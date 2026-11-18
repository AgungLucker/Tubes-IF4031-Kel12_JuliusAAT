const {
    getCheckpoint,
    getOpenDetections,
    getActiveFires,
    getDetectionKeys,
    commitBatch,
} = require("../store/satelliteStore");
const { mapFeedEventToDetection } = require("./detectionMapper");
const { groupLinkedDetections, isLinked, LINK_MAX_TIME_DIFF_MS } = require("./clustering");
const { resolveFireId } = require("./fireId");
const { summarizeFire } = require("./fireSummary");
const { log } = require("../logger");

const LATENESS_LIMIT_MS = Number(process.env.LATENESS_LIMIT_MIN || 300) * 60 * 1000;
const FLUSH_INTERVAL_MS = 1000;
const LOW_CONFIDENCE = "l";

const state = {
    offset: 0,
    committedOffset: 0,
    clockMs: null,
    detections: new Map(),
    fires: new Map(),
    knownKeys: new Set(),
    pendingDetections: new Map(),
    pendingFires: new Map(),
    failure: null,
};

let flushing = false;

const toMs = (value) => new Date(value).getTime();
const watermarkMs = () => (state.clockMs === null ? null : state.clockMs - LATENESS_LIMIT_MS);

function advanceClock(ms) {
    if (state.clockMs === null || ms > state.clockMs) state.clockMs = ms;
}

// load working set dari db
async function loadState() {
    const checkpoint = await getCheckpoint();
    const watermark = checkpoint.watermark ? toMs(checkpoint.watermark) : null;
    const since = new Date(watermark === null ? 0 : watermark - LINK_MAX_TIME_DIFF_MS);

    const [keys, fires, detections] = await Promise.all([
        getDetectionKeys(),
        getActiveFires(),
        getOpenDetections(since),
    ]);

    state.offset = Number(checkpoint.last_offset);
    state.committedOffset = state.offset;
    state.clockMs = watermark === null ? null : watermark + LATENESS_LIMIT_MS;
    state.knownKeys = new Set(keys);
    state.fires = new Map(fires.map((fire) => [fire.fire_id, fire]));
    state.detections = new Map(detections.map((detection) => {
        detection.detected_ms = toMs(detection.detected_at);
        return [detection.detection_key, detection];
    }));
    state.pendingDetections = new Map();
    state.pendingFires = new Map();
    state.failure = null;
}

function classify(detection) {
    if (detection.confidence === LOW_CONFIDENCE) return "LOW_CONFIDENCE";
    const watermark = watermarkMs();
    if (watermark !== null && toMs(detection.detected_at) < watermark) return "LATE_REJECTED";
    return "ACCEPTED";
}

function handleDetection(payload) {
    const detection = mapFeedEventToDetection(payload);
    if (state.knownKeys.has(detection.detection_key)) return;

    detection.detected_ms = toMs(detection.detected_at);
    detection.disposition = classify(detection);
    detection.fire_id = null;
    state.knownKeys.add(detection.detection_key);
    advanceClock(detection.detected_ms);

    state.pendingDetections.set(detection.detection_key, detection);
    if (detection.disposition === "LATE_REJECTED") return;

    state.detections.set(detection.detection_key, detection);
    if (detection.disposition === "ACCEPTED") attach(detection);
}

// Assumption: update/retract skip the lateness limit; keys outside the working set are ignored
function handleUpdate(payload) {
    const detection = state.detections.get(payload.key);
    if (!detection || isStale(detection)) return;

    const wasAccepted = detection.disposition === "ACCEPTED";
    const fireId = detection.fire_id;
    const { confidence, frp } = payload.changes;
    if (frp !== undefined) detection.frp_mw = frp;
    if (confidence !== undefined) {
        detection.confidence = confidence;
        detection.disposition = confidence === LOW_CONFIDENCE ? "LOW_CONFIDENCE" : "ACCEPTED";
    }
    detection.feed_offset = payload.offset;
    state.pendingDetections.set(detection.detection_key, detection);

    const isAccepted = detection.disposition === "ACCEPTED";
    if (!wasAccepted && isAccepted) {
        attach(detection);
    } else if (wasAccepted && !isAccepted) {
        setFireId(detection, null);
        if (fireId) refreshFire(fireId);
    } else if (isAccepted && fireId) {
        refreshFire(fireId);
    }
}

function handleRetract(payload) {
    const detection = state.detections.get(payload.key);
    if (!detection || isStale(detection)) return;

    const fireId = detection.fire_id;
    state.detections.delete(payload.key);
    detection.disposition = "RETRACTED";
    detection.fire_id = null;
    detection.feed_offset = payload.offset;
    state.pendingDetections.set(detection.detection_key, detection);
    if (fireId) refreshFire(fireId);
}

function handleHeartbeat(payload) {
    advanceClock(toMs(payload.virtual_now));
}

async function handleFeedEvent(event) {
    if (state.failure) {
        const failure = state.failure;
        await loadState();
        throw failure;
    }

    const payload = JSON.parse(event.data);
    if (event.type === "detection") handleDetection(payload);
    else if (event.type === "update") handleUpdate(payload);
    else if (event.type === "retract") handleRetract(payload);
    else if (event.type === "heartbeat") handleHeartbeat(payload);
    state.offset = payload.offset;
}

