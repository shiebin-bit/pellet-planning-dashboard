import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { createJob } from "../src/domain/engine";
import type { AppState, HistoryEvent, Job } from "../src/domain/types";
import type {
  CreateJobFromSourceInput,
  SourceImportInput,
  SourceImportPreview,
  SourceImportPreviewContext,
  SourceOrderDetail,
  SourceOrderFields,
  SourceOrderPage,
  SourceOrderSummary,
} from "../src/domain/sourceTypes";
import { ApiError } from "./errors";

interface ExistingSourceRow {
  id: string;
  latest_version: number;
  content_hash: string;
  fields: SourceOrderFields;
  delivery_status: "pending" | "delivered";
  delivery_source: "import" | "manual" | null;
  as_of_date: string | Date;
  inventory_medication: string | null;
  inventory_fmr_omed: string | null;
  inventory_due_date: string | Date | null;
  manual_medication: boolean | null;
  manual_fmr_omed: boolean | null;
  manual_due_date: boolean | null;
}

interface SourceCommandResult { state: AppState; sourceChanged: boolean }

export async function previewSourceImport(client: pg.Pool | pg.PoolClient, input: SourceImportInput, context?: SourceImportPreviewContext): Promise<SourceImportPreview> {
  return buildSourceImportPreview(client, input, true, context);
}

async function buildSourceImportPreview(
  client: pg.Pool | pg.PoolClient,
  input: SourceImportInput,
  useEffectiveManualFields: boolean,
  context?: SourceImportPreviewContext,
): Promise<SourceImportPreview> {
  const existing = await existingByKeys(client, input.rows);
  const baselineExists = context?.includeBaseline
    ? Boolean((await client.query("SELECT 1 FROM inventory_imports WHERE workspace_id=1 AND included_baseline LIMIT 1")).rowCount)
    : false;
  const annotations = !baselineExists && context?.includeBaseline
    ? new Map(context.annotations.map(row => [sourceKey(row.doNo, row.materialCode), row]))
    : new Map<string, SourceImportPreviewContext["annotations"][number]>();
  const rows = input.rows.map(fields => {
    const current = existing.get(sourceKey(fields.doNo, fields.materialCode));
    const annotation = annotations.get(sourceKey(fields.doNo, fields.materialCode));
    const hash = fieldsHash(fields);
    const previousFields = current
      ? useEffectiveManualFields ? effectiveSourceFields(current.fields, current) : current.fields
      : null;
    const nextFields = useEffectiveManualFields
      ? effectiveIncomingSourceFields(fields, current, annotation)
      : fields;
    const changedFields = current ? [...new Set([...Object.keys(previousFields!), ...Object.keys(nextFields)])].filter(key =>
      JSON.stringify(previousFields![key as keyof SourceOrderFields]) !== JSON.stringify(nextFields[key as keyof SourceOrderFields])) : [];
    if (current && dbDate(current.as_of_date) !== input.asOfDate) changedFields.push("asOfDate");
    return {
      key: `${fields.doNo} / ${fields.materialCode}`,
      // Disposition describes what the raw SAP import will persist. changedFields
      // describes the effective operational values after protected overrides.
      disposition: (!current ? "added" : current.content_hash === hash && dbDate(current.as_of_date) === input.asOfDate ? "unchanged" : "changed") as "added" | "unchanged" | "changed",
      existingOrderId: current?.id ?? null,
      fields: nextFields,
      ...(current ? { previousFields, previousAsOfDate: dbDate(current.as_of_date) } : {}),
      changedFields,
      ...(context && current ? { operationalChanged: changedFields.length > 0 } : {}),
    };
  });
  return {
    added: rows.filter(row => row.disposition === "added").length,
    unchanged: rows.filter(row => row.disposition === "unchanged").length,
    changed: rows.filter(row => row.disposition === "changed").length,
    ...(context ? { operationalChanged: rows.filter(row => row.operationalChanged).length } : {}),
    rows,
  };
}

