CREATE TABLE IF NOT EXISTS workspace (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_demo boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL,
  previous_backup jsonb,
  undo_state jsonb,
  undo_revision bigint,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id text PRIMARY KEY,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  planning_date date NOT NULL,
  line_id text NOT NULL CHECK (line_id IN ('PM1', 'PM2', 'PM3', 'PM4')),
  sequence integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'cancelled')),
  payload jsonb NOT NULL,
  UNIQUE (workspace_id, ordinal)
);

CREATE INDEX IF NOT EXISTS jobs_planning_date_idx ON jobs (planning_date);
CREATE INDEX IF NOT EXISTS jobs_line_status_idx ON jobs (line_id, status);

CREATE TABLE IF NOT EXISTS history_events (
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id text PRIMARY KEY,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  job_id text,
  payload jsonb NOT NULL,
  UNIQUE (workspace_id, ordinal)
);

CREATE INDEX IF NOT EXISTS history_events_occurred_at_idx ON history_events (occurred_at);

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id text PRIMARY KEY,
  payload_hash text NOT NULL,
  applied_revision bigint NOT NULL CHECK (applied_revision > 0),
  created_at timestamptz NOT NULL
);
