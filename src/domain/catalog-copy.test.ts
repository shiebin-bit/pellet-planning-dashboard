import { describe, expect, it } from "vitest";
import { executeCommand, parseCommand } from "./commands";
import { createEmptyState } from "./defaults";
import { getScheduledJobs } from "./engine";
import type { AppState, JobInput, LineId, QuantityMode } from "./types";

const NOW = "2026-10-20T03:04:05.000Z";

describe("product catalog commands", () => {
  it("trims catalog values, keeps stable ids, preserves inactive products, and audits changes", () => {
    const created = executeCommand(createEmptyState(), {
      type: "catalog.create",
      input: { code: "  AB-01  ", description: "  Starter pellet  ", defaultMode: "bags" },
    }, { nowIso: NOW });
    expect(created.catalog[0]).toMatchObject({
      code: "AB-01", description: "Starter pellet", defaultMode: "bags", active: true,
    });
    expect(created.events.at(-1)).toMatchObject({ type: "catalog.created", at: NOW });
    const id = created.catalog[0].id;

    const updated = executeCommand(created, {
      type: "catalog.update",
      productId: id,
      patch: { description: "  Revised pellet  ", defaultMode: "bulk" },
    }, { nowIso: NOW });
    expect(updated.catalog[0]).toMatchObject({ id, code: "AB-01", description: "Revised pellet", defaultMode: "bulk" });

    const inactive = executeCommand(updated, {
      type: "catalog.setActive", productId: id, active: false,
    }, { nowIso: NOW });
    const reactivated = executeCommand(inactive, {
      type: "catalog.setActive", productId: id, active: true,
    }, { nowIso: NOW });
    expect(reactivated.catalog[0]).toMatchObject({ id, active: true });
    expect(reactivated.events.map(event => event.type).slice(-3)).toEqual([
      "catalog.updated", "catalog.activation-changed", "catalog.activation-changed",
    ]);
  });

  it("enforces case-insensitive code uniqueness across inactive products without changing jobs", () => {
    const base = withJob(createEmptyState(), "SOURCE", "bags", "2026-10-15", "PM1");
    const created = executeCommand(base, {
      type: "catalog.create",
      input: { code: "Mix-7", description: "First", defaultMode: "bags" },
    }, { nowIso: NOW });
    const inactive = executeCommand(created, {
      type: "catalog.setActive", productId: created.catalog[0].id, active: false,
    }, { nowIso: NOW });
    const jobsBefore = structuredClone(inactive.jobs);
    expect(() => executeCommand(inactive, {
      type: "catalog.create",
      input: { code: "  MIX-7  ", description: "Duplicate", defaultMode: "bulk" },
    }, { nowIso: NOW })).toThrow(/already exists/i);
    const second = executeCommand(inactive, {
      type: "catalog.create",
      input: { code: "SECOND", description: "Second", defaultMode: "bulk" },
    }, { nowIso: NOW });
    expect(() => executeCommand(second, {
      type: "catalog.update",
      productId: second.catalog.find(product => product.code === "SECOND")!.id,
      patch: { code: " mix-7 " },
    }, { nowIso: NOW })).toThrow(/already exists/i);
    expect(inactive.jobs).toEqual(jobsBefore);
  });

  it("strictly parses catalog commands and catalog limits", () => {
    expect(parseCommand({
      type: "catalog.create",
      input: { code: "  P1  ", description: "  Product one  ", defaultMode: "bulk" },
    })).toEqual({
      type: "catalog.create",
      input: { code: "P1", description: "Product one", defaultMode: "bulk" },
    });
    expect(() => parseCommand({ type: "catalog.update", productId: "p1", patch: {} })).toThrow(/at least one/i);
    expect(() => parseCommand({
      type: "catalog.create",
      input: { code: "x".repeat(81), description: "Product", defaultMode: "bulk" },
    })).toThrow(/80 characters/i);
    expect(() => parseCommand({
      type: "catalog.setActive", productId: "p1", active: "yes" },
    )).toThrow(/true or false/i);
  });
});

