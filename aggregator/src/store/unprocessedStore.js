const { pool } = require("./ingestStatus");
const { encodeCursor, decodeCursor } = require("./cursor");


async function listUnprocessed({ source, limit = 100, cursor } = {}) {
    const c = decodeCursor(cursor, ["r", "m"]);
    const { rows } = await pool.query(
        `SELECT message_id, source,
                to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
                reason, retryable, attempts, status,
                received_at::text AS _k
           FROM rejected_messages
          WHERE status IN ('retrying', 'parked')
            AND ($1::text IS NULL OR source = $1)
            AND ($2::text IS NULL OR (received_at, message_id) > ($2::timestamptz, $3))
          ORDER BY received_at, message_id
          LIMIT $4`,
        [source ?? null, c?.r ?? null, c?.m ?? null, limit + 1]
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
        items: page.map(({ _k, ...item }) => item),
        next_cursor: rows.length > limit && last ? encodeCursor({ r: last._k, m: last.message_id }) : null,
    };

}

module.exports = { listUnprocessed };
