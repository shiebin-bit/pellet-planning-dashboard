import type { SourceImportInput } from "./sourceTypes";
import type { PortableSourceData } from "./sourceTypes";
import type { AppState } from "./types";
import type { LineId } from "./types";

export type InventoryUnit = "Bags" | "MT";
export type InventoryStrategy = "mto" | "mts";
export type InventoryHistoricalStatus = "pending" | "done" | "out";
export type InventoryMovementType =
  | "baseline"
  | "production"
  | "received"
  | "return"
  | "rework"
  | "dispatch"
  | "adjustment"
  | "reversal";

export interface InventoryBucketKey {
  medication: string;
  fmrOmed: string;
}

export interface InventoryWorkbookItemInput extends InventoryBucketKey {
  /** Exact material code. The server resolves this to the stable catalog/inventory id. */
  materialCode: string;
  description: string;
  unit: InventoryUnit;
  bagWeightKg: 25 | 50 | null;
  strategy: InventoryStrategy;
  targetQuantity: number;
  needsReview: boolean;
  opening: number;
  production: number;
  received: number;
  salesReturn: number;
  rework: number;
  issue: number;
  closing: number;
}

export interface InventoryOrderAnnotationInput extends InventoryBucketKey {
  doNo: string;
  materialCode: string;
  remark: string;
}

/** Common normalized result of the 18th/later workbook adapter. */
export interface InventoryWorkbookInput {
  fileName: string;
  digest: string;
  asOfDate: string;
  orders: SourceImportInput[];
  items: InventoryWorkbookItemInput[];
  annotations: InventoryOrderAnnotationInput[];
  packingBinTotal: number | null;
  /** False for later SAP imports: order data changes, physical stock never does. */
  includeBaseline: boolean;
  /** A confirmed later physical count creates differences, never replaces the ledger. */
  reconcileStock?: boolean;
}

export type InventoryExtra =
  | { type: "fixed"; quantity: number }
  | { type: "percent"; percent: number };

export interface InventoryItemConfiguration {
  itemId: string;
  materialCode: string;
  description: string;
  unit: InventoryUnit;
  bagWeightKg: 25 | 50 | null;
  strategy: InventoryStrategy | null;
  targetQuantity: number | null;
  defaultExtra: InventoryExtra | null;
  needsReview: boolean;
}

export interface InventoryManualFieldsPatch extends Partial<InventoryBucketKey> {
  dueDate?: string;
}

export interface InventoryDraftRequest {
  fromDate: string;
  toDate: string;
  demandThrough?: string;
  sourceOrderIds?: string[];
  /** Combine compatible orders with the same due date into one physical production batch. */
  combineSameProduct?: boolean;
}

/** Quantity demand passed to the pure inventory planner. Quantities use the row unit. */
export interface InventoryPlanningDemandRow extends InventoryBucketKey {
  key: string;
  itemId: string;
  materialCode: string;
  description: string;
  unit: InventoryUnit;
  bagWeightKg: 25 | 50 | null;
  strategy: InventoryStrategy;
  purpose: InventoryStrategy;
  sourceOrderId: string | null;
  orderNo: string | null;
  dueDate: string;
  /** ISO timestamp; the planner must not place work before this instant. */
  notBefore: string;
  /** Portion of quantity assigned to the source order. Any remainder is deliberate stock output. */
  sourceAllocationQuantity?: number;
  quantity: number;
}

export interface InventoryDraftJob extends InventoryBucketKey {
  draftId: string;
  itemId: string;
  sourceOrderId: string | null;
  sourceAllocations?: Array<{ sourceOrderId: string; plannedQuantity: number }>;
  orderNo: string;
  materialCode: string;
  description: string;
  unit: InventoryUnit;
  bagWeightKg: 25 | 50 | null;
  productionPurpose: InventoryStrategy;
  date: string;
  lineId: LineId;
  quantity: number;
  notBefore: string;
  bin: string;
  remarks: string;
}

