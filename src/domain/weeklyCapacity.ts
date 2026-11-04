import { getAvailableIntervals, getScheduledJobs, getShiftWindow, getWorkingHoursForDate } from './engine';
import { LINE_IDS, type AppState, type LineId } from './types';

const MINUTE = 60_000;
const DAY = 86_400_000;
export interface WeeklyLineCapacity {
  lineId: LineId;
  availableMinutes: number;
  productionMinutes: number;
  changeoverMinutes: number;
  openMinutes: number;
  unavailableWorkMinutes: number;
  load: number | null;
  plannedMt: number;
  carryInCount: number;
  carryOutCount: number;
  queuedCount: number;
  backlogCount: number;
  exception: boolean;
}
export interface CapacityDay {
  date: string;
  lines: WeeklyLineCapacity[];
}
export interface WeeklyCapacity {
  startDate: string;
  endDate: string;
  days: CapacityDay[];
}

export function capacityWeekDates(date: string): string[] {
  const instant = Date.parse(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date) throw new Error('Select a valid capacity date.');
  const monday = instant - ((new Date(instant).getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: 7 }, (_, index) => new Date(monday + index * DAY).toISOString().slice(0, 10));
}

/** Schedule once, then clip each batch to its line's own business shift. */
export function getWeeklyCapacity(state: AppState, selectedDate: string): WeeklyCapacity {
  const dates = capacityWeekDates(selectedDate);
  const scheduled = getScheduledJobs(state);
  const byLine = new Map(LINE_IDS.map(lineId => [lineId, scheduled.filter(job => job.lineId === lineId)]));
  const days = dates.map((date): CapacityDay => ({ date, lines: LINE_IDS.map((lineId): WeeklyLineCapacity => {
    const hours = getWorkingHoursForDate(state.settings, date, lineId);
    const shift = getShiftWindow(hours, date);
    const available = getAvailableIntervals(state.settings, lineId, date);
    const availableMinutes = available.reduce((sum, interval) => sum + (interval.end - interval.start) / MINUTE, 0);
    let productionMinutes = 0, changeoverMinutes = 0, plannedMt = 0, occupiedAvailable = 0, carryInCount = 0, carryOutCount = 0, queuedCount = 0;
    for (const job of byLine.get(lineId)!) {
      let inShiftProduction = 0, totalProduction = 0;
      for (const segment of job.segments) {
        const duration = Math.max(0, Math.min(segment.end, shift.end) - Math.max(segment.start, shift.start)) / MINUTE;
        if (segment.kind === 'production') {
          totalProduction += (segment.end - segment.start) / MINUTE;
          inShiftProduction += duration;
          productionMinutes += duration;
        } else changeoverMinutes += duration;
        for (const interval of available) occupiedAvailable += Math.max(0, Math.min(segment.end, interval.end) - Math.max(segment.start, interval.start)) / MINUTE;
      }
      if (totalProduction > 0) plannedMt += job.quantityMt * inShiftProduction / totalProduction;
      if (inShiftProduction > 0 && job.date < date) carryInCount++;
      if (job.date <= date && job.plannedEnd !== null && job.plannedEnd > shift.end) {
        if (inShiftProduction > 0) carryOutCount++;
        else queuedCount++;
      }
    }
    const booked = productionMinutes + changeoverMinutes;
    return {
      lineId, availableMinutes, productionMinutes, changeoverMinutes,
      openMinutes: Math.max(0, availableMinutes - occupiedAvailable),
      unavailableWorkMinutes: Math.max(0, booked - occupiedAvailable),
      load: availableMinutes > 0 ? booked / availableMinutes : null,
      plannedMt, carryInCount, carryOutCount, queuedCount,
      backlogCount: state.jobs.filter(job => job.date === date && job.lineId === lineId && job.status !== 'cancelled' && job.quantityMt <= 0).length,
      exception: hours.source === 'override',
    };
  }) }));
  return { startDate: dates[0], endDate: dates[6], days };
}
