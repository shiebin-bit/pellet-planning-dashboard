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

  it("materializes legacy calendars and keeps one latest period per Malaysia date", () => {
    const app = state([]);
    const first = updateSettings(app, { ...app.settings, dayStart: "06:00", availableHours: 10 }, "2026-10-23T01:00:00.000Z");
    expect(first.settings.calendarCutover).toBeUndefined();
    expect(first.settings.calendarHistory).toEqual([
      { effectiveFrom: null, dayStart: "08:30", availableHours: 23, activatedAt: null },
      { effectiveFrom: "2026-10-22", dayStart: "07:00", availableHours: 12, activatedAt: NOW },
      { effectiveFrom: "2026-10-23", dayStart: "06:00", availableHours: 10, activatedAt: "2026-10-23T01:00:00.000Z" },
    ]);
    const sameDay = updateSettings(first, { ...first.settings, dayStart: "05:30", availableHours: 8 }, "2026-10-23T04:00:00.000Z");
    expect(sameDay.settings.calendarHistory).toHaveLength(3);
    expect(sameDay.settings.calendarHistory?.at(-1)).toEqual({
      effectiveFrom: "2026-10-23", dayStart: "05:30", availableHours: 8, activatedAt: "2026-10-23T04:00:00.000Z",
    });
    const nextDay = updateSettings(sameDay, { ...sameDay.settings, availableHours: 9 }, "2026-10-24T00:30:00.000Z");
    expect(nextDay.settings.calendarHistory).toHaveLength(4);
    expect(getCalendarForDate(nextDay.settings, "2026-10-21")).toMatchObject({ dayStart: "08:30", availableHours: 23 });
    expect(getCalendarForDate(nextDay.settings, "2026-10-22")).toMatchObject({ dayStart: "07:00", availableHours: 12 });
    expect(getCalendarForDate(nextDay.settings, "2026-10-23")).toMatchObject({ dayStart: "05:30", availableHours: 8 });
    expect(getCalendarForDate(nextDay.settings, "2026-10-24")).toMatchObject({ dayStart: "05:30", availableHours: 9 });
  });

  it("rejects client calendar metadata changes and preserves protected job facts", () => {
    const locked = { ...linkedJob("locked", "2026-10-22"), status: "completed" as const, actualStart: "2026-10-22T00:00:00.000Z", actualEnd: "2026-10-22T01:00:00.000Z", lockedSegments: [{ jobId: "locked", lineId: "PM1" as const, kind: "production" as const, start: Date.parse("2026-10-22T00:00:00Z"), end: Date.parse("2026-10-22T01:00:00Z") }] };
    const running = { ...linkedJob("running", "2026-10-23", 2), lineId: "PM2" as const, status: "running" as const, actualStart: "2026-10-23T00:00:00.000Z", actualEnd: null, pauseIntervals: [{ pausedAt: "2026-10-23T00:30:00.000Z", resumedAt: null, reason: "Hold" }] };
    const app = state([locked, running]);
    const changed = updateSettings(app, { ...app.settings, availableHours: 8 }, "2026-10-23T02:00:00.000Z");
    expect(changed.jobs.find(job => job.id === locked.id)).toEqual(locked);
    expect(changed.jobs.find(job => job.id === running.id)).toMatchObject({
      actualStart: running.actualStart, actualEnd: null, pauseIntervals: running.pauseIntervals,
    });
    expect(changed.jobs.find(job => job.id === running.id)?.lockedSegments?.length).toBeGreaterThan(0);
    const tampered = { ...changed.settings, calendarHistory: changed.settings.calendarHistory!.map(period => ({ ...period })) };
    tampered.calendarHistory![0].dayStart = "00:00";
    expect(() => updateSettings(changed, tampered, "2026-10-23T03:00:00.000Z")).toThrow(/metadata cannot be edited/i);
  });

  it("rebases only current and future generated inventory floors without changing cards", () => {
    const past = { ...linkedJob("past-auto", "2026-10-22", 2), inventoryItemId: "item-1", productionPurpose: "mto" as const, notBefore: "2026-10-22T10:00:00.000Z", calendarManagedRelease: true };
    const currentManual = { ...linkedJob("current-manual", "2026-10-23", 3), inventoryItemId: "item-1", productionPurpose: "mto" as const, notBefore: "2026-10-23T10:00:00.000Z", sequence: 2 };
    const manualWithoutFloor = { ...linkedJob("manual-no-floor", "2026-10-23", 1), inventoryItemId: "item-1", productionPurpose: "mto" as const, sequence: 3 };
    const future = { ...linkedJob("future-auto", "2026-10-24", 4), inventoryItemId: "item-1", productionPurpose: "mto" as const, notBefore: "2026-10-24T10:00:00.000Z", calendarManagedRelease: true };
    const app = state([past, currentManual, manualWithoutFloor, future]);
    const changed = updateSettings(app, { ...app.settings, dayStart: "06:00", availableHours: 10 }, "2026-10-23T02:00:00.000Z");
    expect(changed.jobs.map(job => job.id)).toEqual(app.jobs.map(job => job.id));
    expect(changed.jobs.find(job => job.id === past.id)?.notBefore).toBe(past.notBefore);
    expect(changed.jobs.find(job => job.id === currentManual.id)?.notBefore).toBe(currentManual.notBefore);
    expect(changed.jobs.find(job => job.id === manualWithoutFloor.id)?.notBefore).toBeUndefined();
    expect(changed.jobs.find(job => job.id === future.id)?.notBefore).toBe("2026-10-23T22:00:00.000Z");
    expect(changed.jobs.map(job => [job.orderNo, job.quantityMt, job.sourceOrderId]))
      .toEqual(app.jobs.map(job => [job.orderNo, job.quantityMt, job.sourceOrderId]));
  });

  it("enforces the engine calendar-history size cap", () => {
    const app = state([]);
    delete app.settings.calendarCutover;
    app.settings.calendarHistory = [
      { effectiveFrom: null, dayStart: "07:00", availableHours: 12, activatedAt: null },
      ...Array.from({ length: 10_000 }, () => ({ effectiveFrom: "2026-10-22", dayStart: "07:00", availableHours: 12, activatedAt: NOW })),
    ];
    expect(() => updateSettings(app, { ...app.settings, siteName: "Still valid" }, NOW)).toThrow(/more than 10000 periods/i);
  });
});
