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
      return job.id === anchor.id || allocations.length + anchorAllocations.length <= 500 && ![...sourceIds].some(sourceOrderId => anchorSourceIds.has(sourceOrderId));
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
