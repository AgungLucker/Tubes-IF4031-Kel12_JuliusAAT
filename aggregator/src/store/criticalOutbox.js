// Transactional-outbox style store for critical alerts. A critical observation is written here
// BEFORE anything else happens to it, and is only marked sent after RabbitMQ has confirmed the
// publish. A crash, a RabbitMQ outage or a leader change therefore never loses an alert: the
// relay (ingest/outboxRelay.js) keeps retrying until the broker confirms.
// The primary key (hazard_id) makes enqueueing idempotent, so a re-polled observation never
// creates a second alert.
const { pool } = require("./ingestStatus");

const SCHEMA_LOCK_KEY = 4031014;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS critical_outbox (
    hazard_id   TEXT PRIMARY KEY,
    routing_key TEXT        NOT NULL,
    payload     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ,
    attempts    INTEGER     NOT NULL DEFAULT 0,
    last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_critical_outbox_pending ON critical_outbox (created_at) WHERE sent_at IS NULL;`;

async function ensureSchema() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
        await client.query(SCHEMA_SQL);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function enqueue(event, routingKey) {
    const { rowCount } = await pool.query(
        `INSERT INTO critical_outbox (hazard_id, routing_key, payload)
         VALUES ($1, $2, $3) ON CONFLICT (hazard_id) DO NOTHING`,
        [event.hazard_id, routingKey, JSON.stringify(event)]
    );
    return rowCount === 1;
}

async function claimPending(limit = 50) {
    const { rows } = await pool.query(
        `SELECT hazard_id, routing_key, payload, created_at,
                EXTRACT(EPOCH FROM (now() - created_at)) AS age_s
           FROM critical_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1`,
        [limit]
    );
    return rows;
}

async function markSent(hazardId) {
    await pool.query(
        "UPDATE critical_outbox SET sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE hazard_id = $1",
        [hazardId]
    );
}

async function markFailed(hazardId, message) {
    await pool.query(
        "UPDATE critical_outbox SET attempts = attempts + 1, last_error = $2 WHERE hazard_id = $1",
        [hazardId, String(message).slice(0, 300)]
    );
}

async function pendingStats() {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS pending,
                COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0) AS oldest_s
           FROM critical_outbox WHERE sent_at IS NULL`
    );
    return rows[0];
}

module.exports = { ensureSchema, enqueue, claimPending, markSent, markFailed, pendingStats };
