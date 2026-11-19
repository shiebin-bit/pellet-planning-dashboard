import { plannedMtInWindow, getWorkingHoursForDate, getScheduledJobs, getShiftWindow } from "./engine";
import { LINE_IDS, type AppState } from "./types";


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
    return total + plannedMtInWindow(job, shift.start, shift.end);
  }, 0);
  return { assignedDateMt, inShiftPlannedMt };
}
