const { getSeismicEvents, getTsunamiWarnings } = require("../sources/bmkgClient");
const { mapSeismicEventToHazardEvent } = require("../mappers/seismicMapper");
const { upsertHazardEvent, markPollSuccess, markPollError } = require("../store/canonicalStore");


// mapping tsunami warning dengan event seismic nya
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
            const hazardEvent = mapSeismicEventToHazardEvent(event, related);
            const isNewEvent = await upsertHazardEvent(hazardEvent);

            if (isNewEvent) {
                // publish ke message broker
            }

            if (event.occurred_at > latestCursor) {
                latestCursor = event.occurred_at
            }
        }
        await markPollSuccess("BMKG", latestCursor);
        console.log(`[poll] BMKG: ${events.length} event(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        await markPollError("BMKG", error.message);
        console.log(`[poll] BMKG: GAGAL - ${error.message}`);
    }
}

module.exports = { pollBmkg };