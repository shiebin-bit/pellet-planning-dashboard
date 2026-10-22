CREATE TABLE IF NOT EXISTS source_imports (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  sheet_name text NOT NULL,
  digest text NOT NULL,
  as_of_date date NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  imported_at timestamptz NOT NULL,
  UNIQUE (workspace_id, digest)
);

CREATE TABLE IF NOT EXISTS source_orders (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  do_no text NOT NULL,
  material_code text NOT NULL,
  latest_version integer NOT NULL CHECK (latest_version > 0),
  latest_import_id text NOT NULL REFERENCES source_imports(id),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered')),
  delivery_source text CHECK (delivery_source IN ('import', 'manual')),
  delivery_recorded_at timestamptz,
  delivery_reason text,
  needs_review boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, do_no, material_code)
);

CREATE TABLE IF NOT EXISTS source_order_versions (
  source_order_id text NOT NULL REFERENCES source_orders(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  import_id text NOT NULL REFERENCES source_imports(id),
  fields jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (source_order_id, version)
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_order_id text REFERENCES source_orders(id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_source_order_idx
  ON jobs (workspace_id, source_order_id)
  WHERE source_order_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX IF NOT EXISTS source_orders_delivery_idx ON source_orders (workspace_id, delivery_status);
CREATE INDEX IF NOT EXISTS source_orders_updated_idx ON source_orders (workspace_id, updated_at DESC);
