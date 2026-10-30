import { describe, expect, it } from "vitest";
import { createSampleState } from "./sample";
import { executeCommand, parseCommand } from "./commands";
import { createEmptyState } from "./defaults";
import { createJob } from "./engine";
import { getJobSourceAllocations } from "./jobSources";

describe("shared workspace commands", () => {
  it("strictly parses commands and rejects unknown fields", () => {
    const command = parseCommand({
      type: "job.move", jobId: "job-1", toLineId: "PM2", beforeJobId: "job-2",
    });
    expect(command).toEqual({ type: "job.move", jobId: "job-1", toLineId: "PM2", beforeJobId: "job-2" });
    expect(() => parseCommand({ type: "job.cancel", jobId: "job-1", state: {} })).toThrow(/not supported/i);
    expect(() => parseCommand({ type: "job.create", input: { date: "2026-10-15" } })).toThrow(/required/i);
    expect(() => parseCommand({ type: "workspace.resetDemo", date: "2026-02-30" })).toThrow(/valid calendar/i);
    expect(parseCommand({ type: "job.update", jobId: "job-1", patch: { remarks: "Revised" } })).toEqual({
      type: "job.update", jobId: "job-1", patch: { remarks: "Revised" },
    });
    expect(() => parseCommand({ type: "job.update", jobId: "job-1", patch: { status: "completed" } })).toThrow(/not supported/i);
    expect(() => parseCommand({ type: "job.update", jobId: "job-1", patch: { calendarManagedRelease: true } })).toThrow(/not supported/i);
  });

  it("dispatches ordinary commands and uses the trusted completion timestamp", () => {
    const sample = createSampleState("2026-10-15");
    const pending = sample.jobs.find(job => job.status === "pending" && job.quantityMt > 0)!;
    const started = executeCommand(sample, {
      type: "job.start", jobId: pending.id,
    }, { nowIso: "2026-10-15T00:00:00.000Z" });
    const completed = executeCommand(started, {
      type: "job.complete", jobId: pending.id, actualQuantityMt: pending.quantityMt, completionNote: "Server confirmation",
    }, { nowIso: "2026-10-15T04:00:00.000Z" });
    expect(completed.jobs.find(job => job.id === pending.id)).toMatchObject({
      status: "completed", actualEnd: "2026-10-15T04:00:00.000Z", completionNote: "Server confirmation",
    });
  });

  it("keeps workspace-level operations behind a trusted provider", () => {
    const state = createSampleState("2026-10-15");
    expect(() => executeCommand(state, { type: "workspace.undoLastMove" })).toThrow(/trusted workspace provider/i);
    expect(() => executeCommand(state, { type: "workspace.restore", backup: state })).toThrow(/trusted workspace provider/i);
  });

  it("keeps an explicit public job release floor outside calendar-managed rebasing", () => {
    const created = executeCommand(createEmptyState(), { type: "job.create", input: {
      date: "2026-10-29", lineId: "PM1", orderNo: "MANUAL", productCode: "7.100", description: "Feed",
      bin: "", mode: "bulk", bagCount: null, quantityMt: 1, remarks: "", inventoryItemId: "item-1",
      productionPurpose: "mto", notBefore: "2026-10-29T10:00:00.000Z",
    } });
    const changed = executeCommand(created, {
      type: "settings.update", settings: { ...created.settings, dayStart: "06:00", availableHours: 10 },
    }, { nowIso: "2026-10-29T01:00:00.000Z" });
    expect(changed.jobs[0]).toMatchObject({ notBefore: "2026-10-29T10:00:00.000Z" });
    expect(changed.jobs[0].calendarManagedRelease).toBeUndefined();
  });

  it("parses grouped source creation and atomically combines compatible pending source cards", () => {
    expect(parseCommand({ type: "job.createFromSources", input: { orders: [
      { sourceOrderId: "source-1", sourceOrderVersion: 1, plannedQuantity: 20 },
      { sourceOrderId: "source-2", sourceOrderVersion: 2, plannedQuantity: 30 },
    ], date: "2026-10-29", lineId: "PM1", bin: "B01", remarks: "group" } })).toMatchObject({ type: "job.createFromSources", input: { orders: [{ plannedQuantity: 20 }, { plannedQuantity: 30 }] } });
    expect(() => parseCommand({ type: "job.createFromSources", input: { orders: [
      { sourceOrderId: "source-1", sourceOrderVersion: 1, plannedQuantity: 20 },
      { sourceOrderId: "source-1", sourceOrderVersion: 1, plannedQuantity: 30 },
    ], date: "2026-10-29", lineId: "PM1", bin: "", remarks: "" } })).toThrow(/duplicate/i);

    let state = createEmptyState();
    for (const [index, order] of ["DO-1", "DO-2"].entries()) {
      state = createJob(state, { date: "2026-10-29", lineId: "PM1", orderNo: order, productCode: "7.100", description: "Feed", bin: "B01", mode: "bulk", bagCount: null, quantityMt: index + 1, remarks: "", inventoryItemId: "item-1", medication: "", fmrOmed: "", productionPurpose: "mto" });
      const id = state.jobs.at(-1)!.id;
      state = { ...state, jobs: state.jobs.map(job => job.id === id ? {
        ...job,
        sourceOrderId: `source-${index + 1}`,
        sourceOrderVersion: 1,
        sourceSnapshot: { doNo: order, materialCode: "7.100", description: "Feed", quantity: index + 1, unit: "MT" as const },
        notBefore: `2026-10-29T0${index + 1}:00:00.000Z`,
        ...(index === 0 ? { calendarManagedRelease: true } : {}),
      } : job) };
    }
    const ids = state.jobs.map(job => job.id);
    const combined = executeCommand(state, { type: "job.combinePending", jobIds: ids, bin: "B02", remarks: "Combined" }, { nowIso: "2026-10-29T01:00:00.000Z" });
    const active = combined.jobs.filter(job => job.status !== "cancelled");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: ids[0], quantityMt: 3, bin: "B02", remarks: "Combined" });
    expect(active[0].calendarManagedRelease).toBeUndefined();
    expect(active[0].notBefore).toBe("2026-10-29T02:00:00.000Z");
    expect(getJobSourceAllocations(active[0]).map(row => [row.sourceOrderId, row.plannedQuantity])).toEqual([["source-1", 1], ["source-2", 2]]);
    expect(combined.jobs.find(job => job.id === ids[1])?.status).toBe("cancelled");
  });
});
