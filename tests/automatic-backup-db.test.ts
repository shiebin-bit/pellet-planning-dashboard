import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../server/migrate';
import { WorkspaceStore } from '../server/store';
import { AutomaticBackupService } from '../server/automaticBackup';
import { validatePortableBackupV5 } from '../server/sourceBackup';
import { createDefaultSettings } from '../src/domain/defaults';
import type { Command } from '../src/domain/commands';
import type { InventoryWorkbookInput } from '../src/domain/inventoryTypes';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('automatic V5 recovery against PostgreSQL', () => {
  it('exports real source, inventory, reviews and progress without a revision change, then restores the business graph', async () => {
    const target = new URL(databaseUrl!);
    assert.match(target.pathname.slice(1), /(^|[-_])test(?:[-_]|$)/i, 'Use a dedicated test database.');
    if (process.env.DATABASE_URL) {
      const production = new URL(process.env.DATABASE_URL);
      assert.notEqual(`${target.hostname}:${target.port || '5432'}${target.pathname}`, `${production.hostname}:${production.port || '5432'}${production.pathname}`, 'Test and production databases must differ.');
    }
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'millplan-auto-recovery-test-'));
    let service: AutomaticBackupService | null = null;
    try {
      await runMigrations(pool);
      await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');
      const store = new WorkspaceStore(pool); await store.initialize(createDefaultSettings());
      let revision = 0;
      const command = async (value: Command) => { const result = await store.execute(revision, `auto-recovery-${revision}`, value); revision = result.revision; return result; };
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
      const row = { doNo: 'QA-AUTO-RECOVERY', deliveryDate: today, soldToParty: 'Fictional recovery customer', shipToParty: 'Fictional recovery destination', materialCode: 'QA-AUTO-FEED', description: 'FS 9901 FICTIONAL BULK FEED', quantity: 100, unit: 'MT' as const, deliveryLeadDays: 0, remark: '', daysOutstanding: 0, medication: '', fmrOmed: '' };
      const baseline: InventoryWorkbookInput = { fileName: 'fictional-auto-baseline.xlsx', digest: 'a'.repeat(64), asOfDate: today, includeBaseline: true, packingBinTotal: null, orders: [{ fileName: 'fictional-auto-orders.xlsx', sheetName: 'bulk order', digest: 'b'.repeat(64), asOfDate: today, rows: [row] }], items: [{ materialCode: row.materialCode, description: row.description, unit: 'MT', bagWeightKg: null, strategy: 'mto', targetQuantity: 0, needsReview: false, opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: '', fmrOmed: '' }], annotations: [] };
      await command({ type: 'inventory.importBaseline', input: baseline });
      const source = (await store.getInventoryOrders()).orders[0];
      const plan = await command({ type: 'job.createFromSources', input: { orders: [{ sourceOrderId: source.sourceOrderId, sourceOrderVersion: 1, plannedQuantity: 100 }], date: today, lineId: 'PM1', bin: '', remarks: 'Fictional recovery test' } });
      const jobId = plan.state.jobs[0].id;
      await command({ type: 'job.start', jobId });
      await command({ type: 'production.recordReceipt', jobId, totalActualQuantity: 20 });
      await command({ type: 'production.correctJobTotal', jobId, correctedTotalQuantity: 15, reason: 'Fictional scale correction', postingKey: 'auto-recovery-correction' });
      await command({ type: 'data.import', input: { ...baseline.orders[0], fileName: 'fictional-revised-orders.xlsx', digest: 'c'.repeat(64), rows: [{ ...row, description: 'FS 9901 REVISED FICTIONAL BULK FEED' }] } });
      const expected = await store.getPortableBackup();
      assert.equal(expected.sourceData.discrepancies.length, 1); assert.ok(expected.inventory.ledger.length > 1); assert.equal(expected.productionProgress.samples.length, 1); assert.equal(expected.productionProgress.resets.length, 1);
      service = new AutomaticBackupService({ enabled: true, directory, intervalHours: 24, retentionCount: 14 }, { exportBackup: () => store.getPortableBackup() });
      await service.start(); await service.runDueBackup(); await service.close();
      assert.equal(service.getStatus().state, 'idle'); assert.equal((await store.getWorkspace()).revision, revision);
      const files = (await readdir(directory)).filter(file => file.endsWith('.json')); assert.equal(files.length, 1);
      const saved = validatePortableBackupV5(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')));
      assert.deepEqual(saved.planning, expected.planning); assert.deepEqual(saved.sourceData, expected.sourceData); assert.deepEqual(saved.inventory, expected.inventory); assert.deepEqual(saved.productionProgress, expected.productionProgress);
      await command({ type: 'workspace.resetDemo', date: today });
      await command({ type: 'workspace.restore', backup: saved });
      const restored = await store.getPortableBackup();
      assert.deepEqual(restored.planning.jobs, saved.planning.jobs); assert.deepEqual(restored.planning.settings, saved.planning.settings); assert.deepEqual(restored.planning.catalog, saved.planning.catalog);
      assert.deepEqual(restored.sourceData, saved.sourceData); assert.deepEqual(restored.inventory, saved.inventory); assert.deepEqual(restored.productionProgress, saved.productionProgress);
      for (const event of saved.planning.events) assert.deepEqual(restored.planning.events.find(item => item.id === event.id), event);
    } finally {
      await service?.close(); await pool.end();
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
