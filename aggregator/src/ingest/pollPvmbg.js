const { getVolcanicReports } = require("../sources/pvmbgClient");
const { mapVolcanicReportToHazardEvent } = require("../mappers/volcanicMapper");
const { upsertHazardEvent } = require("../store/canonicalStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { publishHazardEvent } = require("../broker/publisher");



async function pollPvmbg(since) {
    try {
        const volcanicReports = await getVolcanicReports(since);

        let latestCursor = since;
        for (const volcanicReport of volcanicReports) {
            const hazardEvent = mapVolcanicReportToHazardEvent(volcanicReport);
            const { inserted } = await upsertHazardEvent(hazardEvent);

            if (inserted) {
                publishHazardEvent(hazardEvent);
            }


            if (volcanicReport.reported_at > latestCursor) {
                latestCursor = volcanicReport.reported_at;
            }
        }

        await markPollSuccess("PVMBG", latestCursor);
        console.log(`[poll] PVMBG: ${volcanicReports.length} report(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        await markPollError("PVMBG", error.message).catch(() => {});
        console.log(`[poll] PVMBG: GAGAL - ${error.message}`);
    }
}

module.exports = { pollPvmbg };