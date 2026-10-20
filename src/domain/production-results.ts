import type { Job, LineId } from "./types";

const MINUTE_MS = 60_000;

export interface ProductionResult {
  actualQuantityMt: number | null;
  varianceMt: number | null;
  shortfallMt: number | null;
  elapsedMinutes: number | null;
  downtimeMinutes: number;
  netProductionMinutes: number | null;
  isPaused: boolean;
}

export function getProductionResult(job: Job, asOfMs?: number): ProductionResult {
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

  const start = parseTimestamp(job.actualStart);
  const end = resultEnd(job, asOfMs);
  const elapsedMinutes = start === null || end === null || end < start
    ? null
    : (end - start) / MINUTE_MS;
  const downtimeMinutes = elapsedMinutes === null
    ? 0
    : getDowntimeMinutesForWindow([job], start!, end!, end!, job.lineId);

  return {
    actualQuantityMt,
    varianceMt,
    shortfallMt: varianceMt === null ? null : Math.max(0, -varianceMt),
    elapsedMinutes,
    downtimeMinutes,
    netProductionMinutes: elapsedMinutes === null
      ? null
      : Math.max(0, elapsedMinutes - downtimeMinutes),
    isPaused: isJobPaused(job),
  };
}

export function isJobPaused(job: Job): boolean {
  return job.status === "running" && job.pauseIntervals?.at(-1)?.resumedAt === null;
}

export function getDowntimeMinutesForWindow(
  jobs: readonly Job[],
  startMs: number,
  endMs: number,
  asOfMs: number,
  lineId?: LineId,
): number {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(asOfMs) ||
    endMs <= startMs
  ) return 0;
  let totalMs = 0;
  for (const job of jobs) {
    if (lineId && job.lineId !== lineId) continue;
    const completedEnd = job.status === "completed" ? parseTimestamp(job.actualEnd) : null;
    const jobEnd = completedEnd === null ? endMs : Math.min(endMs, completedEnd);
    if (jobEnd <= startMs) continue;
    for (const pause of job.pauseIntervals ?? []) {
      const pauseStart = Date.parse(pause.pausedAt);
      const rawPauseEnd = pause.resumedAt === null ? asOfMs : Date.parse(pause.resumedAt);
      const pauseEnd = Math.min(rawPauseEnd, jobEnd);
      if (!Number.isFinite(pauseStart) || !Number.isFinite(pauseEnd) || pauseEnd <= pauseStart) continue;
      totalMs += Math.max(0, pauseEnd - Math.max(startMs, pauseStart));
    }
  }
  return totalMs / MINUTE_MS;
}

function resultEnd(job: Job, asOfMs?: number): number | null {
  if (job.status === "completed") return parseTimestamp(job.actualEnd);
  if (job.status !== "running") return null;
  const candidate = asOfMs ?? Date.now();
  return Number.isFinite(candidate) ? candidate : null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