export interface InventoryDraftPreview {
  revision: number;
  generatedAt: string;
  request: InventoryDraftRequest;
  demand: InventoryPlanningDemandRow[];
  jobs: InventoryDraftJob[];
  backlog: InventoryPlanningDemandRow[];
  utilization: Array<{ date: string; lineId: LineId; hours: number; availableHours: number }>;
  late: Array<{ key: string; dueDate: string; plannedDate: string | null; quantity: number }>;
}

export type InventoryCommand =
  | { type: "inventory.importBaseline"; input: InventoryWorkbookInput }
  | { type: "inventory.importWorkbook"; input: InventoryWorkbookInput }
  | ({ type: "inventory.adjust"; itemId: string; quantityDelta: number; countedQuantity?: number; reason: string; postingKey: string; occurredOn?: string } & InventoryBucketKey)
  | ({ type: "inventory.receive"; itemId: string; quantity: number; movementType?: "received" | "return" | "rework"; postingKey: string; note?: string; occurredOn?: string } & InventoryBucketKey)
  | { type: "inventory.configure"; itemId: string; patch: Partial<Pick<InventoryItemConfiguration, "bagWeightKg" | "strategy" | "targetQuantity" | "defaultExtra" | "needsReview">> }
  | { type: "production.recordReceipt"; jobId: string; totalActualQuantity: number; occurredOn?: string }
  | { type: "production.correct"; movementId: string; correctedTotalQuantity: number; reason: string; postingKey: string; occurredOn?: string }
  | { type: "production.correctJobTotal"; jobId: string; correctedTotalQuantity: number; reason: string; postingKey: string; occurredOn?: string }
  | { type: "delivery.record"; sourceOrderId: string; quantity: number; postingKey: string; occurredOn?: string }
  | { type: "delivery.reverse"; movementId: string; quantity: number; reason: string; postingKey: string; occurredOn?: string }
  | { type: "planning.commitDraft"; previewRevision: number; jobs: InventoryDraftJob[] }
  | { type: "data.updateManualFields"; sourceOrderId: string; patch: InventoryManualFieldsPatch };

export interface InventoryBucketSnapshot extends InventoryBucketKey {
  onHand: number;
  reserved: number;
  available: number;
}

export interface InventoryItemSnapshot extends InventoryItemConfiguration {
  buckets: InventoryBucketSnapshot[];
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
}

export interface InventorySnapshot {
  revision: number;
  asOfDate: string;
  baselineDate: string | null;
  lastCountDate: string | null;
  items: InventoryItemSnapshot[];
}

export interface InventoryOrderProgress extends InventoryBucketKey {
  sourceOrderId: string;
  itemId: string;
  doNo: string;
  materialCode: string;
  description: string;
  dueDate: string;
  unit: InventoryUnit;
  ordered: number;
  produced: number;
  delivered: number;
  reserved: number;
  orderNeed: number;
  scheduledUnreceived: number;
  netToPlan: number;
  historicalStatus: InventoryHistoricalStatus;
  needsReview: boolean;
}

export interface InventoryOrderProgressSnapshot {
  revision: number;
  asOfDate: string;
  orders: InventoryOrderProgress[];
}

export interface InventoryLedgerEntry extends InventoryBucketKey {
  id: string;
  itemId: string;
  movementType: InventoryMovementType;
  quantityDelta: number;
  unit: InventoryUnit;
  occurredOn: string;
  recordedAt: string;
  sourceOrderId: string | null;
  jobId: string | null;
  reversesMovementId: string | null;
  note: string | null;
}

export interface InventoryDailyStockRow extends InventoryBucketKey {
  date: string;
  itemId: string;
  materialCode: string;
  unit: InventoryUnit;
  opening: number;
  production: number;
  received: number;
  salesReturn: number;
  rework: number;
  dispatch: number;
  adjustment: number;
  closing: number;
}

