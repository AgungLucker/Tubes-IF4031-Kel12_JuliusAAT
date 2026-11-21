const { makePool } = require("../db/shards");
const { FencedError } = require("../coordination/errors");
const { LeaseStore } = require("../coordination/lease");

const INGEST_DATABASE_URL = process.env.INGEST_DATABASE_URL;

if (!INGEST_DATABASE_URL) {
    throw new Error("INGEST_DATABASE_URL belum diatur");
}

const pool = makePool("ingest", INGEST_DATABASE_URL);
const leases = new LeaseStore(pool);

// Pemegang lease yang sah: hanya (name, holder, epoch) yang masih berlaku menurut jam DB.
const LEASE_IS_CURRENT = `EXISTS (
    SELECT 1 FROM ingest_lease l
    WHERE l.name = $1 AND l.holder = $3 AND l.epoch = $4 AND l.lease_until > now())`;

async function getIngestStatus() {
    const { rows } = await pool.query("SELECT * FROM ingest_status");
    return rows;
}

async function getCursor(source) {
    const { rows } = await pool.query("SELECT last_cursor FROM ingest_status WHERE source = $1", [source]);
    return rows[0]?.last_cursor || new Date(0).toISOString();
}


// lease = { holder, epoch } milik leader. Pembaruan kursor dan pemeriksaan lease dilakukan dalam
// SATU pernyataan SQL, jadi instance yang sudah disalip tidak pernah bisa memajukan kursor.
async function markPollSuccess(source, cursor, lease = null) {
    if (!lease) {
        await pool.query(
            `UPDATE ingest_status SET last_cursor = $2, last_success_at = now() WHERE source = $1`,
            [source, cursor]
        );
        return;
    }
    const { rowCount } = await pool.query(
        `UPDATE ingest_status SET last_cursor = $2, last_success_at = now()
         WHERE source = $1 AND ${LEASE_IS_CURRENT}`,
        [source, cursor, lease.holder, lease.epoch]
    );
    if (rowCount === 0) throw new FencedError(source, lease.epoch, "lease no longer held, cursor not advanced");
}

async function markPollError(source, message, lease = null) {
    if (!lease) {
        await pool.query(
            `UPDATE ingest_status SET last_error_at = now(), last_error_message = $2 WHERE source = $1`,
            [source, message]
        );
        return;
    }
    await pool.query(
        `UPDATE ingest_status SET last_error_at = now(), last_error_message = $2
         WHERE source = $1 AND ${LEASE_IS_CURRENT}`,
        [source, message, lease.holder, lease.epoch]
    );
}

// Cursor of a source whose paging token is opaque (Sensor Pantai), not a timestamp.
async function getRawCursor(source) {
    const { rows } = await pool.query("SELECT last_cursor FROM ingest_status WHERE source = $1", [source]);
    return rows[0]?.last_cursor ?? null;
}

module.exports = { getIngestStatus, getCursor, getRawCursor, markPollSuccess, markPollError, pool, leases };
