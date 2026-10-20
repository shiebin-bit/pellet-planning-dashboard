import { describe, expect, it } from "vitest";
import {
  cancelJob,
  completeJob,
  confirmBin,
  createJob,
  getBoard,
  getRate,
  moveJob,
  recordActualOutput,
  reportJobIssue,
  resolveJobIssue,
  startJob,
  updateJob,
  updateSettings,
} from "./engine";
import { getProductionResult } from "./production-results";
import { createSampleState } from "./sample";
import type { AppState, Job, JobInput, LineId, Settings } from "./types";

const DATE = "2026-10-15";
const MINUTE = 60_000;

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    siteName: "Test plant",
    timeZone: "Asia/Kuala_Lumpur",
    dayStart: "08:30",
    availableHours: 23,
    changeoverMinutes: 30,
    bagWeightKg: 50,
    rates: { PM1: 8.5, PM2: 7.5, PM3: 6.5, PM4: 7 },
    slowProductPrefixes: ["6811", "6542"],
    slowRatePM2: 6.5,
    downtime: [],
    ...overrides,
  };
}

function job(
  id: string,
  sequence: number,
  overrides: Partial<Job> = {},
): Job {
  return {
    id,
    date: DATE,
    lineId: "PM1",
    sequence,
    orderNo: `ORD-${id}`,
    productCode: "6220",
    description: "Test product",
    bin: "B1",
    mode: "bulk",
    bagCount: null,
    quantityMt: 8.5,
    status: "pending",
    remarks: "",
    actualStart: null,
    actualEnd: null,
    binNeedsReview: false,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function state(jobs: Job[] = [], config = settings()): AppState {
  return { schemaVersion: 2, catalog: [], jobs, settings: config, events: [] };
}

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    date: DATE,
    lineId: "PM1",
    orderNo: "ORD-NEW",
    productCode: "6220",
    description: "New product",
    bin: "B2",
    mode: "bulk",
    bagCount: null,
    quantityMt: 8.5,
    remarks: "",
    ...overrides,
  };
}

