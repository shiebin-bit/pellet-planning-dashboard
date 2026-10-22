import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { createJob } from "../src/domain/engine";
import type { AppState, HistoryEvent, Job } from "../src/domain/types";
import type {
  CreateJobFromSourceInput,
  SourceImportInput,
  SourceImportPreview,
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
}

interface SourceCommandResult { state: AppState; sourceChanged: boolean }

export async function previewSourceImport(client: pg.Pool | pg.PoolClient, input: SourceImportInput): Promise<SourceImportPreview> {
  const existing = await existingByKeys(client, input.rows);
  const rows = input.rows.map(fields => {
    const current = existing.get(sourceKey(fields.doNo, fields.materialCode));
    const hash = fieldsHash(fields);
    const changedFields = current ? Object.keys(fields).filter(key =>
      JSON.stringify(current.fields[key as keyof SourceOrderFields]) !== JSON.stringify(fields[key as keyof SourceOrderFields])) : [];
    if (current && dbDate(current.as_of_date) !== input.asOfDate) changedFields.push("asOfDate");
    return {
      key: `${fields.doNo} / ${fields.materialCode}`,
      disposition: (!current ? "added" : current.content_hash === hash && dbDate(current.as_of_date) === input.asOfDate ? "unchanged" : "changed") as "added" | "unchanged" | "changed",
      existingOrderId: current?.id ?? null,
      fields,
      changedFields,
    };
  });
  return {
    added: rows.filter(row => row.disposition === "added").length,
    unchanged: rows.filter(row => row.disposition === "unchanged").length,
    changed: rows.filter(row => row.disposition === "changed").length,
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
  const preview = await previewSourceImport(client, input);
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
    const isDone = fields.remark.trim().toLocaleLowerCase("en-US") === "done";
    if (!current) {
      const id = `source-${randomUUID()}`;
      await client.query(
        `INSERT INTO source_orders(id, workspace_id, do_no, material_code, latest_version, latest_import_id,
          delivery_status, delivery_source, delivery_recorded_at, needs_review, updated_at)
         VALUES ($1, 1, $2, $3, 1, $4, $5, $6, $7::timestamptz, false, $8::timestamptz)`,
        [id, fields.doNo, fields.materialCode, importId, isDone ? "delivered" : "pending", isDone ? "import" : null, isDone ? nowIso : null, nowIso],
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
    const deliveryConflict = Boolean(activeJob && activeJob.status !== "completed" && (isDone || current.delivery_status === "delivered"));
    await client.query(
      `UPDATE source_orders SET latest_version = $2,
         delivery_status = CASE WHEN $3 AND delivery_source IS DISTINCT FROM 'manual' THEN 'delivered' ELSE delivery_status END,
         delivery_source = CASE WHEN $3 AND delivery_source IS DISTINCT FROM 'manual' THEN 'import' ELSE delivery_source END,
         delivery_recorded_at = CASE WHEN $3 AND delivery_source IS DISTINCT FROM 'manual' THEN $4::timestamptz ELSE delivery_recorded_at END,
         needs_review = $5 OR $6, updated_at = $4::timestamptz
       WHERE id = $1`,
      [current.id, nextVersion, isDone, nowIso, planningChanged, deliveryConflict],
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
  if (search) {
    values.push(`%${search}%`);
    where.push(`(o.do_no ILIKE $${values.length} OR o.material_code ILIKE $${values.length} OR v.fields->>'description' ILIKE $${values.length} OR v.fields->>'soldToParty' ILIKE $${values.length} OR v.fields->>'shipToParty' ILIKE $${values.length})`);
  }
  for (const [name, operator] of [["deliveryFrom", ">="], ["deliveryTo", "<="]] as const) {
    const value = query.get(name);
    if (value) { values.push(value); where.push(`(v.fields->>'deliveryDate')::date ${operator} $${values.length}::date`); }
  }
  const unit = query.get("unit");
  if (unit) { values.push(unit); where.push(`v.fields->>'unit' = $${values.length}`); }
  const deliveryStatus = query.get("deliveryStatus");
  if (deliveryStatus) { values.push(deliveryStatus); where.push(`o.delivery_status = $${values.length}`); }
  const importId = query.get("importId");
  if (importId) { values.push(importId); where.push(`o.latest_import_id = $${values.length}`); }
  const today = malaysiaDate();
  values.push(today);
  const todayParameter = `$${values.length}`;
  const dynamicWhere: string[] = [];
  const productionStatus = query.get("productionStatus");
  if (productionStatus) { values.push(productionStatus); dynamicWhere.push(`production_status = $${values.length}`); }
  const overdue = query.get("overdue");
  const pickupOverdue = "delivery_status <> 'delivered' AND current_days_outstanding < 0";
  const productionOverdue = "production_status NOT IN ('completed', 'external-complete') AND current_delivery_lead_days < 0";
  if (overdue === "true" || overdue === "pickup") dynamicWhere.push(`(${pickupOverdue})`);
  if (overdue === "production") dynamicWhere.push(`(${productionOverdue})`);
  if (overdue === "false") dynamicWhere.push(`NOT (COALESCE((${pickupOverdue}), false) OR COALESCE((${productionOverdue}), false))`);
  const requestedPage = Number(query.get("page") ?? 1);
  values.push(requestedPage);
  const pageParameter = `$${values.length}`;
  const result = await pool.query<SourceListResult>(
    `WITH base AS (
       SELECT o.id, o.latest_version, o.latest_import_id AS import_id, i.file_name, i.as_of_date::text AS as_of_date,
         o.delivery_status, o.delivery_source, o.delivery_recorded_at, o.delivery_reason, o.needs_review, o.updated_at,
         v.fields, j.id AS job_id, j.status AS job_status, NULLIF(j.payload->>'sourceOrderVersion','')::integer AS job_source_version,
         j.payload->'sourceSnapshot' AS job_source_snapshot,
         (v.fields->>'deliveryDate')::date AS delivery_date, o.do_no, o.material_code,
         COALESCE(j.status, CASE WHEN o.delivery_status = 'delivered' THEN 'external-complete' ELSE 'unplanned' END) AS production_status,
         CASE WHEN v.fields->>'deliveryLeadDays' IS NULL THEN NULL ELSE (v.fields->>'deliveryLeadDays')::integer - (${todayParameter}::date - i.as_of_date) END AS current_delivery_lead_days,
         CASE WHEN v.fields->>'daysOutstanding' IS NULL THEN NULL ELSE (v.fields->>'daysOutstanding')::integer - (${todayParameter}::date - i.as_of_date) END AS current_days_outstanding
       FROM source_orders o
       JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
       JOIN source_imports i ON i.id = o.latest_import_id
       LEFT JOIN LATERAL (SELECT id, status, payload FROM jobs WHERE workspace_id = 1 AND source_order_id = o.id AND status <> 'cancelled' ORDER BY ordinal DESC LIMIT 1) j ON true
       WHERE ${where.join(" AND ")}
     ), filtered AS (
       SELECT * FROM base${dynamicWhere.length ? ` WHERE ${dynamicWhere.join(" AND ")}` : ""}
     ), stats AS (
       SELECT count(*)::integer AS total,
         count(*) FILTER (WHERE production_status = 'pending')::integer AS planned,
         count(*) FILTER (WHERE production_status = 'running')::integer AS running,
         count(*) FILTER (WHERE production_status IN ('completed', 'external-complete'))::integer AS completed,
         count(*) FILTER (WHERE delivery_status = 'delivered')::integer AS delivered,
         count(*) FILTER (WHERE delivery_status <> 'delivered' AND current_days_outstanding < 0)::integer AS overdue
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
  id: string; latest_version: number; import_id: string; file_name: string; as_of_date: string | Date;
  delivery_status: "pending" | "delivered"; delivery_source: "import" | "manual" | null;
  delivery_recorded_at: string | Date | null; delivery_reason: string | null; needs_review: boolean; updated_at: string | Date;
  fields: SourceOrderFields; job_id: string | null; job_status: Job["status"] | null; job_source_version: number | null;
  job_source_snapshot: Job["sourceSnapshot"] | null;
}

interface SourceListResult {
  total: number; planned: number; running: number; completed: number; delivered: number; overdue: number;
  page: number; items: SourceDbView[];
}

function sourceViewSql(where: string): string {
  return `SELECT o.id, o.latest_version, o.latest_import_id AS import_id, i.file_name, i.as_of_date::text AS as_of_date,
    o.delivery_status, o.delivery_source, o.delivery_recorded_at, o.delivery_reason, o.needs_review, o.updated_at,
    v.fields, j.id AS job_id, j.status AS job_status, NULLIF(j.payload->>'sourceOrderVersion','')::integer AS job_source_version,
    j.payload->'sourceSnapshot' AS job_source_snapshot
    FROM source_orders o
    JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
    JOIN source_imports i ON i.id = o.latest_import_id
    LEFT JOIN LATERAL (SELECT id, status, payload FROM jobs WHERE workspace_id = 1 AND source_order_id = o.id AND status <> 'cancelled' ORDER BY ordinal DESC LIMIT 1) j ON true
    WHERE ${where} ORDER BY (v.fields->>'deliveryDate')::date, o.do_no, o.material_code`;
}

function toSummary(row: SourceDbView, today: string): SourceOrderSummary {
  const asOfDate = row.as_of_date instanceof Date ? row.as_of_date.toISOString().slice(0, 10) : String(row.as_of_date).slice(0, 10);
  const elapsed = calendarDays(asOfDate, today);
  const productionStatus = row.job_status ?? (row.delivery_status === "delivered" ? "external-complete" : "unplanned");
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
    linkedJobId: row.job_id,
    currentDeliveryLeadDays: row.fields.deliveryLeadDays === null ? null : row.fields.deliveryLeadDays - elapsed,
    currentDaysOutstanding: row.fields.daysOutstanding === null ? null : row.fields.daysOutstanding - elapsed,
    needsReview: row.needs_review || sourcePlanningMismatch(row.fields, row.job_source_snapshot),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function existingByKeys(client: pg.Pool | pg.PoolClient, rows: SourceOrderFields[]): Promise<Map<string, ExistingSourceRow>> {
  if (!rows.length) return new Map();
  const keys = rows.map(row => [row.doNo, row.materialCode]);
  const result = await client.query<ExistingSourceRow>(
    `SELECT o.id, o.latest_version, v.content_hash, v.fields, o.delivery_status, o.delivery_source, i.as_of_date::text AS as_of_date
       FROM source_orders o JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
      JOIN source_imports i ON i.id = o.latest_import_id
      JOIN jsonb_to_recordset($1::jsonb) AS k(do_no text, material_code text)
        ON lower(btrim(o.do_no)) = lower(btrim(k.do_no)) AND lower(btrim(o.material_code)) = lower(btrim(k.material_code))
      WHERE o.workspace_id = 1`,
    [JSON.stringify(keys.map(([do_no, material_code]) => ({ do_no, material_code })))],
  );
  return new Map(result.rows.map(row => [sourceKey(row.fields.doNo, row.fields.materialCode), row]));
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
  const supported = new Set(["search", "deliveryFrom", "deliveryTo", "unit", "productionStatus", "deliveryStatus", "overdue", "importId", "page"]);
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
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
