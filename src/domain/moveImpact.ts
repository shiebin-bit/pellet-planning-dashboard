import { getBoard, getScheduledJobs, moveJob } from "./engine";
import { getJobSourceAllocations } from "./jobSources";
import type { AppState, Job, LineId } from "./types";

export interface MoveImpactInput {
  jobId: string;
  toLineId: LineId;
  beforeJobId?: string;
}

export interface PlannedRange {
  plannedStart: number | null;
  plannedEnd: number | null;
}

export interface ChangedJobRange {
  jobId: string;
  orderNo: string;
  assignedDate: string;
  beforeLineId: LineId;
  afterLineId: LineId;
  /** Destination/current line; retained as a convenient display alias. */
  lineId: LineId;
  before: PlannedRange;
  after: PlannedRange;
}

export interface MoveDueRisk {
  jobId: string;
  orderNo: string;
  sourceOrderId: string | null;
  dueDate: string | null;
  dueDateKnown: boolean;
  beforeLate: boolean | null;
  afterLate: boolean | null;
  beforePlannedEnd: number | null;
  afterPlannedEnd: number | null;
}

export interface MoveLineUtilization {
  lineId: LineId;
  before: number | null;
  after: number | null;
  beforeProductionMinutes: number;
  afterProductionMinutes: number;
  beforeAvailableMinutes: number;
  afterAvailableMinutes: number;
}

export interface MoveImpactPreview {
  baseRevision?: number;
  assignedDate: string;
  moved: ChangedJobRange;
  changedJobs: ChangedJobRange[];
  dueRisks: MoveDueRisk[];
  lineUtilization: MoveLineUtilization[];
}

export function previewMoveImpact(
  state: AppState,
  input: MoveImpactInput,
  baseRevision?: number,
): MoveImpactPreview {
  if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) {
    throw new Error("Move preview base revision must be a non-negative safe integer.");
  }
  const source = state.jobs.find(job => job.id === input.jobId);
  if (!source) throw new Error(`Job ${input.jobId} was not found.`);
  if (source.status !== "pending") throw new Error("Only a pending job can be previewed for a move.");

  const beforeScheduled = scheduleMap(state);
  let movedState: AppState;
  try {
    movedState = moveJob(state, input.jobId, input.toLineId, input.beforeJobId);
  } catch (error) {
    throw new Error(`Move preview failed: ${error instanceof Error ? error.message : "the requested move is invalid."}`);
  }
  assertProtectedJobsUnchanged(state, movedState);
  const afterScheduled = scheduleMap(movedState);
  const movedBefore = requireScheduled(beforeScheduled, source.id);
  const movedAfter = requireScheduled(afterScheduled, source.id);
  const moved = changedRange(movedBefore, movedAfter);

  const changedJobs = [...beforeScheduled.values()]
    .filter(job => job.id !== source.id)
    .map(job => changedRange(job, requireScheduled(afterScheduled, job.id)))
    .filter(change => !sameRange(change.before, change.after))
    .sort((left, right) => left.assignedDate.localeCompare(right.assignedDate) || left.lineId.localeCompare(right.lineId) || (left.before.plannedStart ?? Number.POSITIVE_INFINITY) - (right.before.plannedStart ?? Number.POSITIVE_INFINITY) || left.jobId.localeCompare(right.jobId));

  const compared = [moved, ...changedJobs];
  const dueRisks = compared.flatMap(change => dueRisksForJob(
    state.jobs.find(job => job.id === change.jobId)!,
    change.before.plannedEnd,
    change.after.plannedEnd,
  ));
  const beforeBoard = getBoard(state, source.date);
  const afterBoard = getBoard(movedState, source.date);
  const affectedLines = [...new Set<LineId>([source.lineId, input.toLineId])].sort();
  const lineUtilization = affectedLines.map(lineId => {
    const before = beforeBoard.lines.find(line => line.lineId === lineId)!;
    const after = afterBoard.lines.find(line => line.lineId === lineId)!;
    return {
      lineId,
      before: before.utilisation,
      after: after.utilisation,
      beforeProductionMinutes: before.productionMinutes,
      afterProductionMinutes: after.productionMinutes,
      beforeAvailableMinutes: before.availableMinutes,
      afterAvailableMinutes: after.availableMinutes,
    };
  });

  return {
    ...(baseRevision === undefined ? {} : { baseRevision }),
    assignedDate: source.date,
    moved,
    changedJobs,
    dueRisks,
    lineUtilization,
  };
}