export interface InventoryOrderJournalRow {
  sourceOrderId: string;
  doNo: string;
  materialCode: string;
  eventType: "reserved" | "production" | "production-corrected" | "delivery" | "delivery-reversed" | "manual-fields";
  quantity: number;
  unit: InventoryUnit;
  occurredOn: string;
  referenceId: string;
  note: string | null;
}

export interface PortableInventoryData {
  items: Array<{
    id: string; catalogId: string | null; materialCode: string; description: string; unit: InventoryUnit;
    bagWeightKg: 25 | 50 | null; strategy: InventoryStrategy | null; targetQuantityScaled: number | null;
    extraType: "fixed" | "percent" | null; extraValueScaled: number | null; needsReview: boolean;
    createdAt: string; updatedAt: string;
  }>;
  imports: Array<{
    id: string; fileName: string; digest: string; semanticDigest: string; asOfDate: string;
    includedBaseline: boolean; packingBinTotalScaled: number | null; importedAt: string;
  }>;
  baselineReports: Array<{
    importId: string; itemId: string; medication: string; fmrOmed: string;
    openingScaled: number; productionScaled: number; receivedScaled: number; salesReturnScaled: number;
    reworkScaled: number; issueScaled: number; closingScaled: number;
  }>;
  orders: Array<{
    sourceOrderId: string; itemId: string; dueDate: string; orderedQuantityScaled: number;
    medication: string; fmrOmed: string; historicalStatus: InventoryHistoricalStatus;
    manualMedication: boolean; manualFmrOmed: boolean; manualDueDate: boolean; needsReview: boolean;
    createdAt: string; updatedAt: string;
  }>;
  ledger: Array<{
    id: string; itemId: string; medication: string; fmrOmed: string; movementType: InventoryMovementType;
    quantityDeltaScaled: number; occurredOn: string; recordedAt: string; postingKey: string;
    sourceOrderId: string | null; jobId: string | null; reversesMovementId: string | null;
    importId: string | null; note: string | null; metadata: Record<string, unknown>;
  }>;
  reservations: Array<{
    sourceOrderId: string; itemId: string; medication: string; fmrOmed: string;
    quantityScaled: number; updatedAt: string;
  }>;
}

export interface PortableWorkspaceBackupV4 {
  schemaVersion: 4;
  exportedAt: string;
  planning: AppState;
  sourceData: PortableSourceData;
  inventory: PortableInventoryData;
}

