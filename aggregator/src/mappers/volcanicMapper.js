const { getVolcanoInfo } = require("../reference/volcanoRegistry");

const ALERT_LEVEL_TO_SEVERITY = { Normal: "NORMAL", Waspada: "WASPADA", Siaga: "SIAGA", Awas: "AWAS" };

function mapVolcanicReportToHazardEvent(volcanicReport) {
    const {
        report_id, volcano_id, alert_level,
        eruption_count_24h, ash_column_height_m, reported_at,
        ...restFields
    } = volcanicReport;

    const volcano = getVolcanoInfo(volcano_id);

    return {
        hazard_id: `PVMBG-${report_id}`,
        source: "PVMBG",
        source_ref_id: report_id,
        hazard_type: "VOLCANIC",
        severity: ALERT_LEVEL_TO_SEVERITY[alert_level],
        area_name: volcano.name,
        latitude: volcano.latitude,
        longitude: volcano.longitude,
        occurred_at: reported_at,
        ingested_at: new Date().toISOString(),
        attributes: {
            eruption_count_24h,
            ash_column_height_m,
            ...restFields
        }
    };
}

module.exports = { mapVolcanicReportToHazardEvent };