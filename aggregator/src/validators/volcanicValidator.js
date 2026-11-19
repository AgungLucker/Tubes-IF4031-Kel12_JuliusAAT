const ALERT_LEVELS = ["Normal", "Waspada", "Siaga", "Awas"];

const REQUIRED_FIELDS = {
    report_id: { type: "string" },
    volcano_id: { type: "string" },
    alert_level: { type: "string" },
    eruption_count_24h: { type: "number", nullable: true },
    ash_column_height_m: { type: "number", nullable: true },
    reported_at: { type: "string" },
};


function validateVolcanicReport(report) {
    for (const field in REQUIRED_FIELDS) {
        const rule = REQUIRED_FIELDS[field];

        if (!(field in report)) {
            return `schema_incompatible: field '${field}' hilang`;
        }

        const value = report[field];
        if (value === null && rule.nullable) continue;

        const actual = value === null ? "null" : typeof value;
        if (actual !== rule.type) {
            return `schema_incompatible: field '${field}' berubah dari ${rule.type} menjadi ${actual}`;
        }
    }

    if (!ALERT_LEVELS.includes(report.alert_level)) {
        return `schema_incompatible: nilai alert_level '${report.alert_level}' tidak dikenal`;
    }

    return null;
}

module.exports = { validateVolcanicReport };