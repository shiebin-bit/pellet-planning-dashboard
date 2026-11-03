import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { createApp } from '../server/app';
import { runMigrations } from '../server/migrate';
import { WorkspaceStore } from '../server/store';
import { createDefaultSettings } from '../src/domain/defaults';
import type { InventoryWorkbookInput } from '../src/domain/inventoryTypes';
import type { SourceImportInput, SourceImportReviewPage } from '../src/domain/sourceTypes';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration=databaseUrl?describe:describe.skip;

integration('source import review API',()=>{
  let pool:pg.Pool,server:Server,baseUrl:string;
  before(async()=>{
    assertDedicatedTestDatabase(databaseUrl!,process.env.DATABASE_URL);
    pool=new pg.Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5_000});
    await runMigrations(pool);const store=new WorkspaceStore(pool);server=createServer();
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not expose a TCP port.');
    server.removeAllListeners('request');server.on('request',createApp({store,hostPorts:new Set([address.port]),distDir:'Z:\\missing',allowedOrigins:new Set([`http://127.0.0.1:${address.port}`])}));
    baseUrl=`http://127.0.0.1:${address.port}`;
  });
  beforeEach(async()=>{await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');await new WorkspaceStore(pool).initialize(createDefaultSettings());});
  after(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(pool)await pool.end();});

  it('queues differences without mutation, applies selected fields, rejects stale candidates, and deduplicates repeated files',async()=>{
    const initial=sourceInput('initial.xlsx','a'.repeat(64),{description:'Original feed',deliveryDate:'2026-11-10',quantity:10});
    await ok(await command(0,'review-initial',{type:'data.import',input:initial}));
    const source=(await get<any>('/api/data')).items[0];
    const firstCandidate=sourceInput('changed-one.xlsx','b'.repeat(64),{description:'Verified feed',deliveryDate:'2026-11-12',quantity:11});
    const secondCandidate=sourceInput('changed-two.xlsx','c'.repeat(64),{description:'Later feed',deliveryDate:'2026-11-13',quantity:12});
    let response=await command(1,'review-first-observation',{type:'data.import',input:firstCandidate});await ok(response);
    response=await command(2,'review-second-observation',{type:'data.import',input:secondCandidate});await ok(response);
    const unchanged=await get<any>(`/api/data/${encodeURIComponent(source.id)}`);
    assert.equal(unchanged.version,1);assert.equal(unchanged.description,'Original feed');assert.equal(unchanged.quantity,10);
    let pending=await get<SourceImportReviewPage>('/api/data/reviews?status=pending&page=1');
    assert.equal(pending.total,2);assert.equal(pending.counts.pending,2);
    const first=pending.items.find(item=>item.sourceImport.fileName==='changed-one.xlsx')!;
    const second=pending.items.find(item=>item.sourceImport.fileName==='changed-two.xlsx')!;
    assert.deepEqual(first.changedFields.sort(),['deliveryDate','description','quantity'].sort());
    assert.equal(first.observedSourceVersion,1);assert.equal(first.currentSourceVersion,1);
    assert.equal((await get<any>(`/api/data/reviews/${encodeURIComponent(first.id)}`)).candidateFields.description,'Verified feed');
    await ok(await command(3,'review-apply-first',{type:'data.applySourceCorrection',reviewId:first.id,expectedSourceVersion:1,selectedFields:['description','deliveryDate'],reason:'Customer confirmed revised feed and due date.'}));
    const corrected=await get<any>(`/api/data/${encodeURIComponent(source.id)}`);
    assert.equal(corrected.version,2);assert.equal(corrected.description,'Verified feed');assert.equal(corrected.deliveryDate,'2026-11-12');assert.equal(corrected.quantity,10);
    assert.equal(corrected.versions.length,2);assert.equal(corrected.versions[0].importId,first.sourceImport.id);
    const stale=await command(4,'review-apply-stale',{type:'data.applySourceCorrection',reviewId:second.id,expectedSourceVersion:2,selectedFields:['description'],reason:'Should be stale.'});
    assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'SOURCE_REVIEW_STALE');
    await ok(await command(4,'review-dismiss-stale',{type:'data.dismissSourceCorrection',reviewId:second.id,expectedSourceVersion:2,reason:'Superseded by the verified correction.'}));
    assert.equal((await get<SourceImportReviewPage>('/api/data/reviews?status=dismissed&page=1')).total,1);
    assert.equal((await get<SourceImportReviewPage>('/api/data/reviews?status=applied&page=1')).items[0].selectedFields?.join(','),'description,deliveryDate');
    await ok(await command(5,'review-repeat-identical-file',{type:'data.import',input:firstCandidate}));
    assert.equal((await get<SourceImportReviewPage>('/api/data/reviews?status=applied&page=1')).total,1);
    assert.equal(Number((await pool.query('SELECT count(*) count FROM source_imports')).rows[0].count),3);
    assert.equal((await get<any[]>('/api/inventory/ledger')).length,0);
    const invalid=await fetch(`${baseUrl}/api/data/reviews?status=unknown`);assert.equal(invalid.status,400);
  });

  it('protects reserved quantity and manual inventory fields while allowing dismissal',async()=>{
    await ok(await command(0,'review-baseline',{type:'inventory.importBaseline',input:baselineInput()}));
    const source=(await get<any>('/api/data')).items[0];
    const changed=sourceInput('reserved-change.xlsx','e'.repeat(64),{quantity:120,medication:'Workbook medication'});
    await ok(await command(1,'review-reserved-observation',{type:'data.import',input:changed}));
    const review=(await get<SourceImportReviewPage>('/api/data/reviews?status=pending&page=1')).items[0];
    assert.ok(review.protectedFields.includes('quantity'));
    const rejected=await command(2,'review-reserved-quantity',{type:'data.applySourceCorrection',reviewId:review.id,expectedSourceVersion:1,selectedFields:['quantity'],reason:'Attempt reserved quantity.'});
    assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'SOURCE_RESERVATION_CONFLICT');
    const workspace=await get<any>('/api/workspace');assert.equal(workspace.revision,2);
    await ok(await command(2,'review-dismiss-reserved',{type:'data.dismissSourceCorrection',reviewId:review.id,expectedSourceVersion:1,reason:'Reservation makes this candidate inapplicable.'}));
    const order=await get<any>(`/api/data/${encodeURIComponent(source.id)}`);assert.equal(order.quantity,100);assert.equal(order.version,1);
  });

  it('retains workbook provenance and rolling counters without flooding the correction queue',async()=>{
    const initial=sourceInput('daily-initial.xlsx','7'.repeat(64),{sourceSheet:'Bag orders',sourceRow:4,deliveryLeadDays:5,daysOutstanding:1});
    await ok(await command(0,'daily-initial',{type:'data.import',input:initial}));
    const daily=sourceInput('daily-next.xlsx','8'.repeat(64),{sourceSheet:'Bag orders latest',sourceRow:77,deliveryLeadDays:4,daysOutstanding:2});
    await ok(await command(1,'daily-counters',{type:'data.import',input:daily}));
    const source=(await get<any>('/api/data')).items[0];
    assert.equal(source.version,1);assert.equal(source.needsReview,false);
    assert.equal((await get<SourceImportReviewPage>('/api/data/reviews?status=pending&page=1')).total,0);
    const previewResponse=await fetch(`${baseUrl}/api/data/preview`,{method:'POST',headers:{'Content-Type':'application/json',Origin:baseUrl},body:JSON.stringify(daily)});
    assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
    assert.equal(preview.changed,0);assert.equal(preview.rows[0].importAction,'skip-unchanged');assert.deepEqual(preview.rows[0].changedFields,[]);
    await ok(await command(2,'daily-counters-repeat',{type:'data.import',input:daily}));
    assert.equal((await get<SourceImportReviewPage>('/api/data/reviews?status=pending&page=1')).total,0);
  });

  it('round-trips a legacy source review flag that predates the persisted queue',async()=>{
    await ok(await command(0,'legacy-review-initial',{type:'data.import',input:sourceInput('legacy-review.xlsx','9'.repeat(64),{})}));
    await pool.query("UPDATE source_orders SET needs_review=true WHERE workspace_id=1");
    const backup=await get<any>('/api/backup');
    assert.equal(backup.sourceData.discrepancies.length,0);assert.equal(backup.sourceData.orders[0].needsReview,true);
    await ok(await command(1,'legacy-review-reset',{type:'workspace.resetDemo',date:'2026-11-03'}));
    await ok(await command(2,'legacy-review-restore',{type:'workspace.restore',backup}));
    const restored=(await get<any>('/api/data')).items[0];assert.equal(restored.needsReview,true);
  });

  it('exports and restores v5 discrepancy provenance without replaying inventory',async()=>{
    await ok(await command(0,'review-v5-initial',{type:'data.import',input:sourceInput('v5-initial.xlsx','1'.repeat(64),{})}));
    await ok(await command(1,'review-v5-change',{type:'data.import',input:sourceInput('v5-change.xlsx','2'.repeat(64),{remark:'Needs review'})}));
    const backup=await get<any>('/api/backup');
    assert.equal(backup.schemaVersion,5);assert.equal(backup.sourceData.discrepancies.length,1);assert.deepEqual(backup.productionProgress,{samples:[],resets:[]});
    await ok(await command(2,'review-v5-reset',{type:'workspace.resetDemo',date:'2026-11-03'}));
    const previous=await get<any>('/api/backup/previous');assert.equal(previous.schemaVersion,5);assert.equal(previous.sourceData.discrepancies.length,1);
    await ok(await command(3,'review-v5-restore',{type:'workspace.restore',backup}));
    const restored=await get<SourceImportReviewPage>('/api/data/reviews?status=pending&page=1');assert.equal(restored.total,1);assert.equal(restored.items[0].candidateFields.remark,'Needs review');
    assert.equal((await get<any>('/api/data')).items[0].needsReview,true,'Pending review visibility is derived even when the base legacy flag is false.');
  });

  async function command(revision:number,commandId:string,commandBody:unknown){return fetch(`${baseUrl}/api/commands`,{method:'POST',headers:{'Content-Type':'application/json',Origin:baseUrl},body:JSON.stringify({expectedRevision:revision,commandId,command:commandBody})});}
  async function get<T>(path:string):Promise<T>{const response=await fetch(baseUrl+path);assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<T>;}
  async function ok(response:Response){assert.equal(response.status,200,await response.clone().text());return response.json();}
});