export function parseInventoryCommand(value: unknown): InventoryCommand {
  const source = object(value, "command");
  const type = text(source.type, "command.type", 80);
  switch (type) {
    case "inventory.importBaseline":
    case "inventory.importWorkbook":
      exact(source, ["type", "input"], "command");
      return { type, input: workbook(source.input, "command.input") };
    case "inventory.adjust": {
      exactOptional(source, ["type", "itemId", "medication", "fmrOmed", "quantityDelta", "reason", "postingKey"], ["occurredOn", "countedQuantity"], "command");
      const quantityDelta = finite(source.quantityDelta, "command.quantityDelta");
      if (quantityDelta === 0) throw new Error("command.quantityDelta cannot be zero.");
      return withOccurredOn({ type, itemId: reference(source.itemId, "command.itemId"), ...bucket(source, "command"), quantityDelta, ...(source.countedQuantity===undefined?{}:{countedQuantity:nonnegative(source.countedQuantity,"command.countedQuantity")}), reason: trimmed(source.reason, "command.reason", 1_000), postingKey: reference(source.postingKey, "command.postingKey") }, source);
    }
    case "inventory.receive": {
      exactOptional(source, ["type", "itemId", "medication", "fmrOmed", "quantity", "postingKey"], ["movementType", "note", "occurredOn"], "command");
      const result = withOccurredOn({ type, itemId: reference(source.itemId, "command.itemId"), ...bucket(source, "command"), quantity: positive(source.quantity, "command.quantity"), postingKey: reference(source.postingKey, "command.postingKey") } as Extract<InventoryCommand, { type: "inventory.receive" }>, source);
      if (has(source, "movementType")) {
        if (source.movementType !== "received" && source.movementType !== "return" && source.movementType !== "rework") throw new Error("command.movementType must be received, return, or rework.");
        result.movementType = source.movementType;
      }
      if (has(source, "note")) result.note = string(source.note, "command.note", 1_000);
      return result;
    }
    case "inventory.configure": {
      exact(source, ["type", "itemId", "patch"], "command");
      const patchSource = object(source.patch, "command.patch");
      rejectUnknown(patchSource, ["bagWeightKg", "strategy", "targetQuantity", "defaultExtra", "needsReview"], "command.patch");
      if (!Object.keys(patchSource).length) throw new Error("command.patch must contain at least one change.");
      const patch: Extract<InventoryCommand, { type: "inventory.configure" }>["patch"] = {};
      if (has(patchSource, "bagWeightKg")) patch.bagWeightKg = bagWeight(patchSource.bagWeightKg, "command.patch.bagWeightKg");
      if (has(patchSource, "strategy")) patch.strategy = nullableStrategy(patchSource.strategy, "command.patch.strategy");
      if (has(patchSource, "targetQuantity")) patch.targetQuantity = patchSource.targetQuantity === null ? null : nonnegative(patchSource.targetQuantity, "command.patch.targetQuantity");
      if (has(patchSource, "defaultExtra")) patch.defaultExtra = extra(patchSource.defaultExtra, "command.patch.defaultExtra");
      if (has(patchSource, "needsReview")) patch.needsReview = bool(patchSource.needsReview, "command.patch.needsReview");
      return { type, itemId: reference(source.itemId, "command.itemId"), patch };
    }
    case "production.recordReceipt":
      exactOptional(source, ["type", "jobId", "totalActualQuantity"], ["occurredOn"], "command");
      return withOccurredOn({ type, jobId: reference(source.jobId, "command.jobId"), totalActualQuantity: nonnegative(source.totalActualQuantity, "command.totalActualQuantity") }, source);
    case "production.correct":
      exactOptional(source, ["type", "movementId", "correctedTotalQuantity", "reason", "postingKey"], ["occurredOn"], "command");
      return withOccurredOn({ type, movementId: reference(source.movementId, "command.movementId"), correctedTotalQuantity: nonnegative(source.correctedTotalQuantity, "command.correctedTotalQuantity"), reason: trimmed(source.reason, "command.reason", 1_000), postingKey: reference(source.postingKey, "command.postingKey") }, source);
    case "production.correctJobTotal":
      exactOptional(source, ["type", "jobId", "correctedTotalQuantity", "reason", "postingKey"], ["occurredOn"], "command");
      return withOccurredOn({ type, jobId: reference(source.jobId, "command.jobId"), correctedTotalQuantity: nonnegative(source.correctedTotalQuantity, "command.correctedTotalQuantity"), reason: trimmed(source.reason, "command.reason", 1_000), postingKey: reference(source.postingKey, "command.postingKey") }, source);
    case "delivery.record":
      exactOptional(source, ["type", "sourceOrderId", "quantity", "postingKey"], ["occurredOn"], "command");
      return withOccurredOn({ type, sourceOrderId: reference(source.sourceOrderId, "command.sourceOrderId"), quantity: positive(source.quantity, "command.quantity"), postingKey: reference(source.postingKey, "command.postingKey") }, source);
    case "delivery.reverse":
      exactOptional(source, ["type", "movementId", "quantity", "reason", "postingKey"], ["occurredOn"], "command");
      return withOccurredOn({ type, movementId: reference(source.movementId, "command.movementId"), quantity: positive(source.quantity, "command.quantity"), reason: trimmed(source.reason, "command.reason", 1_000), postingKey: reference(source.postingKey, "command.postingKey") }, source);
    case "planning.commitDraft": {
      exact(source, ["type", "previewRevision", "jobs"], "command");
      const jobs = array(source.jobs, "command.jobs", 2_000).map((row, index) => draftJob(row, `command.jobs[${index}]`));
      if (!jobs.length) throw new Error("command.jobs must contain at least one job.");
      return { type, previewRevision: integer(source.previewRevision, "command.previewRevision", 0), jobs };
    }
    case "data.updateManualFields": {
      exact(source, ["type", "sourceOrderId", "patch"], "command");
      const patchSource = object(source.patch, "command.patch");
      rejectUnknown(patchSource, ["medication", "fmrOmed", "dueDate"], "command.patch");
      if (!Object.keys(patchSource).length) throw new Error("command.patch must contain at least one change.");
      const patch: InventoryManualFieldsPatch = {};
      if (has(patchSource, "medication")) patch.medication = normalizedBucketText(patchSource.medication, "command.patch.medication");
      if (has(patchSource, "fmrOmed")) patch.fmrOmed = normalizedBucketText(patchSource.fmrOmed, "command.patch.fmrOmed");
      if (has(patchSource, "dueDate")) patch.dueDate = date(patchSource.dueDate, "command.patch.dueDate");
      return { type, sourceOrderId: reference(source.sourceOrderId, "command.sourceOrderId"), patch };
    }
    default:
      throw new Error("command.type is unsupported.");
  }
}

