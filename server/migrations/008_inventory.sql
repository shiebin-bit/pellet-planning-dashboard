DROP INDEX IF EXISTS jobs_one_active_source_order_idx;

CREATE TABLE IF NOT EXISTS inventory_items (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  catalog_id text,
  material_code text NOT NULL,
  description text NOT NULL DEFAULT '',
  unit text NOT NULL CHECK (unit IN ('Bags', 'MT')),
  bag_weight_kg integer CHECK (
    (unit = 'Bags' AND bag_weight_kg IN (25, 50))
    OR (unit = 'MT' AND bag_weight_kg IS NULL)
    OR (unit = 'Bags' AND bag_weight_kg IS NULL)
  ),
  strategy text CHECK (strategy IN ('mto', 'mts')),
  target_quantity_scaled bigint CHECK (target_quantity_scaled IS NULL OR target_quantity_scaled >= 0),
  extra_type text CHECK (extra_type IN ('fixed', 'percent')),
  extra_value_scaled bigint CHECK (extra_value_scaled IS NULL OR extra_value_scaled > 0),
  needs_review boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_material_code_ci
  ON inventory_items (workspace_id, lower(btrim(material_code)));

CREATE TABLE IF NOT EXISTS inventory_imports (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  digest text NOT NULL,
  semantic_digest text NOT NULL,
  as_of_date date NOT NULL,
  included_baseline boolean NOT NULL,
  packing_bin_total_scaled bigint,
  imported_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_imports_semantic_digest_key
  ON inventory_imports (workspace_id, semantic_digest);

CREATE TABLE IF NOT EXISTS inventory_baseline_reports (
  import_id text NOT NULL REFERENCES inventory_imports(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id),
  medication text NOT NULL DEFAULT '',
  fmr_omed text NOT NULL DEFAULT '',
  opening_scaled bigint NOT NULL CHECK (opening_scaled >= 0),
  production_scaled bigint NOT NULL CHECK (production_scaled >= 0),
  received_scaled bigint NOT NULL CHECK (received_scaled >= 0),
  sales_return_scaled bigint NOT NULL CHECK (sales_return_scaled >= 0),
  rework_scaled bigint NOT NULL CHECK (rework_scaled >= 0),
  issue_scaled bigint NOT NULL CHECK (issue_scaled >= 0),
  closing_scaled bigint NOT NULL CHECK (closing_scaled >= 0),
  PRIMARY KEY (import_id, item_id, medication, fmr_omed)
);

CREATE TABLE IF NOT EXISTS inventory_orders (
  source_order_id text PRIMARY KEY REFERENCES source_orders(id) ON DELETE CASCADE,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id),
  due_date date NOT NULL,
  ordered_quantity_scaled bigint NOT NULL CHECK (ordered_quantity_scaled >= 0),
  medication text NOT NULL DEFAULT '',
  fmr_omed text NOT NULL DEFAULT '',
  historical_status text NOT NULL DEFAULT 'pending' CHECK (historical_status IN ('pending', 'done', 'out')),
  manual_medication boolean NOT NULL DEFAULT false,
  manual_fmr_omed boolean NOT NULL DEFAULT false,
  manual_due_date boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_orders_due_idx
  ON inventory_orders (workspace_id, historical_status, due_date, source_order_id);
CREATE INDEX IF NOT EXISTS inventory_orders_item_bucket_idx
  ON inventory_orders (item_id, medication, fmr_omed);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id),
  medication text NOT NULL DEFAULT '',
  fmr_omed text NOT NULL DEFAULT '',
  movement_type text NOT NULL CHECK (movement_type IN ('baseline', 'production', 'received', 'return', 'rework', 'dispatch', 'adjustment', 'reversal')),
  quantity_delta_scaled bigint NOT NULL CHECK (quantity_delta_scaled <> 0),
  occurred_on date NOT NULL,
  recorded_at timestamptz NOT NULL,
  posting_key text NOT NULL,
  source_order_id text REFERENCES source_orders(id) ON DELETE SET NULL,
  job_id text,
  reverses_movement_id text REFERENCES inventory_ledger(id),
  import_id text REFERENCES inventory_imports(id) ON DELETE SET NULL,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (workspace_id, posting_key)
);
CREATE INDEX IF NOT EXISTS inventory_ledger_balance_idx
  ON inventory_ledger (item_id, medication, fmr_omed, occurred_on, recorded_at);
CREATE INDEX IF NOT EXISTS inventory_ledger_order_idx
  ON inventory_ledger (source_order_id, movement_type);
CREATE INDEX IF NOT EXISTS inventory_ledger_job_idx
  ON inventory_ledger (job_id, movement_type);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  source_order_id text PRIMARY KEY REFERENCES inventory_orders(source_order_id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id),
  medication text NOT NULL DEFAULT '',
  fmr_omed text NOT NULL DEFAULT '',
  quantity_scaled bigint NOT NULL CHECK (quantity_scaled >= 0),
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_reservations_bucket_idx
  ON inventory_reservations (item_id, medication, fmr_omed);
