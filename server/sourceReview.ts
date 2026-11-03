import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { SOURCE_IDENTITY_FIELDS, SOURCE_ORDER_FIELD_NAMES, SOURCE_REVIEWABLE_FIELD_NAMES, type ImportReviewCommand } from "../src/domain/importReview";
import type { AppState, HistoryEvent } from "../src/domain/types";
import type {
  SourceImportReview,
  SourceImportReviewPage,
  SourceImportReviewStatus,
  SourceOrderFieldName,
  SourceOrderFields,
} from "../src/domain/sourceTypes";
import { ApiError } from "./errors";

export interface SourceReviewCommandResult { state: AppState; sourceChanged: boolean; inventoryChanged: boolean }

interface ReviewRow {
  id: string; status: SourceImportReviewStatus; source_order_id: string; import_id: string;
  observed_source_version: number; current_source_version: number;
  current_fields: SourceOrderFields; candidate_fields: SourceOrderFields; candidate_hash: string;
  changed_fields: SourceOrderFieldName[]; created_at: string | Date; resolved_at: string | Date | null;
  resolution_reason: string | null; selected_fields: SourceOrderFieldName[] | null; applied_source_version: number | null;
  do_no: string; material_code: string; file_name: string; sheet_name: string; digest: string;
  as_of_date: string | Date; imported_at: string | Date;
  manual_medication: boolean | null; manual_fmr_omed: boolean | null; manual_due_date: boolean | null;
  reservation_scaled: string | number | null; has_execution: boolean; has_ledger: boolean; has_production_dispatch: boolean;
}

interface OperationalState {
  inventoryExists: boolean;
  manualMedication: boolean;
  manualFmrOmed: boolean;
  manualDueDate: boolean;
  reservationScaled: number;
  hasExecution: boolean;
  hasLedger: boolean;
  hasProductionDispatch: boolean;
}

