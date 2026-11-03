import { describe, expect, it } from 'vitest';
import { createEmptyState } from './defaults';
import { nonWorkingWindows } from './planningWindows';

const at = (value: string) => Date.parse(value + '+08:00');
const settings = () => ({ ...createEmptyState().settings, dayStart: '07:00', availableHours: 12 });
const override = (lineId: 'PM1' | 'PM2', availableHours: number, dayStart = '07:00') => ({
  date: '2026-11-04', lineId, dayStart, availableHours, reason: 'Test exception', activatedAt: '2026-11-03T02:00:00.000Z',
});

describe('line timeline working-window backgrounds', () => {
  it('shows overtime as available while the other line keeps its normal finish', () => {
    const form = { ...settings(), workingHoursOverrides: [override('PM1', 14)] };
    expect(nonWorkingWindows(form, 'PM1', at('2026-11-04T07:00:00'), at('2026-11-04T21:00:00'))).toEqual([]);
    expect(nonWorkingWindows(form, 'PM2', at('2026-11-04T07:00:00'), at('2026-11-04T21:00:00'))).toEqual([
      { start: at('2026-11-04T19:00:00'), end: at('2026-11-04T21:00:00') },
    ]);
  });
  it('closes one date then restores the normal window on the next date', () => {
    const form = { ...settings(), workingHoursOverrides: [override('PM1', 0)] };
    expect(nonWorkingWindows(form, 'PM1', at('2026-11-04T07:00:00'), at('2026-11-05T19:00:00'))).toEqual([
      { start: at('2026-11-04T07:00:00'), end: at('2026-11-05T07:00:00') },
    ]);
  });
  it('includes the previous planning date overnight window and then returns to normal', () => {
    const form = { ...settings(), workingHoursOverrides: [override('PM1', 8, '22:00')] };
    expect(nonWorkingWindows(form, 'PM1', at('2026-11-05T00:00:00'), at('2026-11-05T09:00:00'))).toEqual([
      { start: at('2026-11-05T06:00:00'), end: at('2026-11-05T07:00:00') },
    ]);
  });
});
