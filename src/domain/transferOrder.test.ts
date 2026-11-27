import { describe, expect, it } from "vitest";
import { createEmptyState } from "./defaults";
import { executeCommand, parseCommand } from "./commands";
import { createJob } from "./engine";
import { getJobSourceAllocations, getOrderTransferBatchIdentity, isTransferableOrderBatch } from "./jobSources";
import type { AppState, Job, JobSourceAllocation, LineId } from "./types";

const NOW = "2026-11-27T02:00:00.000Z";
const allocation = (id: string, quantity: number): JobSourceAllocation => ({
  sourceOrderId: id,
  sourceOrderVersion: 3,
  plannedQuantity: quantity,
  sourceSnapshot: { doNo: `DO-${id}`, materialCode: "FEED-1", description: "Test feed", quantity: 500, unit: "Bags" },
});

function addBatch(state: AppState, lineId: LineId, bags: number, allocations: JobSourceAllocation[], notBefore: string): [AppState, Job] {
  const next = createJob(state, {
    date: "2026-11-27", lineId, orderNo: allocations[0]?.sourceSnapshot.doNo ?? "EXTRA",
    productCode: "FEED-1", description: "Test feed", bin: "BIN-1", mode: "bags",
    bagCount: bags, quantityMt: bags * 0.025, remarks: "Keep", inventoryItemId: "item-1",
    medication: "MED", fmrOmed: "FMR", productionPurpose: "mto", bagWeightKgSnapshot: 25, notBefore,
  });
  const id = next.jobs.at(-1)!.id;
  const jobs = next.jobs.map(job => job.id === id ? {
    ...job,
    ...(allocations.length ? { sourceAllocations: allocations.map(row => ({ ...row, sourceSnapshot: { ...row.sourceSnapshot } })) } : {}),
  } : job);
  return [{ ...next, jobs }, jobs.find(job => job.id === id)!];
}

describe("source-order allocation transfer", () => {
  it("merges a whole share into a compatible extras-only batch and keeps extras at both sides", () => {
    let state = createEmptyState();
    let source: Job;
    [state, source] = addBatch(state, "PM1", 120, [allocation("A", 60), allocation("B", 40)], "2026-11-27T08:00:00.000Z");
    state = { ...state, jobs: state.jobs.map(job => job.id === source.id ? { ...job, calendarManagedRelease: true } : job) };
    let target: Job;
    [state, target] = addBatch(state, "PM2", 10, [], "2026-11-27T09:00:00.000Z");
    const originalSnapshot = structuredClone(getJobSourceAllocations(source)[0].sourceSnapshot);

    const next = executeCommand(state, {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM2", targetJobId: target.id,
    }, { nowIso: NOW });
    const savedSource = next.jobs.find(job => job.id === source.id)!;
    const savedTarget = next.jobs.find(job => job.id === target.id)!;

    expect(savedSource).toMatchObject({ bagCount: 60, quantityMt: 1.5, status: "pending" });
    expect(getJobSourceAllocations(savedSource).map(row => [row.sourceOrderId, row.plannedQuantity])).toEqual([["B", 40]]);
    expect(savedTarget).toMatchObject({ bagCount: 70, quantityMt: 1.75, binNeedsReview: true, notBefore: "2026-11-27T09:00:00.000Z" });
    expect(savedTarget.calendarManagedRelease).toBeUndefined();
    expect(getJobSourceAllocations(savedTarget).map(row => [row.sourceOrderId, row.plannedQuantity])).toEqual([["A", 60]]);
    expect(getJobSourceAllocations(savedTarget)[0].sourceSnapshot).toEqual(originalSnapshot);
    expect(savedSource.bagCount! + savedTarget.bagCount!).toBe(130);
    expect(next.events.at(-1)).toMatchObject({ type: "job.order-transferred", jobId: target.id });
  });

  it("creates a standalone destination and cancels an emptied source without erasing its history", () => {
    let state = createEmptyState();
    let source: Job;
    [state, source] = addBatch(state, "PM1", 40, [allocation("A", 40)], "2026-11-27T08:00:00.000Z");
    const next = executeCommand(state, {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM3",
    }, { nowIso: NOW });
    const cancelled = next.jobs.find(job => job.id === source.id)!;
    const destination = next.jobs.find(job => job.id !== source.id)!;

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.bagCount).toBe(40);
    expect(getJobSourceAllocations(cancelled).map(row => [row.sourceOrderId, row.plannedQuantity])).toEqual([["A", 40]]);
    expect(destination).toMatchObject({ lineId: "PM3", bagCount: 40, quantityMt: 1, status: "pending", binNeedsReview: true });
    expect(getJobSourceAllocations(destination)).toEqual(getJobSourceAllocations(cancelled));
  });

  it("rejoins matching portions of one order into one saved allocation", () => {
    let state = createEmptyState();
    let source: Job;
    [state, source] = addBatch(state, "PM1", 20, [allocation("A", 20)], "2026-11-27T08:00:00.000Z");
    let target: Job;
    [state, target] = addBatch(state, "PM4", 35, [allocation("A", 30)], "2026-11-27T08:00:00.000Z");
    const next = executeCommand(state, {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM4", targetJobId: target.id,
    }, { nowIso: NOW });
    const destination = next.jobs.find(job => job.id === target.id)!;
    expect(destination.bagCount).toBe(55);
    expect(getJobSourceAllocations(destination).map(row => [row.sourceOrderId, row.plannedQuantity])).toEqual([["A", 50]]);
  });

  it("exports UI guards and rejects incompatible, locked or malformed transfers atomically", () => {
    let state = createEmptyState();
    let source: Job;
    [state, source] = addBatch(state, "PM1", 20, [allocation("A", 20)], "2026-11-27T08:00:00.000Z");
    let target: Job;
    [state, target] = addBatch(state, "PM2", 10, [], "2026-11-27T08:00:00.000Z");
    expect(isTransferableOrderBatch(source)).toBe(true);
    expect(getOrderTransferBatchIdentity(source)).toBe(getOrderTransferBatchIdentity(target));
    const incompatible = { ...state, jobs: state.jobs.map(job => job.id === target.id ? { ...job, medication: "OTHER" } : job) };
    expect(() => executeCommand(incompatible, {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM2", targetJobId: target.id,
    }, { nowIso: NOW })).toThrow(/same date, product, packaging/i);
    expect(incompatible.jobs.find(job => job.id === source.id)?.status).toBe("pending");
    expect(() => executeCommand({ ...state, jobs: state.jobs.map(job => job.id === source.id ? { ...job, actualQuantityMt: 0 } : job) }, {
      type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM2",
    }, { nowIso: NOW })).toThrow(/without actual output/i);
    const command = { type: "job.transferOrder", jobId: source.id, sourceOrderId: "A", toLineId: "PM2", targetJobId: target.id } as const;
    expect(parseCommand(command)).toEqual(command);
    expect(() => parseCommand({ ...command, quantity: 20 })).toThrow(/not supported/i);
    expect(() => parseCommand({ ...command, targetJobId: source.id })).toThrow(/must differ/i);
  });
});
