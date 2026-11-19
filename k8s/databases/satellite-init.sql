-- Posisi bacaan stream. Satu baris, diperbarui dalam transaksi yang sama
-- dengan perubahan detections/fires supaya offset dan state tidak pernah terpisah.
CREATE TABLE stream_checkpoint (
    stream_name     TEXT PRIMARY KEY,
    last_offset     BIGINT NOT NULL DEFAULT 0,
    watermark       TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO stream_checkpoint (stream_name) VALUES ('SATELLITE_FEED');

CREATE TABLE detections (
    detection_key   TEXT PRIMARY KEY,   
    satellite       TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL,   -- acq_date + acq_time (UTC)
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    confidence      TEXT NOT NULL,
    frp_mw          DOUBLE PRECISION NOT NULL DEFAULT 0,
    disposition     TEXT NOT NULL CHECK (disposition IN
                        ('ACCEPTED', 'LOW_CONFIDENCE', 'LATE_REJECTED', 'RETRACTED')),
    fire_id         TEXT,                   
    feed_offset     BIGINT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fires (
    fire_id             TEXT PRIMARY KEY,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE', 'MERGED', 'DISSOLVED')),
    merged_into         TEXT REFERENCES fires (fire_id),
    latitude            DOUBLE PRECISION NOT NULL,
    longitude           DOUBLE PRECISION NOT NULL,
    detection_count     INTEGER NOT NULL,
    satellites          TEXT[] NOT NULL DEFAULT '{}',
    max_confidence      TEXT NOT NULL,
    total_frp_mw        DOUBLE PRECISION NOT NULL DEFAULT 0,
    earliest_detected_at TIMESTAMPTZ NOT NULL,   -- occurred_at
    latest_detected_at   TIMESTAMPTZ NOT NULL,  
    closed_at           TIMESTAMPTZ,             
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE detections
    ADD CONSTRAINT fk_detections_fire FOREIGN KEY (fire_id) REFERENCES fires (fire_id);

CREATE INDEX idx_fires_updated_at     ON fires (updated_at);
CREATE INDEX idx_fires_status         ON fires (status);
CREATE INDEX idx_detections_fire_id   ON detections (fire_id);
CREATE INDEX idx_detections_detected  ON detections (detected_at);
CREATE INDEX idx_detections_disposition ON detections (disposition);
