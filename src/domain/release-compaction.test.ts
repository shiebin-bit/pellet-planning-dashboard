import { describe, expect, it } from "vitest";
import { executeCommand } from "./commands";
import { createDefaultSettings } from "./defaults";
import { getScheduledJobs } from "./engine";
import type { AppState, Job, JobSourceAllocation, LineId } from "./types";

const DATE = "2026-12-01";
const SHIFT_START = "2026-11-30T23:30:00.000Z"; // 07:30 MYT

function allocation(id: string, quantity: number): JobSourceAllocation {
  return {
    sourceOrderId: id,
    sourceOrderVersion: 1,
    plannedQuantity: quantity,
    sourceSnapshot: { doNo: `DO-${id}`, materialCode: "FEED", description: "Feed", quantity, unit: "MT" },
  };
}

function job(id: string, lineId: LineId, sequence: number, quantityMt: number, notBefore: string, patch: Partial<Job> = {}): Job {
  return {
    id, date: DATE, lineId, sequence, orderNo: id, productCode: "FEED", description: "Feed", bin: "",
    mode: "bulk", bagCount: null, quantityMt, status: "pending", remarks: "", actualStart: null, actualEnd: null,
    binNeedsReview: false, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
    inventoryItemId: "item-1", medication: "", fmrOmed: "", productionPurpose: "mto",
    calendarManagedRelease: true, notBefore, ...patch,
  };
}

function state(jobs: Job[]): AppState {
  const settings = createDefaultSettings();
  settings.dayStart = "07:30";
  settings.availableHours = 24;
  settings.changeoverMinutes = 0;
  settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
  return { schemaVersion: 2, catalog: [], jobs, settings, events: [] };
}

describe("calendar-managed release compaction", () => {
  it("compacts downstream automatic cards after an allocation transfer while preserving manual floors", () => {
    const source = job("source", "PM1", 1, 10, SHIFT_START, { sourceAllocations: [allocation("A", 5), allocation("B", 5)] });
    const downstream = job("downstream", "PM1", 2, 10, "2026-12-01T00:30:00.000Z");
    const manual = job("manual", "PM1", 3, 10, "2026-12-01T03:00:00.000Z", { calendarManagedRelease: undefined });
    const unrelated = job("unrelated", "PM3", 1, 10, "2026-12-01T04:00:00.000Z");
    const next = executeCommand(state([source, downstream, manual, unrelated]), {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM2",
    }, { nowIso: "2026-11-30T02:00:00.000Z" });
    const schedules = new Map(getScheduledJobs(next).map(row => [row.id, row]));
    expect(next.jobs.find(row => row.id === downstream.id)?.notBefore).toBe(SHIFT_START);
    expect(schedules.get(downstream.id)?.plannedStart).toBe(schedules.get(source.id)?.plannedEnd);
    expect(next.jobs.find(row => row.id === manual.id)?.notBefore).toBe("2026-12-01T03:00:00.000Z");
    expect(next.jobs.find(row => row.id === unrelated.id)?.notBefore).toBe("2026-12-01T04:00:00.000Z");
  });

  it("uses trusted now for today's automatic cards and does not change executed or past-assigned floors", () => {
    const todayNow = "2026-12-01T02:00:00.000Z"; // 10:00 MYT
    const source = job("source", "PM1", 1, 10, SHIFT_START);
    const downstream = job("downstream", "PM1", 2, 10, "2026-12-01T04:00:00.000Z");
    const running = job("running", "PM1", 3, 10, "2026-12-01T05:00:00.000Z", {
      status: "running", actualStart: "2026-12-01T01:00:00.000Z",
      lockedSegments: [{ jobId: "running", lineId: "PM1", kind: "production", start: Date.parse("2026-12-01T01:00:00.000Z"), end: Date.parse("2026-12-01T02:00:00.000Z") }],
      continuationPlan: { remainingQuantityMt: 5, plannedAt: "2026-12-01T01:30:00.000Z", segments: [] },
    });
    const current = executeCommand(state([source, downstream, running]), {
      type: "job.move", jobId: source.id, toLineId: "PM2",
    }, { nowIso: todayNow });
    expect(current.jobs.find(row => row.id === source.id)?.notBefore).toBe(todayNow);
    expect(current.jobs.find(row => row.id === downstream.id)?.notBefore).toBe(todayNow);
    expect(current.jobs.find(row => row.id === running.id)?.notBefore).toBe("2026-12-01T05:00:00.000Z");

    const past = { ...state([job("past-source", "PM1", 1, 10, "2026-11-30T04:00:00.000Z")]), jobs: [job("past-source", "PM1", 1, 10, "2026-11-30T04:00:00.000Z", { date: "2026-11-30" })] };
    const movedPast = executeCommand(past, { type: "job.move", jobId: "past-source", toLineId: "PM2" }, { nowIso: todayNow });
    expect(movedPast.jobs[0].notBefore).toBe("2026-11-30T04:00:00.000Z");
  });
});