describe("job copy batch command", () => {
  it("copies in source order, appends sequences, recalculates bags, and leaves source snapshots untouched", () => {
    let state = withJob(createEmptyState(), "BAG-SOURCE", "bags", "2026-10-15", "PM1");
    state = withJob(state, "BULK-SOURCE", "bulk", "2026-10-15", "PM1");
    state = withJob(state, "EXISTING-TARGET", "bulk", "2026-10-16", "PM1");
    const sources = state.jobs.filter(job => job.date === "2026-10-15");
    const originalJobs = structuredClone(state.jobs);
    const plansBefore = planMap(state);

    const copied = executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [
        { sourceJobId: sources[1].id, orderNo: " NEW-BULK ", quantity: { mode: "bulk", quantityMt: 2.25 } },
        { sourceJobId: sources[0].id, orderNo: " NEW-BAGS ", quantity: { mode: "bags", bagCount: 11 } },
      ],
    }, { nowIso: NOW });

    expect(copied.jobs.slice(0, originalJobs.length)).toEqual(originalJobs);
    const additions = copied.jobs.slice(originalJobs.length);
    expect(additions.map(job => [job.orderNo, job.sequence])).toEqual([
      ["NEW-BAGS", 2], ["NEW-BULK", 3],
    ]);
    expect(additions[0]).toMatchObject({
      productCode: "BAG-SOURCE", description: "BAG-SOURCE description", bin: "B01",
      mode: "bags", bagCount: 11, quantityMt: 0.55, status: "pending",
      remarks: "Source remarks", binNeedsReview: false, actualStart: null, actualEnd: null,
      createdAt: NOW, updatedAt: NOW,
    });
    expect(additions[0]).not.toHaveProperty("actualQuantityMt");
    expect(additions[0]).not.toHaveProperty("completionNote");
    expect(additions[0]).not.toHaveProperty("issue");
    expect(additions[0]).not.toHaveProperty("lockedSegments");
    expect(additions[1]).toMatchObject({ mode: "bulk", bagCount: null, quantityMt: 2.25 });
    expect(copied.events.filter(event => event.type === "plan.copied")).toHaveLength(1);
    expect(copied.events.at(-1)).toMatchObject({ type: "plan.copied", at: NOW });
    for (const [id, signature] of plansBefore) {
      expect(planMap(copied).get(id)).toBe(signature);
    }
  });

  it("validates the whole batch before mutation and rejects mixed invalid items", () => {
    const state = withJob(createEmptyState(), "BAG-SOURCE", "bags", "2026-10-15", "PM1");
    const source = state.jobs[0];
    const snapshot = JSON.stringify(state);
    expect(() => executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [
        { sourceJobId: source.id, orderNo: "VALID", quantity: { mode: "bags", bagCount: 10 } },
        { sourceJobId: "missing", orderNo: "INVALID", quantity: { mode: "bulk", quantityMt: 2 } },
      ],
    }, { nowIso: NOW })).toThrow(/not found/i);
    expect(JSON.stringify(state)).toBe(snapshot);

    expect(() => executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [
        { sourceJobId: source.id, orderNo: "ONE", quantity: { mode: "bags", bagCount: 10 } },
        { sourceJobId: source.id, orderNo: "TWO", quantity: { mode: "bags", bagCount: 20 } },
      ],
    }, { nowIso: NOW })).toThrow(/duplicated/i);

    expect(() => executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-15",
      items: [{ sourceJobId: source.id, orderNo: "SAME-DAY", quantity: { mode: "bags", bagCount: 10 } }],
    }, { nowIso: NOW })).toThrow(/must differ/i);
    expect(() => executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [{ sourceJobId: source.id, orderNo: "WRONG-MODE", quantity: { mode: "bulk", quantityMt: 1 } }],
    }, { nowIso: NOW })).toThrow(/must match bags/i);
  });

  it("allows copied backlog to carry forward before an existing future-day job", () => {
    let state = withJob(createEmptyState(), "SOURCE", "bulk", "2026-10-15", "PM1");
    state = withJob(state, "FUTURE", "bulk", "2026-10-17", "PM1");
    const source = state.jobs.find(job => job.productCode === "SOURCE")!;
    const snapshot = JSON.stringify(state);
    const copied = executeCommand(state, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [{ sourceJobId: source.id, orderNo: "OVERFLOW", quantity: { mode: "bulk", quantityMt: 200 } }],
    }, { nowIso: NOW });
    expect(copied.jobs).toHaveLength(state.jobs.length + 1);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("strictly parses batch shape, quantity unions, bounds, and dates", () => {
    expect(parseCommand({
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [{ sourceJobId: " source-1 ", orderNo: " order-1 ", quantity: { mode: "bulk", quantityMt: 0 } }],
    })).toMatchObject({
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [{ sourceJobId: "source-1", orderNo: "order-1" }],
    });
    expect(() => parseCommand({
      type: "job.copyBatch", sourceDate: "2026-10-15", targetDate: "2026-10-16", items: [],
    })).toThrow(/at least one/i);
    expect(() => parseCommand({
      type: "job.copyBatch", sourceDate: "2026-10-15", targetDate: "2026-10-16",
      items: [{ sourceJobId: "s", orderNo: "o", quantity: { mode: "bags", quantityMt: 1 } }],
    })).toThrow(/bagCount|required|not supported/i);
    expect(() => parseCommand({
      type: "job.copyBatch", sourceDate: "2026-10-15", targetDate: "2026-10-16",
      items: Array.from({ length: 501 }, (_, index) => ({
        sourceJobId: `s-${index}`, orderNo: `o-${index}`, quantity: { mode: "bulk", quantityMt: 1 },
      })),
    })).toThrow(/500 items/i);
  });
});

function withJob(
  state: AppState,
  productCode: string,
  mode: QuantityMode,
  date: string,
  lineId: LineId,
): AppState {
  const input: JobInput = {
    date,
    lineId,
    orderNo: `ORDER-${productCode}`,
    productCode,
    description: `${productCode} description`,
    bin: "B01",
    mode,
    bagCount: mode === "bags" ? 10 : null,
    quantityMt: mode === "bags" ? 0.5 : 1,
    remarks: "Source remarks",
  };
  return executeCommand(state, { type: "job.create", input });
}

function planMap(state: AppState): Map<string, string> {
  return new Map(getScheduledJobs(state).map(job => [job.id, JSON.stringify({
    plannedStart: job.plannedStart,
    plannedEnd: job.plannedEnd,
    segments: job.segments,
  })]));
}
