import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "./defaults";
import { getOverviewMetrics } from "./overviewMetrics";
import type { AppState, Job } from "./types";

function job(id: string, date: string, quantityMt: number, overrides: Partial<Job> = {}): Job {
  return {
    id, date, lineId: "PM1", sequence: 1, orderNo: id, productCode: "FEED", description: "Feed", bin: "",
    mode: "bulk", bagCount: null, quantityMt, status: "pending", remarks: "", actualStart: null, actualEnd: null,
    binNeedsReview: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  };
}

function state(jobs: Job[]): AppState {
  return {
    schemaVersion: 2, catalog: [], events: [], jobs,
    settings: { ...createDefaultSettings(), dayStart: "08:00", availableHours: 2, changeoverMinutes: 30, rates: { PM1: 8.5, PM2: 7.5, PM3: 6.5, PM4: 7 } },
  };
}

describe("overview metrics", () => {
  it("uses each line's own overtime/overnight window rather than clipping to global hours", () => {
    const app = state([job('overtime', '2026-11-04', 140), job('normal', '2026-11-04', 140, { lineId: 'PM2' }), job('night', '2026-11-04', 60, { lineId: 'PM3' })]);
    app.settings.dayStart = '07:00'; app.settings.availableHours = 12;
    app.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    app.settings.workingHoursOverrides = [
      { date: '2026-11-04', lineId: 'PM1', dayStart: '07:00', availableHours: 14, reason: 'Overtime', activatedAt: '2026-11-03T00:00:00Z' },
      { date: '2026-11-04', lineId: 'PM3', dayStart: '20:00', availableHours: 8, reason: 'Night shift', activatedAt: '2026-11-03T00:00:00Z' },
    ];
    expect(getOverviewMetrics(app, '2026-11-04')).toEqual({ assignedDateMt: 340, inShiftPlannedMt: 320 });
    expect(getOverviewMetrics(app, '2026-11-05').inShiftPlannedMt).toBe(20);
  });
  it("separates whole assigned cards from production inside the shift, including carry-in and carry-out", () => {
    const app = state([job("long", "2026-10-15", 25.5)]);
    expect(getOverviewMetrics(app, "2026-10-15")).toEqual({ assignedDateMt: 25.5, inShiftPlannedMt: 17 });
    expect(getOverviewMetrics(app, "2026-10-16")).toEqual({ assignedDateMt: 0, inShiftPlannedMt: 8.5 });
  });

  it("counts every non-cancelled assigned card but never changeover time as planned quantity", () => {
    const app = state([
      job("first", "2026-10-15", 8.5),
      job("changeover", "2026-10-15", 8.5, { sequence: 2, productCode: "OTHER" }),
      job("cancelled", "2026-10-15", 99, { sequence: 3, status: "cancelled" }),
    ]);
    const result = getOverviewMetrics(app, "2026-10-15");
    expect(result.assignedDateMt).toBe(17);
    expect(result.inShiftPlannedMt).toBeCloseTo(12.75, 10);
  });

  it("uses the job's total production-segment duration for proportional quantity", () => {
    const app = state([job("split", "2026-10-15", 8.5)]);
    app.settings.availableHours = 1;
    app.settings.downtime = [{ id: "pause", date: "2026-10-15", lineId: "PM1", start: "08:15", end: "08:45", reason: "Pause" }];
    expect(getOverviewMetrics(app, "2026-10-15").inShiftPlannedMt).toBeCloseTo(4.25, 10);
    expect(getOverviewMetrics(app, "2026-10-16").inShiftPlannedMt).toBeCloseTo(4.25, 10);
  });
});
