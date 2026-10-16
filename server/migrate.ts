import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type pg from "pg";
import { createPool } from "./db";
import { loadConfig } from "./config";

const MIGRATION_LOCK = 728_451_920;

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const directory = fileURLToPath(new URL("./migrations", import.meta.url));
    const files = (await readdir(directory)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const applied = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
        [file],
      );
      if (applied.rows[0]?.exists) continue;
      const sql = await readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]); } finally { client.release(); }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try { await runMigrations(pool); } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
