ALTER TABLE source_imports
  ADD COLUMN IF NOT EXISTS import_mode text NOT NULL DEFAULT 'sap-append',
  ADD COLUMN IF NOT EXISTS daily_sheet_name text;

ALTER TABLE inventory_imports
  ADD COLUMN IF NOT EXISTS import_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS sheet_name text;

ALTER TABLE inventory_baseline_reports
  ADD COLUMN IF NOT EXISTS calculated_closing_scaled bigint,
  ADD COLUMN IF NOT EXISTS formula_difference_scaled bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continuity_difference_scaled bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliation_difference_scaled bigint NOT NULL DEFAULT 0;

ALTER TABLE inventory_orders
  ADD COLUMN IF NOT EXISTS planning_control text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS planning_control_reason text,
  ADD COLUMN IF NOT EXISTS planning_control_updated_at timestamptz;

DO $$ BEGIN
  ALTER TABLE inventory_orders ADD CONSTRAINT inventory_orders_planning_control_check
    CHECK (planning_control IN ('active','hold','cancel','review'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS source_order_observations (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  import_id text NOT NULL REFERENCES source_imports(id) ON DELETE CASCADE,
  source_order_id text NOT NULL REFERENCES source_orders(id) ON DELETE CASCADE,
  as_of_date date NOT NULL,
  source_row integer,
  raw_status text NOT NULL DEFAULT '',
  effective_status text NOT NULL CHECK (effective_status IN ('pending','done','out')),
  fields jsonb NOT NULL,
  fields_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, import_id, source_order_id)
);
CREATE INDEX IF NOT EXISTS source_order_observations_order_date_idx
  ON source_order_observations(source_order_id, as_of_date, created_at);

CREATE TABLE IF NOT EXISTS planning_control_events (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_order_id text NOT NULL REFERENCES source_orders(id) ON DELETE CASCADE,
  action text NOT NULL,
  before_control text NOT NULL,
  after_control text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS planning_control_events_order_idx
  ON planning_control_events(source_order_id, occurred_at, id);

ALTER TABLE workspace ADD COLUMN IF NOT EXISTS previous_baseline_history_backup jsonb;