export async function listSourceImportReviews(pool: pg.Pool, query: URLSearchParams): Promise<SourceImportReviewPage> {
  validateReviewQuery(query);
  const status = (query.get("status") ?? "pending") as SourceImportReviewStatus;
  const page = Number(query.get("page") ?? 1);
  const values: unknown[] = [status];
  const where = ["d.workspace_id=1", "d.status=$1"];
  for (const [name, column] of [["sourceOrderId", "source_order_id"], ["importId", "import_id"]] as const) {
    const value = query.get(name);
    if (value) { values.push(value); where.push(`d.${column}=$${values.length}`); }
  }
  values.push(page);
  const pageParam = `$${values.length}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const meta = await client.query<{ total: number; page: number; pending: number; applied: number; dismissed: number }>(
      `SELECT count(*) FILTER (WHERE ${where.join(" AND ")})::integer total,
         LEAST(${pageParam}::integer,GREATEST(1,CEIL(count(*) FILTER (WHERE ${where.join(" AND ")})/50.0)::integer)) page,
         count(*) FILTER (WHERE d.workspace_id=1 AND d.status='pending')::integer pending,
         count(*) FILTER (WHERE d.workspace_id=1 AND d.status='applied')::integer applied,
         count(*) FILTER (WHERE d.workspace_id=1 AND d.status='dismissed')::integer dismissed
       FROM source_order_discrepancies d`, values);
    const actualPage = meta.rows[0]?.page ?? 1;
    const rows = await client.query<ReviewRow>(
      `${reviewRowsSql(where.join(" AND "))} ORDER BY d.created_at DESC,d.id DESC LIMIT 50 OFFSET $${values.length}`,
      [...values.slice(0, -1), (actualPage - 1) * 50],
    );
    await client.query("COMMIT");
    const summary = meta.rows[0] ?? { total: 0, page: 1, pending: 0, applied: 0, dismissed: 0 };
    return { items: rows.rows.map(toReview), page: actualPage, pageSize: 50, total: summary.total,
      counts: { pending: summary.pending, applied: summary.applied, dismissed: summary.dismissed } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getSourceImportReview(pool: pg.Pool, id: string): Promise<SourceImportReview | null> {
  const result = await pool.query<ReviewRow>(reviewRowsSql("d.workspace_id=1 AND d.id=$1"), [id]);
  return result.rowCount ? toReview(result.rows[0]) : null;
}

export async function executeSourceImportReview(
  client: pg.PoolClient,
  state: AppState,
  command: ImportReviewCommand,
  nowIso: string,
): Promise<SourceReviewCommandResult> {
  const reviews = await client.query<{
    id: string; status: SourceImportReviewStatus; source_order_id: string; import_id: string;
    observed_source_version: number; candidate_fields: SourceOrderFields; candidate_hash: string;
  }>(`SELECT id,status,source_order_id,import_id,observed_source_version,candidate_fields,candidate_hash
        FROM source_order_discrepancies WHERE workspace_id=1 AND id=$1 FOR UPDATE`, [command.reviewId]);
  if (!reviews.rowCount) throw new ApiError(404, "SOURCE_REVIEW_NOT_FOUND", "The import review item no longer exists.");
  const review = reviews.rows[0];
  if (review.status !== "pending") throw new ApiError(409, "SOURCE_REVIEW_RESOLVED", "This import review item has already been resolved.");
  const sources = await client.query<{ latest_version: number; fields: SourceOrderFields }>(
    `SELECT o.latest_version,v.fields FROM source_orders o
       JOIN source_order_versions v ON v.source_order_id=o.id AND v.version=o.latest_version
      WHERE o.workspace_id=1 AND o.id=$1 FOR UPDATE OF o`, [review.source_order_id]);
  if (!sources.rowCount) throw new ApiError(404, "SOURCE_REVIEW_NOT_FOUND", "The source order for this review no longer exists.");
  const source = sources.rows[0];
  if (source.latest_version !== command.expectedSourceVersion) {
    throw new ApiError(409, "SOURCE_VERSION_CHANGED", "The source order changed. Refresh the review before continuing.");
  }
  if (command.type === "data.dismissSourceCorrection") {
    await client.query(`UPDATE source_order_discrepancies SET status='dismissed',resolved_at=$2::timestamptz,
      resolution_reason=$3,selected_fields=NULL,applied_source_version=NULL WHERE id=$1`, [review.id, nowIso, command.reason]);
    return { state: appendEvent(state, nowIso, "data.source-correction.dismissed",
      `Dismissed import review ${review.id} from ${review.import_id}. Reason: ${command.reason}`), sourceChanged: true, inventoryChanged: false };
  }
  if (review.observed_source_version !== source.latest_version) {
    throw new ApiError(409, "SOURCE_REVIEW_STALE", "This candidate was observed against an older source version. Review the latest order and dismiss this stale item.");
  }
  if (reviewFieldsHash(review.candidate_fields) !== review.candidate_hash) throw new Error(`Stored source review ${review.id} has an invalid candidate hash.`);
  const differences = changedFields(source.fields, review.candidate_fields);
  if (!command.selectedFields.every(field => differences.includes(field))) {
    throw new ApiError(409, "SOURCE_REVIEW_STALE", "One or more selected fields no longer differ from the current source order.");
  }
  const operational = await lockOperationalState(client, review.source_order_id);
  for (const field of command.selectedFields) assertAllowed(field, operational);
  const nextFields = { ...source.fields };
  for (const field of command.selectedFields) assignField(nextFields, field, review.candidate_fields[field]);
  const nextVersion = source.latest_version + 1;
  await client.query(`INSERT INTO source_order_versions(source_order_id,version,import_id,fields,content_hash,created_at)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
  [review.source_order_id, nextVersion, review.import_id, JSON.stringify(nextFields), fieldsHash(nextFields), nowIso]);
  await client.query(`UPDATE source_orders SET latest_version=$2,latest_import_id=$3,updated_at=$4::timestamptz WHERE id=$1`,
    [review.source_order_id, nextVersion, review.import_id, nowIso]);
  const inventorySelected = operational.inventoryExists && command.selectedFields.some(field =>
    field === "deliveryDate" || field === "quantity" || field === "medication" || field === "fmrOmed");
  if (inventorySelected) await updateInventoryOrder(client, review.source_order_id, nextFields, command.selectedFields, nowIso);
  await client.query(`UPDATE source_order_discrepancies SET status='applied',resolved_at=$2::timestamptz,
    resolution_reason=$3,selected_fields=$4::jsonb,applied_source_version=$5 WHERE id=$1`,
  [review.id, nowIso, command.reason, JSON.stringify(command.selectedFields), nextVersion]);
  const before = Object.fromEntries(command.selectedFields.map(field => [field, source.fields[field]]));
  const after = Object.fromEntries(command.selectedFields.map(field => [field, nextFields[field]]));
  return { state: appendEvent(state, nowIso, "data.source-correction.applied",
    `Applied import review ${review.id} from ${review.import_id}; fields ${command.selectedFields.join(", ")}; reason: ${command.reason}; before ${canonicalJson(before)}; after ${canonicalJson(after)}.`),
    sourceChanged: true, inventoryChanged: inventorySelected };
}

