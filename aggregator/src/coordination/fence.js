// Fencing on the storage side (the shards that hold HazardEvent).
const { FencedError } = require("./errors");

const GUARD_SQL = `
INSERT INTO ingest_fence (source, epoch) VALUES ($1, $2)
ON CONFLICT (source) DO UPDATE SET epoch = EXCLUDED.epoch
WHERE ingest_fence.epoch <= EXCLUDED.epoch
RETURNING epoch`;

async function guard(client, fence) {
    const { rowCount } = await client.query(GUARD_SQL, [fence.source, fence.epoch]);
    if (rowCount === 0) throw new FencedError(fence.source, fence.epoch, "fence is ahead on this shard");
}

async function withFence(pool, fence, fn) {
    if (!fence) return fn(pool);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await guard(client, fence);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function installFence(shards, source, epoch) {
    const results = await Promise.allSettled(
        shards.map((s) => s.pool.query(GUARD_SQL, [source, epoch]))
    );
    const ok = [];
    const failed = [];
    results.forEach((r, i) => {
        const name = shards[i].name;
        if (r.status === "rejected") failed.push({ shard: name, error: r.reason.message });
        else if (r.value.rowCount === 0) throw new FencedError(source, epoch, `fence already ahead on ${name}`);
        else ok.push(name);
    });
    return { ok, failed };
}

module.exports = { withFence, installFence, guard, GUARD_SQL };
