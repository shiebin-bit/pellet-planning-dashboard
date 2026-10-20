import {
  cancelJob,
  copyJobBatch,
  createCatalogProduct,
  completeJob,
  confirmBin,
  createJob,
  moveJob,
  recordActualOutput,
  reportJobIssue,
  resolveJobIssue,
  startJob,
  setCatalogProductActive,
  updateCatalogProduct,
  updateJob,
  updateSettings,
} from "./engine";
import { validateWorkspaceBackup } from "./backup";
import type { AppState, JobInput, LineId, Settings } from "./types";

export type CopyBatchQuantity =
  | { mode: "bags"; bagCount: number }
  | { mode: "bulk"; quantityMt: number };

export interface CopyBatchItem {
  sourceJobId: string;
  orderNo: string;
  quantity: CopyBatchQuantity;
}

export interface CatalogCreateInput {
  code: string;
  description: string;
  defaultMode: "bags" | "bulk";
}

export type CatalogUpdatePatch = Partial<CatalogCreateInput>;

export type Command =
  | { type: "job.create"; input: JobInput }
  | { type: "job.update"; jobId: string; patch: Partial<JobInput> }
  | { type: "job.move"; jobId: string; toLineId: LineId; beforeJobId?: string }
  | { type: "job.start"; jobId: string; actualStart: string }
  | { type: "job.complete"; jobId: string; actualQuantityMt: number; completionNote?: string }
  | { type: "job.recordActual"; jobId: string; actualQuantityMt: number; completionNote?: string }
  | { type: "job.cancel"; jobId: string }
  | { type: "job.reportIssue"; jobId: string; reason: string }
  | { type: "job.resolveIssue"; jobId: string }
  | { type: "job.confirmBin"; jobId: string }
  | { type: "job.copyBatch"; sourceDate: string; targetDate: string; items: CopyBatchItem[] }
  | { type: "catalog.create"; input: CatalogCreateInput }
  | { type: "catalog.update"; productId: string; patch: CatalogUpdatePatch }
  | { type: "catalog.setActive"; productId: string; active: boolean }
  | { type: "settings.update"; settings: Settings }
  | { type: "workspace.restore"; backup: AppState }
  | { type: "workspace.resetDemo"; date: string }
  | { type: "workspace.undoLastMove" };

export interface WorkspaceEnvelope {
  state: AppState;
  revision: number;
  isDemo: boolean;
  previousBackup: AppState | null;
  updatedAt: string;
  canUndo: boolean;
}

export interface CommandContext {
  nowIso?: string;
}

const JOB_INPUT_KEYS = [
  "date", "lineId", "orderNo", "productCode", "description", "bin",
  "mode", "bagCount", "quantityMt", "remarks",
] as const;

export function executeCommand(
  state: AppState,
  command: Command,
  context: CommandContext = {},
): AppState {
  switch (command.type) {
    case "job.create": return createJob(state, command.input);
    case "job.update": return updateJob(state, command.jobId, command.patch);
    case "job.move": return moveJob(state, command.jobId, command.toLineId, command.beforeJobId);
    case "job.start": return startJob(state, command.jobId, command.actualStart);
    case "job.complete":
      return completeJob(
        state,
        command.jobId,
        command.actualQuantityMt,
        command.completionNote,
        context.nowIso ?? new Date().toISOString(),
      );
    case "job.recordActual":
      return recordActualOutput(state, command.jobId, command.actualQuantityMt, command.completionNote);
    case "job.cancel": return cancelJob(state, command.jobId);
    case "job.reportIssue": return reportJobIssue(state, command.jobId, command.reason);
    case "job.resolveIssue": return resolveJobIssue(state, command.jobId);
    case "job.confirmBin": return confirmBin(state, command.jobId);
    case "job.copyBatch":
      return copyJobBatch(
        state,
        command.sourceDate,
        command.targetDate,
        command.items,
        context.nowIso ?? new Date().toISOString(),
      );
    case "catalog.create":
      return createCatalogProduct(state, command.input, context.nowIso ?? new Date().toISOString());
    case "catalog.update":
      return updateCatalogProduct(state, command.productId, command.patch, context.nowIso ?? new Date().toISOString());
    case "catalog.setActive":
      return setCatalogProductActive(state, command.productId, command.active, context.nowIso ?? new Date().toISOString());
    case "settings.update": return updateSettings(state, command.settings);
    case "workspace.restore":
    case "workspace.resetDemo":
    case "workspace.undoLastMove":
      throw new Error(`${command.type} requires a trusted workspace provider.`);
  }
}

