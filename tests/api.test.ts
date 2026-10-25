import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../server/app";
import { runMigrations } from "../server/migrate";
import { WorkspaceStore } from "../server/store";
import { createDefaultSettings } from "../src/domain/defaults";
import { createSampleState } from "../src/domain/sample";
import type { Command, WorkspaceEnvelope } from "../src/domain/commands";
import type { AppState, JobInput, LineId } from "../src/domain/types";
import type { SourceImportInput, SourceOrderPage } from "../src/domain/sourceTypes";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL workspace API", () => {
  let pool: pg.Pool;
  let store: WorkspaceStore;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    assertDedicatedTestDatabase(databaseUrl!, process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
    await runMigrations(pool);
    store = new WorkspaceStore(pool);
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
    const port = address.port;
    server.removeAllListeners("request");
    server.on("request", createApp({
      store,
      hostPorts: new Set([port]),
      distDir: "Z:\\directory-that-does-not-exist",
      allowedOrigins: new Set([`http://127.0.0.1:${port}`]),
    }));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE command_receipts, history_events, jobs, workspace CASCADE");
    await store.initialize(createDefaultSettings());
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
  });

  it("serializes concurrent mutations and returns the current workspace on a stale revision", async () => {
    const [first, second] = await Promise.all([
      postCommand(0, "concurrent-a", { type: "job.create", input: input("A") }),
      postCommand(0, "concurrent-b", { type: "job.create", input: input("B") }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const stale = first.status === 409 ? await first.json() : await second.json();
    assert.equal(stale.error.code, "STALE_REVISION");
    assert.equal(stale.workspace.revision, 1);
    assert.equal(stale.workspace.state.jobs.length, 1);
  });

  it("rolls back invalid commands without changing the revision", async () => {
    const invalid = await postCommand(0, "invalid-start", {
      type: "job.start", jobId: "missing",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_COMMAND");
    const current = await getWorkspace();
    assert.equal(current.revision, 0);
    assert.deepEqual(current.state.jobs, []);
  });

  it("deduplicates ambiguous retries and rejects command ID reuse with different content", async () => {
    const original: Command = { type: "job.create", input: input("ONE") };
    const first = await postCommand(0, "stable-id", original);
    assert.equal(first.status, 200);
    const second = await postCommand(1, "another-id", { type: "job.create", input: input("TWO") });
    assert.equal(second.status, 200);

    const retry = await postCommand(0, "stable-id", original);
    assert.equal(retry.status, 200);
    const latest = await retry.json() as WorkspaceEnvelope;
    assert.equal(latest.revision, 2);
    assert.equal(latest.state.jobs.length, 2);

    const conflict = await postCommand(2, "stable-id", { type: "job.create", input: input("DIFFERENT") });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "COMMAND_ID_CONFLICT");
    assert.equal((await getWorkspace()).revision, 2);
  });

  it("uses the server confirmation timestamp when completing a job", async () => {
    const createdResponse = await postCommand(0, "create-timed", { type: "job.create", input: input("TIMED") });
    const created = await createdResponse.json() as WorkspaceEnvelope;
    const jobId = created.state.jobs[0].id;
    const startedResponse = await postCommand(1, "start-timed", {
      type: "job.start", jobId,
    });
    assert.equal(startedResponse.status, 200);
    const earliest = Date.now();
    const completedResponse = await postCommand(2, "complete-timed", {
      type: "job.complete", jobId, actualQuantityMt: 9.5, completionNote: "Confirmed weigh-in",
    });
    const latest = Date.now();
    assert.equal(completedResponse.status, 200);
    const completed = await completedResponse.json() as WorkspaceEnvelope;
    const job = completed.state.jobs.find(candidate => candidate.id === jobId)!;
    assert.equal(job.actualQuantityMt, 9.5);
    assert.equal(job.completionNote, "Confirmed weigh-in");
    assert.ok(job.actualEnd);
    assert.ok(Date.parse(job.actualEnd!) >= earliest && Date.parse(job.actualEnd!) <= latest);
  });

  it("pauses and resumes atomically with trusted timestamps, stale guards, and retry receipts", async () => {
    const createdResponse = await postCommand(0, "pause-create", {
      type: "job.create", input: input("PAUSE-FLOW"),
    });
    const created = await createdResponse.json() as WorkspaceEnvelope;
    const jobId = created.state.jobs[0].id;
    const startedResponse = await postCommand(1, "pause-start", {
      type: "job.start", jobId,
    });
    assert.equal(startedResponse.status, 200);

    const pauseCommand: Command = { type: "job.pause", jobId, reason: "  Hopper inspection  " };
    const earliestPause = Date.now();
    const pausedResponse = await postCommand(2, "pause-stable", pauseCommand);
    const latestPause = Date.now();
    assert.equal(pausedResponse.status, 200);
    const paused = await pausedResponse.json() as WorkspaceEnvelope;
    const pausedJob = paused.state.jobs.find(job => job.id === jobId)!;
    assert.equal(paused.revision, 3);
    assert.equal(pausedJob.status, "running");
    assert.equal(pausedJob.pauseIntervals?.length, 1);
    assert.equal(pausedJob.pauseIntervals?.[0].reason, "Hopper inspection");
    assert.equal(pausedJob.pauseIntervals?.[0].resumedAt, null);
    const pausedAt = Date.parse(pausedJob.pauseIntervals![0].pausedAt);
    assert.ok(pausedAt >= earliestPause && pausedAt <= latestPause);

    const duplicatePause = await postCommand(2, "pause-stable", pauseCommand);
    assert.equal(duplicatePause.status, 200);
    const duplicateState = await duplicatePause.json() as WorkspaceEnvelope;
    assert.equal(duplicateState.revision, 3);
    assert.equal(duplicateState.state.jobs.find(job => job.id === jobId)?.pauseIntervals?.length, 1);

    const staleResume = await postCommand(2, "resume-stale", { type: "job.resume", jobId });
    assert.equal(staleResume.status, 409);
    assert.equal((await staleResume.json()).error.code, "STALE_REVISION");
    assert.equal((await getWorkspace()).state.jobs.find(job => job.id === jobId)?.pauseIntervals?.[0].resumedAt, null);

    const earliestResume = Date.now();
    const resumedResponse = await postCommand(3, "resume-valid", { type: "job.resume", jobId });
    const latestResume = Date.now();
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json() as WorkspaceEnvelope;
    const resumedAt = Date.parse(resumed.state.jobs.find(job => job.id === jobId)!.pauseIntervals![0].resumedAt!);
    assert.ok(resumedAt >= earliestResume && resumedAt <= latestResume);
    assert.ok(resumedAt >= pausedAt);

    const pausedAgainResponse = await postCommand(4, "pause-again", {
      type: "job.pause", jobId, reason: "Material hold",
    });
    assert.equal(pausedAgainResponse.status, 200);
    const completedResponse = await postCommand(5, "complete-paused", {
      type: "job.complete", jobId, actualQuantityMt: 8.25, completionNote: "Closed during hold",
    });
    assert.equal(completedResponse.status, 200);
    const completed = await completedResponse.json() as WorkspaceEnvelope;
    const completedJob = completed.state.jobs.find(job => job.id === jobId)!;
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.pauseIntervals?.length, 2);
    assert.equal(completedJob.pauseIntervals?.at(-1)?.resumedAt, completedJob.actualEnd);
    assert.equal(completed.state.events.at(-1)?.type, "job.completed");
    assert.ok(completed.state.events.at(-1)?.changes?.some(change =>
      change.field === "pauseState" && change.before === "paused" && change.after === null
    ));
    const persisted = await new WorkspaceStore(pool).getWorkspace();
    assert.deepEqual(
      persisted.state.jobs.find(job => job.id === jobId)?.pauseIntervals,
      completedJob.pauseIntervals,
    );
    assert.deepEqual(persisted.state.events.at(-1)?.changes, completed.state.events.at(-1)?.changes);
  });

  it("persists restore recovery, move undo, and workspace state across store instances", async () => {
    const baseResponse = await postCommand(0, "base-job", { type: "job.create", input: input("BASE") });
    assert.equal(baseResponse.status, 200);
    const backup = createSampleState("2026-10-16");
    const restoreResponse = await postCommand(1, "restore-demo-shape", { type: "workspace.restore", backup });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json() as WorkspaceEnvelope;
    assert.equal(restored.revision, 2);
    assert.equal(restored.isDemo, false);
    assert.equal(restored.previousBackup?.jobs[0].productCode, "BASE");
    assert.equal(restored.state.events.at(-1)?.type, "workspace.restored");

    const backlog = restored.state.jobs.find(job => job.status === "pending" && job.quantityMt === 0)!;
    const destination: LineId = backlog.lineId === "PM1" ? "PM2" : "PM1";
    const movedResponse = await postCommand(2, "move-for-undo", {
      type: "job.move", jobId: backlog.id, toLineId: destination,
    });
    const moved = await movedResponse.json() as WorkspaceEnvelope;
    assert.equal(moved.canUndo, true);
    assert.equal(moved.state.jobs.find(job => job.id === backlog.id)?.lineId, destination);

    const undoneResponse = await postCommand(3, "undo-move", { type: "workspace.undoLastMove" });
    const undone = await undoneResponse.json() as WorkspaceEnvelope;
    assert.equal(undone.canUndo, false);
    assert.equal(undone.state.jobs.find(job => job.id === backlog.id)?.lineId, backlog.lineId);
    assert.equal(undone.state.events.at(-1)?.type, "job.move.undone");
    assert.deepEqual(
      undone.state.events.at(-1)?.changes?.find(change => change.field === "lineId"),
      { field: "lineId", before: destination, after: backlog.lineId },
    );
    assert.equal(undone.state.events.at(-2)?.type, "job.moved");

    const restartedStore = new WorkspaceStore(pool);
    const afterRestart = await restartedStore.getWorkspace();
    assert.deepEqual(afterRestart, undone);
  });

  it("captures the prior workspace and audits an explicit demo reset", async () => {
    const baseResponse = await postCommand(0, "before-reset", { type: "job.create", input: input("RECOVER-ME") });
    assert.equal(baseResponse.status, 200);
    const resetResponse = await postCommand(1, "reset-demo", { type: "workspace.resetDemo", date: "2026-10-16" });
    assert.equal(resetResponse.status, 200);
    const reset = await resetResponse.json() as WorkspaceEnvelope;
    assert.equal(reset.isDemo, true);
    assert.equal(reset.previousBackup?.jobs[0].productCode, "RECOVER-ME");
    assert.equal(reset.state.events.at(-1)?.type, "workspace.reset");
  });

  it("persists catalog edits, keeps inactive codes reserved, and leaves job snapshots unchanged", async () => {
    const resetResponse = await postCommand(0, "catalog-demo", {
      type: "workspace.resetDemo", date: "2026-10-16",
    });
    const reset = await resetResponse.json() as WorkspaceEnvelope;
    const jobsBefore = structuredClone(reset.state.jobs);
    const createdResponse = await postCommand(1, "catalog-create", {
      type: "catalog.create",
      input: { code: "  QA-PRODUCT  ", description: "  QA catalog product  ", defaultMode: "bags" },
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json() as WorkspaceEnvelope;
    const product = created.state.catalog.find(item => item.code === "QA-PRODUCT")!;
    assert.ok(product.id);
    assert.equal(product.description, "QA catalog product");
    assert.deepEqual(created.state.jobs, jobsBefore);

    const inactiveResponse = await postCommand(2, "catalog-inactive", {
      type: "catalog.setActive", productId: product.id, active: false,
    });
    assert.equal(inactiveResponse.status, 200);
    const duplicateResponse = await postCommand(3, "catalog-duplicate", {
      type: "catalog.create",
      input: { code: " qa-product ", description: "Duplicate", defaultMode: "bulk" },
    });
    assert.equal(duplicateResponse.status, 400);
    assert.match((await duplicateResponse.json()).error.message, /already exists/i);

    const restarted = await new WorkspaceStore(pool).getWorkspace();
    assert.equal(restarted.revision, 3);
    assert.deepEqual(restarted.state.jobs, jobsBefore);
    assert.deepEqual(restarted.state.catalog.find(item => item.id === product.id), {
      id: product.id,
      code: "QA-PRODUCT",
      description: "QA catalog product",
      defaultMode: "bags",
      active: false,
    });
  });

  it("copies a batch atomically and preserves stale and retry receipt behavior", async () => {
    const bulkResponse = await postCommand(0, "copy-source-bulk", {
      type: "job.create", input: input("COPY-BULK"),
    });
    assert.equal(bulkResponse.status, 200);
    const bulkState = await bulkResponse.json() as WorkspaceEnvelope;
    const bagResponse = await postCommand(1, "copy-source-bags", {
      type: "job.create",
      input: {
        ...input("COPY-BAGS"),
        orderNo: "ORDER-COPY-BAGS",
        mode: "bags",
        bagCount: 20,
        quantityMt: 1,
      },
    });
    assert.equal(bagResponse.status, 200);
    const sources = (await bagResponse.json() as WorkspaceEnvelope).state.jobs;
    const bulk = sources.find(job => job.productCode === "COPY-BULK")!;
    const bags = sources.find(job => job.productCode === "COPY-BAGS")!;
    const command: Command = {
      type: "job.copyBatch",
      sourceDate: "2026-10-16",
      targetDate: "2026-10-17",
      items: [
        { sourceJobId: bulk.id, orderNo: "COPY-TARGET-BULK", quantity: { mode: "bulk", quantityMt: 2.5 } },
        { sourceJobId: bags.id, orderNo: "COPY-TARGET-BAGS", quantity: { mode: "bags", bagCount: 30 } },
      ],
    };

    const copiedResponse = await postCommand(2, "copy-batch-stable", command);
    assert.equal(copiedResponse.status, 200);
    const copied = await copiedResponse.json() as WorkspaceEnvelope;
    assert.equal(copied.revision, 3);
    assert.equal(copied.state.jobs.filter(job => job.date === "2026-10-17").length, 2);
    assert.equal(copied.state.events.filter(event => event.type === "plan.copied").length, 1);

    const invalid = await postCommand(3, "copy-batch-invalid", {
      type: "job.copyBatch",
      sourceDate: "2026-10-16",
      targetDate: "2026-10-18",
      items: [
        { sourceJobId: bulk.id, orderNo: "WOULD-BE-VALID", quantity: { mode: "bulk", quantityMt: 1 } },
        { sourceJobId: "missing-source", orderNo: "INVALID", quantity: { mode: "bulk", quantityMt: 1 } },
      ],
    });
    assert.equal(invalid.status, 400);
    let current = await getWorkspace();
    assert.equal(current.revision, 3);
    assert.equal(current.state.jobs.filter(job => job.date === "2026-10-18").length, 0);

    const later = await postCommand(3, "after-copy", {
      type: "catalog.create",
      input: { code: "AFTER-COPY", description: "Receipt test", defaultMode: "bulk" },
    });
    assert.equal(later.status, 200);
    const retry = await postCommand(2, "copy-batch-stable", command);
    assert.equal(retry.status, 200);
    current = await retry.json() as WorkspaceEnvelope;
    assert.equal(current.revision, 4);
    assert.equal(current.state.jobs.filter(job => job.date === "2026-10-17").length, 2);

    const stale = await postCommand(2, "copy-batch-stale", {
      ...command,
      targetDate: "2026-10-19",
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "STALE_REVISION");
    assert.equal((await getWorkspace()).revision, 4);
    assert.equal(bulkState.state.jobs.length, 1);
  });

  it("invalidates move undo after any later successful mutation", async () => {
    const resetResponse = await postCommand(0, "seed-demo", { type: "workspace.resetDemo", date: "2026-10-16" });
    const reset = await resetResponse.json() as WorkspaceEnvelope;
    const backlog = reset.state.jobs.find(job => job.status === "pending" && job.quantityMt === 0)!;
    const destination: LineId = backlog.lineId === "PM1" ? "PM2" : "PM1";
    const movedResponse = await postCommand(1, "move-once", { type: "job.move", jobId: backlog.id, toLineId: destination });
    assert.equal(movedResponse.status, 200);
    const updatedResponse = await postCommand(2, "edit-after-move", {
      type: "job.update", jobId: backlog.id, patch: { remarks: "Confirmed after move" },
    });
    assert.equal(updatedResponse.status, 200);
    assert.equal(((await updatedResponse.json()) as WorkspaceEnvelope).canUndo, false);
    const undoResponse = await postCommand(3, "late-undo", { type: "workspace.undoLastMove" });
    assert.equal(undoResponse.status, 409);
    assert.equal((await undoResponse.json()).error.code, "UNDO_NOT_AVAILABLE");
  });

  it("activates the 07:00-19:00 cutover and freezes legacy completed segments", async () => {
    const effectiveFrom = malaysiaToday();
    const legacyDate = addDays(effectiveFrom, -1);
    const oldSettings = createDefaultSettings();
    oldSettings.dayStart = "08:30";
    oldSettings.availableHours = 23;
    const legacy: AppState = {
      schemaVersion: 2, catalog: [], settings: oldSettings, events: [], jobs: [{
        id: "legacy-completed", date: legacyDate, lineId: "PM1", sequence: 1,
        orderNo: "LEGACY-1", productCode: "6220", description: "Legacy completed", bin: "B01",
        mode: "bulk", bagCount: null, quantityMt: 10, status: "completed", remarks: "",
        actualStart: `${legacyDate}T01:00:00.000Z`, actualEnd: `${legacyDate}T02:00:00.000Z`,
        actualQuantityMt: 10, binNeedsReview: false, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-21T02:00:00.000Z",
      }],
    };
    const restored = await postCommand(0, "calendar-legacy-restore", { type: "workspace.restore", backup: legacy });
    assert.equal(restored.status, 200);
    const activated = await postCommand(1, "calendar-activate", {
      type: "settings.activateCalendar", effectiveFrom, dayStart: "07:00", availableHours: 12,
    });
    assert.equal(activated.status, 200);
    const state = (await activated.json() as WorkspaceEnvelope).state;
    assert.equal(state.settings.dayStart, "07:00");
    assert.equal(state.settings.availableHours, 12);
    assert.deepEqual(state.settings.calendarCutover && {
      effectiveFrom: state.settings.calendarCutover.effectiveFrom,
      priorDayStart: state.settings.calendarCutover.priorDayStart,
      priorAvailableHours: state.settings.calendarCutover.priorAvailableHours,
    }, { effectiveFrom, priorDayStart: "08:30", priorAvailableHours: 23 });
    assert.ok(state.jobs[0].lockedSegments?.length);
  });

  it("imports source orders, plans one card, preserves the bag snapshot, and controls delivery", async () => {
    const sourceImport: SourceImportInput = {
      fileName: "sap-export.xlsx", sheetName: "Sheet1", digest: "a".repeat(64), asOfDate: "2026-10-22",
      rows: [{
        doNo: "001039192030", deliveryDate: "2026-10-22", soldToParty: "FFM FARMS SDN BHD",
        shipToParty: "FFM FARMS SDN BHD", materialCode: "7.0313008513800",
        description: "FS 5138 POULTRY BR PRE-LAY CRUMB IN BULK", quantity: 20, unit: "Bags",
        deliveryLeadDays: 1, remark: "", daysOutstanding: -2, medication: "", fmrOmed: "",
      }],
    };
    const invalidImport = structuredClone(sourceImport);
    invalidImport.digest = "b".repeat(64);
    invalidImport.rows[0].quantity = -1;
    const invalidResponse = await postCommand(0, "source-import-invalid", { type: "data.import", input: invalidImport } as Command);
    assert.equal(invalidResponse.status, 400);
    assert.equal((await getWorkspace()).revision, 0);
    assert.equal((await (await fetch(`${baseUrl}/api/data/imports`)).json()).length, 0);
    const preview = await fetch(`${baseUrl}/api/data/preview`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify(sourceImport),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { added: 1, unchanged: 0, changed: 0, rows: [{ key: "001039192030 / 7.0313008513800", disposition: "added", existingOrderId: null, fields: sourceImport.rows[0], changedFields: [] }] });

    const imported = await postCommand(0, "source-import-1", { type: "data.import", input: sourceImport });
    assert.equal(imported.status, 200);
    const importRetry = await postCommand(0, "source-import-1", { type: "data.import", input: sourceImport });
    assert.equal(importRetry.status, 200);
    assert.equal((await importRetry.json() as WorkspaceEnvelope).revision, 1);
    const listResponse = await fetch(`${baseUrl}/api/data?search=001039192030`);
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json() as SourceOrderPage;
    assert.equal(page.total, 1);
    assert.equal(page.items[0].productionStatus, "unplanned");
    assert.equal(typeof page.items[0].currentDaysOutstanding, "number");
    let source = page.items[0];

    const laterBaseline = { ...sourceImport, asOfDate: "2026-10-23" };
    const laterPreview = await fetch(`${baseUrl}/api/data/preview`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify(laterBaseline),
    });
    const laterPreviewBody = await laterPreview.json();
    assert.equal(laterPreviewBody.changed, 1);
    assert.deepEqual(laterPreviewBody.rows[0].changedFields, ["asOfDate"]);
    const laterImport = await postCommand(1, "source-import-later-baseline", { type: "data.import", input: laterBaseline });
    assert.equal(laterImport.status, 200);
    const laterEnvelope = await laterImport.json() as WorkspaceEnvelope;
    assert.equal(laterEnvelope.state.events.at(-1)?.type, "data.imported");
    const importBatches = await (await fetch(`${baseUrl}/api/data/imports`)).json();
    assert.equal(importBatches.length, 2);
    const baselineRow = await pool.query<{ as_of_date: string; latest: boolean }>("SELECT i.as_of_date::text AS as_of_date, i.id = o.latest_import_id AS latest FROM source_imports i CROSS JOIN source_orders o WHERE i.workspace_id = 1 ORDER BY i.as_of_date");
    assert.deepEqual(baselineRow.rows.map(row => ({ date: row.as_of_date, latest: row.latest })), [
      { date: "2026-10-22", latest: false },
      { date: "2026-10-23", latest: true },
    ]);
    const refreshedPage = await (await fetch(`${baseUrl}/api/data?search=001039192030`)).json() as SourceOrderPage;
    source = refreshedPage.items[0];
    assert.equal(source.version, 1);
    assert.equal(source.importAsOfDate, "2026-10-23");

    const planned = await postCommand(2, "source-plan-1", {
      type: "job.createFromSource",
      input: { sourceOrderId: source.id, sourceOrderVersion: source.version, date: "2026-10-23", lineId: "PM2", bin: "B02", remarks: "SAP order" },
    });
    assert.equal(planned.status, 200);
    const plannedState = await planned.json() as WorkspaceEnvelope;
    const job = plannedState.state.jobs[0];
    assert.equal(job.sourceOrderId, source.id);
    assert.equal(job.sourceOrderVersion, 1);
    assert.equal(job.bagWeightKgSnapshot, plannedState.state.settings.bagWeightKg);
    assert.equal(job.quantityMt, 20 * plannedState.state.settings.bagWeightKg / 1_000);

    const duplicate = await postCommand(3, "source-plan-duplicate", {
      type: "job.createFromSource",
      input: { sourceOrderId: source.id, sourceOrderVersion: 1, date: "2026-10-23", lineId: "PM3", bin: "", remarks: "" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, "SOURCE_ALREADY_PLANNED");

    const earliest = Date.now();
    const started = await postCommand(3, "source-start", { type: "job.start", jobId: job.id });
    const latest = Date.now();
    assert.equal(started.status, 200);
    const startedEnvelope = await started.json() as WorkspaceEnvelope;
    const startedJob = startedEnvelope.state.jobs[0];
    assert.ok(Date.parse(startedJob.actualStart!) >= earliest && Date.parse(startedJob.actualStart!) <= latest);
    assert.equal(startedJob.updatedAt, startedJob.actualStart);
    const startRetry = await postCommand(3, "source-start", { type: "job.start", jobId: job.id });
    assert.equal(startRetry.status, 200);
    const retriedStart = await startRetry.json() as WorkspaceEnvelope;
    assert.equal(retriedStart.revision, 4);
    assert.equal(retriedStart.state.jobs[0].actualStart, startedJob.actualStart);

    const earlyDelivery = await postCommand(4, "source-deliver-early", { type: "data.setDeliveryStatus", sourceOrderId: source.id, delivered: true });
    assert.equal(earlyDelivery.status, 400);
    assert.equal((await earlyDelivery.json()).error.code, "PRODUCTION_NOT_COMPLETE");
    const completed = await postCommand(4, "source-complete", { type: "job.complete", jobId: job.id, actualQuantityMt: job.quantityMt });
    assert.equal(completed.status, 200);
    const delivered = await postCommand(5, "source-deliver", { type: "data.setDeliveryStatus", sourceOrderId: source.id, delivered: true });
    assert.equal(delivered.status, 200);
    const detailResponse = await fetch(`${baseUrl}/api/data/${encodeURIComponent(source.id)}`);
    const detail = await detailResponse.json();
    assert.equal(detail.deliveryStatus, "delivered");
    assert.equal(detail.deliverySource, "manual");
    assert.equal(detail.productionStatus, "completed");
    assert.equal(detail.versionTotal, 1);

    const backupResponse = await fetch(`${baseUrl}/api/backup`);
    const backup = await backupResponse.json();
    assert.equal(backup.schemaVersion, 4);
    assert.equal(backup.sourceData.orders.length, 1);
    assert.equal(backup.planning.jobs[0].sourceOrderId, source.id);

    const reset = await postCommand(6, "source-reset", { type: "workspace.resetDemo", date: "2026-10-24" });
    assert.equal(reset.status, 200);
    assert.equal((await (await fetch(`${baseUrl}/api/data`)).json() as SourceOrderPage).total, 0);
    const previousResponse = await fetch(`${baseUrl}/api/backup/previous`);
    assert.equal(previousResponse.status, 200);
    const previous = await previousResponse.json();
    assert.equal(previous.sourceData.orders.length, 1);
    const restored = await postCommand(7, "source-restore-v3", { type: "workspace.restore", backup });
    assert.equal(restored.status, 200);
    const restoredState = await restored.json() as WorkspaceEnvelope;
    assert.equal(restoredState.state.jobs.some(item => item.sourceOrderId === source.id), true);
    assert.equal((await (await fetch(`${baseUrl}/api/data`)).json() as SourceOrderPage).total, 1);
  });

  it("uses case-insensitive source identity and validates Data query filters", async () => {
    const base: SourceImportInput = {
      fileName: "case-a.xlsx", sheetName: "Orders", digest: "c".repeat(64), asOfDate: "2026-10-22",
      rows: [{
        doNo: "DO-CASE", deliveryDate: "2026-10-24", soldToParty: "Customer", shipToParty: "Plant",
        materialCode: "MAT-ONE", description: "Feed", quantity: 5, unit: "MT", deliveryLeadDays: 2,
        remark: "", daysOutstanding: 3, medication: "", fmrOmed: "",
      }],
    };
    assert.equal((await postCommand(0, "case-import-a", { type: "data.import", input: base })).status, 200);
    const changed: SourceImportInput = {
      ...base, fileName: "case-b.xlsx", digest: "d".repeat(64),
      rows: [{ ...base.rows[0], doNo: "do-case", materialCode: "mat-one" }],
    };
    assert.equal((await postCommand(1, "case-import-b", { type: "data.import", input: changed })).status, 200);

    const page = await (await fetch(`${baseUrl}/api/data?page=999`)).json() as SourceOrderPage;
    assert.equal(page.total, 1);
    assert.equal(page.page, 1);
    assert.equal(page.items[0].version, 2);
    const detail = await (await fetch(`${baseUrl}/api/data/${encodeURIComponent(page.items[0].id)}`)).json();
    assert.equal(detail.versionTotal, 2);
    assert.equal(detail.versions.length, 2);
    assert.equal((await fetch(`${baseUrl}/api/data?deliveryFrom=2026-02-31`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/data?productionStatus=unknown`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/data?page=0`)).status, 400);
    const backup = await (await fetch(`${baseUrl}/api/backup`)).json();
    assert.equal(backup.sourceData.orders.length, 1);
  });

  it("flags linked cards only when imported planning fields change", async () => {
    const sourceImport: SourceImportInput = {
      fileName: "review-a.xlsx", sheetName: "Orders", digest: "e".repeat(64), asOfDate: "2026-10-22",
      rows: [{
        doNo: "DO-REVIEW", deliveryDate: "2026-10-25", soldToParty: "Customer", shipToParty: "Plant",
        materialCode: "MAT-REVIEW", description: "Review feed", quantity: 8, unit: "MT",
        deliveryLeadDays: 3, remark: "", daysOutstanding: 4, medication: "", fmrOmed: "",
      }],
    };
    assert.equal((await postCommand(0, "review-import-a", { type: "data.import", input: sourceImport })).status, 200);
    let source = ((await (await fetch(`${baseUrl}/api/data?search=DO-REVIEW`)).json()) as SourceOrderPage).items[0];
    assert.equal((await postCommand(1, "review-plan", { type: "job.createFromSource", input: {
      sourceOrderId: source.id, sourceOrderVersion: source.version, date: "2026-10-25", lineId: "PM1", bin: "B01", remarks: "",
    } })).status, 200);

    const operationalUpdate: SourceImportInput = {
      ...sourceImport, fileName: "review-b.xlsx", digest: "f".repeat(64),
      rows: [{ ...sourceImport.rows[0], daysOutstanding: 1, deliveryLeadDays: 1 }],
    };
    assert.equal((await postCommand(2, "review-import-operational", { type: "data.import", input: operationalUpdate })).status, 200);
    source = ((await (await fetch(`${baseUrl}/api/data?search=DO-REVIEW`)).json()) as SourceOrderPage).items[0];
    assert.equal(source.needsReview, false);

    const planningUpdate: SourceImportInput = {
      ...operationalUpdate, fileName: "review-c.xlsx", digest: "1".repeat(64),
      rows: [{ ...operationalUpdate.rows[0], quantity: 9 }],
    };
    assert.equal((await postCommand(3, "review-import-planning", { type: "data.import", input: planningUpdate })).status, 200);
    source = ((await (await fetch(`${baseUrl}/api/data?search=DO-REVIEW`)).json()) as SourceOrderPage).items[0];
    assert.equal(source.needsReview, true);
  });

  it("enforces the loopback request boundary and JSON size/type limits without mutations", async () => {
    const body = JSON.stringify({ expectedRevision: 0, commandId: "boundary-test", command: { type: "job.create", input: input("BOUNDARY") } });
    const rejected = async (headers: Record<string, string>, payload: string, status: number, code: string, path = "/api/commands") => {
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const outgoing = httpRequest(`${baseUrl}${path}`, { method: "POST", headers }, incoming => {
          let data = "";
          incoming.setEncoding("utf8");
          incoming.on("data", chunk => { data += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode, body: data }));
          incoming.on("error", reject);
        });
        outgoing.on("error", reject);
        outgoing.end(payload);
      });
      assert.equal(response.status, status);
      assert.equal(JSON.parse(response.body).error.code, code);
      assert.equal((await getWorkspace()).revision, 0);
    };
    await rejected({ "Content-Type": "application/json", Host: "foreign.example:8080" }, body, 400, "INVALID_HOST");
    await rejected({ "Content-Type": "application/json", Origin: "https://foreign.example" }, body, 403, "INVALID_ORIGIN");
    await rejected({ "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "cross-site" }, body, 403, "CROSS_SITE_REQUEST");
    await rejected({ "Content-Type": "text/plain", Origin: baseUrl }, body, 415, "UNSUPPORTED_MEDIA_TYPE");
    await rejected({ "Content-Type": "application/json", Origin: baseUrl }, "{", 400, "MALFORMED_JSON");
    await rejected({ "Content-Type": "application/json", Origin: baseUrl }, JSON.stringify({ padding: "x".repeat(10 * 1024 * 1024) }), 413, "PAYLOAD_TOO_LARGE", "/api/data/preview");
  });

  async function postCommand(expectedRevision: number, commandId: string, command: Command): Promise<Response> {
    return fetch(`${baseUrl}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ expectedRevision, commandId, command }),
    });
  }

  async function getWorkspace(): Promise<WorkspaceEnvelope> {
    const response = await fetch(`${baseUrl}/api/workspace`);
    assert.equal(response.status, 200);
    return response.json() as Promise<WorkspaceEnvelope>;
  }
});

function input(productCode: string): JobInput {
  return {
    date: "2026-10-16",
    lineId: "PM1",
    orderNo: `ORDER-${productCode}`,
    productCode,
    description: "Integration test job",
    bin: "B01",
    mode: "bulk",
    bagCount: null,
    quantityMt: 10,
    remarks: "",
  };
}

function assertDedicatedTestDatabase(testValue: string, productionValue: string | undefined): void {
  const test = databaseIdentity(testValue, "TEST_DATABASE_URL");
  if (!/(^|[-_])test(?:[-_]|$)/i.test(test.database)) {
    throw new Error("TEST_DATABASE_URL database name must contain a separated 'test' marker (for example, millplan_test).");
  }
  if (!productionValue) return;
  const production = databaseIdentity(productionValue, "DATABASE_URL");
  if (test.host === production.host && test.port === production.port && test.database === production.database) {
    throw new Error("TEST_DATABASE_URL must identify a database separate from DATABASE_URL, regardless of credentials or query options.");
  }
}

function databaseIdentity(value: string, label: string): { host: string; port: string; database: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid PostgreSQL URL.`); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label} must use the postgres or postgresql protocol.`);
  }
  let database: string;
  try { database = decodeURIComponent(url.pathname.replace(/^\//, "")); }
  catch { throw new Error(`${label} contains an invalid encoded database name.`); }
  if (!database || database.includes("/")) throw new Error(`${label} must name exactly one database.`);
  return { host: url.hostname.toLowerCase(), port: url.port || "5432", database };
}

function malaysiaToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
