ALTER TABLE source_imports DROP CONSTRAINT IF EXISTS source_imports_workspace_id_digest_key;
CREATE UNIQUE INDEX IF NOT EXISTS source_imports_file_selection_key
  ON source_imports (workspace_id, digest, sheet_name, as_of_date);
