import {
  cancelJob,
  combinePendingJobs,
  copyJobBatch,
  createCatalogProduct,
  completeJob,
  confirmBin,
  createJob,
  moveJob,
  pauseJob,
  recordActualOutput,
  reportJobIssue,
  resolveJobIssue,
  resumeJob,
  startJob,
  setCatalogProductActive,
  updateCatalogProduct,
  updateJob,
  updateSettings,
} from "./engine";
import { validateSettingsUpdate, validateWorkspaceBackup } from "./backup";
import type { AppState, JobInput, LineId, Settings } from "./types";
import type { CreateJobFromSourceInput, CreateJobFromSourcesInput, PortableWorkspaceBackupV3, SourceImportInput } from "./sourceTypes";
import { parseInventoryCommand, type InventoryCommand, type PortableWorkspaceBackupV4 } from './inventoryTypes';

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
  | InventoryCommand
  | { type: "job.create"; input: JobInput }
  | { type: "job.update"; jobId: string; patch: Partial<JobInput> }
  | { type: "job.move"; jobId: string; toLineId: LineId; beforeJobId?: string }
  | { type: "job.start"; jobId: string }
  | { type: "job.createFromSource"; input: CreateJobFromSourceInput }
  | { type: "job.createFromSources"; input: CreateJobFromSourcesInput }
  | { type: "job.complete"; jobId: string; actualQuantityMt: number; completionNote?: string }
  | { type: "job.recordActual"; jobId: string; actualQuantityMt: number; completionNote?: string }
  | { type: "job.cancel"; jobId: string }
  | { type: "job.reportIssue"; jobId: string; reason: string }
  | { type: "job.resolveIssue"; jobId: string }
  | { type: "job.confirmBin"; jobId: string }
  | { type: "job.pause"; jobId: string; reason: string }
  | { type: "job.resume"; jobId: string }
  | { type: "job.copyBatch"; sourceDate: string; targetDate: string; items: CopyBatchItem[] }
  | { type: "job.combinePending"; jobIds: string[]; bin: string; remarks: string }
  | { type: "catalog.create"; input: CatalogCreateInput }
  | { type: "catalog.update"; productId: string; patch: CatalogUpdatePatch }
  | { type: "catalog.setActive"; productId: string; active: boolean }
  | { type: "settings.update"; settings: Settings }
  | { type: "settings.activateCalendar"; effectiveFrom: string; dayStart: string; availableHours: number }
  | { type: "data.import"; input: SourceImportInput }
  | { type: "data.setDeliveryStatus"; sourceOrderId: string; delivered: boolean; reason?: string }
  | { type: "workspace.restore"; backup: AppState | PortableWorkspaceBackupV3 | PortableWorkspaceBackupV4 }
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
  "inventoryItemId", "medication", "fmrOmed", "productionPurpose", "bagWeightKgSnapshot", "notBefore",
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
    case "job.start": return startJob(state, command.jobId, context.nowIso ?? new Date().toISOString());
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
    case "job.pause":
      return pauseJob(state, command.jobId, command.reason, context.nowIso ?? new Date().toISOString());
    case "job.resume":
      return resumeJob(state, command.jobId, context.nowIso ?? new Date().toISOString());
    case "job.copyBatch":
      return copyJobBatch(
        state,
        command.sourceDate,
        command.targetDate,
        command.items,
        context.nowIso ?? new Date().toISOString(),
      );
    case "job.combinePending":
      return combinePendingJobs(state, command.jobIds, command.bin, command.remarks, context.nowIso ?? new Date().toISOString());
    case "catalog.create":
      return createCatalogProduct(state, command.input, context.nowIso ?? new Date().toISOString());
    case "catalog.update":
      return updateCatalogProduct(state, command.productId, command.patch, context.nowIso ?? new Date().toISOString());
    case "catalog.setActive":
      return setCatalogProductActive(state, command.productId, command.active, context.nowIso ?? new Date().toISOString());
    case "settings.update": return updateSettings(state, command.settings, context.nowIso ?? new Date().toISOString());
    case "job.createFromSource":
    case "job.createFromSources":
    case "settings.activateCalendar":
    case "data.import":
    case "data.setDeliveryStatus":
    case "workspace.restore":
    case "workspace.resetDemo":
    case "workspace.undoLastMove":
      throw new Error(`${command.type} requires a trusted workspace provider.`);
    default: throw new Error(`${command.type} requires a trusted database workspace.`);
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
      exact(source, ["type", "jobId"], "command");
      return { type, jobId: id(source.jobId, "command.jobId") };
    case "job.createFromSource": {
      exact(source, ["type", "input"], "command");
      const input = object(source.input, "command.input");
      exact(input, ["sourceOrderId", "sourceOrderVersion", "date", "lineId", "bin", "remarks", "mode"], "command.input", true);
      const result: CreateJobFromSourceInput = {
        sourceOrderId: reference(input.sourceOrderId, "command.input.sourceOrderId"),
        sourceOrderVersion: integer(input.sourceOrderVersion, "command.input.sourceOrderVersion", 1),
        date: date(input.date, "command.input.date"),
        lineId: lineId(input.lineId, "command.input.lineId"),
        bin: string(input.bin, "command.input.bin", 200),
        remarks: string(input.remarks, "command.input.remarks", 1_000),
      };
      if (has(input, "mode")) result.mode = quantityMode(input.mode, "command.input.mode");
      return { type, input: result };
    }
    case "job.createFromSources": {
      exact(source, ["type", "input"], "command");
      const input = object(source.input, "command.input");
      exact(input, ["orders", "date", "lineId", "bin", "remarks"], "command.input");
      const orders = array(input.orders, "command.input.orders", 500).map((value, index) => {
        const row = object(value, `command.input.orders[${index}]`);
        exact(row, ["sourceOrderId", "sourceOrderVersion", "plannedQuantity"], `command.input.orders[${index}]`);
        return {
          sourceOrderId: reference(row.sourceOrderId, `command.input.orders[${index}].sourceOrderId`),
          sourceOrderVersion: integer(row.sourceOrderVersion, `command.input.orders[${index}].sourceOrderVersion`, 1),
          plannedQuantity: finite(row.plannedQuantity, `command.input.orders[${index}].plannedQuantity`, Number.EPSILON),
        };
      });
      if (!orders.length) throw new Error("command.input.orders must contain at least one order.");
      if (new Set(orders.map(order => order.sourceOrderId)).size !== orders.length) throw new Error("command.input.orders cannot contain duplicate source orders.");
      return { type, input: { orders, date: date(input.date, "command.input.date"), lineId: lineId(input.lineId, "command.input.lineId"), bin: string(input.bin, "command.input.bin", 200), remarks: string(input.remarks, "command.input.remarks", 1_000) } };
    }
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
    case "job.resume":
      exact(source, ["type", "jobId"], "command");
      return { type, jobId: id(source.jobId, "command.jobId") };
    case "job.reportIssue":
      exact(source, ["type", "jobId", "reason"], "command");
      return { type, jobId: id(source.jobId, "command.jobId"), reason: text(source.reason, "command.reason", 1_000) };
    case "job.pause":
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
    case "job.combinePending": {
      exact(source, ["type", "jobIds", "bin", "remarks"], "command");
      const jobIds = array(source.jobIds, "command.jobIds", 500).map((value, index) => id(value, `command.jobIds[${index}]`));
      if (jobIds.length < 2) throw new Error("command.jobIds must contain at least two cards.");
      if (new Set(jobIds).size !== jobIds.length) throw new Error("command.jobIds cannot contain duplicates.");
      return { type, jobIds, bin: string(source.bin, "command.bin", 200), remarks: string(source.remarks, "command.remarks", 1_000) };
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
      const settings = validateSettingsUpdate(source.settings);
      return { type, settings };
    }
    case "settings.activateCalendar":
      exact(source, ["type", "effectiveFrom", "dayStart", "availableHours"], "command");
      return {
        type,
        effectiveFrom: date(source.effectiveFrom, "command.effectiveFrom"),
        dayStart: clock(source.dayStart, "command.dayStart"),
        availableHours: finite(source.availableHours, "command.availableHours", 0),
      };
    case "data.import":
      exact(source, ["type", "input"], "command");
      return { type, input: sourceImportInput(source.input, "command.input") };
    case "data.setDeliveryStatus": {
      exact(source, ["type", "sourceOrderId", "delivered", "reason"], "command", true);
      const result: Extract<Command, { type: "data.setDeliveryStatus" }> = {
        type,
        sourceOrderId: reference(source.sourceOrderId, "command.sourceOrderId"),
        delivered: boolean(source.delivered, "command.delivered"),
      };
      if (has(source, "reason")) result.reason = text(source.reason, "command.reason", 1_000);
      if (!result.delivered && !result.reason) throw new Error("command.reason is required when reopening delivery.");
      return result;
    }
    case "workspace.restore":
      exact(source, ["type", "backup"], "command");
      if (plainPortableV3(source.backup)) return { type, backup: source.backup as unknown as PortableWorkspaceBackupV3 | PortableWorkspaceBackupV4 };
      return { type, backup: validateWorkspaceBackup(source.backup) };
    case "workspace.resetDemo":
      exact(source, ["type", "date"], "command");
      return { type, date: date(source.date, "command.date") };
    case "workspace.undoLastMove":
      exact(source, ["type"], "command");
      return { type };
    default:
      return parseInventoryCommand(value);
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
  if (!partial) for (const key of JOB_INPUT_KEYS.slice(0, 10)) if (!has(source, key)) throw new Error(`${path}.${key} is required.`);
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
  if (has(source, "inventoryItemId")) result.inventoryItemId = reference(source.inventoryItemId, `${path}.inventoryItemId`);
  if (has(source, "medication")) result.medication = string(source.medication, `${path}.medication`, 1_000);
  if (has(source, "fmrOmed")) result.fmrOmed = string(source.fmrOmed, `${path}.fmrOmed`, 1_000);
  if (has(source, "productionPurpose")) {
    if (source.productionPurpose !== 'mto' && source.productionPurpose !== 'mts') throw new Error(`${path}.productionPurpose must be mto or mts.`);
    result.productionPurpose = source.productionPurpose;
  }
  if (has(source, "bagWeightKgSnapshot")) {
    result.bagWeightKgSnapshot = finite(source.bagWeightKgSnapshot, `${path}.bagWeightKgSnapshot`, 0);
    if (result.bagWeightKgSnapshot <= 0) throw new Error('Bag weight must be positive.');
  }
  if (has(source, "notBefore")) result.notBefore = timestamp(source.notBefore, `${path}.notBefore`);
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

