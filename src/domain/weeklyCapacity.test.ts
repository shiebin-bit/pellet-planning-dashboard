import { describe, expect, it } from 'vitest';
import { createEmptyState } from './defaults';
import { capacityWeekDates, getWeeklyCapacity } from './weeklyCapacity';
import type { AppState, Job, LineId } from './types';

const monday = '2026-11-02';
function job(id: string, date = monday, patch: Partial<Job> = {}): Job {
  return { id, date, lineId: 'PM1', sequence: 1, orderNo: id, productCode: 'FEED', description: 'Fictional feed', bin: '', mode: 'bulk', bagCount: null, quantityMt: 10, status: 'pending', remarks: '', actualStart: null, actualEnd: null, binNeedsReview: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...patch };
}
function state(jobs: Job[] = []): AppState {
  const app = createEmptyState();
  app.jobs = jobs; app.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 }; return app;
}
const line = (app: AppState, date = monday, lineId: LineId = 'PM1') => getWeeklyCapacity(app, date).days.find(day => day.date === date)!.lines.find(line => line.lineId === lineId)!;

describe('weekly capacity', () => {
  it('uses a Monday–Sunday week across month/year boundaries and rejects invalid dates', () => {
    expect(capacityWeekDates('2027-01-01')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(capacityWeekDates('2026-11-08')[0]).toBe(monday);
    expect(() => capacityWeekDates('2026-02-30')).toThrow('valid');
  });
  it('shows real empty capacity, counts changeover in load, and excludes cancelled work', () => {
    const empty = line(state()); expect(empty.availableMinutes).toBe(720); expect(empty.load).toBe(0); expect(empty.openMinutes).toBe(720);
    const app = state([job('first'), job('second', monday, { sequence: 2, productCode: 'OTHER' }), job('cancelled', monday, { sequence: 3, quantityMt: 999, status: 'cancelled' })]);
    const result = line(app); expect(result.productionMinutes).toBe(120); expect(result.changeoverMinutes).toBe(30); expect(result.load).toBeCloseTo(150 / 720); expect(result.openMinutes).toBe(570); expect(result.plannedMt).toBe(20);
  });
  it('deducts overlapping downtime once and respects per-line overtime and closures', () => {
    const app = state([job('long', monday, { quantityMt: 140 })]);
    app.settings.workingHoursOverrides = [
      { date: monday, lineId: 'PM1', dayStart: '07:00', availableHours: 14, reason: 'Extra shift', activatedAt: '2026-11-01T00:00:00Z' },
      { date: monday, lineId: 'PM2', dayStart: '07:00', availableHours: 0, reason: 'Closed', activatedAt: '2026-11-01T00:00:00Z' },
    ];
    app.settings.downtime = [{ id: 'a', lineId: 'PM1', date: monday, start: '12:00', end: '13:00', reason: 'Cleaning' }, { id: 'b', lineId: 'PM1', date: monday, start: '12:30', end: '13:30', reason: 'Service' }];
    const result = line(app); expect(result.availableMinutes).toBe(750); expect(result.productionMinutes).toBe(750); expect(result.plannedMt).toBe(125); expect(result.load).toBe(1); expect(result.carryOutCount).toBe(1);
    expect(line(app, monday, 'PM2')).toMatchObject({ availableMinutes: 0, load: null, exception: true });
    expect(line(app, '2026-11-03').availableMinutes).toBe(720);
  });
  it('counts only the physical portion of a cross-day batch, with carry-in and carry-out', () => {
    const app = state([job('split', monday, { quantityMt: 30 })]); app.settings.availableHours = 2;
    const first = line(app), next = line(app, '2026-11-03');
    expect(first.plannedMt).toBe(20); expect(first.carryOutCount).toBe(1);
    expect(next.plannedMt).toBe(10); expect(next.carryInCount).toBe(1); expect(next.carryOutCount).toBe(0);
    expect(getWeeklyCapacity(app, monday).days.reduce((sum, day) => sum + day.lines[0].plannedMt, 0)).toBe(30);
  });
  it('keeps overnight work within its business date and the following date separate', () => {
    const app = state([job('night', monday, { quantityMt: 60 })]); app.settings.dayStart = '20:00'; app.settings.availableHours = 8;
    app.settings.downtime = [{ id: 'night-pause', date: monday, lineId: 'PM1', start: '23:00', end: '01:00', reason: 'Overnight service' }];
    expect(line(app)).toMatchObject({ availableMinutes: 360, productionMinutes: 360, plannedMt: 60, carryOutCount: 0, openMinutes: 0 });
    expect(line(app, '2026-11-03').productionMinutes).toBe(0);
  });
  it('shows work waiting across a closed day as queued rather than physically continuing', () => {
    const app = state([job('split-over-closure', monday, { quantityMt: 30 })]); app.settings.availableHours = 2;
    app.settings.workingHoursOverrides = [{ date: '2026-11-03', lineId: 'PM1', dayStart: '07:00', availableHours: 0, reason: 'Closed', activatedAt: '2026-11-01T00:00:00Z' }];
    expect(line(app, '2026-11-03')).toMatchObject({ availableMinutes: 0, plannedMt: 0, carryInCount: 0, carryOutCount: 0, queuedCount: 1 });
    expect(line(app, '2026-11-04')).toMatchObject({ plannedMt: 10, carryInCount: 1, carryOutCount: 0, queuedCount: 0 });
  });
  it('retains locked historical work and flags time outside availability instead of inventing free capacity', () => {
    const app = state([job('locked', monday, { quantityMt: 20, status: 'completed', actualStart: '2026-11-01T23:00:00Z', actualEnd: '2026-11-02T01:00:00Z', lockedSegments: [{ jobId: 'locked', lineId: 'PM1', kind: 'production', start: Date.parse('2026-11-01T23:00:00Z'), end: Date.parse('2026-11-02T01:00:00Z') }] })]);
    app.settings.availableHours = 1;
    app.settings.downtime = [{ id: 'a', date: monday, lineId: 'PM1', start: '07:00', end: '08:00', reason: 'Unavailable' }];
    expect(line(app)).toMatchObject({ availableMinutes: 0, load: null, productionMinutes: 60, unavailableWorkMinutes: 60, plannedMt: 10 });
  });
  it('preserves native precision, flags jobs awaiting quantity and never mutates the input', () => {
    const app = state([job('tiny', monday, { quantityMt: .001 }), job('needs-quantity', monday, { quantityMt: 0, sequence: 2 })]);
    const before = JSON.stringify(app); expect(line(app).plannedMt).toBeCloseTo(.001, 12); expect(line(app).backlogCount).toBe(1); expect(JSON.stringify(app)).toBe(before);
  });
});
