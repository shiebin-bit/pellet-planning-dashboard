import {
  LINE_IDS,
  type AppState,
  type Board,
  type CatalogProduct,
  type Downtime,
  type HistoryEvent,
  type HistoryChange,
  type Job,
  type JobInput,
  type LineId,
  type LineSchedule,
  type ScheduleSegment,
  type ScheduledJob,
  type Settings,
} from "./types";
import {
  getCatalogHistoryChanges,
  getJobHistoryChanges,
  getSettingsHistoryChanges,
} from "./audit";
import type {
  CatalogCreateInput,
  CatalogUpdatePatch,
  CopyBatchItem,
} from "./commands";
import { getJobSourceAllocations, getProductionBatchIdentity } from "./jobSources";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MALAYSIA_OFFSET_MINUTES = 8 * 60;
const MAX_SEARCH_DAYS = 3_700;
const MAX_NOTE_LENGTH = 1_000;

interface Interval {
  start: number;
  end: number;
}

interface ScheduleResult {
  byLine: Record<LineId, ScheduledJob[]>;
  byId: Map<string, ScheduledJob>;
}

export function getRate(
  settings: Settings,
  lineId: LineId,
  productCode: string,
): number {
  if (
    lineId === "PM2" &&
    settings.slowProductPrefixes.some((prefix) => {
      const normalizedPrefix = prefix.trim();
      return normalizedPrefix.length > 0 && productCode.trim().startsWith(normalizedPrefix);
    })
  ) {
    return settings.slowRatePM2;
  }
  return settings.rates[lineId];
}

export function getBoard(state: AppState, date: string): Board {
  assertDate(date, "Board date");
  validateSettings(state.settings);

  const calendar = getCalendarForDate(state.settings, date);
  const start = businessDayStart(date, calendar.dayStart);
  const end = start + calendar.availableHours * 60 * MINUTE_MS;
  const scheduled = scheduleState(state);

  const lines = LINE_IDS.map((lineId): LineSchedule => {
    const allLineJobs = scheduled.byLine[lineId];
    const jobs = allLineJobs.filter(
      (job) =>
        job.date === date ||
        (job.date < date &&
          job.segments.some(
            (segment) => segment.start < end && segment.end > start,
          )),
    );
    const boardSegments = jobs
      .flatMap((job) => job.segments)
      .filter((segment) => segment.start < end && segment.end > start)
      .map((segment) => ({
        ...segment,
        start: Math.max(start, segment.start),
        end: Math.min(end, segment.end),
      }))
      .sort(compareSegments);

    const productionMinutes = minutesForKind(boardSegments, "production");
    const changeoverMinutes = minutesForKind(boardSegments, "changeover");
    const availableMinutes = getAvailableIntervals(
      calendar,
      lineId,
      date,
    ).reduce(
      (total, interval) =>
        total +
        overlapMinutes(interval.start, interval.end, start, end),
      0,
    );
    const datedJobs = allLineJobs.filter((job) => job.date === date);
    const finishAt = maxOrNull(
      datedJobs
        .map((job) => job.plannedEnd)
        .filter((value): value is number => value !== null),
    );

    return {
      lineId,
      jobs,
      segments: boardSegments,
      availableMinutes,
      productionMinutes,
      changeoverMinutes,
      utilisation:
        availableMinutes > 0
          ? productionMinutes / availableMinutes
          : null,
      plannedMt: datedJobs.reduce((sum, job) => sum + job.quantityMt, 0),
      totalProductionMinutes: datedJobs.reduce(
        (sum, job) => sum + job.durationMinutes,
        0,
      ),
      overflowMinutes: datedJobs.reduce(
        (sum, job) =>
          sum +
          job.segments.reduce(
            (jobSum, segment) =>
              jobSum + Math.max(0, segment.end - Math.max(end, segment.start)) / MINUTE_MS,
            0,
          ),
        0,
      ),
      finishAt,
    };
  });

  const backlog = state.jobs
    .filter(
      (job) =>
        job.date === date && job.status !== "cancelled" && job.quantityMt <= 0,
    )
    .sort(compareJobs)
    .map(cloneJob);

  return { date, start, end, lines, backlog };
}

/** Computes every schedulable production record once without clipping it to a board date. */
export function getScheduledJobs(state: AppState): ScheduledJob[] {
  validateSettings(state.settings);
  const scheduled = scheduleState(state);
  return LINE_IDS.flatMap((lineId) => scheduled.byLine[lineId]);
}

export function createJob(state: AppState, input: JobInput): AppState {
  validateSettings(state.settings);
  const normalized = normalizeInput(input, state.settings);
  const now = new Date().toISOString();
  const sequence =
    Math.max(
      0,
      ...state.jobs
        .filter(
          (job) => job.date === normalized.date && job.lineId === normalized.lineId,
        )
        .map((job) => job.sequence),
    ) + 1;
  const job: Job = {
    ...normalized,
    id: makeId("job"),
    sequence,
    status: "pending",
    actualStart: null,
    actualEnd: null,
    binNeedsReview: false,
    createdAt: now,
    updatedAt: now,
  };
  return finalizeMutation(
    state,
    [...state.jobs, job],
    event(
      "job.created",
      `Created order ${job.orderNo}.`,
      job.id,
      now,
      getJobHistoryChanges(null, job),
    ),
  );
}

