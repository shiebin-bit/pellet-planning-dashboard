import { describe, expect, it } from "vitest";
import { createDefaultSettings, createEmptyState } from "./defaults";
import {
  generateDemoHistory,
  historyDates,
  malaysiaDate,
} from "./demo-history";
import { getScheduledJobs } from "./engine";
import { createSampleState } from "./sample";
import type { AppState, Job, ScheduledJob } from "./types";

const NOW = "2026-10-20T01:00:00.000Z";
const OPTIONS = {
  from: "2026-09-20",
  to: "2026-10-19",
  seed: 20_261_020,
  now: NOW,
} as const;

describe("synthetic demo history", () => {
  it("generates a deterministic month of clearly fictional, varied history", () => {
    const source = createSampleState("2026-10-19");
    const first = generateDemoHistory(source, OPTIONS);
    const second = generateDemoHistory(source, OPTIONS);

    expect(first).toEqual(second);
    expect(first.jobs.length).toBeGreaterThanOrEqual(650);
    expect(first.jobs.length).toBeLessThanOrEqual(800);
    expect(first.events.length).toBeGreaterThan(100);
    expect(first.jobs.every((job) => job.id.startsWith("DEMO-HIST-"))).toBe(true);
    expect(first.jobs.every((job) => job.orderNo.startsWith("DEMO-HIST-"))).toBe(true);
    expect(first.jobs.every((job) => /fictional demo/i.test(job.description))).toBe(true);
    expect(first.jobs.every((job) => /not a customer or SAP order/i.test(job.remarks))).toBe(true);
    expect(first.events.every((event) => /fictional demo/i.test(event.message))).toBe(true);
    expect(first.jobs.every((job) => job.date >= OPTIONS.from && job.date <= OPTIONS.to)).toBe(true);
    expect(first.jobs.some((job) => job.mode === "bags")).toBe(true);
    expect(first.jobs.some((job) => job.mode === "bulk")).toBe(true);

    const statuses = new Set(first.jobs.map((job) => job.status));
    expect(statuses).toEqual(new Set(["completed", "cancelled", "pending"]));
    expect(first.jobs.some((job) => job.status === "running")).toBe(false);
    expect(first.jobs.filter((job) => job.status === "completed").length / first.jobs.length).toBeGreaterThan(0.9);
    expect(first.events.filter((event) => event.type === "demo.issue.resolved").length).toBeGreaterThan(1);
    expect(first.skipped).toEqual([
      { date: "2026-10-19", lineId: "PM1", reason: "occupied" },
      { date: "2026-10-19", lineId: "PM2", reason: "occupied" },
      { date: "2026-10-19", lineId: "PM3", reason: "occupied" },
      { date: "2026-10-19", lineId: "PM4", reason: "occupied" },
    ]);
  });

  it("preserves the source and every pre-existing computed plan", () => {
    const source = createSampleState("2026-10-19");
    const sourceJson = JSON.stringify(source);
    const before = planMap(source);
    const result = generateDemoHistory(source, OPTIONS);
    const after = planMap(result.state);

    expect(JSON.stringify(source)).toBe(sourceJson);
    expect(result.state.jobs.slice(0, source.jobs.length)).toEqual(source.jobs);
    expect(result.state.events.slice(0, source.events.length)).toEqual(source.events);
    expect(result.state.settings).toEqual(source.settings);
    for (const [id, plan] of before) expect(after.get(id)).toEqual(plan);
  });

  it("freezes completed jobs and keeps quantities, timestamps, and output variation coherent", () => {
    const result = generateDemoHistory(createSampleState("2026-10-19"), OPTIONS);
    const completed = result.jobs.filter((job) => job.status === "completed");
    const cancelled = result.jobs.filter((job) => job.status === "cancelled");
    const issues = result.jobs.filter((job) => job.status === "pending");
    const now = Date.parse(NOW);

    expect(completed.every((job) => (job.lockedSegments?.length ?? 0) > 0)).toBe(true);
    expect(cancelled.every((job) => !job.lockedSegments?.length && job.actualStart === null && job.actualEnd === null)).toBe(true);
    expect(issues.every((job) => !!job.issue && !job.lockedSegments?.length)).toBe(true);
    expect(issues.every((job) => job.updatedAt === job.issue!.reportedAt)).toBe(true);
    expect(result.jobs.filter((job) => job.mode === "bags").every((job) =>
      job.bagCount !== null && job.quantityMt === job.bagCount * result.state.settings.bagWeightKg / 1_000
    )).toBe(true);
    expect(completed.every((job) =>
      job.actualStart !== null && job.actualEnd !== null
      && Date.parse(job.actualStart) <= Date.parse(job.actualEnd)
      && Date.parse(job.actualEnd) < now
    )).toBe(true);

    expect(completed.some((job) => !Object.hasOwn(job, "actualQuantityMt"))).toBe(true);
    expect(completed.some((job) => job.actualQuantityMt === null)).toBe(true);
    expect(completed.some((job) => job.actualQuantityMt === 0)).toBe(true);
    expect(completed.some((job) => typeof job.actualQuantityMt === "number" && job.actualQuantityMt > job.quantityMt)).toBe(true);
    expect(completed.some((job) => typeof job.actualQuantityMt === "number" && job.actualQuantityMt! > 0 && job.actualQuantityMt! < job.quantityMt)).toBe(true);

    assertNoOverlap(completed, (job) => job.lockedSegments?.map((segment) => ({ start: segment.start, end: segment.end })) ?? []);
    assertNoOverlap(completed, (job) => [{ start: Date.parse(job.actualStart!), end: Date.parse(job.actualEnd!) }]);
  });

  it("is a repeatable no-op after the same history has been generated", () => {
    const first = generateDemoHistory(createSampleState("2026-10-19"), OPTIONS);
    const repeated = generateDemoHistory(first.state, OPTIONS);

    expect(repeated.jobs).toEqual([]);
    expect(repeated.events).toEqual([]);
    expect(repeated.state).toEqual(first.state);
    expect(repeated.skipped).toHaveLength(30 * 4);
    expect(repeated.skipped.every((item) => item.reason === "occupied")).toBe(true);
  });

  it("rejects invalid, present, future, reversed, and overlong ranges", () => {
    expect(() => historyDates("2026-02-30", "2026-03-01", NOW)).toThrow(/valid calendar date/i);
    expect(() => historyDates("2026-10-02", "2026-10-01", NOW)).toThrow(/on or after/i);
    expect(() => historyDates("2026-09-19", "2026-10-19", NOW)).not.toThrow();
    expect(() => historyDates("2026-09-18", "2026-10-19", NOW)).toThrow(/31 calendar days/i);
    expect(() => historyDates("2026-10-20", "2026-10-20", NOW)).toThrow(/before today in Malaysia/i);
    expect(() => historyDates("2026-10-21", "2026-10-21", NOW)).toThrow(/before today in Malaysia/i);
    expect(malaysiaDate("2026-10-19T16:00:00.000Z")).toBe("2026-10-20");
    expect(() => generateDemoHistory(createEmptyState(), { ...OPTIONS, seed: -1 })).toThrow(/seed/i);
  });

  it("skips a line-day that the current downtime settings cannot schedule", () => {
    const state: AppState = {
      ...createEmptyState(),
      settings: {
        ...createDefaultSettings(),
        downtime: [{
          id: "full-day-pm1",
          date: "2026-10-18",
          lineId: "PM1",
          start: "08:30",
          end: "07:30",
          reason: "Test full-day downtime",
        }],
      },
    };
    const result = generateDemoHistory(state, {
      from: "2026-10-18",
      to: "2026-10-18",
      seed: OPTIONS.seed,
      now: NOW,
    });

    expect(result.skipped).toContainEqual({ date: "2026-10-18", lineId: "PM1", reason: "unschedulable" });
    expect(result.jobs.some((job) => job.lineId === "PM1")).toBe(false);
    expect(result.jobs.some((job) => job.lineId === "PM2")).toBe(true);
  });
});

function planMap(state: AppState): Map<string, ReturnType<typeof planValue>> {
  return new Map(getScheduledJobs(state).map((job) => [job.id, planValue(job)]));
}

function planValue(job: ScheduledJob) {
  return {
    plannedStart: job.plannedStart,
    plannedEnd: job.plannedEnd,
    durationMinutes: job.durationMinutes,
    rate: job.rate,
    changeoverMinutes: job.changeoverMinutes,
    segments: job.segments,
    overflow: job.overflow,
  };
}

function assertNoOverlap(
  jobs: Job[],
  intervalsFor: (job: Job) => Array<{ start: number; end: number }>,
): void {
  for (const lineId of ["PM1", "PM2", "PM3", "PM4"] as const) {
    for (const date of new Set(jobs.map((job) => job.date))) {
      const intervals = jobs
        .filter((job) => job.lineId === lineId && job.date === date)
        .flatMap(intervalsFor)
        .sort((left, right) => left.start - right.start || left.end - right.end);
      for (let index = 1; index < intervals.length; index += 1) {
        expect(intervals[index - 1].end).toBeLessThanOrEqual(intervals[index].start);
      }
    }
  }
}
