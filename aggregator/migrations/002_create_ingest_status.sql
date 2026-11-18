
CREATE TABLE IF NOT EXISTS ingest_status (
    source              TEXT PRIMARY KEY CHECK (source IN ('BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI')),
    last_cursor         TEXT,
    last_success_at     TIMESTAMPTZ,
    last_error_at       TIMESTAMPTZ,
    last_error_message  TEXT
);

INSERT INTO ingest_status (source)
VALUES ('BMKG'), ('PVMBG'), ('SATELIT'), ('SENSOR_PANTAI')
ON CONFLICT (source) DO NOTHING;
