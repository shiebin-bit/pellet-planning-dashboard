import { describe, expect, it } from "vitest";
import {
  getDowntimeMinutesForWindow,
  getProductionResult,
  isJobPaused,
} from "./production-results";
import type { Job } from "./types";

describe("pause-aware production results", () => {
  it("uses an explicit as-of time for running elapsed, downtime, and net minutes", () => {
    const running = job({
      status: "running",
      actualStart: "2026-10-15T01:00:00.000Z",
      pauseIntervals: [{ pausedAt: "2026-10-15T01:30:00.000Z", resumedAt: null, reason: "Hold" }],
    });
    expect(getProductionResult(running, Date.parse("2026-10-15T02:00:00.000Z"))).toMatchObject({
      elapsedMinutes: 60,
      downtimeMinutes: 30,
      netProductionMinutes: 30,
      isPaused: true,
    });
    expect(isJobPaused(running)).toBe(true);
  });

  it("uses actual end for completed results and reports zero recorded downtime for legacy jobs", () => {
    const completed = job({
      status: "completed",
      actualStart: "2026-10-15T01:00:00.000Z",
      actualEnd: "2026-10-15T03:00:00.000Z",
      actualQuantityMt: 9,
      pauseIntervals: [{
        pausedAt: "2026-10-15T01:30:00.000Z",
        resumedAt: "2026-10-15T02:00:00.000Z",
        reason: "Hold",
      }],
    });
    expect(getProductionResult(completed, Date.parse("2026-10-20T00:00:00.000Z"))).toMatchObject({
      elapsedMinutes: 120,
      downtimeMinutes: 30,
      netProductionMinutes: 90,
      isPaused: false,
    });
    const legacy = { ...completed };
    delete legacy.pauseIntervals;
    expect(getProductionResult(legacy)).toMatchObject({ downtimeMinutes: 0, netProductionMinutes: 120 });
  });

  it("sums line-minutes across jobs with cross-day clipping and completed-end caps", () => {
    const jobs = [
      job({
        id: "pm1-cross-day",
        lineId: "PM1",
        status: "completed",
        actualStart: "2026-10-14T23:00:00.000Z",
        actualEnd: "2026-10-15T00:20:00.000Z",
        pauseIntervals: [{
          pausedAt: "2026-10-14T23:50:00.000Z",
          resumedAt: "2026-10-15T00:40:00.000Z",
          reason: "Cross day",
        }],
      }),
      job({
        id: "pm1-second",
        lineId: "PM1",
        status: "running",
        actualStart: "2026-10-15T00:00:00.000Z",
        pauseIntervals: [{ pausedAt: "2026-10-15T00:10:00.000Z", resumedAt: null, reason: "Open" }],
      }),
      job({
        id: "pm2",
        lineId: "PM2",
        status: "running",
        actualStart: "2026-10-15T00:00:00.000Z",
        pauseIntervals: [{ pausedAt: "2026-10-15T00:00:00.000Z", resumedAt: null, reason: "Other line" }],
      }),
    ];
    const start = Date.parse("2026-10-15T00:00:00.000Z");
    const end = Date.parse("2026-10-16T00:00:00.000Z");
    const asOf = Date.parse("2026-10-15T00:30:00.000Z");
    expect(getDowntimeMinutesForWindow(jobs, start, end, asOf, "PM1")).toBe(40);
    expect(getDowntimeMinutesForWindow(jobs, start, end, asOf)).toBe(70);
    expect(getDowntimeMinutesForWindow(jobs, end, start, asOf)).toBe(0);
  });
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job",
    date: "2026-10-15",
    lineId: "PM1",
    sequence: 1,
    orderNo: "ORDER-1",
    productCode: "P1",
    description: "Product",
    bin: "B01",
    mode: "bulk",
    bagCount: null,
    quantityMt: 8,
    status: "pending",
    remarks: "",
    actualStart: null,
    actualEnd: null,
    binNeedsReview: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}
