CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_per_line_idx
  ON jobs (workspace_id, line_id)
  WHERE status = 'running';

ALTER TABLE jobs
  ADD CONSTRAINT jobs_payload_projection_check CHECK (
    payload->>'id' = id
    AND (payload->>'date')::date = planning_date
    AND payload->>'lineId' = line_id
    AND (payload->>'sequence')::integer = sequence
    AND payload->>'status' = status
  );

ALTER TABLE history_events
  ADD CONSTRAINT history_payload_projection_check CHECK (
    payload->>'id' = id
    AND (payload->>'at')::timestamptz = occurred_at
    AND payload->>'type' = event_type
    AND COALESCE(payload->>'jobId', '') = COALESCE(job_id, '')
  );
