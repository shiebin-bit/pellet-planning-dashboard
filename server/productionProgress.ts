import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { isJobPaused } from '../src/domain/production-results';
import { quantityToScaled, scaledToQuantity } from '../src/domain/inventory';
import {
  estimateProductionCompletion,
  type JobProductionProgress,
  type PortableProductionProgress,
  type ProductionProgressSampleView,
  type ProductionProgressSnapshot,
} from '../src/domain/productionProgress';
import type { AppState, Job } from '../src/domain/types';
import type { InventoryUnit } from '../src/domain/inventoryTypes';
import { ApiError } from './errors';

interface ItemUnitRow { id: string; unit: InventoryUnit }
interface TotalRow { job_id: string; total: string }
interface SampleRow {
  id: string; job_id: string; command_id: string; cumulative_scaled: string;
  sampled_at: string | Date; recorded_at: string | Date; source: 'operator-live' | 'completion';
  trustworthy: boolean; untrusted_reason: string | null;
}
interface ResetRow { id: string; job_id: string; command_id: string; reset_at: string | Date; reason: string }

export interface ProductionProgressCommandContext {
  commandId?: string;
  receiptSource?: 'operator-live' | 'completion';
}

export function parseProductionProgressJobIds(query: URLSearchParams): string[] {
  for (const [name] of query) if (name !== 'jobId') throw new ApiError(400, 'INVALID_PROGRESS_FILTER', `Production progress filter ${name} is not supported.`);
  const ids = query.getAll('jobId').map(value => value.trim());
  if (!ids.length || ids.length > 100) throw new ApiError(400, 'INVALID_PROGRESS_JOB_IDS', 'Supply between 1 and 100 production card ids.');
  if (ids.some(id => !id || id.length > 200)) throw new ApiError(400, 'INVALID_PROGRESS_JOB_IDS', 'Production card ids must be nonblank text of 200 characters or fewer.');
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'DUPLICATE_PROGRESS_JOB_ID', 'Production card ids must be unique.');
  return ids;
}

