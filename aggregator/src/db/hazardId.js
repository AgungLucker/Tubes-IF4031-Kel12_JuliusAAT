
const crypto = require("crypto");
const BUCKETS = 64;
function makeHazardId(source, sourceRefId) {
    if (!source || sourceRefId === undefined || sourceRefId === null || sourceRefId === "") {
        throw new Error("source dan source_ref_id wajib ada untuk membuat hazard_id");
    }
    const hex = crypto
        .createHash("sha256")
        .update(`${source}|${String(sourceRefId)}`)
        .digest("hex");
    return `hz-${hex.slice(0, 16)}`;
}

function bucketOf(hazardId) {
    const hex = hazardId.slice(3, 11);
    return parseInt(hex, 16) % BUCKETS;
}

module.exports = { BUCKETS, makeHazardId, bucketOf };
