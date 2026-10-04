const { getVolcanicReports } = require("../sources/pvmbgClient");
const { mapVolcanicReportToHazardEvent } = require("../mappers/volcanicMapper");
const { upsertHazardEvent, markPollSuccess, markPollError } = require("../store/canonicalStore");
const { publishHazardEvent } = require("../broker/publisher");



async function pollPvmbg(since) {
    try {
        const volcanicReports = await getVolcanicReports(since);

        let latestCursor = since;
        for (const volcanicReport of volcanicReports) {
            const hazardEvent = mapVolcanicReportToHazardEvent(volcanicReport);
            const isNewEvent = await upsertHazardEvent(hazardEvent);

            if (isNewEvent) {
                // publish ke message broker
                publishHazardEvent(hazardEvent);
            }


            if (volcanicReport.reported_at > latestCursor) {
                latestCursor = volcanicReport.reported_at;
            }
        }

        await markPollSuccess("PVMBG", latestCursor);
        console.log(`[poll] PVMBG: ${volcanicReports.length} report(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        await markPollError("PVMBG", error.message);
        console.log(`[poll] PVMBG: GAGAL - ${error.message}`);
    }
}

module.exports = { pollPvmbg };