const THREAT_LEVEL_TO_SEVERITY = { Waspada: "WASPADA", Siaga: "SIAGA", Awas: "AWAS" };

function computeSeverityFromMagnitude(magnitude) {
    if (magnitude >= 6.5) return "SIAGA";
    if (magnitude >= 5.0) return "WASPADA";
    return "NORMAL";
}

function mapSeismicEventToHazardEvent(seismicEvent, relatedTsunamiWarning) {
    const {
        event_id, magnitude, depth_km,
        epicenter_lat, epicenter_lon,
        region_name, occurred_at, potential_tsunami,
        ...restFields
    } = seismicEvent;

    const severity = relatedTsunamiWarning
        ? THREAT_LEVEL_TO_SEVERITY[relatedTsunamiWarning.threat_level]
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
            ...(relatedTsunamiWarning ? { tsunami_warning: relatedTsunamiWarning } : {})
        }
    };
}

module.exports = { mapSeismicEventToHazardEvent };

