import { createHash, randomUUID } from "node:crypto";
import {draftPlanningFloor} from '../src/domain/draftTiming';
export {draftPlanningFloor} from '../src/domain/draftTiming';
import type pg from "pg";
import { validateWorkspaceBackup } from "../src/domain/backup";
import { createMoveUndoEvent } from "../src/domain/audit";
import { executeCommand, type Command, type WorkspaceEnvelope } from "../src/domain/commands";
import { createSampleState } from "../src/domain/sample";
import type { AppState, HistoryEvent, Settings } from "../src/domain/types";
import { getJobSourceAllocations } from "../src/domain/jobSources";
import { ApiError } from "./errors";
import { getScheduledJobs } from "../src/domain/engine";
import { planInventoryDraft } from "../src/domain/inventoryPlanner";
import { buildCarryoverPlanningContext, clearDailyPlanning, exportDailyPlanning, reconcileContinuationReservation, restoreDailyPlanning } from './dailyPlanning';
import type { InventoryCommand, InventoryDraftRequest } from "../src/domain/inventoryTypes";
import type { SourceImportInput, SourceImportPreviewContext } from "../src/domain/sourceTypes";
import type { PortableSourceData, PortableSourceDataWithReviews } from "../src/domain/sourceTypes";
import type { PortableInventoryData, PortableWorkspaceBackupV4 } from "../src/domain/inventoryTypes";
import type { PortableProductionProgress, PortableWorkspaceBackupV5 } from "../src/domain/productionProgress";
import { clearInventoryData, exportBaselineHistory, exportInventoryData, exportSourceData, portableBackupV5, portableBackupV6, portableBackupV7, restoreBaselineHistory, restoreInventoryData, restoreSourceData, validatePortableBackupV3, validatePortableBackupV4, validatePortableBackupV5, validatePortableBackupV6, validatePortableBackupV7 } from "./sourceBackup";
import {
  clearSourceData,
  createJobFromSource,
  createJobFromSources,
  getSourceOrder,
  listSourceOrders,
  setDeliveryStatus,
} from "./sourceData";
import { executeSourceImportReview, getSourceImportReview, listSourceImportReviews } from "./sourceReview";
import {
  buildPlanningDemand,
  jobProductionTotal,
  jobProductionTotalsBySource,
  validateInventoryJobs,
  executeInventoryCommand,
  getInventorySnapshot,
  getProductionSummary,
  getOrderProgress,
  listDailyStock,
  listLedger,
  listOrderJournal,
  recalculateReservations,
} from "./inventory";
import { clearProductionProgress, exportProductionProgress, getProductionProgress, restoreProductionProgress } from "./productionProgress";
import { getOperationsSummary } from "./operationsSummary";
import type { DailyReportInput } from "../src/domain/dailyImport";
import { importDailyReports, listSourceOrderObservations, previewDailyReports, setPlanningControl } from "./dailyImport";
import { importNextDaySourceBatch, previewNextDaySourceImport, readSapImportContext } from './nextDayImport';
import type { PortableBaselineHistory } from "../src/domain/dailyImport";
import type { PortableWorkspaceBackupV6, PortableWorkspaceBackupV7 } from "../src/domain/baselineBackup";
import type { PortableDailyPlanning } from '../src/domain/dailyPlanning';

interface WorkspaceRow {
  revision: string;
  is_demo: boolean;
  settings: unknown;
  catalog: unknown;
  previous_backup: unknown | null;
  previous_source_backup: unknown | null;
  previous_inventory_backup: unknown | null;
  previous_production_progress_backup: unknown | null;
  previous_baseline_history_backup: unknown | null;
  previous_daily_planning_backup:unknown|null;
  undo_state: unknown | null;
  undo_revision: string | null;
  updated_at: Date | string;
}

interface LoadedWorkspace {
  state: AppState;
  revision: number;
  isDemo: boolean;
  previousBackup: AppState | null;
  previousSourceBackup: PortableSourceDataWithReviews | null;
  previousInventoryBackup: PortableInventoryData | null;
  previousProductionProgressBackup: PortableProductionProgress | null;
  previousBaselineHistoryBackup: PortableBaselineHistory | null;
  previousDailyPlanningBackup:PortableDailyPlanning|null;
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

