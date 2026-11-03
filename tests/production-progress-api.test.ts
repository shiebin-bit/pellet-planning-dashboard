import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { createApp } from '../server/app';
import { runMigrations } from '../server/migrate';
import { WorkspaceStore } from '../server/store';
import { createDefaultSettings } from '../src/domain/defaults';
import type { InventoryWorkbookInput } from '../src/domain/inventoryTypes';
import type { ProductionProgressSnapshot } from '../src/domain/productionProgress';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('production progress API', () => {
  let pool: pg.Pool;
  let server: Server;
  let store: WorkspaceStore;
  let baseUrl: string;

  before(async () => {
    assertDedicatedTestDatabase(databaseUrl!, process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000 });
    await runMigrations(pool);
    store = new WorkspaceStore(pool);
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port.');
    server.on('request', createApp({ store, hostPorts: new Set([address.port]), distDir: 'Z:\\missing', allowedOrigins: new Set([`http://127.0.0.1:${address.port}`]) }));
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');
    const settings = createDefaultSettings();
    settings.changeoverMinutes = 0;
    settings.rates = { PM1: 100, PM2: 100, PM3: 100, PM4: 100 };
    await store.initialize(settings);
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
  });

  it('reports authoritative progress, estimates only from live samples, resets after correction and deduplicates retries', async () => {
    await store.execute(0, 'progress-baseline', { type: 'inventory.importBaseline', input: baselineInput() });
    const order = (await store.getInventoryOrders()).orders[0];
    // Progress must also work outside the planning shift. Manual order planning
    // avoids making this receipt test depend on today's remaining draft capacity.
    let workspace = await store.execute(1, 'progress-plan', { type: 'job.createFromSources', input: {
      orders: [{ sourceOrderId: order.sourceOrderId, sourceOrderVersion: 1, plannedQuantity: 100 }],
      date: malaysiaToday(), lineId: 'PM1', bin: '', remarks: '',
    } });
    const jobId = workspace.state.jobs[0].id;
    workspace = await store.execute(2, 'progress-start', { type: 'job.start', jobId });
    assert.equal(workspace.state.jobs[0].status, 'running');
    await store.execute(3, 'progress-10', { type: 'production.recordReceipt', jobId, totalActualQuantity: 10 });
    await store.execute(4, 'progress-25', { type: 'production.recordReceipt', jobId, totalActualQuantity: 25 });
    await store.execute(5, 'progress-40', { type: 'production.recordReceipt', jobId, totalActualQuantity: 40 });
    const now = Date.now();
    await pool.query(`UPDATE production_progress_samples SET sampled_at=CASE command_id
      WHEN 'progress-10' THEN $1::timestamptz WHEN 'progress-25' THEN $2::timestamptz ELSE $3::timestamptz END
      WHERE command_id IN ('progress-10','progress-25','progress-40')`,
    [new Date(now - 30 * 60_000).toISOString(), new Date(now - 15 * 60_000).toISOString(), new Date(now).toISOString()]);

    let response = await fetch(`${baseUrl}/api/inventory/production-progress?jobId=${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200, await response.clone().text());
    let progress = await response.json() as ProductionProgressSnapshot;
    assert.equal(progress.revision, 6);
    assert.equal(progress.jobs[0].actualTotal, 40);
    assert.equal(progress.jobs[0].plannedTotal, 100);
    assert.equal(progress.jobs[0].samples.length, 3);
    assert.equal(progress.jobs[0].estimate?.label, 'estimate');
    assert.equal(progress.jobs[0].estimate?.ratePerHour, 60);

    const retry = await store.execute(5, 'progress-40', { type: 'production.recordReceipt', jobId, totalActualQuantity: 40 });
    assert.equal(retry.revision, 6);
    assert.equal(Number((await pool.query<{ count: string }>('SELECT count(*)::text count FROM production_progress_samples')).rows[0].count), 3);

    await store.execute(6, 'progress-correct', { type: 'production.correctJobTotal', jobId, correctedTotalQuantity: 30, reason: 'Scale correction', postingKey: 'progress-correct' });
    progress = await getProgress(jobId);
    assert.equal(progress.jobs[0].actualTotal, 30);
    assert.equal(progress.jobs[0].estimate, null);
    assert.equal(progress.jobs[0].estimateUnavailableReason, 'corrected');
    assert.equal(Number((await pool.query<{ count: string }>('SELECT count(*)::text count FROM production_progress_resets')).rows[0].count), 1);

    await store.execute(7, 'progress-complete', { type: 'job.complete', jobId, actualQuantityMt: 50, completionNote: 'Completed for QA' });
    progress = await getProgress(jobId);
    assert.equal(progress.jobs[0].status, 'completed');
    assert.equal(progress.jobs[0].actualTotal, 50);
    assert.equal(progress.jobs[0].estimateUnavailableReason, 'not-running');
    const completion = await pool.query<{ source: string; trustworthy: boolean }>('SELECT source,trustworthy FROM production_progress_samples WHERE command_id=$1', ['progress-complete']);
    assert.deepEqual(completion.rows[0], { source: 'completion', trustworthy: false });
    await store.execute(7, 'progress-complete', { type: 'job.complete', jobId, actualQuantityMt: 50, completionNote: 'Completed for QA' });
    assert.equal(Number((await pool.query<{ count: string }>('SELECT count(*)::text count FROM production_progress_samples WHERE command_id=$1', ['progress-complete'])).rows[0].count), 1);
  });

  it('validates the batch query strictly', async () => {
    assert.equal((await fetch(`${baseUrl}/api/inventory/production-progress`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/inventory/production-progress?jobId=a&jobId=a`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/inventory/production-progress?jobId=a&date=2026-11-03`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/inventory/production-progress?jobId=missing`)).status, 404);
  });

  it('keeps bag progress in whole bags instead of converting it to MT', async () => {
    const input = baselineInput();
    input.fileName = 'progress-bags.xlsx'; input.digest = '7'.repeat(64); input.orders[0].digest = '6'.repeat(64);
    input.orders[0].rows[0] = { ...input.orders[0].rows[0], unit: 'Bags', quantity: 100, materialCode: '7.BAGS', description: 'Progress bag feed' };
    input.items[0] = { ...input.items[0], materialCode: '7.BAGS', description: 'Progress bag feed', unit: 'Bags', bagWeightKg: 50 };
    await store.execute(0, 'progress-bags-baseline', { type: 'inventory.importBaseline', input });
    const order = (await store.getInventoryOrders()).orders[0];
    const planned = await store.execute(1, 'progress-bags-plan', { type: 'job.createFromSources', input: {
      orders: [{ sourceOrderId: order.sourceOrderId, sourceOrderVersion: 1, plannedQuantity: 100 }],
      date: malaysiaToday(), lineId: 'PM1', bin: '', remarks: '',
    } });
    const jobId = planned.state.jobs[0].id;
    await store.execute(2, 'progress-bags-start', { type: 'job.start', jobId });
    await store.execute(3, 'progress-bags-40', { type: 'production.recordReceipt', jobId, totalActualQuantity: 40 });
    const progress = await getProgress(jobId);
    assert.equal(progress.jobs[0].unit, 'Bags');
    assert.equal(progress.jobs[0].actualTotal, 40);
    assert.equal(progress.jobs[0].plannedTotal, 100);
  });

  async function getProgress(jobId: string): Promise<ProductionProgressSnapshot> {
    const response = await fetch(`${baseUrl}/api/inventory/production-progress?jobId=${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<ProductionProgressSnapshot>;
  }
});

function baselineInput(): InventoryWorkbookInput {
  return {
    fileName: 'progress.xlsx', digest: '9'.repeat(64), asOfDate: '2026-10-18', includeBaseline: true, packingBinTotal: null,
    orders: [{ fileName: 'progress.xlsx', sheetName: 'bulk order', digest: '8'.repeat(64), asOfDate: '2026-10-18', rows: [{
      goodsMovementStatus: '', sourceSheet: 'bulk order', sourceRow: 2, doNo: 'DO-PROGRESS', deliveryDate: malaysiaToday(),
      soldToParty: 'Progress customer', shipToParty: 'Progress farm', materialCode: '7.PROGRESS', description: 'Progress bulk feed',
      quantity: 100, unit: 'MT', deliveryLeadDays: 0, remark: '', daysOutstanding: 0, medication: '', fmrOmed: '',
    }] }],
    items: [{ materialCode: '7.PROGRESS', description: 'Progress bulk feed', unit: 'MT', bagWeightKg: null, strategy: 'mto', targetQuantity: 0,
      needsReview: false, opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: '', fmrOmed: '' }],
    annotations: [],
  };
}

function malaysiaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function assertDedicatedTestDatabase(testValue: string, productionValue: string | undefined): void {
  const test = new URL(testValue);
  if (!/(^|[-_])test(?:[-_]|$)/i.test(test.pathname.slice(1))) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
  if (productionValue) {
    const production = new URL(productionValue);
    if (test.hostname === production.hostname && (test.port || '5432') === (production.port || '5432') && test.pathname === production.pathname) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  }
}
