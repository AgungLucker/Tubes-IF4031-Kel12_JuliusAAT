const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function validateDetection({ detection }) {
    if (!isObject(detection)) return "detection bukan objek";
    if (!isText(detection.satellite)) return "satellite kosong atau bukan teks";
    if (!isText(detection.confidence)) return "confidence kosong atau bukan teks";
    if (!isValidDate(detection.acq_date)) return `acq_date tidak valid: ${detection.acq_date}`;
    if (!Number.isInteger(detection.acq_time) || detection.acq_time < 0 || detection.acq_time > 2359 || detection.acq_time % 100 > 59) {
        return `acq_time tidak valid: ${detection.acq_time}`;
    }
    if (!isNumber(detection.latitude) || detection.latitude < -90 || detection.latitude > 90) {
        return `latitude tidak valid: ${detection.latitude}`;
    }
    if (!isNumber(detection.longitude) || detection.longitude < -180 || detection.longitude > 180) {
        return `longitude tidak valid: ${detection.longitude}`;
    }
    if (!isNumber(detection.frp) || detection.frp < 0) return `frp tidak valid: ${detection.frp}`;
    return null;
}

function validateUpdate({ key, changes }) {
    if (!isText(key)) return "key kosong atau bukan teks";
    if (!isObject(changes)) return "changes bukan objek";
    if (changes.confidence !== undefined && !isText(changes.confidence)) return "changes.confidence bukan teks";
    if (changes.frp !== undefined && (!isNumber(changes.frp) || changes.frp < 0)) return `changes.frp tidak valid: ${changes.frp}`;
    return null;
}

function validateRetract({ key }) {
    return isText(key) ? null : "key kosong atau bukan teks";
}

function validateHeartbeat({ virtual_now }) {
    return typeof virtual_now === "string" && !Number.isNaN(Date.parse(virtual_now)) ? null : "virtual_now bukan waktu yang valid";
}

const CHECKS = {
    detection: validateDetection,
    update: validateUpdate,
    retract: validateRetract,
    heartbeat: validateHeartbeat,
};

function validateFeedEvent(type, payload) {
    if (!isObject(payload)) return "payload bukan objek";
    if (!Number.isInteger(payload.offset)) return "offset bukan bilangan bulat";
    const check = CHECKS[type];
    return check ? check(payload) : null;
}

module.exports = { validateFeedEvent };
