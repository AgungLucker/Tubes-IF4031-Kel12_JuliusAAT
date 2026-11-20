const { claimDue, markRecovered, markFailed } = require("../store/rejectedStore");
const { processVolcanicReport } = require("./pollPvmbg");

const BATCH_SIZE = 500;

const PROCESSORS = {
    PVMBG: processVolcanicReport,
};

async function replayOne(message) {
    let result;
    try {
        const payload = JSON.parse(message.raw_payload.toString("utf8"));
        result = await PROCESSORS[message.source](payload);
    } catch (error) {
        result = { ok: false, reason: `system_error: ${error.message}`, retryable: true };
    }

    if (result.ok) {
        await markRecovered(message.message_id);
    } else {
        await markFailed(message.message_id, { reason: result.reason, retryable: result.retryable });
    }
}

async function replayBatch(status) {
    const messages = await claimDue(status, BATCH_SIZE);
    for (const message of messages) {
        await replayOne(message);
    }

    if (messages.length) console.log(`[replay] ${status}: ${messages.length} pesan diproses ulang`);
}

const replayRetrying = () => replayBatch("retrying");
const replayParked = () => replayBatch("parked");

module.exports = { replayRetrying, replayParked };

