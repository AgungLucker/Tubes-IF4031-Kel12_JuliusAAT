CREATE TABLE seismic_events (
    event_id VARCHAR(100) PRIMARY KEY,
    magnitude DOUBLE PRECISION NOT NULL,
    depth_km DOUBLE PRECISION NOT NULL,
    epicenter_lat DOUBLE PRECISION NOT NULL,
    epicenter_lon DOUBLE PRECISION NOT NULL,
    region_name VARCHAR(255) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    potential_tsunami BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE tsunami_warnings (
    warning_id VARCHAR(100) PRIMARY KEY,
    related_event_id VARCHAR(100) NOT NULL,
    threat_level VARCHAR(10) NOT NULL,
    affected_zones TEXT[] NOT NULL,
    estimated_arrival TIMESTAMPTZ,

    CONSTRAINT fk_tsunami_event
        FOREIGN KEY (related_event_id)
        REFERENCES seismic_events(event_id),

    CONSTRAINT chk_threat_level
        CHECK (threat_level IN ('Waspada', 'Siaga', 'Awas'))
);

CREATE SEQUENCE seismic_events_seq START WITH 21;
CREATE SEQUENCE tsunami_warnings_seq START WITH 11;

INSERT INTO seismic_events (
    event_id,
    magnitude,
    depth_km,
    epicenter_lat,
    epicenter_lon,
    region_name,
    occurred_at,
    potential_tsunami
) VALUES
('SE001', 4.8, 32.5, -6.21, 106.82, 'Selat Sunda', '2026-09-10 02:15:00+07', FALSE),
('SE002', 5.2, 18.7, -8.32, 115.41, 'Bali', '2026-09-10 14:42:00+07', TRUE),
('SE003', 4.5, 76.2, -0.91, 100.46, 'Sumatera Barat', '2026-09-11 06:30:00+07', FALSE),
('SE004', 6.1, 24.8, -3.72, 128.18, 'Ambon, Maluku', '2026-09-11 19:05:00+07', TRUE),
('SE005', 4.2, 91.4, -7.81, 110.37, 'Jawa Tengah', '2026-09-12 04:17:00+07', FALSE),

('SE006', 5.7, 42.1, -9.12, 119.48, 'Sumba, Nusa Tenggara Timur', '2026-09-12 16:23:00+07', TRUE),
('SE007', 4.6, 55.3, -2.54, 101.21, 'Bengkulu', '2026-09-13 08:11:00+07', FALSE),
('SE008', 5.0, 63.7, -8.57, 116.09, 'Lombok, NTB', '2026-09-13 21:48:00+07', FALSE),
('SE009', 6.3, 17.9, -0.42, 125.67, 'Laut Maluku', '2026-09-14 05:36:00+07', TRUE),
('SE010', 4.4, 108.5, -6.89, 108.42, 'Jawa Barat', '2026-09-14 17:12:00+07', FALSE),

('SE011', 5.5, 29.6, -5.83, 130.21, 'Kepulauan Banda', '2026-09-15 03:27:00+07', TRUE),
('SE012', 4.9, 44.8, -8.04, 111.92, 'Jawa Timur', '2026-09-15 12:54:00+07', FALSE),
('SE013', 5.1, 36.4, -2.97, 119.52, 'Sulawesi Selatan', '2026-09-16 07:43:00+07', FALSE),
('SE014', 6.0, 21.5, -7.46, 113.18, 'Selatan Jawa Timur', '2026-09-16 20:16:00+07', TRUE),
('SE015', 4.3, 82.6, -1.64, 103.91, 'Jambi', '2026-09-17 09:08:00+07', FALSE),

('SE016', 5.8, 27.3, -10.24, 124.71, 'Laut Timor', '2026-09-18 01:52:00+07', TRUE),
('SE017', 4.7, 68.9, -6.34, 107.14, 'Jawa Barat', '2026-09-19 15:31:00+07', FALSE),
('SE018', 6.2, 15.7, -3.11, 128.45, 'Maluku', '2026-09-21 11:22:00+07', TRUE),
('SE019', 4.1, 102.3, -7.25, 109.87, 'Jawa Tengah', '2026-09-23 06:45:00+07', FALSE),
('SE020', 5.4, 33.8, -8.91, 121.64, 'Flores, NTT', '2026-09-24 10:18:00+07', TRUE);


INSERT INTO tsunami_warnings (
    warning_id,
    related_event_id,
    threat_level,
    affected_zones,
    estimated_arrival
) VALUES
('TW001', 'SE002', 'Waspada',
    ARRAY['Pantai Selatan Bali', 'Nusa Penida'],
    '2026-09-10 15:30:00+07'),

('TW002', 'SE004', 'Siaga',
    ARRAY['Ambon', 'Seram Bagian Barat'],
    '2026-09-11 20:10:00+07'),

('TW003', 'SE006', 'Waspada',
    ARRAY['Waingapu', 'Sumba Timur'],
    '2026-09-12 17:40:00+07'),

('TW004', 'SE009', 'Awas',
    ARRAY['Ternate', 'Tidore', 'Halmahera Barat'],
    '2026-09-14 07:15:00+07'),

('TW005', 'SE011', 'Siaga',
    ARRAY['Kepulauan Banda', 'Maluku Tengah'],
    '2026-09-15 04:50:00+07'),

('TW006', 'SE014', 'Waspada',
    ARRAY['Pacitan', 'Trenggalek', 'Tulungagung'],
    '2026-09-16 21:30:00+07'),

('TW007', 'SE016', 'Siaga',
    ARRAY['Kupang', 'Timor Tengah Selatan'],
    '2026-09-18 03:10:00+07'),

('TW008', 'SE018', 'Awas',
    ARRAY['Ambon', 'Pulau Seram', 'Buru'],
    '2026-09-21 12:40:00+07'),

('TW009', 'SE020', 'Waspada',
    ARRAY['Ende', 'Sikka', 'Flores Timur'],
    '2026-09-24 11:45:00+07'),

('TW010', 'SE004', 'Waspada',
    ARRAY['Ambon', 'Seram', 'Buru'],
    '2026-09-11 22:00:00+07');