CREATE TABLE volcanic_reports (
    report_id VARCHAR PRIMARY KEY,
    volcano_id VARCHAR NOT NULL,
    alert_level VARCHAR NOT NULL,
    eruption_count_24h INTEGER,
    ash_column_height_m FLOAT,
    reported_at TIMESTAMP NOT NULL,
    confidence_level FLOAT,

    CONSTRAINT chk_alert_level
        CHECK (alert_level IN ('Normal', 'Waspada', 'Siaga', 'Awas'))
);

CREATE SEQUENCE report_id_seq START WITH 21;

INSERT INTO volcanic_reports (
    report_id,
    volcano_id,
    alert_level,
    eruption_count_24h,
    ash_column_height_m,
    reported_at,
    confidence_level
) VALUES
('VR1', 'V001', 'Normal', 1, 500, '2026-09-10 01:15:00', NULL),
('VR2', 'V002', 'Siaga', 3, 1200, '2026-09-10 03:40:00', NULL),
('VR3', 'V003', 'Awas', 5, 3500, '2026-09-12 05:20:00', NULL),
('VR4', 'V004', 'Waspada', 0, 300, '2026-09-12 07:10:00', NULL),
('VR5', 'V005', 'Siaga', 2, 1800, '2026-09-14 08:45:00', NULL),
('VR6', 'V001', 'Normal', 1, 700, '2026-09-14 10:30:00', NULL),
('VR7', 'V006', 'Waspada', 2, 650, '2026-09-16 12:15:00', NULL),
('VR8', 'V007', 'Siaga', 4, 2100, '2026-09-16 14:50:00', NULL),
('VR9', 'V003', 'Awas', 6, 4200, '2026-09-18 16:20:00', NULL),
('VR10', 'V008', 'Waspada', 0, 250, '2026-09-18 18:05:00', NULL),

('VR11', 'V002', 'Siaga', 3, 1500, '2026-09-18 20:40:00', NULL),
('VR12', 'V004', 'Normal', 1, 450, '2026-09-18 22:15:00', NULL),
('VR13', 'V005', 'Siaga', 2, 1900, '2026-09-19 00:30:00', NULL),
('VR14', 'V006', 'Waspada', 1, 600, '2026-09-19 02:45:00', NULL),
('VR15', 'V007', 'Siaga', 3, 2300, '2026-09-19 04:10:00', NULL),
('VR16', 'V008', 'Waspada', 0, 200, '2026-09-20 06:25:00', NULL),
('VR17', 'V001', 'Normal', 2, 800, '2026-09-20 08:00:00', NULL),
('VR18', 'V002', 'Siaga', 4, 1700, '2026-09-21 09:35:00', NULL),
('VR19', 'V003', 'Awas', 7, 4500, '2026-09-22 10:50:00', NULL),
('VR20', 'V005', 'Siaga', 2, 1600, '2026-09-24 12:20:00', NULL);