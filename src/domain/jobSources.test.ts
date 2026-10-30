import { describe, expect, it } from "vitest";
import { combinePendingJobs } from "./engine";
import {
  getCompatiblePendingJobs,
  getJobSourceAllocations,
  getProductionBatchIdentity,
} from "./jobSources";
import { createEmptyState } from "./defaults";
import type { Job, JobSourceAllocation } from "./types";

const allocation = (sourceOrderId: string): JobSourceAllocation => ({
  sourceOrderId,
  sourceOrderVersion: 1,
  sourceSnapshot: {
    doNo: sourceOrderId.toUpperCase(),
    materialCode: "7.0312008522050",
    description: "FS 5220 BROILER FINISHER PELLET II 50KG",
    quantity: 300,
    unit: "Bags",
  },
  plannedQuantity: 300,
});

const job = (id: string, sequence: number, patch: Partial<Job> = {}): Job => ({
  id,
  date: "2026-10-29",
  lineId: "PM4",
  sequence,
  orderNo: id.toUpperCase(),
  productCode: "7.0312008522050",
  description: "FS 5220 BROILER FINISHER PELLET II 50KG",
  bin: "",
  mode: "bags",
  bagCount: 300,
  quantityMt: 15,
  status: "pending",
  remarks: "",
  actualStart: null,
  actualEnd: null,
  binNeedsReview: false,
  createdAt: `2026-10-28T01:36:0${sequence}.000Z`,
  updatedAt: "2026-10-28T01:36:06.000Z",
  inventoryItemId: "inventory-5220-50kg",
  medication: "",
  fmrOmed: "",
  productionPurpose: "mto",
  bagWeightKgSnapshot: 50,
  sourceAllocations: [allocation(id)],
  ...patch,
});

describe("production batch compatibility", () => {
  it("uses the complete saved batch identity and ignores product-code case and outside whitespace", () => {
    const base = job("a", 1);
    expect(getProductionBatchIdentity(job("b", 2, { productCode: " 7.0312008522050 " })))
      .toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { productCode: "7.0312008522051" })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { medication: "MED-X" })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { fmrOmed: "FMR" })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { mode: "bulk", bagCount: null })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { bagWeightKgSnapshot: 25 })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { lineId: "PM3" })))
      .not.toBe(getProductionBatchIdentity(base));
    expect(getProductionBatchIdentity(job("b", 2, { date: "2026-10-30" })))
      .not.toBe(getProductionBatchIdentity(base));
  });

  it("returns only pending compatible source cards in production order", () => {
    const anchor = job("anchor", 2);
    const earlier = job("earlier", 1);
    const later = job("later", 3);
    const result = getCompatiblePendingJobs([
      later,
      job("running", 0, { status: "running", actualStart: "2026-10-29T00:00:00.000Z" }),
      job("material", 0, { productCode: "7.0312008522051" }),
      { ...job("manual", 0), sourceAllocations: undefined },
      anchor,
      earlier,
    ], anchor);
    expect(result.map(item => item.id)).toEqual(["earlier", "anchor", "later"]);
  });

  it("excludes duplicate source allocations within a card and source IDs already held by the anchor", () => {
    const anchor = job("anchor", 1);
    const duplicateInside = job("duplicate-inside", 2, {
      sourceAllocations: [allocation("dup"), allocation("dup")],
    });
    const duplicateAnchor = job("duplicate-anchor", 3, {
      sourceAllocations: [allocation("anchor")],
    });
    const valid = job("valid", 4);
    expect(getCompatiblePendingJobs([anchor, duplicateInside, duplicateAnchor, valid], anchor).map(item => item.id))
      .toEqual(["anchor", "valid"]);
    expect(getCompatiblePendingJobs([valid], duplicateInside)).toEqual([]);
  });

  it("does not offer a card whose saved allocation list exceeds the command limit", () => {
    const anchor = job("anchor", 1);
    const oversized = job("oversized", 2, {
      sourceAllocations: Array.from({ length: 501 }, (_, index) => allocation(`order-${index}`)),
    });
    expect(getCompatiblePendingJobs([anchor, oversized], anchor).map(item => item.id)).toEqual(["anchor"]);
    expect(getCompatiblePendingJobs([anchor], oversized)).toEqual([]);
    const full = {...oversized, sourceAllocations: oversized.sourceAllocations!.slice(0, 500)};
    expect(getCompatiblePendingJobs([anchor, full], anchor).map(item => item.id)).toEqual(["anchor"]);
    const withinLimit = {...full, sourceAllocations: full.sourceAllocations.slice(0, 499)};
    expect(getCompatiblePendingJobs([anchor, withinLimit], anchor).map(item => item.id)).toEqual(["anchor", "oversized"]);
  });

  it("keeps the contextual predicate aligned with the transactional combine command", () => {
    const first = job("first", 1);
    const second = job("second", 2);
    const state = { ...createEmptyState(), jobs: [first, second] };
    expect(getCompatiblePendingJobs(state.jobs, first).map(item => item.id)).toEqual(["first", "second"]);
    const combined = combinePendingJobs(state, [first.id, second.id], "BIN-1", "One run", "2026-10-29T01:00:00.000Z");
    const survivor = combined.jobs.find(item => item.id === first.id)!;
    expect(getJobSourceAllocations(survivor).map(row => row.sourceOrderId)).toEqual(["first", "second"]);
    expect(survivor).toMatchObject({ bagCount: 600, quantityMt: 30, orderNo: "FIRST +1" });
    expect(combined.jobs.find(item => item.id === second.id)?.status).toBe("cancelled");
  });
});
