CREATE TABLE IF NOT EXISTS source_order_discrepancies (
  id text PRIMARY KEY,
  workspace_id smallint NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_order_id text NOT NULL REFERENCES source_orders(id) ON DELETE CASCADE,
  import_id text NOT NULL REFERENCES source_imports(id) ON DELETE CASCADE,
  observed_source_version integer NOT NULL CHECK (observed_source_version > 0),
  candidate_fields jsonb NOT NULL,
  candidate_hash text NOT NULL,
  changed_fields jsonb NOT NULL CHECK (jsonb_typeof(changed_fields) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason text,
  selected_fields jsonb CHECK (selected_fields IS NULL OR jsonb_typeof(selected_fields) = 'array'),
  applied_source_version integer CHECK (applied_source_version IS NULL OR applied_source_version > 0),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolution_reason IS NULL AND selected_fields IS NULL AND applied_source_version IS NULL)
    OR
    (status = 'applied' AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL AND selected_fields IS NOT NULL AND applied_source_version IS NOT NULL)
    OR
    (status = 'dismissed' AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL AND selected_fields IS NULL AND applied_source_version IS NULL)
  ),
  UNIQUE (workspace_id, source_order_id, import_id, candidate_hash)
);

CREATE INDEX IF NOT EXISTS source_order_discrepancies_status_idx
  ON source_order_discrepancies (workspace_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS source_order_discrepancies_order_idx
  ON source_order_discrepancies (source_order_id, status);

