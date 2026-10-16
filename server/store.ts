import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { validateWorkspaceBackup } from "../src/domain/backup";
import { executeCommand, type Command, type WorkspaceEnvelope } from "../src/domain/commands";
import { createSampleState } from "../src/domain/sample";
import type { AppState, HistoryEvent, Settings } from "../src/domain/types";
import { ApiError } from "./errors";

interface WorkspaceRow {
  revision: string;
  is_demo: boolean;
  settings: unknown;
  previous_backup: unknown | null;
  undo_state: unknown | null;
  undo_revision: string | null;
  updated_at: Date | string;
}

interface LoadedWorkspace {
  state: AppState;
  revision: number;
  isDemo: boolean;
  previousBackup: AppState | null;
  undoState: AppState | null;
  undoRevision: number | null;
  updatedAt: string;
}

export class WorkspaceStore {
  constructor(private readonly pool: pg.Pool) {}

  async initialize(defaultSettings: Settings): Promise<void> {
    const settings = validateWorkspaceBackup({ schemaVersion: 1, jobs: [], settings: defaultSettings, events: [] }).settings;
    await this.pool.query(
      `INSERT INTO workspace(id, revision, is_demo, settings, updated_at)
       VALUES (1, 0, false, $1::jsonb, now())
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(settings)],
    );
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getWorkspace(): Promise<WorkspaceEnvelope> {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const result = envelope(await loadWorkspace(client, false));
      await client.query("COMMIT");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(expectedRevision: number, commandId: string, command: Command): Promise<WorkspaceEnvelope> {
    const payloadHash = hashCommand(command);
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const current = await loadWorkspace(client, "update");
      const receipt = await client.query<{ payload_hash: string }>(
        "SELECT payload_hash FROM command_receipts WHERE command_id = $1",
        [commandId],
      );
      if (receipt.rowCount) {
        if (receipt.rows[0].payload_hash !== payloadHash) {
          throw new ApiError(409, "COMMAND_ID_CONFLICT", "This command ID was already used for different content.");
        }
        await client.query("COMMIT");
        inTransaction = false;
        return envelope(current);
      }
      if (expectedRevision !== current.revision) {
        throw new ApiError(409, "STALE_REVISION", "The workspace changed. Refresh it before making another change.", envelope(current));
      }

      const nowIso = new Date().toISOString();
      const nextRevision = current.revision + 1;
      let nextState: AppState;
      let isDemo = current.isDemo;
      let previousBackup = current.previousBackup;
      let undoState: AppState | null = null;
      let undoRevision: number | null = null;

      try {
        switch (command.type) {
          case "workspace.restore":
            previousBackup = current.state;
            nextState = appendEvent(validateWorkspaceBackup(command.backup), {
              id: `event-${randomUUID()}`,
              at: nowIso,
              type: "workspace.restored",
              message: "Restored workspace from a validated JSON backup.",
            });
            isDemo = false;
            break;
          case "workspace.resetDemo":
            previousBackup = current.state;
            nextState = appendEvent(createSampleState(command.date), {
              id: `event-${randomUUID()}`,
              at: nowIso,
              type: "workspace.reset",
              message: "Reset workspace to the illustrative demo plan.",
            });
            isDemo = true;
            break;
          case "workspace.undoLastMove":
            if (!current.undoState || current.undoRevision !== current.revision) {
              throw new ApiError(409, "UNDO_NOT_AVAILABLE", "Only the most recent move can be undone before another change.");
            }
            nextState = {
              ...current.undoState,
              events: [...current.state.events, {
                id: `event-${randomUUID()}`,
                at: nowIso,
                type: "job.move.undone",
                message: "Undid the most recent production move.",
              }],
            };
            break;
          default:
            nextState = executeCommand(current.state, command, { nowIso });
            if (command.type === "job.move") {
              undoState = current.state;
              undoRevision = nextRevision;
            }
        }
        nextState = validateWorkspaceBackup(nextState);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "INVALID_COMMAND", error instanceof Error ? error.message : "Command is invalid.");
      }
      await persistWorkspace(client, {
        state: nextState,
        revision: nextRevision,
        isDemo,
        previousBackup,
        undoState,
        undoRevision,
        updatedAt: nowIso,
      });
      await client.query(
        `INSERT INTO command_receipts(command_id, payload_hash, applied_revision, created_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [commandId, payloadHash, nextRevision, nowIso],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return {
        state: nextState,
        revision: nextRevision,
        isDemo,
        previousBackup,
        updatedAt: nowIso,
        canUndo: undoState !== null && undoRevision === nextRevision,
      };
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function defaultSettings(date = malaysiaDate()): Settings {
  return createSampleState(date).settings;
}

async function loadWorkspace(client: pg.PoolClient, lock: false | "update"): Promise<LoadedWorkspace> {
  const lockClause = lock === "update" ? " FOR UPDATE" : "";
  const workspace = await client.query<WorkspaceRow>(
    `SELECT revision, is_demo, settings, previous_backup, undo_state, undo_revision, updated_at
     FROM workspace WHERE id = 1${lockClause}`,
  );
  if (!workspace.rowCount) throw new Error("Workspace has not been initialized.");
  const row = workspace.rows[0];
  const [jobs, events] = await Promise.all([
    client.query<{ payload: unknown }>("SELECT payload FROM jobs WHERE workspace_id = 1 ORDER BY ordinal"),
    client.query<{ payload: unknown }>("SELECT payload FROM history_events WHERE workspace_id = 1 ORDER BY ordinal"),
  ]);
  const state = validateWorkspaceBackup({
    schemaVersion: 1,
    jobs: jobs.rows.map(item => item.payload),
    settings: row.settings,
    events: events.rows.map(item => item.payload),
  });
  return {
    state,
    revision: safeRevision(row.revision),
    isDemo: row.is_demo,
    previousBackup: row.previous_backup === null ? null : validateWorkspaceBackup(row.previous_backup),
    undoState: row.undo_state === null ? null : validateWorkspaceBackup(row.undo_state),
    undoRevision: row.undo_revision === null ? null : safeRevision(row.undo_revision),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function persistWorkspace(client: pg.PoolClient, value: LoadedWorkspace): Promise<void> {
  await client.query(
    `UPDATE workspace SET revision = $1, is_demo = $2, settings = $3::jsonb,
       previous_backup = $4::jsonb, undo_state = $5::jsonb, undo_revision = $6,
       updated_at = $7::timestamptz WHERE id = 1`,
    [
      value.revision,
      value.isDemo,
      JSON.stringify(value.state.settings),
      value.previousBackup === null ? null : JSON.stringify(value.previousBackup),
      value.undoState === null ? null : JSON.stringify(value.undoState),
      value.undoRevision,
      value.updatedAt,
    ],
  );
  await client.query("DELETE FROM jobs WHERE workspace_id = 1");
  if (value.state.jobs.length) {
    await client.query(
      `INSERT INTO jobs(workspace_id, id, ordinal, planning_date, line_id, sequence, status, payload)
       SELECT 1, item->>'id', ordinality - 1, (item->>'date')::date,
              item->>'lineId', (item->>'sequence')::integer, item->>'status', item
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)`,
      [JSON.stringify(value.state.jobs)],
    );
  }
  await client.query("DELETE FROM history_events WHERE workspace_id = 1");
  if (value.state.events.length) {
    await client.query(
      `INSERT INTO history_events(workspace_id, id, ordinal, occurred_at, event_type, job_id, payload)
       SELECT 1, item->>'id', ordinality - 1, (item->>'at')::timestamptz,
              item->>'type', item->>'jobId', item
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)`,
      [JSON.stringify(value.state.events)],
    );
  }
}

function envelope(value: LoadedWorkspace): WorkspaceEnvelope {
  return {
    state: value.state,
    revision: value.revision,
    isDemo: value.isDemo,
    previousBackup: value.previousBackup,
    updatedAt: value.updatedAt,
    canUndo: value.undoState !== null && value.undoRevision === value.revision,
  };
}

function appendEvent(state: AppState, historyEvent: HistoryEvent): AppState {
  return { ...state, events: [...state.events, historyEvent] };
}

function hashCommand(command: Command): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Stored workspace revision is invalid.");
  return revision;
}

function malaysiaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