function reviewRowsSql(where: string): string {
  return `SELECT d.*,o.latest_version current_source_version,o.do_no,o.material_code,v.fields current_fields,
    i.file_name,i.sheet_name,i.digest,i.as_of_date,i.imported_at,
    io.manual_medication,io.manual_fmr_omed,io.manual_due_date,
    COALESCE(r.quantity_scaled,0)::text reservation_scaled,
    EXISTS(SELECT 1 FROM job_source_allocations a JOIN jobs j ON j.id=a.job_id WHERE a.source_order_id=o.id AND j.status<>'cancelled') has_execution,
    EXISTS(SELECT 1 FROM inventory_ledger l WHERE l.source_order_id=o.id) has_ledger,
    EXISTS(SELECT 1 FROM inventory_ledger l WHERE l.source_order_id=o.id AND l.movement_type IN ('production','dispatch')) has_production_dispatch
   FROM source_order_discrepancies d JOIN source_orders o ON o.id=d.source_order_id
   JOIN source_order_versions v ON v.source_order_id=o.id AND v.version=o.latest_version
   JOIN source_imports i ON i.id=d.import_id LEFT JOIN inventory_orders io ON io.source_order_id=o.id
   LEFT JOIN inventory_reservations r ON r.source_order_id=o.id WHERE ${where}`;
}

function toReview(row: ReviewRow): SourceImportReview {
  const operational: OperationalState = { inventoryExists: row.manual_medication !== null, manualMedication: Boolean(row.manual_medication),
    manualFmrOmed: Boolean(row.manual_fmr_omed), manualDueDate: Boolean(row.manual_due_date), reservationScaled: Number(row.reservation_scaled ?? 0),
    hasExecution: row.has_execution, hasLedger: row.has_ledger, hasProductionDispatch: row.has_production_dispatch };
  return { id: row.id, status: row.status, sourceOrderId: row.source_order_id, doNo: row.do_no, materialCode: row.material_code,
    observedSourceVersion: row.observed_source_version, currentSourceVersion: row.current_source_version,
    currentFields: row.current_fields, candidateFields: row.candidate_fields, changedFields: changedFields(row.current_fields, row.candidate_fields),
    protectedFields: SOURCE_ORDER_FIELD_NAMES.filter(field => protectedReason(field, operational) !== null),
    sourceImport: { id: row.import_id, fileName: row.file_name, sheetName: row.sheet_name, digest: row.digest,
      asOfDate: dbDate(row.as_of_date), importedAt: new Date(row.imported_at).toISOString() },
    createdAt: new Date(row.created_at).toISOString(), resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolutionReason: row.resolution_reason, selectedFields: row.selected_fields, appliedSourceVersion: row.applied_source_version };
}

async function lockOperationalState(client: pg.PoolClient, sourceOrderId: string): Promise<OperationalState> {
  const inventory = await client.query<{ manual_medication: boolean; manual_fmr_omed: boolean; manual_due_date: boolean }>(
    "SELECT manual_medication,manual_fmr_omed,manual_due_date FROM inventory_orders WHERE source_order_id=$1 FOR UPDATE", [sourceOrderId]);
  const reservation = await client.query<{ quantity_scaled: string }>(
    "SELECT quantity_scaled::text FROM inventory_reservations WHERE source_order_id=$1 FOR UPDATE", [sourceOrderId]);
  const execution = await client.query(`SELECT 1 FROM job_source_allocations a JOIN jobs j ON j.id=a.job_id
    WHERE a.source_order_id=$1 AND j.status<>'cancelled' LIMIT 1`, [sourceOrderId]);
  const ledger = await client.query<{ movement_type: string }>("SELECT movement_type FROM inventory_ledger WHERE source_order_id=$1 FOR SHARE", [sourceOrderId]);
  const row = inventory.rows[0];
  return { inventoryExists: Boolean(row), manualMedication: Boolean(row?.manual_medication), manualFmrOmed: Boolean(row?.manual_fmr_omed),
    manualDueDate: Boolean(row?.manual_due_date), reservationScaled: Number(reservation.rows[0]?.quantity_scaled ?? 0),
    hasExecution: Boolean(execution.rowCount), hasLedger: Boolean(ledger.rowCount),
    hasProductionDispatch: ledger.rows.some(item => item.movement_type === "production" || item.movement_type === "dispatch") };
}

function assertAllowed(field: SourceOrderFieldName, state: OperationalState): void {
  const reason = protectedReason(field, state);
  if (!reason) return;
  if (reason === "reservation") throw new ApiError(409, "SOURCE_RESERVATION_CONFLICT", "Quantity cannot be corrected while the order has an active reservation.");
  if (reason === "execution") throw new ApiError(409, "SOURCE_EXECUTION_CONFLICT", "This field cannot be corrected after production or inventory execution has started.");
  throw new ApiError(409, "SOURCE_FIELD_PROTECTED", "The selected field is protected and cannot be corrected through import review.");
}