const fireSignature = (fire) => JSON.stringify([
    fire.status, fire.merged_into, fire.latitude, fire.longitude, fire.detection_count,
    fire.satellites, fire.max_confidence, fire.total_frp_mw,
    toMs(fire.earliest_detected_at), toMs(fire.latest_detected_at),
    fire.closed_at ? toMs(fire.closed_at) : null,
]);

function setFireId(detection, fireId) {
    if (detection.fire_id === fireId) return;
    detection.fire_id = fireId;
    state.pendingDetections.set(detection.detection_key, detection);
}

function retireFire(fireId, status, mergedInto) {
    const previous = state.fires.get(fireId);
    state.pendingFires.set(fireId, { ...previous, status, merged_into: mergedInto });
    state.fires.delete(fireId);
}

function neighborsOf(detection) {
    const neighbors = [];
    for (const other of state.detections.values()) {
        if (other !== detection && other.disposition === "ACCEPTED" && isLinked(detection, other)) {
            neighbors.push(other);
        }
    }
    return neighbors;
}

function membersOfFires(fireIds) {
    const members = [];
    for (const detection of state.detections.values()) {
        if (detection.disposition === "ACCEPTED" && fireIds.has(detection.fire_id)) members.push(detection);
    }
    return members;
}

function reconcileSubset(subset, touchedFireIds) {
    const groups = groupLinkedDetections(subset.filter((detection) => detection.disposition === "ACCEPTED"));
    const claimed = new Set();

    for (const members of groups) {
        if (members.length < 2) {
            setFireId(members[0], null);
            continue;
        }

        const candidates = members.map((member) =>
            claimed.has(member.fire_id) ? { ...member, fire_id: null } : member
        );
        const { fireId, mergedFireIds } = resolveFireId(candidates, state.fires);
        claimed.add(fireId);
        mergedFireIds.forEach((id) => claimed.add(id));

        members.forEach((member) => setFireId(member, fireId));
        mergedFireIds.forEach((id) => retireFire(id, "MERGED", fireId));

        const previous = state.fires.get(fireId);
        const fire = { fire_id: fireId, status: "ACTIVE", merged_into: null, closed_at: null, ...summarizeFire(members) };
        if (!previous || fireSignature(previous) !== fireSignature(fire)) state.pendingFires.set(fireId, fire);
        state.fires.set(fireId, fire);
    }

    for (const fireId of touchedFireIds) {
        if (state.fires.has(fireId) && !claimed.has(fireId)) retireFire(fireId, "DISSOLVED", null);
    }
}

function attach(detection) {
    const neighbors = neighborsOf(detection);
    if (neighbors.length === 0) return;

    const fireIds = new Set(neighbors.map((neighbor) => neighbor.fire_id).filter(Boolean));
    const subset = new Set([detection, ...neighbors, ...membersOfFires(fireIds)]);
    reconcileSubset([...subset], fireIds);
}

function refreshFire(fireId) {
    const fireIds = new Set([fireId]);
    reconcileSubset(membersOfFires(fireIds), fireIds);
}

function isStale(detection) {
    const watermark = watermarkMs();
    if (watermark === null) return false;
    if (!detection.fire_id) return detection.detected_ms + LINK_MAX_TIME_DIFF_MS < watermark;
    const fire = state.fires.get(detection.fire_id);
    return !fire || watermark > toMs(fire.latest_detected_at) + LINK_MAX_TIME_DIFF_MS;
}

function sweep() {
    const watermark = watermarkMs();
    if (watermark === null) return;

    const closing = new Set();
    for (const [fireId, fire] of state.fires) {
        if (watermark > toMs(fire.latest_detected_at) + LINK_MAX_TIME_DIFF_MS) closing.add(fireId);
    }
    for (const fireId of closing) {
        state.pendingFires.set(fireId, { ...state.fires.get(fireId), closed_at: new Date(state.clockMs) });
        state.fires.delete(fireId);
    }
    for (const [key, detection] of state.detections) {
        const stale = detection.fire_id
            ? closing.has(detection.fire_id)
            : detection.detected_ms + LINK_MAX_TIME_DIFF_MS < watermark;
        if (stale) state.detections.delete(key);
    }
}

function buildBatch() {
    sweep();

    const fires = [...state.pendingFires.values()];
    const detections = [...state.pendingDetections.values()].map((detection) => ({ ...detection }));
    if (state.offset === state.committedOffset && fires.length === 0 && detections.length === 0) return null;

    const watermark = watermarkMs();
    state.pendingFires = new Map();
    state.pendingDetections = new Map();
    return { offset: state.offset, watermark: watermark === null ? null : new Date(watermark), fires, detections };
}

async function flush() {
    const batch = buildBatch();
    if (!batch) return;
    await commitBatch(batch);
    state.committedOffset = batch.offset;
}

async function startEventProcessor() {
    await loadState();
    setInterval(async () => {
        if (flushing || state.failure) return;
        flushing = true;
        try {
            await flush();
        } catch (error) {
            state.failure = error;
            log.error({ event: "flush_failed", message: error.message });
        } finally {
            flushing = false;
        }
    }, FLUSH_INTERVAL_MS);
}

function getResumeOffset() {
    return state.offset + 1;
}

module.exports = { startEventProcessor, handleFeedEvent, getResumeOffset };