function workbook(value: unknown, path: string): InventoryWorkbookInput {
  const source = object(value, path);
  exactOptional(source, ["fileName", "digest", "asOfDate", "orders", "items", "annotations", "packingBinTotal", "includeBaseline"], ["reconcileStock"], path);
  const items = array(source.items, `${path}.items`, 1_000).map((value, index) => workbookItem(value, `${path}.items[${index}]`));
  const materialCodes = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = item.materialCode.toLocaleUpperCase("en-US");
    if (materialCodes.has(key)) throw new Error(`${path}.items[${index}] duplicates a material code.`);
    materialCodes.add(key);
  }
  return {
    fileName: trimmed(source.fileName, `${path}.fileName`, 255),
    digest: sha256(source.digest, `${path}.digest`),
    asOfDate: date(source.asOfDate, `${path}.asOfDate`),
    orders: array(source.orders, `${path}.orders`, 20).map((value, index) => sourceImport(value, `${path}.orders[${index}]`)),
    items,
    annotations: array(source.annotations, `${path}.annotations`, 10_000).map((value, index) => annotation(value, `${path}.annotations[${index}]`)),
    packingBinTotal: source.packingBinTotal === null ? null : nonnegative(source.packingBinTotal, `${path}.packingBinTotal`),
    includeBaseline: bool(source.includeBaseline, `${path}.includeBaseline`),
    ...(source.reconcileStock === undefined ? {} : { reconcileStock: bool(source.reconcileStock, `${path}.reconcileStock`) }),
  };
}

function workbookItem(value: unknown, path: string): InventoryWorkbookItemInput {
  const source = object(value, path);
  exact(source, ["materialCode", "description", "unit", "bagWeightKg", "strategy", "targetQuantity", "needsReview", "opening", "production", "received", "salesReturn", "rework", "issue", "closing", "medication", "fmrOmed"], path);
  const unit = inventoryUnit(source.unit, `${path}.unit`);
  const parsedBagWeight = bagWeight(source.bagWeightKg, `${path}.bagWeightKg`);
  if (unit === "Bags" && parsedBagWeight === null) throw new Error(`${path}.bagWeightKg is required for bag items.`);
  if (unit === "MT" && parsedBagWeight !== null) throw new Error(`${path}.bagWeightKg must be null for bulk items.`);
  return { materialCode: trimmed(source.materialCode, `${path}.materialCode`, 120), description: string(source.description, `${path}.description`, 200), unit, bagWeightKg: parsedBagWeight, strategy: strategy(source.strategy, `${path}.strategy`), targetQuantity: nonnegative(source.targetQuantity, `${path}.targetQuantity`), needsReview: bool(source.needsReview, `${path}.needsReview`), opening: nonnegative(source.opening, `${path}.opening`), production: nonnegative(source.production, `${path}.production`), received: nonnegative(source.received, `${path}.received`), salesReturn: nonnegative(source.salesReturn, `${path}.salesReturn`), rework: nonnegative(source.rework, `${path}.rework`), issue: nonnegative(source.issue, `${path}.issue`), closing: nonnegative(source.closing, `${path}.closing`), ...bucket(source, path) };
}