export async function applySourceImport(
  client: pg.PoolClient,
  state: AppState,
  input: SourceImportInput,
  nowIso: string,
): Promise<SourceCommandResult> {
  const semanticDigest = semanticImportDigest(input);
  const duplicate = await client.query<{ id: string }>(
    "SELECT id FROM source_imports WHERE workspace_id = 1 AND semantic_digest = $1",
    [semanticDigest],
  );
  if (duplicate.rowCount) {
    return { state: appendEvent(state, nowIso, "data.import.duplicate", `Skipped duplicate import ${input.fileName}.`), sourceChanged: false };
  }
  // Keep import/event semantics based on the raw SAP values. The public preview uses
  // effective protected fields so a manual Medication/FMR override is not presented
  // to the operator as if the next workbook would replace it.
  const preview = await buildSourceImportPreview(client, input, false);
  const importId = `import-${randomUUID()}`;
  await client.query(
    `INSERT INTO source_imports(id, workspace_id, file_name, sheet_name, digest, semantic_digest, as_of_date, row_count, imported_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6::date, $7, $8::timestamptz)`,
    [importId, input.fileName, input.sheetName, input.digest, semanticDigest, input.asOfDate, input.rows.length, nowIso],
  );
  const existing = await existingByKeys(client, input.rows);
  for (const fields of input.rows) {
    const key = sourceKey(fields.doNo, fields.materialCode);
    const current = existing.get(key);
    const hash = fieldsHash(fields);
    if (!current) {
      const id = `source-${randomUUID()}`;
      await client.query(
        `INSERT INTO source_orders(id, workspace_id, do_no, material_code, latest_version, latest_import_id,
          delivery_status, delivery_source, delivery_recorded_at, needs_review, updated_at)
         VALUES ($1, 1, $2, $3, 1, $4, 'pending', NULL, NULL, false, $5::timestamptz)`,
        [id, fields.doNo, fields.materialCode, importId, nowIso],
      );
      await insertVersion(client, id, 1, importId, fields, hash, nowIso);
      continue;
    }
    const baselineUpdate = await client.query(
      "UPDATE source_orders SET latest_import_id = $2, updated_at = $3::timestamptz WHERE id = $1",
      [current.id, importId, nowIso],
    );
    if (baselineUpdate.rowCount !== 1) throw new Error("The source order changed while applying the import.");
    if (current.content_hash === hash) {
      continue;
    }
    const nextVersion = current.latest_version + 1;
    const activeJob = await activeJobForSource(client, current.id);
    const planningChanged = Boolean(activeJob && sourcePlanningMismatch(fields, activeJob.sourceSnapshot));
    const deliveryConflict = Boolean(activeJob && activeJob.status !== "completed" && current.delivery_status === "delivered");
    await client.query(
      `UPDATE source_orders SET latest_version = $2,
         needs_review = $3 OR $4, updated_at = $5::timestamptz
       WHERE id = $1`,
      [current.id, nextVersion, planningChanged, deliveryConflict, nowIso],
    );
    await insertVersion(client, current.id, nextVersion, importId, fields, hash, nowIso);
  }
  const message = `Imported ${input.rows.length} source orders from ${input.fileName}: ${preview.added} added, ${preview.changed} changed, ${preview.unchanged} unchanged.`;
  return { state: appendEvent(state, nowIso, "data.imported", message), sourceChanged: true };
}

