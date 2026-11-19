import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { assertFixtureDatabase, executeHistoricalFixture } from './historical-fixture';

describe('historical fixture isolation', () => {
  it('refuses missing, production and credential-aliased database targets before connecting', async () => {
    const previous = { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, BROWSER_ALLOW_REPLACE: process.env.BROWSER_ALLOW_REPLACE, BROWSER_BASE_URL: process.env.BROWSER_BASE_URL };
    const restore = () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
    const pool = new pg.Pool({ connectionString: 'postgresql://example.invalid/production', connectionTimeoutMillis: 10 });
    try {
      delete process.env.TEST_DATABASE_URL; delete process.env.BROWSER_ALLOW_REPLACE; delete process.env.BROWSER_BASE_URL;
      assert.throws(assertFixtureDatabase, /explicit TEST_DATABASE_URL/);
      process.env.TEST_DATABASE_URL = 'postgresql://example.invalid/production';
      assert.throws(assertFixtureDatabase, /dedicated database/);
      process.env.TEST_DATABASE_URL = 'postgresql://testuser@example.invalid:5432/millplan_test';
      process.env.DATABASE_URL = 'postgresql://anotheruser@example.invalid/millplan_test?sslmode=require';
      assert.throws(assertFixtureDatabase, /must differ/);
      process.env.DATABASE_URL = 'postgresql://example.invalid/production';
      await assert.rejects(executeHistoricalFixture(pool, 0, 'guard-fixture', { type: 'data.import' }), /pool must match/);
      // Even the browser exception requires an explicit replace flag and a
      // non-production loopback port; production8080 never qualifies.
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      process.env.BROWSER_ALLOW_REPLACE = '1'; process.env.BROWSER_BASE_URL = 'http://127.0.0.1:8080';
      assert.throws(assertFixtureDatabase, /must differ/);
    } finally { restore(); await pool.end(); }
  });
});