function annotation(value: unknown, path: string): InventoryOrderAnnotationInput {
  const source = object(value, path);
  exact(source, ["doNo", "materialCode", "remark", "medication", "fmrOmed"], path);
  return { doNo: trimmed(source.doNo, `${path}.doNo`, 120), materialCode: trimmed(source.materialCode, `${path}.materialCode`, 120), remark: string(source.remark, `${path}.remark`, 1_000), ...bucket(source, path) };
}

function sourceImport(value: unknown, path: string): SourceImportInput {
  const source = object(value, path);
  exact(source, ["fileName", "sheetName", "digest", "asOfDate", "rows"], path);
  return { fileName: trimmed(source.fileName, `${path}.fileName`, 255), sheetName: trimmed(source.sheetName, `${path}.sheetName`, 120), digest: sha256(source.digest, `${path}.digest`), asOfDate: date(source.asOfDate, `${path}.asOfDate`), rows: array(source.rows, `${path}.rows`, 5_000).map((value, index) => {
    const rowPath = `${path}.rows[${index}]`; const row = object(value, rowPath);
    const required = ["doNo", "deliveryDate", "soldToParty", "shipToParty", "materialCode", "description", "quantity", "unit", "deliveryLeadDays", "remark", "daysOutstanding", "medication", "fmrOmed"] as const;
    rejectUnknown(row, [...required, "goodsMovementStatus", "sourceSheet", "sourceRow"], rowPath);
    for (const key of required) if (!has(row, key)) throw new Error(`${rowPath}.${key} is required.`);
    return { ...(has(row, "goodsMovementStatus") ? { goodsMovementStatus: string(row.goodsMovementStatus, `${rowPath}.goodsMovementStatus`, 100) } : {}), ...(has(row, "sourceSheet") ? { sourceSheet: string(row.sourceSheet, `${rowPath}.sourceSheet`, 120) } : {}), ...(has(row, "sourceRow") ? { sourceRow: integer(row.sourceRow, `${rowPath}.sourceRow`, 1) } : {}), doNo: trimmed(row.doNo, `${rowPath}.doNo`, 120), deliveryDate: date(row.deliveryDate, `${rowPath}.deliveryDate`), soldToParty: string(row.soldToParty, `${rowPath}.soldToParty`, 1_000), shipToParty: string(row.shipToParty, `${rowPath}.shipToParty`, 1_000), materialCode: trimmed(row.materialCode, `${rowPath}.materialCode`, 120), description: string(row.description, `${rowPath}.description`, 200), quantity: nonnegative(row.quantity, `${rowPath}.quantity`), unit: inventoryUnit(row.unit, `${rowPath}.unit`), deliveryLeadDays: nullableFinite(row.deliveryLeadDays, `${rowPath}.deliveryLeadDays`), remark: string(row.remark, `${rowPath}.remark`, 1_000), daysOutstanding: nullableFinite(row.daysOutstanding, `${rowPath}.daysOutstanding`), medication: string(row.medication, `${rowPath}.medication`, 1_000), fmrOmed: string(row.fmrOmed, `${rowPath}.fmrOmed`, 1_000) };
  }) };
}

