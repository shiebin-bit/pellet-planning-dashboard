import { parseCommand } from "../domain/commands";
import type {
  InventoryDraftJob,
  InventoryDraftPreview,
} from "../domain/inventoryTypes";
import type { LineId } from "../domain/types";

export const PLANNING_DRAFT_STORAGE_KEY = "millplan.planning-draft.v1";
export const PLANNING_DRAFT_BROWSER_ONLY_LABEL = "Saved in this browser only";
export const PLANNING_DRAFT_MAX_BYTES = 8 * 1024 * 1024;

export interface PlanningDraftUiState {
  from: string;
  to: string;
  demandThrough: string;
  combineSameProduct: boolean;
}

export interface PreparedPlanningDraftCommit {
  expectedRevision: number;
  commandId: string;
  command: {
    type: "planning.commitDraft";
    previewRevision: number;
    jobs: InventoryDraftJob[];
  };
}

export interface SavedPlanningDraft {
  schemaVersion: 1;
  draftInstanceId: string;
  baseRevision: number;
  baseUpdatedAt: string;
  savedAt: string;
  preview: InventoryDraftPreview;
  jobs: InventoryDraftJob[];
  ui: PlanningDraftUiState;
  pendingCommit?: PreparedPlanningDraftCommit;
}

export interface CreatePlanningDraftInput {
  baseRevision: number;
  baseUpdatedAt: string;
  preview: InventoryDraftPreview;
  jobs: InventoryDraftJob[];
  ui: PlanningDraftUiState;
  draftInstanceId?: string;
  savedAt?: string;
}

export interface PlanningDraftWorkspaceVersion {
  revision: number | null;
  updatedAt: string | null;
}

export interface PlanningDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PlanningDraftStorageExpectation {
  /** Null requires no saved draft. A string requires the same draft instance. */
  draftInstanceId: string | null;
  /** Detects edits from another tab that retained the same draft instance id. */
  savedAt?: string;
  /** Optional stronger guard retained from the caller's last successful read or write. */
  draftFingerprint?: string;
  /** When supplied, also protects a pending retry from being replaced or cleared. */
  pendingCommandId?: string | null;
}

export type PlanningDraftStorageFailureCode =
  | "unavailable"
  | "invalid"
  | "too-large"
  | "conflict";

export type PlanningDraftStorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PlanningDraftStorageFailureCode; error: string };

export interface ReadPlanningDraftValue {
  draft: SavedPlanningDraft | null;
  stale: boolean;
  /** A stale restored draft must be freshly generated before commit. */
  requiresFreshGeneration: boolean;
  /** A persisted uncertain commit is the only command that may be retried after reload. */
  canRetryPendingCommit: boolean;
}

export interface PreparedPlanningDraftValue {
  draft: SavedPlanningDraft;
  request: PreparedPlanningDraftCommit;
}

export function createPlanningDraft(input: CreatePlanningDraftInput): SavedPlanningDraft {
  return validateDraft({
    schemaVersion: 1,
    draftInstanceId: input.draftInstanceId ?? newUuid(),
    baseRevision: input.baseRevision,
    baseUpdatedAt: input.baseUpdatedAt,
    savedAt: input.savedAt ?? new Date().toISOString(),
    preview: input.preview,
    jobs: input.jobs,
    ui: input.ui,
  });
}

export function parsePlanningDraft(raw: string): SavedPlanningDraft {
  if (typeof raw !== "string") throw new Error("Saved planning draft must be JSON text.");
  if (byteLength(raw) > PLANNING_DRAFT_MAX_BYTES) {
    throw new Error("Saved planning draft exceeds the 8 MB browser limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Saved planning draft is not valid JSON.");
  }
  return parseDraft(value);
}

