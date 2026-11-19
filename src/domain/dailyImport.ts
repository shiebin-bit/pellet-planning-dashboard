import type { InventoryWorkbookItemInput, InventoryUnit } from './inventoryTypes';
import type { SourceImportInput, SourceOrderFields } from './sourceTypes';

export type PlanningControl = 'active' | 'hold' | 'cancel' | 'review';
export type PlanningControlAction = 'release' | 'hold' | 'cancel' | 'historicalDone' | 'historicalOut';

export interface StockReportInput {
  fileName: string;
  digest: string;
  sheetName: string;
  asOfDate: string;
  stockRows: InventoryWorkbookItemInput[];
}

/** @deprecated Dated reports are stock-only. Retained as a source-compatible alias. */
export type DailyReportInput = StockReportInput;

export interface DailyImportDifference {
  materialCode: string;
  unit: InventoryUnit;
  date: string;
  difference: number;
}

export interface DailyImportPreview {
  revision: number;
  reports: Array<{ asOfDate: string; fileName: string; sheetName: string; stockCount: number; bagCount: number; bulkCount: number }>;
  formulaDifferences: DailyImportDifference[];
  continuityDifferences: DailyImportDifference[];
  stockDifferences: DailyImportDifference[];
  requiresReconcile: boolean;
  warnings: string[];
}

export type DailyImportCommand =
  | { type: 'inventory.importStockReports'; reports: StockReportInput[]; reconcile: boolean; reason: string }
  | { type: 'inventory.importDailyReports'; reports: StockReportInput[]; reconcile: boolean; reason: string }
  | { type: 'data.importBatch'; inputs: SourceImportInput[] }
  | { type: 'data.setPlanningControl'; sourceOrderId: string; action: PlanningControlAction; reason: string; stockAccounted?: boolean };

export interface SourceOrderObservation {
  id: string;
  importId: string;
  sourceOrderId: string;
  asOfDate: string;
  sourceRow: number | null;
  rawStatus: string;
  effectiveStatus: 'pending' | 'done' | 'out';
  fields: SourceOrderFields;
  createdAt: string;
}

export interface PortableBaselineHistory {
  observations: SourceOrderObservation[];
  planningControls: Array<{ sourceOrderId: string; control: PlanningControl; reason: string | null; updatedAt: string }>;
  planningControlEvents: Array<{ id: string; sourceOrderId: string; action: string; beforeControl: PlanningControl; afterControl: PlanningControl; reason: string; occurredAt: string }>;
  sourceImports: Array<{ importId: string; importMode: 'sap-append' | 'dated-report'; dailySheetName: string | null }>;
  inventoryImports: Array<{ importId: string; importMode: 'legacy' | 'dated-report'; sheetName: string | null }>;
  reportDiagnostics: Array<{ importId: string; itemId: string; medication: string; fmrOmed: string; calculatedClosingScaled: number | null; formulaDifferenceScaled: number; continuityDifferenceScaled: number; reconciliationDifferenceScaled: number }>;
}

export function parseDailyImportCommand(value: unknown): DailyImportCommand {
  const root = object(value, 'command');
  const type = text(root.type, 'command.type', 80);
  if (type === 'inventory.importStockReports' || type === 'inventory.importDailyReports') {
    exact(root, ['type', 'reports', 'reconcile', 'reason'], 'command');
    if (!Array.isArray(root.reports) || !root.reports.length || root.reports.length > 31) throw new Error('command.reports must contain between 1 and 31 daily reports.');
    const reports = root.reports.map((entry, index) => stockReport(entry, `command.reports[${index}]`, type === 'inventory.importDailyReports'));
    if (new Set(reports.map(row => row.asOfDate)).size !== reports.length) throw new Error('command.reports must not repeat a date.');
    for (let index = 1; index < reports.length; index++) if (reports[index - 1].asOfDate >= reports[index].asOfDate) throw new Error('command.reports must be ordered by ascending date.');
    return { type, reports, reconcile: bool(root.reconcile, 'command.reconcile'), reason: string(root.reason, 'command.reason', 1_000).trim() };
  }
  if (type === 'data.importBatch') {
    exact(root, ['type', 'inputs'], 'command');
    if (!Array.isArray(root.inputs) || !root.inputs.length || root.inputs.length > 10) throw new Error('command.inputs must contain between 1 and 10 imports.');
    return { type, inputs: root.inputs.map((entry, index) => sourceImport(entry, `command.inputs[${index}]`)) };
  }
  if (type === 'data.setPlanningControl') {
    const allowed = ['type', 'sourceOrderId', 'action', 'reason', 'stockAccounted'];
    rejectUnknown(root, allowed, 'command');
    for (const key of ['type', 'sourceOrderId', 'action', 'reason']) if (!(key in root)) throw new Error(`command.${key} is required.`);
    const action = root.action;
    if (!['release', 'hold', 'cancel', 'historicalDone', 'historicalOut'].includes(String(action))) throw new Error('command.action is invalid.');
    if (root.stockAccounted !== undefined && typeof root.stockAccounted !== 'boolean') throw new Error('command.stockAccounted must be boolean.');
    return { type, sourceOrderId: trimmed(root.sourceOrderId, 'command.sourceOrderId', 200), action: action as PlanningControlAction,
      reason: trimmed(root.reason, 'command.reason', 1_000), ...(root.stockAccounted === undefined ? {} : { stockAccounted: root.stockAccounted }) };
  }
  throw new Error(`Unsupported daily import command ${type}.`);
}

