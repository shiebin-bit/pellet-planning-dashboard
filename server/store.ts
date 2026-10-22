import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { validateWorkspaceBackup } from "../src/domain/backup";
import { createMoveUndoEvent } from "../src/domain/audit";
import { executeCommand, type Command, type WorkspaceEnvelope } from "../src/domain/commands";
import { createSampleState } from "../src/domain/sample";
import type { AppState, HistoryEvent, Settings } from "../src/domain/types";
import { ApiError } from "./errors";
import { getScheduledJobs } from "../src/domain/engine";
import type { SourceImportInput } from "../src/domain/sourceTypes";
import type { PortableSourceData, PortableWorkspaceBackupV3 } from "../src/domain/sourceTypes";
import { exportSourceData, portableBackup, restoreSourceData, validatePortableBackupV3 } from "./sourceBackup";
import {
  applySourceImport,
  clearSourceData,
  createJobFromSource,
  getSourceOrder,
  listSourceOrders,
  previewSourceImport,
  setDeliveryStatus,
} from "./sourceData";

interface WorkspaceRow {
  revision: string;
  is_demo: boolean;
  settings: unknown;
  catalog: unknown;
  previous_backup: unknown | null;
  previous_source_backup: unknown | null;
  undo_state: unknown | null;
  undo_revision: string | null;
  updated_at: Date | string;
}

interface LoadedWorkspace {
  state: AppState;
  revision: number;
  isDemo: boolean;
  previousBackup: AppState | null;
  previousSourceBackup: PortableSourceData | null;
  undoState: AppState | null;
  undoRevision: number | null;
  updatedAt: string;
}

export class WorkspaceStore {
  constructor(private readonly pool: pg.Pool) {}

