ALTER TABLE workspace
  ADD COLUMN IF NOT EXISTS catalog jsonb NOT NULL DEFAULT '[]'::jsonb;