export function readPlanningDraft(
  storage: PlanningDraftStorage,
  current?: PlanningDraftWorkspaceVersion,
): PlanningDraftStorageResult<ReadPlanningDraftValue> {
  let raw: string | null;
  try {
    raw = storage.getItem(PLANNING_DRAFT_STORAGE_KEY);
  } catch {
    return failure("unavailable", "This browser could not read the locally saved planning draft. Nothing was cleared.");
  }
  if (raw === null) return success({ draft: null, stale: false, requiresFreshGeneration: false, canRetryPendingCommit: false });
  try {
    const draft = parsePlanningDraft(raw);
    const stale = current ? isPlanningDraftStale(draft, current) : false;
    return success({
      draft,
      stale,
      requiresFreshGeneration: stale && draft.pendingCommit === undefined,
      canRetryPendingCommit: draft.pendingCommit !== undefined,
    });
  } catch (error) {
    return failure("invalid", `The locally saved planning draft is corrupt or unsupported and was not restored. ${message(error)}`);
  }
}

export function savePlanningDraft(
  storage: PlanningDraftStorage,
  draft: SavedPlanningDraft,
  expected?: PlanningDraftStorageExpectation,
): PlanningDraftStorageResult<SavedPlanningDraft> {
  let validated: SavedPlanningDraft;
  let serialized: string;
  try {
    validated = validateDraft({ ...draft, savedAt: draft.savedAt });
    serialized = JSON.stringify(validated);
  } catch (error) {
    return failure("invalid", message(error));
  }
  if (byteLength(serialized) > PLANNING_DRAFT_MAX_BYTES) {
    return failure("too-large", "The planning draft is larger than 8 MB and was not saved in this browser.");
  }
  const conflict = expectationConflict(storage, expected);
  if (conflict) return conflict;
  try {
    storage.setItem(PLANNING_DRAFT_STORAGE_KEY, serialized);
    return success(validated);
  } catch {
    return failure("unavailable", "This browser could not save the planning draft. The existing saved draft was not cleared.");
  }
}

export function preparePlanningDraftCommit(
  storage: PlanningDraftStorage,
  draft: SavedPlanningDraft,
  commandId: string,
): PlanningDraftStorageResult<PreparedPlanningDraftValue> {
  const normalizedCommandId = boundedText(commandId, "pendingCommit.commandId", 200, true);
  const request: PreparedPlanningDraftCommit = {
    expectedRevision: draft.baseRevision,
    commandId: normalizedCommandId,
    command: {
      type: "planning.commitDraft",
      previewRevision: draft.baseRevision,
      jobs: clone(draft.jobs),
    },
  };
  let prepared: SavedPlanningDraft;
  try {
    prepared = validateDraft({ ...clone(draft), savedAt: new Date().toISOString(), pendingCommit: request });
  } catch (error) {
    return failure("invalid", message(error));
  }
  const saved = savePlanningDraft(storage, prepared, {
    draftInstanceId: draft.draftInstanceId,
    savedAt: draft.savedAt,
    draftFingerprint: planningDraftFingerprint(draft),
    pendingCommandId: draft.pendingCommit?.commandId ?? null,
  });
  return saved.ok ? success({ draft: saved.value, request: saved.value.pendingCommit! }) : saved;
}

export function clearPlanningDraft(
  storage: PlanningDraftStorage,
  expected?: PlanningDraftStorageExpectation,
): PlanningDraftStorageResult<null> {
  const conflict = expectationConflict(storage, expected);
  if (conflict) return conflict;
  try {
    storage.removeItem(PLANNING_DRAFT_STORAGE_KEY);
    return success(null);
  } catch {
    return failure("unavailable", "This browser could not clear the locally saved planning draft.");
  }
}

export function isPlanningDraftStale(
  draft: SavedPlanningDraft,
  current: PlanningDraftWorkspaceVersion,
): boolean {
  return current.revision === null || current.updatedAt === null ||
    current.revision !== draft.baseRevision || current.updatedAt !== draft.baseUpdatedAt;
}

export function planningDraftFingerprint(draft: SavedPlanningDraft): string {
  return canonicalJson(draft);
}

export function regeneratePlanningDraftIdentity(
  draft: SavedPlanningDraft,
  nowIso = new Date().toISOString(),
): SavedPlanningDraft {
  const { pendingCommit: _pending, ...rest } = clone(draft);
  return validateDraft({ ...rest, draftInstanceId: newUuid(), savedAt: isoTimestamp(nowIso, "savedAt") });
}

