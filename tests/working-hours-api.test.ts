import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { createApp } from '../server/app';
import { runMigrations } from '../server/migrate';
import { WorkspaceStore } from '../server/store';
import { createDefaultSettings } from '../src/domain/defaults';
import type { Command, WorkspaceEnvelope } from '../src/domain/commands';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('working-hours command API', () => {
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
    server.on('request', createApp({
      store,
      hostPorts: new Set([address.port]),
      distDir: 'Z:\\missing',
      allowedOrigins: new Set([`http://127.0.0.1:${address.port}`]),
    }));
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');
    const settings = createDefaultSettings();
    settings.changeoverMinutes = 0;
    settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    await store.initialize(settings);
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
  });

  it('deduplicates retries, rejects stale writes, rolls back invalid calendars and preserves execution facts', async () => {
    const today = malaysiaToday();
    const tomorrow = addDay(today, 1);
    const nightDate = addDay(today, 2);
    const collisionDate = addDay(today, 3);
    let response = await post(0, 'hours-create', { type: 'job.create', input: {
      date: today, lineId: 'PM4', orderNo: 'QA-HOURS-EXECUTION', productCode: 'QA-HOURS',
      description: 'Fictional protected execution', bin: 'QA', mode: 'bulk', bagCount: null,
      quantityMt: 1, remarks: 'Execution facts must remain stable',
    } });
    assert.equal(response.status, 200, await response.clone().text());
    let workspace = await response.json() as WorkspaceEnvelope;
    const jobId = workspace.state.jobs[0].id;
    response = await post(1, 'hours-start', { type: 'job.start', jobId });
    assert.equal(response.status, 200, await response.clone().text());
    response = await post(2, 'hours-complete', { type: 'job.complete', jobId, actualQuantityMt: 1, completionNote: 'Fictional QA complete' });
    assert.equal(response.status, 200, await response.clone().text());
    workspace = await response.json() as WorkspaceEnvelope;
    const legacyBackup = structuredClone(workspace.state);
    delete legacyBackup.jobs.find(job => job.id === jobId)!.lockedSegments;
    response = await post(3, 'hours-legacy-restore', { type: 'workspace.restore', backup: legacyBackup });
    assert.equal(response.status, 200, await response.clone().text());
    workspace = await response.json() as WorkspaceEnvelope;
    assert.equal(workspace.revision, 4);
    const completed = workspace.state.jobs.find(job => job.id === jobId)!;
    assert.equal(completed.lockedSegments, undefined);
    const completedBefore = structuredClone(completed);
    const executionFacts = {
      id: completed.id, orderNo: completed.orderNo, productCode: completed.productCode,
      quantityMt: completed.quantityMt, status: completed.status,
      actualStart: completed.actualStart, actualEnd: completed.actualEnd,
    };

    const overtime: Command = { type: 'settings.replaceWorkingHoursOverrides', date: tomorrow, reason: 'Urgent fictional orders', lines: [
      { lineId: 'PM1', dayStart: '06:00', availableHours: 15 },
      { lineId: 'PM3', dayStart: '07:00', availableHours: 0 },
    ] };
    response = await post(4, 'hours-stable-id', overtime);
    assert.equal(response.status, 200, await response.clone().text());
    workspace = await response.json() as WorkspaceEnvelope;
    assert.equal(workspace.revision, 5);
    assert.equal(workspace.state.settings.workingHoursOverrides?.filter(row => row.date === tomorrow).length, 2);
    assert.ok(workspace.state.settings.workingHoursOverrides?.every(row => row.reason === 'Urgent fictional orders' && Number.isFinite(Date.parse(row.activatedAt))));
    assert.deepEqual(execution(workspace, jobId), executionFacts);
    assert.deepEqual(workspace.state.jobs.find(job => job.id === jobId), completedBefore);

    const retry = await post(4, 'hours-stable-id', overtime);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await retry.json() as WorkspaceEnvelope).revision, 5);
    assert.equal((await current()).state.events.filter(event => event.type === 'settings.workingHours.updated').length, 1);

    const stale = await post(4, 'hours-stale-id', { ...overtime, reason: 'Stale alternate reason' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'STALE_REVISION');
    assert.equal((await current()).revision, 5);

    const beforeInvalid = await current();
    const past = await post(5, 'hours-past', { type: 'settings.replaceWorkingHoursOverrides', date: addDay(today, -1), reason: 'Past date', lines: [] });
    assert.equal(past.status, 400);
    assert.equal((await past.json()).error.code, 'INVALID_COMMAND');
    const excessive = await post(5, 'hours-excessive', { type: 'settings.replaceWorkingHoursOverrides', date: nightDate, reason: 'Invalid duration', lines: [
      { lineId: 'PM1', dayStart: '22:00', availableHours: 25 },
    ] });
    assert.equal(excessive.status, 400);
    assert.deepEqual(await current(), beforeInvalid);

    response = await post(5, 'hours-night', { type: 'settings.replaceWorkingHoursOverrides', date: nightDate, reason: 'Fictional night shift', lines: [
      { lineId: 'PM1', dayStart: '22:00', availableHours: 8 },
    ] });
    assert.equal(response.status, 200, await response.clone().text());
    const afterNight = await response.json() as WorkspaceEnvelope;
    assert.equal(afterNight.revision, 6);
    const collision = await post(6, 'hours-overlap', { type: 'settings.replaceWorkingHoursOverrides', date: collisionDate, reason: 'Overlapping early shift', lines: [
      { lineId: 'PM1', dayStart: '05:00', availableHours: 8 },
    ] });
    assert.equal(collision.status, 400);
    assert.match((await collision.json()).error.message, /overlap/i);
    const afterCollision = await current();
    assert.equal(afterCollision.revision, 6);
    assert.equal(afterCollision.state.settings.workingHoursOverrides?.some(row => row.date === collisionDate), false);
    assert.deepEqual(execution(afterCollision, jobId), executionFacts);
  });

  async function post(revision: number, commandId: string, command: Command): Promise<Response> {
    return fetch(`${baseUrl}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ expectedRevision: revision, commandId, command }) });
  }
  async function current(): Promise<WorkspaceEnvelope> {
    const response = await fetch(`${baseUrl}/api/workspace`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<WorkspaceEnvelope>;
  }
});

function execution(workspace: WorkspaceEnvelope, jobId: string) {
  const job = workspace.state.jobs.find(candidate => candidate.id === jobId)!;
  return { id: job.id, orderNo: job.orderNo, productCode: job.productCode, quantityMt: job.quantityMt, status: job.status, actualStart: job.actualStart, actualEnd: job.actualEnd };
}

function malaysiaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function addDay(date: string, count: number): string { return new Date(Date.parse(`${date}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10); }
function assertDedicatedTestDatabase(testValue: string, productionValue: string | undefined): void {
  const test = new URL(testValue);
  if (!/(^|[-_])test(?:[-_]|$)/i.test(test.pathname.slice(1))) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
  if (productionValue) {
    const production = new URL(productionValue);
    if (test.hostname === production.hostname && (test.port || '5432') === (production.port || '5432') && test.pathname === production.pathname) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  }
}
