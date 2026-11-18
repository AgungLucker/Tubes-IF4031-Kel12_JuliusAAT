
const { shardByName, shards } = require("../db/router");
const { readQuery } = require("../db/scatter");

const META_SHARD = process.env.META_SHARD || "shard-1";

function metaShard() {
    return shardByName(META_SHARD) || shards[0];
}

async function getIngestStatus() {
    const { rows } = await readQuery(metaShard(), "SELECT * FROM ingest_status");
    return rows;
}

async function markPollSuccess(source, cursor) {
    await metaShard().pool.query(
        `UPDATE ingest_status SET last_cursor = $2, last_success_at = now() WHERE source = $1`,
        [source, cursor]
    );
}

async function markPollError(source, message) {
    await metaShard().pool.query(
        `UPDATE ingest_status SET last_error_at = now(), last_error_message = $2 WHERE source = $1`,
        [source, message]
    );
}

module.exports = { getIngestStatus, markPollSuccess, markPollError };
