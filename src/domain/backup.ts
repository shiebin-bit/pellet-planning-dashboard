import {
  LINE_IDS,
  type AppState,
  type CatalogProduct,
  type Downtime,
  type HistoryEvent,
  type HistoryChange,
  type Job,
  type JobStatus,
  type LineId,
  type QuantityMode,
  type ProductionPause,
  type ScheduleSegment,
  type Settings,
} from "./types";
import { getRate, getScheduledJobs } from "./engine";

const MAX_BACKUP_CHARACTERS = 64 * 1024 * 1024;
const MAX_JOBS = 10_000;
const MAX_CATALOG_PRODUCTS = 10_000;
const MAX_EVENTS = 50_000;
const MAX_DOWNTIME = 10_000;
const MAX_PREFIXES = 1_000;
const MAX_SEGMENTS_PER_JOB = 20_000;
const MAX_PAUSES_PER_JOB = 10_000;
const MAX_CHANGES_PER_EVENT = 100;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_EVENT_MESSAGE_LENGTH = 20_000;
const MAX_NOTE_LENGTH = 1_000;

type DataObject = Record<string, unknown>;

const JOB_KEYS = [
  "id", "date", "lineId", "sequence", "orderNo", "productCode",
  "description", "bin", "mode", "bagCount", "quantityMt", "status",
  "remarks", "actualStart", "actualEnd", "actualQuantityMt",
  "completionNote", "binNeedsReview", "createdAt", "updatedAt",
  "lockedSegments", "issue",
  "pauseIntervals",
  "sourceOrderId", "sourceOrderVersion", "sourceSnapshot", "sourceAllocations", "bagWeightKgSnapshot",
  "inventoryItemId", "medication", "fmrOmed", "productionPurpose", "notBefore",
] as const;

const JOB_CHANGE_FIELDS = new Set([
  "date", "lineId", "sequence", "orderNo", "productCode", "description",
  "bin", "mode", "bagCount", "quantityMt", "remarks", "status",
  "actualStart", "actualEnd", "actualQuantityMt", "completionNote",
  "binNeedsReview", "issue.reason", "pauseState", "pauseReason",
]);

export function parseWorkspaceBackup(text: string): AppState {
  if (typeof text !== "string") {
    throw invalid("backup", "must be JSON text");
  }
  if (text.length > MAX_BACKUP_CHARACTERS) {
    throw invalid("backup", `exceeds ${MAX_BACKUP_CHARACTERS} characters`);
  }
  if (text.length === 0 || text.trim().length === 0) {
    throw invalid("backup", "is empty");
  }

  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw invalid("backup", "is not valid JSON");
  }
  return validateWorkspaceBackup(value);
}

export function validateWorkspaceBackup(value: unknown): AppState {
  const root = objectValue(value, "backup");
  const schemaVersion = numberValue(required(root, "schemaVersion", "backup"), "backup.schemaVersion", {
    integer: true,
  });
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw invalid("backup.schemaVersion", `is unsupported (${schemaVersion}); expected 1 or 2`);
  }
  onlyKeys(
    root,
    schemaVersion === 1
      ? ["schemaVersion", "jobs", "settings", "events"]
      : ["schemaVersion", "catalog", "jobs", "settings", "events"],
    "backup",
  );

  const jobsValue = arrayValue(required(root, "jobs", "backup"), "backup.jobs", MAX_JOBS);
  const eventsValue = arrayValue(required(root, "events", "backup"), "backup.events", MAX_EVENTS);
  const catalogValue = schemaVersion === 1
    ? []
    : arrayValue(required(root, "catalog", "backup"), "backup.catalog", MAX_CATALOG_PRODUCTS);
  const jobs = jobsValue.map((job, index) => validateJob(job, `backup.jobs[${index}]`));
  const events = eventsValue.map((event, index) => validateEvent(event, `backup.events[${index}]`));
  const catalog = catalogValue.map((product, index) => validateCatalogProduct(product, `backup.catalog[${index}]`));
  const settings = validateSettings(required(root, "settings", "backup"), "backup.settings");

  uniqueIds(catalog, "backup.catalog");
  uniqueCatalogCodes(catalog);
  uniqueIds(jobs, "backup.jobs");
  uniqueIds(events, "backup.events");

  const restored: AppState = { schemaVersion: 2, catalog, jobs, settings, events };
  validateSchedule(restored);
  return restored;
}

