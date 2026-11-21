// Base contract of Sensor Pantai (Lampiran C). The sensor is a black box we do not control, so
// EVERY observation is checked; whatever fails is set aside with a reason instead of becoming a
// HazardEvent. The checks look only at the shape and plausibility of the record, never at ids,
// ordering or any pattern of a particular test profile.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const QUALITY_OK = new Set((process.env.PANTAI_QUALITY_OK || "ok").split(","));
const MAX_ABS_SEA_LEVEL_M = Number(process.env.PANTAI_MAX_SEA_LEVEL_M || 30);
const MAX_WAVE_M = Number(process.env.PANTAI_MAX_WAVE_M || 60);
const FUTURE_TOLERANCE_MS = 1000;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

function parseTime(v) {
    if (typeof v !== "string" || !ISO_UTC.test(v)) return NaN;
    return Date.parse(v);
}

// generatedAt: the sensor's own clock for this response in ms (not ours: its time may run faster).
// stations: Map(station_id -> station) or null when the station list is unavailable.
function validateObservation(obs, { generatedAt = null, stations = null } = {}) {
    if (obs === null || typeof obs !== "object" || Array.isArray(obs)) {
        return "contract_violation: observasi bukan objek";
    }
    for (const f of ["observation_id", "station_id"]) {
        if (!nonEmptyString(obs[f])) return `contract_violation: '${f}' hilang atau bukan string`;
    }
    const observedMs = parseTime(obs.observed_at);
    if (Number.isNaN(observedMs)) return "contract_violation: 'observed_at' bukan waktu ISO-8601 yang valid";
    if (generatedAt !== null && observedMs > generatedAt + FUTURE_TOLERANCE_MS) {
        return "contract_violation: 'observed_at' lebih baru dari 'generated_at' respons";
    }
    if (!isFiniteNumber(obs.sea_level_anomaly_m)) return "contract_violation: 'sea_level_anomaly_m' bukan angka";
    if (Math.abs(obs.sea_level_anomaly_m) > MAX_ABS_SEA_LEVEL_M) {
        return `out_of_range: sea_level_anomaly_m=${obs.sea_level_anomaly_m} di luar +-${MAX_ABS_SEA_LEVEL_M} m`;
    }
    if (!isFiniteNumber(obs.wave_height_m)) return "contract_violation: 'wave_height_m' bukan angka";
    if (obs.wave_height_m < 0 || obs.wave_height_m > MAX_WAVE_M) {
        return `out_of_range: wave_height_m=${obs.wave_height_m} di luar 0..${MAX_WAVE_M} m`;
    }
    if (typeof obs.critical !== "boolean") return "contract_violation: 'critical' bukan boolean";
    if (!nonEmptyString(obs.quality)) return "contract_violation: 'quality' hilang atau bukan string";
    if (!QUALITY_OK.has(obs.quality)) return `quality_not_ok: quality='${obs.quality}'`;
    if (stations && !stations.has(obs.station_id)) return `unknown_station: '${obs.station_id}' tidak ada di /v1/stations`;
    return null;
}

function validateStation(st) {
    if (!st || typeof st !== "object") return "station bukan objek";
    if (!nonEmptyString(st.station_id) || !nonEmptyString(st.name)) return "station_id/name hilang";
    if (!isFiniteNumber(st.latitude) || st.latitude < -90 || st.latitude > 90) return "latitude tidak valid";
    if (!isFiniteNumber(st.longitude) || st.longitude < -180 || st.longitude > 180) return "longitude tidak valid";
    return null;
}

module.exports = { validateObservation, validateStation, parseTime };
