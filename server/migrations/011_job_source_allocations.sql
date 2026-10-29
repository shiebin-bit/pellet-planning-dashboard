CREATE TABLE IF NOT EXISTS job_source_allocations (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_order_id text NOT NULL REFERENCES source_orders(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  planned_quantity_scaled bigint NOT NULL CHECK (planned_quantity_scaled > 0),
  source_order_version integer NOT NULL CHECK (source_order_version > 0),
  source_snapshot jsonb NOT NULL,
  PRIMARY KEY (job_id, source_order_id),
  UNIQUE (job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS job_source_allocations_source_idx
  ON job_source_allocations (source_order_id, job_id);

INSERT INTO job_source_allocations(job_id, source_order_id, ordinal, planned_quantity_scaled, source_order_version, source_snapshot)
SELECT j.id, j.source_order_id, 0,
  CASE WHEN j.payload->'sourceSnapshot'->>'unit' = 'Bags'
    THEN round(COALESCE((j.payload->>'bagCount')::numeric, 0))::bigint
    ELSE round(COALESCE((j.payload->>'quantityMt')::numeric, 0) * 1000)::bigint END,
  (j.payload->>'sourceOrderVersion')::integer,
  j.payload->'sourceSnapshot'
FROM jobs j
WHERE j.source_order_id IS NOT NULL
  AND j.payload->'sourceSnapshot' IS NOT NULL
  AND COALESCE((j.payload->>'sourceOrderVersion')::integer, 0) > 0
  AND CASE WHEN j.payload->'sourceSnapshot'->>'unit' = 'Bags'
    THEN round(COALESCE((j.payload->>'bagCount')::numeric, 0))::bigint
    ELSE round(COALESCE((j.payload->>'quantityMt')::numeric, 0) * 1000)::bigint END > 0
ON CONFLICT (job_id, source_order_id) DO NOTHING;
