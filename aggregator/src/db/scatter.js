const {shards} = require("./shards");
const READ_TIMEOUT_MS = Number(process.env.SHARD_READ_TIMEOUT_MS || 3000);

function isQueryBug(err) {
    return typeof err.code === "string" && /^(22|23|42)/.test(err.code);
}

async function readQuery(shard, text, values = [], timeoutMs = READ_TIMEOUT_MS) {
    const q = { text, values, query_timeout: timeoutMs };
    try {
        const res = await shard.pool.query(q);
        return { rows: res.rows, via: "primary" };
    } catch (err) {
        if (!shard.readPool || isQueryBug(err)) throw err;
        const res = await shard.readPool.query(q);
        return { rows: res.rows, via: "replica" };
    }
}

async function scatter(fn, { timeoutMs = READ_TIMEOUT_MS, targets = shards } = {}) {
    const settled = await Promise.allSettled(
        targets.map(async (shard) => {
            let via = "primary";
            const query = async (text, values) => {
                const r = await readQuery(shard, text, values, timeoutMs);
                if (r.via === "replica") via = "replica";
                return r.rows;
            };
            const value = await fn(shard, query);
            return { shard: shard.name, value, via };
        })
    );

    const results = [];
    const unavailable = [];
    settled.forEach((s, i) => {
        if (s.status === "fulfilled") {
            results.push(s.value);
        } else {
            if (isQueryBug(s.reason)) throw s.reason; 
            unavailable.push(targets[i].name);
            console.error(`[scatter] ${targets[i].name} tidak terjangkau: ${s.reason.message}`);
        }
    });
    return { results, unavailable };
}

module.exports = { scatter, readQuery, READ_TIMEOUT_MS };
