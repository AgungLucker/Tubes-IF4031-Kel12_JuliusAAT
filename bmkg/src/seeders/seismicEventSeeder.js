const pool = require("../db/connection");

const locations = [
    { name: "Selat Sunda", lat: -6.21, lon: 106.82 },
    { name: "Bali", lat: -8.32, lon: 115.41 },
    { name: "Sumatera Barat", lat: -0.91, lon: 100.46 },
    { name: "Ambon, Maluku", lat: -3.72, lon: 128.18 },
    { name: "Jawa Tengah", lat: -7.81, lon: 110.37 },
    { name: "Sumba, Nusa Tenggara Timur", lat: -9.12, lon: 119.48 },
    { name: "Bengkulu", lat: -2.54, lon: 101.21 },
    { name: "Lombok, NTB", lat: -8.57, lon: 116.09 },
    { name: "Laut Maluku", lat: -0.42, lon: 125.67 },
    { name: "Jawa Barat", lat: -6.89, lon: 108.42 },
    { name: "Kepulauan Banda", lat: -5.83, lon: 130.21 },
    { name: "Jawa Timur", lat: -8.04, lon: 111.92 },
    { name: "Sulawesi Selatan", lat: -2.97, lon: 119.52 },
    { name: "Selatan Jawa Timur", lat: -7.46, lon: 113.18 },
    { name: "Jambi", lat: -1.64, lon: 103.91 },
    { name: "Laut Timor", lat: -10.24, lon: 124.71 },
    { name: "Jawa Barat", lat: -6.34, lon: 107.14 },
    { name: "Maluku", lat: -3.11, lon: 128.45 },
    { name: "Jawa Tengah", lat: -7.25, lon: 109.87 },
    { name: "Flores, NTT", lat: -8.91, lon: 121.64 }
];

const affectedZonesByRegion = {
    "Bali": [
        "Pantai Selatan Bali",
        "Nusa Penida"
    ],

    "Ambon, Maluku": [
        "Ambon",
        "Seram",
        "Buru"
    ],

    "Sumba, Nusa Tenggara Timur": [
        "Waingapu",
        "Sumba Timur"
    ],

    "Laut Maluku": [
        "Ternate",
        "Tidore",
        "Halmahera Barat"
    ],

    "Kepulauan Banda": [
        "Kepulauan Banda",
        "Maluku Tengah"
    ],

    "Selatan Jawa Timur": [
        "Pacitan",
        "Trenggalek",
        "Tulungagung"
    ],

    "Laut Timor": [
        "Kupang",
        "Timor Tengah Selatan"
    ],

    "Maluku": [
        "Ambon",
        "Pulau Seram",
        "Buru"
    ],

    "Flores, NTT": [
        "Ende",
        "Sikka",
        "Flores Timur"
    ]
};

async function seedSeismicEvent() {
    const location =
        locations[Math.floor(Math.random() * locations.length)];

    const eventResult = await pool.query(
        `
        WITH generated AS (
            SELECT
                ROUND((RANDOM() * 4 + 3)::numeric, 2) AS magnitude,
                FLOOR(RANDOM() * 150) + 1 AS depth,
                $1::DOUBLE PRECISION AS epicenter_lat,
                $2::DOUBLE PRECISION AS epicenter_lon,
                $3::VARCHAR(255) AS region_name
        )
        INSERT INTO seismic_events (
            event_id,
            magnitude,
            depth_km,
            epicenter_lat,
            epicenter_lon,
            region_name,
            occurred_at,
            potential_tsunami
        )
        SELECT
            'SE' || LPAD(nextval('seismic_events_seq')::TEXT, 3, '0'),
            magnitude,
            depth,
            epicenter_lat,
            epicenter_lon,
            region_name,
            NOW(),
            magnitude >= 6.0 AND depth <= 70
        FROM generated
        RETURNING *;
        `,
        [
            location.lat,
            location.lon,
            location.name
        ]
    );

    const event = eventResult.rows[0];

    console.log("Seismic event seeded");

    if (event.potential_tsunami) {
        const affectedZones =
            affectedZonesByRegion[event.region_name] || [event.region_name];

        let threatLevel;

        if (event.magnitude >= 6.5) {
            threatLevel = "Awas";
        } else if (event.magnitude >= 6.2) {
            threatLevel = "Siaga";
        } else {
            threatLevel = "Waspada";
        }

        const estimatedArrival = new Date(
            new Date(event.occurred_at).getTime() + 30 * 60 * 1000
        );

        await pool.query(
            `
            INSERT INTO tsunami_warnings (
                warning_id,
                related_event_id,
                threat_level,
                affected_zones,
                estimated_arrival
            )
            VALUES (
                'TW' || LPAD(nextval('tsunami_warnings_seq')::TEXT, 3, '0'),
                $1,
                $2,
                $3,
                $4
            );
            `,
            [
                event.event_id,
                threatLevel,
                affectedZones,
                estimatedArrival
            ]
        );

        console.log("Tsunami warning created:");
    }
}

module.exports = seedSeismicEvent;