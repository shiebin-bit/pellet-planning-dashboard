import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../server/app";
import { runMigrations } from "../server/migrate";
import { WorkspaceStore } from "../server/store";
import { createDefaultSettings } from "../src/domain/defaults";
import type { Command } from "../src/domain/commands";
import { executeHistoricalFixture } from "./historical-fixture";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("transactional order-allocation transfer API", () => {
  let pool: pg.Pool, server: Server, store: WorkspaceStore, base: string;
  before(async () => {
    const target = new URL(url!);
    assert.match(target.pathname, /(^|[_-])test([_-]|$)/i);
    if (process.env.DATABASE_URL) assert.notEqual(url, process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await runMigrations(pool);
    store = new WorkspaceStore(pool);
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    server.on("request", createApp({ store, hostPorts: new Set([address.port]), distDir: "Z:/missing", allowedOrigins: new Set([base]) }));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE command_receipts,history_events,jobs,workspace CASCADE");
    await store.initialize(createDefaultSettings());
  });
  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  });

  async function get(path: string) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function post(command: Command, expectedRevision?: number, commandId = randomUUID()) {
    const revision = expectedRevision ?? (await get("/api/workspace")).revision;
    const response = await fetch(base + "/api/commands", {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ command, expectedRevision: revision, commandId }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function ok(command: Command) {
    const result = await post(command);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function setup() {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
    const row = (doNo: string, quantity: number) => ({
      doNo, deliveryDate: date, soldToParty: "Fictional customer", shipToParty: "Fictional farm",
      materialCode: "QA-FEED-TRANSFER", description: "Fictional transfer feed", quantity, unit: "MT" as const,
      deliveryLeadDays: 0, daysOutstanding: null, remark: "", medication: "", fmrOmed: "",
    });
    const rows = [row("QA-TRANSFER-A", 40), row("QA-TRANSFER-B", 50)];
    const fixtureRevision = (await get("/api/workspace")).revision;
    await executeHistoricalFixture(pool, fixtureRevision, `transfer-fixture-${randomUUID()}`, { type: "inventory.importBaseline", input: {
      fileName: "fictional-stock.xlsx", digest: "a".repeat(64), asOfDate: date, includeBaseline: true,
      packingBinTotal: null, annotations: [],
      orders: [{ fileName: "fictional-orders.xlsx", sheetName: "bulk order", digest: "b".repeat(64), asOfDate: date, rows }],
      items: [{ materialCode: "QA-FEED-TRANSFER", description: "Fictional transfer feed", unit: "MT", bagWeightKg: null,
        strategy: "mto", targetQuantity: 0, needsReview: false, opening: 0, production: 0, received: 0,
        salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: "", fmrOmed: "" }],
    } });
    const orders = (await get("/api/inventory/orders")).orders.sort((left: any, right: any) => left.doNo.localeCompare(right.doNo));
    const planned = await ok({ type: "job.createFromSources", input: {
      orders: orders.map((order: any, index: number) => ({ sourceOrderId: order.sourceOrderId, sourceOrderVersion: 1, plannedQuantity: index ? 50 : 40 })),
      date, lineId: "PM1", bin: "BIN", remarks: "Fictional grouped batch",
    } });
    return { date, orders, job: planned.state.jobs.find((candidate: any) => candidate.status === "pending") };
  }

  it("rolls back a held order, then conserves quantities through standalone and merge transfers with idempotent retry", async () => {
    const { orders, job } = await setup();
    await ok({ type: "data.setPlanningControl", sourceOrderId: orders[0].sourceOrderId, action: "hold", reason: "QA hold" });
    const heldBefore = await get("/api/workspace");
    const held = await post({ type: "job.transferOrder", jobId: job.id, sourceOrderId: orders[0].sourceOrderId, toLineId: "PM2" });
    assert.equal(held.status, 409);
    const heldAfter = await get("/api/workspace");
    assert.equal(heldAfter.revision, heldBefore.revision);
    assert.deepEqual(heldAfter.state.jobs, heldBefore.state.jobs);

    await ok({ type: "data.setPlanningControl", sourceOrderId: orders[0].sourceOrderId, action: "release", reason: "QA release" });
    const revision = (await get("/api/workspace")).revision;
    const command: Command = { type: "job.transferOrder", jobId: job.id, sourceOrderId: orders[0].sourceOrderId, toLineId: "PM2" };
    const commandId = randomUUID();
    const moved = await post(command, revision, commandId);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const retry = await post(command, revision, commandId);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.revision, moved.body.revision);
    const pending = moved.body.state.jobs.filter((candidate: any) => candidate.status === "pending");
    const source = pending.find((candidate: any) => candidate.id === job.id);
    const destination = pending.find((candidate: any) => candidate.id !== job.id);
    assert.equal(source.quantityMt, 50);
    assert.equal(destination.quantityMt, 40);
    assert.equal(source.quantityMt + destination.quantityMt, 90);

    const merged = await ok({ type: "job.transferOrder", jobId: source.id, sourceOrderId: orders[1].sourceOrderId, toLineId: "PM2", targetJobId: destination.id });
    assert.equal(merged.state.jobs.find((candidate: any) => candidate.id === source.id).status, "cancelled");
    const survivor = merged.state.jobs.find((candidate: any) => candidate.id === destination.id);
    assert.equal(survivor.quantityMt, 90);
    assert.deepEqual(survivor.sourceAllocations.map((value: any) => value.plannedQuantity).sort((a: number, b: number) => a - b), [40, 50]);
  });

  it("rejects stale persisted allocations and actual ledger movements without changing workspace state", async () => {
    const { date, orders, job } = await setup();
    const before = await get("/api/workspace");
    await pool.query("UPDATE job_source_allocations SET planned_quantity_scaled=planned_quantity_scaled+1000 WHERE job_id=$1 AND source_order_id=$2", [job.id, orders[0].sourceOrderId]);
    const stale = await post({ type: "job.transferOrder", jobId: job.id, sourceOrderId: orders[0].sourceOrderId, toLineId: "PM2" }, before.revision);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "SOURCE_ALLOCATION_CHANGED");
    assert.deepEqual((await get("/api/workspace")).state.jobs, before.state.jobs);
    await pool.query("UPDATE job_source_allocations SET planned_quantity_scaled=40000 WHERE job_id=$1 AND source_order_id=$2", [job.id, orders[0].sourceOrderId]);
    const item = await pool.query<{ item_id: string }>("SELECT item_id FROM inventory_orders WHERE source_order_id=$1", [orders[0].sourceOrderId]);
    await pool.query(`INSERT INTO inventory_ledger(id,workspace_id,item_id,medication,fmr_omed,movement_type,quantity_delta_scaled,occurred_on,recorded_at,posting_key,source_order_id,job_id,metadata)
      VALUES($1,1,$2,'','','production',1000,$3::date,now(),$4,$5,$6,'{}')`,
    [`ledger-${randomUUID()}`, item.rows[0].item_id, date, `posted-${randomUUID()}`, orders[0].sourceOrderId, job.id]);
    // Reading the externally inserted receipt can derive continuation metadata.
    // Compare against this post-fixture state, not the pre-receipt projection.
    const postedBefore = await get("/api/workspace");
    const posted = await post({ type: "job.transferOrder", jobId: job.id, sourceOrderId: orders[0].sourceOrderId, toLineId: "PM2" }, before.revision);
    assert.equal(posted.status, 409);
    assert.equal(posted.body.error.code, "POSTED_JOB_IMMUTABLE");
    const after = await get("/api/workspace");
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.state.jobs, postedBefore.state.jobs);
  });
});
