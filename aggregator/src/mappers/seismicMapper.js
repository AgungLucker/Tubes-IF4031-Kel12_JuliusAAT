const THREAT_LEVEL_TO_SEVERITY = { Waspada: "WASPADA", Siaga: "SIAGA", Awas: "AWAS" };
const SEVERITY_RANK = { WASPADA: 1, SIAGA: 2, AWAS: 3 };

// asumsi satu seismic events -> multiple tsunami events
function computeSeverityFromTsunamiWarnings(tsunamiWarnings) {
    let best = null;
    for (const tsunamiWarning of tsunamiWarnings) {
        const severity = THREAT_LEVEL_TO_SEVERITY[tsunamiWarning.threat_level];
        if (!best || SEVERITY_RANK[severity] > SEVERITY_RANK[best]) {
            best = severity;
        }
    }
    return best;
}

function computeSeverityFromMagnitude(magnitude) {
    if (magnitude >= 6.5) return "SIAGA";
    if (magnitude >= 5.0) return "WASPADA";
    return "NORMAL";
}

function mapSeismicEventToHazardEvent(seismicEvent, relatedTsunamiWarnings = []) {
    const {
        event_id, magnitude, depth_km,
        epicenter_lat, epicenter_lon,
        region_name, occurred_at, potential_tsunami,
        ...restFields
    } = seismicEvent;

    const severity = relatedTsunamiWarnings.length > 0
        ? computeSeverityFromTsunamiWarnings(relatedTsunamiWarnings)
        : computeSeverityFromMagnitude(magnitude);

    return {
        hazard_id: `BMKG-${event_id}`,
        source: "BMKG",
        source_ref_id: event_id,
        hazard_type: "SEISMIC",
        severity,
        area_name: region_name,
        latitude: epicenter_lat,
        longitude: epicenter_lon,
        occurred_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            magnitude,
            depth_km,
            potential_tsunami,
            ...restFields,
            ...(relatedTsunamiWarnings.length > 0 ? { tsunami_warnings: relatedTsunamiWarnings } : {})
        }
    };
}

module.exports = { mapSeismicEventToHazardEvent };