function expectationConflict(
  storage: PlanningDraftStorage,
  expected: PlanningDraftStorageExpectation | undefined,
): PlanningDraftStorageResult<never> | null {
  if (!expected) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PLANNING_DRAFT_STORAGE_KEY);
  } catch {
    return failure("unavailable", "This browser could not verify the existing planning draft. Nothing was changed.");
  }
  if (expected.draftInstanceId === null) {
    return raw === null ? null : failure("conflict", "Another tab saved a planning draft first. Reload its draft before continuing.");
  }
  if (raw === null) return failure("conflict", "The saved planning draft was removed in another tab. Nothing was changed.");
  let current: SavedPlanningDraft;
  try {
    current = parsePlanningDraft(raw);
  } catch {
    return failure("invalid", "The existing local planning draft is corrupt. Nothing was changed; discard it explicitly if desired.");
  }
  if (current.draftInstanceId !== expected.draftInstanceId) {
    return failure("conflict", "Another tab replaced the saved planning draft. Reload before continuing.");
  }
  if (expected.savedAt !== undefined && current.savedAt !== expected.savedAt) {
    return failure("conflict", "Another tab edited the saved planning draft. Reload before continuing.");
  }
  if (expected.draftFingerprint !== undefined && planningDraftFingerprint(current) !== expected.draftFingerprint) {
    return failure("conflict", "Another tab changed the saved planning draft. Reload before continuing.");
  }
  if (expected.pendingCommandId !== undefined &&
      (current.pendingCommit?.commandId ?? null) !== expected.pendingCommandId) {
    return failure("conflict", "The saved draft's pending commit changed in another tab. Reload before continuing.");
  }
  return null;
}

function parseDraft(value: unknown): SavedPlanningDraft {
  const source = record(value, "draft");
  exactOptional(source,
    ["schemaVersion", "draftInstanceId", "baseRevision", "baseUpdatedAt", "savedAt", "preview", "jobs", "ui"],
    ["pendingCommit"], "draft");
  if (source.schemaVersion !== 1) throw new Error("draft.schemaVersion must be 1.");
  const baseRevision = integer(source.baseRevision, "draft.baseRevision", 0);
  const preview = previewValue(source.preview, "draft.preview");
  if (preview.revision !== baseRevision) throw new Error("draft.preview.revision must match draft.baseRevision.");
  const jobs = list(source.jobs, "draft.jobs", 2_000).map((job, index) => draftJob(job, `draft.jobs[${index}]`));
  validateJobReferences(preview, jobs);
  const result: SavedPlanningDraft = {
    schemaVersion: 1,
    draftInstanceId: boundedText(source.draftInstanceId, "draft.draftInstanceId", 200, true),
    baseRevision,
    baseUpdatedAt: isoTimestamp(source.baseUpdatedAt, "draft.baseUpdatedAt"),
    savedAt: isoTimestamp(source.savedAt, "draft.savedAt"),
    preview,
    jobs,
    ui: uiValue(source.ui, "draft.ui"),
  };
  if (has(source, "pendingCommit")) result.pendingCommit = pendingCommit(source.pendingCommit, result);
  return result;
}

function validateDraft(value: unknown): SavedPlanningDraft {
  return parseDraft(JSON.parse(JSON.stringify(value)) as unknown);
}

function pendingCommit(value: unknown, draft: SavedPlanningDraft): PreparedPlanningDraftCommit {
  const source = record(value, "draft.pendingCommit");
  exact(source, ["expectedRevision", "commandId", "command"], "draft.pendingCommit");
  const expectedRevision = integer(source.expectedRevision, "draft.pendingCommit.expectedRevision", 0);
  const commandId = boundedText(source.commandId, "draft.pendingCommit.commandId", 200, true);
  const parsed = parseCommand(source.command);
  if (parsed.type !== "planning.commitDraft") throw new Error("draft.pendingCommit.command must be planning.commitDraft.");
  if (expectedRevision !== draft.baseRevision || parsed.previewRevision !== draft.baseRevision) {
    throw new Error("draft.pendingCommit revisions must match draft.baseRevision.");
  }
  if (canonicalJson(parsed.jobs) !== canonicalJson(draft.jobs)) {
    throw new Error("draft.pendingCommit jobs must exactly match draft.jobs.");
  }
  return { expectedRevision, commandId, command: parsed };
}

