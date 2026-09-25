const { getSeismicEvents, getTsunamiWarnings } = require("../sources/bmkgClient");
const { mapSeismicEventToHazardEvent } = require("../mappers/seismicMapper");
const { upsertHazardEvent, markPollSuccess, markPollError } = require("../store/canonicalStore");


// mapping tsunami warning dengan event seismic nya
function groupTsunamiWarningsByEventId(tsunamiWarnings) {
    const map = {};
    for (const tsunamiWarning of tsunamiWarnings) {
        const eventId = tsunamiWarning.related_event_id;
        if (!map[eventId]) {
            map[eventId] = [];
        }

        map[eventId].push(tsunamiWarning);
    }
    return map;
}

async function pollBmkg(since) {
    try {
        const [events, tsunamiWarnings] = await Promise.all([
            getSeismicEvents(since),
            getTsunamiWarnings(since)
        ]);

        const tsunamiWarningByEvent = groupTsunamiWarningsByEventId(tsunamiWarnings);

        let latestCursor = since;
        for (const event of events) {
            const related = tsunamiWarningByEvent[event.event_id] ?? [];
            const hazardEvent = mapSeismicEventToHazardEvent(event, related);
            await upsertHazardEvent(hazardEvent);

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