function protectedReason(field: SourceOrderFieldName, state: OperationalState): "field" | "execution" | "reservation" | null {
  if ((SOURCE_IDENTITY_FIELDS as readonly SourceOrderFieldName[]).includes(field)) return "field";
  if (field === "deliveryDate" && state.manualDueDate) return "field";
  if (field === "medication" && state.manualMedication || field === "fmrOmed" && state.manualFmrOmed) return "field";
  if ((field === "medication" || field === "fmrOmed") && (state.hasExecution || state.hasLedger)) return "execution";
  if (field === "quantity" && state.reservationScaled !== 0) return "reservation";
  if (field === "quantity" && (state.hasExecution || state.hasProductionDispatch)) return "execution";
  return null;
}

async function updateInventoryOrder(client: pg.PoolClient, sourceOrderId: string, fields: SourceOrderFields,
  selected: readonly SourceOrderFieldName[], nowIso: string): Promise<void> {
  const updates = ["updated_at=$2::timestamptz"];
  const values: unknown[] = [sourceOrderId, nowIso];
  const add = (column: string, value: unknown) => { values.push(value); updates.push(`${column}=$${values.length}`); };
  if (selected.includes("deliveryDate")) add("due_date", fields.deliveryDate);
  if (selected.includes("quantity")) add("ordered_quantity_scaled", sourceQuantityScaled(fields));
  if (selected.includes("medication")) add("medication", fields.medication);
  if (selected.includes("fmrOmed")) add("fmr_omed", fields.fmrOmed);
  await client.query(`UPDATE inventory_orders SET ${updates.join(",")} WHERE source_order_id=$1`, values);
}

function sourceQuantityScaled(fields: SourceOrderFields): number {
  const scaled = fields.unit === "MT" ? fields.quantity * 1_000 : fields.quantity;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7 || rounded < 0) {
    throw new ApiError(400, "SOURCE_QUANTITY_PRECISION", "Corrected quantity must be whole Bags or MT with at most 3 decimals.");
  }
  return rounded;
}

function assignField(target: SourceOrderFields, field: SourceOrderFieldName, value: SourceOrderFields[SourceOrderFieldName]): void {
  (target as unknown as Record<SourceOrderFieldName, SourceOrderFields[SourceOrderFieldName]>)[field] = value;
}

function changedFields(current: SourceOrderFields, candidate: SourceOrderFields): SourceOrderFieldName[] {
  return SOURCE_REVIEWABLE_FIELD_NAMES.filter(field => JSON.stringify(current[field]) !== JSON.stringify(candidate[field]));
}

function fieldsHash(fields: SourceOrderFields): string { return createHash("sha256").update(canonicalJson(fields)).digest("hex"); }
function reviewFieldsHash(fields: SourceOrderFields): string { return createHash("sha256").update(canonicalJson(Object.fromEntries(SOURCE_REVIEWABLE_FIELD_NAMES.map(
  field => [field, fields[field]],
)))).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}
function appendEvent(state: AppState, at: string, type: string, message: string): AppState {
  const event: HistoryEvent = { id: `event-${randomUUID()}`, at, type, message };
  return { ...state, events: [...state.events, event] };
}
function dbDate(value: string | Date): string { return value instanceof Date
  ? `${value.getFullYear().toString().padStart(4,"0")}-${(value.getMonth()+1).toString().padStart(2,"0")}-${value.getDate().toString().padStart(2,"0")}`
  : String(value).slice(0,10); }

function validateReviewQuery(query: URLSearchParams): void {
  const supported = new Set(["status", "page", "sourceOrderId", "importId"]);
  for (const [name] of query) if (!supported.has(name)) throw new ApiError(400, "INVALID_DATA_FILTER", `Review filter ${name} is not supported.`);
  for (const name of supported) if (query.getAll(name).length > 1) throw new ApiError(400, "INVALID_DATA_FILTER", `Review filter ${name} may only be supplied once.`);
  const status = query.get("status") ?? "pending";
  if (!new Set(["pending", "applied", "dismissed"]).has(status)) throw new ApiError(400, "INVALID_DATA_FILTER", "Review status is invalid.");
  const page = query.get("page") ?? "1";
  if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) > 1_000_000) throw new ApiError(400, "INVALID_DATA_FILTER", "Review page is invalid.");
  for (const name of ["sourceOrderId", "importId"] as const) {
    const value = query.get(name); if (value !== null && (!value.trim() || value.length > 200)) throw new ApiError(400, "INVALID_DATA_FILTER", `${name} is invalid.`);
  }
}
