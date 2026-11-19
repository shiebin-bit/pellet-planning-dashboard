// Historical/multi-date setup belongs to the disposable DB, not the public
// tomorrow-only import API. Browser interactions still use the real server.
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

exports.historicalFixtureCommand = async (base, command) => {
  const fixture = command.type === 'data.import' || command.type === 'data.importBatch' ||
    (['inventory.importBaseline', 'inventory.importWorkbook'].includes(command.type) &&
      Boolean(command.input?.orders?.length || command.input?.annotations?.length));
  if (!fixture) return undefined;
  const target = new URL(base);
  if (process.env.BROWSER_ALLOW_REPLACE !== '1' || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.port || target.port === '8080') {
    throw new Error('Historical fixtures require the disposable loopback browser workspace.');
  }
  if (!process.env.TEST_DATABASE_URL) throw new Error('Pass TEST_DATABASE_URL for the disposable browser database.');
  const response = await fetch(base + '/api/workspace');
  if (!response.ok) throw new Error('Could not read disposable fixture revision.');
  const { revision } = await response.json();
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'historical-fixture.ts')], {
    cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8',
    input: JSON.stringify({ expectedRevision: revision, commandId: randomUUID(), command }),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`Historical fixture setup failed: ${run.stderr || run.error?.message}`);
  return JSON.parse(run.stdout);
};
