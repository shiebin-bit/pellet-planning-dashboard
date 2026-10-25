import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../server/app";
import { runMigrations } from "../server/migrate";
import { WorkspaceStore } from "../server/store";
import { createDefaultSettings } from "../src/domain/defaults";
import type { InventoryDraftJob, InventoryOrderProgressSnapshot, InventorySnapshot, InventoryWorkbookInput } from "../src/domain/inventoryTypes";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("inventory API", () => {
  let pool: pg.Pool;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    assertDedicatedTestDatabase(databaseUrl!, process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
    await runMigrations(pool);
    const store = new WorkspaceStore(pool);
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
    server.removeAllListeners("request");
    server.on("request", createApp({ store, hostPorts: new Set([address.port]), distDir: "Z:\\missing", allowedOrigins: new Set([`http://127.0.0.1:${address.port}`]) }));
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE command_receipts, history_events, jobs, workspace CASCADE");
    await new WorkspaceStore(pool).initialize(createDefaultSettings());
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
  });

  it("uses exact stock reservation arithmetic and counts an MTS target once", async () => {
    const first = await command(0, "baseline-one", { type: "inventory.importBaseline", input: baselineInput() });
    assert.equal(first.status, 200);

    let stock = await get<InventorySnapshot>("/api/inventory");
    assert.equal(stock.baselineDate, "2026-10-18");
    assert.equal(stock.items[0].totalOnHand, 30);
    assert.equal(stock.items[0].totalReserved, 30);
    assert.equal(stock.items[0].totalAvailable, 0);
    const orders = await get<InventoryOrderProgressSnapshot>("/api/inventory/orders");
    assert.equal(orders.orders[0].ordered, 100);
    assert.equal(orders.orders[0].reserved, 30);
    assert.equal(orders.orders[0].orderNeed, 70);

    const draftResponse = await fetch(`${baseUrl}/api/inventory/draft`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ fromDate: malaysiaToday(), toDate: addDays(malaysiaToday(), 3) }),
    });
    assert.equal(draftResponse.status, 200);
    const draft = await draftResponse.json();
    assert.equal(draft.demand.filter((row: any) => row.purpose === "mto").reduce((n: number, row: any) => n + row.quantity, 0), 70);
    assert.equal(draft.demand.filter((row: any) => row.purpose === "mts").reduce((n: number, row: any) => n + row.quantity, 0), 20);
    assert.equal(draft.demand.reduce((n: number, row: any) => n + row.quantity, 0), 90);

    const retry = await command(0, "baseline-one", { type: "inventory.importBaseline", input: baselineInput() });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).revision, 1);
    const semanticDuplicate = await command(1, "baseline-two", { type: "inventory.importBaseline", input: baselineInput() });
    assert.equal(semanticDuplicate.status, 200);
    stock = await get<InventorySnapshot>("/api/inventory");
    assert.equal(stock.items[0].totalOnHand, 30);
    assert.equal((await get<any[]>("/api/inventory/ledger")).filter(row => row.movementType === "baseline").length, 1);

    const backup = await get<any>("/api/backup");
    assert.equal(backup.schemaVersion, 4);
    assert.equal(backup.inventory.items.length, 1);
    assert.equal(backup.inventory.ledger.length, 1);
    await ok(await command(2, "reset-after-backup", { type: "workspace.resetDemo", date: malaysiaToday() }));
    assert.equal((await get<InventorySnapshot>("/api/inventory")).items.length, 0);
    const previous = await get<any>("/api/backup/previous");
    assert.equal(previous.schemaVersion, 4);
    assert.equal(previous.inventory.ledger.length, 1);
    await ok(await command(3, "restore-v4", { type: "workspace.restore", backup }));
    const restored = await get<InventorySnapshot>("/api/inventory");
    assert.equal(restored.items[0].totalOnHand, 30);
    assert.equal(restored.items[0].totalReserved, 30);
  });

  it("supports multiple production receipts, partial dispatch, reversals, and free overproduction", async () => {
    await ok(await command(0, "seed-flow", { type: "inventory.importBaseline", input: baselineInput() }));
    const progress = await get<InventoryOrderProgressSnapshot>("/api/inventory/orders");
    const stock = await get<InventorySnapshot>("/api/inventory");
    const order = progress.orders[0];
    const draftJob = manualDraftJob(order.sourceOrderId, stock.items[0].itemId, 70);
    const committed = await json(await command(1, "commit-one", { type: "planning.commitDraft", previewRevision: 1, jobs: [draftJob] }));
    const jobId = committed.state.jobs[0].id;

    await ok(await command(2, "receipt-20", { type: "production.recordReceipt", jobId, totalActualQuantity: 20 }));
    await ok(await command(3, "receipt-30", { type: "production.recordReceipt", jobId, totalActualQuantity: 30 }));
    let orderState = (await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    assert.equal(orderState.produced, 30);
    assert.equal(orderState.scheduledUnreceived, 40);

    await ok(await command(4, "dispatch-30", { type: "delivery.record", sourceOrderId: order.sourceOrderId, quantity: 30, postingKey: "dispatch-30" }));
    const duplicate = await command(5, "dispatch-30-again", { type: "delivery.record", sourceOrderId: order.sourceOrderId, quantity: 30, postingKey: "dispatch-30" });
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    orderState = (await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    assert.equal(orderState.delivered, 30);
    assert.equal((await get<any[]>("/api/inventory/ledger")).filter(row => row.movementType === "dispatch").length, 1);

    const beforeInvalid = await get<any>("/api/workspace");
    const invalid = await command(beforeInvalid.revision, "dispatch-too-much", { type: "delivery.record", sourceOrderId: order.sourceOrderId, quantity: 40, postingKey: "too-much" });
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).error.code, "DELIVERY_NOT_RESERVED");
    assert.equal((await get<any>("/api/workspace")).revision, beforeInvalid.revision);

    await ok(await command(beforeInvalid.revision, "receipt-80", { type: "production.recordReceipt", jobId, totalActualQuantity: 80 }));
    let latest = await get<InventorySnapshot>("/api/inventory");
    assert.equal(latest.items[0].totalOnHand, 80);
    assert.equal(latest.items[0].totalReserved, 70);
    assert.equal(latest.items[0].totalAvailable, 10);

    const dispatchMovement = (await get<any[]>("/api/inventory/ledger")).find(row => row.movementType === "dispatch");
    const revision = (await get<any>("/api/workspace")).revision;
    await ok(await command(revision, "reverse-ten", { type: "delivery.reverse", movementId: dispatchMovement.id, quantity: 10, reason: "Customer reduced pickup", postingKey: "reverse-ten" }));
    latest = await get<InventorySnapshot>("/api/inventory");
    assert.equal(latest.items[0].totalOnHand, 90);
    assert.equal(latest.items[0].totalReserved, 80);
    assert.equal(latest.items[0].totalAvailable, 10);
    assert.equal((await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0].delivered, 20);

    const backup = await get<any>("/api/backup");
    const currentRevision = (await get<any>("/api/workspace")).revision;
    await ok(await command(currentRevision, "reset-flow", { type: "workspace.resetDemo", date: malaysiaToday() }));
    await ok(await command(currentRevision + 1, "restore-flow", { type: "workspace.restore", backup }));
    const roundTrip = (await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    assert.equal(roundTrip.produced, 80);
    assert.equal(roundTrip.delivered, 20);
    assert.equal((await get<InventorySnapshot>("/api/inventory")).items[0].totalAvailable, 10);
  });

  it("serializes concurrent receipt totals, deduplicates retries, and rolls invalid stock back", async () => {
    await ok(await command(0, "seed-concurrency", { type: "inventory.importBaseline", input: baselineInput() }));
    const order = (await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    const item = (await get<InventorySnapshot>("/api/inventory")).items[0];
    const committed = await json(await command(1, "commit-concurrency", { type: "planning.commitDraft", previewRevision: 1, jobs: [manualDraftJob(order.sourceOrderId, item.itemId, 70)] }));
    const jobId = committed.state.jobs[0].id;
    const [a, b] = await Promise.all([
      command(2, "receipt-concurrent-a", { type: "production.recordReceipt", jobId, totalActualQuantity: 10 }),
      command(2, "receipt-concurrent-b", { type: "production.recordReceipt", jobId, totalActualQuantity: 20 }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winnerId = a.status === 200 ? "receipt-concurrent-a" : "receipt-concurrent-b";
    const winnerTotal = a.status === 200 ? 10 : 20;
    const retry = await command(2, winnerId, { type: "production.recordReceipt", jobId, totalActualQuantity: winnerTotal });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).revision, 3);
    assert.equal((await get<any[]>("/api/inventory/ledger")).filter(row => row.movementType === "production").length, 1);

    const invalid = await command(3, "negative-adjustment", { type: "inventory.adjust", itemId: item.itemId, medication: "", fmrOmed: "", quantityDelta: -1000, reason: "Impossible", postingKey: "negative" });
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).error.code, "NEGATIVE_PHYSICAL_STOCK");
    assert.equal((await get<any>("/api/workspace")).revision, 3);
    assert.equal((await get<any[]>("/api/inventory/ledger")).some(row => row.note === "Impossible"), false);
    const future=await command(3,"future-receipt",{type:"inventory.receive",itemId:item.itemId,medication:"",fmrOmed:"",quantity:1,occurredOn:addDays(malaysiaToday(),1),postingKey:"future-receipt"});
    assert.equal(future.status,400);assert.equal((await future.json()).error.code,"FUTURE_PHYSICAL_MOVEMENT");
    assert.equal((await get<any>("/api/workspace")).revision,3);
  });

  it("corrects cumulative output, releases completed shortages and can receive the same total after a correction",async()=>{
    await ok(await command(0,"seed-correction",{type:"inventory.importBaseline",input:baselineInput()}));
    const order=(await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0],item=(await get<InventorySnapshot>("/api/inventory")).items[0];
    const committed=await json(await command(1,"plan-correction",{type:"planning.commitDraft",previewRevision:1,jobs:[manualDraftJob(order.sourceOrderId,item.itemId,70)]}));
    const jobId=committed.state.jobs[0].id;
    await ok(await command(2,"receipt-c20",{type:"production.recordReceipt",jobId,totalActualQuantity:20}));
    await ok(await command(3,"receipt-c30",{type:"production.recordReceipt",jobId,totalActualQuantity:30}));
    const receipt=(await get<any[]>("/api/inventory/ledger")).find(row=>row.movementType==="production"&&row.quantityDelta===10);
    const correction={type:"production.correct",movementId:receipt.id,correctedTotalQuantity:25,reason:"Correct cumulative total",postingKey:"cumulative-correction"};
    await ok(await command(4,"correction25",correction));
    assert.equal((await get<any>(`/api/inventory/jobs/${jobId}/production`)).total,25);
    assert.equal((await get<InventorySnapshot>("/api/inventory")).items[0].totalOnHand,55);
    await ok(await command(5,"correction25-retry",correction));
    await ok(await command(6,"receive-30-again",{type:"production.recordReceipt",jobId,totalActualQuantity:30}));
    assert.equal((await get<InventorySnapshot>("/api/inventory")).items[0].totalOnHand,60);
    const backup=await get<any>("/api/backup");await ok(await command(7,"restore-corrections",{type:"workspace.restore",backup}));
    await ok(await command(8,"start-short",{type:"job.start",jobId}));
    await ok(await command(9,"complete-short",{type:"job.complete",jobId,actualQuantityMt:35}));
    const progress=(await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    assert.equal(progress.scheduledUnreceived,0);assert.equal(progress.netToPlan,35);assert.equal(progress.produced,35);
  });

  it("keeps historical DONE/OUT separate from postings and preserves manual policies on later imports",async()=>{
    const input=baselineInput();input.items[0].production=5;input.items[0].rework=5;
    input.annotations=[{doNo:"DO-100",materialCode:"7.100",remark:"DONE",medication:"",fmrOmed:""}];
    await ok(await command(0,"seed-history",{type:"inventory.importBaseline",input}));
    let progress=(await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    assert.equal(progress.orderNeed,0);assert.equal(progress.needsReview,true);
    const draft=await postDraft();assert.equal(draft.demand.filter((row:any)=>row.purpose==="mto").length,0);
    const daily=await get<any[]>("/api/inventory/daily?date=2026-10-18");assert.equal(daily[0].opening,30);assert.equal(daily[0].production,5);assert.equal(daily[0].rework,5);assert.equal(daily[0].closing,30);
    const item=(await get<InventorySnapshot>("/api/inventory")).items[0];
    await ok(await command(1,"configure-extra",{type:"inventory.configure",itemId:item.itemId,patch:{targetQuantity:45,defaultExtra:{type:"fixed",quantity:20}}}));
    await ok(await command(2,"manual-med",{type:"data.updateManualFields",sourceOrderId:progress.sourceOrderId,patch:{medication:"MED-A",fmrOmed:"REF-1"}}));
    const later={...input,includeBaseline:false,digest:"c".repeat(64),annotations:[],orders:input.orders.map(batch=>({...batch,digest:"d".repeat(64),rows:batch.rows.map(row=>({...row,remark:"OUT"}))}))};
    await ok(await command(3,"later-workbook",{type:"inventory.importWorkbook",input:later}));
    const updated=(await get<InventorySnapshot>("/api/inventory")).items[0];assert.equal(updated.targetQuantity,45);assert.equal(updated.totalOnHand,30);
    progress=(await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];assert.equal(progress.medication,"MED-A");assert.equal(progress.fmrOmed,"REF-1");assert.equal(progress.delivered,0);
    assert.equal((await get<any[]>("/api/inventory/ledger")).length,1);
  });

  it("counts overproduction once per compatible bucket and confirms later physical count differences",async()=>{
    await ok(await command(0,"seed-extra",{type:"inventory.importBaseline",input:baselineInput()}));
    const item=(await get<InventorySnapshot>("/api/inventory")).items[0];
    await ok(await command(1,"extra-twenty",{type:"inventory.configure",itemId:item.itemId,patch:{defaultExtra:{type:"fixed",quantity:20}}}));
    const draft=await postDraft();assert.equal(draft.demand.reduce((sum:number,row:any)=>sum+row.quantity,0),90);assert.equal(draft.demand.filter((row:any)=>row.purpose==="mts").length,0);
    const count=baselineInput();count.includeBaseline=false;count.reconcileStock=true;count.asOfDate="2026-10-19";count.items[0].opening=35;count.items[0].closing=35;
    await ok(await command(2,"physical-count",{type:"inventory.importWorkbook",input:count}));
    const ledger=await get<any[]>("/api/inventory/ledger");assert.equal(ledger.filter(row=>row.movementType==="adjustment")[0].quantityDelta,5);
    const stock=await get<InventorySnapshot>("/api/inventory");assert.equal(stock.items[0].totalOnHand,35);assert.equal(stock.lastCountDate,"2026-10-19");assert.equal(stock.baselineDate,"2026-10-18");
    await ok(await command(3,"same-count",{type:"inventory.importWorkbook",input:count}));assert.equal((await get<InventorySnapshot>("/api/inventory")).items[0].totalOnHand,35);
  });

  it("records OUT only after the final pickup, reopens on reversal and deduplicates full pickup retries",async()=>{
    const input=baselineInput();input.items[0].opening=100;input.items[0].closing=100;
    await ok(await command(0,"seed-pickup",{type:"inventory.importBaseline",input}));
    const order=(await get<InventoryOrderProgressSnapshot>("/api/inventory/orders")).orders[0];
    const delivery={type:"delivery.record",sourceOrderId:order.sourceOrderId,quantity:100,postingKey:"full-pickup"};
    await ok(await command(1,"full-pickup",delivery));await ok(await command(2,"full-pickup-retry",delivery));
    assert.equal((await get<any>("/api/data")).items[0].deliveryStatus,"delivered");
    const movement=(await get<any[]>("/api/inventory/ledger")).find(row=>row.movementType==="dispatch");
    const reverse={type:"delivery.reverse",movementId:movement.id,quantity:100,reason:"Wrong pickup",postingKey:"full-reversal"};
    await ok(await command(3,"reverse-full",reverse));await ok(await command(4,"reverse-full-retry",reverse));
    assert.equal((await get<any>("/api/data")).items[0].deliveryStatus,"pending");
    assert.equal((await get<InventorySnapshot>("/api/inventory")).items[0].totalOnHand,100);
    const bypass=await command(5,"legacy-bypass",{type:"data.setDeliveryStatus",sourceOrderId:order.sourceOrderId,delivered:true});assert.equal(bypass.status,409);
  });

  async function postDraft():Promise<any>{const response=await fetch(`${baseUrl}/api/inventory/draft`,{method:"POST",headers:{"Content-Type":"application/json",Origin:baseUrl},body:JSON.stringify({fromDate:addDays(malaysiaToday(),1),toDate:addDays(malaysiaToday(),3)})});return json(response);}
  async function command(expectedRevision: number, commandId: string, value: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify({ expectedRevision, commandId, command: value }) });
  }
  async function get<T>(path: string): Promise<T> { const response = await fetch(`${baseUrl}${path}`); assert.equal(response.status, 200); return response.json() as Promise<T>; }
});

