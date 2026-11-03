import { getShiftWindow, getWorkingHoursForDate } from './engine';
import type { LineId, Settings } from './types';

const DAY_MS = 86_400_000;
const dateAt = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);

/** Display-only complement of line working windows, including overnight carry-in. */
export function nonWorkingWindows(settings: Settings, lineId: LineId, start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 168 * 3_600_000) return [];
  const firstDay = Date.parse(dateAt(start) + 'T00:00:00Z') - DAY_MS;
  const lastDay = Date.parse(dateAt(end) + 'T00:00:00Z');
  const open: Array<{ start: number; end: number }> = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    const hours = getWorkingHoursForDate(settings, date, lineId);
    if (!hours.availableHours) continue;
    const window = getShiftWindow(hours, date);
    if (window.end > start && window.start < end) open.push({ start: Math.max(start, window.start), end: Math.min(end, window.end) });
  }
  open.sort((a, b) => a.start - b.start);
  const closed: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const window of open) {
    if (window.start > cursor) closed.push({ start: cursor, end: window.start });
    cursor = Math.max(cursor, window.end);
  }
  if (cursor < end) closed.push({ start: cursor, end });
  return closed;
}