function previewValue(value: unknown, path: string): InventoryDraftPreview {
  const source = record(value, path);
  exact(source, ["revision", "generatedAt", "request", "demand", "jobs", "backlog", "utilization", "late"], path);
  const request = requestValue(source.request, `${path}.request`);
  const demand = list(source.demand, `${path}.demand`, 10_000).map((row, index) => demandRow(row, `${path}.demand[${index}]`));
  const jobs = list(source.jobs, `${path}.jobs`, 2_000).map((job, index) => draftJob(job, `${path}.jobs[${index}]`));
  const backlog = list(source.backlog, `${path}.backlog`, 10_000).map((row, index) => demandRow(row, `${path}.backlog[${index}]`));
  const utilization = list(source.utilization, `${path}.utilization`, 20_000).map((row, index) => {
    const rowPath = `${path}.utilization[${index}]`; const item = record(row, rowPath);
    exact(item, ["date", "lineId", "hours", "availableHours"], rowPath);
    return { date: date(item.date, `${rowPath}.date`), lineId: lineId(item.lineId, `${rowPath}.lineId`), hours: nonnegative(item.hours, `${rowPath}.hours`), availableHours: nonnegative(item.availableHours, `${rowPath}.availableHours`) };
  });
  const late = list(source.late, `${path}.late`, 10_000).map((row, index) => {
    const rowPath = `${path}.late[${index}]`; const item = record(row, rowPath);
    exact(item, ["key", "dueDate", "plannedDate", "quantity"], rowPath);
    return { key: boundedText(item.key, `${rowPath}.key`, 200, true), dueDate: date(item.dueDate, `${rowPath}.dueDate`), plannedDate: item.plannedDate === null ? null : date(item.plannedDate, `${rowPath}.plannedDate`), quantity: positive(item.quantity, `${rowPath}.quantity`) };
  });
  assertUniqueKeys(demand, `${path}.demand`);
  assertUniqueKeys(backlog, `${path}.backlog`);
  const keys = new Set(demand.map(row => row.key));
  for (const row of backlog) if (!keys.has(row.key)) throw new Error(`${path}.backlog references unknown demand key ${row.key}.`);
  for (const row of late) if (!keys.has(row.key)) throw new Error(`${path}.late references unknown demand key ${row.key}.`);
  const result: InventoryDraftPreview = {
    revision: integer(source.revision, `${path}.revision`, 0),
    generatedAt: isoTimestamp(source.generatedAt, `${path}.generatedAt`),
    request, demand, jobs, backlog, utilization, late,
  };
  validateJobReferences(result, jobs);
  return result;
}

function requestValue(value: unknown, path: string): InventoryDraftPreview["request"] {
  const source = record(value, path);
  exactOptional(source, ["fromDate", "toDate"], ["demandThrough", "sourceOrderIds", "combineSameProduct"], path);
  const result: InventoryDraftPreview["request"] = { fromDate: date(source.fromDate, `${path}.fromDate`), toDate: date(source.toDate, `${path}.toDate`) };
  if (result.toDate < result.fromDate) throw new Error(`${path}.toDate cannot be before fromDate.`);
  if (has(source, "demandThrough")) result.demandThrough = date(source.demandThrough, `${path}.demandThrough`);
  if (has(source, "sourceOrderIds")) {
    result.sourceOrderIds = list(source.sourceOrderIds, `${path}.sourceOrderIds`, 10_000).map((id, index) => boundedText(id, `${path}.sourceOrderIds[${index}]`, 200, true));
    if (new Set(result.sourceOrderIds).size !== result.sourceOrderIds.length) throw new Error(`${path}.sourceOrderIds must be distinct.`);
  }
  if (has(source, "combineSameProduct")) result.combineSameProduct = boolean(source.combineSameProduct, `${path}.combineSameProduct`);
  return result;
}