export async function createJobFromSource(
  client: pg.PoolClient,
  state: AppState,
  input: CreateJobFromSourceInput,
  nowIso: string,
): Promise<SourceCommandResult> {
  const result = await client.query<{
    latest_version: number; delivery_status: string; fields: SourceOrderFields;
  }>(
    `SELECT o.latest_version, o.delivery_status, v.fields
       FROM source_orders o JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
      WHERE o.workspace_id = 1 AND o.id = $1 FOR UPDATE`,
    [input.sourceOrderId],
  );
  if (!result.rowCount) throw new ApiError(400, "SOURCE_NOT_FOUND", "The source order no longer exists.");
  const source = result.rows[0];
  if (source.delivery_status === "delivered") throw new ApiError(400, "SOURCE_DELIVERED", "A delivered order cannot be planned again.");
  if (source.latest_version !== input.sourceOrderVersion) throw new ApiError(409, "SOURCE_VERSION_CHANGED", "The source order changed. Review the latest values before planning it.");
  if (source.fields.quantity <= 0) throw new ApiError(400, "SOURCE_QUANTITY_INVALID", "The source order quantity must be greater than zero before it can be planned.");
  if (await activeJobForSource(client, input.sourceOrderId)) throw new ApiError(409, "SOURCE_ALREADY_PLANNED", "This source order already has a production card.");

  const mode = source.fields.unit === "Bags" ? "bags" : "bulk";
  if (input.mode && input.mode !== mode) throw new ApiError(400, "SOURCE_UNIT_MISMATCH", "The planning mode must match the imported unit.");
  const bagWeight = state.settings.bagWeightKg;
  const quantityMt = mode === "bags" ? source.fields.quantity * bagWeight / 1_000 : source.fields.quantity;
  let next = createJob(state, {
    date: input.date,
    lineId: input.lineId,
    orderNo: source.fields.doNo,
    productCode: source.fields.materialCode,
    description: source.fields.description,
    bin: input.bin,
    mode,
    bagCount: mode === "bags" ? source.fields.quantity : null,
    quantityMt,
    remarks: input.remarks,
  });
  const createdId = next.events.at(-1)?.jobId;
  if (!createdId) throw new Error("The source job was created without an audit identity.");
  next = {
    ...next,
    jobs: next.jobs.map(job => job.id === createdId ? {
      ...job,
      sourceOrderId: input.sourceOrderId,
      sourceOrderVersion: source.latest_version,
      sourceSnapshot: {
        doNo: source.fields.doNo,
        materialCode: source.fields.materialCode,
        description: source.fields.description,
        quantity: source.fields.quantity,
        unit: source.fields.unit,
      },
      ...(mode === "bags" ? { bagWeightKgSnapshot: bagWeight } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    } : job),
    events: next.events.map(event => event.jobId === createdId && event.type === "job.created" ? { ...event, at: nowIso } : event),
  };
  await client.query("UPDATE source_orders SET needs_review = false, updated_at = $2::timestamptz WHERE id = $1", [input.sourceOrderId, nowIso]);
  return { state: next, sourceChanged: true };
}

export async function setDeliveryStatus(
  client: pg.PoolClient,
  state: AppState,
  sourceOrderId: string,
  delivered: boolean,
  reason: string | undefined,
  nowIso: string,
): Promise<SourceCommandResult> {
  const tracked = await client.query("SELECT 1 FROM inventory_orders WHERE source_order_id=$1 AND EXISTS(SELECT 1 FROM inventory_imports WHERE included_baseline)", [sourceOrderId]);
  if(tracked.rowCount)throw new ApiError(409,"USE_STOCK_DELIVERY","Record or reverse a stock collection for this order instead of changing its delivery flag.");
  const current = await client.query<{ delivery_status: "pending" | "delivered" }>(
    "SELECT delivery_status FROM source_orders WHERE workspace_id = 1 AND id = $1 FOR UPDATE",
    [sourceOrderId],
  );
  if (!current.rowCount) throw new ApiError(400, "SOURCE_NOT_FOUND", "The source order no longer exists.");
  if (delivered) {
    const job = await activeJobForSource(client, sourceOrderId);
    if (job && job.status !== "completed") throw new ApiError(400, "PRODUCTION_NOT_COMPLETE", "Complete production before marking this order delivered.");
  } else if (!reason?.trim()) {
    throw new ApiError(400, "REOPEN_REASON_REQUIRED", "A reason is required to reopen delivery.");
  }
  await client.query(
    `UPDATE source_orders SET delivery_status = $2, delivery_source = $3,
       delivery_recorded_at = $4::timestamptz, delivery_reason = $5, needs_review = false,
       updated_at = $6::timestamptz WHERE id = $1`,
    [sourceOrderId, delivered ? "delivered" : "pending", delivered ? "manual" : null, delivered ? nowIso : null, reason?.trim() || null, nowIso],
  );
  return {
    state: appendEvent(state, nowIso, delivered ? "data.delivered" : "data.delivery.reopened", delivered ? "Marked a source order delivered." : `Reopened a source order: ${reason!.trim()}`),
    sourceChanged: true,
  };
}

export async function listSourceOrders(pool: pg.Pool, query: URLSearchParams): Promise<SourceOrderPage> {
  validateSourceListQuery(query);
  const search = (query.get("search") ?? "").trim();
  const values: unknown[] = [];
  const where = ["o.workspace_id = 1"];
  const dynamicWhere: string[] = [];
  if (search) {
    values.push(`%${search}%`);
    dynamicWhere.push(`(do_no ILIKE $${values.length} OR material_code ILIKE $${values.length} OR fields->>'description' ILIKE $${values.length} OR fields->>'soldToParty' ILIKE $${values.length} OR fields->>'shipToParty' ILIKE $${values.length} OR fields->>'medication' ILIKE $${values.length} OR fields->>'fmrOmed' ILIKE $${values.length})`);
  }
  for (const [name, operator] of [["deliveryFrom", ">="], ["deliveryTo", "<="]] as const) {
    const value = query.get(name);
    if (value) { values.push(value); dynamicWhere.push(`delivery_date ${operator} $${values.length}::date`); }
  }
  const unit = query.get("unit");
  if (unit) { values.push(unit); where.push(`v.fields->>'unit' = $${values.length}`); }
  const deliveryStatus = query.get("deliveryStatus");
  if (deliveryStatus) { values.push(deliveryStatus); where.push(`o.delivery_status = $${values.length}`); }
  const importId = query.get("importId");
  if (importId) { values.push(importId); where.push(`o.latest_import_id = $${values.length}`); }
  const today = malaysiaDate();
  const productionStatus = query.get("productionStatus");
  if (productionStatus) { values.push(productionStatus); dynamicWhere.push(`production_status = $${values.length}`); }
  const overdue = query.get("overdue");
  const pickupOverdue = "delivery_status <> 'delivered' AND current_days_outstanding > 0";
  const productionOverdue = "production_status NOT IN ('completed', 'external-complete') AND current_delivery_lead_days < 0";
  if (overdue === "true" || overdue === "pickup") dynamicWhere.push(`(${pickupOverdue})`);
  if (overdue === "production") dynamicWhere.push(`(${productionOverdue})`);
  if (overdue === "false") dynamicWhere.push(`NOT (COALESCE((${pickupOverdue}), false) OR COALESCE((${productionOverdue}), false))`);
  const view = query.get("view") ?? "all";
  if (view === "needs-production") {
    dynamicWhere.push(`delivery_status <> 'delivered' AND source_quantity > 0 AND (
      (is_inventory_tracked AND net_to_plan_scaled > 0) OR
      (NOT is_inventory_tracked AND job_id IS NULL)
    )`);
  }
  if (view === "ready-pickup") {
    dynamicWhere.push(`delivery_status <> 'delivered' AND source_quantity > 0 AND (
      (is_inventory_tracked AND remaining_to_collect_scaled > 0 AND reserved_scaled >= remaining_to_collect_scaled) OR
      (NOT is_inventory_tracked AND production_status IN ('completed', 'external-complete'))
    )`);
  }
  if (view === "needs-review") dynamicWhere.push("needs_review");
  const requestedPage = Number(query.get("page") ?? 1);
  values.push(requestedPage);
  const pageParameter = `$${values.length}`;
  const result = await pool.query<SourceListResult>(
    `WITH ${inventoryProgressCtes()}, base AS (
       SELECT o.id, o.latest_version, o.latest_import_id AS import_id, i.file_name, i.as_of_date::text AS as_of_date,
         o.delivery_status, o.delivery_source, o.delivery_recorded_at, o.delivery_reason,
         (o.needs_review OR ${sourcePlanningMismatchSql()} OR
           (COALESCE(ip.is_inventory_tracked, false) AND COALESCE(ip.inventory_needs_review, false))) AS needs_review,
         o.updated_at,
         ${effectiveFieldsSql()} AS fields, j.id AS job_id, j.status AS job_status, NULLIF(j.payload->>'sourceOrderVersion','')::integer AS job_source_version,
         j.payload->'sourceSnapshot' AS job_source_snapshot,
         ${effectiveDeliveryDateSql()} AS delivery_date, o.do_no, o.material_code,
         COALESCE((v.fields->>'quantity')::numeric, 0) AS source_quantity,
         COALESCE(ip.is_inventory_tracked, false) AS is_inventory_tracked,
         COALESCE(ip.net_to_plan_scaled, 0) AS net_to_plan_scaled,
         COALESCE(ip.reserved_scaled, 0) AS reserved_scaled,
         COALESCE(ip.remaining_to_collect_scaled, 0) AS remaining_to_collect_scaled,
         ip.inventory_unit,
         ${productionStatusSql()} AS production_status,
         (${effectiveDeliveryDateSql()} - '${today}'::date)::integer AS current_delivery_lead_days,
         CASE WHEN o.delivery_status='delivered' THEN 0 ELSE GREATEST(0, ('${today}'::date - ${effectiveDeliveryDateSql()})::integer + 1) END AS current_days_outstanding
       FROM source_orders o
       JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
       JOIN source_imports i ON i.id = o.latest_import_id
       LEFT JOIN LATERAL (SELECT id, status, payload FROM jobs WHERE workspace_id = 1 AND source_order_id = o.id AND status <> 'cancelled' ORDER BY ordinal DESC LIMIT 1) j ON true
       LEFT JOIN inventory_progress ip ON ip.source_order_id = o.id
       WHERE ${where.join(" AND ")}
     ), filtered AS (
       SELECT * FROM base${dynamicWhere.length ? ` WHERE ${dynamicWhere.join(" AND ")}` : ""}
     ), stats AS (
       SELECT count(*)::integer AS total,
         count(*) FILTER (WHERE production_status = 'pending')::integer AS planned,
         count(*) FILTER (WHERE production_status = 'running')::integer AS running,
         count(*) FILTER (WHERE production_status IN ('completed', 'external-complete'))::integer AS completed,
         count(*) FILTER (WHERE delivery_status = 'delivered')::integer AS delivered,
         count(*) FILTER (WHERE delivery_status <> 'delivered' AND current_days_outstanding > 0)::integer AS overdue
       FROM filtered
     )
     SELECT stats.*, LEAST(${pageParameter}::integer, GREATEST(1, CEIL(stats.total / 50.0)::integer)) AS page,
       COALESCE(page_rows.items, '[]'::jsonb) AS items
     FROM stats
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(to_jsonb(selected) ORDER BY selected.delivery_date, selected.do_no, selected.material_code) AS items
       FROM (
         SELECT * FROM filtered ORDER BY delivery_date, do_no, material_code LIMIT 50
         OFFSET (LEAST(${pageParameter}::integer, GREATEST(1, CEIL(stats.total / 50.0)::integer)) - 1) * 50
       ) selected
     ) page_rows ON true`,
    values,
  );
  const row = result.rows[0];
  const items = row.items.map(item => toSummary(item, today));
  return {
    items, page: row.page, pageSize: 50, total: row.total,
    stats: { total: row.total, planned: row.planned, running: row.running, completed: row.completed, delivered: row.delivered, overdue: row.overdue },
  };
}

export async function getSourceOrder(pool: pg.Pool, id: string): Promise<SourceOrderDetail | null> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    const rows = await client.query<SourceDbView>(sourceViewSql("o.workspace_id = 1 AND o.id = $1"), [id]);
    if (!rows.rowCount) {
      await client.query("COMMIT");
      inTransaction = false;
      return null;
    }
    const versions = await client.query<{ version: number; import_id: string; created_at: Date | string; fields: SourceOrderFields; version_total: string }>(
      `SELECT version, import_id, created_at, fields, count(*) OVER ()::text AS version_total
         FROM source_order_versions WHERE source_order_id = $1 ORDER BY version DESC LIMIT 200`,
      [id],
    );
    const result: SourceOrderDetail = {
      ...toSummary(rows.rows[0], malaysiaDate()),
      versionTotal: Number(versions.rows[0]?.version_total ?? 0),
      versions: versions.rows.map(row => ({ version: row.version, importId: row.import_id, importedAt: new Date(row.created_at).toISOString(), fields: row.fields })),
    };
    await client.query("COMMIT");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function clearSourceData(client: pg.PoolClient): Promise<void> {
  await client.query("UPDATE jobs SET source_order_id = NULL WHERE workspace_id = 1 AND source_order_id IS NOT NULL");
  await client.query("DELETE FROM source_order_versions WHERE source_order_id IN (SELECT id FROM source_orders WHERE workspace_id = 1)");
  await client.query("DELETE FROM source_orders WHERE workspace_id = 1");
  await client.query("DELETE FROM source_imports WHERE workspace_id = 1");
}

interface SourceDbView {
  production_status?: SourceOrderSummary["productionStatus"];
  id: string; latest_version: number; import_id: string; file_name: string; as_of_date: string | Date;
  delivery_status: "pending" | "delivered"; delivery_source: "import" | "manual" | null;
  delivery_recorded_at: string | Date | null; delivery_reason: string | null; needs_review: boolean; updated_at: string | Date;
  fields: SourceOrderFields; job_id: string | null; job_status: Job["status"] | null; job_source_version: number | null;
  job_source_snapshot: Job["sourceSnapshot"] | null;
  is_inventory_tracked?: boolean;
  net_to_plan_scaled?: string | number;
  inventory_unit?: "MT" | "Bags" | null;
}

interface SourceListResult {
  total: number; planned: number; running: number; completed: number; delivered: number; overdue: number;
  page: number; items: SourceDbView[];
}

function sourceViewSql(where: string): string {
  return `WITH ${inventoryProgressCtes()}
    SELECT o.id, o.latest_version, o.latest_import_id AS import_id, i.file_name, i.as_of_date::text AS as_of_date,
    o.delivery_status, o.delivery_source, o.delivery_recorded_at, o.delivery_reason,
    (o.needs_review OR ${sourcePlanningMismatchSql()} OR
      (COALESCE(ip.is_inventory_tracked, false) AND COALESCE(ip.inventory_needs_review, false))) AS needs_review,
    o.updated_at,
    ${effectiveFieldsSql()} AS fields, ${productionStatusSql()} AS production_status, j.id AS job_id, j.status AS job_status, NULLIF(j.payload->>'sourceOrderVersion','')::integer AS job_source_version,
    j.payload->'sourceSnapshot' AS job_source_snapshot,
    COALESCE(ip.is_inventory_tracked, false) AS is_inventory_tracked,
    COALESCE(ip.net_to_plan_scaled, 0) AS net_to_plan_scaled,
    ip.inventory_unit
    FROM source_orders o
    JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
    JOIN source_imports i ON i.id = o.latest_import_id
    LEFT JOIN LATERAL (SELECT id, status, payload FROM jobs WHERE workspace_id = 1 AND source_order_id = o.id AND status <> 'cancelled' ORDER BY ordinal DESC LIMIT 1) j ON true
    LEFT JOIN inventory_progress ip ON ip.source_order_id=o.id
    WHERE ${where} ORDER BY ${effectiveDeliveryDateSql()}, o.do_no, o.material_code`;
}


function productionStatusSql():string {
  return `CASE WHEN EXISTS(SELECT 1 FROM inventory_orders io WHERE io.source_order_id=o.id AND EXISTS(SELECT 1 FROM inventory_imports WHERE included_baseline)) THEN
    CASE WHEN o.delivery_status='delivered' OR EXISTS(SELECT 1 FROM inventory_orders io LEFT JOIN inventory_reservations ir ON ir.source_order_id=io.source_order_id WHERE io.source_order_id=o.id AND (io.historical_status IN ('done','out') OR io.ordered_quantity_scaled<=COALESCE(ir.quantity_scaled,0)+COALESCE((SELECT sum(-l.quantity_delta_scaled) FROM inventory_ledger l WHERE l.source_order_id=o.id AND (l.movement_type='dispatch' OR (l.movement_type='reversal' AND l.reverses_movement_id IN (SELECT id FROM inventory_ledger WHERE movement_type='dispatch')))),0))) THEN 'external-complete'
      WHEN EXISTS(SELECT 1 FROM jobs active WHERE active.source_order_id=o.id AND active.status='running') THEN 'running'
      WHEN EXISTS(SELECT 1 FROM jobs active WHERE active.source_order_id=o.id AND active.status='pending') THEN 'pending' ELSE 'unplanned' END
    ELSE COALESCE(j.status,CASE WHEN o.delivery_status='delivered' OR upper(btrim(v.fields->>'remark'))='DONE' THEN 'external-complete' ELSE 'unplanned' END) END`;
}

function sourcePlanningMismatchSql(): string {
  return `(j.payload->'sourceSnapshot' IS NOT NULL AND j.payload->'sourceSnapshot' IS DISTINCT FROM jsonb_build_object(
    'doNo', v.fields->>'doNo', 'materialCode', v.fields->>'materialCode',
    'description', v.fields->>'description', 'quantity', v.fields->'quantity', 'unit', v.fields->>'unit'
  ))`;
}

function effectiveDeliveryDateSql(): string {
  return `COALESCE(ip.inventory_due_date, (v.fields->>'deliveryDate')::date)`;
}

function effectiveFieldsSql(): string {
  return `(v.fields || CASE WHEN ip.source_order_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'deliveryDate', ${effectiveDeliveryDateSql()}::text,
    'medication', COALESCE(ip.inventory_medication, ''),
    'fmrOmed', COALESCE(ip.inventory_fmr_omed, '')
  ) END)`;
}

/**
 * Inventory order progress is calculated from the same persisted facts as
 * getOrderProgress: reservations already include received production, while
 * scheduled quantity only includes the unreceived balance of active cards.
 */
function inventoryProgressCtes(): string {
  return `inventory_enabled AS (
      SELECT EXISTS(SELECT 1 FROM inventory_imports WHERE workspace_id = 1 AND included_baseline) AS enabled
    ), inventory_movement_totals AS (
      SELECT l.source_order_id,
        COALESCE(sum(CASE WHEN l.movement_type='dispatch' THEN -l.quantity_delta_scaled
          WHEN l.movement_type='reversal' AND original.movement_type='dispatch' THEN -l.quantity_delta_scaled ELSE 0 END),0)::bigint AS delivered_scaled
      FROM inventory_ledger l
      LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id
      WHERE l.workspace_id=1 AND l.source_order_id IS NOT NULL
      GROUP BY l.source_order_id
    ), inventory_job_production AS (
      SELECT l.job_id,
        COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled
          WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0)::bigint AS produced_scaled
      FROM inventory_ledger l
      LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id
      WHERE l.workspace_id=1 AND l.job_id IS NOT NULL
      GROUP BY l.job_id
    ), inventory_scheduled AS (
      SELECT io.source_order_id,
        COALESCE(sum(GREATEST(0,
          CASE WHEN item.unit='Bags' THEN COALESCE((job.payload->>'bagCount')::numeric,0)::bigint
            ELSE round(COALESCE((job.payload->>'quantityMt')::numeric,0)*1000)::bigint END
          - COALESCE(posted.produced_scaled,0))),0)::bigint AS scheduled_scaled
      FROM inventory_orders io
      JOIN inventory_items item ON item.id=io.item_id
      JOIN jobs job ON job.workspace_id=1 AND job.source_order_id=io.source_order_id AND job.status IN ('pending','running')
      LEFT JOIN inventory_job_production posted ON posted.job_id=job.id
      WHERE io.workspace_id=1
      GROUP BY io.source_order_id
    ), inventory_progress_core AS (
      SELECT io.source_order_id, item.unit AS inventory_unit, enabled.enabled AS is_inventory_tracked,
        io.historical_status, io.needs_review AS configured_needs_review,
        io.due_date AS inventory_due_date, io.medication AS inventory_medication, io.fmr_omed AS inventory_fmr_omed,
        io.ordered_quantity_scaled::bigint AS ordered_scaled,
        COALESCE(reservation.quantity_scaled,0)::bigint AS reserved_scaled,
        CASE WHEN io.historical_status='out' THEN io.ordered_quantity_scaled::bigint
          ELSE COALESCE(movement.delivered_scaled,0)::bigint END AS delivered_scaled,
        COALESCE(scheduled.scheduled_scaled,0)::bigint AS scheduled_scaled
      FROM inventory_orders io
      JOIN inventory_items item ON item.id=io.item_id
      CROSS JOIN inventory_enabled enabled
      LEFT JOIN inventory_reservations reservation ON reservation.source_order_id=io.source_order_id
      LEFT JOIN inventory_movement_totals movement ON movement.source_order_id=io.source_order_id
      LEFT JOIN inventory_scheduled scheduled ON scheduled.source_order_id=io.source_order_id
      WHERE io.workspace_id=1
    ), inventory_progress AS (
      SELECT core.*,
        GREATEST(0, core.ordered_scaled-core.delivered_scaled) AS remaining_to_collect_scaled,
        GREATEST(0,
          CASE WHEN core.historical_status='done' THEN 0
            ELSE GREATEST(0,core.ordered_scaled-core.delivered_scaled-core.reserved_scaled) END
          - GREATEST(0,core.scheduled_scaled)) AS net_to_plan_scaled,
        (core.configured_needs_review OR
          (core.historical_status='done' AND core.reserved_scaled<GREATEST(0,core.ordered_scaled-core.delivered_scaled))) AS inventory_needs_review
      FROM inventory_progress_core core
    )`;
}

function toSummary(row: SourceDbView, today: string): SourceOrderSummary {
  const asOfDate = row.as_of_date instanceof Date ? row.as_of_date.toISOString().slice(0, 10) : String(row.as_of_date).slice(0, 10);
  const productionStatus = row.production_status ?? row.job_status ?? (row.delivery_status === "delivered" || row.fields.remark.trim().toUpperCase()==='DONE' ? "external-complete" : "unplanned");
  const netToPlan = row.is_inventory_tracked
    ? Number(row.net_to_plan_scaled ?? 0) / (row.inventory_unit === "MT" ? 1_000 : 1)
    : undefined;
  return {
    id: row.id,
    version: row.latest_version,
    importId: row.import_id,
    importFileName: row.file_name,
    importAsOfDate: asOfDate,
    ...row.fields,
    deliveryStatus: row.delivery_status,
    deliverySource: row.delivery_source,
    deliveryRecordedAt: row.delivery_recorded_at ? new Date(row.delivery_recorded_at).toISOString() : null,
    deliveryReason: row.delivery_reason,
    productionStatus,
    ...(netToPlan === undefined ? {} : { netToPlan }),
    linkedJobId: row.job_id,
    currentDeliveryLeadDays: calendarDays(today, row.fields.deliveryDate),
    currentDaysOutstanding: row.delivery_status === 'delivered' ? 0 : Math.max(0, calendarDays(row.fields.deliveryDate, today) + 1),
    needsReview: row.needs_review || sourcePlanningMismatch(row.fields, row.job_source_snapshot),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function existingByKeys(client: pg.Pool | pg.PoolClient, rows: SourceOrderFields[]): Promise<Map<string, ExistingSourceRow>> {
  if (!rows.length) return new Map();
  const keys = rows.map(row => [row.doNo, row.materialCode]);
  const result = await client.query<ExistingSourceRow>(
    `SELECT o.id, o.latest_version, v.content_hash, v.fields, o.delivery_status, o.delivery_source, i.as_of_date::text AS as_of_date,
       io.medication AS inventory_medication, io.fmr_omed AS inventory_fmr_omed, io.due_date AS inventory_due_date,
       io.manual_medication, io.manual_fmr_omed, io.manual_due_date
       FROM source_orders o JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
      JOIN source_imports i ON i.id = o.latest_import_id
      LEFT JOIN inventory_orders io ON io.source_order_id = o.id
      JOIN jsonb_to_recordset($1::jsonb) AS k(do_no text, material_code text)
        ON lower(btrim(o.do_no)) = lower(btrim(k.do_no)) AND lower(btrim(o.material_code)) = lower(btrim(k.material_code))
      WHERE o.workspace_id = 1`,
    [JSON.stringify(keys.map(([do_no, material_code]) => ({ do_no, material_code })))],
  );
  return new Map(result.rows.map(row => [sourceKey(row.fields.doNo, row.fields.materialCode), row]));
}

function effectiveSourceFields(fields: SourceOrderFields, current: ExistingSourceRow): SourceOrderFields {
  return {
    ...fields,
    ...(current.manual_due_date && current.inventory_due_date
      ? { deliveryDate: dbDate(current.inventory_due_date) }
      : {}),
    // Inventory buckets remain operationally stable on later workbook imports,
    // even when they came from the baseline rather than a manual override.
    ...(current.inventory_medication !== null
      ? { medication: current.inventory_medication ?? current.fields.medication }
      : {}),
    ...(current.inventory_fmr_omed !== null
      ? { fmrOmed: current.inventory_fmr_omed ?? current.fields.fmrOmed }
      : {}),
  };
}

function effectiveIncomingSourceFields(
  fields: SourceOrderFields,
  current: ExistingSourceRow | undefined,
  annotation: SourceImportPreviewContext["annotations"][number] | undefined,
): SourceOrderFields {
  const retained = current ? effectiveSourceFields(fields, current) : { ...fields };
  if (!annotation) return retained;
  return {
    ...retained,
    ...(!current?.manual_medication ? { medication: annotation.medication } : {}),
    ...(!current?.manual_fmr_omed ? { fmrOmed: annotation.fmrOmed } : {}),
  };
}

async function insertVersion(client: pg.PoolClient, orderId: string, version: number, importId: string, fields: SourceOrderFields, hash: string, nowIso: string) {
  await client.query(
    `INSERT INTO source_order_versions(source_order_id, version, import_id, fields, content_hash, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
    [orderId, version, importId, JSON.stringify(fields), hash, nowIso],
  );
}

async function activeJobForSource(client: pg.PoolClient, sourceOrderId: string): Promise<{ id: string; status: Job["status"]; sourceSnapshot: Job["sourceSnapshot"] | null } | null> {
  const result = await client.query<{ id: string; status: Job["status"]; sourceSnapshot: Job["sourceSnapshot"] | null }>(
    `SELECT id, status, payload->'sourceSnapshot' AS "sourceSnapshot"
       FROM jobs WHERE workspace_id = 1 AND source_order_id = $1 AND status <> 'cancelled' LIMIT 1`,
    [sourceOrderId],
  );
  return result.rows[0] ?? null;
}

function sourcePlanningMismatch(fields: SourceOrderFields, snapshot: Job["sourceSnapshot"] | null | undefined): boolean {
  return Boolean(snapshot && (
    snapshot.doNo !== fields.doNo || snapshot.materialCode !== fields.materialCode ||
    snapshot.description !== fields.description || snapshot.quantity !== fields.quantity || snapshot.unit !== fields.unit
  ));
}

function fieldsHash(fields: SourceOrderFields): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

function semanticImportDigest(input: SourceImportInput): string {
  return createHash("sha256").update(canonicalJson({ sheetName: input.sheetName, asOfDate: input.asOfDate, rows: input.rows })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

function sourceKey(doNo: string, materialCode: string): string {
  return `${doNo.trim().toLocaleUpperCase("en-US")}\u0000${materialCode.trim().toLocaleUpperCase("en-US")}`;
}

function validateSourceListQuery(query: URLSearchParams): void {
  const supported = new Set(["search", "deliveryFrom", "deliveryTo", "unit", "productionStatus", "deliveryStatus", "overdue", "importId", "view", "page"]);
  for (const [name] of query) if (!supported.has(name)) throw new ApiError(400, "INVALID_DATA_FILTER", `Data filter ${name} is not supported.`);
  const single = (name: string): string | null => {
    const values = query.getAll(name);
    if (values.length > 1) throw new ApiError(400, "INVALID_DATA_FILTER", `Data filter ${name} may only be supplied once.`);
    return values[0] ?? null;
  };
  const search = single("search");
  if (search !== null && search.length > 200) throw new ApiError(400, "INVALID_DATA_FILTER", "Data search must be 200 characters or fewer.");
  for (const name of ["deliveryFrom", "deliveryTo"] as const) {
    const value = single(name);
    if (value !== null && !validDate(value)) throw new ApiError(400, "INVALID_DATA_FILTER", `${name} must be a valid YYYY-MM-DD date.`);
  }
  enumFilter(single("unit"), new Set(["MT", "Bags"]), "unit");
  enumFilter(single("productionStatus"), new Set(["unplanned", "external-complete", "pending", "running", "paused", "completed", "cancelled"]), "productionStatus");
  enumFilter(single("deliveryStatus"), new Set(["pending", "delivered"]), "deliveryStatus");
  enumFilter(single("overdue"), new Set(["true", "false", "production", "pickup"]), "overdue");
  enumFilter(single("view"), new Set(["all", "needs-production", "ready-pickup", "needs-review"]), "view");
  const importId = single("importId");
  if (importId !== null && (!importId.trim() || importId.length > 200)) throw new ApiError(400, "INVALID_DATA_FILTER", "importId must be nonblank text of 200 characters or fewer.");
  const page = single("page");
  if (page !== null && !/^[1-9]\d*$/.test(page)) throw new ApiError(400, "INVALID_DATA_FILTER", "page must be a positive integer.");
  if (page !== null && (!Number.isSafeInteger(Number(page)) || Number(page) > 1_000_000)) throw new ApiError(400, "INVALID_DATA_FILTER", "page is too large.");
  const from = query.get("deliveryFrom");
  const to = query.get("deliveryTo");
  if (from && to && from > to) throw new ApiError(400, "INVALID_DATA_FILTER", "deliveryFrom cannot be after deliveryTo.");
}

function enumFilter(value: string | null, allowed: ReadonlySet<string>, name: string): void {
  if (value !== null && !allowed.has(value)) throw new ApiError(400, "INVALID_DATA_FILTER", `${name} has an unsupported value.`);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function appendEvent(state: AppState, nowIso: string, type: string, message: string): AppState {
  const event: HistoryEvent = { id: `event-${randomUUID()}`, at: nowIso, type, message };
  return { ...state, events: [...state.events, event] };
}

function malaysiaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function dbDate(value: string | Date): string {
  return value instanceof Date
    ? `${value.getFullYear().toString().padStart(4, "0")}-${(value.getMonth() + 1).toString().padStart(2, "0")}-${value.getDate().toString().padStart(2, "0")}`
    : String(value).slice(0, 10);
}
