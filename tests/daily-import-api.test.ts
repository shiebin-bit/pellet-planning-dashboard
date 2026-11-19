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
import { validatePortableBackupV7 } from '../server/sourceBackup';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration=databaseUrl?describe:describe.skip;

integration('stock-only daily import API',()=>{
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

  it('imports only anonymous stock history and round-trips V7 without any order projection',async()=>{
    const reports=[report('2026-10-26',30,10,5,35),report('2026-10-27',35,5,10,30)];
    const preview=await previewReports(reports);assert.equal(preview.requiresReconcile,false);assert.deepEqual(preview.formulaDifferences,[]);assert.deepEqual(preview.continuityDifferences,[]);
    assert.equal(preview.reports.length,2);assert.equal('newOrders' in preview,false);
    await ok(await command(0,'stock-reports',{type:'inventory.importStockReports',reports,reconcile:false,reason:''}));
    assert.equal((await get('/api/workspace')).state.jobs.length,0);
    const inventory=await get('/api/inventory');assert.equal(inventory.items[0].totalOnHand,30);assert.equal(inventory.baselineDate,'2026-10-26');
    assert.deepEqual((await get('/api/inventory/orders')).orders,[]);assert.equal((await get('/api/data')).total,0);
    const anonymous=await pool.query('SELECT count(*)::integer count FROM inventory_ledger WHERE source_order_id IS NULL AND job_id IS NULL');assert.ok(anonymous.rows[0].count>=5);
    const backup=await get('/api/backup');assert.equal(backup.schemaVersion,7);assert.equal(backup.baselineHistory.observations.length,0);assert.equal(backup.baselineHistory.inventoryImports.length,2);validatePortableBackupV7(backup);
    await ok(await command(1,'stock-reset',{type:'workspace.resetDemo',date:'2026-11-16'}));
    await ok(await command(2,'stock-restore',{type:'workspace.restore',backup}));
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,30);assert.deepEqual((await get('/api/inventory/orders')).orders,[]);
    assert.deepEqual((await get('/api/backup')).baselineHistory,backup.baselineHistory);
  });

  it('rejects nonempty legacy order rows atomically through both stock-only contracts',async()=>{
    const bad={...report('2026-10-26',30,0,0,30),orderRows:[order('IGNORED-LOWER-TABLE','CANCEL',100)]};
    for(const type of ['inventory.importDailyReports','inventory.importStockReports']){
      const response=await command(0,'reject-'+type,{type,reports:[bad],reconcile:false,reason:''});assert.equal(response.status,400);
      assert.equal((await get('/api/workspace')).revision,0);assert.equal((await get('/api/data')).total,0);assert.equal((await get('/api/backup')).inventory.ledger.length,0);
    }
    const compatible={...report('2026-10-26',30,0,0,30),orderRows:[]};
    await ok(await command(0,'legacy-empty-stock-only',{type:'inventory.importDailyReports',reports:[compatible],reconcile:false,reason:''}));
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,30);assert.equal((await get('/api/data')).total,0);
  });

  it('rejects an unconfirmed formula difference and never replays a same-day report',async()=>{
    const bad=report('2026-10-26',30,10,5,34);
    assert.equal((await previewReports([bad])).requiresReconcile,true);
    const rejected=await command(0,'bad-unconfirmed',{type:'inventory.importStockReports',reports:[bad],reconcile:false,reason:''});assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'DAILY_REPORT_RECONCILIATION_REQUIRED');
    await ok(await command(0,'bad-confirmed',{type:'inventory.importStockReports',reports:[bad],reconcile:true,reason:'Confirmed physical Closing'}));
    const changed={...bad,digest:digest('changed')};const conflict=await command(1,'same-date-conflict',{type:'inventory.importStockReports',reports:[changed],reconcile:true,reason:'Changed copy'});assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'DAILY_REPORT_DATE_CONFLICT');
    assert.equal(Number((await pool.query('SELECT count(*) count FROM inventory_ledger')).rows[0].count),4);
  });

  it('rejects old SAP dates through batch and compatibility commands without admitting an order',async()=>{
    const stale={fileName:'bag order.xlsx',sheetName:'bag order',digest:digest('stale-batch'),asOfDate:today(),rows:[{...order('STALE-1','',10),deliveryDate:addDays(today(),-1)}]};
    for(const cmd of [{type:'data.importBatch',inputs:[stale]},{type:'data.import',input:stale}]){
      const response=await command(0,'reject-'+cmd.type,cmd);assert.equal(response.status,400,await response.clone().text());
      assert.equal((await get('/api/workspace')).revision,0);assert.deepEqual((await get('/api/inventory/orders')).orders,[]);
    }
  });

  it('uses only reasoned physical-count adjustments when a ledger already exists',async()=>{
    await ok(await command(0,'first-count',{type:'inventory.importStockReports',reports:[report('2026-10-18',30,0,0,30)],reconcile:false,reason:''}));
    const daily=report('2026-10-26',30,10,5,35),preview=await previewReports([daily]);assert.equal(preview.requiresReconcile,true);assert.equal(preview.stockDifferences[0].difference,5);
    await ok(await command(1,'later-count',{type:'inventory.importStockReports',reports:[daily],reconcile:true,reason:'Confirmed physical count'}));
    const imported=await pool.query<any>(`SELECT l.movement_type,l.quantity_delta_scaled::integer quantity FROM inventory_ledger l JOIN inventory_imports i ON i.id=l.import_id WHERE i.as_of_date='2026-10-26'`);assert.deepEqual(imported.rows,[{movement_type:'adjustment',quantity:5}]);
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,35);
  });

  it('leaves manually confirmed DONE, OUT, HOLD and CANCEL untouched by later stock imports',async()=>{
    await ok(await command(0,'status-stock',{type:'inventory.importStockReports',reports:[report('2026-10-26',30,0,0,30)],reconcile:false,reason:''}));
    const rows=['DONE','OUT','HOLD','CANCEL'].map(name=>order(name,'',5));
    await ok(await command(1,'admit-status-orders',{type:'data.importBatch',inputs:[{fileName:'fictional-orders.xlsx',sheetName:'bag order',digest:digest('statuses'),asOfDate:today(),rows}]}));
    const byDo=new Map<string,any>((await get('/api/inventory/orders')).orders.map((row:any)=>[row.doNo,row]));
    const actions=['historicalDone','historicalOut','hold','cancel'];
    for(let index=0;index<rows.length;index++)await ok(await command(index+2,'manual-'+rows[index].doNo,{type:'data.setPlanningControl',sourceOrderId:byDo.get(rows[index].doNo).sourceOrderId,action:actions[index],reason:'Verified explicitly by planner',...(index===1?{stockAccounted:true}:{})}));
    const before=await get('/api/backup');
    const reports=[report('2026-10-27',30,0,0,30)];await ok(await command(6,'later-status-stock',{type:'inventory.importStockReports',reports,reconcile:false,reason:''}));
    const after=await get('/api/backup');assert.deepEqual(after.sourceData,before.sourceData);assert.deepEqual(after.inventory.orders,before.inventory.orders);assert.deepEqual(after.inventory.reservations,before.inventory.reservations);
    assert.equal(after.baselineHistory.observations.length,0);assert.deepEqual(after.baselineHistory.planningControls,before.baselineHistory.planningControls);assert.deepEqual(after.baselineHistory.planningControlEvents,before.baselineHistory.planningControlEvents);
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,30);
  });

  it('skips duplicate stock history after later postings without overwriting stock or order controls',async()=>{
    const reports=[report('2026-10-26',30,0,0,30),report('2026-10-27',30,0,0,30)];
    await ok(await command(0,'initial-reports',{type:'inventory.importStockReports',reports,reconcile:false,reason:''}));
    const item=(await get('/api/inventory')).items[0];
    await ok(await command(1,'later-valid-count',{type:'inventory.adjust',itemId:item.itemId,medication:'',fmrOmed:'',quantityDelta:10,countedQuantity:40,occurredOn:today(),reason:'Later verified count',postingKey:'daily-later-count'}));
    const before=await get('/api/backup');const preview=await previewReports(reports);assert.equal(preview.requiresReconcile,false);assert.deepEqual(preview.stockDifferences,[]);
    await ok(await command(2,'duplicate-reports',{type:'inventory.importStockReports',reports,reconcile:false,reason:''}));
    assert.equal((await get('/api/inventory')).items[0].totalOnHand,40);assert.deepEqual((await get('/api/backup')).inventory.ledger,before.inventory.ledger);
  });

  it('recognizes an established zero baseline and requires a later count reconciliation',async()=>{
    await ok(await command(0,'zero-baseline',{type:'inventory.importStockReports',reports:[report('2026-10-18',0,0,0,0)],reconcile:false,reason:''}));
    const reports=[report('2026-10-26',0,10,5,5)];assert.equal((await previewReports(reports)).requiresReconcile,true);
    await ok(await command(1,'zero-count-confirm',{type:'inventory.importStockReports',reports,reconcile:true,reason:'Verified Closing count'}));
    const ledger=(await get('/api/backup')).inventory.ledger;assert.equal(ledger.length,1);assert.equal(ledger[0].movementType,'adjustment');assert.equal((await get('/api/data')).total,0);
  });

  async function previewReports(reports:DailyReportInput[]){return json(await fetch(`${baseUrl}/api/inventory/daily-import/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({reports})}));}

  async function command(revision:number,id:string,command:unknown){return fetch(`${baseUrl}/api/commands`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({expectedRevision:revision,commandId:id,command})})}
  async function get(path:string){return json(await fetch(baseUrl+path))}
  async function ok(response:Response){assert.equal(response.status,200,await response.clone().text());return response}
});

function report(date:string,opening:number,production:number,issue:number,closing:number):DailyReportInput{return{fileName:`FEED ${date}.xlsm`,digest:digest(date),sheetName:date.slice(-2)+'th',asOfDate:date,stockRows:[{materialCode:'5220',description:'FS 5220 50KG',unit:'Bags',bagWeightKg:50,strategy:'mto',targetQuantity:0,needsReview:false,opening,production,received:0,salesReturn:0,rework:0,issue,closing,medication:'',fmrOmed:''}]}}
function order(doNo:string,remark:string,quantity:number){return{doNo,deliveryDate:addDays(today(),1),soldToParty:'Fictional customer',shipToParty:'Fictional customer',materialCode:'5220',description:'FS 5220 50KG',quantity,unit:'Bags' as const,deliveryLeadDays:1,remark,daysOutstanding:null,medication:'',fmrOmed:'',sourceSheet:'bag order',sourceRow:1}}
function digest(value:string){return createHash('sha256').update(value).digest('hex')}
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date())}
function addDays(date:string,n:number){return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)}
async function json(response:Response){const body=await response.json();if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(body)}`);return body}
function assertDedicated(testUrl:string,productionUrl:string|undefined){const test=new URL(testUrl);assert.match(test.pathname.slice(1),/(^|[-_])test(?:[-_]|$)/i);if(productionUrl){const production=new URL(productionUrl);assert.notEqual(`${test.hostname}:${test.port||'5432'}${test.pathname}`,`${production.hostname}:${production.port||'5432'}${production.pathname}`)}}