function demandRow(value: unknown, path: string): InventoryDraftPreview["demand"][number] {
  const source = record(value, path);
  exactOptional(source, ["key", "itemId", "materialCode", "description", "unit", "bagWeightKg", "strategy", "purpose", "sourceOrderId", "orderNo", "dueDate", "notBefore", "quantity", "medication", "fmrOmed"], ["sourceAllocationQuantity"], path);
  const unit = inventoryUnit(source.unit, `${path}.unit`);
  const bagWeightKg = bagWeight(source.bagWeightKg, `${path}.bagWeightKg`);
  assertWeightMatches(unit, bagWeightKg, path);
  const result: InventoryDraftPreview["demand"][number] = {
    key: boundedText(source.key, `${path}.key`, 200, true), itemId: boundedText(source.itemId, `${path}.itemId`, 200, true),
    materialCode: boundedText(source.materialCode, `${path}.materialCode`, 120, true), description: boundedText(source.description, `${path}.description`, 200, false),
    unit, bagWeightKg, strategy: strategy(source.strategy, `${path}.strategy`), purpose: strategy(source.purpose, `${path}.purpose`),
    sourceOrderId: source.sourceOrderId === null ? null : boundedText(source.sourceOrderId, `${path}.sourceOrderId`, 200, true),
    orderNo: source.orderNo === null ? null : boundedText(source.orderNo, `${path}.orderNo`, 120, false), dueDate: date(source.dueDate, `${path}.dueDate`),
    notBefore: isoTimestamp(source.notBefore, `${path}.notBefore`), quantity: positiveQuantity(source.quantity, unit, `${path}.quantity`),
    medication: boundedText(source.medication, `${path}.medication`, 200, false), fmrOmed: boundedText(source.fmrOmed, `${path}.fmrOmed`, 200, false),
  };
  if (has(source, "sourceAllocationQuantity")) result.sourceAllocationQuantity = quantityValue(source.sourceAllocationQuantity, unit, `${path}.sourceAllocationQuantity`, true);
  return result;
}

function draftJob(value: unknown, path: string): InventoryDraftJob {
  const source = record(value, path);
  exactOptional(source, ["draftId", "itemId", "sourceOrderId", "orderNo", "materialCode", "description", "unit", "bagWeightKg", "productionPurpose", "date", "lineId", "quantity", "notBefore", "bin", "remarks", "medication", "fmrOmed"], ["sourceAllocations"], path);
  const unit = inventoryUnit(source.unit, `${path}.unit`); const bagWeightKg = bagWeight(source.bagWeightKg, `${path}.bagWeightKg`);
  assertWeightMatches(unit, bagWeightKg, path);
  const result: InventoryDraftJob = {
    draftId: boundedText(source.draftId, `${path}.draftId`, 200, true), itemId: boundedText(source.itemId, `${path}.itemId`, 200, true),
    sourceOrderId: source.sourceOrderId === null ? null : boundedText(source.sourceOrderId, `${path}.sourceOrderId`, 200, true),
    orderNo: boundedText(source.orderNo, `${path}.orderNo`, 120, false), materialCode: boundedText(source.materialCode, `${path}.materialCode`, 120, true),
    description: boundedText(source.description, `${path}.description`, 200, false), unit, bagWeightKg,
    productionPurpose: strategy(source.productionPurpose, `${path}.productionPurpose`), date: date(source.date, `${path}.date`), lineId: lineId(source.lineId, `${path}.lineId`),
    quantity: positiveQuantity(source.quantity, unit, `${path}.quantity`), notBefore: isoTimestamp(source.notBefore, `${path}.notBefore`),
    bin: boundedText(source.bin, `${path}.bin`, 200, false), remarks: boundedText(source.remarks, `${path}.remarks`, 1_000, false),
    medication: boundedText(source.medication, `${path}.medication`, 200, false), fmrOmed: boundedText(source.fmrOmed, `${path}.fmrOmed`, 200, false),
  };
  if (has(source, "sourceAllocations")) {
    result.sourceAllocations = list(source.sourceAllocations, `${path}.sourceAllocations`, 500).map((row, index) => {
      const rowPath = `${path}.sourceAllocations[${index}]`; const allocation = record(row, rowPath);
      exact(allocation, ["sourceOrderId", "plannedQuantity"], rowPath);
      return { sourceOrderId: boundedText(allocation.sourceOrderId, `${rowPath}.sourceOrderId`, 200, true), plannedQuantity: positiveQuantity(allocation.plannedQuantity, unit, `${rowPath}.plannedQuantity`) };
    });
    if (!result.sourceAllocations.length || new Set(result.sourceAllocations.map(row => row.sourceOrderId)).size !== result.sourceAllocations.length) throw new Error(`${path}.sourceAllocations must contain distinct source orders.`);
    if (result.sourceAllocations.reduce((sum, row) => sum + row.plannedQuantity, 0) > result.quantity + 1e-8) throw new Error(`${path}.sourceAllocations cannot exceed quantity.`);
  }
  return result;
}

