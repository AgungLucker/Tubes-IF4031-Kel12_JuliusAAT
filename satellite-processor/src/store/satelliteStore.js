const pool = require("../db/connection")

const STREAM = "SATELLITE_FEED"

async function getCheckpoint() {
    const result = await pool.query(
        `SELECT last_offset, watermark FROM stream_checkpoint WHERE stream_name = $1`,
        [STREAM]
    )

    return result.rows[0];
}

async function getLastOffset() {
    const { last_offset } = await getCheckpoint();
    return Number(last_offset); // karena BIGINT hasilnya string oleh pg
}

async function commitBatch({ offset, watermark, fires = [], detections = [] }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (const fire of fires) await upsertFire(client, fire);
        for (const detection of detections) await upsertDetection(client, detection);
        await client.query(
            `UPDATE stream_checkpoint
                SET last_offset = $2, watermark = $3, updated_at = now()
              WHERE stream_name = $1`,
            [STREAM, offset, watermark]
        );
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

async function upsertFire(client, f) {
    await client.query(
        `INSERT INTO fires (
            fire_id, status, merged_into, latitude, longitude, detection_count,
            satellites, max_confidence, total_frp_mw,
            earliest_detected_at, latest_detected_at, closed_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        ON CONFLICT (fire_id) DO UPDATE SET
            status = EXCLUDED.status,
            merged_into = EXCLUDED.merged_into,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            detection_count = EXCLUDED.detection_count,
            satellites = EXCLUDED.satellites,
            max_confidence = EXCLUDED.max_confidence,
            total_frp_mw = EXCLUDED.total_frp_mw,
            earliest_detected_at = EXCLUDED.earliest_detected_at,
            latest_detected_at = EXCLUDED.latest_detected_at,
            closed_at = EXCLUDED.closed_at,
            updated_at = now()`,
        [f.fire_id, f.status, f.merged_into, f.latitude, f.longitude, f.detection_count,
        f.satellites, f.max_confidence, f.total_frp_mw,
        f.earliest_detected_at, f.latest_detected_at, f.closed_at]
    );
}

async function upsertDetection(client, d) {
    await client.query(
        `INSERT INTO detections (
            detection_key, satellite, detected_at, latitude, longitude,
            confidence, frp_mw, disposition, fire_id, feed_offset
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (detection_key) DO UPDATE SET
            confidence = EXCLUDED.confidence,
            frp_mw = EXCLUDED.frp_mw,
            disposition = EXCLUDED.disposition,
            fire_id = EXCLUDED.fire_id,
            feed_offset = EXCLUDED.feed_offset`,
        [d.detection_key, d.satellite, d.detected_at, d.latitude, d.longitude,
        d.confidence, d.frp_mw, d.disposition, d.fire_id, d.feed_offset]
    );
}

async function listFires({ since } = {}) {
    const result = await pool.query(
        `SELECT f.*,
                COALESCE((SELECT array_agg(d.detection_key ORDER BY d.detection_key)
                            FROM detections d
                           WHERE d.fire_id = f.fire_id AND d.disposition = 'ACCEPTED'), '{}') AS detection_keys
           FROM fires f
          WHERE f.updated_at >= $1
          ORDER BY f.updated_at ASC`,
        [since || new Date(0).toISOString()]
    );
    return result.rows;
}

async function getOpenDetections(since) {
    const result = await pool.query(
        `SELECT d.*
           FROM detections d
           LEFT JOIN fires f ON f.fire_id = d.fire_id
          WHERE (d.fire_id IS NOT NULL AND d.disposition = 'ACCEPTED' AND f.status = 'ACTIVE' AND f.closed_at IS NULL)
             OR (d.fire_id IS NULL AND d.disposition IN ('ACCEPTED', 'LOW_CONFIDENCE') AND d.detected_at >= $1)`,
        [since]
    );
    return result.rows;
}

async function getActiveFires() {
    const result = await pool.query(`SELECT * FROM fires WHERE status = 'ACTIVE' AND closed_at IS NULL`);
    return result.rows;
}

async function getDetectionKeys() {
    const result = await pool.query(`SELECT detection_key FROM detections`);
    return result.rows.map((row) => row.detection_key);
}

module.exports = { getCheckpoint, getLastOffset, commitBatch, listFires, getActiveFires, getOpenDetections, getDetectionKeys };