function validateCatalogProduct(value: unknown, path: string): CatalogProduct {
  const source = objectValue(value, path);
  onlyKeys(source, ["id", "code", "description", "defaultMode", "active"], path);
  const code = normalizedCatalogText(required(source, "code", path), `${path}.code`, 80);
  const description = normalizedCatalogText(required(source, "description", path), `${path}.description`, 200);
  return {
    id: nonEmptyString(required(source, "id", path), `${path}.id`, MAX_ID_LENGTH),
    code,
    description,
    defaultMode: enumValue<QuantityMode>(
      required(source, "defaultMode", path),
      ["bags", "bulk"],
      `${path}.defaultMode`,
    ),
    active: booleanValue(required(source, "active", path), `${path}.active`),
  };
}

function normalizedCatalogText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") throw invalid(path, "must be text");
  const result = value.trim();
  if (!result) throw invalid(path, "cannot be blank");
  if (result.length > maxLength) throw invalid(path, `must be ${maxLength} characters or fewer`);
  return result;
}

function uniqueCatalogCodes(catalog: CatalogProduct[]): void {
  const seen = new Set<string>();
  for (const product of catalog) {
    const key = product.code.toLowerCase();
    if (seen.has(key)) {
      throw invalid("backup.catalog", `contains duplicate product code ${JSON.stringify(product.code)}`);
    }
    seen.add(key);
  }
}

function validateSchedule(state: AppState): void {
  for (const lineId of LINE_IDS) {
    const running = state.jobs.filter((job) => job.lineId === lineId && job.status === "running");
    if (running.length > 1) {
      throw invalid(
        "backup.jobs",
        `contains more than one running job on ${lineId}; finish the current running job before starting another`,
      );
    }
  }

  const active = state.jobs.filter((job) => job.status !== "cancelled" && job.quantityMt > 0);
  for (const job of active) {
    const durationMinutes = (job.quantityMt / getRate(state.settings, job.lineId, job.productCode)) * 60;
    if (!Number.isFinite(durationMinutes)) {
      throw invalid("backup.jobs", `cannot calculate a finite duration for job ${JSON.stringify(job.id)}`);
    }
  }
  if (active.length === 0) {
    getScheduledJobs(state);
    return;
  }
  const scheduled = new Map(getScheduledJobs(state).map((job) => [job.id, job]));
  for (const job of active) {
    const computed = scheduled.get(job.id);
    if (!computed || !Number.isFinite(computed.durationMinutes)) {
      throw invalid("backup.jobs", `cannot calculate a safe schedule for job ${JSON.stringify(job.id)}`);
    }
    const hasLockedPlan = (job.lockedSegments?.length ?? 0) > 0;
    if (state.settings.availableHours === 0 && !hasLockedPlan) continue;
    if (
      computed.plannedStart === null ||
      computed.plannedEnd === null ||
      !Number.isFinite(computed.plannedStart) ||
      !Number.isFinite(computed.plannedEnd) ||
      !Number.isFinite(new Date(computed.plannedStart).getTime()) ||
      !Number.isFinite(new Date(computed.plannedEnd).getTime())
    ) {
      throw invalid(
        "backup.jobs",
        `cannot schedule job ${JSON.stringify(job.id)} within the planning engine's bounded calendar`,
      );
    }
  }
}