function validateJobReferences(preview: InventoryDraftPreview, jobs: InventoryDraftJob[]): void {
  const sources = new Map(preview.demand.filter(row => row.sourceOrderId !== null).map(row => [row.sourceOrderId!, row]));
  const previewIds = new Set<string>();
  for (const job of preview.jobs) {
    if (previewIds.has(job.draftId)) throw new Error(`draft.preview.jobs contains duplicate draftId ${job.draftId}.`);
    previewIds.add(job.draftId);
    validateJobSources(job, sources, "draft.preview.jobs");
  }
  validateAllocationTotals(preview.jobs, sources, "draft.preview.jobs");
  const savedIds = new Set<string>();
  for (const job of jobs) {
    if (savedIds.has(job.draftId)) throw new Error(`draft.jobs contains duplicate draftId ${job.draftId}.`);
    savedIds.add(job.draftId);
    if (!previewIds.has(job.draftId)) throw new Error(`draft.jobs references unknown preview draftId ${job.draftId}.`);
    validateJobSources(job, sources, "draft.jobs");
  }
  validateAllocationTotals(jobs, sources, "draft.jobs");
}

function validateJobSources(job: InventoryDraftJob, sources: Map<string, InventoryDraftPreview["demand"][number]>, path: string): void {
  const ids = job.sourceAllocations?.map(row => row.sourceOrderId) ?? (job.sourceOrderId ? [job.sourceOrderId] : []);
  for (const id of ids) {
    const source = sources.get(id);
    if (!source) throw new Error(`${path} sourceOrderId ${id} is not present in preview demand.`);
    if (source.itemId !== job.itemId || source.unit !== job.unit) throw new Error(`${path} sourceOrderId ${id} does not match the job item and unit.`);
  }
  if (job.sourceOrderId && job.sourceAllocations?.length && !job.sourceAllocations.some(row => row.sourceOrderId === job.sourceOrderId)) {
    throw new Error(`${path} sourceOrderId must appear in sourceAllocations.`);
  }
}

function validateAllocationTotals(
  jobs: InventoryDraftJob[],
  sources: Map<string, InventoryDraftPreview["demand"][number]>,
  path: string,
): void {
  const totals = new Map<string, number>();
  for (const job of jobs) {
    const allocations = job.sourceAllocations ?? (job.sourceOrderId ? [{ sourceOrderId: job.sourceOrderId, plannedQuantity: job.quantity }] : []);
    for (const allocation of allocations) totals.set(allocation.sourceOrderId, (totals.get(allocation.sourceOrderId) ?? 0) + allocation.plannedQuantity);
  }
  for (const [sourceOrderId, total] of totals) {
    const demand = sources.get(sourceOrderId)!;
    const maximum = demand.sourceAllocationQuantity ?? demand.quantity;
    if (total > maximum + 1e-8) throw new Error(`${path} source allocations for ${sourceOrderId} exceed preview demand.`);
  }
}

