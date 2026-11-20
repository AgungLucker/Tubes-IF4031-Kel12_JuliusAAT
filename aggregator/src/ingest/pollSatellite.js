const { getFires } = require("../sources/satelliteClient");
const { mapFireToHazardEvent } = require("../mappers/fireMapper");
const { upsertHazardEvent, deleteHazardEvent, findHazardEvent } = require("../store/canonicalStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { publishHazardEvent } = require("../broker/publisher");

async function syncFire(fire) {
    const hazardEvent = mapFireToHazardEvent(fire);
    const { event: previous } = await findHazardEvent(hazardEvent.hazard_id);
    const { inserted } = await upsertHazardEvent(hazardEvent);

    if (inserted || (previous && previous.severity !== hazardEvent.severity)) {
        publishHazardEvent(hazardEvent);
    }
}

async function pollSatellite(since) {
    try {
        const fires = await getFires(since);

        let latestCursor = since;
        for (const fire of fires) {
            if (fire.status === "ACTIVE") {
                await syncFire(fire);
            } else {
                await deleteHazardEvent("SATELIT", fire.fire_id);
            }

            if (fire.updated_at > latestCursor) {
                latestCursor = fire.updated_at
            }
        }

        await markPollSuccess("SATELIT", latestCursor);
        console.log(`[poll] SATELIT: ${fires.length} fire(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        if (error instanceof BadPayloadError) {
            await saveRejected({
                source: "SATELIT",
                rawPayload: error.raw,
                reason: error.reason,
                retryable: false,
            }).catch((saveError) => console.log(`[poll] SATELIT: gagal menyimpan pesan rusak - ${saveError.message}`));
        }

        await markPollError("SATELIT", error.message).catch(() => { });
        console.log(`[poll] SATELIT: GAGAL - ${error.message}`);
    }
}

module.exports = { pollSatellite };