function validateJob(value: unknown, path: string): Job {
  const source = objectValue(value, path);
  onlyKeys(source, JOB_KEYS, path);

  const id = nonEmptyString(required(source, "id", path), `${path}.id`, MAX_ID_LENGTH);
  const date = dateValue(required(source, "date", path), `${path}.date`);
  const lineId = lineValue(required(source, "lineId", path), `${path}.lineId`);
  const sequence = numberValue(required(source, "sequence", path), `${path}.sequence`, {
    min: 0,
    integer: true,
  });
  const orderNo = stringValue(required(source, "orderNo", path), `${path}.orderNo`, MAX_TEXT_LENGTH);
  const productCode = nonEmptyString(required(source, "productCode", path), `${path}.productCode`, MAX_TEXT_LENGTH);
  const description = stringValue(required(source, "description", path), `${path}.description`, MAX_TEXT_LENGTH);
  const bin = stringValue(required(source, "bin", path), `${path}.bin`, MAX_TEXT_LENGTH);
  const mode = enumValue<QuantityMode>(required(source, "mode", path), ["bags", "bulk"], `${path}.mode`);
  const bagCountValue = required(source, "bagCount", path);
  const bagCount = bagCountValue === null
    ? null
    : numberValue(bagCountValue, `${path}.bagCount`, { min: 0 });
  if (mode === "bags" && bagCount === null) {
    throw invalid(`${path}.bagCount`, "is required for bag quantities");
  }
  if (mode === "bulk" && bagCount !== null) {
    throw invalid(`${path}.bagCount`, "must be null for bulk quantities");
  }
  const quantityMt = numberValue(required(source, "quantityMt", path), `${path}.quantityMt`, { min: 0 });
  const status = enumValue<JobStatus>(
    required(source, "status", path),
    ["pending", "running", "completed", "cancelled"],
    `${path}.status`,
  );
  const remarks = stringValue(required(source, "remarks", path), `${path}.remarks`, MAX_NOTE_LENGTH);
  const actualStart = nullableTimestamp(required(source, "actualStart", path), `${path}.actualStart`);
  const actualEnd = nullableTimestamp(required(source, "actualEnd", path), `${path}.actualEnd`);
  validateActualTimes(status, actualStart, actualEnd, path);
  const binNeedsReview = booleanValue(required(source, "binNeedsReview", path), `${path}.binNeedsReview`);
  const createdAt = timestampValue(required(source, "createdAt", path), `${path}.createdAt`);
  const updatedAt = timestampValue(required(source, "updatedAt", path), `${path}.updatedAt`);

  const result: Job = {
    id,
    date,
    lineId,
    sequence,
    orderNo,
    productCode,
    description,
    bin,
    mode,
    bagCount,
    quantityMt,
    status,
    remarks,
    actualStart,
    actualEnd,
    binNeedsReview,
    createdAt,
    updatedAt,
  };

  if (hasOwn(source, "actualQuantityMt")) {
    const actual = source.actualQuantityMt;
    result.actualQuantityMt = actual === null
      ? null
      : numberValue(actual, `${path}.actualQuantityMt`, { min: 0 });
    if (status !== "completed" && result.actualQuantityMt !== null) {
      throw invalid(`${path}.actualQuantityMt`, "is only valid for a completed job");
    }
  }
  if (hasOwn(source, "completionNote")) {
    result.completionNote = stringValue(source.completionNote, `${path}.completionNote`, MAX_NOTE_LENGTH);
    if (status !== "completed") {
      throw invalid(`${path}.completionNote`, "is only valid for a completed job");
    }
  }
  if (hasOwn(source, "lockedSegments")) {
    const segments = arrayValue(source.lockedSegments, `${path}.lockedSegments`, MAX_SEGMENTS_PER_JOB);
    if ((status === "pending" || status === "cancelled") && segments.length > 0) {
      throw invalid(`${path}.lockedSegments`, "must be empty for a pending or cancelled job");
    }
    result.lockedSegments = segments.map((segment, index) =>
      validateSegment(segment, `${path}.lockedSegments[${index}]`, id, lineId),
    );
  }
  if (hasOwn(source, "issue")) {
    if (status !== "pending" && status !== "running") {
      throw invalid(`${path}.issue`, "is only valid for a pending or running job");
    }
    result.issue = validateIssue(source.issue, `${path}.issue`);
  }
  if (hasOwn(source, "pauseIntervals")) {
    const pauses = arrayValue(source.pauseIntervals, `${path}.pauseIntervals`, MAX_PAUSES_PER_JOB)
      .map((pause, index) => validateProductionPause(pause, `${path}.pauseIntervals[${index}]`));
    validateProductionPauses(pauses, status, actualStart, actualEnd, `${path}.pauseIntervals`);
    result.pauseIntervals = pauses;
  }
  if (hasOwn(source, "sourceOrderId")) {
    result.sourceOrderId = nonEmptyString(source.sourceOrderId, `${path}.sourceOrderId`, MAX_ID_LENGTH);
    result.sourceOrderVersion = numberValue(required(source, "sourceOrderVersion", path), `${path}.sourceOrderVersion`, { min: 1, integer: true });
    result.sourceSnapshot = validateSourceSnapshot(required(source, "sourceSnapshot", path), `${path}.sourceSnapshot`);
    if (hasOwn(source, "bagWeightKgSnapshot")) {
      result.bagWeightKgSnapshot = numberValue(source.bagWeightKgSnapshot, `${path}.bagWeightKgSnapshot`, { exclusiveMin: 0 });
    }
  } else if (hasOwn(source, "sourceOrderVersion") || hasOwn(source, "sourceSnapshot")) {
    throw invalid(path, "source metadata requires sourceOrderId");
  }
  if (hasOwn(source, "sourceAllocations")) {
    if (result.sourceOrderId) throw invalid(path, "cannot contain both sourceAllocations and legacy sourceOrderId");
    const values = arrayValue(source.sourceAllocations, `${path}.sourceAllocations`, 500);
    if (!values.length) throw invalid(`${path}.sourceAllocations`, "must contain at least one allocation");
    const seen = new Set<string>();
    result.sourceAllocations = values.map((value, index) => {
      const allocationPath = `${path}.sourceAllocations[${index}]`;
      const allocation = objectValue(value, allocationPath);
      onlyKeys(allocation, ["sourceOrderId", "sourceOrderVersion", "sourceSnapshot", "plannedQuantity"], allocationPath);
      const sourceOrderId = nonEmptyString(required(allocation, "sourceOrderId", allocationPath), `${allocationPath}.sourceOrderId`, MAX_ID_LENGTH);
      if (seen.has(sourceOrderId)) throw invalid(`${path}.sourceAllocations`, `contains duplicate source order ${JSON.stringify(sourceOrderId)}`);
      seen.add(sourceOrderId);
      const sourceSnapshot = validateSourceSnapshot(required(allocation, "sourceSnapshot", allocationPath), `${allocationPath}.sourceSnapshot`);
      if ((sourceSnapshot.unit === "Bags") !== (mode === "bags")) throw invalid(`${allocationPath}.sourceSnapshot.unit`, "must match the job quantity mode");
      if (sourceSnapshot.materialCode.trim().toUpperCase() !== productCode.trim().toUpperCase()) throw invalid(`${allocationPath}.sourceSnapshot.materialCode`, "must match the job product");
      const plannedQuantity = numberValue(required(allocation, "plannedQuantity", allocationPath), `${allocationPath}.plannedQuantity`, { exclusiveMin: 0 });
      const scaledQuantity = plannedQuantity * (sourceSnapshot.unit === "MT" ? 1_000 : 1);
      if (!Number.isSafeInteger(Math.round(scaledQuantity)) || Math.abs(scaledQuantity - Math.round(scaledQuantity)) > 1e-8) {
        throw invalid(`${allocationPath}.plannedQuantity`, sourceSnapshot.unit === "Bags" ? "must be a whole number of bags" : "must have no more than three decimal places");
      }
      return {
        sourceOrderId,
        sourceOrderVersion: numberValue(required(allocation, "sourceOrderVersion", allocationPath), `${allocationPath}.sourceOrderVersion`, { min: 1, integer: true }),
        sourceSnapshot,
        plannedQuantity,
      };
    });
    const allocationTotal = result.sourceAllocations.reduce((sum, allocation) => sum + allocation.plannedQuantity, 0);
    const jobTotal = mode === "bags" ? bagCount! : quantityMt;
    if (allocationTotal - jobTotal > 1e-6) throw invalid(`${path}.sourceAllocations`, "planned quantities cannot exceed the job quantity");
  }
  if (hasOwn(source, "bagWeightKgSnapshot")) result.bagWeightKgSnapshot = numberValue(source.bagWeightKgSnapshot, `${path}.bagWeightKgSnapshot`, { exclusiveMin: 0 });
  if (hasOwn(source, "inventoryItemId")) result.inventoryItemId = nonEmptyString(source.inventoryItemId, `${path}.inventoryItemId`, MAX_ID_LENGTH);
  if (hasOwn(source, "medication")) result.medication = stringValue(source.medication, `${path}.medication`, MAX_NOTE_LENGTH);
  if (hasOwn(source, "fmrOmed")) result.fmrOmed = stringValue(source.fmrOmed, `${path}.fmrOmed`, MAX_NOTE_LENGTH);
  if (hasOwn(source, "productionPurpose")) result.productionPurpose = enumValue<"mto" | "mts">(source.productionPurpose, ["mto", "mts"], `${path}.productionPurpose`);
  if (hasOwn(source, "notBefore")) result.notBefore = timestampValue(source.notBefore, `${path}.notBefore`);

  return result;
}