function uiValue(value: unknown, path: string): PlanningDraftUiState {
  const source = record(value, path); exact(source, ["from", "to", "demandThrough", "combineSameProduct"], path);
  const result = { from: date(source.from, `${path}.from`), to: date(source.to, `${path}.to`), demandThrough: date(source.demandThrough, `${path}.demandThrough`), combineSameProduct: boolean(source.combineSameProduct, `${path}.combineSameProduct`) };
  if (result.to < result.from) throw new Error(`${path}.to cannot be before from.`);
  return result;
}

function assertUniqueKeys(rows: Array<{ key: string }>, path: string): void {
  const keys = new Set<string>();
  for (const row of rows) {
    if (keys.has(row.key)) throw new Error(`${path} keys must be unique.`);
    keys.add(row.key);
  }
}

function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`); return value as Record<string, unknown>; }
function exact(source: Record<string, unknown>, keys: readonly string[], path: string): void { exactOptional(source, keys, [], path); }
function exactOptional(source: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void { const allowed = new Set([...required, ...optional]); for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`); for (const key of required) if (!has(source, key)) throw new Error(`${path}.${key} is required.`); }
function has(source: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(source, key); }
function list(value: unknown, path: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${path} must be an array of ${max} items or fewer.`); return value; }
function boundedText(value: unknown, path: string, max: number, required: boolean): string { if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${path} must be ${required ? "non-blank " : ""}text of ${max} characters or fewer.`); return value; }
function integer(value: unknown, path: string, min: number): number { if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${path} must be a safe integer of at least ${min}.`); return value as number; }
function finite(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`); return value; }
function nonnegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) throw new Error(`${path} cannot be negative.`); return result; }
function positive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) throw new Error(`${path} must be greater than zero.`); return result; }
function positiveQuantity(value: unknown, unit: "Bags" | "MT", path: string): number { return quantityValue(value, unit, path, false); }
function quantityValue(value: unknown, unit: "Bags" | "MT", path: string, allowZero: boolean): number { const result = allowZero ? nonnegative(value, path) : positive(value, path); const scaled = unit === "Bags" ? result : result * 1_000; if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-8) throw new Error(`${path} must be whole Bags or MT with at most 3 decimals.`); return result; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new Error(`${path} must be true or false.`); return value; }
function date(value: unknown, path: string): string { const result = boundedText(value, path, 10, true); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${path} must be a valid YYYY-MM-DD date.`); const [year, month, day] = result.split("-").map(Number); if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== result) throw new Error(`${path} must be a valid YYYY-MM-DD date.`); return result; }
function isoTimestamp(value: unknown, path: string): string { const result = boundedText(value, path, 100, true); const parsed = Date.parse(result); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) throw new Error(`${path} must be a normalized ISO timestamp.`); return result; }
function inventoryUnit(value: unknown, path: string): "Bags" | "MT" { if (value !== "Bags" && value !== "MT") throw new Error(`${path} must be Bags or MT.`); return value; }
function strategy(value: unknown, path: string): "mto" | "mts" { if (value !== "mto" && value !== "mts") throw new Error(`${path} must be mto or mts.`); return value; }
function bagWeight(value: unknown, path: string): 25 | 50 | null { if (value === null) return null; if (value !== 25 && value !== 50) throw new Error(`${path} must be 25, 50, or null.`); return value; }
function assertWeightMatches(unit: "Bags" | "MT", weight: 25 | 50 | null, path: string): void { if ((unit === "Bags") !== (weight !== null)) throw new Error(`${path}.bagWeightKg does not match unit.`); }
function lineId(value: unknown, path: string): LineId { if (value !== "PM1" && value !== "PM2" && value !== "PM3" && value !== "PM4") throw new Error(`${path} is invalid.`); return value; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function newUuid(): string { return globalThis.crypto.randomUUID(); }
function message(error: unknown): string { return error instanceof Error ? error.message : "Planning draft validation failed."; }
function success<T>(value: T): PlanningDraftStorageResult<T> { return { ok: true, value }; }
function failure(code: PlanningDraftStorageFailureCode, error: string): PlanningDraftStorageResult<never> { return { ok: false, code, error }; }