export async function getProductionProgress(
  client: pg.PoolClient,
  state: AppState,
  revision: number,
  jobIds: readonly string[],
  serverNow = new Date().toISOString(),
): Promise<ProductionProgressSnapshot> {
  const byId = new Map(state.jobs.map(job => [job.id, job]));
  for (const id of jobIds) if (!byId.has(id)) throw new ApiError(404, 'JOB_NOT_FOUND', `Production card ${id} was not found.`);
  const trackedIds = jobIds.filter(id => byId.get(id)!.inventoryItemId);
  const itemIds = [...new Set(trackedIds.map(id => byId.get(id)!.inventoryItemId!))];
  // A PoolClient owns one database connection. Keep these reads sequential so the
  // repeatable-read snapshot also remains compatible with pg 9, which rejects
  // overlapping queries on a single client.
  const itemsResult = itemIds.length
    ? await client.query<ItemUnitRow>('SELECT id,unit FROM inventory_items WHERE workspace_id=1 AND id=ANY($1::text[])', [itemIds])
    : { rows: [] as ItemUnitRow[] };
  const totalsResult = trackedIds.length
    ? await client.query<TotalRow>(`SELECT requested.job_id,
          COALESCE(sum(CASE WHEN ledger.movement_type='production' THEN ledger.quantity_delta_scaled
            WHEN ledger.movement_type='reversal' AND original.movement_type='production' THEN ledger.quantity_delta_scaled ELSE 0 END),0)::text total
        FROM unnest($1::text[]) requested(job_id)
        LEFT JOIN inventory_ledger ledger ON ledger.job_id=requested.job_id
        LEFT JOIN inventory_ledger original ON original.id=ledger.reverses_movement_id
        GROUP BY requested.job_id`, [trackedIds])
    : { rows: [] as TotalRow[] };
  const samplesResult = trackedIds.length
    ? await client.query<SampleRow>(`SELECT id,job_id,command_id,cumulative_scaled::text,sampled_at,recorded_at,source,trustworthy,untrusted_reason
          FROM production_progress_samples WHERE workspace_id=1 AND job_id=ANY($1::text[])
          ORDER BY sampled_at,id`, [trackedIds])
    : { rows: [] as SampleRow[] };
  const resetsResult = trackedIds.length
    ? await client.query<ResetRow>(`SELECT DISTINCT ON (job_id) id,job_id,command_id,reset_at,reason
          FROM production_progress_resets WHERE workspace_id=1 AND job_id=ANY($1::text[])
          ORDER BY job_id,reset_at DESC,id DESC`, [trackedIds])
    : { rows: [] as ResetRow[] };
  const units = new Map(itemsResult.rows.map(row => [row.id, row.unit]));
  const totals = new Map(totalsResult.rows.map(row => [row.job_id, integer(row.total)]));
  const resetByJob = new Map(resetsResult.rows.map(row => [row.job_id, iso(row.reset_at)]));
  const samplesByJob = new Map<string, ProductionProgressSampleView[]>();
  for (const row of samplesResult.rows) {
    const job = byId.get(row.job_id)!;
    const unit = units.get(job.inventoryItemId!);
    if (!unit) continue;
    const view = { id: row.id, cumulativeTotal: scaledToQuantity(unit, integer(row.cumulative_scaled)), sampledAt: iso(row.sampled_at), trustworthy: row.trustworthy };
    samplesByJob.set(row.job_id, [...(samplesByJob.get(row.job_id) ?? []), view]);
    if (!row.trustworthy) {
      const currentReset = resetByJob.get(row.job_id);
      if (!currentReset || Date.parse(view.sampledAt) > Date.parse(currentReset)) resetByJob.set(row.job_id, view.sampledAt);
    }
  }
  const jobs: JobProductionProgress[] = jobIds.map(jobId => {
    const job = byId.get(jobId)!;
    const fallbackUnit: InventoryUnit = job.mode === 'bags' ? 'Bags' : 'MT';
    const unit = job.inventoryItemId ? units.get(job.inventoryItemId) : undefined;
    const plannedTotal = nativePlannedTotal(job, unit ?? fallbackUnit);
    if (!job.inventoryItemId || !unit) return {
      jobId, status: job.status, paused: isJobPaused(job), unit: fallbackUnit, plannedTotal,
      actualTotal: null, samples: [], estimate: null, estimateUnavailableReason: 'not-tracked',
    };
    const actualTotal = scaledToQuantity(unit, totals.get(jobId) ?? 0);
    const samples = samplesByJob.get(jobId) ?? [];
    const productionEnds = (job.lockedSegments ?? []).filter(segment => segment.kind === 'production').map(segment => segment.end);
    const result = estimateProductionCompletion({
      status: job.status,
      paused: isJobPaused(job),
      plannedTotal,
      actualTotal,
      samples,
      serverNow,
      plannedEnd: productionEnds.length ? new Date(Math.max(...productionEnds)).toISOString() : null,
      pauseIntervals: job.pauseIntervals,
      resetAt: resetByJob.get(jobId) ?? null,
    });
    return { jobId, status: job.status, paused: isJobPaused(job), unit, plannedTotal, actualTotal, samples, estimate: result.estimate, estimateUnavailableReason: result.reason };
  });
  return { revision, serverNow, jobs };
}

