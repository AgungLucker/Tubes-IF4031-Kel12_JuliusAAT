const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();
let sequence = 0;

const run = (ctx, fn) => als.run(ctx, fn);
const current = () => als.getStore();

function upstreamHeaders() {
    const ctx = als.getStore();
    if (!ctx) return {};
    return {
        "X-Correlation-ID": `poll:${ctx.holder}:${ctx.source}:e${ctx.epoch}:${++sequence}`,
        "X-Poller-Id": ctx.holder,
        "X-Fence-Epoch": String(ctx.epoch),
    };
}

module.exports = { run, current, upstreamHeaders };
