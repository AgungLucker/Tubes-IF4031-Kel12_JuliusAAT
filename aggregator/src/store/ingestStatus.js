// ingest_status disimpan di DB tersendiri (store-ingest-status), terpisah dari shard HazardEvent,
// sehingga state polling tidak ikut hilang/berpindah saat shard rebalance atau satu node shard mati.
const { makePool } = require("../db/shards");

const INGEST_STATUS_DATABASE_URL = process.env.INGEST_STATUS_DATABASE_URL;

if (!INGEST_STATUS_DATABASE_URL) {
    throw new Error("INGEST_STATUS_DATABASE_URL belum diatur");
}

const pool = makePool("ingest-status", INGEST_STATUS_DATABASE_URL);

async function getIngestStatus() {
    const { rows } = await pool.query("SELECT * FROM ingest_status");
    return rows;
}

async function markPollSuccess(source, cursor) {
    await pool.query(
        `UPDATE ingest_status SET last_cursor = $2, last_success_at = now() WHERE source = $1`,
        [source, cursor]
    );
}

async function markPollError(source, message) {
    await pool.query(
        `UPDATE ingest_status SET last_error_at = now(), last_error_message = $2 WHERE source = $1`,
        [source, message]
    );
}

module.exports = { getIngestStatus, markPollSuccess, markPollError, pool };