function validateSourceSnapshot(value: unknown, path: string): NonNullable<Job["sourceSnapshot"]> {
  const snapshot = objectValue(value, path);
  onlyKeys(snapshot, ["doNo", "materialCode", "description", "quantity", "unit", "deliveryDate", "soldToParty", "shipToParty"], path);
  return {
    doNo: nonEmptyString(required(snapshot, "doNo", path), `${path}.doNo`, 120),
    materialCode: nonEmptyString(required(snapshot, "materialCode", path), `${path}.materialCode`, 120),
    description: stringValue(required(snapshot, "description", path), `${path}.description`, 200),
    quantity: numberValue(required(snapshot, "quantity", path), `${path}.quantity`, { min: 0 }),
    unit: enumValue(required(snapshot, "unit", path), ["MT", "Bags"], `${path}.unit`),
    ...(hasOwn(snapshot, "deliveryDate") ? { deliveryDate: dateValue(snapshot.deliveryDate, `${path}.deliveryDate`) } : {}),
    ...(hasOwn(snapshot, "soldToParty") ? { soldToParty: stringValue(snapshot.soldToParty, `${path}.soldToParty`, 1_000) } : {}),
    ...(hasOwn(snapshot, "shipToParty") ? { shipToParty: stringValue(snapshot.shipToParty, `${path}.shipToParty`, 1_000) } : {}),
  };
}

