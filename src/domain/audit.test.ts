import { describe, expect, it } from "vitest";
import { executeCommand } from "./commands";
import { createDefaultSettings, createEmptyState } from "./defaults";
import type { JobInput } from "./types";

describe("structured audit changes", () => {
  it("records only normalized fields changed on the subject job", () => {
    const created = executeCommand(createEmptyState(), { type: "job.create", input: input("A") });
    const id = created.jobs[0].id;
    expect(created.events.at(-1)?.changes).toEqual(expect.arrayContaining([
      { field: "orderNo", before: null, after: "ORDER-A" },
      { field: "description", before: null, after: "Description A" },
      { field: "status", before: null, after: "pending" },
    ]));
    const updated = executeCommand(created, {
      type: "job.update", jobId: id, patch: { description: "  Revised description  ", remarks: "same" },
    });
    expect(updated.events.at(-1)?.changes).toEqual([
      { field: "description", before: "Description A", after: "Revised description" },
    ]);
  });

  it("does not include incidental resequencing of other jobs in move audit", () => {
    let state = executeCommand(createEmptyState(), { type: "job.create", input: input("A") });
    state = executeCommand(state, { type: "job.create", input: input("B") });
    const [first, second] = state.jobs;
    const moved = executeCommand(state, {
      type: "job.move", jobId: second.id, toLineId: "PM1", beforeJobId: first.id,
    });
    expect(moved.events.at(-1)?.changes).toEqual([
      { field: "sequence", before: 2, after: 1 },
    ]);
    expect(moved.jobs.find(job => job.id === first.id)?.sequence).toBe(2);
  });

  it("records lifecycle values without timestamps used only as mutation metadata", () => {
    const created = executeCommand(createEmptyState(), { type: "job.create", input: input("RUN") });
    const id = created.jobs[0].id;
    const started = executeCommand(created, {
      type: "job.start", jobId: id,
    }, { nowIso: "2026-10-15T01:00:00.000Z" });
    expect(started.events.at(-1)?.changes).toEqual([
      { field: "status", before: "pending", after: "running" },
      { field: "actualStart", before: null, after: "2026-10-15T01:00:00.000Z" },
    ]);

    const completed = executeCommand(started, {
      type: "job.complete", jobId: id, actualQuantityMt: 0.75, completionNote: "  Weigh-in  ",
    }, { nowIso: "2026-10-15T02:00:00.000Z" });
    expect(completed.events.at(-1)?.changes).toEqual([
      { field: "status", before: "running", after: "completed" },
      { field: "actualEnd", before: null, after: "2026-10-15T02:00:00.000Z" },
      { field: "actualQuantityMt", before: null, after: 0.75 },
      { field: "completionNote", before: null, after: "Weigh-in" },
    ]);
    expect(completed.events.at(-1)?.changes?.some(change => change.field === "updatedAt")).toBe(false);
  });

  it("records causal settings and catalog changes without job recalculation noise", () => {
    let state = executeCommand(createEmptyState(), { type: "job.create", input: { ...input("BAGS"), mode: "bags", bagCount: 20, quantityMt: 1 } });
    state = executeCommand(state, {
      type: "settings.update",
      settings: { ...createDefaultSettings(), bagWeightKg: 40, slowProductPrefixes: [" 6811 "] },
    });
    expect(state.events.at(-1)?.changes).toEqual([
      { field: "settings.bagWeightKg", before: 50, after: 40 },
      { field: "settings.slowProductPrefixes", before: '["6811","6542"]', after: '[" 6811 "]' },
    ]);
    expect(state.events.at(-1)?.changes?.some(change => change.field === "quantityMt")).toBe(false);

    const created = executeCommand(state, {
      type: "catalog.create",
      input: { code: " P1 ", description: " Product one ", defaultMode: "bulk" },
    }, { nowIso: "2026-10-15T01:00:00.000Z" });
    expect(created.events.at(-1)?.changes).toEqual([
      { field: "catalog.code", before: null, after: "P1" },
      { field: "catalog.description", before: null, after: "Product one" },
      { field: "catalog.defaultMode", before: null, after: "bulk" },
      { field: "catalog.active", before: null, after: true },
    ]);
  });
});

function input(code: string): JobInput {
  return {
    date: "2026-10-15",
    lineId: "PM1",
    orderNo: `ORDER-${code}`,
    productCode: code,
    description: `Description ${code}`,
    bin: "B01",
    mode: "bulk",
    bagCount: null,
    quantityMt: 1,
    remarks: "same",
  };
}