function baselineInput(): InventoryWorkbookInput {
  return {
    fileName: "18th.xlsx", digest: "a".repeat(64), asOfDate: "2026-10-18", includeBaseline: true, packingBinTotal: 42.123,
    orders: [{ fileName: "18th.xlsx", sheetName: "bulk order", digest: "b".repeat(64), asOfDate: "2026-10-18", rows: [{
      goodsMovementStatus: "", sourceSheet: "bulk order", sourceRow: 2, doNo: "DO-100", deliveryDate: addDays(malaysiaToday(), 1),
      soldToParty: "Customer", shipToParty: "Farm", materialCode: "7.100", description: "Test bulk feed", quantity: 100,
      unit: "MT", deliveryLeadDays: 1, remark: "", daysOutstanding: 0, medication: "", fmrOmed: "",
    }] }],
    items: [{ materialCode: "7.100", description: "Test bulk feed", unit: "MT", bagWeightKg: null, strategy: "mts", targetQuantity: 20,
      needsReview: false, opening: 30, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 30, medication: "", fmrOmed: "" }],
    annotations: [],
  };
}

function manualDraftJob(sourceOrderId: string, itemId: string, quantity: number): InventoryDraftJob {
  const date = addDays(malaysiaToday(), 1);
  return { draftId: "manual-one", itemId, sourceOrderId, orderNo: "DO-100", materialCode: "7.100", description: "Test bulk feed",
    unit: "MT", bagWeightKg: null, productionPurpose: "mto", date, lineId: "PM1", quantity,
    notBefore: `${date}T00:00:00.000Z`, bin: "", remarks: "", medication: "", fmrOmed: "" };
}

async function ok(response: Response): Promise<void> { assert.equal(response.status, 200, await response.text()); }
async function json(response: Response): Promise<any> { assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
function malaysiaToday(): string { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const get=(type:string)=>parts.find(part=>part.type===type)?.value??""; return `${get("year")}-${get("month")}-${get("day")}`; }
function addDays(date:string,days:number):string{const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
function assertDedicatedTestDatabase(testValue: string, productionValue: string | undefined): void { const test = new URL(testValue); if (!/(^|[-_])test(?:[-_]|$)/i.test(test.pathname.slice(1))) throw new Error("TEST_DATABASE_URL must name a dedicated test database."); if (productionValue) { const production = new URL(productionValue); if (test.hostname===production.hostname&&(test.port||"5432")===(production.port||"5432")&&test.pathname===production.pathname) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL."); } }
