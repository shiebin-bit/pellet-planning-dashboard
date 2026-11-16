import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {before,after,beforeEach,describe,it} from 'node:test';
import pg from 'pg';
import {createApp} from '../server/app';
import {runMigrations} from '../server/migrate';
import {WorkspaceStore} from '../server/store';
import {createDefaultSettings} from '../src/domain/defaults';
import type {Command,SplitPendingGroup} from '../src/domain/commands';

const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('transactional card split API',()=>{
 let pool:pg.Pool,server:Server,store:WorkspaceStore,base:string;
 before(async()=>{
  const target=new URL(url!);assert.match(target.pathname,/(^|[_-])test([_-]|$)/i);
  if(process.env.DATABASE_URL)assert.notEqual(url,process.env.DATABASE_URL);
  pool=new pg.Pool({connectionString:url,max:4});await runMigrations(pool);store=new WorkspaceStore(pool);
  server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`;
  server.on('request',createApp({store,hostPorts:new Set([address.port]),distDir:'Z:/missing',allowedOrigins:new Set([base])}));
 });
 beforeEach(async()=>{await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');await store.initialize(createDefaultSettings());});
 after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});
 async function get(path:string){const response=await fetch(base+path);assert.equal(response.status,200);return response.json();}
 async function post(command:Command,expectedRevision?:number,commandId=randomUUID()){
  const revision=expectedRevision??(await get('/api/workspace')).revision;
  const response=await fetch(base+'/api/commands',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({command,expectedRevision:revision,commandId})});
  return {status:response.status,body:await response.json()};
 }
 async function ok(command:Command){const result=await post(command);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
 async function setup(){
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
  const fields={doNo:'QA-SPLIT-A',deliveryDate:date,soldToParty:'Fictional customer',shipToParty:'Fictional farm',materialCode:'QA-FEED-SPLIT',description:'FS 5220 TEST BULK',quantity:100,unit:'MT' as const,deliveryLeadDays:0,daysOutstanding:null,remark:'',medication:'',fmrOmed:''};
  await ok({type:'inventory.importBaseline',input:{fileName:'fictional-stock.xlsx',digest:'a'.repeat(64),asOfDate:date,includeBaseline:true,packingBinTotal:null,annotations:[],orders:[{fileName:'fictional-orders.xlsx',sheetName:'bulk order',digest:'b'.repeat(64),asOfDate:date,rows:[fields]}],items:[{...fields,bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0}].map(({doNo:_,deliveryDate:__,soldToParty:___,shipToParty:____,quantity:_____,deliveryLeadDays:______,daysOutstanding:_______,remark:________,...item})=>item)}});
  const order=(await get('/api/inventory/orders')).orders[0];
  const result=await ok({type:'job.createFromSources',input:{orders:[{sourceOrderId:order.sourceOrderId,sourceOrderVersion:1,plannedQuantity:100}],date,lineId:'PM1',bin:'BIN',remarks:'Fictional'}});
  const job=result.state.jobs[0];
  const group=(n:number):SplitPendingGroup=>({date,lineId:'PM1',bin:'BIN',remarks:'Fictional split',allocations:[{sourceOrderId:order.sourceOrderId,plannedQuantity:n}],unallocatedQuantity:0});
  return {job,group};
 }
 it('rejects invalid batches and stale revisions, retries once, preserves source quantity and round-trips lineage',async()=>{
  const {job,group}=await setup(),before=await get('/api/backup'),revision=(await get('/api/workspace')).revision;
  const bad=await post({type:'job.splitPending',jobId:job.id,groups:[group(40),group(59)]});assert.equal(bad.status,400);assert.equal((await get('/api/workspace')).revision,revision);assert.equal((await get('/api/workspace')).state.jobs.length,1);
  const stale=await post({type:'job.splitPending',jobId:job.id,groups:[group(40),group(60)]},revision-1);assert.equal(stale.status,409);
  const command:Command={type:'job.splitPending',jobId:job.id,groups:[group(40),group(60)]},id=randomUUID();
  const saved=await post(command,revision,id);assert.equal(saved.status,200,JSON.stringify(saved.body));
  const retry=await post(command,revision,id);assert.equal(retry.status,200);assert.equal(retry.body.revision,saved.body.revision);
  const children=saved.body.state.jobs.filter((j:any)=>j.derivedFromJobId===job.id);assert.equal(children.length,2);assert.equal(children.reduce((n:number,j:any)=>n+j.quantityMt,0),100);
  const split=await get('/api/backup');assert.deepEqual(split.inventory.ledger,before.inventory.ledger);
  await ok({type:'workspace.restore',backup:split});const restored=await get('/api/backup');assert.deepEqual(restored.planning.jobs,split.planning.jobs);
  const combined=await ok({type:'job.combinePending',jobIds:children.map((j:any)=>j.id),bin:'BIN',remarks:'Rejoined'});
  const active=combined.state.jobs.filter((j:any)=>j.status==='pending');assert.equal(active.length,1);assert.equal(active[0].sourceAllocations.length,1);assert.equal(active[0].sourceAllocations[0].plannedQuantity,100);
 });
 it('refuses to split a card after physical output was posted',async()=>{
  const {job,group}=await setup();await ok({type:'job.start',jobId:job.id});await ok({type:'production.recordReceipt',jobId:job.id,totalActualQuantity:1});
  const before=await get('/api/backup'),result=await post({type:'job.splitPending',jobId:job.id,groups:[group(40),group(60)]});assert.ok(result.status>=400);assert.deepEqual((await get('/api/backup')).inventory.ledger,before.inventory.ledger);assert.equal((await get('/api/workspace')).state.jobs.length,1);
 });
});
