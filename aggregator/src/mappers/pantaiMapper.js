const { makeHazardId } = require("../db/hazardId");

// A critical observation is a direct sighting of a coastal hazard: severity AWAS, which is also
// what routes it to the Tim Lapangan notifier (binding hazard.*.awas).
function mapObservationToHazardEvent(obs, station) {
    const { observation_id, station_id, observed_at, sea_level_anomaly_m, wave_height_m, quality, critical, ...rest } = obs;
    return {
        hazard_id: makeHazardId("SENSOR_PANTAI", observation_id),
        source: "SENSOR_PANTAI",
        source_ref_id: observation_id,
        hazard_type: "COASTAL",
        severity: critical ? "AWAS" : "NORMAL",
        area_name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        occurred_at: new Date(observed_at).toISOString(),
        ingested_at: new Date().toISOString(),
        attributes: {
            station_id, province: station.province ?? null,
            sea_level_anomaly_m, wave_height_m, quality, critical,
            ...rest,
        },
    };
}

module.exports = { mapObservationToHazardEvent };