export function parseCommand(value: unknown): Command {
  const source = object(value, "command");
  const type = text(source.type, "command.type", 80);
  switch (type) {
    case "job.create":
      exact(source, ["type", "input"], "command");
      return { type, input: jobInput(source.input, "command.input", false) as JobInput };
    case "job.update":
      exact(source, ["type", "jobId", "patch"], "command");
      return { type, jobId: id(source.jobId, "command.jobId"), patch: jobInput(source.patch, "command.patch", true) };
    case "job.move": {
      exact(source, ["type", "jobId", "toLineId", "beforeJobId"], "command", true);
      const result: Extract<Command, { type: "job.move" }> = {
        type,
        jobId: id(source.jobId, "command.jobId"),
        toLineId: lineId(source.toLineId, "command.toLineId"),
      };
      if (has(source, "beforeJobId")) result.beforeJobId = id(source.beforeJobId, "command.beforeJobId");
      return result;
    }
    case "job.start":
      exact(source, ["type", "jobId", "actualStart"], "command");
      return { type, jobId: id(source.jobId, "command.jobId"), actualStart: timestamp(source.actualStart, "command.actualStart") };
    case "job.complete":
    case "job.recordActual": {
      exact(source, ["type", "jobId", "actualQuantityMt", "completionNote"], "command", true);
      const result = {
        type,
        jobId: id(source.jobId, "command.jobId"),
        actualQuantityMt: finite(source.actualQuantityMt, "command.actualQuantityMt", 0),
      } as Extract<Command, { type: typeof type }>;
      if (has(source, "completionNote")) result.completionNote = string(source.completionNote, "command.completionNote", 1_000);
      return result;
    }
    case "job.cancel":
    case "job.resolveIssue":
    case "job.confirmBin":
      exact(source, ["type", "jobId"], "command");
      return { type, jobId: id(source.jobId, "command.jobId") };
    case "job.reportIssue":
      exact(source, ["type", "jobId", "reason"], "command");
      return { type, jobId: id(source.jobId, "command.jobId"), reason: text(source.reason, "command.reason", 1_000) };
    case "job.copyBatch": {
      exact(source, ["type", "sourceDate", "targetDate", "items"], "command");
      const items = array(source.items, "command.items", 500).map((item, index) =>
        copyBatchItem(item, `command.items[${index}]`),
      );
      if (items.length === 0) throw new Error("command.items must contain at least one item.");
      return {
        type,
        sourceDate: date(source.sourceDate, "command.sourceDate"),
        targetDate: date(source.targetDate, "command.targetDate"),
        items,
      };
    }
    case "catalog.create":
      exact(source, ["type", "input"], "command");
      return { type, input: catalogInput(source.input, "command.input", false) as CatalogCreateInput };
    case "catalog.update": {
      exact(source, ["type", "productId", "patch"], "command");
      const patch = catalogInput(source.patch, "command.patch", true);
      if (Object.keys(patch).length === 0) throw new Error("command.patch must contain at least one change.");
      return { type, productId: reference(source.productId, "command.productId"), patch };
    }
    case "catalog.setActive":
      exact(source, ["type", "productId", "active"], "command");
      return {
        type,
        productId: reference(source.productId, "command.productId"),
        active: boolean(source.active, "command.active"),
      };
    case "settings.update": {
      exact(source, ["type", "settings"], "command");
      const settings = validateWorkspaceBackup({ schemaVersion: 2, catalog: [], jobs: [], settings: source.settings, events: [] }).settings;
      return { type, settings };
    }
    case "workspace.restore":
      exact(source, ["type", "backup"], "command");
      return { type, backup: validateWorkspaceBackup(source.backup) };
    case "workspace.resetDemo":
      exact(source, ["type", "date"], "command");
      return { type, date: date(source.date, "command.date") };
    case "workspace.undoLastMove":
      exact(source, ["type"], "command");
      return { type };
    default:
      throw new Error("command.type is unsupported.");
  }
}

function catalogInput(value: unknown, path: string, partial: true): CatalogUpdatePatch;
function catalogInput(value: unknown, path: string, partial: false): CatalogCreateInput;
function catalogInput(value: unknown, path: string, partial: boolean): CatalogUpdatePatch {
  const source = object(value, path);
  const keys = ["code", "description", "defaultMode"] as const;
  rejectUnknown(source, keys, path);
  if (!partial) for (const key of keys) if (!has(source, key)) throw new Error(`${path}.${key} is required.`);
  const result: CatalogUpdatePatch = {};
  if (has(source, "code")) result.code = trimmedText(source.code, `${path}.code`, 80);
  if (has(source, "description")) result.description = trimmedText(source.description, `${path}.description`, 200);
  if (has(source, "defaultMode")) result.defaultMode = quantityMode(source.defaultMode, `${path}.defaultMode`);
  return result;
}

