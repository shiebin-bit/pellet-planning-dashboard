import { getWorkingHoursForDate, getScheduledJobs, getShiftWindow } from "./engine";
import { LINE_IDS, type AppState } from "./types";

const MINUTE_MS = 60_000;

export interface OverviewMetrics {
  /** Whole-card quantity assigned to the selected planning date. */
  assignedDateMt: number;
  /** Quantity represented by production time physically inside the selected shift. */
  inShiftPlannedMt: number;
}

export function getOverviewMetrics(state: AppState, date: string): OverviewMetrics {
  const scheduled = getScheduledJobs(state);
  const shifts = new Map(LINE_IDS.map(line => [line, getShiftWindow(getWorkingHoursForDate(state.settings, date, line), date)]));
  const assignedDateMt = state.jobs.reduce(
    (total, job) => total + (job.date === date && job.status !== "cancelled" ? job.quantityMt : 0),
    0,
  );
  const inShiftPlannedMt = scheduled.reduce((total, job) => {
    const shift = shifts.get(job.lineId)!;
    const production = job.segments.filter(segment => segment.kind === "production");
    const totalProductionMinutes = production.reduce(
      (minutes, segment) => minutes + (segment.end - segment.start) / MINUTE_MS,
      0,
    );
    if (totalProductionMinutes <= 0) return total;
    const inShiftMinutes = production.reduce(
      (minutes, segment) => minutes + Math.max(0, Math.min(segment.end, shift.end) - Math.max(segment.start, shift.start)) / MINUTE_MS,
      0,
    );
    return total + job.quantityMt * inShiftMinutes / totalProductionMinutes;
  }, 0);
  return { assignedDateMt, inShiftPlannedMt };
}
