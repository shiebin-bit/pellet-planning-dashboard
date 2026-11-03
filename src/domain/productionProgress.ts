import type { JobStatus, ProductionPause } from './types';
import type { InventoryUnit } from './inventoryTypes';
import type { PortableInventoryData } from './inventoryTypes';
import type { PortableSourceDataWithReviews } from './sourceTypes';
import type { AppState } from './types';

export const PROGRESS_MIN_SAMPLE_COUNT = 3;
export const PROGRESS_MIN_ACTIVE_MINUTES = 15;
export const PROGRESS_MAX_SAMPLE_AGE_MINUTES = 20;
export const PROGRESS_ON_PLAN_MINUTES = 5;

export type ProductionEstimateUnavailableReason =
  | 'not-tracked'
  | 'not-running'
  | 'paused'
  | 'insufficient-samples'
  | 'stale-sample'
  | 'corrected'
  | 'target-reached'
  | 'nonpositive-rate'
  | 'no-locked-plan';

export interface ProductionProgressSampleView {
  id: string;
  cumulativeTotal: number;
  sampledAt: string;
  trustworthy: boolean;
}

export interface ProductionProgressEstimate {
  label: 'estimate';
  estimatedCompletionAt: string;
  ratePerHour: number;
  sampleCount: number;
  windowStartedAt: string;
  deltaMinutes: number;
  status: 'ahead' | 'on-plan' | 'late';
}

export interface JobProductionProgress {
  jobId: string;
  status: JobStatus;
  paused: boolean;
  unit: InventoryUnit;
  plannedTotal: number;
  actualTotal: number | null;
  samples: ProductionProgressSampleView[];
  estimate: ProductionProgressEstimate | null;
  estimateUnavailableReason: ProductionEstimateUnavailableReason | null;
}

export interface ProductionProgressSnapshot {
  revision: number;
  serverNow: string;
  jobs: JobProductionProgress[];
}

export interface PortableProductionProgress {
  samples: Array<{
    id: string;
    jobId: string;
    commandId: string;
    cumulativeScaled: string;
    sampledAt: string;
    recordedAt: string;
    source: 'operator-live' | 'completion';
    trustworthy: boolean;
    untrustedReason: string | null;
  }>;
  resets: Array<{
    id: string;
    jobId: string;
    commandId: string;
    resetAt: string;
    reason: string;
  }>;
}

export interface PortableWorkspaceBackupV5 {
  schemaVersion: 5;
  exportedAt: string;
  planning: AppState;
  sourceData: PortableSourceDataWithReviews;
  inventory: PortableInventoryData;
  productionProgress: PortableProductionProgress;
}

export interface ProductionEstimateInput {
  status: JobStatus;
  paused: boolean;
  plannedTotal: number;
  actualTotal: number;
  samples: ProductionProgressSampleView[];
  serverNow: string;
  plannedEnd: string | null;
  pauseIntervals?: ProductionPause[];
  resetAt?: string | null;
}

export function estimateProductionCompletion(input: ProductionEstimateInput): {
  estimate: ProductionProgressEstimate | null;
  reason: ProductionEstimateUnavailableReason | null;
} {
  if (![input.plannedTotal, input.actualTotal].every(value => Number.isFinite(value) && value >= 0)) return unavailable('nonpositive-rate');
  if (input.status !== 'running') return unavailable('not-running');
  if (input.paused) return unavailable('paused');
  if (input.actualTotal >= input.plannedTotal) return unavailable('target-reached');

  const now = timestamp(input.serverNow);
  const resetAt = input.resetAt ? timestamp(input.resetAt) : null;
  const samples = input.samples
    .filter(sample => sample.trustworthy && (resetAt === null || timestamp(sample.sampledAt) > resetAt))
    .slice()
    .sort((left, right) => timestamp(left.sampledAt) - timestamp(right.sampledAt));
  if (samples.length < PROGRESS_MIN_SAMPLE_COUNT) {
    return unavailable(resetAt === null ? 'insufficient-samples' : 'corrected');
  }
  const latest = samples.at(-1)!;
  const latestAt = timestamp(latest.sampledAt);
  if (latestAt > now || now - latestAt > PROGRESS_MAX_SAMPLE_AGE_MINUTES * 60_000) return unavailable('stale-sample');
  if (latest.cumulativeTotal !== input.actualTotal) return unavailable('corrected');

  const firstAt = timestamp(samples[0].sampledAt);
  const activeWindowMinutes = activeMinutes(firstAt, latestAt, input.pauseIntervals ?? []);
  if (activeWindowMinutes < PROGRESS_MIN_ACTIVE_MINUTES) return unavailable('insufficient-samples');

  const rates: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const quantity = current.cumulativeTotal - previous.cumulativeTotal;
    const minutes = activeMinutes(timestamp(previous.sampledAt), timestamp(current.sampledAt), input.pauseIntervals ?? []);
    if (quantity <= 0 || minutes <= 0) return unavailable('nonpositive-rate');
    rates.push(quantity / minutes * 60);
  }
  const ratePerHour = median(rates);
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return unavailable('nonpositive-rate');
  if (!input.plannedEnd) return unavailable('no-locked-plan');
  const plannedEnd = timestamp(input.plannedEnd);
  const completion = now + (input.plannedTotal - input.actualTotal) / ratePerHour * 3_600_000;
  if (!Number.isFinite(completion)) return unavailable('nonpositive-rate');
  const deltaMinutes = (completion - plannedEnd) / 60_000;
  return {
    estimate: {
      label: 'estimate',
      estimatedCompletionAt: new Date(completion).toISOString(),
      ratePerHour,
      sampleCount: samples.length,
      windowStartedAt: new Date(firstAt).toISOString(),
      deltaMinutes,
      status: Math.abs(deltaMinutes) <= PROGRESS_ON_PLAN_MINUTES ? 'on-plan' : deltaMinutes < 0 ? 'ahead' : 'late',
    },
    reason: null,
  };
}

function unavailable(reason: ProductionEstimateUnavailableReason) {
  return { estimate: null, reason };
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid progress timestamp: ${value}`);
  return result;
}

function activeMinutes(start: number, end: number, pauses: ProductionPause[]): number {
  if (end <= start) return 0;
  let paused = 0;
  for (const interval of pauses) {
    const pauseStart = Date.parse(interval.pausedAt);
    const pauseEnd = interval.resumedAt === null ? end : Date.parse(interval.resumedAt);
    if (!Number.isFinite(pauseStart) || !Number.isFinite(pauseEnd)) continue;
    paused += Math.max(0, Math.min(end, pauseEnd) - Math.max(start, pauseStart));
  }
  return Math.max(0, end - start - paused) / 60_000;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
