import { describe, expect, it } from "vitest";
import { createEmptyState } from "../domain/defaults";
import { planInventoryDraft } from "../domain/inventoryPlanner";
import type { InventoryDraftJob, InventoryDraftPreview } from "../domain/inventoryTypes";
import {
  PLANNING_DRAFT_STORAGE_KEY,
  clearPlanningDraft,
  createPlanningDraft,
  isPlanningDraftStale,
  parsePlanningDraft,
  planningDraftFingerprint,
  preparePlanningDraftCommit,
  readPlanningDraft,
  regeneratePlanningDraftIdentity,
  savePlanningDraft,
  type PlanningDraftStorage,
} from "./planningDraftStorage";

const UPDATED = "2026-10-31T01:00:00.000Z";

class MemoryStorage implements PlanningDraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function job(overrides: Partial<InventoryDraftJob> = {}): InventoryDraftJob {
  return {
    draftId: "draft-job-1", itemId: "item-1", sourceOrderId: "source-1",
    sourceAllocations: [{ sourceOrderId: "source-1", plannedQuantity: 2 }],
    orderNo: "DO-1", materialCode: "MAT-1", description: "Feed", unit: "MT", bagWeightKg: null,
    productionPurpose: "mto", date: "2026-11-01", lineId: "PM1", quantity: 2,
    notBefore: "2026-11-01T00:00:00.000Z", bin: "", remarks: "", medication: "", fmrOmed: "", ...overrides,
  };
}

function preview(): InventoryDraftPreview {
  const draftJob = job();
  return {
    revision: 5,
    generatedAt: UPDATED,
    request: { fromDate: "2026-11-01", toDate: "2026-11-02", demandThrough: "2026-11-05", combineSameProduct: true },
    demand: [{
      key: "demand-1", itemId: "item-1", materialCode: "MAT-1", description: "Feed", unit: "MT", bagWeightKg: null,
      strategy: "mto", purpose: "mto", sourceOrderId: "source-1", orderNo: "DO-1", dueDate: "2026-11-05",
      notBefore: "2026-11-01T00:00:00.000Z", sourceAllocationQuantity: 2, quantity: 2, medication: "", fmrOmed: "",
    }],
    jobs: [draftJob], backlog: [],
    utilization: [{ date: "2026-11-01", lineId: "PM1", hours: 0.25, availableHours: 12 }],
    late: [],
  };
}

function saved() {
  const p = preview();
  return createPlanningDraft({
    baseRevision: 5, baseUpdatedAt: UPDATED, preview: p, jobs: p.jobs,
    ui: { from: "2026-11-01", to: "2026-11-02", demandThrough: "2026-11-05", combineSameProduct: true },
    draftInstanceId: "draft-instance-1", savedAt: "2026-10-31T02:00:00.000Z",
  });
}

