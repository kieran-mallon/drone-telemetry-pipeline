-- ---------------------------------------------------------------------------
-- 002: the quarantine table for records that failed validation.
--
-- The important idea: a record that fails validation is NOT a processing
-- failure. Retrying it will never help, because the data itself is wrong. It
-- is dropped here with the reason attached, the message is acknowledged, and
-- the rest of the batch carries on. Only genuine infrastructure failures
-- (database unreachable, S3 unreachable) are retried and eventually land in
-- the SQS dead-letter queue.
--
-- Conflating the two is the most common failure mode in pipelines like this:
-- a DLQ that slowly fills with malformed records that can never succeed,
-- burning retries and hiding the real infrastructure failures among them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telemetry_quarantine (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Where the bad record came from, so an operator can go and look at it.
    source      TEXT        NOT NULL,

    -- TEXT, deliberately, not JSONB. The entire premise of this table is that
    -- the payload may be corrupt, and a JSONB column would reject exactly the
    -- rows we are trying to preserve. Storing it verbatim also means a fix can
    -- be replayed later without going back to the fleet.
    raw_payload TEXT        NOT NULL,

    -- Flattened validation issues: [{ path, code, message }, ...].
    -- Structured rather than a joined string so that "which field breaks most
    -- often" is a query, not a grep. That question usually points at a
    -- firmware bug on a specific drone model.
    errors      JSONB       NOT NULL,

    failed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the operational question "what has been failing recently, and why".
CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_failed_at
    ON telemetry_quarantine (failed_at DESC);

COMMENT ON TABLE telemetry_quarantine IS
    'Records that failed validation. Preserved verbatim for diagnosis and replay.';