function validateProductionPause(value: unknown, path: string): ProductionPause {
  const source = objectValue(value, path);
  onlyKeys(source, ["pausedAt", "resumedAt", "reason"], path);
  return {
    pausedAt: timestampValue(required(source, "pausedAt", path), `${path}.pausedAt`),
    resumedAt: nullableTimestamp(required(source, "resumedAt", path), `${path}.resumedAt`),
    reason: nonEmptyString(required(source, "reason", path), `${path}.reason`, MAX_NOTE_LENGTH),
  };
}

function validateProductionPauses(
  pauses: ProductionPause[],
  status: JobStatus,
  actualStart: string | null,
  actualEnd: string | null,
  path: string,
): void {
  if ((status === "pending" || status === "cancelled") && pauses.length > 0) {
    throw invalid(path, `${status} jobs cannot have production pauses`);
  }
  const startMs = actualStart === null ? null : Date.parse(actualStart);
  const endMs = actualEnd === null ? null : Date.parse(actualEnd);
  let previousEnd: number | null = null;
  for (let index = 0; index < pauses.length; index += 1) {
    const pause = pauses[index];
    const pausedAt = Date.parse(pause.pausedAt);
    const resumedAt = pause.resumedAt === null ? null : Date.parse(pause.resumedAt);
    if (startMs !== null && pausedAt < startMs) {
      throw invalid(`${path}[${index}].pausedAt`, "cannot be earlier than actual start");
    }
    if (endMs !== null && pausedAt > endMs) {
      throw invalid(`${path}[${index}].pausedAt`, "cannot be later than actual end");
    }
    if (resumedAt !== null && resumedAt < pausedAt) {
      throw invalid(`${path}[${index}].resumedAt`, "cannot be earlier than pause start");
    }
    if (resumedAt !== null && endMs !== null && resumedAt > endMs) {
      throw invalid(`${path}[${index}].resumedAt`, "cannot be later than actual end");
    }
    if (index > 0 && (previousEnd === null || pausedAt < previousEnd)) {
      throw invalid(`${path}[${index}].pausedAt`, "must follow the previous resumed pause without overlap");
    }
    if (resumedAt === null && index !== pauses.length - 1) {
      throw invalid(`${path}[${index}].resumedAt`, "may be open only on the final pause");
    }
    previousEnd = resumedAt;
  }
  if (status === "completed" && pauses.some((pause) => pause.resumedAt === null)) {
    throw invalid(path, "completed jobs cannot have an open production pause");
  }
}

