import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { createApp } from '../server/app';
import { runMigrations } from '../server/migrate';
import { WorkspaceStore } from '../server/store';
import { createDefaultSettings } from '../src/domain/defaults';
import type { DailyReportInput } from '../src/domain/dailyImport';
import { validatePortableBackupV6 } from '../server/sourceBackup';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration=databaseUrl?describe:describe.skip;

integration('dated daily import API',()=>{
  let pool:pg.Pool,server:Server,baseUrl:string;
  before(async()=>{
    assertDedicated(databaseUrl!,process.env.DATABASE_URL);
    pool=new pg.Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});await runMigrations(pool);
    const store=new WorkspaceStore(pool);server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const address=server.address();if(!address||typeof address==='string')throw new Error('missing test port');server.removeAllListeners('request');
    baseUrl=`http://127.0.0.1:${address.port}`;server.on('request',createApp({store,hostPorts:new Set([address.port]),distDir:'Z:\\missing',allowedOrigins:new Set([baseUrl])}));
  });
  beforeEach(async()=>{await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');await new WorkspaceStore(pool).initialize(createDefaultSettings())});
  after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end()});

  it('stores raw observations, builds anonymous stock history and keeps planning controls separate',async()=>{
    const reports=[report('2026-10-26',30,10,5,35,[order('A','',100),order('MISSING','',10)]),report('2026-10-27',35,5,10,30,[order('A','DONE',100),order('H','HOLD',20),order('C','CANCEL',20)])];
    const preview=await json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports})}));
    assert.equal(preview.newOrders,4);assert.equal(preview.existingOrders,0);assert.equal(preview.requiresReconcile,false);assert.deepEqual(preview.formulaDifferences,[]);assert.deepEqual(preview.continuityDifferences,[]);
    const applied=await command(0,'daily-import',{type:'inventory.importDailyReports',reports,reconcile:false,reason:''});assert.equal(applied.status,200,await applied.clone().text());
    const envelope=await applied.json();assert.equal(envelope.state.jobs.length,0);
    const inventory=await get('/api/inventory');assert.equal(inventory.items[0].totalOnHand,30);assert.equal(inventory.baselineDate,'2026-10-26');
    const progress=await get('/api/inventory/orders');const byDo=new Map(progress.orders.map((row:any)=>[row.doNo,row]));
    assert.equal(byDo.get('A').historicalStatus,'done');assert.equal(byDo.get('A').planningControl,'active');
    assert.equal(byDo.get('H').planningControl,'hold');assert.equal(byDo.get('C').planningControl,'cancel');assert.equal(byDo.get('MISSING').planningControl,'review');
    assert.equal((await get(`/api/data/${encodeURIComponent(byDo.get('A').sourceOrderId)}/observations`)).length,2);
    const anonymous=await pool.query("SELECT count(*)::integer count FROM inventory_ledger WHERE source_order_id IS NULL AND job_id IS NULL");assert.ok(anonymous.rows[0].count>=5);
    const backup=await get('/api/backup');assert.equal(backup.schemaVersion,6);assert.equal(backup.baselineHistory.observations.length,5);assert.equal(backup.baselineHistory.inventoryImports.length,2);validatePortableBackupV6(backup);
    assert.equal((await command(1,'daily-reset',{type:'workspace.resetDemo',date:'2026-11-16'})).status,200);
    const restored=await command(2,'daily-restore',{type:'workspace.restore',backup});assert.equal(restored.status,200,await restored.clone().text());
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,30);
    assert.equal((await get(`/api/data/${encodeURIComponent(byDo.get('A').sourceOrderId)}/observations`)).length,2);
  });

  it('rejects an unconfirmed formula difference and never replays a same-day report',async()=>{
    const bad=report('2026-10-26',30,10,5,34,[order('A','',100)]);
    const preview=await json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports:[bad]})}));assert.equal(preview.requiresReconcile,true);
    const rejected=await command(0,'bad-unconfirmed',{type:'inventory.importDailyReports',reports:[bad],reconcile:false,reason:''});assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'DAILY_REPORT_RECONCILIATION_REQUIRED');
    const accepted=await command(0,'bad-confirmed',{type:'inventory.importDailyReports',reports:[bad],reconcile:true,reason:'Confirmed physical Closing'});assert.equal(accepted.status,200,await accepted.clone().text());
    const changed={...bad,digest:digest('changed')};const conflict=await command(1,'same-date-conflict',{type:'inventory.importDailyReports',reports:[changed],reconcile:true,reason:'Changed copy'});assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'DAILY_REPORT_DATE_CONFLICT');
    assert.equal(Number((await pool.query("SELECT count(*) count FROM inventory_ledger")).rows[0].count),4);
  });

  it('folds dated status history without inventing actual production and older files cannot regress a manual release',async()=>{
    const reports=[
      report('2026-10-26',0,0,0,0,[order('DONE-STICKY','DONE',100),order('OUT-STICKY','OUT',10),order('CANCEL-STICKY','CANCEL',20),order('HOLD-STICKY','HOLD',20),order('UNKNOWN','CHECK',20),order('ABSENT','',20)]),
      report('2026-10-27',0,0,0,0,[order('DONE-STICKY','',120),order('OUT-STICKY','',10),order('CANCEL-STICKY','',20),order('HOLD-STICKY','',20),order('UNKNOWN','',20)]),
    ];
    await ok(await command(0,'status-fold',{type:'inventory.importDailyReports',reports,reconcile:false,reason:''}));
    let progress=await get('/api/inventory/orders'),byDo=new Map(progress.orders.map((row:any)=>[row.doNo,row]));
    assert.deepEqual({status:byDo.get('DONE-STICKY').historicalStatus,control:byDo.get('DONE-STICKY').planningControl,ordered:byDo.get('DONE-STICKY').ordered,produced:byDo.get('DONE-STICKY').produced},{status:'done',control:'review',ordered:120,produced:0});
    assert.equal(byDo.get('CANCEL-STICKY').planningControl,'cancel');assert.equal(byDo.get('HOLD-STICKY').planningControl,'hold');assert.equal(byDo.get('UNKNOWN').planningControl,'review');assert.equal(byDo.get('ABSENT').planningControl,'review');
    const source=await get(`/api/data/${encodeURIComponent(byDo.get('DONE-STICKY').sourceOrderId)}`);assert.equal(source.quantity,120);assert.equal(source.version,2);
    const outSource=await get(`/api/data/${encodeURIComponent(byDo.get('OUT-STICKY').sourceOrderId)}`);assert.equal(outSource.deliveryStatus,'delivered');assert.equal(outSource.deliveryRecordedAt,null);assert.equal(outSource.currentDaysOutstanding,0);
    await ok(await command(1,'release-cancel',{type:'data.setPlanningControl',sourceOrderId:byDo.get('CANCEL-STICKY').sourceOrderId,action:'release',reason:'Planner verified it is pending'}));
    await ok(await command(2,'duplicate-after-release',{type:'inventory.importDailyReports',reports,reconcile:false,reason:''}));
    const older=report('2026-10-25',0,0,0,0,[order('CANCEL-STICKY','CANCEL',10)]);await ok(await command(3,'older-after-release',{type:'inventory.importDailyReports',reports:[older],reconcile:false,reason:''}));
    progress=await get('/api/inventory/orders');byDo=new Map(progress.orders.map((row:any)=>[row.doNo,row]));assert.equal(byDo.get('CANCEL-STICKY').planningControl,'active');assert.equal(byDo.get('CANCEL-STICKY').ordered,20);
  });

  it('quarantines only newly seen overdue SAP orders through both import commands',async()=>{
    const stale={fileName:'bag order.xlsx',sheetName:'bag order',digest:digest('stale-batch'),asOfDate:'2026-10-30',rows:[{...order('STALE-1','',10),deliveryDate:'2026-10-20'}]};
    await ok(await command(0,'stale-batch',{type:'data.importBatch',inputs:[stale]}));
    let progress=await get('/api/inventory/orders');assert.equal(progress.orders[0].planningControl,'review');assert.equal(progress.orders[0].reserved,0);
    const normal={...stale,digest:digest('stale-old-command'),rows:[{...order('STALE-2','',10),deliveryDate:'2026-10-20'}]};
    await ok(await command(1,'stale-old-command',{type:'data.import',input:normal}));
    progress=await get('/api/inventory/orders');const second=progress.orders.find((row:any)=>row.doNo==='STALE-2');assert.equal(second.planningControl,'review');assert.equal(second.reserved,0);
  });

  it('stores dated raw reports over an existing ledger but uses only reasoned physical-count adjustments',async()=>{
    const baseline={fileName:'legacy.xlsm',digest:digest('legacy'),asOfDate:'2026-10-18',includeBaseline:true,reconcileStock:false,packingBinTotal:null,
      items:[{materialCode:'5220',description:'FS 5220 50KG',unit:'Bags',bagWeightKg:50,strategy:'mto',targetQuantity:0,needsReview:false,opening:30,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:30,medication:'',fmrOmed:''}],orders:[],annotations:[]};
    await ok(await command(0,'legacy-baseline',{type:'inventory.importBaseline',input:baseline}));
    const daily=report('2026-10-26',30,10,5,35,[order('A','',10)]),preview=await json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports:[daily]})}));assert.equal(preview.requiresReconcile,true);assert.equal(preview.stockDifferences[0].difference,5);
    await ok(await command(1,'daily-over-ledger',{type:'inventory.importDailyReports',reports:[daily],reconcile:true,reason:'Confirmed count'}));
    const imported=await pool.query<any>(`SELECT l.movement_type,l.quantity_delta_scaled::integer quantity FROM inventory_ledger l JOIN inventory_imports i ON i.id=l.import_id WHERE i.import_mode='dated-report'`);assert.deepEqual(imported.rows,[{movement_type:'adjustment',quantity:5}]);
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,35);
  });

  it('confirms historical DONE and OUT without disguising them as hold/cancel or posting stock',async()=>{
    const input=report('2026-10-26',10,0,0,10,[order('CONFIRM-DONE','',5),order('CONFIRM-OUT','',5)]);await ok(await command(0,'confirm-seed',{type:'inventory.importDailyReports',reports:[input],reconcile:false,reason:''}));
    let progress=await get('/api/inventory/orders'),byDo=new Map(progress.orders.map((row:any)=>[row.doNo,row])),before=Number((await pool.query('SELECT count(*) count FROM inventory_ledger')).rows[0].count);
    await ok(await command(1,'confirm-done',{type:'data.setPlanningControl',sourceOrderId:byDo.get('CONFIRM-DONE').sourceOrderId,action:'historicalDone',reason:'Verified against archived production sheet'}));
    await ok(await command(2,'confirm-out',{type:'data.setPlanningControl',sourceOrderId:byDo.get('CONFIRM-OUT').sourceOrderId,action:'historicalOut',reason:'Verified as already reflected in baseline',stockAccounted:true}));
    progress=await get('/api/inventory/orders');byDo=new Map(progress.orders.map((row:any)=>[row.doNo,row]));assert.deepEqual({status:byDo.get('CONFIRM-DONE').historicalStatus,control:byDo.get('CONFIRM-DONE').planningControl},{status:'done',control:'active'});assert.deepEqual({status:byDo.get('CONFIRM-OUT').historicalStatus,control:byDo.get('CONFIRM-OUT').planningControl},{status:'out',control:'active'});
    const out=await get(`/api/data/${encodeURIComponent(byDo.get('CONFIRM-OUT').sourceOrderId)}`);assert.equal(out.deliveryStatus,'delivered');assert.equal(out.deliveryRecordedAt,null);assert.equal(Number((await pool.query('SELECT count(*) count FROM inventory_ledger')).rows[0].count),before);
  });

  it('skips duplicate history after later stock activity and preserves a manually released missing order',async()=>{
    const reports=[report('2026-10-26',30,0,0,30,[order('MISSING','',10)]),report('2026-10-27',30,0,0,30,[])];
    await ok(await command(0,'empty-latest-report',{type:'inventory.importDailyReports',reports,reconcile:false,reason:''}));
    let item=(await get('/api/inventory')).items[0],tracked=(await get('/api/inventory/orders')).orders[0];
    assert.equal(tracked.planningControl,'review');
    await ok(await command(1,'release-missing',{type:'data.setPlanningControl',sourceOrderId:tracked.sourceOrderId,action:'release',reason:'Verified still required'}));
    // Simulate a later valid stock posting directly in the disposable DB to isolate duplicate semantics.
    await pool.query("UPDATE inventory_ledger SET quantity_delta_scaled=40 WHERE item_id=$1 AND movement_type='baseline'",[item.itemId]);
    const preview=await json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports})}));
    assert.equal(preview.requiresReconcile,false);assert.deepEqual(preview.stockDifferences,[]);
    await ok(await command(2,'repeat-all-reports',{type:'inventory.importDailyReports',reports,reconcile:false,reason:''}));
    tracked=(await get('/api/inventory/orders')).orders[0];assert.equal(tracked.planningControl,'active');assert.equal((await get('/api/inventory')).items[0].totalOnHand,40);
  });

  it('treats a zero stock baseline as established and confirms historical states without false control labels',async()=>{
    const baseline={fileName:'zero.xlsm',digest:digest('zero'),asOfDate:'2026-10-18',includeBaseline:true,packingBinTotal:null,orders:[],annotations:[],items:report('2026-10-18',0,0,0,0,[]).stockRows};
    await ok(await command(0,'zero-baseline',{type:'inventory.importBaseline',input:baseline}));
    const reports=[report('2026-10-26',0,10,5,5,[order('VERIFY','',10)])];
    const preview=await json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports})}));assert.equal(preview.requiresReconcile,true);
    await ok(await command(1,'zero-count-confirm',{type:'inventory.importDailyReports',reports,reconcile:true,reason:'Verified Closing count'}));
    const ledger=(await get('/api/backup')).inventory.ledger;assert.equal(ledger.length,1);assert.equal(ledger[0].movementType,'adjustment');
    const id=(await get('/api/inventory/orders')).orders[0].sourceOrderId;
    await ok(await command(2,'confirm-ready',{type:'data.setPlanningControl',sourceOrderId:id,action:'historicalDone',reason:'Previously completed'}));
    let tracked=(await get('/api/inventory/orders')).orders[0];assert.equal(tracked.historicalStatus,'done');assert.equal(tracked.planningControl,'active');assert.equal(tracked.produced,0);
    await ok(await command(3,'confirm-out',{type:'data.setPlanningControl',sourceOrderId:id,action:'historicalOut',reason:'Already included in historical count',stockAccounted:true}));
    tracked=(await get('/api/inventory/orders')).orders[0];assert.equal(tracked.historicalStatus,'out');assert.equal(tracked.planningControl,'active');
    assert.equal((await get(`/api/data/${id}`)).deliveryRecordedAt,null);assert.deepEqual((await get('/api/backup')).inventory.ledger,ledger);
  });

  async function command(revision:number,id:string,command:unknown){return fetch(`${baseUrl}/api/commands`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({expectedRevision:revision,commandId:id,command})})}
  async function get(path:string){return json(await fetch(baseUrl+path))}
  async function ok(response:Response){assert.equal(response.status,200,await response.clone().text());return response}
});

