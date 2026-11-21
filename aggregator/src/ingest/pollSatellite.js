const { getFires } = require("../sources/satelliteClient");
const { mapFireToHazardEvent } = require("../mappers/fireMapper");
const { upsertHazardEvent, deleteHazardEvent, findHazardEvent } = require("../store/canonicalStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { saveRejected } = require("../store/rejectedStore");
const { publishHazardEvent } = require("../broker/publisher");
const { BadPayloadError } = require("../sources/httpClient");
const { FencedError } = require("../coordination/errors");

async function syncFire(fire, ctx) {
    const hazardEvent = mapFireToHazardEvent(fire);
    const { event: previous } = await findHazardEvent(hazardEvent.hazard_id);
    const { inserted } = await upsertHazardEvent(hazardEvent, ctx);

    if (inserted || (previous && previous.severity !== hazardEvent.severity)) {
        publishHazardEvent(hazardEvent);
    }
}

// ctx = { source, holder, epoch } dari leader election (fence untuk shard, lease untuk kursor).
async function pollSatellite(cursor, ctx = null) {
    try {
        let [since, afterId = ""] = cursor.split("|");
        let processed = 0;

        while (true) {
            const fires = await getFires(since, afterId);

            for (const fire of fires) {
                if (fire.status === "ACTIVE") {
                    await syncFire(fire, ctx);
                } else {
                    await deleteHazardEvent("SATELIT", fire.fire_id, ctx);
                }
            }

            if (fires.length > 0) {
                const last = fires[fires.length - 1];
                since = last.updated_at;
                afterId = last.fire_id;
                processed += fires.length;
            }

            await markPollSuccess("SATELIT", `${since}|${afterId}`, ctx);
            if (fires.length === 0) break;
        }

        console.log(`[poll] SATELIT: ${processed} fire(s) diproses, cursor=${since}|${afterId}`);

        return "success";
    } catch (error) {
        if (error instanceof FencedError) {
            console.log(`[poll] SATELIT: dihentikan, leader sudah digantikan - ${error.message}`);
            return "fenced";
        }
        if (error instanceof BadPayloadError) {
            await saveRejected({
                source: "SATELIT",
                rawPayload: error.raw,
                reason: error.reason,
                retryable: false,
            }).catch((saveError) => console.log(`[poll] SATELIT: gagal menyimpan pesan rusak - ${saveError.message}`));
        }

        await markPollError("SATELIT", error.message, ctx).catch(() => { });
        console.log(`[poll] SATELIT: GAGAL - ${error.message}`);
        return "error";
    }
}

module.exports = { pollSatellite };
