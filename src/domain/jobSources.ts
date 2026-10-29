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