function validateActualTimes(
  status: JobStatus,
  actualStart: string | null,
  actualEnd: string | null,
  path: string,
): void {
  if (actualEnd !== null && actualStart === null) {
    throw invalid(`${path}.actualEnd`, "cannot be recorded without an actual start");
  }
  if (
    actualStart !== null &&
    actualEnd !== null &&
    Date.parse(actualEnd) < Date.parse(actualStart)
  ) {
    throw invalid(`${path}.actualEnd`, "cannot be earlier than actual start");
  }
  if ((status === "pending" || status === "cancelled") && (actualStart !== null || actualEnd !== null)) {
    throw invalid(path, `${status} jobs cannot have actual timestamps`);
  }
  if (status === "running" && (actualStart === null || actualEnd !== null)) {
    throw invalid(path, "running jobs require an actual start and no actual end");
  }
  if (status === "completed" && (actualStart === null || actualEnd === null)) {
    throw invalid(path, "completed jobs require actual start and end timestamps");
  }
}

function validateSegment(
  value: unknown,
  path: string,
  expectedJobId: string,
  expectedLineId: LineId,
): ScheduleSegment {
  const source = objectValue(value, path);
  onlyKeys(source, ["jobId", "lineId", "kind", "start", "end"], path);
  const jobId = nonEmptyString(required(source, "jobId", path), `${path}.jobId`, MAX_ID_LENGTH);
  const lineId = lineValue(required(source, "lineId", path), `${path}.lineId`);
  const kind = enumValue<ScheduleSegment["kind"]>(
    required(source, "kind", path),
    ["production", "changeover"],
    `${path}.kind`,
  );
  const start = numberValue(required(source, "start", path), `${path}.start`, { min: 0 });
  const end = numberValue(required(source, "end", path), `${path}.end`, { min: 0 });
  if (end <= start) throw invalid(`${path}.end`, "must be later than segment start");
  if (jobId !== expectedJobId) {
    throw invalid(`${path}.jobId`, `must match parent job id ${JSON.stringify(expectedJobId)}`);
  }
  if (lineId !== expectedLineId) {
    throw invalid(`${path}.lineId`, `must match parent line ${expectedLineId}`);
  }
  return { jobId, lineId, kind, start, end };
}

function validateIssue(value: unknown, path: string): NonNullable<Job["issue"]> {
  const source = objectValue(value, path);
  onlyKeys(source, ["reason", "reportedAt"], path);
  return {
    reason: nonEmptyString(required(source, "reason", path), `${path}.reason`, MAX_NOTE_LENGTH),
    reportedAt: timestampValue(required(source, "reportedAt", path), `${path}.reportedAt`),
  };
}