  async getOperationsSummary() { return getOperationsSummary(this.pool); }
  async previewDailyReports(reports: DailyReportInput[]) { return previewDailyReports(this.pool, reports); }
  async getSourceOrderObservations(id: string) { return listSourceOrderObservations(this.pool, id); }
  async getSapImportContext() { return readSapImportContext(this.pool); }

  async previewSourceImport(input: SourceImportInput, _context?: SourceImportPreviewContext) { return previewNextDaySourceImport(this.pool, input); }
  async listSourceOrders(query: URLSearchParams) { return listSourceOrders(this.pool, query); }
  async getSourceOrder(id: string) { return getSourceOrder(this.pool, id); }
  async listSourceImportReviews(query: URLSearchParams) { return listSourceImportReviews(this.pool, query); }
  async getSourceImportReview(id: string) { return getSourceImportReview(this.pool, id); }
  async getInventory() { return getInventorySnapshot(this.pool); }
  async getInventoryProductionSummary(date: string) {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const current = await loadWorkspace(client, false);
      const result = await getProductionSummary(client, date, current.revision);
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
  async getJobProduction(jobId:string) {
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const current=await loadWorkspace(client,false),job=current.state.jobs.find(row=>row.id===jobId);
      if(!job)throw new ApiError(404,"JOB_NOT_FOUND","Production card not found.");
      const total=await jobProductionTotal(client,jobId);
      const orderTotals=await jobProductionTotalsBySource(client,jobId);
      await client.query("COMMIT");
      return {total:job.mode==="bags"?total:total/1000,unit:job.mode==="bags"?"Bags":"MT",orderTotals:orderTotals.map(row=>({sourceOrderId:row.sourceOrderId,total:job.mode==="bags"?row.total:row.total/1000}))};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async getInventoryOrders() {
    const current = await this.getWorkspace();
    return getOrderProgress(this.pool, current.state);
  }
  async getInventoryDaily(date?: string) {
    return listDailyStock(this.pool,date);
  }
  async getInventoryOrderJournal(sourceOrderId: string) {
    return (await listOrderJournal(this.pool,sourceOrderId)).filter(row => row.sourceOrderId === sourceOrderId);
  }
  async getInventoryLedger(limit?: number, itemId?: string) { return listLedger(this.pool, limit, itemId); }
  async getProductionProgress(jobIds: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const loaded = await loadWorkspace(client, false);
      const result = await getProductionProgress(client, loaded.state, loaded.revision, jobIds);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async previewInventoryDraft(input: InventoryDraftRequest) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const loaded = await loadWorkspace(client, false);
      const nowIso = new Date().toISOString();
      const demand = await buildPlanningDemand(client, loaded.state, input, nowIso);
      const carryover = await buildCarryoverPlanningContext(client,loaded.state,nowIso);
      // Leave a short, rounded review window before current-day work starts.
      // The commit path rejects drafts after that start instead of silently
      // shifting a full line beyond the end of its working day.
      const preview = planInventoryDraft(loaded.state, demand, input, loaded.revision, draftPlanningFloor(nowIso),carryover);
      await client.query("COMMIT");
      return { ...preview, generatedAt: nowIso };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async listSourceImports() {
    const result = await this.pool.query<{ id: string; file_name: string; as_of_date: string | Date; imported_at: string | Date; row_count: number }>(
      "SELECT id, file_name, as_of_date::text AS as_of_date, imported_at, row_count FROM source_imports WHERE workspace_id = 1 ORDER BY imported_at DESC",
    );
    return result.rows.map(row => ({ id: row.id, fileName: row.file_name, asOfDate: String(row.as_of_date).slice(0, 10), importedAt: new Date(row.imported_at).toISOString(), rowCount: row.row_count }));
  }

  async getPortableBackup(): Promise<PortableWorkspaceBackupV7> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const loaded = await loadWorkspace(client, false);
      const sourceData = await exportSourceData(client);
      const result = portableBackupV7(stripContinuationProjection(loaded.state), sourceData, await exportInventoryData(client), await exportProductionProgress(client), await exportBaselineHistory(client),await exportDailyPlanning(client));
      assertPortableBackupSize(result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async getPreviousPortableBackup(): Promise<PortableWorkspaceBackupV5 | PortableWorkspaceBackupV6 | PortableWorkspaceBackupV7 | null> {
    const current = await this.getWorkspaceWithPreviousSource();
    if (!current.previousBackup) return null;
    const result = current.previousBaselineHistoryBackup
      ? current.previousDailyPlanningBackup?portableBackupV7(stripContinuationProjection(current.previousBackup), current.previousSourceBackup ?? emptySourceData(), current.previousInventoryBackup ?? emptyInventoryData(), current.previousProductionProgressBackup ?? emptyProductionProgress(), current.previousBaselineHistoryBackup,current.previousDailyPlanningBackup)
      : portableBackupV6(current.previousBackup, current.previousSourceBackup ?? emptySourceData(), current.previousInventoryBackup ?? emptyInventoryData(), current.previousProductionProgressBackup ?? emptyProductionProgress(), current.previousBaselineHistoryBackup)
      : portableBackupV5(current.previousBackup, current.previousSourceBackup ?? emptySourceData(), current.previousInventoryBackup ?? emptyInventoryData(), current.previousProductionProgressBackup ?? emptyProductionProgress());
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
      let previousInventoryBackup = current.previousInventoryBackup;
      let previousProductionProgressBackup = current.previousProductionProgressBackup;
      let previousBaselineHistoryBackup = current.previousBaselineHistoryBackup;
      let previousDailyPlanningBackup=current.previousDailyPlanningBackup;
      let productionProgressToRestore: PortableProductionProgress | null = null;
      let baselineHistoryToRestore: PortableBaselineHistory | null = null;
      let dailyPlanningToRestore:PortableDailyPlanning|null=null;
      let undoState: AppState | null = null;
      let undoRevision: number | null = null;

      try {
        switch (command.type) {
          case "workspace.restore":
            assertPortableBackupSize(command.backup);
            {
              const backup = "planning" in command.backup
                ? (command.backup.schemaVersion === 7 ? validatePortableBackupV7(command.backup)
                  : command.backup.schemaVersion === 6 ? validatePortableBackupV6(command.backup)
                  : command.backup.schemaVersion === 5 ? validatePortableBackupV5(command.backup)
                  : "inventory" in command.backup ? validatePortableBackupV4(command.backup) : validatePortableBackupV3(command.backup))
                : null;
              const restoredPlanning = backup?.planning ?? stripSourceLinks(validateWorkspaceBackup(command.backup));
              previousSourceBackup = await exportSourceData(client);
              previousInventoryBackup = await exportInventoryData(client);
              previousProductionProgressBackup = await exportProductionProgress(client);
              previousBaselineHistoryBackup = await exportBaselineHistory(client);
              previousDailyPlanningBackup=await exportDailyPlanning(client);
              await clearDailyPlanning(client);
              await clearProductionProgress(client);
              await clearInventoryData(client);
              await clearSourceData(client);
              previousBackup = current.state;
              if (backup) await restoreSourceData(client, backup.sourceData);
              if (backup && "inventory" in backup) await restoreInventoryData(client, backup.inventory);
              productionProgressToRestore = backup && "productionProgress" in backup ? backup.productionProgress : emptyProductionProgress();
              baselineHistoryToRestore = backup && "baselineHistory" in backup ? backup.baselineHistory : null;
              dailyPlanningToRestore=backup&&'dailyPlanning' in backup?backup.dailyPlanning:{admissionBatches:[],orderAdmissions:[],continuationReservations:[]};
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
            previousInventoryBackup = await exportInventoryData(client);
            previousProductionProgressBackup = await exportProductionProgress(client);
            previousBaselineHistoryBackup = await exportBaselineHistory(client);
            previousDailyPlanningBackup=await exportDailyPlanning(client);
            await clearDailyPlanning(client);
            await clearProductionProgress(client);
            await clearInventoryData(client);
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
            nextState = await importNextDaySourceBatch(client,current.state,[command.input],nowIso);
            break;
          }
          case "inventory.importStockReports":
          case "inventory.importDailyReports":
            nextState = await importDailyReports(client, current.state, command.reports, command.reconcile, command.reason, nowIso);
            isDemo = false;
            break;
          case "data.importBatch":
            nextState = await importNextDaySourceBatch(client, current.state, command.inputs, nowIso);
            break;
          case "data.setPlanningControl":
            nextState = await setPlanningControl(client, current.state, command.sourceOrderId, command.action, command.reason, command.stockAccounted, nowIso);
            break;
          case "data.applySourceCorrection":
          case "data.dismissSourceCorrection": {
            const result = await executeSourceImportReview(client, current.state, command, nowIso);
            if (result.inventoryChanged) await recalculateReservations(client, nowIso);
            nextState = result.state;
            break;
          }
          case "job.createFromSource": {
            const result = await createJobFromSource(client, current.state, command.input, nowIso);
            nextState = result.state;
            break;
          }
          case "job.createFromSources": {
            const result = await createJobFromSources(client, current.state, command.input, nowIso);
            nextState = result.state;
            break;
          }
          case "job.combinePending": {
            const posted=await client.query("SELECT 1 FROM inventory_ledger WHERE job_id=ANY($1::text[]) LIMIT 1",[command.jobIds]);
            if(posted.rowCount)throw new ApiError(409,"POSTED_JOB_IMMUTABLE","Cards with inventory movements cannot be combined. Correct or complete them separately.");
            nextState=executeCommand(current.state,command,{nowIso});
            break;
          }
          case "job.splitPending": {
            const posted=await client.query("SELECT 1 FROM inventory_ledger WHERE job_id=$1 LIMIT 1",[command.jobId]);
            if(posted.rowCount)throw new ApiError(409,"POSTED_JOB_IMMUTABLE","A card with recorded or corrected production cannot be split.");
            nextState=executeCommand(current.state,command,{nowIso});
            break;
          }
          case "job.transferOrder": {
            await validateOrderTransferPersistence(client, current.state, command);
            nextState=executeCommand(current.state,command,{nowIso});
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
          case "inventory.importBaseline":
          case "inventory.importWorkbook":
          case "inventory.adjust":
          case "inventory.receive":
          case "inventory.configure":
          case "production.recordReceipt":
          case "production.correct":
          case "production.correctJobTotal":
          case "delivery.record":
          case "delivery.reverse":
          case "planning.commitDraft":
          case "data.updateManualFields":
            if (command.type === "planning.commitDraft" && command.previewRevision !== current.revision) {
              throw new ApiError(409, "STALE_DRAFT", "Inventory or capacity changed after this draft was generated. Generate it again.");
            }
            nextState = await executeInventoryCommand(client, current.state, command as InventoryCommand, nowIso, { commandId });
            if((command.type==="inventory.importBaseline"||command.type==="inventory.importWorkbook")&&command.input.includeBaseline)isDemo=false;
            break;
          default:
            if(command.type==='job.move'){
              const fixed=await client.query(`SELECT 1 FROM inventory_ledger WHERE job_id=$1 LIMIT 1`,[command.jobId]);
              if(fixed.rowCount)throw new ApiError(409,'POSTED_JOB_IMMUTABLE','A card with production movement history must remain on its original PM and date. Correct its output instead of moving it.');
            }
            if(command.type==='job.update'){
              const posted=await client.query(`SELECT 1 FROM inventory_ledger WHERE job_id=$1 LIMIT 1`,[command.jobId]);
              if(posted.rowCount&&Object.keys(command.patch).some(key=>key!=='bin'&&key!=='remarks'))throw new ApiError(409,'POSTED_JOB_IMMUTABLE','Only bin and remarks can change after production has been posted.');
            }
            if (command.type === "job.start") {
              const blocked=await client.query(`SELECT 1 FROM job_source_allocations a JOIN inventory_orders io ON io.source_order_id=a.source_order_id WHERE a.job_id=$1 AND io.planning_control<>'active' LIMIT 1`,[command.jobId]);
              if(blocked.rowCount)throw new ApiError(409,"SOURCE_PLANNING_BLOCKED","This production card contains an order that is on hold, cancelled, or requires review.");
            }
            nextState = executeCommand(current.state, command, { nowIso });
            if(command.type==='job.cancel')nextState=await reconcileContinuationReservation(client,nextState,command.jobId,nowIso);
            if(command.type==='job.complete'||command.type==='job.recordActual')nextState=await reconcileContinuationReservation(client,nextState,command.jobId,nowIso);
            if ((command.type === "job.complete" || command.type === "job.recordActual")) {
              const job = nextState.jobs.find(candidate => candidate.id === command.jobId);
              if (job?.inventoryItemId && typeof job.actualQuantityMt === "number") {
                const totalActualQuantity = job.mode === "bags"
                  ? job.actualQuantityMt * 1_000 / (job.bagWeightKgSnapshot ?? current.state.settings.bagWeightKg)
                  : job.actualQuantityMt;
                nextState = await executeInventoryCommand(client, nextState, {
                  type: "production.recordReceipt", jobId: job.id, totalActualQuantity,
                }, nowIso, { commandId, receiptSource: "completion" });
              }
            }
            if (command.type === "job.move") {
              undoState = current.state;
              undoRevision = nextRevision;
            }
        }
        nextState = validateWorkspaceBackup(nextState);
        await validateInventoryJobs(client,nextState);
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
        previousInventoryBackup,
        previousProductionProgressBackup,
        previousBaselineHistoryBackup,
        previousDailyPlanningBackup,
        undoState,
        undoRevision,
        updatedAt: nowIso,
      });
      if (productionProgressToRestore) await restoreProductionProgress(client, productionProgressToRestore);
      if (baselineHistoryToRestore) await restoreBaselineHistory(client, baselineHistoryToRestore);
      if(dailyPlanningToRestore){await restoreDailyPlanning(client,dailyPlanningToRestore);nextState=(await loadWorkspace(client,false)).state;}
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
    `SELECT revision, is_demo, settings, catalog, previous_backup, previous_source_backup, previous_inventory_backup,
       previous_production_progress_backup, previous_baseline_history_backup,previous_daily_planning_backup, undo_state, undo_revision, updated_at
     FROM workspace WHERE id = 1${lockClause}`,
  );
  if (!workspace.rowCount) throw new Error("Workspace has not been initialized.");
  const row = workspace.rows[0];
  const jobs = await client.query<{ payload: any }>("SELECT payload FROM jobs WHERE workspace_id = 1 ORDER BY ordinal");
  const events = await client.query<{ payload: unknown }>("SELECT payload FROM history_events WHERE workspace_id = 1 ORDER BY ordinal");
  const baseState=validateWorkspaceBackup({schemaVersion:2,catalog:row.catalog,jobs:jobs.rows.map(item=>item.payload),settings:row.settings,events:events.rows.map(item=>item.payload)});
  interface ContinuationRow{job_id:string;remaining_quantity_scaled:string;unit:'Bags'|'MT';segments:unknown;planned_at:string|Date}
  const continuations=await client.query<ContinuationRow>('SELECT job_id,remaining_quantity_scaled::text,unit,segments,planned_at FROM job_continuation_reservations WHERE workspace_id=1');
  const continuationByJob=new Map<string,ContinuationRow>(continuations.rows.map((item:ContinuationRow)=>[item.job_id,item]));
  const movementHistory=await client.query<{job_id:string;last_recorded_at:string|Date}>(`SELECT l.job_id,max(l.recorded_at) last_recorded_at FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.job_id IS NOT NULL AND (l.movement_type='production' OR (l.movement_type='reversal' AND original.movement_type='production')) GROUP BY l.job_id`);
  const historyByJob=new Map(movementHistory.rows.map(item=>[item.job_id,new Date(item.last_recorded_at).toISOString()]));
  const virtualIds=new Set(baseState.jobs.filter(job=>job.status==='pending'&&!continuationByJob.has(job.id)&&historyByJob.has(job.id)).map(job=>job.id));
  const scheduledBefore=new Map(getScheduledJobs(baseState).map(job=>[job.id,job])),cutoff=Math.min(...[...virtualIds].map(id=>Date.parse(historyByJob.get(id)!)));
  const hydratedJobs=baseState.jobs.map(job=>{let current=job;if(virtualIds.size&&!virtualIds.has(job.id)){const schedule=scheduledBefore.get(job.id);if(schedule?.status==='pending'&&schedule.plannedStart!==null&&(schedule.plannedEnd??0)>cutoff)current={...current,notBefore:new Date(Math.max(schedule.plannedStart,Date.parse(current.notBefore??'1970-01-01T00:00:00Z'))).toISOString()};}const plan=continuationByJob.get(job.id);if(plan){const native=Number(plan.remaining_quantity_scaled)/(plan.unit==='MT'?1_000:1),remainingQuantityMt=plan.unit==='Bags'?native*(job.bagWeightKgSnapshot??baseState.settings.bagWeightKg)/1_000:native;return{...current,continuationPlan:{remainingQuantityMt,plannedAt:new Date(plan.planned_at).toISOString(),segments:plan.segments}};}const plannedAt=historyByJob.get(job.id);return virtualIds.has(job.id)&&plannedAt?{...current,continuationPlan:{remainingQuantityMt:0,plannedAt,segments:[]}}:current;});
  const state = validateWorkspaceBackup({
    schemaVersion: 2,
    catalog: baseState.catalog,
    jobs: hydratedJobs,
    settings: baseState.settings,
    events: baseState.events,
  });
  return {
    state,
    revision: safeRevision(row.revision),
    isDemo: row.is_demo,
    previousBackup: row.previous_backup === null ? null : validateWorkspaceBackup(row.previous_backup),
    previousSourceBackup: row.previous_source_backup === null ? null : normalizePreviousSourceData(row.previous_source_backup),
    previousInventoryBackup: row.previous_inventory_backup === null ? null : row.previous_inventory_backup as PortableInventoryData,
    previousProductionProgressBackup: row.previous_production_progress_backup === null ? null : row.previous_production_progress_backup as PortableProductionProgress,
    previousBaselineHistoryBackup: row.previous_baseline_history_backup === null ? null : row.previous_baseline_history_backup as PortableBaselineHistory,
    previousDailyPlanningBackup:row.previous_daily_planning_backup===null?null:row.previous_daily_planning_backup as PortableDailyPlanning,
    undoState: row.undo_state === null ? null : validateWorkspaceBackup(row.undo_state),
    undoRevision: row.undo_revision === null ? null : safeRevision(row.undo_revision),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function persistWorkspace(client: pg.PoolClient, value: LoadedWorkspace): Promise<void> {
  await client.query(
    `UPDATE workspace SET revision = $1, is_demo = $2, settings = $3::jsonb,
       catalog = $4::jsonb, previous_backup = $5::jsonb, previous_source_backup = $6::jsonb,
       previous_inventory_backup = $7::jsonb, previous_production_progress_backup=$8::jsonb,
       previous_baseline_history_backup=$9::jsonb,previous_daily_planning_backup=$10::jsonb, undo_state = $11::jsonb, undo_revision = $12, updated_at = $13::timestamptz WHERE id = 1`,
    [
      value.revision,
      value.isDemo,
      JSON.stringify(value.state.settings),
      JSON.stringify(value.state.catalog),
      value.previousBackup === null ? null : JSON.stringify(value.previousBackup),
      value.previousSourceBackup === null ? null : JSON.stringify(value.previousSourceBackup),
      value.previousInventoryBackup === null ? null : JSON.stringify(value.previousInventoryBackup),
      value.previousProductionProgressBackup === null ? null : JSON.stringify(value.previousProductionProgressBackup),
      value.previousBaselineHistoryBackup === null ? null : JSON.stringify(value.previousBaselineHistoryBackup),
      value.previousDailyPlanningBackup===null?null:JSON.stringify(value.previousDailyPlanningBackup),
      value.undoState === null ? null : JSON.stringify(value.undoState),
      value.undoRevision,
      value.updatedAt,
    ],
  );
  // Preserve row identities and dependent records. Ordinals move out of the way first so swaps
  // cannot violate the workspace/ordinal unique constraint during the upsert.
  await client.query("UPDATE jobs SET ordinal = ordinal + 1000000000 WHERE workspace_id = 1");
  if (value.state.jobs.length) {
    await client.query(
      `INSERT INTO jobs(workspace_id, id, ordinal, planning_date, line_id, sequence, status, source_order_id, payload)
       SELECT 1, item->>'id', ordinality - 1, (item->>'date')::date,
              item->>'lineId', (item->>'sequence')::integer, item->>'status', NULLIF(item->>'sourceOrderId', ''), item
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)
       ON CONFLICT (id) DO UPDATE SET ordinal=EXCLUDED.ordinal,planning_date=EXCLUDED.planning_date,
         line_id=EXCLUDED.line_id,sequence=EXCLUDED.sequence,status=EXCLUDED.status,
         source_order_id=EXCLUDED.source_order_id,payload=EXCLUDED.payload`,
      [JSON.stringify(value.state.jobs.map(job=>{const{continuationPlan:_continuationPlan,...persisted}=job;return persisted;}))],
    );
  }
  await client.query("DELETE FROM jobs WHERE workspace_id=1 AND ordinal >= 1000000000");
  const sourceAllocations = value.state.jobs.flatMap(job => getJobSourceAllocations(job).map((allocation, ordinal) => ({
    job_id: job.id,
    source_order_id: allocation.sourceOrderId,
    ordinal,
    planned_quantity_scaled: Math.round(allocation.plannedQuantity * (allocation.sourceSnapshot.unit === "MT" ? 1_000 : 1)),
    source_order_version: allocation.sourceOrderVersion,
    source_snapshot: allocation.sourceSnapshot,
  })));
  await client.query("DELETE FROM job_source_allocations WHERE job_id IN (SELECT id FROM jobs WHERE workspace_id=1)");
  for (let offset = 0; offset < sourceAllocations.length; offset += 1_000) {
    await client.query(
      `INSERT INTO job_source_allocations(job_id,source_order_id,ordinal,planned_quantity_scaled,source_order_version,source_snapshot)
       SELECT job_id,source_order_id,ordinal,planned_quantity_scaled,source_order_version,source_snapshot
       FROM jsonb_to_recordset($1::jsonb) AS x(job_id text,source_order_id text,ordinal integer,planned_quantity_scaled bigint,source_order_version integer,source_snapshot jsonb)`,
      [JSON.stringify(sourceAllocations.slice(offset, offset + 1_000))],
    );
  }
  await client.query("UPDATE history_events SET ordinal = ordinal + 1000000000 WHERE workspace_id = 1");
  if (value.state.events.length) {
    await client.query(
      `INSERT INTO history_events(workspace_id, id, ordinal, occurred_at, event_type, job_id, payload)
       SELECT 1, item->>'id', ordinality - 1, (item->>'at')::timestamptz,
              item->>'type', item->>'jobId', item
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(item, ordinality)
       ON CONFLICT (id) DO UPDATE SET ordinal=EXCLUDED.ordinal,occurred_at=EXCLUDED.occurred_at,
         event_type=EXCLUDED.event_type,job_id=EXCLUDED.job_id,payload=EXCLUDED.payload`,
      [JSON.stringify(value.state.events)],
    );
  }
  await client.query("DELETE FROM history_events WHERE workspace_id=1 AND ordinal >= 1000000000");
}

function emptySourceData(): PortableSourceDataWithReviews { return { imports: [], orders: [], versions: [], discrepancies: [] }; }
function emptyInventoryData(): PortableInventoryData { return { items: [], imports: [], baselineReports: [], orders: [], ledger: [], reservations: [] }; }
function emptyProductionProgress(): PortableProductionProgress { return { samples: [], resets: [] }; }
function normalizePreviousSourceData(value: unknown): PortableSourceDataWithReviews {
  const source = value as PortableSourceData & { discrepancies?: PortableSourceDataWithReviews["discrepancies"] };
  return { imports: source.imports ?? [], orders: source.orders ?? [], versions: source.versions ?? [], discrepancies: source.discrepancies ?? [] };
}

function activateCalendar(state: AppState, effectiveFrom: string, dayStart: string, availableHours: number, nowIso: string): AppState {
  if (availableHours <= 0 || availableHours > 24) throw new Error("Available hours must be greater than zero and no more than 24.");
  if (effectiveFrom !== malaysiaDateAt(nowIso)) throw new Error("The production calendar must take effect on the current Malaysia date.");
  if (state.settings.calendarHistory) throw new Error("The legacy calendar activation command is unavailable after editable production hours are saved.");
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
      const { sourceOrderId: _sourceOrderId, sourceOrderVersion: _sourceOrderVersion, sourceSnapshot: _sourceSnapshot, sourceAllocations: _sourceAllocations, bagWeightKgSnapshot: _bagWeightKgSnapshot, ...plain } = job;
      return plain;
    }),
  };
}

function stripContinuationProjection(state:AppState):AppState{return{...state,jobs:state.jobs.map(job=>{const{continuationPlan:_projection,...stored}=job;return stored;})}}

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

async function validateOrderTransferPersistence(
  client: pg.PoolClient,
  state: AppState,
  command: Extract<Command, { type: "job.transferOrder" }>,
): Promise<void> {
  const jobIds = command.targetJobId ? [command.jobId, command.targetJobId] : [command.jobId];
  const storedJobs = await client.query<{ id: string; status: string }>(
    "SELECT id,status FROM jobs WHERE workspace_id=1 AND id=ANY($1::text[]) FOR UPDATE",
    [jobIds],
  );
  if (storedJobs.rowCount !== jobIds.length) throw new ApiError(409, "TRANSFER_BATCH_CHANGED", "The source or destination batch no longer exists. Refresh the plan.");
  if (storedJobs.rows.some(row => row.status !== "pending")) {
    throw new ApiError(409, "TRANSFER_BATCH_STARTED", "Only pending production batches can transfer an order.");
  }
  const posted = await client.query(
    "SELECT 1 FROM inventory_ledger WHERE job_id=ANY($1::text[]) LIMIT 1",
    [jobIds],
  );
  if (posted.rowCount) {
    throw new ApiError(409, "POSTED_JOB_IMMUTABLE", "A batch with production movement history cannot transfer an order.");
  }

  const storedAllocations = await client.query<{
    job_id: string; source_order_id: string; ordinal: number; planned_quantity_scaled: string;
    source_order_version: number; source_snapshot: unknown;
  }>(
    `SELECT job_id,source_order_id,ordinal,planned_quantity_scaled::text,source_order_version,source_snapshot
       FROM job_source_allocations WHERE job_id=ANY($1::text[]) ORDER BY job_id,ordinal`,
    [jobIds],
  );
  const expectedAllocations = jobIds.flatMap(jobId => {
    const job = state.jobs.find(candidate => candidate.id === jobId);
    if (!job) return [];
    return getJobSourceAllocations(job).map((allocation, ordinal) => ({
      job_id: jobId,
      source_order_id: allocation.sourceOrderId,
      ordinal,
      planned_quantity_scaled: String(Math.round(allocation.plannedQuantity * (allocation.sourceSnapshot.unit === "MT" ? 1_000 : 1))),
      source_order_version: allocation.sourceOrderVersion,
      source_snapshot: allocation.sourceSnapshot,
    }));
  }).sort((left, right) => left.job_id < right.job_id ? -1 : left.job_id > right.job_id ? 1 : left.ordinal - right.ordinal);
  if (canonicalJson(storedAllocations.rows) !== canonicalJson(expectedAllocations)) {
    throw new ApiError(409, "SOURCE_ALLOCATION_CHANGED", "The saved order allocations changed. Refresh the plan before transferring.");
  }
  if (!storedAllocations.rows.some(row => row.job_id === command.jobId && row.source_order_id === command.sourceOrderId)) {
    throw new ApiError(409, "SOURCE_ALLOCATION_CHANGED", "The selected order is no longer allocated to the source batch.");
  }

  const source = await client.query<{
    delivery_status: string; needs_review: boolean; has_pending_review: boolean;
    planning_control: string | null; historical_status: string | null;
  }>(
    `SELECT o.delivery_status,o.needs_review,
       EXISTS(SELECT 1 FROM source_order_discrepancies d WHERE d.source_order_id=o.id AND d.status='pending') has_pending_review,
       io.planning_control,io.historical_status
       FROM source_orders o LEFT JOIN inventory_orders io ON io.source_order_id=o.id
      WHERE o.workspace_id=1 AND o.id=$1 FOR UPDATE OF o`,
    [command.sourceOrderId],
  );
  if (!source.rowCount) throw new ApiError(409, "SOURCE_NOT_FOUND", "The selected source order no longer exists.");
  const eligibility = source.rows[0];
  if (eligibility.planning_control && eligibility.planning_control !== "active") {
    throw new ApiError(409, "SOURCE_PLANNING_BLOCKED", "This order is on hold, cancelled, or requires review before it can move.");
  }
  if (eligibility.needs_review || eligibility.has_pending_review) {
    throw new ApiError(409, "SOURCE_REVIEW_REQUIRED", "Resolve the source-order review before moving this order between batches.");
  }
  if (eligibility.delivery_status === "delivered") {
    throw new ApiError(409, "SOURCE_DELIVERED", "A delivered order cannot move between production batches.");
  }
  if (eligibility.historical_status === "done" || eligibility.historical_status === "out") {
    throw new ApiError(409, "SOURCE_PRODUCTION_COMPLETE", "An order marked production complete cannot move between batches.");
  }
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Stored workspace revision is invalid.");
  return revision;
}
