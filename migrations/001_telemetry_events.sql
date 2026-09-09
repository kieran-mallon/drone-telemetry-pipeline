-- ---------------------------------------------------------------------------
-- 001: the serving table for valid, structured telemetry.
--
-- Shape: typed columns for everything we query on, plus JSONB for everything
-- we do not. Drone firmware evolves faster than this pipeline can be
-- redeployed, so a rigid column-per-field schema would force a migration every
-- time a new sensor ships. Equally, putting *everything* in JSONB would make
-- the two queries we actually care about slow and unindexable. This is the
-- middle ground: model what you query, keep the rest.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telemetry_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Idempotency key. Supplied by the drone if it sends one, otherwise
    -- derived deterministically from the record's content (see core/transform.ts).
    -- The UNIQUE constraint is what makes at-least-once delivery safe: a
    -- redelivered SQS message or a re-uploaded file collides here and is skipped.
    event_id     TEXT        NOT NULL,

    drone_id     TEXT        NOT NULL,
    event_time   TIMESTAMPTZ NOT NULL,
    event_type   TEXT        NOT NULL,
    status_code  INTEGER,

    -- Derived at transform time from event_type and status_code so that the
    -- "show me errors" query is a simple indexed predicate rather than a
    -- scattered set of OR conditions that has to change every time a new
    -- failure event type is introduced.
    severity     TEXT        NOT NULL,

    -- Promoted out of telemetryData because they are the fields most likely to
    -- be filtered, aggregated or charted. Nullable: the brief is explicit that
    -- fields may be missing, and a missing battery reading is not a reason to
    -- reject an otherwise good delivery event.
    battery_pct  NUMERIC(5, 2),
    latitude     DOUBLE PRECISION,
    longitude    DOUBLE PRECISION,

    -- Everything else the drone sent under telemetryData, validated as an
    -- object but otherwise unmodelled.
    telemetry    JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- The original record exactly as received. Cheap insurance: if we later
    -- discover the transform dropped or mangled something, we can replay from
    -- here rather than asking the fleet to resend.
    raw          JSONB       NOT NULL,

    -- Provenance, e.g. "s3://drone-telemetry-raw/2026-09-09/batch.csv#L42" or
    -- "sqs:a1b2c3". Makes a bad batch traceable back to its origin.
    source       TEXT        NOT NULL,

    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT telemetry_events_event_id_key UNIQUE (event_id),
    CONSTRAINT telemetry_events_severity_check
        CHECK (severity IN ('info', 'warning', 'error')),
    CONSTRAINT telemetry_events_battery_range
        CHECK (battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100)),
    CONSTRAINT telemetry_events_latitude_range
        CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT telemetry_events_longitude_range
        CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

-- Serves: "find all events for a specific drone", newest first.
-- Composite and ordered so that the common query (one drone, a time range,
-- most recent first) is satisfied entirely by an index scan with no sort.
CREATE INDEX IF NOT EXISTS idx_telemetry_events_drone_time
    ON telemetry_events (drone_id, event_time DESC);

-- Serves: "find all errors within a time window".
-- Deliberately PARTIAL. Errors should be a small minority of traffic, so
-- indexing only those rows keeps this index a fraction of the size of a full
-- one on event_time and keeps it hot in cache. If errors ever became the
-- majority the partial predicate would stop paying for itself.
CREATE INDEX IF NOT EXISTS idx_telemetry_events_errors_time
    ON telemetry_events (event_time DESC)
    WHERE severity = 'error';

-- Serves: ad-hoc filtering on telemetry fields we chose not to promote to
-- columns, e.g. telemetry @> '{"payloadAttached": true}'. jsonb_path_ops is
-- smaller and faster than the default operator class, at the cost of only
-- supporting containment queries, which is the access pattern we expect here.
CREATE INDEX IF NOT EXISTS idx_telemetry_events_telemetry
    ON telemetry_events USING GIN (telemetry jsonb_path_ops);

COMMENT ON TABLE telemetry_events IS
    'Valid, structured drone telemetry. One row per unique event_id.';