function localTime(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+08:00`);
}

function scheduled(app: AppState, id: string, date = DATE) {
  const found = getBoard(app, date).lines.flatMap((line) => line.jobs).find((item) => item.id === id);
  if (!found) throw new Error(`Scheduled job ${id} not found`);
  return found;
}

describe("quantity and rates", () => {
  it("converts bags using the configured weight and updates pending bag jobs", () => {
    const created = createJob(
      state(),
      input({ mode: "bags", bagCount: 100, quantityMt: 999 }),
    );
    expect(created.jobs[0].quantityMt).toBe(5);

    const changed = updateSettings(created, {
      ...created.settings,
      bagWeightKg: 25,
    });
    expect(changed.jobs[0].quantityMt).toBe(2.5);
    expect(created.jobs[0].quantityMt).toBe(5);
  });

  it("uses line rates and the PM2 slow-prefix override", () => {
    const config = settings();
    expect(getRate(config, "PM1", "6811-X")).toBe(8.5);
    expect(getRate(config, "PM2", " 6811-X ")).toBe(6.5);
    expect(getRate(config, "PM2", "6542ABC")).toBe(6.5);
    expect(getRate(config, "PM2", "6220")).toBe(7.5);
  });
});

describe("scheduling", () => {
  it("creates Malaysia-time board epochs independently of the host timezone", () => {
    const board = getBoard(state(), DATE);
    expect(board.start).toBe(Date.parse("2026-10-15T08:30:00+08:00"));
    expect(board.start).toBe(Date.parse("2026-10-15T00:30:00Z"));
    expect(board.end).toBe(Date.parse("2026-10-16T00:30:00Z"));
  });

  it("computes durations and inserts changeover only when the first four characters change", () => {
    const app = state([
      job("a", 1),
      job("b", 2, { productCode: "6220-B", quantityMt: 4.25 }),
      job("c", 3, { productCode: "6210", quantityMt: 8.5 }),
    ]);
    const line = getBoard(app, DATE).lines[0];

    expect(line.jobs.map((item) => item.durationMinutes)).toEqual([60, 30, 60]);
    expect(line.jobs.map((item) => item.changeoverMinutes)).toEqual([0, 0, 30]);
    expect(line.jobs[2].segments[0].kind).toBe("changeover");
    expect(line.jobs[2].plannedEnd! - line.jobs[2].plannedStart!).toBe(90 * MINUTE);
    expect(line.productionMinutes).toBe(150);
    expect(line.changeoverMinutes).toBe(30);
    expect(line.utilisation).toBeCloseTo(150 / (23 * 60));
  });

  it("pauses production for downtime and resumes afterward", () => {
    const config = settings({
      downtime: [
        {
          id: "maint",
          date: DATE,
          lineId: "PM1",
          start: "09:00",
          end: "10:00",
          reason: "Maintenance",
        },
      ],
    });
    const item = scheduled(state([job("a", 1)], config), "a");

    expect(item.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [localTime(DATE, "08:30"), localTime(DATE, "09:00")],
      [localTime(DATE, "10:00"), localTime(DATE, "10:30")],
    ]);
  });

  it("rolls after-midnight downtime relative to the business-day start", () => {
    const config = settings({
      availableHours: 23,
      downtime: [
        {
          id: "clean",
          date: DATE,
          lineId: "all",
          start: "00:30",
          end: "01:30",
          reason: "Cleaning",
        },
      ],
    });
    const start = localTime(DATE, "08:30");
    const app = state([
      job("a", 1, { quantityMt: 17 * 8.5 }),
    ], config);
    const item = scheduled(app, "a");

    expect(item.segments).toHaveLength(2);
    expect(item.segments[0].end).toBe(start + 16 * 60 * MINUTE);
    expect(item.segments[1].start).toBe(start + 17 * 60 * MINUTE);
  });

  it("continues across business days and clips board capacity and utilisation", () => {
    const config = settings({ availableHours: 2 });
    const app = state([job("a", 1, { quantityMt: 3 * 8.5 })], config);
    const first = getBoard(app, DATE);
    const line = first.lines[0];

    expect(line.availableMinutes).toBe(120);
    expect(line.productionMinutes).toBe(120);
    expect(line.utilisation).toBe(1);
    expect(line.overflowMinutes).toBe(60);
    expect(line.jobs[0].overflow).toBe(true);

    const next = getBoard(app, "2026-10-16").lines[0];
    expect(next.jobs.map((item) => item.id)).toContain("a");
    expect(next.productionMinutes).toBe(60);
  });

  it("returns unscheduled jobs without hanging when capacity is zero", () => {
    const line = getBoard(
      state([job("a", 1)], settings({ availableHours: 0 })),
      DATE,
    ).lines[0];
    expect(line.availableMinutes).toBe(0);
    expect(line.utilisation).toBeNull();
    expect(line.jobs[0].plannedStart).toBeNull();
    expect(line.jobs[0].segments).toEqual([]);
  });
});

describe("mutations and frozen plans", () => {
  it("allows only one running job on a physical line across planning dates", () => {
    const original = state([
      job("a", 1),
      job("b", 1, { date: "2026-10-16" }),
      job("c", 1, { lineId: "PM2", quantityMt: 7.5 }),
    ]);
    const withPm1Running = startJob(
      original,
      "a",
      "2026-10-15T01:00:00.000Z",
    );

    expect(() =>
      startJob(withPm1Running, "b", "2026-10-16T01:00:00.000Z"),
    ).toThrow(/finish the current running job on PM1/i);
    expect(
      startJob(withPm1Running, "c", "2026-10-15T01:00:00.000Z").jobs.find(
        (item) => item.id === "c",
      )?.status,
    ).toBe("running");
  });

  it("moves pending jobs, preserves the bin, and requires bin review across lines", () => {
    const original = state([
      job("a", 1, { bin: "B17" }),
      job("b", 1, { lineId: "PM2" }),
    ]);
    const moved = moveJob(original, "a", "PM2", "b");
    const movedJob = moved.jobs.find((item) => item.id === "a")!;

    expect(movedJob.lineId).toBe("PM2");
    expect(movedJob.bin).toBe("B17");
    expect(movedJob.binNeedsReview).toBe(true);
    expect(
      moved.jobs
        .filter((item) => item.lineId === "PM2")
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(confirmBin(moved, "a").jobs.find((item) => item.id === "a")!.binNeedsReview).toBe(false);
    expect(original.jobs[0].lineId).toBe("PM1");
  });

  it("freezes a started job while a pending predecessor is edited around it", () => {
    let app = state([job("a", 1), job("b", 2)]);
    const before = scheduled(app, "b").segments;
    app = startJob(app, "b", "2026-10-15T02:00:00.000Z");
    app = updateJob(app, "a", { quantityMt: 25.5 });

    const frozen = scheduled(app, "b");
    expect(frozen.segments).toEqual(before);
    expect(app.jobs.find((item) => item.id === "b")!.lockedSegments).toEqual(before);
    expect(scheduled(app, "a").plannedEnd).toBeGreaterThanOrEqual(frozen.plannedEnd!);
  });

  it("records actual timestamps separately from the frozen planned schedule", () => {
    const original = state([job("a", 1)]);
    const planned = scheduled(original, "a");
    const running = startJob(original, "a", "2026-10-15T01:02:03.000Z");
    const done = completeJob(running, "a", 8.25, "Shift target adjusted", "2026-10-15T02:30:00.000Z");
    const completed = done.jobs[0];

    expect(completed.status).toBe("completed");
    expect(completed.actualStart).toBe("2026-10-15T01:02:03.000Z");
    expect(completed.actualEnd).toBe("2026-10-15T02:30:00.000Z");
    expect(completed.updatedAt).toBe("2026-10-15T02:30:00.000Z");
    expect(completed.actualQuantityMt).toBe(8.25);
    expect(completed.completionNote).toBe("Shift target adjusted");
    expect(scheduled(done, "a").plannedStart).toBe(planned.plannedStart);
    expect(scheduled(done, "a").segments).toEqual(planned.segments);
    expect(done.events.map((item) => item.type)).toEqual(["job.started", "job.completed"]);
    expect(done.events.at(-1)?.at).toBe("2026-10-15T02:30:00.000Z");
    expect(done.events.at(-1)?.message).toContain("8.25 MT");
    expect(done.events.at(-1)?.message).toContain("Shift target adjusted");
    expect(original.jobs[0].actualQuantityMt).toBeUndefined();
  });

  it("cancels only pending jobs, retains history, and removes them from scheduling", () => {
    const cancelled = cancelJob(state([job("a", 1)]), "a");
    expect(cancelled.jobs[0].status).toBe("cancelled");
    expect(cancelled.events.at(-1)?.type).toBe("job.cancelled");
    expect(getBoard(cancelled, DATE).lines[0].jobs).toEqual([]);
    expect(() => cancelJob(cancelled, "a")).toThrow(/pending/i);
  });
});

describe("actual production output", () => {
  it("calculates exact, under, over, and zero-output results without inventing legacy actuals", () => {
    const base = job("result", 1, {
      status: "completed",
      actualStart: "2026-10-15T01:00:00.000Z",
      actualEnd: "2026-10-15T02:30:00.000Z",
    });

    expect(getProductionResult({ ...base, actualQuantityMt: 8.5 })).toEqual({
      actualQuantityMt: 8.5,
      varianceMt: 0,
      shortfallMt: 0,
      elapsedMinutes: 90,
      downtimeMinutes: 0,
      netProductionMinutes: 90,
      isPaused: false,
    });
    expect(getProductionResult({ ...base, actualQuantityMt: 8 })).toMatchObject({
      actualQuantityMt: 8,
      varianceMt: -0.5,
      shortfallMt: 0.5,
    });
    expect(getProductionResult({ ...base, actualQuantityMt: 9 })).toMatchObject({
      actualQuantityMt: 9,
      varianceMt: 0.5,
      shortfallMt: 0,
    });
    expect(getProductionResult({ ...base, actualQuantityMt: 0 })).toMatchObject({
      actualQuantityMt: 0,
      varianceMt: -8.5,
      shortfallMt: 8.5,
    });

    const legacy: Job = { ...base, actualQuantityMt: 8.5, completionNote: "Modern field" };
    delete legacy.actualQuantityMt;
    delete legacy.completionNote;
    expect(getProductionResult(legacy)).toMatchObject({
      actualQuantityMt: null,
      varianceMt: null,
      shortfallMt: null,
      elapsedMinutes: 90,
    });
    expect(
      getProductionResult({
        ...base,
        actualStart: "2026-10-15T03:00:00.000Z",
        actualEnd: "2026-10-15T02:00:00.000Z",
      }).elapsedMinutes,
    ).toBeNull();
  });

  it("rejects invalid actual quantities and applies the remarks-length limit to completion notes", () => {
    const running = startJob(
      state([job("a", 1)]),
      "a",
      "2026-10-15T01:00:00.000Z",
    );
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        completeJob(running, "a", invalid, undefined, "2026-10-15T02:00:00.000Z"),
      ).toThrow(/finite number zero or greater/i);
    }
    expect(() =>
      completeJob(running, "a", 8.5, "x".repeat(1_001), "2026-10-15T02:00:00.000Z"),
    ).toThrow(/1000 characters or fewer/i);
    expect(
      completeJob(running, "a", 0, " x ".repeat(250), "2026-10-15T02:00:00.000Z")
        .jobs[0].actualQuantityMt,
    ).toBe(0);
    expect(() => createJob(state(), input({ remarks: "x".repeat(1_001) }))).toThrow(
      /1000 characters or fewer/i,
    );
  });

  it("backfills and corrects completed output without changing actual times or the frozen plan", () => {
    const legacyCompleted = state([
      job("legacy", 1, {
        status: "completed",
        actualStart: "2026-10-15T00:30:00.000Z",
        actualEnd: "2026-10-15T01:30:00.000Z",
      }),
    ]);
    const backfilled = recordActualOutput(legacyCompleted, "legacy", 8.25, "Backfilled tally");
    expect(backfilled.jobs[0].actualQuantityMt).toBe(8.25);
    expect(backfilled.jobs[0].actualStart).toBe(legacyCompleted.jobs[0].actualStart);
    expect(backfilled.jobs[0].actualEnd).toBe(legacyCompleted.jobs[0].actualEnd);
    expect(legacyCompleted.jobs[0].actualQuantityMt).toBeUndefined();

    const running = startJob(
      state([job("a", 1)]),
      "a",
      "2026-10-15T01:00:00.000Z",
    );
    const completed = completeJob(
      running,
      "a",
      8,
      "Initial tally",
      "2026-10-15T02:00:00.000Z",
    );
    const beforeSchedule = scheduled(completed, "a");
    const corrected = recordActualOutput(completed, "a", 9, "  Final weighbridge tally  ");
    const correctedJob = corrected.jobs[0];

    expect(correctedJob.actualQuantityMt).toBe(9);
    expect(correctedJob.completionNote).toBe("Final weighbridge tally");
    expect(correctedJob.actualStart).toBe(completed.jobs[0].actualStart);
    expect(correctedJob.actualEnd).toBe(completed.jobs[0].actualEnd);
    expect(correctedJob.lockedSegments).toEqual(completed.jobs[0].lockedSegments);
    expect(scheduled(corrected, "a").plannedStart).toBe(beforeSchedule.plannedStart);
    expect(scheduled(corrected, "a").plannedEnd).toBe(beforeSchedule.plannedEnd);
    expect(scheduled(corrected, "a").segments).toEqual(beforeSchedule.segments);
    expect(corrected.events.at(-1)).toMatchObject({
      type: "job.actual-output-recorded",
      jobId: "a",
    });
    expect(corrected.events.at(-1)?.message).toContain("from 8 MT to 9 MT");
    expect(completed.jobs[0].actualQuantityMt).toBe(8);
    expect(completed.jobs[0].completionNote).toBe("Initial tally");

    const quantityOnlyCorrection = recordActualOutput(corrected, "a", 8.75);
    expect(quantityOnlyCorrection.jobs[0].completionNote).toBe("Final weighbridge tally");
    expect(() => recordActualOutput(running, "a", 8.5)).toThrow(/completed job/i);
    expect(() => recordActualOutput(corrected, "a", Number.NaN)).toThrow(/finite number/i);
  });

  it("freezes a legacy running job at completion when locked segments are absent", () => {
    const legacyRunning = state([
      job("a", 1, {
        status: "running",
        actualStart: "2026-10-15T01:00:00.000Z",
      }),
    ]);
    const before = scheduled(legacyRunning, "a").segments;
    const completed = completeJob(
      legacyRunning,
      "a",
      8.5,
      undefined,
      "2026-10-15T02:00:00.000Z",
    );
    const changedSettings = updateSettings(completed, {
      ...completed.settings,
      rates: { ...completed.settings.rates, PM1: 4.25 },
    });

    expect(completed.jobs[0].lockedSegments).toEqual(before);
    expect(scheduled(changedSettings, "a").segments).toEqual(before);
    expect(legacyRunning.jobs[0].lockedSegments).toBeUndefined();
  });
});

describe("job issues", () => {
  it("reports and resolves an issue immutably with history", () => {
    const original = state([job("a", 1)]);
    const reported = reportJobIssue(original, "a", "  Pellet moisture high  ");

    expect(original.jobs[0].issue).toBeUndefined();
    expect(reported.jobs[0].issue?.reason).toBe("Pellet moisture high");
    expect(reported.jobs[0].issue?.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reported.events.at(-1)).toMatchObject({
      type: "job.issue-reported",
      jobId: "a",
    });
    expect(reported.events.at(-1)?.message).toContain("Pellet moisture high");

    const resolved = resolveJobIssue(reported, "a");
    expect(resolved.jobs[0]).not.toHaveProperty("issue");
    expect(reported.jobs[0].issue?.reason).toBe("Pellet moisture high");
    expect(resolved.events.at(-1)).toMatchObject({
      type: "job.issue-resolved",
      jobId: "a",
    });
    expect(() => resolveJobIssue(resolved, "a")).toThrow(/no issue/i);
  });

  it("allows reports only for pending or running jobs and requires a reason", () => {
    const pending = state([job("a", 1)]);
    expect(() => reportJobIssue(pending, "a", "   ")).toThrow(/reason is required/i);

    const running = startJob(pending, "a", "2026-10-15T01:00:00.000Z");
    expect(reportJobIssue(running, "a", "Feed interruption").jobs[0].issue?.reason).toBe(
      "Feed interruption",
    );

    const completed = completeJob(running, "a", 8.5, undefined, "2026-10-15T02:00:00.000Z");
    expect(() => reportJobIssue(completed, "a", "Late report")).toThrow(
      /pending or running/i,
    );
    const cancelled = cancelJob(state([job("b", 1)]), "b");
    expect(() => reportJobIssue(cancelled, "b", "Late report")).toThrow(
      /pending or running/i,
    );
  });

  it("clears an issue on completion and records its reason in completed history", () => {
    let app = startJob(
      state([job("a", 1)]),
      "a",
      "2026-10-15T01:00:00.000Z",
    );
    app = reportJobIssue(app, "a", "Motor temperature high");
    const completed = completeJob(app, "a", 8, "Recovered after inspection", "2026-10-15T02:00:00.000Z");

    expect(completed.jobs[0].status).toBe("completed");
    expect(completed.jobs[0]).not.toHaveProperty("issue");
    expect(completed.events.at(-1)?.type).toBe("job.completed");
    expect(completed.events.at(-1)?.message).toContain("Motor temperature high");
    expect(app.jobs[0].issue?.reason).toBe("Motor temperature high");
  });

  it("clears an issue on cancellation and accepts legacy jobs without issue metadata", () => {
    const legacy = JSON.parse(JSON.stringify(state([job("legacy", 1)]))) as AppState;
    expect(getBoard(legacy, DATE).lines[0].jobs[0].id).toBe("legacy");

    const reported = reportJobIssue(legacy, "legacy", "Material unavailable");
    const cancelled = cancelJob(reported, "legacy");
    expect(cancelled.jobs[0].status).toBe("cancelled");
    expect(cancelled.jobs[0]).not.toHaveProperty("issue");
    expect(reported.jobs[0].issue?.reason).toBe("Material unavailable");
  });
});

describe("validation and sample data", () => {
  it("rejects invalid inputs and edits to locked jobs", () => {
    expect(() => createJob(state(), input({ quantityMt: -1 }))).toThrow(/zero or greater/i);
    expect(() => createJob(state(), input({ mode: "bags", bagCount: null }))).toThrow(/bag count/i);
    expect(() => updateSettings(state(), settings({ availableHours: 25 }))).toThrow(/between 0 and 24/i);

    const running = startJob(state([job("a", 1)]), "a", "2026-10-15T01:00:00Z");
    expect(() => updateJob(running, "a", { quantityMt: 1 })).toThrow(/pending/i);
    expect(() => moveJob(running, "a", "PM2")).toThrow(/pending/i);
    expect(() => completeJob(running, "a", 8.5, undefined, "2026-10-15T00:00:00Z")).toThrow(/earlier/i);
  });

  it("rejects a mutation whose overflow reaches an existing future-day job", () => {
    const future = job("future", 1, { date: "2026-10-16" });
    expect(() =>
      createJob(
        state([future], settings({ availableHours: 24 })),
        input({ quantityMt: 300 }),
      ),
    ).toThrow(/collides with an existing job/i);
  });

  it("creates the documented demo mix, totals, completed jobs, and backlog", () => {
    const demo = createSampleState(DATE);
    const board = getBoard(demo, DATE);
    const totals = Object.fromEntries(
      board.lines.map((line) => [line.lineId, line.plannedMt]),
    ) as Record<LineId, number>;

    expect(totals).toEqual({ PM1: 195.5, PM2: 172.5, PM3: 134, PM4: 184 });
    expect(demo.jobs.filter((item) => item.status === "completed")).toHaveLength(5);
    expect(demo.jobs.filter((item) => item.status === "completed").every((item) => item.lockedSegments?.length)).toBe(true);
    expect(demo.jobs.filter((item) => item.status === "completed").every((item) => item.actualQuantityMt !== undefined)).toBe(true);
    expect(
      demo.jobs.filter(
        (item) =>
          item.status === "completed" && item.actualQuantityMt !== item.quantityMt,
      ),
    ).toHaveLength(1);
    expect(board.backlog).toHaveLength(4);
    expect(demo.settings.siteName).toContain("Demo");
    expect(demo.events[0].type).toBe("demo.initialized");
    expect(demo.jobs.every((item) => item.issue === undefined)).toBe(true);
  });

  it("scopes backlog to the selected planning date", () => {
    const app = state([
      job("today", 1, { quantityMt: 0 }),
      job("tomorrow", 1, { date: "2026-10-16", quantityMt: 0 }),
    ]);

    expect(getBoard(app, DATE).backlog.map((item) => item.id)).toEqual(["today"]);
    expect(getBoard(app, "2026-10-16").backlog.map((item) => item.id)).toEqual([
      "tomorrow",
    ]);
  });
});
