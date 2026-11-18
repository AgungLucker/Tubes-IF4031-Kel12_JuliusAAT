const { pollBmkg } = require("./pollBmkg");
const { pollPvmbg } = require("./pollPvmbg");
const { getIngestStatus } = require("../store/ingestStatus");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const EPOCH = new Date(0).toISOString();

async function runPollCycle() {
    let statuses;
    try {
        statuses = await getIngestStatus();
    } catch (error) {
        console.log(`[poll] status ingest tidak terbaca, siklus dilewati: ${error.message}`);
        return;
    }
    const cursorFor = Object.fromEntries(
        statuses.map((s) => {
            const cursor = s.last_cursor ? new Date(s.last_cursor).toISOString() : EPOCH;
            return [s.source, cursor];
        })
    );

    await Promise.allSettled([
        pollBmkg(cursorFor.BMKG),
        pollPvmbg(cursorFor.PVMBG)
    ]);
}

function startPoller() {
    runPollCycle();
    setInterval(runPollCycle, POLL_INTERVAL_MS);
}

module.exports = { startPoller };
