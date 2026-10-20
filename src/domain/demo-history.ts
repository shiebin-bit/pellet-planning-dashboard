import { validateWorkspaceBackup } from "./backup";
import { getRate, getScheduledJobs } from "./engine";
import {
  LINE_IDS,
  type AppState,
  type HistoryEvent,
  type Job,
  type JobStatus,
  type LineId,
  type ScheduledJob,
} from "./types";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MALAYSIA_OFFSET_MS = 8 * 60 * MINUTE_MS;
const MAX_HISTORY_DAYS = 31;

const PRODUCTS = [
  { code: "6220-DEMO", description: "Fictional demo grower pellet batch" },
  { code: "6210-DEMO", description: "Fictional demo maintenance pellet batch" },
  { code: "6148-DEMO", description: "Fictional demo starter pellet batch" },
  { code: "6811-DEMO", description: "Fictional demo slow-rate pellet batch" },
  { code: "6542-DEMO", description: "Fictional demo specialty pellet batch" },
  { code: "6227-DEMO", description: "Fictional demo finisher pellet batch" },
  { code: "6315-DEMO", description: "Fictional demo breeder pellet batch" },
  { code: "6402-DEMO", description: "Fictional demo general pellet batch" },
] as const;

export interface DemoHistoryOptions {
  from: string;
  to: string;
  seed: number;
  now?: Date | string;
}

export type DemoHistorySkipReason = "occupied" | "unschedulable";

export interface DemoHistorySkippedLineDay {
  date: string;
  lineId: LineId;
  reason: DemoHistorySkipReason;
}

export interface DemoHistoryResult {
  state: AppState;
  jobs: Job[];
  events: HistoryEvent[];
  skipped: DemoHistorySkippedLineDay[];
}

interface DraftGroup {
  date: string;
  lineId: LineId;
  jobs: Job[];
  desiredStatus: Map<string, JobStatus>;
}

/**
 * Builds deterministic, explicitly fictional production history without mutating the source.
 * Each line-day is scheduled independently through the production engine, then the complete
 * candidate is validated and checked for changes to every pre-existing computed plan.
 */
export function generateDemoHistory(
  source: AppState,
  options: DemoHistoryOptions,
): DemoHistoryResult {
  const dates = historyDates(options.from, options.to, options.now);
  assertSeed(options.seed);

  const baseline = validateWorkspaceBackup(source);
  const beforePlans = existingPlanSignatures(baseline);
  const occupied = new Set(
    baseline.jobs.map((job) => lineDayKey(job.date, job.lineId)),
  );
  const existingJobIds = new Set(baseline.jobs.map((job) => job.id));
  const existingEventIds = new Set(baseline.events.map((event) => event.id));
  const nowMs = parseNow(options.now);
  const jobs: Job[] = [];
  const events: HistoryEvent[] = [];
  const skipped: DemoHistorySkippedLineDay[] = [];

  for (const date of dates) {
    for (const lineId of LINE_IDS) {
      if (occupied.has(lineDayKey(date, lineId))) {
        skipped.push({ date, lineId, reason: "occupied" });
        continue;
      }

      const group = createDraftGroup(baseline, date, lineId, options.seed);
      for (const job of group.jobs) {
        if (existingJobIds.has(job.id)) {
          throw new Error(`Synthetic history job id already exists: ${job.id}.`);
        }
      }
      const scheduled = scheduleDraftGroup(baseline, group);
      if (!scheduled || !fitsLineDay(scheduled, group, baseline, nowMs)) {
        skipped.push({ date, lineId, reason: "unschedulable" });
        continue;
      }

      const completed = materializeGroup(group, scheduled, options.seed);
      jobs.push(...completed);
      const batchEvent = createBatchEvent(group, completed);
      if (!existingEventIds.has(batchEvent.id)) events.push(batchEvent);

      const resolvedEvent = createResolvedIssueEvent(group, completed, options.seed);
      if (resolvedEvent && !existingEventIds.has(resolvedEvent.id)) {
        events.push(resolvedEvent);
      }
    }
  }

  const candidate = validateWorkspaceBackup({
    schemaVersion: 1,
    jobs: [...baseline.jobs, ...jobs],
    settings: baseline.settings,
    events: [...baseline.events, ...events],
  });
  assertExistingPlansUnchanged(beforePlans, candidate);

  const addedJobIds = new Set(jobs.map((job) => job.id));
  const addedEventIds = new Set(events.map((event) => event.id));
  return {
    state: candidate,
    jobs: candidate.jobs.filter((job) => addedJobIds.has(job.id)),
    events: candidate.events.filter((event) => addedEventIds.has(event.id)),
    skipped,
  };
}

