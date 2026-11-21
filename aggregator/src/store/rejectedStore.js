const crypto = require("crypto");
const { pool } = require("./ingestStatus");
const {rejectedMessagesTotal} =  require("../metrics");

const MAX_ATTEMPTS = Number(process.env.DLQ_MAX_ATTEMPTS || 5);
const RETRY_DELAY_MS = Number(process.env.DLQ_RETRY_DELAY_MS || 30000);

function makeMessageId(source, payload) {
    return crypto.createHash("sha256").update(source).update(":").update(payload).digest("hex");
}

async function saveRejected({ source, sourceRefId = null, rawPayload, reason, retryable }) {
    const payload = Buffer.from(rawPayload);
    const { rowCount } = await pool.query(
        `INSERT INTO rejected_messages (
            message_id, source, source_ref_id, raw_payload, reason, retryable, status, next_attempt_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            CASE WHEN $6 THEN now() + $8 * interval '1 millisecond' END
        )
        ON CONFLICT (message_id) DO NOTHING`,
        [
            makeMessageId(source, payload), source, sourceRefId, payload, reason, retryable,
            retryable ? "retrying" : "parked", RETRY_DELAY_MS,
        ]
    );
    // ON CONFLICT DO NOTHING: pesan rusak yang sama datang lagi -> jangan dihitung dua kali.
    if (rowCount === 1) rejectedMessagesTotal.inc({source, retryable:String(retryable)});
}

// retry query dlq
async function claimDue(status, limit) {
    const { rows } = await pool.query(
        `UPDATE rejected_messages
            SET next_attempt_at = now() + $3 * interval '1 millisecond'
          WHERE message_id IN (
                SELECT message_id FROM rejected_messages
                 WHERE status = $1 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                 ORDER BY received_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
        RETURNING message_id, source, source_ref_id, raw_payload, attempts, retryable, received_at`,
        [status, limit, RETRY_DELAY_MS]
    );
    return rows.sort((a, b) => a.received_at - b.received_at);
}

async function markRecovered(messageId) {
    await pool.query(
        `UPDATE rejected_messages
            SET status = 'recovered', next_attempt_at = NULL
          WHERE message_id = $1`,
        [messageId]
    );
}

async function markFailed(messageId, { reason, retryable }) {
    await pool.query(
        `UPDATE rejected_messages
            SET attempts = attempts + 1,
                reason = $2,
                retryable = $3,
                status = CASE WHEN $3 AND attempts + 1 < $4 THEN 'retrying' ELSE 'parked' END,
                next_attempt_at = CASE WHEN $3 AND attempts + 1 < $4 THEN now() + $5 * interval '1 millisecond' END
          WHERE message_id = $1`,
        [messageId, reason, retryable, MAX_ATTEMPTS, RETRY_DELAY_MS]
    );
}

module.exports = { saveRejected, claimDue, markRecovered, markFailed };

