const { getSeismicEvents, getTsunamiWarnings } = require("../sources/bmkgClient");
const { mapSeismicEventToHazardEvent } = require("../mappers/seismicMapper");
const { upsertHazardEvent } = require("../store/canonicalStore");
const { saveRejected } = require("../store/rejectedStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { publishHazardEvent } = require("../broker/publisher");
const { BadPayloadError } = require("../sources/httpClient");


function mapTsunamiWarningByEventId(tsunamiWarnings) {
    const map = {};
    for (const tsunamiWarning of tsunamiWarnings) {
        map[tsunamiWarning.related_event_id] = tsunamiWarning
    }
    return map;
}

async function pollBmkg(since) {
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
            const { inserted } = await upsertHazardEvent(hazardEvent);

            if (inserted) {
                publishHazardEvent(hazardEvent);
            }

            if (event.occurred_at > latestCursor) {
                latestCursor = event.occurred_at
            }
        }
        await markPollSuccess("BMKG", latestCursor);
        console.log(`[poll] BMKG: ${events.length} event(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        if (error instanceof BadPayloadError) {
            await saveRejected({
                source: "BMKG",
                rawPayload: error.raw,
                reason: error.reason,
                retryable: false,
            }).catch((saveError) => console.log(`[poll] BMKG: gagal menyimpan pesan rusak - ${saveError.message}`));
        }

        await markPollError("BMKG", error.message).catch(() => { });
        console.log(`[poll] BMKG: GAGAL - ${error.message}`);
    }
}

module.exports = { pollBmkg };