describe("browser planning draft storage", () => {
  it("round trips one strict v1 draft and reports workspace staleness without rebasing", () => {
    const storage = new MemoryStorage(); const draft = saved();
    expect(savePlanningDraft(storage, draft, { draftInstanceId: null }).ok).toBe(true);
    const current = readPlanningDraft(storage, { revision: 5, updatedAt: UPDATED });
    expect(current).toMatchObject({ ok: true, value: { stale: false, requiresFreshGeneration: false, canRetryPendingCommit: false, draft: { draftInstanceId: "draft-instance-1" } } });
    expect(readPlanningDraft(storage, { revision: 6, updatedAt: UPDATED })).toMatchObject({ ok: true, value: { stale: true, requiresFreshGeneration: true } });
    expect(isPlanningDraftStale(draft, { revision: 6, updatedAt: UPDATED })).toBe(true);
    expect(isPlanningDraftStale(draft, { revision: 5, updatedAt: "2026-10-31T01:00:01.000Z" })).toBe(true);
    expect(isPlanningDraftStale(draft, { revision: null, updatedAt: null })).toBe(true);
    const regenerated = regeneratePlanningDraftIdentity(draft, "2026-10-31T03:00:00.000Z");
    expect(regenerated.draftInstanceId).not.toBe(draft.draftInstanceId);
    expect(regenerated.pendingCommit).toBeUndefined();
  });

  it("persists an exact retryable command before returning it and reloads it unchanged", () => {
    const storage = new MemoryStorage(); const draft = saved();
    expect(savePlanningDraft(storage, draft, { draftInstanceId: null }).ok).toBe(true);
    const prepared = preparePlanningDraftCommit(storage, draft, "command-1");
    expect(prepared).toMatchObject({ ok: true, value: { request: { expectedRevision: 5, commandId: "command-1", command: { type: "planning.commitDraft", previewRevision: 5 } } } });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.value.request.command.jobs).toEqual(draft.jobs);
    const reloaded = readPlanningDraft(storage);
    expect(reloaded.ok && reloaded.value.draft?.pendingCommit).toEqual(prepared.value.request);
    expect(reloaded).toMatchObject({ ok: true, value: { requiresFreshGeneration: false, canRetryPendingCommit: true } });
    expect(clearPlanningDraft(storage, { draftInstanceId: draft.draftInstanceId, pendingCommandId: "different" })).toMatchObject({ ok: false, code: "conflict" });
    expect(clearPlanningDraft(storage, { draftInstanceId: draft.draftInstanceId, pendingCommandId: "command-1" }).ok).toBe(true);
  });

  it("rejects unknown fields, unresolved sources, allocation mismatches, and tampered pending commands", () => {
    const original = saved();
    expect(() => parsePlanningDraft(JSON.stringify({ ...original, surprise: true }))).toThrow(/surprise.*not supported/i);
    const unresolved = structuredClone(original); unresolved.jobs[0].sourceAllocations![0].sourceOrderId = "missing";
    expect(() => parsePlanningDraft(JSON.stringify(unresolved))).toThrow(/not present in preview demand/i);
    const over = structuredClone(original); over.jobs[0].sourceAllocations![0].plannedQuantity = 3;
    expect(() => parsePlanningDraft(JSON.stringify(over))).toThrow(/cannot exceed/i);
    const previewMismatch = structuredClone(original); previewMismatch.preview.demand[0].sourceAllocationQuantity = 1;
    expect(() => parsePlanningDraft(JSON.stringify(previewMismatch))).toThrow(/exceed preview demand/i);
    const pending = { ...structuredClone(original), pendingCommit: { expectedRevision: 5, commandId: "command-1", command: { type: "planning.commitDraft", previewRevision: 5, jobs: [job({ quantity: 1, sourceAllocations: [{ sourceOrderId: "source-1", plannedQuantity: 1 }] })] } } };
    expect(() => parsePlanningDraft(JSON.stringify(pending))).toThrow(/exactly match/i);
  });

  it("bounds dates, quantities, enums, arrays, and serialized size", () => {
    const invalidDate = structuredClone(saved()); invalidDate.ui.from = "2026-02-30";
    expect(() => parsePlanningDraft(JSON.stringify(invalidDate))).toThrow(/valid YYYY-MM-DD/i);
    const invalidQuantity = structuredClone(saved()); invalidQuantity.jobs[0].quantity = 1.0001;
    expect(() => parsePlanningDraft(JSON.stringify(invalidQuantity))).toThrow(/at most 3 decimals/i);
    const invalidLine = structuredClone(saved()) as any; invalidLine.jobs[0].lineId = "PM9";
    expect(() => parsePlanningDraft(JSON.stringify(invalidLine))).toThrow(/lineId.*invalid/i);
    expect(() => parsePlanningDraft(`{"padding":"${"x".repeat(8 * 1024 * 1024)}"}`)).toThrow(/8 MB/i);
  });

  it("accepts a real partial planner preview whose backlog repeats its demand key and has zero allocation remaining", () => {
    const state = createEmptyState();
    const generated = planInventoryDraft(state, [{
      key: "partial-order", itemId: "item-1", materialCode: "MAT-1", description: "Feed", unit: "MT", bagWeightKg: null,
      strategy: "mto", purpose: "mto", sourceOrderId: "source-1", orderNo: "DO-PARTIAL", dueDate: "2026-11-01",
      notBefore: "2026-11-01T00:00:00.000Z", sourceAllocationQuantity: 1, quantity: 10_000, medication: "", fmrOmed: "",
    }], { fromDate: "2026-11-01", toDate: "2026-11-01" }, 5, "2026-10-31T01:00:00.000Z");
    expect(generated.backlog).toHaveLength(1);
    expect(generated.backlog[0].key).toBe(generated.demand[0].key);
    expect(generated.backlog[0].sourceAllocationQuantity).toBe(0);
    const parsed = createPlanningDraft({
      baseRevision: 5, baseUpdatedAt: UPDATED, preview: generated, jobs: generated.jobs,
      ui: { from: "2026-11-01", to: "2026-11-01", demandThrough: "2026-11-01", combineSameProduct: true },
      draftInstanceId: "partial-planner", savedAt: "2026-10-31T02:00:00.000Z",
    });
    expect(parsed.preview.backlog[0]).toMatchObject({ key: "partial-order", sourceAllocationQuantity: 0 });
  });

  it("does not clear data after browser failures or cross-tab identity conflicts", () => {
    const storage = new MemoryStorage(); const draft = saved();
    expect(savePlanningDraft(storage, draft, { draftInstanceId: null }).ok).toBe(true);
    const replacement = { ...draft, draftInstanceId: "other-tab", savedAt: "2026-10-31T04:00:00.000Z" };
    storage.setItem(PLANNING_DRAFT_STORAGE_KEY, JSON.stringify(replacement));
    expect(savePlanningDraft(storage, draft, { draftInstanceId: draft.draftInstanceId })).toMatchObject({ ok: false, code: "conflict" });
    expect(parsePlanningDraft(storage.getItem(PLANNING_DRAFT_STORAGE_KEY)!).draftInstanceId).toBe("other-tab");

    storage.setItem(PLANNING_DRAFT_STORAGE_KEY, JSON.stringify({ ...draft, savedAt: "2026-10-31T04:00:00.000Z" }));
    expect(savePlanningDraft(storage, draft, { draftInstanceId: draft.draftInstanceId, savedAt: draft.savedAt })).toMatchObject({ ok: false, code: "conflict" });
    expect(clearPlanningDraft(storage, { draftInstanceId: draft.draftInstanceId, draftFingerprint: planningDraftFingerprint(draft) })).toMatchObject({ ok: false, code: "conflict" });

    const failing: PlanningDraftStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readPlanningDraft(failing)).toMatchObject({ ok: false, code: "unavailable" });
    expect(clearPlanningDraft(failing)).toMatchObject({ ok: false, code: "unavailable" });

    storage.setItem(PLANNING_DRAFT_STORAGE_KEY, "not-json");
    expect(readPlanningDraft(storage)).toMatchObject({ ok: false, code: "invalid" });
    expect(storage.getItem(PLANNING_DRAFT_STORAGE_KEY)).toBe("not-json");
  });
});
