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
        await upsertFires(client, fires);
        await upsertDetections(client, detections);

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

async function upsertFires(client, fires) {
    if (fires.length === 0) return;
    await client.query(
        `INSERT INTO fires (
            fire_id, status, merged_into, latitude, longitude, detection_count,
            satellites, max_confidence, total_frp_mw,
            earliest_detected_at, latest_detected_at, closed_at, updated_at
        )
        SELECT fire_id, status, merged_into, latitude, longitude, detection_count,
               ARRAY(SELECT jsonb_array_elements_text(satellites)), max_confidence, total_frp_mw,
               earliest_detected_at, latest_detected_at, closed_at, now()
          FROM jsonb_to_recordset($1::jsonb) AS f(
               fire_id text, status text, merged_into text,
               latitude double precision, longitude double precision, detection_count integer,
               satellites jsonb, max_confidence text, total_frp_mw double precision,
               earliest_detected_at timestamptz, latest_detected_at timestamptz, closed_at timestamptz)
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
        [JSON.stringify(fires)]
    );
}

async function upsertDetections(client, detections) {
    if (detections.length === 0) return;
    await client.query(
        `INSERT INTO detections (
            detection_key, satellite, detected_at, latitude, longitude,
            confidence, frp_mw, disposition, fire_id, feed_offset
        )
        SELECT detection_key, satellite, detected_at, latitude, longitude,
               confidence, frp_mw, disposition, fire_id, feed_offset
          FROM jsonb_to_recordset($1::jsonb) AS d(
               detection_key text, satellite text, detected_at timestamptz,
               latitude double precision, longitude double precision, confidence text,
               frp_mw double precision, disposition text, fire_id text, feed_offset bigint)
        ON CONFLICT (detection_key) DO UPDATE SET
            confidence = EXCLUDED.confidence,
            frp_mw = EXCLUDED.frp_mw,
            disposition = EXCLUDED.disposition,
            fire_id = EXCLUDED.fire_id,
            feed_offset = EXCLUDED.feed_offset
        WHERE EXCLUDED.disposition <> 'LATE_REJECTED'`,
        [JSON.stringify(detections)]
    );
}


async function listFires({ since, afterId = "", limit } = {}) {
    const result = await pool.query(
        `SELECT f.*,
                COALESCE((SELECT array_agg(d.detection_key ORDER BY d.detection_key)
                            FROM detections d
                           WHERE d.fire_id = f.fire_id AND d.disposition = 'ACCEPTED'), '{}') AS detection_keys
           FROM fires f
          WHERE (date_trunc('milliseconds', f.updated_at), f.fire_id) > ($1::timestamptz, $2::text)
          ORDER BY date_trunc('milliseconds', f.updated_at) ASC, f.fire_id ASC
          LIMIT $3`,
        [since || new Date(0).toISOString(), afterId, limit]
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

async function getDetectionKeys(since) {
    const result = await pool.query(
        `SELECT detection_key, detected_at FROM detections WHERE detected_at >= $1`,
        [since]
    );
    return result.rows.map((row) => [row.detection_key, new Date(row.detected_at).getTime()]);
}


module.exports = { getCheckpoint, getLastOffset, commitBatch, listFires, getActiveFires, getOpenDetections, getDetectionKeys };