function draftJob(value: unknown, path: string): InventoryDraftJob {
  const source = object(value, path);
  exactOptional(source, ["draftId", "itemId", "sourceOrderId", "orderNo", "materialCode", "description", "unit", "bagWeightKg", "productionPurpose", "date", "lineId", "quantity", "notBefore", "bin", "remarks", "medication", "fmrOmed"], ["sourceAllocations"], path);
  const unit = inventoryUnit(source.unit, `${path}.unit`); const weight = bagWeight(source.bagWeightKg, `${path}.bagWeightKg`);
  if ((unit === "Bags") !== (weight !== null)) throw new Error(`${path}.bagWeightKg does not match the unit.`);
  const sourceAllocations = has(source, "sourceAllocations") ? array(source.sourceAllocations, `${path}.sourceAllocations`, 500).map((value, index) => {
    const allocationPath = `${path}.sourceAllocations[${index}]`; const allocation = object(value, allocationPath);
    exact(allocation, ["sourceOrderId", "plannedQuantity"], allocationPath);
    const plannedQuantity=positive(allocation.plannedQuantity, `${allocationPath}.plannedQuantity`),scaled=plannedQuantity*(unit==="MT"?1_000:1);
    if(!Number.isSafeInteger(Math.round(scaled))||Math.abs(scaled-Math.round(scaled))>1e-7)throw new Error(`${allocationPath}.plannedQuantity must be whole Bags or MT with at most 3 decimals.`);
    return { sourceOrderId: reference(allocation.sourceOrderId, `${allocationPath}.sourceOrderId`), plannedQuantity };
  }) : undefined;
  if (sourceAllocations && (!sourceAllocations.length || new Set(sourceAllocations.map(row => row.sourceOrderId)).size !== sourceAllocations.length)) throw new Error(`${path}.sourceAllocations must contain distinct source orders.`);
  const quantity = positive(source.quantity, `${path}.quantity`);
  if (sourceAllocations && sourceAllocations.reduce((sum, row) => sum + row.plannedQuantity, 0) - quantity > 1e-6) throw new Error(`${path}.sourceAllocations cannot exceed the draft quantity.`);
  return { draftId: reference(source.draftId, `${path}.draftId`), itemId: reference(source.itemId, `${path}.itemId`), sourceOrderId: source.sourceOrderId === null ? null : reference(source.sourceOrderId, `${path}.sourceOrderId`), ...(sourceAllocations ? { sourceAllocations } : {}), orderNo: string(source.orderNo, `${path}.orderNo`, 120), materialCode: trimmed(source.materialCode, `${path}.materialCode`, 120), description: string(source.description, `${path}.description`, 200), unit, bagWeightKg: weight, productionPurpose: strategy(source.productionPurpose, `${path}.productionPurpose`), date: date(source.date, `${path}.date`), lineId: lineId(source.lineId, `${path}.lineId`), quantity, notBefore: timestamp(source.notBefore, `${path}.notBefore`), bin: string(source.bin, `${path}.bin`, 200), remarks: string(source.remarks, `${path}.remarks`, 1_000), ...bucket(source, path) };
}

function extra(value: unknown, path: string): InventoryExtra | null {
  if (value === null) return null;
  const source = object(value, path); const type = source.type;
  if (type === "fixed") { exact(source, ["type", "quantity"], path); const quantity = nonnegative(source.quantity, `${path}.quantity`); return quantity === 0 ? null : { type, quantity }; }
  if (type === "percent") { exact(source, ["type", "percent"], path); const percent = nonnegative(source.percent, `${path}.percent`); if (percent > 1_000) throw new Error(`${path}.percent must be 1000 or less.`); return percent === 0 ? null : { type, percent }; }
  throw new Error(`${path}.type must be fixed or percent.`);
}

