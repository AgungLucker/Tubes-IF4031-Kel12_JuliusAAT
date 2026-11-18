const { makeHazardId } = require("../db/hazardId");
const { findNearestProvince } = require("../reference/provinceRegistry");

function computeSeverityFromFire({ detection_count, total_frp_mw }) {
    if (detection_count >= 20 || total_frp_mw >= 100) return "AWAS";
    if (detection_count >= 6 || total_frp_mw >= 30) return "SIAGA";
    return "WASPADA";
}

function mapFireToHazardEvent(fire) {
    const {
        fire_id, latitude, longitude, detection_count, satellites,
        max_confidence, total_frp_mw, earliest_detected_at, detection_keys,
    } = fire;

    return {
        hazard_id: makeHazardId("SATELIT", fire_id),
        source: "SATELIT",
        source_ref_id: fire_id,
        hazard_type: "WILDFIRE",
        severity: computeSeverityFromFire({ detection_count, total_frp_mw }),
        area_name: findNearestProvince(latitude, longitude),
        latitude,
        longitude,
        occurred_at: earliest_detected_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            detection_count,
            satellites,
            max_confidence,
            total_frp_mw,
            detection_keys,
        }
    };
}

module.exports = { mapFireToHazardEvent };