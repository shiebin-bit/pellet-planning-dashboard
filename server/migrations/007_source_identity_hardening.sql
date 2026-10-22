ALTER TABLE source_orders DROP CONSTRAINT IF EXISTS source_orders_workspace_id_do_no_material_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS source_orders_business_key_ci
  ON source_orders (workspace_id, lower(btrim(do_no)), lower(btrim(material_code)));

ALTER TABLE source_imports ADD COLUMN IF NOT EXISTS semantic_digest text;
UPDATE source_imports SET semantic_digest = digest WHERE semantic_digest IS NULL;
ALTER TABLE source_imports ALTER COLUMN semantic_digest SET NOT NULL;
DROP INDEX IF EXISTS source_imports_file_selection_key;
CREATE UNIQUE INDEX IF NOT EXISTS source_imports_semantic_digest_key
  ON source_imports (workspace_id, semantic_digest);
