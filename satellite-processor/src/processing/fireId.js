const { createHash } = require("crypto");

const toMs = (value) => new Date(value).getTime();

function earliestDetection(members) {
    return [...members].sort((first, second) =>
        toMs(first.detected_at) - toMs(second.detected_at) ||
        (first.detection_key < second.detection_key ? -1 : 1)
    )[0];
}

function makeFireId(members) {
    const { detection_key } = earliestDetection(members);
    const digest = createHash("sha256").update(detection_key).digest("hex").slice(0, 16);
    return `fire-${digest}`;
}

function pickMergeTarget(fires) {
    return [...fires].sort((first, second) =>
        toMs(first.earliest_detected_at) - toMs(second.earliest_detected_at) ||
        (first.fire_id < second.fire_id ? -1 : 1)
    )[0];
}

function resolveFireId(members, firesById) {
    const existingIds = [...new Set(members.map((m) => m.fire_id).filter(Boolean))];

    if (existingIds.length === 0) {
        return { fireId: makeFireId(members), mergedFireIds: [] };
    }

    const target = pickMergeTarget(existingIds.map((id) => firesById.get(id)));
    return {
        fireId: target.fire_id,
        mergedFireIds: existingIds.filter((id) => id !== target.fire_id),
    };
}

module.exports = { makeFireId, pickMergeTarget, resolveFireId };
