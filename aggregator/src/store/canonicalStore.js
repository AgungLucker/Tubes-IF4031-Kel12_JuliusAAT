const pool = require("../db/connection");

async function upsertHazardEvent(event) {
    const {
        hazard_id, source, source_ref_id, hazard_type,
        severity, area_name, latitude, longitude,
        occurred_at, ingested_at, attributes
    } = event;

    const result = await pool.query(
        `INSERT INTO hazard_events (
            hazard_id, source, source_ref_id, hazard_type,
            severity, area_name, latitude, longitude,
            occurred_at, ingested_at, attributes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (source, source_ref_id) DO UPDATE SET
            severity = EXCLUDED.severity,
            area_name = EXCLUDED.area_name,
            attributes = EXCLUDED.attributes
        RETURNING (xmax = 0) AS inserted`,
        [hazard_id, source, source_ref_id, hazard_type, severity, area_name,
            latitude, longitude, occurred_at, ingested_at, JSON.stringify(attributes)]
    );

    return result.rows[0].inserted; // return boolean -> true = record baru, false = record lama di-update
}

async function listHazardEvents({ since, hazardType, severity, limit = 100 } = {}) {
    const conditions = [];
    const params = [];

    if (since) {
        params.push(since);
        conditions.push(`ingested_at >= $${params.length}`);
    }
    if (hazardType) {
        params.push(hazardType);
        conditions.push(`hazard_type = $${params.length}`);
    }
    if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const result = await pool.query(
        `SELECT * FROM hazard_events ${whereClause}
     ORDER BY occurred_at DESC LIMIT $${params.length}`,
        params
    );

    return result.rows.reverse();
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

async function getIngestStatus() {
    const result = await pool.query(`SELECT * FROM ingest_status`);
    return result.rows;
}

module.exports = {
    upsertHazardEvent,
    listHazardEvents,
    markPollSuccess,
    markPollError,
    getIngestStatus
}