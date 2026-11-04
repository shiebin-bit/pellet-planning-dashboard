import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AutomaticBackupService, managedFileName } from '../server/automaticBackup';
import { loadConfig } from '../server/config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('automatic portable V5 backups', () => {
  it('creates the first backup immediately with the exact managed filename and a future interval', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-04T01:02:03.456Z');
    const service = automaticBackup(directory, clock.now, async () => ({ schemaVersion: 5, marker: 'complete' }));
    await service.start();
    await service.runDueBackup();

    const files = await readdir(directory);
    assert.deepEqual(files, ['millplan-auto-v5-20261104T010203456Z.json']);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')), { schemaVersion: 5, marker: 'complete' });
    const status = service.getStatus();
    assert.equal(status.state, 'idle');
    assert.deepEqual(status.lastAttempt, { at: clock.now().toISOString(), result: 'success' });
    assert.deepEqual(status.lastSuccess, { at: clock.now().toISOString(), fileName: files[0], bytes: 39 });
    assert.equal(status.nextAttemptAt, '2026-11-05T01:02:03.456Z');
    await service.close();
  });

  it('is single-flight and shutdown waits for an export already in progress', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-04T02:00:00.000Z');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let exports = 0;
    const service = automaticBackup(directory, clock.now, async () => {
      exports += 1;
      markStarted();
      await gate;
      return { schemaVersion: 5 };
    });
    await service.start();
    const first = service.runDueBackup();
    const second = service.runDueBackup();
    assert.equal(first, second);
    await started;
    assert.equal(exports, 1);
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await Promise.all([first, closing]);
    assert.equal(closed, true);
  });

  it('degrades without a final file after export failure and schedules a sanitized 15-minute retry', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-04T03:00:00.000Z');
    const service = automaticBackup(directory, clock.now, async () => { throw new Error('postgresql://secret@private-host/db'); });
    await service.start();
    await service.runDueBackup();
    assert.deepEqual(await readdir(directory), []);
    const status = service.getStatus();
    assert.equal(status.state, 'degraded');
    assert.deepEqual(status.lastAttempt, {
      at: '2026-11-04T03:00:00.000Z', result: 'failed', code: 'EXPORT_FAILED',
      sanitizedMessage: 'The portable workspace export failed.',
    });
    assert.equal(status.nextAttemptAt, '2026-11-04T03:15:00.000Z');
    assert.doesNotMatch(JSON.stringify(status), /secret|private-host|postgresql/i);
    await service.close();
  });

  it('starts in a visible degraded state when the configured directory is inaccessible', async () => {
    const parent = await tempDirectory();
    const directory = path.join(parent, 'not-a-directory');
    await writeFile(directory, 'occupied');
    const clock = fakeClock('2026-11-04T03:30:00.000Z');
    const service = automaticBackup(directory, clock.now, async () => ({ schemaVersion: 5 }));
    await service.start();
    assert.deepEqual(service.getStatus(), {
      enabled: true, format: 'portable-v5', intervalHours: 24, retentionCount: 14, state: 'degraded',
      lastAttempt: { at: clock.now().toISOString(), result: 'failed', code: 'DIRECTORY_UNAVAILABLE', sanitizedMessage: 'The automatic backup directory is unavailable.' },
      lastSuccess: null, nextAttemptAt: '2026-11-04T03:45:00.000Z',
    });
    await service.close();
  });

  it('removes its exclusive temporary file when the atomic rename fails', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-04T04:00:00.000Z');
    const finalName = managedFileName(clock.now());
    await mkdir(path.join(directory, finalName));
    const service = automaticBackup(directory, clock.now, async () => ({ schemaVersion: 5 }));
    await service.start();
    await service.runDueBackup();
    const entries = await readdir(directory, { withFileTypes: true });
    assert.deepEqual(entries.map(entry => [entry.name, entry.isDirectory()]), [[finalName, true]]);
    assert.equal(service.getStatus().lastAttempt?.code, 'WRITE_FAILED');
    assert.equal(service.getStatus().lastSuccess, null);
    await service.close();
  });

  it('recovers a validated recent success on restart without making a duplicate', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-04T05:00:00.000Z');
    const fileName = managedFileName(clock.now());
    await writeFile(path.join(directory, fileName), JSON.stringify({ schemaVersion: 5 }));
    clock.advanceHours(1);
    let exports = 0;
    const service = automaticBackup(directory, clock.now, async () => { exports += 1; return { schemaVersion: 5 }; });
    await service.start();
    assert.equal(exports, 0);
    assert.equal(service.getStatus().lastSuccess?.fileName, fileName);
    assert.equal(service.getStatus().nextAttemptAt, '2026-11-05T05:00:00.000Z');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(exports, 0);
    await service.close();
  });

  it('schedules one immediate catch-up when the newest validated success is overdue', async () => {
    const directory = await tempDirectory();
    const clock = fakeClock('2026-11-01T06:00:00.000Z');
    await writeFile(path.join(directory, managedFileName(clock.now())), JSON.stringify({ schemaVersion: 5 }));
    clock.advanceHours(25);
    let exports = 0;
    const service = automaticBackup(directory, clock.now, async () => { exports += 1; return { schemaVersion: 5 }; });
    await service.start();
    assert.equal(service.getStatus().nextAttemptAt, clock.now().toISOString());
    await service.runDueBackup();
    assert.equal(exports, 1);
    assert.equal(service.getStatus().nextAttemptAt, '2026-11-03T07:00:00.000Z');
    await service.close();
  });

  it('prunes only older validated managed regular files and preserves unrelated, invalid, directory and symlink entries', async () => {
    const directory = await tempDirectory();
    const validNames = ['millplan-auto-v5-20261101T000000000Z.json', 'millplan-auto-v5-20261102T000000000Z.json', 'millplan-auto-v5-20261103T000000000Z.json'];
    for (const fileName of validNames) await writeFile(path.join(directory, fileName), JSON.stringify({ schemaVersion: 5 }));
    const invalidName = 'millplan-auto-v5-20261031T000000000Z.json';
    await writeFile(path.join(directory, invalidName), '{invalid');
    await writeFile(path.join(directory, 'millplan-20261101.dump'), 'do not delete');
    const directoryName = 'millplan-auto-v5-20261030T000000000Z.json';
    await mkdir(path.join(directory, directoryName));
    const symlinkName = 'millplan-auto-v5-20261029T000000000Z.json';
    let symlinkCreated = true;
    try { await symlink(path.join(directory, validNames[2]), path.join(directory, symlinkName), 'file'); } catch { symlinkCreated = false; }

    const clock = fakeClock('2026-11-04T00:00:00.000Z');
    const service = new AutomaticBackupService({ enabled: true, directory, intervalHours: 24, retentionCount: 2 }, {
      now: clock.now, exportBackup: async () => ({ schemaVersion: 5 }), validateBackup: validateTestBackup,
    });
    await service.start();
    await service.runDueBackup();
    const remaining = new Set(await readdir(directory));
    assert.equal(remaining.has(validNames[0]), false);
    assert.equal(remaining.has(validNames[1]), false);
    assert.equal(remaining.has(validNames[2]), true);
    assert.equal(remaining.has(managedFileName(clock.now())), true);
    assert.equal(remaining.has(invalidName), true);
    assert.equal(remaining.has('millplan-20261101.dump'), true);
    assert.equal(remaining.has(directoryName), true);
    if (symlinkCreated) assert.equal(remaining.has(symlinkName), true);
    await service.close();
  });

  it('rejects unsafe or out-of-range automatic-backup configuration', () => {
    const base = { DATABASE_URL: 'postgresql://example.invalid/db' };
    assert.equal(loadConfig(base).automaticBackup.enabled, false);
    assert.throws(() => loadConfig({ ...base, AUTOMATIC_BACKUP_ENABLED: 'yes' }), /must be true or false/);
    assert.throws(() => loadConfig({ ...base, AUTOMATIC_BACKUP_ENABLED: 'true', AUTOMATIC_BACKUP_DIR: 'relative' }), /absolute non-root/);
    assert.throws(() => loadConfig({ ...base, AUTOMATIC_BACKUP_ENABLED: 'true', AUTOMATIC_BACKUP_DIR: path.parse(process.cwd()).root }), /absolute non-root/);
    assert.throws(() => loadConfig({ ...base, AUTOMATIC_BACKUP_INTERVAL_HOURS: '169' }), /1 to 168/);
    assert.throws(() => loadConfig({ ...base, AUTOMATIC_BACKUP_RETENTION_COUNT: '0' }), /1 to 365/);
  });
});

function automaticBackup(directory: string, now: () => Date, exportBackup: () => Promise<unknown>) {
  return new AutomaticBackupService({ enabled: true, directory, intervalHours: 24, retentionCount: 14 }, { now, exportBackup, validateBackup: validateTestBackup });
}

function validateTestBackup(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 5) throw new Error('invalid V5 backup');
}

function fakeClock(initial: string) {
  let current = Date.parse(initial);
  return { now: () => new Date(current), advanceHours: (hours: number) => { current += hours * 3_600_000; } };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'millplan-auto-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}
