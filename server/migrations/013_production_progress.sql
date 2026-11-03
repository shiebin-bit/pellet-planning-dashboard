CREATE TABLE IF NOT EXISTS production_progress_samples (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  command_id text NOT NULL UNIQUE,
  cumulative_scaled bigint NOT NULL CHECK (cumulative_scaled >= 0),
  sampled_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('operator-live', 'completion')),
  trustworthy boolean NOT NULL,
  untrusted_reason text,
  CHECK ((trustworthy AND untrusted_reason IS NULL) OR (NOT trustworthy AND btrim(COALESCE(untrusted_reason, '')) <> ''))
);

CREATE INDEX IF NOT EXISTS production_progress_samples_job_time_idx
  ON production_progress_samples (job_id, sampled_at DESC, id);

CREATE TABLE IF NOT EXISTS production_progress_resets (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  command_id text NOT NULL UNIQUE,
  reset_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> '')
);

CREATE INDEX IF NOT EXISTS production_progress_resets_job_time_idx
  ON production_progress_resets (job_id, reset_at DESC, id);

ALTER TABLE workspace
  ADD COLUMN IF NOT EXISTS previous_production_progress_backup jsonb;
