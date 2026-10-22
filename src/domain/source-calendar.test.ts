import { describe, expect, it } from "vitest";
import { copyJobBatch, getCalendarForDate, getScheduledJobs, updateJob, updateSettings } from "./engine";
import { createDefaultSettings } from "./defaults";
import type { AppState, Job } from "./types";
import { validateWorkspaceBackup } from "./backup";

const NOW = "2026-10-22T04:00:00.000Z";

function linkedJob(id: string, date: string, quantityMt = 12): Job {
  return {
    id, date, lineId: "PM1", sequence: 1, orderNo: `DO-${id}`, productCode: "6220-A",
    description: "Imported", bin: "B01", mode: "bags", bagCount: 240, quantityMt,
    status: "pending", remarks: "", actualStart: null, actualEnd: null, binNeedsReview: false,
    createdAt: NOW, updatedAt: NOW, sourceOrderId: `source-${id}`, sourceOrderVersion: 1,
    sourceSnapshot: { doNo: `DO-${id}`, materialCode: "6220-A", description: "Imported", quantity: 240, unit: "Bags" },
    bagWeightKgSnapshot: 50,
  };
}

function state(jobs: Job[]): AppState {
  const settings = createDefaultSettings();
  settings.calendarCutover = {
    effectiveFrom: "2026-10-22", priorDayStart: "08:30", priorAvailableHours: 23,
    activatedAt: NOW,
  };
  settings.rates.PM1 = 10;
  return { schemaVersion: 2, catalog: [], jobs, settings, events: [] };
}

describe("source-linked production and calendar cutover", () => {
  it("uses the prior calendar for an entire past-assigned backlog and 07:00-19:00 for current work", () => {
    const past = linkedJob("past", "2026-10-21", 300);
    const current = { ...linkedJob("current", "2026-10-22", 130), sourceOrderId: "source-current", sequence: 2 };
    const app = state([past, current]);
    expect(getCalendarForDate(app.settings, "2026-10-21").dayStart).toBe("08:30");
    expect(getCalendarForDate(app.settings, "2026-10-22").dayStart).toBe("07:00");
    const schedule = getScheduledJobs(app);
    const pastSegments = schedule.find(job => job.id === "past")!.segments.filter(segment => segment.kind === "production");
    expect(new Date(pastSegments[0].start).toISOString()).toBe("2026-10-21T00:30:00.000Z");
    expect(new Date(pastSegments[1].start).toISOString()).toBe("2026-10-22T00:30:00.000Z");
    const currentJob = schedule.find(job => job.id === "current")!;
    expect(currentJob.plannedStart).toBe(pastSegments.at(-1)!.end);
    expect(currentJob.segments.every(segment => {
      const malaysiaHour = new Date(segment.start + 8 * 60 * 60_000).getUTCHours();
      return malaysiaHour >= 7 && malaysiaHour < 19;
    })).toBe(true);
  });

  it("keeps imported quantity snapshots stable and rejects ordinary source edits and copy", () => {
    const job = linkedJob("one", "2026-10-22");
    const app = state([job]);
    expect(() => updateJob(app, job.id, { quantityMt: 99 })).toThrow(/cannot be edited/i);
    const updatedSettings = { ...app.settings, bagWeightKg: 60 };
    const afterSettings = updateSettings(app, updatedSettings);
    expect(afterSettings.jobs[0].quantityMt).toBe(12);
    expect(afterSettings.jobs[0].bagWeightKgSnapshot).toBe(50);
    expect(() => copyJobBatch(app, "2026-10-22", "2026-10-23", [{
      sourceJobId: job.id, orderNo: "COPY", quantity: { mode: "bags", bagCount: 240 },
    }], NOW)).toThrow(/imported source job/i);
  });

  it("rejects overlapping locked segments during backup validation", () => {
    const first = { ...linkedJob("first", "2026-10-22"), status: "completed" as const, actualStart: "2026-10-22T00:00:00.000Z", actualEnd: "2026-10-22T01:00:00.000Z", lockedSegments: [{ jobId: "first", lineId: "PM1" as const, kind: "production" as const, start: Date.parse("2026-10-22T00:00:00Z"), end: Date.parse("2026-10-22T01:00:00Z") }] };
    const second = { ...linkedJob("second", "2026-10-22"), sequence: 2, status: "completed" as const, actualStart: "2026-10-22T00:30:00.000Z", actualEnd: "2026-10-22T01:30:00.000Z", lockedSegments: [{ jobId: "second", lineId: "PM1" as const, kind: "production" as const, start: Date.parse("2026-10-22T00:30:00Z"), end: Date.parse("2026-10-22T01:30:00Z") }] };
    expect(() => validateWorkspaceBackup(state([first, second]))).toThrow(/overlapping production time/i);
  });
});