function validateSettings(value: unknown, path: string): Settings {
  const source = objectValue(value, path);
  onlyKeys(source, [
    "siteName", "timeZone", "dayStart", "availableHours", "changeoverMinutes",
    "bagWeightKg", "rates", "slowProductPrefixes", "slowRatePM2", "downtime", "calendarCutover",
  ], path);

  const ratesValue = objectValue(required(source, "rates", path), `${path}.rates`);
  onlyKeys(ratesValue, LINE_IDS, `${path}.rates`);
  const rates = Object.fromEntries(
    LINE_IDS.map((lineId) => [
      lineId,
      numberValue(required(ratesValue, lineId, `${path}.rates`), `${path}.rates.${lineId}`, { exclusiveMin: 0 }),
    ]),
  ) as Record<LineId, number>;

  const prefixesValue = arrayValue(
    required(source, "slowProductPrefixes", path),
    `${path}.slowProductPrefixes`,
    MAX_PREFIXES,
  );
  const slowProductPrefixes = prefixesValue.map((prefix, index) =>
    stringValue(prefix, `${path}.slowProductPrefixes[${index}]`, MAX_TEXT_LENGTH),
  );

  const downtimeValue = arrayValue(required(source, "downtime", path), `${path}.downtime`, MAX_DOWNTIME);
  const downtime = downtimeValue.map((item, index) => validateDowntime(item, `${path}.downtime[${index}]`));
  uniqueIds(downtime, `${path}.downtime`);

  const result: Settings = {
    siteName: nonEmptyString(required(source, "siteName", path), `${path}.siteName`, MAX_TEXT_LENGTH),
    timeZone: nonEmptyString(required(source, "timeZone", path), `${path}.timeZone`, MAX_TEXT_LENGTH),
    dayStart: timeValue(required(source, "dayStart", path), `${path}.dayStart`),
    availableHours: numberValue(required(source, "availableHours", path), `${path}.availableHours`, { min: 0, max: 24 }),
    changeoverMinutes: numberValue(required(source, "changeoverMinutes", path), `${path}.changeoverMinutes`, { min: 0 }),
    bagWeightKg: numberValue(required(source, "bagWeightKg", path), `${path}.bagWeightKg`, { exclusiveMin: 0 }),
    rates,
    slowProductPrefixes,
    slowRatePM2: numberValue(required(source, "slowRatePM2", path), `${path}.slowRatePM2`, { exclusiveMin: 0 }),
    downtime,
  };
  if (hasOwn(source, "calendarCutover")) {
    const cutover = objectValue(source.calendarCutover, `${path}.calendarCutover`);
    onlyKeys(cutover, ["effectiveFrom", "priorDayStart", "priorAvailableHours", "activatedAt"], `${path}.calendarCutover`);
    result.calendarCutover = {
      effectiveFrom: dateValue(required(cutover, "effectiveFrom", `${path}.calendarCutover`), `${path}.calendarCutover.effectiveFrom`),
      priorDayStart: timeValue(required(cutover, "priorDayStart", `${path}.calendarCutover`), `${path}.calendarCutover.priorDayStart`),
      priorAvailableHours: numberValue(required(cutover, "priorAvailableHours", `${path}.calendarCutover`), `${path}.calendarCutover.priorAvailableHours`, { min: 0, max: 24 }),
      activatedAt: timestampValue(required(cutover, "activatedAt", `${path}.calendarCutover`), `${path}.calendarCutover.activatedAt`),
    };
  }
  return result;
}

function validateDowntime(value: unknown, path: string): Downtime {
  const source = objectValue(value, path);
  onlyKeys(source, ["id", "date", "lineId", "start", "end", "reason"], path);
  const rawLine = required(source, "lineId", path);
  const lineId = rawLine === "all" ? "all" : lineValue(rawLine, `${path}.lineId`);
  return {
    id: nonEmptyString(required(source, "id", path), `${path}.id`, MAX_ID_LENGTH),
    date: dateValue(required(source, "date", path), `${path}.date`),
    lineId,
    start: timeValue(required(source, "start", path), `${path}.start`),
    end: timeValue(required(source, "end", path), `${path}.end`),
    reason: stringValue(required(source, "reason", path), `${path}.reason`, MAX_TEXT_LENGTH),
  };
}

function validateEvent(value: unknown, path: string): HistoryEvent {
  const source = objectValue(value, path);
  onlyKeys(source, ["id", "at", "type", "jobId", "message", "changes"], path);
  const result: HistoryEvent = {
    id: nonEmptyString(required(source, "id", path), `${path}.id`, MAX_ID_LENGTH),
    at: timestampValue(required(source, "at", path), `${path}.at`),
    type: nonEmptyString(required(source, "type", path), `${path}.type`, MAX_TEXT_LENGTH),
    message: stringValue(required(source, "message", path), `${path}.message`, MAX_EVENT_MESSAGE_LENGTH),
  };
  if (hasOwn(source, "jobId")) {
    result.jobId = nonEmptyString(source.jobId, `${path}.jobId`, MAX_ID_LENGTH);
  }
  if (hasOwn(source, "changes")) {
    result.changes = arrayValue(source.changes, `${path}.changes`, MAX_CHANGES_PER_EVENT)
      .map((change, index) => validateHistoryChange(change, `${path}.changes[${index}]`));
    const fields = new Set<string>();
    for (let index = 0; index < result.changes.length; index += 1) {
      const field = result.changes[index].field;
      if (fields.has(field)) throw invalid(`${path}.changes[${index}].field`, `duplicates ${JSON.stringify(field)}`);
      fields.add(field);
    }
  }
  return result;
}

