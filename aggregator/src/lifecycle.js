const { shards } = require("./db/shards");

const SHARD_CHECK_MS = Number(process.env.SHARD_CHECK_MS || 3000);
const SHARD_PING_TIMEOUT_MS = 1000;

const state = {
    started: false,
    draining: false,
    forcedUnready: false,
    shardsUp: shards.length,
    shardsTotal: shards.length,
};

async function pingShard(shard) {
    try {
        await shard.pool.query({ text: "SELECT 1", query_timeout: SHARD_PING_TIMEOUT_MS });
        return true;
    } catch {
        return false;
    }
}

let timer = null;
function startShardMonitor() {
    const tick = async () => {
        const results = await Promise.all(shards.map(pingShard));
        state.shardsUp = results.filter(Boolean).length;
    };
    tick();
    timer = setInterval(tick, SHARD_CHECK_MS);
    timer.unref();
}

function readiness() {
    const reasons = [];
    if (!state.started) reasons.push("starting");
    if (state.draining) reasons.push("draining");
    if (state.forcedUnready) reasons.push("forced_unready");
    if (state.shardsTotal > 0 && state.shardsUp === 0) reasons.push("no_shard_reachable");
    return { ready: reasons.length === 0, reasons, shardsUp: state.shardsUp, shardsTotal: state.shardsTotal };
}

module.exports = { state, readiness, startShardMonitor };
