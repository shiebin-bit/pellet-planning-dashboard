import { describe, expect, it } from 'vitest';
import { estimateProductionCompletion, type ProductionEstimateInput } from './productionProgress';

const base = (patch: Partial<ProductionEstimateInput> = {}): ProductionEstimateInput => ({
  status: 'running', paused: false, plannedTotal: 100, actualTotal: 40,
  serverNow: '2026-11-03T02:30:00.000Z', plannedEnd: '2026-11-03T04:00:00.000Z',
  samples: [
    { id: 'a', cumulativeTotal: 10, sampledAt: '2026-11-03T02:00:00.000Z', trustworthy: true },
    { id: 'b', cumulativeTotal: 25, sampledAt: '2026-11-03T02:15:00.000Z', trustworthy: true },
    { id: 'c', cumulativeTotal: 40, sampledAt: '2026-11-03T02:30:00.000Z', trustworthy: true },
  ],
  ...patch,
});

describe('production completion estimate', () => {
  it('uses the median adjacent live rate and labels the result as an estimate', () => {
    const result = estimateProductionCompletion(base());
    expect(result.reason).toBeNull();
    expect(result.estimate).toMatchObject({ label: 'estimate', ratePerHour: 60, sampleCount: 3, status: 'ahead' });
    expect(result.estimate?.estimatedCompletionAt).toBe('2026-11-03T03:30:00.000Z');
  });

  it.each([
    [{ status: 'completed' as const }, 'not-running'],
    [{ paused: true }, 'paused'],
    [{ actualTotal: 100 }, 'target-reached'],
    [{ samples: base().samples.slice(1) }, 'insufficient-samples'],
    [{ serverNow: '2026-11-03T03:00:01.000Z' }, 'stale-sample'],
    [{ serverNow: '2026-11-03T02:29:59.000Z' }, 'stale-sample'],
    [{ actualTotal: 41 }, 'corrected'],
    [{ actualTotal: Number.NaN }, 'nonpositive-rate'],
    [{ plannedEnd: null }, 'no-locked-plan'],
  ])('suppresses unsafe estimates: %s', (patch, reason) => {
    expect(estimateProductionCompletion(base(patch)).reason).toBe(reason);
  });

  it('requires a fresh sample window after a correction reset', () => {
    expect(estimateProductionCompletion(base({ resetAt: '2026-11-03T02:10:00.000Z' })).reason).toBe('corrected');
  });

  it('subtracts persisted pause time from the rate window', () => {
    const result = estimateProductionCompletion(base({
      pauseIntervals: [{ pausedAt: '2026-11-03T02:15:00.000Z', resumedAt: '2026-11-03T02:20:00.000Z', reason: 'Feed check' }],
    }));
    expect(result.estimate?.ratePerHour).toBe(75);
  });

  it('rejects flat or decreasing cumulative samples', () => {
    const samples = base().samples.map((sample, index) => index === 1 ? { ...sample, cumulativeTotal: 10 } : sample);
    expect(estimateProductionCompletion(base({ samples })).reason).toBe('nonpositive-rate');
  });
});
