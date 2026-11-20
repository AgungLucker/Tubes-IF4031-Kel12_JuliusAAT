const { getVolcanicReports } = require("../sources/pvmbgClient");
const { mapVolcanicReportToHazardEvent } = require("../mappers/volcanicMapper");
const { validateVolcanicReport } = require("../validators/volcanicValidator");
const { upsertHazardEvent } = require("../store/canonicalStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { saveRejected } = require("../store/rejectedStore");
const { publishHazardEvent } = require("../broker/publisher");
const { BadPayloadError } = require("../sources/httpClient");

async function processVolcanicReport(volcanicReport) {
    const reason = validateVolcanicReport(volcanicReport);
    if (reason) return { ok: false, reason, retryable: false };

    try {
        const hazardEvent = mapVolcanicReportToHazardEvent(volcanicReport);
        const { inserted } = await upsertHazardEvent(hazardEvent);

        if (inserted) {
            publishHazardEvent(hazardEvent);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `system_error: ${error.message}`, retryable: true };
    }
}

async function pollPvmbg(since) {
    try {
        const volcanicReports = await getVolcanicReports(since);

        let latestCursor = since;
        for (const volcanicReport of volcanicReports) {
            const result = await processVolcanicReport(volcanicReport);

            if (!result.ok) {
                await saveRejected({
                    source: "PVMBG",
                    sourceRefId: volcanicReport.report_id ?? null,
                    rawPayload: JSON.stringify(volcanicReport),
                    reason: result.reason,
                    retryable: result.retryable,
                });
            }

            if (volcanicReport.reported_at > latestCursor) {
                latestCursor = volcanicReport.reported_at;
            }
        }

        await markPollSuccess("PVMBG", latestCursor);
        console.log(`[poll] PVMBG: ${volcanicReports.length} report(s) diproses, cursor=${latestCursor}`);
    } catch (error) {
        if (error instanceof BadPayloadError) {
            await saveRejected({
                source: "PVMBG",
                rawPayload: error.raw,
                reason: error.reason,
                retryable: false,
            }).catch((saveError) => console.log(`[poll] PVMBG: gagal menyimpan pesan rusak - ${saveError.message}`));
        }

        await markPollError("PVMBG", error.message).catch(() => { });
        console.log(`[poll] PVMBG: GAGAL - ${error.message}`);
    }
}

module.exports = { pollPvmbg, processVolcanicReport };