function sourceImportInput(value: unknown, path: string): SourceImportInput {
  const source = object(value, path);
  exact(source, ["fileName", "sheetName", "digest", "asOfDate", "rows"], path);
  const rows = array(source.rows, `${path}.rows`, 2_000).map((value, index) => {
    const rowPath = `${path}.rows[${index}]`;
    const row = object(value, rowPath);
    const keys = ["doNo", "deliveryDate", "soldToParty", "shipToParty", "materialCode", "description", "quantity", "unit", "deliveryLeadDays", "remark", "daysOutstanding", "medication", "fmrOmed"] as const;
    rejectUnknown(row, [...keys, 'goodsMovementStatus', 'sourceSheet', 'sourceRow'], rowPath);
    for (const key of keys) if (!has(row, key)) throw new Error(`${rowPath}.${key} is required.`);
    const nullableNumber = (value: unknown, field: string): number | null => value === null ? null : finiteSigned(value, field);
    return {
      ...(has(row, 'goodsMovementStatus') ? { goodsMovementStatus: string(row.goodsMovementStatus, `${rowPath}.goodsMovementStatus`, 100) } : {}),
      ...(has(row, 'sourceSheet') ? { sourceSheet: string(row.sourceSheet, `${rowPath}.sourceSheet`, 120) } : {}),
      ...(has(row, 'sourceRow') ? { sourceRow: integer(row.sourceRow, `${rowPath}.sourceRow`, 1) } : {}),
      doNo: trimmedText(row.doNo, `${rowPath}.doNo`, 120),
      deliveryDate: date(row.deliveryDate, `${rowPath}.deliveryDate`),
      soldToParty: string(row.soldToParty, `${rowPath}.soldToParty`, 1_000),
      shipToParty: string(row.shipToParty, `${rowPath}.shipToParty`, 1_000),
      materialCode: trimmedText(row.materialCode, `${rowPath}.materialCode`, 80),
      description: string(row.description, `${rowPath}.description`, 200),
      quantity: finite(row.quantity, `${rowPath}.quantity`, 0),
      unit: sourceUnit(row.unit, `${rowPath}.unit`),
      deliveryLeadDays: nullableNumber(row.deliveryLeadDays, `${rowPath}.deliveryLeadDays`),
      remark: string(row.remark, `${rowPath}.remark`, 1_000),
      daysOutstanding: nullableNumber(row.daysOutstanding, `${rowPath}.daysOutstanding`),
      medication: string(row.medication, `${rowPath}.medication`, 1_000),
      fmrOmed: string(row.fmrOmed, `${rowPath}.fmrOmed`, 1_000),
    };
  });
  if (!rows.length) throw new Error(`${path}.rows must contain at least one row.`);
  const keys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const key = `${row.doNo.toLocaleUpperCase("en-US")}\u0000${row.materialCode.toLocaleUpperCase("en-US")}`;
    if (keys.has(key)) throw new Error(`${path}.rows[${index}] duplicates a DO no and material code in this import.`);
    keys.add(key);
  }
  return {
    fileName: trimmedText(source.fileName, `${path}.fileName`, 255),
    sheetName: trimmedText(source.sheetName, `${path}.sheetName`, 120),
    digest: sha256(source.digest, `${path}.digest`),
    asOfDate: date(source.asOfDate, `${path}.asOfDate`),
    rows,
  };
}

function finite(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${path} must be a finite number ${min} or greater.`);
  return value;
}

function finiteSigned(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
  return value;
}

function integer(value: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${path} must be an integer ${min} or greater.`);
  return value as number;
}

function sourceUnit(value: unknown, path: string): "MT" | "Bags" {
  if (value !== "MT" && value !== "Bags") throw new Error(`${path} must be MT or Bags.`);
  return value;
}

function clock(value: unknown, path: string): string {
  const result = string(value, path, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error(`${path} must use HH:MM.`);
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = trimmedText(value, path, 64).toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${path} must be a SHA-256 hex digest.`);
  return result;
}

function plainPortableV3(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 3 && source.schemaVersion !== 4) return false;
  exact(source, source.schemaVersion === 4 ? ["schemaVersion", "exportedAt", "planning", "sourceData", "inventory"] : ["schemaVersion", "exportedAt", "planning", "sourceData"], "command.backup");
  return true;
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