export function historyDates(from: string, to: string, now?: Date | string): string[] {
  const start = dateTimestamp(from, "History start date");
  const end = dateTimestamp(to, "History end date");
  if (end < start) throw new Error("History end date must be on or after the start date.");
  const count = Math.round((end - start) / DAY_MS) + 1;
  if (count > MAX_HISTORY_DAYS) {
    throw new Error(`Synthetic history is limited to ${MAX_HISTORY_DAYS} calendar days.`);
  }
  const today = malaysiaDate(parseNow(now));
  if (to >= today) {
    throw new Error("Synthetic history dates must be before today in Malaysia time.");
  }
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10),
  );
}

export function malaysiaDate(value: Date | string | number = new Date()): string {
  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Current time must be a valid date and time.");
  return new Date(timestamp + MALAYSIA_OFFSET_MS).toISOString().slice(0, 10);
}

function createDraftGroup(
  state: AppState,
  date: string,
  lineId: LineId,
  seed: number,
): DraftGroup {
  const count = 6 + (randomInt(seed, date, lineId, "count") % 5 === 0 ? 1 : 0);
  const capacityMinutes = state.settings.availableHours * 60;
  const utilisation = 0.52 + (randomInt(seed, date, lineId, "utilisation") % 19) / 100;
  const targetMinutes = capacityMinutes * utilisation;
  const weights = Array.from(
    { length: count },
    (_, index) => 75 + (randomInt(seed, date, lineId, index, "weight") % 51),
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const issueIndex = randomInt(seed, date, lineId, "issue") % 11 === 0 ? count - 1 : -1;
  const cancelIndex = randomInt(seed, date, lineId, "cancel") % 6 === 0
    ? (issueIndex === count - 1 ? count - 2 : count - 1)
    : -1;
  const desiredStatus = new Map<string, JobStatus>();
  const createdAt = new Date(businessDayStart(date, state.settings.dayStart) - 60 * MINUTE_MS).toISOString();

  const jobs = Array.from({ length: count }, (_, index): Job => {
    const sequence = index + 1;
    const id = demoJobId(date, lineId, sequence);
    const product = PRODUCTS[
      randomInt(seed, date, lineId, index, "product") % PRODUCTS.length
    ];
    const mode = randomInt(seed, date, lineId, index, "mode") % 5 < 2 ? "bags" : "bulk";
    const minutes = targetMinutes * weights[index] / totalWeight;
    const rate = getRate(state.settings, lineId, product.code);
    const targetQuantity = Math.max(0.1, rate * minutes / 60);
    const bagCount = mode === "bags"
      ? Math.max(1, Math.round(targetQuantity * 1_000 / state.settings.bagWeightKg))
      : null;
    const quantityMt = bagCount === null
      ? round(targetQuantity, 1)
      : bagCount * state.settings.bagWeightKg / 1_000;
    const status: JobStatus = index === issueIndex
      ? "pending"
      : index === cancelIndex
        ? "cancelled"
        : "completed";
    desiredStatus.set(id, status);
    const reportedAt = new Date(
      businessDayStart(date, state.settings.dayStart) + Math.min(30 + index * 7, 120) * MINUTE_MS,
    ).toISOString();

    return {
      id,
      date,
      lineId,
      sequence,
      orderNo: `DEMO-HIST-${date.replaceAll("-", "")}-${lineId}-${String(sequence).padStart(2, "0")}`,
      productCode: product.code,
      description: product.description,
      bin: `D${String(1 + randomInt(seed, date, lineId, index, "bin") % 24).padStart(2, "0")}`,
      mode,
      bagCount,
      quantityMt,
      status: status === "cancelled" ? "cancelled" : "pending",
      remarks: `Fictional demo history only; not a customer or SAP order. Deterministic seed ${seed}.`,
      actualStart: null,
      actualEnd: null,
      binNeedsReview: randomInt(seed, date, lineId, index, "bin-review") % 31 === 0,
      createdAt,
      updatedAt: status === "pending" ? reportedAt : createdAt,
      ...(status === "pending"
        ? { issue: { reason: "Fictional demo issue awaiting an illustrative review.", reportedAt } }
        : {}),
    };
  });

  return { date, lineId, jobs, desiredStatus };
}

function scheduleDraftGroup(
  baseline: AppState,
  group: DraftGroup,
): Map<string, ScheduledJob> | null {
  const groupIds = new Set(group.jobs.map((job) => job.id));
  const scheduled = getScheduledJobs({ ...baseline, jobs: [...baseline.jobs, ...group.jobs] });
  const byId = new Map(
    scheduled.filter((job) => groupIds.has(job.id)).map((job) => [job.id, job]),
  );
  const activeCount = group.jobs.filter((job) => job.status !== "cancelled" && job.quantityMt > 0).length;
  return byId.size === activeCount ? byId : null;
}

function fitsLineDay(
  scheduled: Map<string, ScheduledJob>,
  group: DraftGroup,
  state: AppState,
  nowMs: number,
): boolean {
  const start = businessDayStart(group.date, state.settings.dayStart);
  const end = start + DAY_MS;
  for (const job of group.jobs) {
    if (job.status === "cancelled" || job.quantityMt <= 0) continue;
    const plan = scheduled.get(job.id);
    if (!plan || plan.plannedStart === null || plan.plannedEnd === null || plan.segments.length === 0) {
      return false;
    }
    if (plan.plannedStart < start || plan.plannedEnd > end || plan.plannedEnd >= nowMs) {
      return false;
    }
    if (plan.segments.some((segment) => segment.start < start || segment.end > end)) {
      return false;
    }
  }
  return true;
}

function materializeGroup(
  group: DraftGroup,
  scheduled: Map<string, ScheduledJob>,
  seed: number,
): Job[] {
  return group.jobs.map((job, index) => {
    const desiredStatus = group.desiredStatus.get(job.id)!;
    if (desiredStatus !== "completed") return { ...job, status: desiredStatus };
    const plan = scheduled.get(job.id);
    if (!plan || plan.plannedStart === null || plan.plannedEnd === null) {
      throw new Error(`Synthetic history job ${job.id} did not receive a schedule.`);
    }
    const actualStartMs = Math.min(
      plan.plannedEnd - MINUTE_MS,
      plan.plannedStart + (randomInt(seed, job.id, "start-delay") % 3) * MINUTE_MS,
    );
    const actualEndMs = Math.max(
      actualStartMs + MINUTE_MS,
      plan.plannedEnd - (randomInt(seed, job.id, "end-advance") % 4) * MINUTE_MS,
    );
    const actualVariant = randomInt(seed, job.id, "actual-output") % 100;
    const actualQuantity = actualVariant === 2
      ? 0
      : actualVariant < 41
        ? round(job.quantityMt * (0.96 + (actualVariant % 4) / 100), 3)
        : actualVariant < 79
          ? round(job.quantityMt * (1.01 + (actualVariant % 4) / 100), 3)
          : round(job.quantityMt, 3);
    const updatedAt = new Date(actualEndMs).toISOString();
    const actualFields = actualVariant === 0
      ? {}
      : actualVariant === 1
        ? { actualQuantityMt: null }
        : { actualQuantityMt: actualQuantity };

    return {
      ...job,
      status: "completed",
      actualStart: new Date(actualStartMs).toISOString(),
      actualEnd: updatedAt,
      ...actualFields,
      ...(actualVariant < 3
        ? { completionNote: "Fictional demo result with intentionally incomplete or zero output data." }
        : index % 9 === 0
          ? { completionNote: "Fictional demo batch completed for interface demonstration." }
          : {}),
      updatedAt,
      lockedSegments: plan.segments.map((segment) => ({ ...segment })),
    };
  });
}

function createBatchEvent(group: DraftGroup, jobs: Job[]): HistoryEvent {
  const completed = jobs.filter((job) => job.status === "completed");
  const at = completed.at(-1)?.actualEnd
    ?? new Date(businessDayStart(group.date, "08:30") + 5 * MINUTE_MS).toISOString();
  return {
    id: `DEMO-HIST-EVENT-BATCH-${group.date}-${group.lineId}`,
    at: at!,
    type: "demo.history.generated",
    message: `Fictional demo history: recorded ${jobs.length} illustrative ${group.lineId} jobs for ${group.date}.`,
  };
}

function createResolvedIssueEvent(
  group: DraftGroup,
  jobs: Job[],
  seed: number,
): HistoryEvent | null {
  if (randomInt(seed, group.date, group.lineId, "resolved-event") % 7 !== 0) return null;
  const job = jobs.find((candidate) => candidate.status === "completed");
  if (!job?.actualEnd) return null;
  return {
    id: `DEMO-HIST-EVENT-RESOLVED-${group.date}-${group.lineId}`,
    at: job.actualEnd,
    type: "demo.issue.resolved",
    jobId: job.id,
    message: `Fictional demo history: resolved an illustrative ${group.lineId} material-flow issue.`,
  };
}

function existingPlanSignatures(state: AppState): Map<string, string> {
  return new Map(
    getScheduledJobs(state).map((job) => [job.id, planSignature(job)]),
  );
}

function assertExistingPlansUnchanged(before: Map<string, string>, state: AppState): void {
  const after = new Map(
    getScheduledJobs(state).map((job) => [job.id, planSignature(job)]),
  );
  for (const [id, signature] of before) {
    if (after.get(id) !== signature) {
      throw new Error(`Synthetic history would change the existing computed plan for job ${id}.`);
    }
  }
}

function planSignature(job: ScheduledJob): string {
  return JSON.stringify({
    plannedStart: job.plannedStart,
    plannedEnd: job.plannedEnd,
    durationMinutes: job.durationMinutes,
    rate: job.rate,
    changeoverMinutes: job.changeoverMinutes,
    segments: job.segments,
    overflow: job.overflow,
  });
}

function demoJobId(date: string, lineId: LineId, sequence: number): string {
  return `DEMO-HIST-${date}-${lineId}-${String(sequence).padStart(2, "0")}`;
}

function lineDayKey(date: string, lineId: LineId): string {
  return `${date}:${lineId}`;
}

function businessDayStart(date: string, dayStart: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = dayStart.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function dateTimestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const timestamp = Date.parse(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  return timestamp;
}

function parseNow(value?: Date | string): number {
  const timestamp = value === undefined ? Date.now() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Current time must be a valid date and time.");
  return timestamp;
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647) {
    throw new Error("Synthetic history seed must be an integer from 0 to 2147483647.");
  }
}

function randomInt(seed: number, ...parts: Array<string | number>): number {
  let hash = 2_166_136_261 ^ seed;
  const input = parts.join("|");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash += hash << 13;
  hash ^= hash >>> 7;
  hash += hash << 3;
  hash ^= hash >>> 17;
  hash += hash << 5;
  return hash >>> 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
