import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app';
import type { WorkspaceStore } from '../server/store';
import type { AutomaticBackupStatus } from '../src/domain/automaticBackup';

describe('automatic backup status API', () => {
  let server: Server;
  let baseUrl: string;
  const status: AutomaticBackupStatus = {
    enabled: true,
    format: 'portable-v5',
    intervalHours: 24,
    retentionCount: 14,
    state: 'degraded',
    lastAttempt: { at: '2026-11-04T03:00:00.000Z', result: 'failed', code: 'WRITE_FAILED', sanitizedMessage: 'The automatic backup file could not be saved.' },
    lastSuccess: { at: '2026-11-03T03:00:00.000Z', fileName: 'millplan-auto-v5-20261103T030000000Z.json', bytes: 1234 },
    nextAttemptAt: '2026-11-04T03:15:00.000Z',
  };

  before(async () => {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port.');
    server.on('request', createApp({
      store: {} as WorkspaceStore,
      hostPorts: new Set([address.port]),
      distDir: 'Z:\\directory-that-does-not-exist',
      allowedOrigins: new Set([`http://127.0.0.1:${address.port}`]),
      automaticBackupStatus: () => status,
    }));
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('returns only the portable backup status contract without server paths or secrets', async () => {
    const response = await fetch(`${baseUrl}/api/backup/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, status);
    assert.doesNotMatch(JSON.stringify(body), /postgresql:|\\|\/var\/|password|stack/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('rejects every query parameter and exposes no mutation endpoint', async () => {
    const query = await fetch(`${baseUrl}/api/backup/status?details=true`);
    assert.equal(query.status, 400);
    assert.equal((await query.json()).error.code, 'INVALID_REQUEST');
    const trigger = await fetch(`${baseUrl}/api/backup/trigger`, { method: 'POST' });
    assert.equal(trigger.status, 404);
  });
});