export function updateJob(
  state: AppState,
  id: string,
  patch: Partial<JobInput>,
): AppState {
  const current = requireJob(state, id);
  requirePending(current, "edit");
  if (getJobSourceAllocations(current).length) {
    const protectedFields: Array<keyof JobInput> = ["orderNo", "productCode", "description", "mode", "bagCount", "quantityMt"];
    if (protectedFields.some(field => Object.prototype.hasOwnProperty.call(patch, field))) {
      throw new Error("Imported order, product, unit, and quantity fields cannot be edited on the production card.");
    }
  }
  const normalizationSettings = current.bagWeightKgSnapshot
    ? { ...state.settings, bagWeightKg: current.bagWeightKgSnapshot }
    : state.settings;
  const normalized = normalizeInput({ ...toInput(current), ...patch }, normalizationSettings);
  const now = new Date().toISOString();
  let jobs = state.jobs.map((job) =>
    job.id === id
      ? {
          ...job,
          ...normalized,
          binNeedsReview:
            normalized.lineId !== current.lineId ? true : job.binNeedsReview,
          updatedAt: now,
        }
      : job,
  );
  if (normalized.lineId !== current.lineId || normalized.date !== current.date) {
    jobs = resequence(jobs, current.lineId, current.date);
    jobs = resequence(jobs, normalized.lineId, normalized.date);
  }
  return finalizeMutation(
    state,
    jobs,
    event(
      "job.updated",
      `Updated order ${current.orderNo}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function moveJob(
  state: AppState,
  id: string,
  toLineId: LineId,
  beforeJobId?: string,
): AppState {
  assertLineId(toLineId);
  const current = requireJob(state, id);
  requirePending(current, "move");
  if (beforeJobId === id) {
    throw new Error("A job cannot be moved before itself.");
  }

  const before = beforeJobId ? requireJob(state, beforeJobId) : undefined;
  if (
    before &&
    (before.lineId !== toLineId || before.date !== current.date)
  ) {
    throw new Error("The target job must be on the destination line and date.");
  }

  const now = new Date().toISOString();
  const moved: Job = {
    ...current,
    lineId: toLineId,
    binNeedsReview:
      current.lineId === toLineId ? current.binNeedsReview : true,
    updatedAt: now,
  };
  const remaining = state.jobs.filter((job) => job.id !== id);
  const destination = remaining
    .filter((job) => job.lineId === toLineId && job.date === current.date)
    .sort(compareJobs);
  const insertionIndex = before
    ? destination.findIndex((job) => job.id === before.id)
    : destination.length;
  destination.splice(insertionIndex, 0, moved);
  const destinationIds = new Set(destination.map((job) => job.id));
  let jobs = remaining
    .filter((job) => !destinationIds.has(job.id))
    .concat(destination.map((job, index) => ({ ...job, sequence: index + 1 })));
  jobs = resequence(jobs, current.lineId, current.date);

  return finalizeMutation(
    state,
    jobs,
    event(
      "job.moved",
      `Moved order ${current.orderNo} to ${toLineId}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function startJob(
  state: AppState,
  id: string,
  actualStartIso: string,
): AppState {
  const current = requireJob(state, id);
  requirePending(current, "start");
  assertIsoDateTime(actualStartIso, "Actual start");
  const startedAt = new Date(actualStartIso).toISOString();
  const alreadyRunning = state.jobs.find(
    (job) => job.lineId === current.lineId && job.status === "running",
  );
  if (alreadyRunning) {
    throw new Error(
      `Finish the current running job on ${current.lineId} before starting another.`,
    );
  }
  if (current.quantityMt <= 0) {
    throw new Error("A job must have a positive quantity before it can start.");
  }
  const scheduled = scheduleState(state).byId.get(id);
  if (!scheduled || scheduled.segments.length === 0) {
    throw new Error("The job cannot start because no production capacity is available.");
  }
  const now = startedAt;
  const jobs = state.jobs.map((job) =>
    job.id === id
      ? {
          ...job,
          status: "running" as const,
          actualStart: startedAt,
          actualEnd: null,
          lockedSegments: scheduled.segments.map((segment) => ({ ...segment })),
          updatedAt: now,
        }
      : job,
  );
  return withEvent(
    state,
    jobs,
    event(
      "job.started",
      `Started order ${current.orderNo}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function completeJob(
  state: AppState,
  id: string,
  actualQuantityMt: number,
  completionNote?: string,
  nowIso = new Date().toISOString(),
): AppState {
  const current = requireJob(state, id);
  if (current.status !== "running") {
    throw new Error("Only a running job can be completed.");
  }
  assertActualQuantity(actualQuantityMt);
  const normalizedNote = optionalNote(completionNote, "Completion note");
  assertIsoDateTime(nowIso, "Actual end");
  const actualEnd = new Date(nowIso).toISOString();
  if (
    current.actualStart &&
    new Date(actualEnd).getTime() < new Date(current.actualStart).getTime()
  ) {
    throw new Error("Actual end cannot be earlier than actual start.");
  }
  const openPause = current.pauseIntervals?.at(-1)?.resumedAt === null
    ? current.pauseIntervals.at(-1)
    : undefined;
  if (openPause && Date.parse(actualEnd) < Date.parse(openPause.pausedAt)) {
    throw new Error("Actual end cannot be earlier than the active pause.");
  }
  const pauseIntervals = current.pauseIntervals?.map((pause, index, pauses) => ({
    ...pause,
    resumedAt: index === pauses.length - 1 && pause.resumedAt === null ? actualEnd : pause.resumedAt,
  }));
  const frozenSegments = (
    current.lockedSegments ?? scheduleState(state).byId.get(id)?.segments ?? []
  ).map((segment) => ({ ...segment }));
  const changedAt = actualEnd;
  const priorIssueReason = current.issue?.reason;
  const jobs = state.jobs.map((job) => {
    if (job.id !== id) return job;
    const { issue: _issue, completionNote: _completionNote, ...withoutIssue } = job;
    return {
      ...withoutIssue,
      status: "completed" as const,
      actualEnd,
      actualQuantityMt,
      ...(frozenSegments.length > 0 ? { lockedSegments: frozenSegments } : {}),
      ...(normalizedNote ? { completionNote: normalizedNote } : {}),
      ...(pauseIntervals ? { pauseIntervals } : {}),
      updatedAt: changedAt,
    };
  });
  const varianceMt = actualQuantityMt - current.quantityMt;
  const details = [
    `Completed order ${current.orderNo} at ${formatMt(actualQuantityMt)} actual output`,
    `planned ${formatMt(current.quantityMt)}`,
    `variance ${formatSignedMt(varianceMt)}`,
  ];
  if (normalizedNote) details.push(`note: ${normalizedNote}`);
  if (priorIssueReason) details.push(`resolved issue: ${priorIssueReason}`);
  return withEvent(
    state,
    jobs,
    event(
      "job.completed",
      `${details.join("; ")}.`,
      id,
      changedAt,
      getJobHistoryChanges(current, jobFrom(jobs, id), { includePauseState: Boolean(openPause) }),
    ),
  );
}

export function recordActualOutput(
  state: AppState,
  id: string,
  actualQuantityMt: number,
  completionNote?: string,
): AppState {
  const current = requireJob(state, id);
  if (current.status !== "completed") {
    throw new Error("Actual output can only be recorded for a completed job.");
  }
  assertActualQuantity(actualQuantityMt);
  const normalizedNote =
    completionNote === undefined
      ? current.completionNote
      : optionalNote(completionNote, "Completion note");
  const now = new Date().toISOString();
  const jobs = state.jobs.map((job) => {
    if (job.id !== id) return job;
    const { completionNote: _completionNote, ...withoutNote } = job;
    return {
      ...withoutNote,
      actualQuantityMt,
      ...(normalizedNote ? { completionNote: normalizedNote } : {}),
      updatedAt: now,
    };
  });
  const varianceMt = actualQuantityMt - current.quantityMt;
  const priorActual =
    typeof current.actualQuantityMt === "number" && Number.isFinite(current.actualQuantityMt)
      ? current.actualQuantityMt
      : null;
  const action =
    priorActual === null
      ? `Recorded actual output for order ${current.orderNo}: ${formatMt(actualQuantityMt)}`
      : `Corrected actual output for order ${current.orderNo} from ${formatMt(priorActual)} to ${formatMt(actualQuantityMt)}`;
  const details = [`planned ${formatMt(current.quantityMt)}`, `variance ${formatSignedMt(varianceMt)}`];
  if (normalizedNote) details.push(`note: ${normalizedNote}`);
  else if (completionNote !== undefined && current.completionNote) details.push("completion note cleared");
  return withEvent(
    state,
    jobs,
    event(
      "job.actual-output-recorded",
      `${action}; ${details.join("; ")}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function cancelJob(state: AppState, id: string): AppState {
  const current = requireJob(state, id);
  requirePending(current, "cancel");
  const now = new Date().toISOString();
  const jobs = state.jobs.map((job) => {
    if (job.id !== id) return job;
    const { issue: _issue, ...withoutIssue } = job;
    return { ...withoutIssue, status: "cancelled" as const, updatedAt: now };
  });
  return withEvent(
    state,
    jobs,
    event(
      "job.cancelled",
      `Cancelled order ${current.orderNo}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function reportJobIssue(
  state: AppState,
  id: string,
  reason: string,
): AppState {
  const current = requireJob(state, id);
  if (current.status !== "pending" && current.status !== "running") {
    throw new Error("Only a pending or running job can report an issue.");
  }
  const normalizedReason = requiredText(reason, "Issue reason");
  const now = new Date().toISOString();
  const jobs = state.jobs.map((job) =>
    job.id === id
      ? {
          ...job,
          issue: { reason: normalizedReason, reportedAt: now },
          updatedAt: now,
        }
      : job,
  );
  return withEvent(
    state,
    jobs,
    event(
      "job.issue-reported",
      `Reported issue for order ${current.orderNo}: ${normalizedReason}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function resolveJobIssue(state: AppState, id: string): AppState {
  const current = requireJob(state, id);
  if (!current.issue) {
    throw new Error("This job has no issue to resolve.");
  }
  const now = new Date().toISOString();
  const jobs = state.jobs.map((job) => {
    if (job.id !== id) return job;
    const { issue: _issue, ...withoutIssue } = job;
    return { ...withoutIssue, updatedAt: now };
  });
  return withEvent(
    state,
    jobs,
    event(
      "job.issue-resolved",
      `Resolved issue for order ${current.orderNo}: ${current.issue.reason}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function confirmBin(state: AppState, id: string): AppState {
  const current = requireJob(state, id);
  if (current.status === "cancelled") {
    throw new Error("A cancelled job cannot have its bin confirmed.");
  }
  if (!current.binNeedsReview) return state;
  const now = new Date().toISOString();
  const jobs = state.jobs.map((job) =>
    job.id === id ? { ...job, binNeedsReview: false, updatedAt: now } : job,
  );
  return withEvent(
    state,
    jobs,
    event(
      "job.bin-confirmed",
      `Confirmed bin for order ${current.orderNo}.`,
      id,
      now,
      getJobHistoryChanges(current, jobFrom(jobs, id)),
    ),
  );
}

export function pauseJob(
  state: AppState,
  id: string,
  reason: string,
  nowIso = new Date().toISOString(),
): AppState {
  const current = requireJob(state, id);
  if (current.status !== "running") throw new Error("Only a running job can be paused.");
  if (current.pauseIntervals?.at(-1)?.resumedAt === null) throw new Error("This job is already paused.");
  const normalizedReason = optionalNote(reason, "Pause reason");
  if (!normalizedReason) throw new Error("Pause reason is required.");
  assertIsoDateTime(nowIso, "Pause time");
  const pausedAt = new Date(nowIso).toISOString();
  if (!current.actualStart || Date.parse(pausedAt) < Date.parse(current.actualStart)) {
    throw new Error("Pause time cannot be earlier than actual start.");
  }
  const previousResume = current.pauseIntervals?.at(-1)?.resumedAt;
  if (previousResume && Date.parse(pausedAt) < Date.parse(previousResume)) {
    throw new Error("Pause time cannot be earlier than the previous resume time.");
  }
  const jobs = state.jobs.map((job) => job.id === id ? {
    ...job,
    pauseIntervals: [
      ...(job.pauseIntervals?.map((pause) => ({ ...pause })) ?? []),
      { pausedAt, resumedAt: null, reason: normalizedReason },
    ],
    updatedAt: pausedAt,
  } : job);
  return withEvent(
    state,
    jobs,
    event(
      "job.paused",
      `Paused order ${current.orderNo}: ${normalizedReason}.`,
      id,
      pausedAt,
      getJobHistoryChanges(current, jobFrom(jobs, id), { includePauseState: true }),
    ),
  );
}

export function resumeJob(
  state: AppState,
  id: string,
  nowIso = new Date().toISOString(),
): AppState {
  const current = requireJob(state, id);
  if (current.status !== "running") throw new Error("Only a running job can be resumed.");
  const openPause = current.pauseIntervals?.at(-1);
  if (!openPause || openPause.resumedAt !== null) throw new Error("This job is not paused.");
  assertIsoDateTime(nowIso, "Resume time");
  const resumedAt = new Date(nowIso).toISOString();
  if (Date.parse(resumedAt) < Date.parse(openPause.pausedAt)) {
    throw new Error("Resume time cannot be earlier than pause time.");
  }
  const jobs = state.jobs.map((job) => job.id === id ? {
    ...job,
    pauseIntervals: job.pauseIntervals!.map((pause, index, pauses) =>
      index === pauses.length - 1 ? { ...pause, resumedAt } : { ...pause },
    ),
    updatedAt: resumedAt,
  } : job);
  return withEvent(
    state,
    jobs,
    event(
      "job.resumed",
      `Resumed order ${current.orderNo}.`,
      id,
      resumedAt,
      getJobHistoryChanges(current, jobFrom(jobs, id), { includePauseState: true }),
    ),
  );
}

export function updateSettings(state: AppState, settings: Settings): AppState {
  validateSettings(settings);
  if (!state.settings.calendarCutover && settings.calendarCutover) {
    throw new Error("Use calendar activation to create production calendar cutover metadata.");
  }
  if (state.settings.calendarCutover && JSON.stringify(settings.calendarCutover) !== JSON.stringify(state.settings.calendarCutover)) {
    throw new Error("Production calendar cutover metadata cannot be edited in ordinary settings.");
  }
  if (state.settings.calendarCutover && (settings.dayStart !== state.settings.dayStart || settings.availableHours !== state.settings.availableHours)) {
    throw new Error("Production hours cannot be changed after the calendar cutover is activated.");
  }
  const now = new Date().toISOString();
  const copiedSettings = cloneSettings(settings);
  const jobs = state.jobs.map((job) => {
    if (job.mode !== "bags" || job.status !== "pending" || job.sourceOrderId || job.bagWeightKgSnapshot) return job;
    return {
      ...job,
      quantityMt: quantityFromBags(job.bagCount ?? 0, copiedSettings.bagWeightKg),
      updatedAt: now,
    };
  });
  return finalizeMutation(
    { ...state, settings: copiedSettings },
    jobs,
    event(
      "settings.updated",
      "Updated planning settings.",
      undefined,
      now,
      getSettingsHistoryChanges(state.settings, copiedSettings),
    ),
  );
}

export function createCatalogProduct(
  state: AppState,
  input: CatalogCreateInput,
  nowIso = new Date().toISOString(),
): AppState {
  assertIsoDateTime(nowIso, "Catalog update time");
  const normalized = normalizeCatalogInput(input);
  assertUniqueCatalogCode(state.catalog, normalized.code);
  const product: CatalogProduct = {
    id: makeId("product"),
    ...normalized,
    active: true,
  };
  return {
    ...state,
    catalog: [...state.catalog.map(cloneCatalogProduct), product],
    events: [
      ...state.events,
      event(
        "catalog.created",
        `Created catalog product ${product.code}.`,
        undefined,
        nowIso,
        getCatalogHistoryChanges(null, product),
      ),
    ],
  };
}

export function updateCatalogProduct(
  state: AppState,
  productId: string,
  patch: CatalogUpdatePatch,
  nowIso = new Date().toISOString(),
): AppState {
  assertIsoDateTime(nowIso, "Catalog update time");
  const current = requireCatalogProduct(state, productId);
  if (Object.keys(patch).length === 0) throw new Error("Catalog update must contain at least one change.");
  const normalized = normalizeCatalogInput({
    code: patch.code ?? current.code,
    description: patch.description ?? current.description,
    defaultMode: patch.defaultMode ?? current.defaultMode,
  });
  assertUniqueCatalogCode(state.catalog, normalized.code, current.id);
  return {
    ...state,
    catalog: state.catalog.map((product) =>
      product.id === current.id ? { ...product, ...normalized } : cloneCatalogProduct(product),
    ),
    events: [
      ...state.events,
      event(
        "catalog.updated",
        `Updated catalog product ${normalized.code}.`,
        undefined,
        nowIso,
        getCatalogHistoryChanges(current, { ...current, ...normalized }),
      ),
    ],
  };
}

export function setCatalogProductActive(
  state: AppState,
  productId: string,
  active: boolean,
  nowIso = new Date().toISOString(),
): AppState {
  assertIsoDateTime(nowIso, "Catalog update time");
  if (typeof active !== "boolean") throw new Error("Catalog active state must be true or false.");
  const current = requireCatalogProduct(state, productId);
  return {
    ...state,
    catalog: state.catalog.map((product) =>
      product.id === current.id ? { ...product, active } : cloneCatalogProduct(product),
    ),
    events: [
      ...state.events,
      event(
        "catalog.activation-changed",
        `${active ? "Activated" : "Deactivated"} catalog product ${current.code}.`,
        undefined,
        nowIso,
        getCatalogHistoryChanges(current, { ...current, active }),
      ),
    ],
  };
}

export function copyJobBatch(
  state: AppState,
  sourceDate: string,
  targetDate: string,
  items: CopyBatchItem[],
  nowIso = new Date().toISOString(),
): AppState {
  assertDate(sourceDate, "Source date");
  assertDate(targetDate, "Target date");
  assertIsoDateTime(nowIso, "Copy time");
  if (sourceDate === targetDate) throw new Error("Target date must differ from source date.");
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    throw new Error("Copy batch must contain between 1 and 500 items.");
  }
  if (state.jobs.length + items.length > 10_000) {
    throw new Error("Copy batch would exceed the workspace limit of 10000 jobs.");
  }

  const seen = new Set<string>();
  const validated = items.map((item, index) => {
    const sourceJobId = boundedReference(item.sourceJobId, `Copy item ${index + 1} source job id`);
    const orderNo = boundedReference(item.orderNo, `Copy item ${index + 1} order number`);
    if (seen.has(sourceJobId)) throw new Error(`Source job ${sourceJobId} is duplicated in the copy batch.`);
    seen.add(sourceJobId);
    const source = requireJob(state, sourceJobId);
    if (source.date !== sourceDate) throw new Error(`Source job ${sourceJobId} is not on ${sourceDate}.`);
    if (source.status === "cancelled") throw new Error(`Cancelled source job ${sourceJobId} cannot be copied.`);
    if (getJobSourceAllocations(source).length) throw new Error(`Imported source job ${sourceJobId} cannot be copied.`);
    if (!item.quantity || item.quantity.mode !== source.mode) {
      throw new Error(`Copy quantity mode for source job ${sourceJobId} must match ${source.mode}.`);
    }
    if (item.quantity.mode === "bags") {
      assertFiniteNonnegative(item.quantity.bagCount, `Copy item ${index + 1} bag count`);
    } else {
      assertFiniteNonnegative(item.quantity.quantityMt, `Copy item ${index + 1} quantity`);
    }
    return { source, orderNo, quantity: item.quantity };
  });

  validated.sort((left, right) => compareJobs(left.source, right.source));
  const nextSequence = new Map<LineId, number>(
    LINE_IDS.map((lineId) => [
      lineId,
      Math.max(
        0,
        ...state.jobs
          .filter((job) => job.date === targetDate && job.lineId === lineId)
          .map((job) => job.sequence),
      ),
    ]),
  );
  const copied = validated.map(({ source, orderNo, quantity }): Job => {
    const sequence = (nextSequence.get(source.lineId) ?? 0) + 1;
    nextSequence.set(source.lineId, sequence);
    const bags = quantity.mode === "bags" ? quantity.bagCount : null;
    return {
      ...(source.inventoryItemId ? { inventoryItemId: source.inventoryItemId, medication: source.medication ?? '', fmrOmed: source.fmrOmed ?? '', productionPurpose: source.productionPurpose ?? 'mts' } : {}),
      ...(source.bagWeightKgSnapshot ? { bagWeightKgSnapshot: source.bagWeightKgSnapshot } : {}),
      id: makeId("job"),
      date: targetDate,
      lineId: source.lineId,
      sequence,
      orderNo,
      productCode: source.productCode,
      description: source.description,
      bin: source.bin,
      mode: quantity.mode,
      bagCount: bags,
      quantityMt: quantity.mode === "bags"
        ? quantityFromBags(quantity.bagCount, source.bagWeightKgSnapshot ?? state.settings.bagWeightKg)
        : quantity.quantityMt,
      status: "pending",
      remarks: source.remarks,
      actualStart: null,
      actualEnd: null,
      binNeedsReview: source.binNeedsReview,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });

  return finalizeMutation(
    state,
    [...state.jobs, ...copied],
    event(
      "plan.copied",
      `Copied ${copied.length} production ${copied.length === 1 ? "job" : "jobs"} from ${sourceDate} to ${targetDate}.`,
      undefined,
      nowIso,
    ),
  );
}

export function combinePendingJobs(
  state: AppState,
  jobIds: string[],
  bin: string,
  remarks: string,
  nowIso = new Date().toISOString(),
): AppState {
  assertIsoDateTime(nowIso, "Combine time");
  if (!Array.isArray(jobIds) || jobIds.length < 2 || jobIds.length > 500) {
    throw new Error("Choose between 2 and 500 production cards to combine.");
  }
  const uniqueIds = [...new Set(jobIds)];
  if (uniqueIds.length !== jobIds.length) throw new Error("A production card cannot be selected more than once.");
  const members = uniqueIds.map(id => requireJob(state, id)).sort(compareJobs);
  for (const member of members) requirePending(member, "combine");
  const survivor = members[0];
  if (members.some(job => getProductionBatchIdentity(job) !== getProductionBatchIdentity(survivor))) {
    throw new Error("Combined cards must share the same date, line, product, unit, bag weight and inventory variant.");
  }
  const allocations = members.flatMap(getJobSourceAllocations);
  if (allocations.length > 500) throw new Error("A combined card can contain at most 500 source orders.");
  if (members.some(job => getJobSourceAllocations(job).length === 0) || new Set(allocations.map(row => row.sourceOrderId)).size !== allocations.length) {
    throw new Error("Only distinct source-order cards can be combined.");
  }
  if (typeof bin !== "string" || bin.length > 200) throw new Error("Destination bin must be text of 200 characters or fewer.");
  const normalizedBin = bin.trim();
  const normalizedRemarks = optionalNote(remarks, "Remarks") ?? "";
  const bagCount = survivor.mode === "bags" ? members.reduce((sum, job) => sum + (job.bagCount ?? 0), 0) : null;
  const quantityMt = members.reduce((sum, job) => sum + job.quantityMt, 0);
  const orderNo = `${allocations[0].sourceSnapshot.doNo} +${allocations.length - 1}`;
  const memberIds = new Set(members.map(job => job.id));
  let jobs = state.jobs.map(job => {
    if (!memberIds.has(job.id)) return job;
    if (job.id !== survivor.id) return { ...job, status: "cancelled" as const, updatedAt: nowIso };
    const {
      sourceOrderId: _sourceOrderId,
      sourceOrderVersion: _sourceOrderVersion,
      sourceSnapshot: _sourceSnapshot,
      ...withoutLegacySource
    } = job;
    return {
      ...withoutLegacySource,
      orderNo,
      bin: normalizedBin,
      remarks: normalizedRemarks,
      bagCount,
      quantityMt,
      sourceAllocations: allocations.map(allocation => ({ ...allocation, sourceSnapshot: { ...allocation.sourceSnapshot } })),
      updatedAt: nowIso,
    };
  });
  jobs = resequence(jobs, survivor.lineId, survivor.date);
  return finalizeMutation(state, jobs, event(
    "job.combined",
    `Combined ${members.length} source-order cards into ${orderNo}.`,
    survivor.id,
    nowIso,
    getJobHistoryChanges(survivor, jobFrom(jobs, survivor.id)),
  ));
}

function normalizeCatalogInput(input: CatalogCreateInput): CatalogCreateInput {
  const code = boundedCatalogText(input.code, "Catalog code", 80);
  const description = boundedCatalogText(input.description, "Catalog description", 200);
  if (input.defaultMode !== "bags" && input.defaultMode !== "bulk") {
    throw new Error("Catalog default mode must be bags or bulk.");
  }
  return { code, description, defaultMode: input.defaultMode };
}

function assertUniqueCatalogCode(catalog: CatalogProduct[], code: string, exceptId?: string): void {
  const key = code.toLowerCase();
  if (catalog.some((product) => product.id !== exceptId && product.code.trim().toLowerCase() === key)) {
    throw new Error(`Catalog code ${code} already exists.`);
  }
}

function requireCatalogProduct(state: AppState, productId: string): CatalogProduct {
  const normalizedId = boundedReference(productId, "Catalog product id");
  const product = state.catalog.find((candidate) => candidate.id === normalizedId);
  if (!product) throw new Error(`Catalog product ${normalizedId} was not found.`);
  return product;
}

function cloneCatalogProduct(product: CatalogProduct): CatalogProduct {
  return { ...product };
}

function boundedCatalogText(value: string, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function boundedReference(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > 120) throw new Error(`${label} must be 120 characters or fewer.`);
  return trimmed;
}

function assertFiniteNonnegative(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite number zero or greater.`);
  }
}

function scheduleState(state: AppState): ScheduleResult {
  const byLine: Record<LineId, ScheduledJob[]> = {
    PM1: [],
    PM2: [],
    PM3: [],
    PM4: [],
  };
  const byId = new Map<string, ScheduledJob>();

  for (const lineId of LINE_IDS) {
    const jobs = state.jobs
      .filter(
        (job) =>
          job.lineId === lineId &&
          job.status !== "cancelled" &&
          job.quantityMt > 0,
      )
      .sort(compareJobs);
    const fixed = jobs
      .flatMap((job) => job.lockedSegments ?? [])
      .filter((segment) => segment.lineId === lineId)
      .map((segment) => ({ start: segment.start, end: segment.end }))
      .sort(compareIntervals);
    let cursor: number | null = null;
    let previousJob: Job | null = null;

    for (const job of jobs) {
      const rate = getRate(state.settings, lineId, job.productCode);
      const durationMinutes = (job.quantityMt / rate) * 60;
      const needsChangeover = previousJob !== null && (
        previousJob.sourceOrderId || job.sourceOrderId || previousJob.inventoryItemId || job.inventoryItemId
          ? normalizedProduct(previousJob.productCode) !== normalizedProduct(job.productCode)
          : productFamily(previousJob.productCode) !== productFamily(job.productCode)
      ) || (previousJob !== null && ((previousJob.medication ?? '').trim().toLowerCase() !== (job.medication ?? '').trim().toLowerCase() || (previousJob.fmrOmed ?? '').trim().toLowerCase() !== (job.fmrOmed ?? '').trim().toLowerCase()));
      let segments: ScheduleSegment[] = [];
      let changeoverMinutes = needsChangeover
        ? state.settings.changeoverMinutes
        : 0;

      if (job.lockedSegments && job.lockedSegments.length > 0) {
        segments = job.lockedSegments
          .filter((segment) => segment.lineId === lineId)
          .map((segment) => ({ ...segment, jobId: job.id }))
          .sort(compareSegments);
        changeoverMinutes = minutesForKind(segments, "changeover");
      } else {
        const calendar = getCalendarForDate(state.settings, job.date);
        if (calendar.availableHours <= 0) {
          const scheduledJob: ScheduledJob = {
            ...cloneJob(job), plannedStart: null, plannedEnd: null, durationMinutes, rate,
            changeoverMinutes, segments: [], overflow: false,
          };
          byLine[lineId].push(scheduledJob);
          byId.set(job.id, scheduledJob);
          previousJob = job;
          continue;
        }
        let phaseCursor = Math.max(
          cursor ?? Number.NEGATIVE_INFINITY,
          businessDayStart(job.date, calendar.dayStart),
          job.notBefore ? Date.parse(job.notBefore) : Number.NEGATIVE_INFINITY,
        );
        if (changeoverMinutes > 0) {
          const changeover = allocateWork(
            calendar,
            lineId,
            job.id,
            "changeover",
            phaseCursor,
            changeoverMinutes,
            fixed,
          );
          if (changeover) {
            segments.push(...changeover);
            phaseCursor = changeover.at(-1)!.end;
          } else {
            changeoverMinutes = 0;
          }
        }
        const production = allocateWork(
          calendar,
          lineId,
          job.id,
          "production",
          phaseCursor,
          durationMinutes,
          fixed,
        );
        if (production) segments.push(...production);
      }

      const plannedStart = minOrNull(segments.map((segment) => segment.start));
      const plannedEnd = maxOrNull(segments.map((segment) => segment.end));
      if (plannedEnd !== null) cursor = Math.max(cursor ?? plannedEnd, plannedEnd);
      const jobCalendar = getCalendarForDate(state.settings, job.date);
      const businessEnd = businessDayStart(job.date, jobCalendar.dayStart) + jobCalendar.availableHours * 60 * MINUTE_MS;
      const scheduledJob: ScheduledJob = {
        ...cloneJob(job),
        plannedStart,
        plannedEnd,
        durationMinutes,
        rate,
        changeoverMinutes,
        segments,
        overflow: plannedEnd !== null && plannedEnd > businessEnd,
      };
      byLine[lineId].push(scheduledJob);
      byId.set(job.id, scheduledJob);
      previousJob = job;
    }
    const lineSegments = byLine[lineId].flatMap(job => job.segments).sort(compareSegments);
    for (let index = 1; index < lineSegments.length; index += 1) {
      if (lineSegments[index].start < lineSegments[index - 1].end - 0.001) {
        throw new Error(`Schedule on ${lineId} contains overlapping production time.`);
      }
    }
  }

  return { byLine, byId };
}

function allocateWork(
  settings: Settings,
  lineId: LineId,
  jobId: string,
  kind: ScheduleSegment["kind"],
  earliest: number,
  minutes: number,
  fixed: Interval[],
): ScheduleSegment[] | null {
  if (minutes <= 0) return [];
  let remainingMs = minutes * MINUTE_MS;
  let cursor = earliest;
  let date = businessDateAtOrBefore(cursor, settings.dayStart);
  const segments: ScheduleSegment[] = [];

  for (let searched = 0; searched < MAX_SEARCH_DAYS; searched += 1) {
    const intervals = subtractIntervals(
      getAvailableIntervals(settings, lineId, date),
      fixed,
    );
    for (const interval of intervals) {
      const start = Math.max(cursor, interval.start);
      if (start >= interval.end) continue;
      const usedMs = Math.min(remainingMs, interval.end - start);
      segments.push({
        jobId,
        lineId,
        kind,
        start,
        end: start + usedMs,
      });
      remainingMs -= usedMs;
      cursor = start + usedMs;
      if (remainingMs <= 0.001) return segments;
    }
    date = addDays(date, 1);
    cursor = Math.max(cursor, businessDayStart(date, settings.dayStart));
  }
  return null;
}

function getAvailableIntervals(
  settings: Settings,
  lineId: LineId,
  date: string,
): Interval[] {
  if (settings.availableHours <= 0) return [];
  const start = businessDayStart(date, settings.dayStart);
  const available: Interval[] = [
    { start, end: start + settings.availableHours * 60 * MINUTE_MS },
  ];
  const downtime = settings.downtime
    .filter(
      (item) => item.date === date && (item.lineId === "all" || item.lineId === lineId),
    )
    .map((item) => downtimeInterval(item, settings.dayStart));
  return subtractIntervals(available, downtime);
}

function downtimeInterval(item: Downtime, dayStart: string): Interval {
  const businessStart = businessDayStart(item.date, dayStart);
  const dayStartMinutes = timeToMinutes(dayStart, "Day start");
  const startClock = timeToMinutes(item.start, "Downtime start");
  const endClock = timeToMinutes(item.end, "Downtime end");
  let startOffset = startClock - dayStartMinutes;
  let endOffset = endClock - dayStartMinutes;
  if (startOffset < 0) startOffset += 24 * 60;
  if (endOffset < 0) endOffset += 24 * 60;
  if (endOffset <= startOffset) endOffset += 24 * 60;
  return {
    start: businessStart + startOffset * MINUTE_MS,
    end: businessStart + endOffset * MINUTE_MS,
  };
}

function subtractIntervals(source: Interval[], blocks: Interval[]): Interval[] {
  let result = source.map((interval) => ({ ...interval }));
  for (const block of blocks.filter(validInterval).sort(compareIntervals)) {
    result = result.flatMap((interval) => {
      if (block.end <= interval.start || block.start >= interval.end) return [interval];
      const pieces: Interval[] = [];
      if (block.start > interval.start) {
        pieces.push({ start: interval.start, end: Math.min(block.start, interval.end) });
      }
      if (block.end < interval.end) {
        pieces.push({ start: Math.max(block.end, interval.start), end: interval.end });
      }
      return pieces.filter(validInterval);
    });
  }
  return result.sort(compareIntervals);
}

function finalizeMutation(
  state: AppState,
  jobs: Job[],
  historyEvent: HistoryEvent,
): AppState {
  const next = withEvent(state, jobs, historyEvent);
  validateFutureDayCollisions(next);
  return next;
}

function validateFutureDayCollisions(state: AppState): void {
  const scheduled = scheduleState(state);
  for (const lineId of LINE_IDS) {
    const segments = scheduled.byLine[lineId].flatMap(job => job.segments).sort(compareSegments);
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index].start < segments[index - 1].end - 0.001) {
        throw new Error(`Schedule on ${lineId} contains overlapping production time.`);
      }
    }
  }
}

export function getCalendarForDate(settings: Settings, assignedDate: string): Settings {
  const cutover = settings.calendarCutover;
  if (!cutover || assignedDate >= cutover.effectiveFrom) return settings;
  return { ...settings, dayStart: cutover.priorDayStart, availableHours: cutover.priorAvailableHours };
}

function normalizedProduct(value: string): string {
  return value.trim().toLocaleUpperCase("en-US");
}

function normalizeInput(input: JobInput, settings: Settings): JobInput {
  assertDate(input.date, "Job date");
  assertLineId(input.lineId);
  const orderNo = requiredText(input.orderNo, "Order number");
  const productCode = requiredText(input.productCode, "Product code");
  const description = input.description.trim();
  const bin = input.bin.trim();
  const remarks = optionalNote(input.remarks, "Remarks") ?? "";
  if (input.mode !== "bags" && input.mode !== "bulk") {
    throw new Error("Quantity mode must be bags or bulk.");
  }
  if (input.bagCount !== null && (!Number.isFinite(input.bagCount) || input.bagCount < 0)) {
    throw new Error("Bag count must be zero or greater.");
  }
  if (!Number.isFinite(input.quantityMt) || input.quantityMt < 0) {
    throw new Error("Quantity must be zero or greater.");
  }
  if (input.mode === "bags" && input.bagCount === null) {
    throw new Error("Bag count is required for bag quantities.");
  }
  return {
    ...(input.inventoryItemId ? { inventoryItemId: input.inventoryItemId } : {}),
    ...(input.productionPurpose ? { productionPurpose: input.productionPurpose } : {}),
    ...(input.medication !== undefined ? { medication: input.medication.trim() } : {}),
    ...(input.fmrOmed !== undefined ? { fmrOmed: input.fmrOmed.trim() } : {}),
    ...(input.bagWeightKgSnapshot ? { bagWeightKgSnapshot: input.bagWeightKgSnapshot } : {}),
    ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    date: input.date,
    lineId: input.lineId,
    orderNo,
    productCode,
    description,
    bin,
    mode: input.mode,
    bagCount: input.mode === "bags" ? input.bagCount : null,
    quantityMt:
      input.mode === "bags"
        ? quantityFromBags(input.bagCount ?? 0, input.bagWeightKgSnapshot ?? settings.bagWeightKg)
        : input.quantityMt,
    remarks,
  };
}

function validateSettings(settings: Settings): void {
  requiredText(settings.siteName, "Site name");
  requiredText(settings.timeZone, "Time zone");
  timeToMinutes(settings.dayStart, "Day start");
  if (!Number.isFinite(settings.availableHours) || settings.availableHours < 0 || settings.availableHours > 24) {
    throw new Error("Available hours must be between 0 and 24.");
  }
  if (!Number.isFinite(settings.changeoverMinutes) || settings.changeoverMinutes < 0) {
    throw new Error("Changeover minutes must be zero or greater.");
  }
  if (!Number.isFinite(settings.bagWeightKg) || settings.bagWeightKg <= 0) {
    throw new Error("Bag weight must be greater than zero.");
  }
  for (const lineId of LINE_IDS) {
    if (!Number.isFinite(settings.rates[lineId]) || settings.rates[lineId] <= 0) {
      throw new Error(`Rate for ${lineId} must be greater than zero.`);
    }
  }
  if (!Number.isFinite(settings.slowRatePM2) || settings.slowRatePM2 <= 0) {
    throw new Error("PM2 slow rate must be greater than zero.");
  }
  for (const downtime of settings.downtime) {
    requiredText(downtime.id, "Downtime id");
    assertDate(downtime.date, "Downtime date");
    if (downtime.lineId !== "all") assertLineId(downtime.lineId);
    timeToMinutes(downtime.start, "Downtime start");
    timeToMinutes(downtime.end, "Downtime end");
  }
  if (settings.calendarCutover) {
    assertDate(settings.calendarCutover.effectiveFrom, "Calendar cutover date");
    timeToMinutes(settings.calendarCutover.priorDayStart, "Prior day start");
    if (!Number.isFinite(settings.calendarCutover.priorAvailableHours) || settings.calendarCutover.priorAvailableHours < 0 || settings.calendarCutover.priorAvailableHours > 24) {
      throw new Error("Prior available hours must be between 0 and 24.");
    }
    assertIsoDateTime(settings.calendarCutover.activatedAt, "Calendar activation time");
  }
}

function withEvent(
  state: AppState,
  jobs: Job[],
  historyEvent: HistoryEvent,
): AppState {
  return {
    ...state,
    jobs,
    settings: cloneSettings(state.settings),
    events: [...state.events, historyEvent],
  };
}

function event(
  type: string,
  message: string,
  jobId?: string,
  at = new Date().toISOString(),
  changes: HistoryChange[] = [],
): HistoryEvent {
  return {
    id: makeId("event"),
    at,
    type,
    ...(jobId ? { jobId } : {}),
    message,
    ...(changes.length ? { changes } : {}),
  };
}

function resequence(jobs: Job[], lineId: LineId, date: string): Job[] {
  const orderedIds = jobs
    .filter((job) => job.lineId === lineId && job.date === date)
    .sort(compareJobs)
    .map((job) => job.id);
  const sequenceById = new Map(orderedIds.map((id, index) => [id, index + 1]));
  return jobs.map((job) =>
    sequenceById.has(job.id)
      ? { ...job, sequence: sequenceById.get(job.id)! }
      : job,
  );
}

function requireJob(state: AppState, id: string): Job {
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Job ${id} was not found.`);
  return job;
}

function jobFrom(jobs: Job[], id: string): Job {
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Job ${id} was not found after mutation.`);
  return job;
}

function requirePending(job: Job, action: string): void {
  if (job.status !== "pending") {
    const wording: Record<string, string> = {
      edit: "edited",
      move: "moved",
      start: "started",
      cancel: "cancelled",
      combine: "combined",
    };
    throw new Error(`Only a pending job can be ${wording[action] ?? action}.`);
  }
}

function toInput(job: Job): JobInput {
  return {
    ...(job.inventoryItemId ? { inventoryItemId: job.inventoryItemId } : {}),
    ...(job.productionPurpose ? { productionPurpose: job.productionPurpose } : {}),
    ...(job.medication !== undefined ? { medication: job.medication } : {}),
    ...(job.fmrOmed !== undefined ? { fmrOmed: job.fmrOmed } : {}),
    ...(job.bagWeightKgSnapshot ? { bagWeightKgSnapshot: job.bagWeightKgSnapshot } : {}),
    ...(job.notBefore ? { notBefore: job.notBefore } : {}),
    date: job.date,
    lineId: job.lineId,
    orderNo: job.orderNo,
    productCode: job.productCode,
    description: job.description,
    bin: job.bin,
    mode: job.mode,
    bagCount: job.bagCount,
    quantityMt: job.quantityMt,
    remarks: job.remarks,
  };
}

function cloneJob(job: Job): Job {
  return {
    ...job,
    lockedSegments: job.lockedSegments?.map((segment) => ({ ...segment })),
    ...(job.issue ? { issue: { ...job.issue } } : {}),
    ...(job.pauseIntervals ? { pauseIntervals: job.pauseIntervals.map((pause) => ({ ...pause })) } : {}),
    ...(job.sourceSnapshot ? { sourceSnapshot: { ...job.sourceSnapshot } } : {}),
    ...(job.sourceAllocations ? { sourceAllocations: job.sourceAllocations.map(allocation => ({ ...allocation, sourceSnapshot: { ...allocation.sourceSnapshot } })) } : {}),
  };
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    rates: { ...settings.rates },
    slowProductPrefixes: [...settings.slowProductPrefixes],
    downtime: settings.downtime.map((item) => ({ ...item })),
    ...(settings.calendarCutover ? { calendarCutover: { ...settings.calendarCutover } } : {}),
  };
}

function productFamily(productCode: string): string {
  return productCode.trim().slice(0, 4);
}

function quantityFromBags(bags: number, bagWeightKg: number): number {
  return (bags * bagWeightKg) / 1_000;
}

function businessDayStart(date: string, dayStart: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = dayStart.split(":").map(Number);
  return (
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) -
    MALAYSIA_OFFSET_MINUTES * MINUTE_MS
  );
}

function businessDateAtOrBefore(timestamp: number, dayStart: string): string {
  const malaysiaPoint = new Date(timestamp + MALAYSIA_OFFSET_MINUTES * MINUTE_MS);
  let date = formatUtcDate(malaysiaPoint);
  if (timestamp < businessDayStart(date, dayStart)) date = addDays(date, -1);
  return date;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return formatUtcDate(result);
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeToMinutes(value: string, label: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label} must use HH:mm in 24-hour time.`);
  }
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (formatUtcDate(parsed) !== value) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
}

function assertLineId(value: string): asserts value is LineId {
  if (!LINE_IDS.includes(value as LineId)) {
    throw new Error(`Unknown production line: ${value}.`);
  }
}

function assertIsoDateTime(value: string, label: string): void {
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`${label} must be a valid date and time.`);
  }
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function optionalNote(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new Error(`${label} must be ${MAX_NOTE_LENGTH} characters or fewer.`);
  }
  return trimmed || undefined;
}

function assertActualQuantity(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Actual quantity must be a finite number zero or greater.");
  }
}

function formatMt(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return `${Object.is(rounded, -0) ? 0 : rounded} MT`;
}

function formatSignedMt(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized > 0 ? "+" : ""}${normalized} MT`;
}

function makeId(prefix: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function compareJobs(a: Job, b: Job): number {
  return (
    a.date.localeCompare(b.date) ||
    a.sequence - b.sequence ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function compareIntervals(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end;
}

function compareSegments(a: ScheduleSegment, b: ScheduleSegment): number {
  return a.start - b.start || a.end - b.end;
}

function validInterval(interval: Interval): boolean {
  return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;
}

function minutesForKind(
  segments: ScheduleSegment[],
  kind: ScheduleSegment["kind"],
): number {
  return segments
    .filter((segment) => segment.kind === kind)
    .reduce((sum, segment) => sum + (segment.end - segment.start) / MINUTE_MS, 0);
}

function overlapMinutes(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) / MINUTE_MS;
}

function minOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function maxOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}