function copyBatchItem(value: unknown, path: string): CopyBatchItem {
  const source = object(value, path);
  exact(source, ["sourceJobId", "orderNo", "quantity"], path);
  const quantitySource = object(source.quantity, `${path}.quantity`);
  const mode = quantityMode(quantitySource.mode, `${path}.quantity.mode`);
  if (mode === "bags") {
    exact(quantitySource, ["mode", "bagCount"], `${path}.quantity`);
    return {
      sourceJobId: reference(source.sourceJobId, `${path}.sourceJobId`),
      orderNo: reference(source.orderNo, `${path}.orderNo`),
      quantity: { mode, bagCount: finite(quantitySource.bagCount, `${path}.quantity.bagCount`, 0) },
    };
  }
  exact(quantitySource, ["mode", "quantityMt"], `${path}.quantity`);
  return {
    sourceJobId: reference(source.sourceJobId, `${path}.sourceJobId`),
    orderNo: reference(source.orderNo, `${path}.orderNo`),
    quantity: { mode, quantityMt: finite(quantitySource.quantityMt, `${path}.quantity.quantityMt`, 0) },
  };
}

function jobInput(value: unknown, path: string, partial: true): Partial<JobInput>;
function jobInput(value: unknown, path: string, partial: false): JobInput;
function jobInput(value: unknown, path: string, partial: boolean): Partial<JobInput> {
  const source = object(value, path);
  rejectUnknown(source, JOB_INPUT_KEYS, path);
  if (!partial) for (const key of JOB_INPUT_KEYS) if (!has(source, key)) throw new Error(`${path}.${key} is required.`);
  const result: Partial<JobInput> = {};
  if (has(source, "date")) result.date = date(source.date, `${path}.date`);
  if (has(source, "lineId")) result.lineId = lineId(source.lineId, `${path}.lineId`);
  if (has(source, "orderNo")) result.orderNo = string(source.orderNo, `${path}.orderNo`, 10_000);
  if (has(source, "productCode")) result.productCode = string(source.productCode, `${path}.productCode`, 10_000);
  if (has(source, "description")) result.description = string(source.description, `${path}.description`, 10_000);
  if (has(source, "bin")) result.bin = string(source.bin, `${path}.bin`, 10_000);
  if (has(source, "mode")) {
    if (source.mode !== "bags" && source.mode !== "bulk") throw new Error(`${path}.mode must be bags or bulk.`);
    result.mode = source.mode;
  }
  if (has(source, "bagCount")) result.bagCount = source.bagCount === null ? null : finite(source.bagCount, `${path}.bagCount`, 0);
  if (has(source, "quantityMt")) result.quantityMt = finite(source.quantityMt, `${path}.quantityMt`, 0);
  if (has(source, "remarks")) result.remarks = string(source.remarks, `${path}.remarks`, 1_000);
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  if (value.length > max) throw new Error(`${path} must contain ${max} items or fewer.`);
  return value;
}

function exact(source: Record<string, unknown>, keys: readonly string[], path: string, optionalLast = false): void {
  rejectUnknown(source, keys, path);
  const required = optionalLast ? keys.slice(0, -1) : keys;
  for (const key of required) if (!has(source, key)) throw new Error(`${path}.${key} is required.`);
}

function rejectUnknown(source: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`);
}

function has(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${path} must be text.`);
  if (value.length > max) throw new Error(`${path} must be ${max} characters or fewer.`);
  return value;
}

function text(value: unknown, path: string, max: number): string {
  const result = string(value, path, max);
  if (!result.trim()) throw new Error(`${path} cannot be blank.`);
  return result;
}

function trimmedText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${path} must be text.`);
  const result = value.trim();
  if (!result) throw new Error(`${path} cannot be blank.`);
  if (result.length > max) throw new Error(`${path} must be ${max} characters or fewer.`);
  return result;
}

function id(value: unknown, path: string): string { return text(value, path, 200); }
function reference(value: unknown, path: string): string { return trimmedText(value, path, 120); }

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be true or false.`);
  return value;
}

function quantityMode(value: unknown, path: string): "bags" | "bulk" {
  if (value !== "bags" && value !== "bulk") throw new Error(`${path} must be bags or bulk.`);
  return value;
}

function finite(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${path} must be a finite number ${min} or greater.`);
  return value;
}

function lineId(value: unknown, path: string): LineId {
  if (value !== "PM1" && value !== "PM2" && value !== "PM3" && value !== "PM4") throw new Error(`${path} must be PM1, PM2, PM3, or PM4.`);
  return value;
}

function date(value: unknown, path: string): string {
  const result = string(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${path} must use YYYY-MM-DD.`);
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error(`${path} must be a valid calendar date.`);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path, 200);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !/(Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${path} must be an ISO date-time with a time-zone offset.`);
  }
  return result;
}