type ImpactScheduledJob = Pick<Job, "id" | "orderNo" | "date" | "lineId"> & PlannedRange;

function scheduleMap(state: AppState): Map<string, ImpactScheduledJob> {
  const scheduled = new Map<string, ImpactScheduledJob>(getScheduledJobs(state).map(job => [job.id, job]));
  // Zero-quantity pending records are valid backlog cards and moveJob permits
  // rearranging them, even though the scheduler intentionally omits them.
  for (const job of state.jobs) {
    if (job.status === "pending" && job.quantityMt <= 0 && !scheduled.has(job.id)) {
      scheduled.set(job.id, { ...job, plannedStart: null, plannedEnd: null });
    }
  }
  return scheduled;
}

function requireScheduled(scheduled: Map<string, ImpactScheduledJob>, id: string): ImpactScheduledJob {
  const job = scheduled.get(id);
  if (!job) throw new Error(`Move preview cannot schedule job ${id}; check that it has a positive quantity and available capacity.`);
  return job;
}

function range(job: ImpactScheduledJob): PlannedRange {
  return { plannedStart: job.plannedStart, plannedEnd: job.plannedEnd };
}

function changedRange(before: ImpactScheduledJob, after: ImpactScheduledJob): ChangedJobRange {
  return {
    jobId: before.id,
    orderNo: before.orderNo,
    assignedDate: before.date,
    beforeLineId: before.lineId,
    afterLineId: after.lineId,
    lineId: after.lineId,
    before: range(before),
    after: range(after),
  };
}

function sameRange(left: PlannedRange, right: PlannedRange): boolean {
  return left.plannedStart === right.plannedStart && left.plannedEnd === right.plannedEnd;
}

function dueRisksForJob(
  job: Job,
  beforePlannedEnd: number | null,
  afterPlannedEnd: number | null,
): MoveDueRisk[] {
  const allocations = getJobSourceAllocations(job);
  if (!allocations.length) {
    return [{
      jobId: job.id,
      orderNo: job.orderNo,
      sourceOrderId: null,
      dueDate: null,
      dueDateKnown: false,
      beforeLate: null,
      afterLate: null,
      beforePlannedEnd,
      afterPlannedEnd,
    }];
  }
  return allocations.map(allocation => {
    const dueDate = allocation.sourceSnapshot.deliveryDate ?? null;
    const beforeDate = beforePlannedEnd === null ? null : malaysiaDate(beforePlannedEnd);
    const afterDate = afterPlannedEnd === null ? null : malaysiaDate(afterPlannedEnd);
    return {
      jobId: job.id,
      orderNo: allocation.sourceSnapshot.doNo,
      sourceOrderId: allocation.sourceOrderId,
      dueDate,
      dueDateKnown: dueDate !== null,
      beforeLate: dueDate === null || beforeDate === null ? null : beforeDate > dueDate,
      afterLate: dueDate === null || afterDate === null ? null : afterDate > dueDate,
      beforePlannedEnd,
      afterPlannedEnd,
    };
  });
}

function malaysiaDate(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function assertProtectedJobsUnchanged(before: AppState, after: AppState): void {
  const afterById = new Map(after.jobs.map(job => [job.id, job]));
  for (const job of before.jobs) {
    if (job.status === "pending") continue;
    const candidate = afterById.get(job.id);
    if (!candidate) throw new Error(`Move preview would remove protected ${job.status} job ${job.orderNo}.`);
    if (
      candidate.status !== job.status ||
      candidate.lineId !== job.lineId ||
      candidate.date !== job.date ||
      candidate.actualStart !== job.actualStart ||
      candidate.actualEnd !== job.actualEnd ||
      candidate.actualQuantityMt !== job.actualQuantityMt ||
      candidate.completionNote !== job.completionNote ||
      JSON.stringify(candidate.pauseIntervals ?? null) !== JSON.stringify(job.pauseIntervals ?? null) ||
      JSON.stringify(candidate.lockedSegments ?? null) !== JSON.stringify(job.lockedSegments ?? null)
    ) {
      throw new Error(`Move preview would alter protected ${job.status} job ${job.orderNo}; refresh the workspace before moving.`);
    }
  }
}