function sourceInput(fileName:string,digest:string,patch:Partial<SourceImportInput['rows'][number]>):SourceImportInput{return{fileName,sheetName:'Orders',digest,asOfDate:'2026-11-03',rows:[{
  goodsMovementStatus:'',sourceSheet:'Orders',sourceRow:2,doNo:'TEST-REVIEW-001',deliveryDate:'2026-11-10',soldToParty:'Fictional buyer',shipToParty:'Fictional mill',materialCode:'TEST-FEED-001',description:'Original feed',quantity:100,unit:'MT',deliveryLeadDays:7,remark:'',daysOutstanding:0,medication:'',fmrOmed:'',...patch,
}]};}

function baselineInput():InventoryWorkbookInput{return{fileName:'review-baseline.xlsx',digest:'d'.repeat(64),asOfDate:'2026-11-03',includeBaseline:true,reconcileStock:false,packingBinTotal:null,
  orders:[sourceInput('review-baseline-orders.xlsx','f'.repeat(64),{})],annotations:[],items:[{materialCode:'TEST-FEED-001',description:'Original feed',unit:'MT',bagWeightKg:null,medication:'',fmrOmed:'',strategy:'mto',targetQuantity:0,needsReview:false,opening:30,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:30}]};}

function assertDedicatedTestDatabase(testUrl:string,productionUrl:string|undefined){const parsed=new URL(testUrl);const database=parsed.pathname.replace(/^\//,'');assert.match(database,/(^|[_-])test($|[_-])/i,`TEST_DATABASE_URL must name a dedicated test database; received ${database}.`);if(productionUrl)assert.notEqual(testUrl,productionUrl,'TEST_DATABASE_URL must not match DATABASE_URL.');}