export async function recordProductionProgressSample(client: pg.PoolClient, input: {
  commandId: string;
  job: Job;
  unit: InventoryUnit;
  cumulativeScaled: number;
  previousScaled: number;
  occurredOn: string;
  recordedAt: string;
  source: 'operator-live' | 'completion';
}): Promise<void> {
  const plannedScaled = quantityToScaled(input.unit, nativePlannedTotal(input.job, input.unit), 'planned production total');
  const today = malaysiaDate(input.recordedAt);
  const reason = input.source === 'completion' ? 'completion'
    : input.job.status !== 'running' ? 'not-running'
    : isJobPaused(input.job) ? 'paused'
    : input.occurredOn !== today ? 'backdated-posting'
    : input.cumulativeScaled <= input.previousScaled ? 'non-increasing'
    : input.cumulativeScaled >= plannedScaled ? 'target-reached'
    : null;
  await client.query(`INSERT INTO production_progress_samples
      (id,workspace_id,job_id,command_id,cumulative_scaled,sampled_at,recorded_at,source,trustworthy,untrusted_reason)
    VALUES($1,1,$2,$3,$4,$5::timestamptz,$5::timestamptz,$6,$7,$8)
    ON CONFLICT(command_id) DO NOTHING`,
  [randomUUID(), input.job.id, input.commandId, input.cumulativeScaled, input.recordedAt, input.source, reason === null, reason]);
}

export async function recordProductionProgressReset(client: pg.PoolClient, input: { commandId: string; jobId: string; resetAt: string; reason: string }): Promise<void> {
  await client.query(`INSERT INTO production_progress_resets(id,workspace_id,job_id,command_id,reset_at,reason)
    VALUES($1,1,$2,$3,$4::timestamptz,$5) ON CONFLICT(command_id) DO NOTHING`,
  [randomUUID(), input.jobId, input.commandId, input.resetAt, input.reason.trim() || 'Production total corrected.']);
}

export async function exportProductionProgress(client: pg.PoolClient): Promise<PortableProductionProgress> {
  const samples = await client.query<SampleRow>('SELECT id,job_id,command_id,cumulative_scaled::text,sampled_at,recorded_at,source,trustworthy,untrusted_reason FROM production_progress_samples WHERE workspace_id=1 ORDER BY sampled_at,id');
  const resets = await client.query<ResetRow>('SELECT id,job_id,command_id,reset_at,reason FROM production_progress_resets WHERE workspace_id=1 ORDER BY reset_at,id');
  return {
    samples: samples.rows.map(row => ({ id: row.id, jobId: row.job_id, commandId: row.command_id, cumulativeScaled: row.cumulative_scaled, sampledAt: iso(row.sampled_at), recordedAt: iso(row.recorded_at), source: row.source, trustworthy: row.trustworthy, untrustedReason: row.untrusted_reason })),
    resets: resets.rows.map(row => ({ id: row.id, jobId: row.job_id, commandId: row.command_id, resetAt: iso(row.reset_at), reason: row.reason })),
  };
}

export async function clearProductionProgress(client: pg.PoolClient): Promise<void> {
  await client.query('DELETE FROM production_progress_resets WHERE workspace_id=1');
  await client.query('DELETE FROM production_progress_samples WHERE workspace_id=1');
}

export async function restoreProductionProgress(client: pg.PoolClient, data: PortableProductionProgress): Promise<void> {
  for (const row of data.samples) await client.query(`INSERT INTO production_progress_samples
    (id,workspace_id,job_id,command_id,cumulative_scaled,sampled_at,recorded_at,source,trustworthy,untrusted_reason)
    VALUES($1,1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9)`,
  [row.id,row.jobId,row.commandId,row.cumulativeScaled,row.sampledAt,row.recordedAt,row.source,row.trustworthy,row.untrustedReason]);
  for (const row of data.resets) await client.query(`INSERT INTO production_progress_resets(id,workspace_id,job_id,command_id,reset_at,reason)
    VALUES($1,1,$2,$3,$4::timestamptz,$5)`, [row.id,row.jobId,row.commandId,row.resetAt,row.reason]);
}

function nativePlannedTotal(job: Job, unit: InventoryUnit): number {
  return unit === 'Bags' ? job.bagCount ?? 0 : job.quantityMt;
}
function integer(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Production progress quantity is outside the safe integer range.');
  return result;
}
function iso(value: string | Date): string { return new Date(value).toISOString(); }
function malaysiaDate(value: string): string { return new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 10); }
