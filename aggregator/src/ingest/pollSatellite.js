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
async function pollSatellite(since, ctx = null) {
    try {
        const fires = await getFires(since);

        let latestCursor = since;
        for (const fire of fires) {
            if (fire.status === "ACTIVE") {
                await syncFire(fire, ctx);
            } else {
                await deleteHazardEvent("SATELIT", fire.fire_id, ctx);
            }

            if (fire.updated_at > latestCursor) {
                latestCursor = fire.updated_at
            }
        }

        await markPollSuccess("SATELIT", latestCursor, ctx);
        console.log(`[poll] SATELIT: ${fires.length} fire(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        if (error instanceof FencedError) {
            console.log(`[poll] SATELIT: dihentikan, leader sudah digantikan - ${error.message}`);
            return;
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
    }
}

module.exports = { pollSatellite };
