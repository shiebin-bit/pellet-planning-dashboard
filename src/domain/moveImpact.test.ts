import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "./defaults";
import { previewMoveImpact } from "./moveImpact";
import type { AppState, Job } from "./types";

const DATE = "2026-10-15";

function job(id: string, lineId: "PM1" | "PM2", sequence: number, overrides: Partial<Job> = {}): Job {
  return {
    id, date: DATE, lineId, sequence, orderNo: id, productCode: "FEED", description: "Feed", bin: "",
    mode: "bulk", bagCount: null, quantityMt: 100, status: "pending", remarks: "", actualStart: null, actualEnd: null,
    binNeedsReview: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  };
}

function state(jobs: Job[], settings: Partial<AppState["settings"]> = {}): AppState {
  return {
    schemaVersion: 2, catalog: [], events: [], jobs,
    settings: { ...createDefaultSettings(), dayStart: "08:00", availableHours: 8, changeoverMinutes: 0, rates: { PM1: 10, PM2: 10, PM3: 10, PM4: 10 }, ...settings },
  };
}

describe("move impact preview", () => {
  it("compares the moved range, every shifted job, utilization, and known or unknown due dates", () => {
    const known = job("known", "PM2", 1, {
      sourceOrderId: "source-known", sourceOrderVersion: 1,
      sourceSnapshot: { doNo: "DO-K", materialCode: "FEED", description: "Feed", quantity: 10, unit: "MT", deliveryDate: DATE },
    });
    const app = state([
      job("move", "PM1", 1),
      job("source-follow", "PM1", 2, { date: "2026-10-16" }),
      known,
      job("unknown", "PM2", 2),
      job("dest-future", "PM2", 1, { date: "2026-10-16" }),
    ]);
    const result = previewMoveImpact(app, { jobId: "move", toLineId: "PM2", beforeJobId: "known" }, 7);
    expect(result.baseRevision).toBe(7);
    expect(result.moved).toMatchObject({ beforeLineId: "PM1", afterLineId: "PM2" });
    expect(result.changedJobs.map(row => row.jobId)).toEqual(expect.arrayContaining(["source-follow", "known", "unknown", "dest-future"]));
    expect(result.lineUtilization.map(row => row.lineId)).toEqual(["PM1", "PM2"]);
    expect(result.dueRisks.find(row => row.jobId === "known")).toMatchObject({ dueDate: DATE, dueDateKnown: true });
    expect(result.dueRisks.find(row => row.jobId === "unknown")).toMatchObject({ dueDate: null, dueDateKnown: false, beforeLate: null, afterLate: null });
  });

  it("does not mutate state or protected job fields while previewing", () => {
    const completed = job("done", "PM1", 1, {
      status: "completed", actualStart: "2026-10-15T00:00:00.000Z", actualEnd: "2026-10-15T01:00:00.000Z",
      lockedSegments: [{ jobId: "done", lineId: "PM1", kind: "production", start: Date.parse("2026-10-15T08:00:00+08:00"), end: Date.parse("2026-10-15T09:00:00+08:00") }],
    });
    const app = state([completed, job("move", "PM2", 1)]);
    const snapshot = JSON.stringify(app);
    previewMoveImpact(app, { jobId: "move", toLineId: "PM1" });
    expect(JSON.stringify(app)).toBe(snapshot);
    expect(app.jobs[0]).toEqual(completed);
  });

  it("returns actionable failures for locked and invalid moves", () => {
    expect(() => previewMoveImpact(state([job("running", "PM1", 1, { status: "running", actualStart: "2026-10-15T00:00:00.000Z" })]), { jobId: "running", toLineId: "PM2" })).toThrow(/pending job/i);
    const app = state([job("move", "PM1", 1), job("target", "PM2", 1, { date: "2026-10-16" })]);
    expect(() => previewMoveImpact(app, { jobId: "move", toLineId: "PM2", beforeJobId: "target" })).toThrow(/move preview failed.*destination line and date/i);
  });

  it("uses the Malaysia completion date for daytime and overnight due checks", () => {
    const linked = (quantityMt: number) => job("linked", "PM1", 1, {
      quantityMt,
      sourceOrderId: "source-day", sourceOrderVersion: 1,
      sourceSnapshot: { doNo: "DO-DAY", materialCode: "FEED", description: "Feed", quantity: quantityMt, unit: "MT", deliveryDate: DATE },
    });
    const day = previewMoveImpact(state([linked(10)]), { jobId: "linked", toLineId: "PM2" });
    expect(day.dueRisks[0]).toMatchObject({ orderNo: "DO-DAY", dueDate: DATE, beforeLate: false, afterLate: false });
    const overnight = previewMoveImpact(state([linked(30)], { dayStart: "22:00", availableHours: 8 }), { jobId: "linked", toLineId: "PM2" });
    expect(overnight.dueRisks[0]).toMatchObject({ dueDate: DATE, beforeLate: true, afterLate: true });
  });

  it("reports each combined allocation using its own saved DO number and due date", () => {
    const combined = job("combined", "PM1", 1, {
      quantityMt: 10, sourceOrderId: undefined, sourceOrderVersion: undefined, sourceSnapshot: undefined,
      sourceAllocations: [
        { sourceOrderId: "source-a", sourceOrderVersion: 1, plannedQuantity: 4, sourceSnapshot: { doNo: "DO-A", materialCode: "FEED", description: "Feed", quantity: 4, unit: "MT", deliveryDate: DATE } },
        { sourceOrderId: "source-b", sourceOrderVersion: 1, plannedQuantity: 6, sourceSnapshot: { doNo: "DO-B", materialCode: "FEED", description: "Feed", quantity: 6, unit: "MT", deliveryDate: "2026-10-16" } },
      ],
    });
    const risks = previewMoveImpact(state([combined]), { jobId: "combined", toLineId: "PM2" }).dueRisks;
    expect(risks.map(risk => [risk.sourceOrderId, risk.orderNo, risk.dueDate])).toEqual([
      ["source-a", "DO-A", DATE],
      ["source-b", "DO-B", "2026-10-16"],
    ]);
  });

  it("previews moving a pending zero-quantity backlog card", () => {
    const backlog = job("backlog", "PM1", 1, { quantityMt: 0 });
    const result = previewMoveImpact(state([backlog]), { jobId: backlog.id, toLineId: "PM2" });

    expect(result.moved).toMatchObject({
      jobId: "backlog",
      beforeLineId: "PM1",
      afterLineId: "PM2",
      before: { plannedStart: null, plannedEnd: null },
      after: { plannedStart: null, plannedEnd: null },
    });
    expect(result.changedJobs).toEqual([]);
    expect(result.dueRisks).toEqual([expect.objectContaining({
      jobId: "backlog",
      beforePlannedEnd: null,
      afterPlannedEnd: null,
      beforeLate: null,
      afterLate: null,
    })]);
  });
});
