import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../server/app";
import { runMigrations } from "../server/migrate";
import { WorkspaceStore } from "../server/store";
import { createDefaultSettings } from "../src/domain/defaults";
import type { OperationsSummary } from "../src/domain/operationsSummary";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("operations summary API", () => {
  let pool: pg.Pool, server: Server, baseUrl: string;

  before(async () => {
    assertDedicatedTestDatabase(databaseUrl!, process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
    await runMigrations(pool);
    const store = new WorkspaceStore(pool);
    server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
    server.removeAllListeners("request");
    server.on("request", createApp({ store, hostPorts: new Set([address.port]), distDir: "Z:\\missing", allowedOrigins: new Set([`http://127.0.0.1:${address.port}`]) }));
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => { await pool.query("TRUNCATE command_receipts, history_events, jobs, workspace CASCADE"); await new WorkspaceStore(pool).initialize(createDefaultSettings()); });
  after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (pool) await pool.end(); });

  it("returns the strict empty contract and rejects every query parameter", async () => {
    const rejected = await fetch(`${baseUrl}/api/operations-summary?extra=true`);
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error.code, "INVALID_REQUEST");
    const value = await get<OperationsSummary>("/api/operations-summary");
    assert.deepEqual(Object.keys(value), ["revision", "serverNow", "asOfDate", "dueSoonThrough", "counts", "freshness"]);
    assert.equal(value.revision, 0); assert.equal(value.dueSoonThrough, addDays(value.asOfDate, 3));
    assert.deepEqual(value.counts, { overdueToPlan: 0, dueSoon: 0, stockShortages: 0, pendingImportReviews: 0 });
    assert.deepEqual(value.freshness, { latestOrderImport: null, newestExcelAsOfDate: null, inventoryBaselineDate: null, lastVerifiedStockCountDate: null });
  });

  it("counts all destination rows and isolates standard MTS stock and freshness without writes", async () => {
    const clock = await get<OperationsSummary>("/api/operations-summary"), today = clock.asOfDate;
    const yesterday = addDays(today, -1), through = addDays(today, 3), baseline = addDays(today, -10), newestExcel = addDays(today, -2), verified = addDays(today, -1);
    await pool.query("UPDATE workspace SET revision=42 WHERE id=1");
    await pool.query(`INSERT INTO source_imports(id,workspace_id,file_name,sheet_name,digest,semantic_digest,as_of_date,row_count,imported_at) VALUES
      ('newest-excel',1,'new.xlsx','orders','d-new','s-new',$1,0,'2026-10-01T01:00:00Z'),
      ('latest-upload',1,'old.xlsx','orders','d-old','s-old',$2,0,'2026-10-02T01:00:00Z')`, [newestExcel, baseline]);
    for (let index = 0; index < 55; index++) await insertOrder(`due-${index}`, index % 2 ? through : today);
    await insertOrder("after-window", addDays(through, 1)); await insertOrder("due-delivered", today, true);
    for (const key of ["missing", "partial", "fully-planned", "stock-covered"]) await insertOrder(key, yesterday);
    await insertOrder("overdue-delivered", yesterday, true);
    await seedInventory(baseline, newestExcel, verified, today);
    await track("partial", 30_000, 50_000, 0); await track("fully-planned", 30_000, 70_000, 1); await track("stock-covered", 100_000, 0, 2);
    const candidate = fields("missing", yesterday);
    for (let index = 0; index < 2; index++) await pool.query(`INSERT INTO source_order_discrepancies(id,workspace_id,source_order_id,import_id,observed_source_version,candidate_fields,candidate_hash,changed_fields,status,created_at)
      VALUES($1,1,'source-missing','newest-excel',1,$2,$3,'["quantity"]','pending','2026-10-02T01:00:00Z')`, [`review-${index}`, { ...candidate, quantity: 101 + index }, `candidate-${index}`]);

    const before = await fingerprint(), summary = await get<OperationsSummary>("/api/operations-summary"), after = await fingerprint();
    assert.deepEqual(after, before, "read-only summary changed persisted state");
    const overdue = await get<{ total: number }>(`/api/data?view=needs-production&deliveryTo=${yesterday}`);
    const due = await get<{ total: number; items: unknown[] }>(`/api/data?deliveryStatus=pending&deliveryFrom=${today}&deliveryTo=${through}`);
    assert.equal(summary.revision, 42); assert.equal(summary.dueSoonThrough, through);
    assert.equal(summary.counts.overdueToPlan, 2); assert.equal(summary.counts.overdueToPlan, overdue.total);
    assert.equal(summary.counts.dueSoon, 55); assert.equal(summary.counts.dueSoon, due.total); assert.equal(due.items.length, 50);
    assert.equal(summary.counts.stockShortages, 2); assert.equal(summary.counts.pendingImportReviews, 2);
    assert.deepEqual(summary.freshness, { latestOrderImport: { asOfDate: baseline, importedAt: "2026-10-02T01:00:00.000Z" }, newestExcelAsOfDate: newestExcel, inventoryBaselineDate: baseline, lastVerifiedStockCountDate: verified });
  });

  async function insertOrder(key: string, date: string, delivered = false) {
    const value = fields(key, date);
    await pool.query(`INSERT INTO source_orders(id,workspace_id,do_no,material_code,latest_version,latest_import_id,delivery_status,delivery_source,delivery_recorded_at,needs_review,updated_at)
      VALUES($1,1,$2,$3,1,'latest-upload',$4,$5,$6,false,'2026-10-02T01:00:00Z')`, [`source-${key}`, value.doNo, value.materialCode, delivered ? "delivered" : "pending", delivered ? "manual" : null, delivered ? "2026-10-02T02:00:00Z" : null]);
    await pool.query(`INSERT INTO source_order_versions(source_order_id,version,import_id,fields,content_hash,created_at) VALUES($1,1,'latest-upload',$2,$3,'2026-10-02T01:00:00Z')`, [`source-${key}`, value, `hash-${key}`]);
  }

  async function seedInventory(baseline: string, countDate: string, verified: string, today: string) {
    for (const [id, material, strategy, target] of [["order-item","ORDER","mto",null],["epsilon","MT-0.001","mts",1000],["variant","VARIANT","mts",1000],["adequate","ADEQUATE","mts",1000],["mto","MTO","mto",1000],["null-target","NULL","mts",null]] as const) {
      await pool.query(`INSERT INTO inventory_items(id,workspace_id,material_code,description,unit,strategy,target_quantity_scaled,needs_review,created_at,updated_at) VALUES($1,1,$2,$2,'MT',$3,$4,false,$5,$5)`, [id, material, strategy, target, `${today}T00:00:00Z`]);
    }
    await pool.query(`INSERT INTO inventory_imports(id,workspace_id,file_name,digest,semantic_digest,as_of_date,included_baseline,imported_at) VALUES
      ('baseline',1,'baseline.xlsx','ibd','ibs',$1,true,$3),('count',1,'count.xlsx','icd','ics',$2,false,$3)`, [baseline, countDate, `${today}T00:00:00Z`]);
    await pool.query(`INSERT INTO inventory_baseline_reports(import_id,item_id,medication,fmr_omed,opening_scaled,production_scaled,received_scaled,sales_return_scaled,rework_scaled,issue_scaled,closing_scaled) VALUES
      ('baseline','order-item','','',0,0,0,0,0,0,0),('count','order-item','','',0,0,0,0,0,0,0)`);
    await pool.query(`INSERT INTO inventory_ledger(id,workspace_id,item_id,medication,fmr_omed,movement_type,quantity_delta_scaled,occurred_on,recorded_at,posting_key,metadata) VALUES
      ('eps',1,'epsilon','','','baseline',999,$1,$3,'eps','{}'),('variant',1,'variant','MED','FMR','baseline',5000,$1,$3,'variant','{}'),
      ('adequate',1,'adequate','','','baseline',1000,$1,$3,'adequate','{}'),('mto',1,'mto','','','baseline',1,$1,$3,'mto','{}'),
      ('verified',1,'adequate','','','adjustment',1,$2,$3,'verified','{"physicalCount":"true"}')`, [baseline, verified, `${today}T00:00:00Z`]);
  }

  async function track(key: string, reserved: number, scheduled: number, ordinal: number) {
    await pool.query(`INSERT INTO inventory_orders(source_order_id,workspace_id,item_id,due_date,ordered_quantity_scaled,historical_status,created_at,updated_at)
      SELECT $1,1,'order-item',(fields->>'deliveryDate')::date,100000,'pending','2026-10-02T01:00:00Z','2026-10-02T01:00:00Z' FROM source_order_versions WHERE source_order_id=$1 AND version=1`, [`source-${key}`]);
    if (reserved) await pool.query(`INSERT INTO inventory_reservations(source_order_id,item_id,quantity_scaled,updated_at) VALUES($1,'order-item',$2,'2026-10-02T01:00:00Z')`, [`source-${key}`, reserved]);
    if (scheduled) {
      const job = `job-${key}`; await pool.query(`INSERT INTO jobs(workspace_id,id,ordinal,planning_date,line_id,sequence,status,payload) VALUES(1,$1,$2,'2026-10-03','PM1',0,'pending','{}')`, [job, ordinal]);
      await pool.query(`INSERT INTO job_source_allocations(job_id,source_order_id,ordinal,planned_quantity_scaled,source_order_version,source_snapshot)
        SELECT $1,$2,0,$3,1,fields FROM source_order_versions WHERE source_order_id=$2 AND version=1`, [job, `source-${key}`, scheduled]);
    }
  }
  async function fingerprint() { return (await pool.query(`SELECT (SELECT revision::text FROM workspace WHERE id=1) revision,(SELECT count(*)::text FROM source_orders) orders,(SELECT count(*)::text FROM source_order_discrepancies) reviews,(SELECT count(*)::text FROM inventory_ledger) ledger,(SELECT count(*)::text FROM jobs) jobs`)).rows[0]; }
  async function get<T>(path: string): Promise<T> { const response = await fetch(`${baseUrl}${path}`); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>; }
});

function fields(key: string, deliveryDate: string) { return { goodsMovementStatus:"",sourceSheet:"orders",sourceRow:2,doNo:`DO-${key}`,deliveryDate,soldToParty:"Private",shipToParty:"Private",materialCode:`MAT-${key}`,description:"Feed",quantity:100,unit:"MT",deliveryLeadDays:null,remark:"",daysOutstanding:null,medication:"",fmrOmed:"" }; }
function addDays(date: string, days: number) { const result = new Date(`${date}T12:00:00Z`); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10); }
function assertDedicatedTestDatabase(testValue: string, productionValue?: string) { const test = new URL(testValue); if (!/(^|[-_])test(?:[-_]|$)/i.test(test.pathname.slice(1))) throw new Error("TEST_DATABASE_URL must name a dedicated test database."); if (productionValue) { const production = new URL(productionValue); if (test.hostname===production.hostname&&(test.port||"5432")===(production.port||"5432")&&test.pathname===production.pathname) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL."); } }