export function parseDailyPreviewRequest(value: unknown): { reports: StockReportInput[] } {
  const root = object(value, 'request'); exact(root, ['reports'], 'request');
  if (!Array.isArray(root.reports) || !root.reports.length || root.reports.length > 31) throw new Error('request.reports must contain between 1 and 31 daily reports.');
  const reports = root.reports.map((entry, index) => stockReport(entry, `request.reports[${index}]`, true));
  if (new Set(reports.map(row => row.asOfDate)).size !== reports.length) throw new Error('request.reports must not repeat a date.');
  return { reports };
}

function stockReport(value: unknown, path: string, acceptLegacyEmptyOrders: boolean): StockReportInput {
  const root = object(value, path);
  rejectUnknown(root, ['fileName', 'digest', 'sheetName', 'asOfDate', 'stockRows', ...(acceptLegacyEmptyOrders ? ['orderRows'] : [])], path);
  for (const key of ['fileName', 'digest', 'sheetName', 'asOfDate', 'stockRows']) if (!(key in root)) throw new Error(`${path}.${key} is required.`);
  if (!Array.isArray(root.stockRows) || !root.stockRows.length || root.stockRows.length > 1_000) throw new Error(`${path}.stockRows is invalid.`);
  if ('orderRows' in root && (!Array.isArray(root.orderRows) || root.orderRows.length)) throw new Error(`${path}.orderRows is no longer supported. Baseline import reads stock only.`);
  const stockRows = root.stockRows.map((row, index) => stockRow(row, `${path}.stockRows[${index}]`));
  unique(stockRows.map(row => `${row.materialCode.toLowerCase()}\0${row.medication.trim().toLowerCase()}\0${row.fmrOmed.trim().toLowerCase()}`), `${path} stock bucket`);
  return { fileName: trimmed(root.fileName, `${path}.fileName`, 255), digest: sha256(root.digest, `${path}.digest`),
    sheetName: trimmed(root.sheetName, `${path}.sheetName`, 255), asOfDate: date(root.asOfDate, `${path}.asOfDate`), stockRows };
}

function sourceImport(value: unknown, path: string): SourceImportInput {
  const root = object(value, path); exact(root, ['fileName', 'sheetName', 'digest', 'asOfDate', 'rows'], path);
  if (!Array.isArray(root.rows) || !root.rows.length || root.rows.length > 10_000) throw new Error(`${path}.rows is invalid.`);
  const rows = root.rows.map((row, index) => sourceFields(row, `${path}.rows[${index}]`));
  unique(rows.map(row => `${row.doNo.toLowerCase()}\0${row.materialCode.toLowerCase()}`), `${path} order identity`);
  return { fileName: trimmed(root.fileName, `${path}.fileName`, 255), sheetName: trimmed(root.sheetName, `${path}.sheetName`, 255),
    digest: sha256(root.digest, `${path}.digest`), asOfDate: date(root.asOfDate, `${path}.asOfDate`), rows };
}

