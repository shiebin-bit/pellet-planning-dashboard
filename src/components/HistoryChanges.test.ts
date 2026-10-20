import { describe, expect, it } from 'vitest';
import { historyFieldLabel, historyValueLabel } from './HistoryChanges';

describe('readable audit snapshots', () => {
  it('keeps unknown, known zero and exact numeric changes distinct', () => {
    expect(historyValueLabel('actualQuantityMt', null)).toBe('Not set');
    expect(historyValueLabel('actualQuantityMt', 0)).toBe('0 MT');
    expect(historyValueLabel('quantityMt', 1.00001)).toBe('1.00001 MT');
    expect(historyValueLabel('bagCount', 240)).toBe('240 bags');
  });
  it('keeps the year and sub-minute differences visible in Malaysia time', () => {
    expect(historyValueLabel('actualEnd', '2026-10-20T06:12:13.123Z')).toBe('2026-10-20 14:12:13.123 MYT');
    expect(historyValueLabel('actualEnd', '2027-10-20T06:12:13.124Z')).toBe('2027-10-20 14:12:13.124 MYT');
    expect(historyValueLabel('actualEnd', 'Older imported value')).toBe('Older imported value');
  });
  it('labels units, state and future fields without losing values', () => {
    expect(historyFieldLabel('settings.rates.PM3')).toBe('PM3 rate (MT/hr)');
    expect(historyValueLabel('pauseState', 'paused')).toBe('Paused');
    expect(historyValueLabel('catalog.active', false)).toBe('No');
    expect(historyValueLabel('future.field', 'Custom snapshot')).toBe('Custom snapshot');
  });
});
