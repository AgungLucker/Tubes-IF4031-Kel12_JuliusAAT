
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


CREATE TABLE IF NOT EXISTS rejected_messages (
    message_id      TEXT PRIMARY KEY,
    source          TEXT NOT NULL CHECK (source IN ('BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI', 'FIELD_REPORT')),
    source_ref_id   TEXT,
    raw_payload     BYTEA NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT NOT NULL,
    retryable       BOOLEAN NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL CHECK (status IN ('retrying', 'parked', 'recovered')),
    next_attempt_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rejected_replay ON rejected_messages (status, next_attempt_at);

