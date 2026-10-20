import path from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { createPool } from "../server/db";
import { WorkspaceStore } from "../server/store";
import {
  generateDemoHistory,
  malaysiaDate,
  type DemoHistoryOptions,
  type DemoHistoryResult,
} from "../src/domain/demo-history";

interface CliOptions extends DemoHistoryOptions {
  apply: boolean;
}

class CliUsageError extends Error {}

export function parseDemoHistoryArgs(args: string[], now = new Date()): CliOptions {
  let apply = false;
  let explicitDryRun = false;
  let from: string | undefined;
  let to: string | undefined;
  let seed = 20_261_020;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--dry-run") explicitDryRun = true;
    else if (argument === "--from") from = requiredValue(args, ++index, "--from");
    else if (argument === "--to") to = requiredValue(args, ++index, "--to");
    else if (argument === "--seed") {
      const raw = requiredValue(args, ++index, "--seed");
      seed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seed) || seed > 2_147_483_647) {
        throw new CliUsageError("--seed must be an integer from 0 to 2147483647.");
      }
    } else if (argument === "--help" || argument === "-h") {
      throw new CliUsageError(usage());
    } else {
      throw new CliUsageError(`Unknown option ${JSON.stringify(argument)}.\n${usage()}`);
    }
  }
  if (apply && explicitDryRun) throw new CliUsageError("Choose either --apply or --dry-run.");

  const today = malaysiaDate(now);
  const defaultTo = addDays(today, -1);
  return {
    apply,
    from: from ?? addDays(defaultTo, -29),
    to: to ?? defaultTo,
    seed,
    now,
  };
}

async function main(): Promise<void> {
  const options = parseDemoHistoryArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new CliUsageError("DATABASE_URL is required.");
  const pool = createPool(databaseUrl);
  try {
    const store = new WorkspaceStore(pool);
    const snapshot = await store.getWorkspace();
    if (!snapshot.isDemo) {
      throw new CliUsageError("Synthetic history can only be added to a demo workspace.");
    }
    const result = generateDemoHistory(snapshot.state, options);
    writeReport(result, options, snapshot.revision);
    if (!options.apply) {
      process.stdout.write("Dry run only. Re-run with --apply to persist this exact deterministic range and seed.\n");
      return;
    }
    if (result.jobs.length === 0 && result.events.length === 0) {
      process.stdout.write("No new synthetic history was needed; the workspace was left unchanged.\n");
      return;
    }
    const revision = await appendHistory(pool, snapshot, result);
    process.stdout.write(`Applied synthetic history at workspace revision ${revision}.\n`);
  } finally {
    await pool.end();
  }
}

async function appendHistory(
  pool: pg.Pool,
  snapshot: Awaited<ReturnType<WorkspaceStore["getWorkspace"]>>,
  result: DemoHistoryResult,
): Promise<number> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const locked = await client.query<{ revision: string; is_demo: boolean }>(
      "SELECT revision, is_demo FROM workspace WHERE id = 1 FOR UPDATE",
    );
    if (!locked.rowCount) throw new Error("Workspace has not been initialized.");
    const revision = Number(locked.rows[0].revision);
    if (!Number.isSafeInteger(revision) || revision !== snapshot.revision) {
      throw new CliUsageError("Workspace changed after the dry-run snapshot; no history was applied.");
    }
    if (!locked.rows[0].is_demo) {
      throw new CliUsageError("Workspace is no longer a demo workspace; no history was applied.");
    }

    if (result.jobs.length > 0) {
      await client.query(
        `WITH base AS (
           SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM jobs WHERE workspace_id = 1
         )
         INSERT INTO jobs(workspace_id, id, ordinal, planning_date, line_id, sequence, status, payload)
         SELECT 1, item->>'id', base.max_ordinal + ordinality,
                (item->>'date')::date, item->>'lineId',
                (item->>'sequence')::integer, item->>'status', item
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)
         CROSS JOIN base`,
        [JSON.stringify(result.jobs)],
      );
    }
    if (result.events.length > 0) {
      await client.query(
        `WITH base AS (
           SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM history_events WHERE workspace_id = 1
         )
         INSERT INTO history_events(workspace_id, id, ordinal, occurred_at, event_type, job_id, payload)
         SELECT 1, item->>'id', base.max_ordinal + ordinality,
                (item->>'at')::timestamptz, item->>'type', item->>'jobId', item
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)
         CROSS JOIN base`,
        [JSON.stringify(result.events)],
      );
    }
    const nextRevision = revision + 1;
    await client.query(
      `UPDATE workspace
       SET revision = $1, previous_backup = $2::jsonb,
           undo_state = NULL, undo_revision = NULL, updated_at = now()
       WHERE id = 1`,
      [nextRevision, JSON.stringify(snapshot.state)],
    );
    await client.query("COMMIT");
    inTransaction = false;
    return nextRevision;
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function writeReport(result: DemoHistoryResult, options: CliOptions, revision: number): void {
  const statusCounts = Object.fromEntries(
    ["completed", "cancelled", "pending", "running"].map((status) => [
      status,
      result.jobs.filter((job) => job.status === status).length,
    ]),
  );
  const occupied = result.skipped.filter((item) => item.reason === "occupied").length;
  const unschedulable = result.skipped.filter((item) => item.reason === "unschedulable").length;
  process.stdout.write([
    `${options.apply ? "Apply" : "Dry-run"} synthetic history for ${options.from} through ${options.to} (seed ${options.seed}).`,
    `Snapshot revision: ${revision}. New jobs: ${result.jobs.length}; new events: ${result.events.length}.`,
    `Statuses: ${statusCounts.completed} completed, ${statusCounts.cancelled} cancelled, ${statusCounts.pending} pending issue, ${statusCounts.running} running.`,
    `Skipped line-days: ${occupied} occupied, ${unschedulable} unschedulable.`,
  ].join("\n") + "\n");
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new CliUsageError(`${option} requires a value.`);
  return value;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function usage(): string {
  return "Usage: npm run seed:demo-history -- [--dry-run | --apply] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--seed INTEGER]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("Synthetic history operation failed. No changes were committed.\n");
    }
    process.exitCode = 1;
  });
}
