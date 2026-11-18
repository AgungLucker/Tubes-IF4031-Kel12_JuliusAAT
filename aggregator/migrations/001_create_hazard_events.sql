

CREATE TABLE IF NOT EXISTS hazard_events (
    hazard_id       TEXT COLLATE "C" PRIMARY KEY,
    bucket          SMALLINT NOT NULL CHECK (bucket >= 0 AND bucket < 64),
    source          TEXT NOT NULL CHECK (source IN ('BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI')),
    source_ref_id   TEXT COLLATE "C" NOT NULL,
    hazard_type     TEXT NOT NULL CHECK (hazard_type IN ('SEISMIC', 'TSUNAMI', 'VOLCANIC', 'WILDFIRE', 'COASTAL')),
    severity        TEXT NOT NULL CHECK (severity IN ('NORMAL', 'WASPADA', 'SIAGA', 'AWAS')),
    area_name       TEXT NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    attributes      JSONB NOT NULL DEFAULT '{}',
    UNIQUE (source, source_ref_id)
);

CREATE INDEX IF NOT EXISTS idx_he_ingested        ON hazard_events (ingested_at, hazard_id);
CREATE INDEX IF NOT EXISTS idx_he_source_ingested ON hazard_events (source, ingested_at, hazard_id);

CREATE INDEX IF NOT EXISTS idx_he_latest          ON hazard_events (occurred_at DESC, hazard_id DESC);
CREATE INDEX IF NOT EXISTS idx_he_type_latest     ON hazard_events (hazard_type, occurred_at DESC, hazard_id DESC);

CREATE INDEX IF NOT EXISTS idx_he_bucket          ON hazard_events (bucket);
