import type {
  CatalogProduct,
  AppState,
  HistoryEvent,
  HistoryChange,
  HistoryChangeValue,
  Job,
  Settings,
} from "./types";

export function createMoveUndoEvent(current: AppState, restored: AppState, id: string, at: string): HistoryEvent {
  const move = current.events.at(-1);
  const jobId = move?.type === 'job.moved' ? move.jobId : undefined;
  const before = current.jobs.find(job => job.id === jobId);
  const after = restored.jobs.find(job => job.id === jobId);
  const changes = before && after ? getJobHistoryChanges(before, after) : [];
  return { id, at, type: 'job.move.undone', ...(jobId ? { jobId } : {}),
    message: 'Undid the most recent production move.', ...(changes.length ? { changes } : {}) };
}

const JOB_FIELDS = [
  "date", "lineId", "sequence", "orderNo", "productCode", "description",
  "bin", "mode", "bagCount", "quantityMt", "remarks", "status",
  "actualStart", "actualEnd", "actualQuantityMt", "completionNote",
  "binNeedsReview",
] as const;

export interface JobChangeOptions {
  includePauseState?: boolean;
}

export function getJobHistoryChanges(
  before: Job | null,
  after: Job | null,
  options: JobChangeOptions = {},
): HistoryChange[] {
  const changes: HistoryChange[] = [];
  for (const field of JOB_FIELDS) {
    addChange(changes, field, before?.[field], after?.[field]);
  }
  addChange(changes, "issue.reason", before?.issue?.reason, after?.issue?.reason);
  if (options.includePauseState) {
    addChange(changes, "pauseState", pauseState(before), pauseState(after));
    addChange(changes, "pauseReason", activePauseReason(before), activePauseReason(after));
  }
  return changes;
}

export function getSettingsHistoryChanges(before: Settings, after: Settings): HistoryChange[] {
  const changes: HistoryChange[] = [];
  addChange(changes, "settings.siteName", before.siteName, after.siteName);
  addChange(changes, "settings.timeZone", before.timeZone, after.timeZone);
  addChange(changes, "settings.dayStart", before.dayStart, after.dayStart);
  addChange(changes, "settings.availableHours", before.availableHours, after.availableHours);
  addChange(changes, "settings.changeoverMinutes", before.changeoverMinutes, after.changeoverMinutes);
  addChange(changes, "settings.bagWeightKg", before.bagWeightKg, after.bagWeightKg);
  for (const lineId of ["PM1", "PM2", "PM3", "PM4"] as const) {
    addChange(changes, `settings.rates.${lineId}`, before.rates[lineId], after.rates[lineId]);
  }
  addChange(
    changes,
    "settings.slowProductPrefixes",
    compactList(before.slowProductPrefixes),
    compactList(after.slowProductPrefixes),
  );
  addChange(changes, "settings.slowRatePM2", before.slowRatePM2, after.slowRatePM2);
  addChange(
    changes,
    "settings.downtime",
    compactList(before.downtime),
    compactList(after.downtime),
  );
  return changes;
}

export function getCatalogHistoryChanges(
  before: CatalogProduct | null,
  after: CatalogProduct | null,
): HistoryChange[] {
  const changes: HistoryChange[] = [];
  addChange(changes, "catalog.code", before?.code, after?.code);
  addChange(changes, "catalog.description", before?.description, after?.description);
  addChange(changes, "catalog.defaultMode", before?.defaultMode, after?.defaultMode);
  addChange(changes, "catalog.active", before?.active, after?.active);
  return changes;
}

function pauseState(job: Job | null): HistoryChangeValue {
  if (!job) return null;
  if (activePauseReason(job) !== null) return "paused";
  return job.status === "running" ? "running" : null;
}

function activePauseReason(job: Job | null): string | null {
  if (!job) return null;
  const last = job.pauseIntervals?.at(-1);
  return last?.resumedAt === null ? last.reason : null;
}

function addChange(
  changes: HistoryChange[],
  field: string,
  before: unknown,
  after: unknown,
): void {
  const normalizedBefore = scalar(before);
  const normalizedAfter = scalar(after);
  if (!Object.is(normalizedBefore, normalizedAfter)) {
    changes.push({ field, before: normalizedBefore, after: normalizedAfter });
  }
}

function scalar(value: unknown): HistoryChangeValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("Audit changes must use scalar values.");
}

function compactList(value: unknown[]): string {
  const json = JSON.stringify(value);
  if (json.length <= 1_000) return json;
  let hash = 2_166_136_261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return JSON.stringify({ count: value.length, fingerprint: (hash >>> 0).toString(16).padStart(8, "0") });
}
