import type { Job, JobSourceAllocation } from "./types";

/** New grouped cards use sourceAllocations; legacy singular links remain readable. */
export function getJobSourceAllocations(job: Job): JobSourceAllocation[] {
  if (job.sourceAllocations?.length) return job.sourceAllocations;
  if (!job.sourceOrderId || !job.sourceOrderVersion || !job.sourceSnapshot) return [];
  return [{
    sourceOrderId: job.sourceOrderId,
    sourceOrderVersion: job.sourceOrderVersion,
    sourceSnapshot: job.sourceSnapshot,
    plannedQuantity: job.mode === "bags" ? job.bagCount ?? 0 : job.quantityMt,
  }];
}

export function jobHasSourceOrder(job: Job, sourceOrderId: string): boolean {
  return getJobSourceAllocations(job).some(allocation => allocation.sourceOrderId === sourceOrderId);
}

/** Same-order portions can rejoin only when their saved source version and facts agree. */
export function mergeSourceAllocations(rows: JobSourceAllocation[]): JobSourceAllocation[] {
  const merged = new Map<string,JobSourceAllocation>();
  for (const row of rows) {
    const prior = merged.get(row.sourceOrderId);
    if (prior && allocationSnapshotKey(prior) !== allocationSnapshotKey(row)) throw new Error('Order portions have different saved versions or details. Refresh and review them before combining.');
    if (prior) prior.plannedQuantity = Math.round((prior.plannedQuantity + row.plannedQuantity) * 1000) / 1000;
    else merged.set(row.sourceOrderId,{...row,sourceSnapshot:{...row.sourceSnapshot}});
  }
  if (merged.size > 500) throw new Error('A combined card can contain at most 500 source orders.');
  return [...merged.values()];
}
function allocationSnapshotKey(row: JobSourceAllocation): string {
  const s=row.sourceSnapshot;
  return JSON.stringify([row.sourceOrderVersion,s.doNo,s.materialCode,s.description,s.quantity,s.unit,s.deliveryDate??null,s.soldToParty??null,s.shipToParty??null]);
}

/**
 * Stable identity for one physical production batch. The short FS display code is
 * deliberately excluded: cards may only combine when their full saved product and
 * inventory variant match on the same date and line.
 */
export function getProductionBatchIdentity(job: Job): string {
  return [
    job.date,
    job.lineId,
    job.productCode.trim().toLowerCase(),
    job.mode,
    job.inventoryItemId ?? "",
    job.medication?.trim() ?? "",
    job.fmrOmed?.trim() ?? "",
    String(job.bagWeightKgSnapshot ?? ""),
    job.productionPurpose ?? "",
  ].join("\u0000");
}

/** A pending batch whose quantity and source allocations may still be reshaped safely. */
export function isTransferableOrderBatch(job: Job): boolean {
  return job.status === "pending"
    && job.actualStart === null
    && job.actualEnd === null
    && job.actualQuantityMt == null
    && !job.lockedSegments?.length
    && !job.pauseIntervals?.length;
}

/**
 * Physical batch identity used when moving one order allocation between PMs.
 * It deliberately excludes only the PM; date, packaging and inventory variant
 * must remain identical. Extras-only cards are valid destinations.
 */
export function getOrderTransferBatchIdentity(job: Job): string {
  return [
    job.date,
    job.productCode.trim().toLowerCase(),
    job.mode,
    job.inventoryItemId ?? "",
    job.medication?.trim() ?? "",
    job.fmrOmed?.trim() ?? "",
    String(job.bagWeightKgSnapshot ?? ""),
    job.productionPurpose ?? "",
  ].join("\u0000");
}

/**
 * Contextual choices that may be offered beside a pending source-linked card.
 * Final aggregate validation remains in combinePendingJobs so stale selections are
 * rejected transactionally.
 */
export function getCompatiblePendingJobs(jobs: Job[], anchor: Job): Job[] {
  const anchorAllocations = getJobSourceAllocations(anchor);
  const anchorSourceIds = sourceIdsIfDistinct(anchorAllocations);
  if (anchor.status !== "pending" || !anchorSourceIds || anchorAllocations.length > 500) return [];
  const identity = getProductionBatchIdentity(anchor);
  return jobs
    .filter(job => {
      if (job.status !== "pending" || getProductionBatchIdentity(job) !== identity) return false;
      const allocations = getJobSourceAllocations(job);
      const sourceIds = sourceIdsIfDistinct(allocations);
      if (!sourceIds || allocations.length > 500) return false;
      try {mergeSourceAllocations([...anchorAllocations,...allocations]); return true;} catch {return false;}
    })
    .sort((left, right) =>
      left.lineId.localeCompare(right.lineId) ||
      left.sequence - right.sequence ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id));
}

function sourceIdsIfDistinct(allocations: JobSourceAllocation[]): Set<string> | null {
  if (!allocations.length) return null;
  const sourceIds = new Set(allocations.map(allocation => allocation.sourceOrderId));
  return sourceIds.size === allocations.length ? sourceIds : null;
}