function sourceFields(value: unknown, path: string): SourceOrderFields {
  const root = object(value, path);
  const keys = ['doNo','deliveryDate','soldToParty','shipToParty','materialCode','description','quantity','unit','deliveryLeadDays','remark','daysOutstanding','medication','fmrOmed'];
  rejectUnknown(root, [...keys, 'goodsMovementStatus','sourceSheet','sourceRow'], path);
  for (const key of keys) if (!(key in root)) throw new Error(`${path}.${key} is required.`);
  const unit = root.unit; if (unit !== 'Bags' && unit !== 'MT') throw new Error(`${path}.unit is invalid.`);
  const quantity = nonnegative(root.quantity, `${path}.quantity`); if (unit === 'Bags' && !Number.isInteger(quantity)) throw new Error(`${path}.quantity must be whole Bags.`);
  const result: SourceOrderFields = { doNo: trimmed(root.doNo, `${path}.doNo`, 120), deliveryDate: date(root.deliveryDate, `${path}.deliveryDate`),
    soldToParty: string(root.soldToParty, `${path}.soldToParty`, 500), shipToParty: string(root.shipToParty, `${path}.shipToParty`, 500),
    materialCode: trimmed(root.materialCode, `${path}.materialCode`, 120), description: string(root.description, `${path}.description`, 1_000), quantity, unit,
    deliveryLeadDays: nullableInteger(root.deliveryLeadDays, `${path}.deliveryLeadDays`), remark: string(root.remark, `${path}.remark`, 500),
    daysOutstanding: nullableInteger(root.daysOutstanding, `${path}.daysOutstanding`), medication: string(root.medication, `${path}.medication`, 200), fmrOmed: string(root.fmrOmed, `${path}.fmrOmed`, 200) };
  if (root.goodsMovementStatus !== undefined) result.goodsMovementStatus = string(root.goodsMovementStatus, `${path}.goodsMovementStatus`, 200);
  if (root.sourceSheet !== undefined) result.sourceSheet = string(root.sourceSheet, `${path}.sourceSheet`, 255);
  if (root.sourceRow !== undefined) result.sourceRow = integer(root.sourceRow, `${path}.sourceRow`, 1);
  return result;
}

function stockRow(value: unknown, path: string): InventoryWorkbookItemInput {
  const root = object(value, path); const keys = ['materialCode','description','unit','bagWeightKg','strategy','targetQuantity','needsReview','opening','production','received','salesReturn','rework','issue','closing','medication','fmrOmed']; exact(root, keys, path);
  const unit = root.unit; if (unit !== 'Bags' && unit !== 'MT') throw new Error(`${path}.unit is invalid.`);
  const bagWeightKg = root.bagWeightKg; if (unit === 'Bags' && bagWeightKg !== 25 && bagWeightKg !== 50) throw new Error(`${path}.bagWeightKg is invalid.`); if (unit === 'MT' && bagWeightKg !== null) throw new Error(`${path}.bagWeightKg must be null for bulk.`);
  if (root.strategy !== 'mto' && root.strategy !== 'mts') throw new Error(`${path}.strategy is invalid.`);
  const numeric = (name: string) => { const value = nonnegative(root[name], `${path}.${name}`); if (unit === 'Bags' && !Number.isInteger(value)) throw new Error(`${path}.${name} must be whole Bags.`); return value; };
  return { materialCode: trimmed(root.materialCode, `${path}.materialCode`, 120), description: string(root.description, `${path}.description`, 1_000), unit, bagWeightKg: bagWeightKg as 25|50|null, strategy: root.strategy,
    targetQuantity: numeric('targetQuantity'), needsReview: bool(root.needsReview, `${path}.needsReview`), opening: numeric('opening'), production: numeric('production'), received: numeric('received'), salesReturn: numeric('salesReturn'), rework: numeric('rework'), issue: numeric('issue'), closing: numeric('closing'), medication: string(root.medication, `${path}.medication`, 200), fmrOmed: string(root.fmrOmed, `${path}.fmrOmed`, 200) };
}

function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[], path: string) { rejectUnknown(value, keys, path); for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key} is required.`); }
function rejectUnknown(value: Record<string, unknown>, keys: string[], path: string) { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${path}.${key} is not supported.`); }
function string(value: unknown, path: string, max: number) { if (typeof value !== 'string' || value.length > max) throw new Error(`${path} must be text of ${max} characters or fewer.`); return value; }
function trimmed(value: unknown, path: string, max: number) { const result = string(value, path, max).trim(); if (!result) throw new Error(`${path} is required.`); return result; }
function text(value: unknown, path: string, max: number) { return trimmed(value, path, max); }
function bool(value: unknown, path: string) { if (typeof value !== 'boolean') throw new Error(`${path} must be boolean.`); return value; }
function nonnegative(value: unknown, path: string) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a nonnegative number.`); return value; }
function integer(value: unknown, path: string, min: number) { if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${path} must be an integer of at least ${min}.`); return value as number; }
function nullableInteger(value: unknown, path: string) { return value === null ? null : integer(value, path, -100_000); }
function date(value: unknown, path: string) { const result = trimmed(value, path, 10); const parsed=new Date(result+'T00:00:00Z'); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==result) throw new Error(`${path} must be a valid YYYY-MM-DD date.`); return result; }
function sha256(value: unknown, path: string) { const result = trimmed(value, path, 64); if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error(`${path} must be a SHA-256 digest.`); return result.toLowerCase(); }
function unique(values: string[], path: string) { if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicates.`); }
