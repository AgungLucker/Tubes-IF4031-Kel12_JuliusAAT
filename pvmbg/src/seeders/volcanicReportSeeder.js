const pool = require("../db/connection");
const { getConfidenceLevel } = require('../routes/adminSchemaVersion');

async function seedVolcanicReport() {
    const isConfidenceEnabled = getConfidenceLevel();

    await pool.query(`
        INSERT INTO volcanic_reports (
            report_id,
            volcano_id,
            alert_level,
            eruption_count_24h,
            ash_column_height_m,
            reported_at,
            confidence_level
        )
        SELECT
            'VR' || LPAD(nextval('report_id_seq')::TEXT, 3, '0'),
            'V' || LPAD((FLOOR(RANDOM() * 8) + 1)::TEXT, 3, '0'),
            alert_level,
            FLOOR(RANDOM() * 19 + 1)::INT,
            CASE
                WHEN alert_level = 'Normal' THEN FLOOR(RANDOM() * 201)::INT
                WHEN alert_level = 'Waspada' THEN FLOOR(RANDOM() * 901 + 100)::INT
                WHEN alert_level = 'Siaga' THEN FLOOR(RANDOM() * 1501 + 500)::INT
                WHEN alert_level = 'Awas' THEN FLOOR(RANDOM() * 4001 + 1000)::INT
            END,
            NOW(),
            CASE
                WHEN $1::BOOLEAN = TRUE
                    THEN ROUND((RANDOM() * 0.15 + 0.85)::NUMERIC, 2)
                ELSE NULL
            END
        FROM (
            SELECT (ARRAY['Normal', 'Waspada', 'Siaga', 'Awas'])[FLOOR(RANDOM() * 4 + 1)::INT] AS alert_level
        ) AS generated;
    `, [isConfidenceEnabled]);
    console.log("Volcanic report seeded");

}

module.exports = seedVolcanicReport;