function validateHistoryChange(value: unknown, path: string): HistoryChange {
  const source = objectValue(value, path);
  onlyKeys(source, ["field", "before", "after"], path);
  const field = nonEmptyString(required(source, "field", path), `${path}.field`, 200);
  if (!JOB_CHANGE_FIELDS.has(field) && !/^settings\.[A-Za-z0-9_.]+$/.test(field) && !/^catalog\.[A-Za-z0-9_.]+$/.test(field)) {
    throw invalid(`${path}.field`, "is not an allowed audit field");
  }
  const before = historyChangeValue(required(source, "before", path), `${path}.before`);
  const after = historyChangeValue(required(source, "after", path), `${path}.after`);
  if (Object.is(before, after)) throw invalid(path, "must describe a changed value");
  return { field, before, after };
}

function historyChangeValue(value: unknown, path: string): HistoryChange["before"] {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return numberValue(value, path);
  if (typeof value === "string") return stringValue(value, path, MAX_EVENT_MESSAGE_LENGTH);
  throw invalid(path, "must be text, a finite number, true, false, or null");
}

function objectValue(value: unknown, path: string): DataObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(path, "must be a plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid(path, "contains unsupported symbol keys");
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      throw invalid(`${path}.${key}`, "cannot be an accessor property");
    }
  }
  return value as DataObject;
}

function arrayValue(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid(path, "must be an array");
  }
  if (value.length > maxLength) {
    throw invalid(path, `contains more than ${maxLength} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw invalid(`${path}[${index}]`, "is missing");
    }
  }
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw invalid(`${path}.${key}`, "is not a supported array property");
    }
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key !== "length" && (descriptor.get || descriptor.set)) {
      throw invalid(`${path}[${key}]`, "cannot be an accessor property");
    }
  }
  return value;
}

function stringValue(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") throw invalid(path, "must be text");
  if (value.length > maxLength) throw invalid(path, `must be ${maxLength} characters or fewer`);
  return value;
}

function nonEmptyString(value: unknown, path: string, maxLength: number): string {
  const text = stringValue(value, path, maxLength);
  if (text.trim().length === 0) throw invalid(path, "cannot be blank");
  return text;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "must be true or false");
  return value;
}

function numberValue(
  value: unknown,
  path: string,
  bounds: { min?: number; max?: number; exclusiveMin?: number; integer?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(path, "must be a finite number");
  }
  if (bounds.integer && !Number.isSafeInteger(value)) throw invalid(path, "must be a safe integer");
  if (bounds.min !== undefined && value < bounds.min) throw invalid(path, `must be ${bounds.min} or greater`);
  if (bounds.max !== undefined && value > bounds.max) throw invalid(path, `must be ${bounds.max} or less`);
  if (bounds.exclusiveMin !== undefined && value <= bounds.exclusiveMin) {
    throw invalid(path, `must be greater than ${bounds.exclusiveMin}`);
  }
  return value;
}

function dateValue(value: unknown, path: string): string {
  const text = stringValue(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw invalid(path, "must use YYYY-MM-DD");
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw invalid(path, "is not a valid calendar date");
  }
  return text;
}

function timeValue(value: unknown, path: string): string {
  const text = stringValue(value, path, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw invalid(path, "must use HH:mm in 24-hour time");
  return text;
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path, 200);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw invalid(path, "must be an ISO date-time with a time-zone offset");
  }
  dateValue(text.slice(0, 10), `${path} date`);
  if (!Number.isFinite(Date.parse(text))) throw invalid(path, "must be a valid date-time");
  return text;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestampValue(value, path);
}

function lineValue(value: unknown, path: string): LineId {
  if (typeof value !== "string" || !LINE_IDS.includes(value as LineId)) {
    throw invalid(path, `must be one of ${LINE_IDS.join(", ")}`);
  }
  return value as LineId;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function required(source: DataObject, key: string, path: string): unknown {
  if (!hasOwn(source, key)) throw invalid(`${path}.${key}`, "is required");
  return source[key];
}

function hasOwn(source: DataObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function onlyKeys(source: DataObject, allowed: readonly string[], path: string): void {
  const supported = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (!supported.has(key)) throw invalid(`${path}.${key}`, "is not supported");
  }
}

function uniqueIds(items: Array<{ id: string }>, path: string): void {
  const ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    if (ids.has(items[index].id)) {
      throw invalid(`${path}[${index}].id`, `duplicates ${JSON.stringify(items[index].id)}`);
    }
    ids.add(items[index].id);
  }
}

function invalid(path: string, message: string): Error {
  return new Error(`Invalid workspace backup: ${path} ${message}.`);
}
