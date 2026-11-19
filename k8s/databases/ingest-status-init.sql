
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


-- CREATE TABLE IF NOT EXISTS rejected_messages (
--     id TEXT PRIMARY KEY,              
--     source TEXT NOT NULL CHECK (source IN ('BMKG','PVMBG','SATELIT','SENSOR_PANTAI','FIELD_REPORT')),
--     source_ref_id TEXT,
--     raw_payload BYTEA NOT NULL,
--     received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--     source_time TIMESTAMPTZ,
--     failure_class TEXT NOT NULL CHECK (failure_class IN ('TRANSIENT','PERMANENT')),
--     reason TEXT NOT NULL,
--     status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','REPROCESSED', 'DISCARDED'))
-- );