function withOccurredOn<T extends object>(result: T, source: Record<string, unknown>): T & { occurredOn?: string } {
  if (has(source, "occurredOn")) return { ...result, occurredOn: date(source.occurredOn, "command.occurredOn") };
  return result;
}
function bucket(source: Record<string, unknown>, path: string): InventoryBucketKey { return { medication: normalizedBucketText(source.medication, `${path}.medication`), fmrOmed: normalizedBucketText(source.fmrOmed, `${path}.fmrOmed`) }; }
function normalizedBucketText(value: unknown, path: string): string { return string(value, path, 200).trim().replace(/\s+/g, " "); }
function inventoryUnit(value: unknown, path: string): InventoryUnit { if (value !== "Bags" && value !== "MT") throw new Error(`${path} must be Bags or MT.`); return value; }
function strategy(value: unknown, path: string): InventoryStrategy { if (value !== "mto" && value !== "mts") throw new Error(`${path} must be mto or mts.`); return value; }
function nullableStrategy(value: unknown, path: string): InventoryStrategy | null { return value === null ? null : strategy(value, path); }
function bagWeight(value: unknown, path: string): 25 | 50 | null { if (value === null) return null; if (value !== 25 && value !== 50) throw new Error(`${path} must be 25, 50, or null.`); return value; }
function lineId(value: unknown, path: string): LineId { if (value !== "PM1" && value !== "PM2" && value !== "PM3" && value !== "PM4") throw new Error(`${path} is invalid.`); return value; }
function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`); return value as Record<string, unknown>; }
function array(value: unknown, path: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${path} must be an array of ${max} items or fewer.`); return value; }
function rejectUnknown(source: Record<string, unknown>, keys: readonly string[], path: string): void { const allowed = new Set(keys); for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`); }
function exact(source: Record<string, unknown>, keys: readonly string[], path: string): void { rejectUnknown(source, keys, path); for (const key of keys) if (!has(source, key)) throw new Error(`${path}.${key} is required.`); }
function exactOptional(source: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void { rejectUnknown(source, [...required, ...optional], path); for (const key of required) if (!has(source, key)) throw new Error(`${path}.${key} is required.`); }
function has(source: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(source, key); }
function string(value: unknown, path: string, max: number): string { if (typeof value !== "string" || value.length > max) throw new Error(`${path} must be text of ${max} characters or fewer.`); return value; }
function text(value: unknown, path: string, max: number): string { const result = string(value, path, max); if (!result.trim()) throw new Error(`${path} cannot be blank.`); return result; }
function trimmed(value: unknown, path: string, max: number): string { const result = string(value, path, max).trim(); if (!result) throw new Error(`${path} cannot be blank.`); return result; }
function reference(value: unknown, path: string): string { return trimmed(value, path, 200); }
function finite(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`); return value; }
function nonnegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) throw new Error(`${path} cannot be negative.`); return result; }
function positive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) throw new Error(`${path} must be greater than zero.`); return result; }
function nullableFinite(value: unknown, path: string): number | null { return value === null ? null : finite(value, path); }
function integer(value: unknown, path: string, min: number): number { if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${path} must be a safe integer of at least ${min}.`); return value as number; }
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new Error(`${path} must be true or false.`); return value; }
function date(value: unknown, path: string): string { const result = string(value, path, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw new Error(`${path} must be a YYYY-MM-DD date.`); const [year, month, day] = result.split("-").map(Number); const parsed = new Date(Date.UTC(year, month - 1, day)); if (parsed.toISOString().slice(0, 10) !== result) throw new Error(`${path} must be a valid date.`); return result; }
function timestamp(value: unknown, path: string): string { const result = string(value, path, 100); const parsed = Date.parse(result); if (!Number.isFinite(parsed)) throw new Error(`${path} must be an ISO timestamp.`); return new Date(parsed).toISOString(); }
function sha256(value: unknown, path: string): string { const result = trimmed(value, path, 64).toLocaleLowerCase("en-US"); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${path} must be a SHA-256 digest.`); return result; }
