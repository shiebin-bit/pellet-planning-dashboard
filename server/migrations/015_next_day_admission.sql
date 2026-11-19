CREATE TABLE IF NOT EXISTS order_admission_batches (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  target_date date NOT NULL,
  semantic_digest text NOT NULL,
  accepted_at timestamptz NOT NULL,
  row_count integer NOT NULL CHECK (row_count > 0),
  UNIQUE (workspace_id, target_date, semantic_digest)
);
CREATE INDEX IF NOT EXISTS order_admission_batches_target_idx
  ON order_admission_batches(workspace_id, target_date, accepted_at, id);

ALTER TABLE inventory_orders
  ADD COLUMN IF NOT EXISTS admission_batch_id text REFERENCES order_admission_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admission_ordinal integer;

DO $$ BEGIN
  ALTER TABLE inventory_orders ADD CONSTRAINT inventory_orders_admission_pair_check
    CHECK ((admission_batch_id IS NULL) = (admission_ordinal IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE inventory_orders ADD CONSTRAINT inventory_orders_admission_ordinal_check
    CHECK (admission_ordinal IS NULL OR admission_ordinal >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_orders_admission_ordinal_idx
  ON inventory_orders(admission_batch_id, admission_ordinal)
  WHERE admission_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_continuation_reservations (
  job_id text PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  remaining_quantity_scaled bigint NOT NULL CHECK (remaining_quantity_scaled > 0),
  unit text NOT NULL CHECK (unit IN ('Bags','MT')),
  planning_date date NOT NULL,
  line_id text NOT NULL CHECK (line_id IN ('PM1','PM2','PM3','PM4')),
  not_before timestamptz NOT NULL,
  segments jsonb NOT NULL,
  planned_at timestamptz NOT NULL
);

ALTER TABLE workspace ADD COLUMN IF NOT EXISTS previous_daily_planning_backup jsonb;