function report(date:string,opening:number,production:number,issue:number,closing:number,orderRows:ReturnType<typeof order>[]):DailyReportInput{return{fileName:`FEED ${date}.xlsm`,digest:digest(date),sheetName:date.slice(-2)+'th',asOfDate:date,stockRows:[{materialCode:'5220',description:'FS 5220 50KG',unit:'Bags',bagWeightKg:50,strategy:'mto',targetQuantity:0,needsReview:false,opening,production,received:0,salesReturn:0,rework:0,issue,closing,medication:'',fmrOmed:''}],orderRows}}
function order(doNo:string,remark:string,quantity:number){return{doNo,deliveryDate:'2026-10-28',soldToParty:'Customer',shipToParty:'Customer',materialCode:'5220',description:'FS 5220 50KG',quantity,unit:'Bags' as const,deliveryLeadDays:1,remark,daysOutstanding:null,medication:'',fmrOmed:'',sourceSheet:'27th',sourceRow:1}}
function digest(value:string){return createHash('sha256').update(value).digest('hex')}
async function json(response:Response){const body=await response.json();if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(body)}`);return body}
function assertDedicated(testUrl:string,_productionUrl:string|undefined){const test=new URL(testUrl);if(!/test/i.test(test.pathname))throw new Error('TEST_DATABASE_URL must identify a test database')}