  async initialize(defaultSettings: Settings): Promise<void> {
    const settings = validateWorkspaceBackup({ schemaVersion: 2, catalog: [], jobs: [], settings: defaultSettings, events: [] }).settings;
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

  async previewSourceImport(input: SourceImportInput) { return previewSourceImport(this.pool, input); }
  async listSourceOrders(query: URLSearchParams) { return listSourceOrders(this.pool, query); }
  async getSourceOrder(id: string) { return getSourceOrder(this.pool, id); }
  async listSourceImports() {
    const result = await this.pool.query<{ id: string; file_name: string; as_of_date: string | Date; imported_at: string | Date; row_count: number }>(
      "SELECT id, file_name, as_of_date::text AS as_of_date, imported_at, row_count FROM source_imports WHERE workspace_id = 1 ORDER BY imported_at DESC",
    );
    return result.rows.map(row => ({ id: row.id, fileName: row.file_name, asOfDate: String(row.as_of_date).slice(0, 10), importedAt: new Date(row.imported_at).toISOString(), rowCount: row.row_count }));
  }

  async getPortableBackup(): Promise<PortableWorkspaceBackupV3> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const loaded = await loadWorkspace(client, false);
      const result = portableBackup(loaded.state, await exportSourceData(client));
      assertPortableBackupSize(result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async getPreviousPortableBackup(): Promise<PortableWorkspaceBackupV3 | null> {
    const current = await this.getWorkspaceWithPreviousSource();
    if (!current.previousBackup) return null;
    const result = portableBackup(current.previousBackup, current.previousSourceBackup ?? emptySourceData());
    assertPortableBackupSize(result);
    return result;
  }

  private async getWorkspaceWithPreviousSource(): Promise<LoadedWorkspace> {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const loaded = await loadWorkspace(client, false);
      await client.query("COMMIT");
      inTransaction = false;
      return loaded;
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
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
      let previousSourceBackup = current.previousSourceBackup;
      let undoState: AppState | null = null;
      let undoRevision: number | null = null;

      try {
        switch (command.type) {
          case "workspace.restore":
            assertPortableBackupSize(command.backup);
            {
              const backup = "planning" in command.backup ? validatePortableBackupV3(command.backup) : null;
              const restoredPlanning = backup?.planning ?? stripSourceLinks(validateWorkspaceBackup(command.backup));
              previousSourceBackup = await exportSourceData(client);
              await clearSourceData(client);
              previousBackup = current.state;
              if (backup) await restoreSourceData(client, backup.sourceData);
              nextState = appendEvent(restoredPlanning, {
                id: `event-${randomUUID()}`,
                at: nowIso,
                type: "workspace.restored",
                message: "Restored workspace from a validated JSON backup.",
              });
            }
            isDemo = false;
            break;
          case "workspace.resetDemo":
            previousSourceBackup = await exportSourceData(client);
            await clearSourceData(client);
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
            {
              nextState = {
                ...current.undoState,
                events: [...current.state.events, createMoveUndoEvent(current.state, current.undoState, `event-${randomUUID()}`, nowIso)],
              };
            }
            break;
          case "data.import": {
            const result = await applySourceImport(client, current.state, command.input, nowIso);
            nextState = result.state;
            break;
          }
          case "job.createFromSource": {
            const result = await createJobFromSource(client, current.state, command.input, nowIso);
            nextState = result.state;
            break;
          }
          case "data.setDeliveryStatus": {
            const result = await setDeliveryStatus(client, current.state, command.sourceOrderId, command.delivered, command.reason, nowIso);
            nextState = result.state;
            break;
          }
          case "settings.activateCalendar":
            nextState = activateCalendar(current.state, command.effectiveFrom, command.dayStart, command.availableHours, nowIso);
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
        previousSourceBackup,
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

async function loadWorkspace(client: pg.PoolClient, lock: false | "update"): Promise<LoadedWorkspace> {
  const lockClause = lock === "update" ? " FOR UPDATE" : "";
  const workspace = await client.query<WorkspaceRow>(
    `SELECT revision, is_demo, settings, catalog, previous_backup, previous_source_backup, undo_state, undo_revision, updated_at
     FROM workspace WHERE id = 1${lockClause}`,
  );
  if (!workspace.rowCount) throw new Error("Workspace has not been initialized.");
  const row = workspace.rows[0];
  const jobs = await client.query<{ payload: unknown }>("SELECT payload FROM jobs WHERE workspace_id = 1 ORDER BY ordinal");
  const events = await client.query<{ payload: unknown }>("SELECT payload FROM history_events WHERE workspace_id = 1 ORDER BY ordinal");
  const state = validateWorkspaceBackup({
    schemaVersion: 2,
    catalog: row.catalog,
    jobs: jobs.rows.map(item => item.payload),
    settings: row.settings,
    events: events.rows.map(item => item.payload),
  });
  return {
    state,
    revision: safeRevision(row.revision),
    isDemo: row.is_demo,
    previousBackup: row.previous_backup === null ? null : validateWorkspaceBackup(row.previous_backup),
    previousSourceBackup: row.previous_source_backup === null ? null : row.previous_source_backup as PortableSourceData,
    undoState: row.undo_state === null ? null : validateWorkspaceBackup(row.undo_state),
    undoRevision: row.undo_revision === null ? null : safeRevision(row.undo_revision),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function persistWorkspace(client: pg.PoolClient, value: LoadedWorkspace): Promise<void> {
  await client.query(
    `UPDATE workspace SET revision = $1, is_demo = $2, settings = $3::jsonb,
       catalog = $4::jsonb, previous_backup = $5::jsonb, previous_source_backup = $6::jsonb,
       undo_state = $7::jsonb, undo_revision = $8, updated_at = $9::timestamptz WHERE id = 1`,
    [
      value.revision,
      value.isDemo,
      JSON.stringify(value.state.settings),
      JSON.stringify(value.state.catalog),
      value.previousBackup === null ? null : JSON.stringify(value.previousBackup),
      value.previousSourceBackup === null ? null : JSON.stringify(value.previousSourceBackup),
      value.undoState === null ? null : JSON.stringify(value.undoState),
      value.undoRevision,
      value.updatedAt,
    ],
  );
  await client.query("DELETE FROM jobs WHERE workspace_id = 1");
  if (value.state.jobs.length) {
    await client.query(
      `INSERT INTO jobs(workspace_id, id, ordinal, planning_date, line_id, sequence, status, source_order_id, payload)
       SELECT 1, item->>'id', ordinality - 1, (item->>'date')::date,
              item->>'lineId', (item->>'sequence')::integer, item->>'status', NULLIF(item->>'sourceOrderId', ''), item
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

function emptySourceData(): PortableSourceData { return { imports: [], orders: [], versions: [] }; }

function activateCalendar(state: AppState, effectiveFrom: string, dayStart: string, availableHours: number, nowIso: string): AppState {
  if (availableHours <= 0 || availableHours > 24) throw new Error("Available hours must be greater than zero and no more than 24.");
  if (effectiveFrom !== malaysiaDateAt(nowIso)) throw new Error("The production calendar must take effect on the current Malaysia date.");
  const existing = state.settings.calendarCutover;
  const cutover = existing ?? {
    effectiveFrom,
    priorDayStart: state.settings.dayStart,
    priorAvailableHours: state.settings.availableHours,
    activatedAt: nowIso,
  };
  if (existing && (existing.effectiveFrom !== effectiveFrom || state.settings.dayStart !== dayStart || state.settings.availableHours !== availableHours)) {
    throw new Error("The production calendar cutover has already been activated and cannot be changed.");
  }
  const oldSchedule = new Map(getScheduledJobs(state).map(job => [job.id, job]));
  const jobs = state.jobs.map(job => {
    if ((job.status !== "running" && job.status !== "completed") || job.lockedSegments?.length || job.quantityMt <= 0) return job;
    const segments = oldSchedule.get(job.id)?.segments;
    if (!segments?.length) throw new Error(`Cannot activate the calendar until the legacy plan for order ${job.orderNo} can be frozen.`);
    return { ...job, lockedSegments: segments.map(segment => ({ ...segment })) };
  });
  return appendEvent({
    ...state,
    jobs,
    settings: { ...state.settings, dayStart, availableHours, calendarCutover: cutover },
  }, {
    id: `event-${randomUUID()}`,
    at: nowIso,
    type: "settings.calendar.activated",
    message: `Activated production hours ${dayStart} for ${availableHours} hours from ${effectiveFrom}.`,
  });
}

function malaysiaDateAt(nowIso: string): string {
  const shifted = new Date(Date.parse(nowIso) + 8 * 60 * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function stripSourceLinks(state: AppState): AppState {
  return {
    ...state,
    jobs: state.jobs.map(job => {
      const { sourceOrderId: _sourceOrderId, sourceOrderVersion: _sourceOrderVersion, sourceSnapshot: _sourceSnapshot, bagWeightKgSnapshot: _bagWeightKgSnapshot, ...plain } = job;
      return plain;
    }),
  };
}

function assertPortableBackupSize(backup: unknown): void {
  if (Buffer.byteLength(JSON.stringify(backup), "utf8") > 64 * 1024 * 1024) {
    throw new ApiError(413, "BACKUP_TOO_LARGE", "Portable backup exceeds 64 MB. Use the PostgreSQL backup script for this workspace.");
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
