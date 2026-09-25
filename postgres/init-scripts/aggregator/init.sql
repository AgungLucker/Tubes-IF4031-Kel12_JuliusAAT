CREATE TABLE hazard_events (
    hazard_id       TEXT PRIMARY KEY,
    source          TEXT NOT NULL CHECK (source IN ('BMKG', 'PVMBG')),
    source_ref_id   TEXT NOT NULL,
    hazard_type     TEXT NOT NULL CHECK (hazard_type IN ('SEISMIC', 'VOLCANIC')),
    severity        TEXT NOT NULL CHECK (severity IN ('NORMAL', 'WASPADA', 'SIAGA', 'AWAS')),
    area_name       TEXT NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    attributes      JSONB NOT NULL DEFAULT '{}',
    UNIQUE (source, source_ref_id)
);

CREATE INDEX idx_hazard_events_occurred_at ON hazard_events (occurred_at);
CREATE INDEX idx_hazard_events_hazard_type ON hazard_events (hazard_type);

CREATE TABLE ingest_status (
    source              TEXT PRIMARY KEY CHECK (source IN ('BMKG', 'PVMBG')),
    last_cursor         TIMESTAMPTZ,
    last_success_at     TIMESTAMPTZ,
    last_error_at       TIMESTAMPTZ,
    last_error_message  TEXT
);

INSERT INTO ingest_status (source) VALUES ('BMKG'), ('PVMBG');
