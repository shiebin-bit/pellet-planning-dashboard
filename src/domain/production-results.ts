import type { Job } from "./types";

export interface ProductionResult {
  actualQuantityMt: number | null;
  varianceMt: number | null;
  shortfallMt: number | null;
  elapsedMinutes: number | null;
}

export function getProductionResult(job: Job): ProductionResult {
  const actualQuantityMt =
    typeof job.actualQuantityMt === "number" &&
    Number.isFinite(job.actualQuantityMt) &&
    job.actualQuantityMt >= 0
      ? job.actualQuantityMt
      : null;
  const plannedQuantityMt =
    Number.isFinite(job.quantityMt) && job.quantityMt >= 0
      ? job.quantityMt
      : null;
  const varianceMt =
    actualQuantityMt !== null && plannedQuantityMt !== null
      ? actualQuantityMt - plannedQuantityMt
      : null;

  return {
    actualQuantityMt,
    varianceMt,
    shortfallMt: varianceMt === null ? null : Math.max(0, -varianceMt),
    elapsedMinutes: elapsedMinutes(job.actualStart, job.actualEnd),
  };
}

function elapsedMinutes(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}
