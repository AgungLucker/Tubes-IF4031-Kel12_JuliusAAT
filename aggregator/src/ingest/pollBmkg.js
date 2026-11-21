const { getSeismicEvents, getTsunamiWarnings } = require("../sources/bmkgClient");
const { mapSeismicEventToHazardEvent } = require("../mappers/seismicMapper");
const { upsertHazardEvent } = require("../store/canonicalStore");
const { saveRejected } = require("../store/rejectedStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { publishHazardEvent } = require("../broker/publisher");
const { BadPayloadError } = require("../sources/httpClient");
const { FencedError } = require("../coordination/errors");


function mapTsunamiWarningByEventId(tsunamiWarnings) {
    const map = {};
    for (const tsunamiWarning of tsunamiWarnings) {
        map[tsunamiWarning.related_event_id] = tsunamiWarning
    }
    return map;
}

// ctx = { source, holder, epoch } dari leader election. ctx berfungsi sebagai fence (source+epoch)
// untuk tulis ke shard dan sebagai lease (holder+epoch) untuk memajukan kursor.
async function pollBmkg(since, ctx = null) {
    try {
        const [events, tsunamiWarnings] = await Promise.all([
            getSeismicEvents(since),
            getTsunamiWarnings(since)
        ]);

        const tsunamiWarningByEvent = mapTsunamiWarningByEventId(tsunamiWarnings);

        let latestCursor = since;
        for (const event of events) {
            const relatedWarning = tsunamiWarningByEvent[event.event_id];
            const hazardEvent = mapSeismicEventToHazardEvent(event, relatedWarning);
            const { inserted } = await upsertHazardEvent(hazardEvent, ctx);

            if (inserted) {
                publishHazardEvent(hazardEvent);
            }

            if (event.occurred_at > latestCursor) {
                latestCursor = event.occurred_at
            }
        }
        await markPollSuccess("BMKG", latestCursor, ctx);
        console.log(`[poll] BMKG: ${events.length} event(s) diproses, cursor=${latestCursor}`);
        return "success";
    } catch (error) {
        if (error instanceof FencedError) {
            console.log(`[poll] BMKG: dihentikan, leader sudah digantikan - ${error.message}`);
            return "fenced";
        }
        if (error instanceof BadPayloadError) {
            await saveRejected({
                source: "BMKG",
                rawPayload: error.raw,
                reason: error.reason,
                retryable: false,
            }).catch((saveError) => console.log(`[poll] BMKG: gagal menyimpan pesan rusak - ${saveError.message}`));
        }

        await markPollError("BMKG", error.message, ctx).catch(() => { });
        console.log(`[poll] BMKG: GAGAL - ${error.message}`);
        return "error";
    }
}

module.exports = { pollBmkg };