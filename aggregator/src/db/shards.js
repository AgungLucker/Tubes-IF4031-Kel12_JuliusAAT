const { Pool } = require("pg");

const POOL_MAX = Number(process.env.SHARD_POOL_MAX || 10);
const CONNECT_TIMEOUT_MS = Number(process.env.SHARD_CONNECT_TIMEOUT_MS || 2000);
const STATEMENT_TIMEOUT_MS = Number(process.env.SHARD_STATEMENT_TIMEOUT_MS || 30000);

function deriveReadUri(uri) {
    return uri.replace(/-rw(?=[.:/])/, "-r");
}

function makePool(name, uri) {
    const pool = new Pool({
        connectionString: uri,
        max: POOL_MAX,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        idleTimeoutMillis: 10000,
        keepAlive: true,
    });
    pool.on("error", (err) => {
        console.error(`[db] ${name}: koneksi idle error: ${err.message}`);
    });
    return pool;
}

function buildShards() {
    const list = [];
    const count = parseInt(process.env.SHARD_COUNT, 10);

    if (!Number.isInteger(count) && process.env.DATABASE_URL) {
        list.push({ name: "shard-1", pool: makePool("shard-1", process.env.DATABASE_URL), readPool: null });
        return list;
    }
    if (!Number.isInteger(count) || count < 1) {
        throw new Error("SHARD_COUNT belum diatur atau tidak valid");
    }

    for (let i = 1; i <= count; i++) {
        const name = `shard-${i}`;
        const uri = process.env[`SHARD_${i}_URI`];
        if (!uri) throw new Error(`SHARD_${i}_URI belum diatur`);

        const readUri = process.env[`SHARD_${i}_READ_URI`] || deriveReadUri(uri);
        list.push({
            name,
            pool: makePool(name, uri),
            readPool: readUri !== uri ? makePool(`${name}-r`, readUri) : null,
        });
    }
    return list;
}

const shards = buildShards();

module.exports = shards;
