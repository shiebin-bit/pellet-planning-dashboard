import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {after,before,beforeEach,describe,it} from 'node:test';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../server/app';
import {runMigrations} from '../server/migrate';
import {WorkspaceStore} from '../server/store';
import {createDefaultSettings} from '../src/domain/defaults';
import {createJob,getRate,getScheduledJobs} from '../src/domain/engine';
import {applyAndPersistDraftCarryovers,buildCarryoverPlanningContext} from '../server/dailyPlanning';
import {readSapImportContext} from '../server/nextDayImport';
import {ApiError} from '../server/errors';
import type {SourceImportInput,SourceOrderFields} from '../src/domain/sourceTypes';

const databaseUrl=process.env.TEST_DATABASE_URL;
const integration=databaseUrl?describe:describe.skip;

integration('next-day SAP admission and stock-only baseline',()=>{
  let pool:pg.Pool,store:WorkspaceStore,server:Server,baseUrl:string;
  before(async()=>{
    assert.match(new URL(databaseUrl!).pathname,/(?:^|[-_])test(?:[-_]|$)/i);
    pool=new pg.Pool({connectionString:databaseUrl,max:4});await runMigrations(pool);store=new WorkspaceStore(pool);
    server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const address=server.address();if(!address||typeof address==='string')throw new Error('No test port');
    server.removeAllListeners('request');server.on('request',createApp({store,hostPorts:new Set([address.port]),distDir:'Z:\\missing',allowedOrigins:new Set([`http://127.0.0.1:${address.port}`])}));baseUrl=`http://127.0.0.1:${address.port}`;
  });
  beforeEach(async()=>{await pool.query('TRUNCATE command_receipts,history_events,jobs,workspace CASCADE');await store.initialize(createDefaultSettings())});
  after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end()});

  it('publishes an authoritative Malaysia import context and rejects stale or non-next-day rows',async()=>{
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));
    assert.equal(context.timeZone,'Asia/Kuala_Lumpur');assert.equal(context.targetIssueDate,addDays(context.asOfDate,1));assert.equal(context.revision,0);
    const stale=source('STALE',context.targetIssueDate,addDays(context.asOfDate,-1));
    let response=await preview(stale);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'IMPORT_TARGET_DATE_CHANGED');
    const far=source('FAR',addDays(context.targetIssueDate,1),context.asOfDate);
    response=await preview(far);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'SAP_ORDER_NOT_NEXT_DAY');
    const accepted=await json(await preview(source('OK',context.targetIssueDate,context.asOfDate)));
    assert.equal(accepted.targetIssueDate,context.targetIssueDate);assert.equal(accepted.added,1);
    const year=await readSapImportContext(pool,new Date('2026-12-31T15:59:00Z')),month=await readSapImportContext(pool,new Date('2026-01-31T15:59:00Z'));
    assert.deepEqual([year.asOfDate,year.targetIssueDate],['2026-12-31','2027-01-01']);assert.deepEqual([month.asOfDate,month.targetIssueDate],['2026-01-31','2026-02-01']);
  });

  it('imports baseline stock without orders and rejects every legacy stock-order attachment',async()=>{
    const report=stockReport();
    let response=await command(0,'stock',{type:'inventory.importStockReports',reports:[report],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const imports=await pool.query(`SELECT included_baseline FROM inventory_imports`);assert.equal(imports.rowCount,1);assert.equal(imports.rows[0].included_baseline,true);
    const legacy={...report,orderRows:[row('OLD','2026-01-01')]};
    response=await command(1,'legacy-daily',{type:'inventory.importDailyReports',reports:[legacy],reconcile:false,reason:''});assert.equal(response.status,400);assert.match((await response.json()).error.message,/stock only|no longer supported/i);
    response=await command(1,'legacy-workbook',{type:'inventory.importBaseline',input:{fileName:'old.xlsm',digest:hash('old'),asOfDate:'2026-01-01',orders:[source('OLD','2026-01-02','2026-01-01')],items:[],annotations:[],packingBinTotal:null,includeBaseline:true}});assert.equal(response.status,400);
    assert.equal((await pool.query('SELECT 1 FROM source_orders')).rowCount,0);
  });

  it('rejects duplicate DO/material identities across worksheets atomically',async()=>{
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));
    const one=source('DUP',context.targetIssueDate,context.asOfDate,'Bag order'),two=source('DUP',context.targetIssueDate,context.asOfDate,'Custom mapped sheet');
    const response=await command(0,'dup',{type:'data.importBatch',inputs:[one,two]});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'SAP_ORDER_DUPLICATE');
    assert.equal((await pool.query('SELECT 1 FROM source_orders')).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM order_admission_batches')).rowCount,0);
  });

  it('admits exact retries once, keeps the earliest ordinal, and preserves HOLD on changed reimport',async()=>{
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));const input=source('KEEP',context.targetIssueDate,context.asOfDate);
    let response=await command(0,'first',{type:'data.importBatch',inputs:[input]});assert.equal(response.status,200,await response.text());
    const first=await pool.query(`SELECT io.source_order_id,io.admission_batch_id,io.admission_ordinal,io.updated_at FROM inventory_orders io`);assert.equal(first.rows[0].admission_ordinal,0);
    response=await command(1,'hold',{type:'data.setPlanningControl',sourceOrderId:first.rows[0].source_order_id,action:'hold',reason:'Manager hold'});assert.equal(response.status,200,await response.text());
    const changed={...input,digest:hash('changed'),rows:[{...input.rows[0],quantity:125}]};
    response=await command(2,'changed',{type:'data.importBatch',inputs:[changed]});assert.equal(response.status,200,await response.text());
    const retained=await pool.query(`SELECT admission_batch_id,admission_ordinal,planning_control,planning_control_reason FROM inventory_orders`);
    assert.equal(retained.rows[0].admission_batch_id,first.rows[0].admission_batch_id);assert.equal(retained.rows[0].admission_ordinal,0);assert.equal(retained.rows[0].planning_control,'hold');assert.equal(retained.rows[0].planning_control_reason,'Manager hold');
  });

  it('keeps stable priority across multiple batches accepted for the same target day',async()=>{
    const zero={...stockReport(),digest:hash('priority-zero'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'priority-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));
    const first={...source('PRIORITY-A',context.targetIssueDate,context.asOfDate),digest:hash('priority-first'),rows:[row('PRIORITY-A',context.targetIssueDate),row('PRIORITY-B',context.targetIssueDate)]};
    response=await command(1,'priority-first',{type:'data.importBatch',inputs:[first]});assert.equal(response.status,200,await response.text());
    response=await command(2,'priority-second',{type:'data.importBatch',inputs:[source('PRIORITY-C',context.targetIssueDate,context.asOfDate)]});assert.equal(response.status,200,await response.text());
    const draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,2))),orders=draft.demand.filter((entry:any)=>entry.orderNo?.startsWith('PRIORITY-'));
    assert.deepEqual(orders.map((entry:any)=>entry.orderNo),['PRIORITY-A','PRIORITY-B','PRIORITY-C']);assert.deepEqual(orders.map((entry:any)=>entry.priorityOrdinal),[0,1,2]);
  });

  it('excludes legacy non-admitted orders from reservation and generated demand',async()=>{
    const report=stockReport();let response=await command(0,'stock',{type:'inventory.importStockReports',reports:[report],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const item=await pool.query(`SELECT id FROM inventory_items LIMIT 1`),now=new Date().toISOString();
    await pool.query(`INSERT INTO source_imports(id,workspace_id,file_name,sheet_name,digest,semantic_digest,as_of_date,row_count,imported_at) VALUES('legacy-import',1,'legacy.xlsx','old',$1,$1,current_date,1,$2)`,[hash('legacy'),now]);
    await pool.query(`INSERT INTO source_orders(id,workspace_id,do_no,material_code,latest_version,latest_import_id,delivery_status,updated_at) VALUES('legacy-order',1,'OLD','7.0312008522050',1,'legacy-import','pending',$1)`,[now]);
    await pool.query(`INSERT INTO source_order_versions(source_order_id,version,import_id,fields,content_hash,created_at) VALUES('legacy-order',1,'legacy-import',$1::jsonb,$2,$3)`,[JSON.stringify(row('OLD','2026-01-01')),hash('fields'),now]);
    await pool.query(`INSERT INTO inventory_orders(source_order_id,workspace_id,item_id,due_date,ordered_quantity_scaled,medication,fmr_omed,historical_status,needs_review,planning_control,created_at,updated_at) VALUES('legacy-order',1,$1,current_date,100,'','','pending',false,'active',$2,$2)`,[item.rows[0].id,now]);
    const client=await pool.connect();try{await client.query('BEGIN');const {recalculateReservations}=await import('../server/inventory');await recalculateReservations(client,now);await client.query('COMMIT')}finally{client.release()}
    assert.equal(Number((await pool.query(`SELECT quantity_scaled FROM inventory_reservations WHERE source_order_id='legacy-order'`)).rows[0].quantity_scaled),0);
    response=await fetch(`${baseUrl}/api/inventory/draft`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({fromDate:contextDate(),toDate:addDays(contextDate(),2),demandThrough:addDays(contextDate(),3)})});
    assert.equal(response.status,200,await response.clone().text());const draft=await response.json();assert.equal(draft.demand.some((entry:any)=>entry.sourceOrderId==='legacy-order'),false);
  });

  it('carries existing manual work while keeping bag candidates integral and rejects past capacity',async()=>{
    const settings=createDefaultSettings(),nowIso=new Date().toISOString(),today=contextDate(),yesterday=addDays(today,-1);
    let state=createJob({catalog:[],jobs:[],events:[],settings},{date:yesterday,lineId:'PM1',orderNo:'MANUAL',productCode:'5220',description:'Manual MTS',bin:'',mode:'bags',bagCount:100,quantityMt:5,remarks:'',productionPurpose:'mts',bagWeightKgSnapshot:50});
    let client=await pool.connect();
    try{
      let context=await buildCarryoverPlanningContext(client,state,nowIso);assert.equal(context.candidates.length,1);assert.equal(context.candidates[0].kind,'reschedule');assert.equal(context.candidates[0].remainingQuantity,100);
      const start=Date.now()+3_600_000,rate=getRate(settings,'PM1','5220'),capacityBags=2.7,end=start+capacityBags*0.05/rate*3_600_000;
      const original=state.jobs[0];state={...state,jobs:[{...original,date:today,status:'running',actualStart:nowIso,lockedSegments:[{jobId:original.id,lineId:'PM1',kind:'production',start,end}]}]};
      context=await buildCarryoverPlanningContext(client,state,nowIso);assert.equal(context.candidates[0].kind,'continuation');assert.equal(context.candidates[0].remainingQuantity,98);assert.equal(Number.isInteger(context.candidates[0].remainingQuantity),true);
      const candidate=context.candidates[0];
      await assert.rejects(()=>applyAndPersistDraftCarryovers(client,state,[{...candidate,date:today,lineId:'PM1',notBefore:new Date(Date.now()-120_000).toISOString(),segments:[{jobId:original.id,lineId:'PM1',kind:'production',start:Date.now()-120_000,end:Date.now()-60_000}]}],nowIso),(error:any)=>error instanceof ApiError&&error.code==='DRAFT_CARRYOVER_EXPIRED');
    }finally{client.release()}
  });

  it('removes separately reserved continuation capacity when its original card completes',async()=>{
    const input={date:contextDate(),lineId:'PM1',orderNo:'LIFE',productCode:'5220',description:'Lifecycle',bin:'',mode:'bags',bagCount:100,quantityMt:5,remarks:'',productionPurpose:'mts',bagWeightKgSnapshot:50};
    let response=await command(0,'life-create',{type:'job.create',input});let workspace=await json(response),jobId=workspace.state.jobs[0].id;
    response=await command(1,'life-start',{type:'job.start',jobId});workspace=await json(response);
    const start=Date.now()+86_400_000,end=start+3_600_000;
    await pool.query(`INSERT INTO job_continuation_reservations(job_id,workspace_id,remaining_quantity_scaled,unit,planning_date,line_id,not_before,segments,planned_at) VALUES($1,1,100,'Bags',$2,'PM1',$3,$4::jsonb,$5)`,[jobId,addDays(contextDate(),1),new Date(start).toISOString(),JSON.stringify([{jobId,lineId:'PM1',kind:'production',start,end}]),new Date().toISOString()]);
    response=await command(2,'life-complete',{type:'job.complete',jobId,actualQuantityMt:5,completionNote:'Done'});workspace=await json(response);
    assert.equal(workspace.state.jobs[0].status,'completed');assert.equal('continuationPlan' in workspace.state.jobs[0],false);assert.equal((await pool.query('SELECT 1 FROM job_continuation_reservations WHERE job_id=$1',[jobId])).rowCount,0);
  });

  it('keeps a zero continuation projection after receipts and a correction to zero, including V7 restore',async()=>{
    const zero={...stockReport(),digest:hash('zero-projection-stock'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'zero-projection-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));
    response=await command(1,'zero-projection-order',{type:'data.importBatch',inputs:[source('ZERO-LIFE',context.targetIssueDate,context.asOfDate)]});assert.equal(response.status,200,await response.text());
    let draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,2)));
    response=await command(2,'zero-projection-plan',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});let workspace=await json(response);
    const job=workspace.state.jobs.find((value:any)=>value.orderNo==='ZERO-LIFE');assert.ok(job);
    response=await command(3,'zero-projection-neighbour',{type:'job.create',input:{date:job.date,lineId:job.lineId,orderNo:'NEIGHBOUR',productCode:'5220',description:'Unrelated future card',bin:'',mode:'bags',bagCount:10,quantityMt:0.5,remarks:'',productionPurpose:'mts',bagWeightKgSnapshot:50}});workspace=await json(response);
    const neighbour=workspace.state.jobs.find((value:any)=>value.orderNo==='NEIGHBOUR'),beforeStart=getScheduledJobs(workspace.state).find(value=>value.id===neighbour.id)?.plannedStart;assert.ok(beforeStart);

    response=await command(4,'zero-projection-receipt-40',{type:'production.recordReceipt',jobId:job.id,totalActualQuantity:40});workspace=await json(response);
    let current=workspace.state.jobs.find((value:any)=>value.id===job.id);assert.deepEqual(current.continuationPlan?.segments,[]);assert.equal(current.continuationPlan?.remainingQuantityMt,0);
    assert.ok(Math.abs((getScheduledJobs(workspace.state).find(value=>value.id===neighbour.id)?.plannedStart??0)-beforeStart)<1);
    response=await command(5,'zero-projection-receipt-full',{type:'production.recordReceipt',jobId:job.id,totalActualQuantity:100});workspace=await json(response);
    current=workspace.state.jobs.find((value:any)=>value.id===job.id);assert.equal(current.continuationPlan?.remainingQuantityMt,0);
    workspace=await json(await fetch(`${baseUrl}/api/workspace`));current=workspace.state.jobs.find((value:any)=>value.id===job.id);assert.equal(current.continuationPlan?.remainingQuantityMt,0);

    response=await command(6,'zero-projection-correct',{type:'production.correctJobTotal',jobId:job.id,correctedTotalQuantity:0,reason:'Scale was assigned to the wrong card',postingKey:'zero-projection-correct'});workspace=await json(response);
    current=workspace.state.jobs.find((value:any)=>value.id===job.id);assert.equal(current.continuationPlan?.remainingQuantityMt,0);
    draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,2)));const carry=draft.carryovers.find((value:any)=>value.jobId===job.id);assert.ok(carry);assert.equal(carry.kind,'continuation');assert.equal(carry.remainingQuantity,100);assert.equal(carry.originalLineId,job.lineId);assert.equal(carry.lineId,job.lineId);

    const backup=await json(await fetch(`${baseUrl}/api/backup`)),saved=backup.dailyPlanning.continuationReservations.find((value:any)=>value.jobId===job.id);assert.ok(saved);assert.equal(saved.remainingQuantity,0);assert.deepEqual(saved.segments,[]);
    response=await command(7,'zero-projection-restore',{type:'workspace.restore',backup});workspace=await json(response);current=workspace.state.jobs.find((value:any)=>value.id===job.id);assert.equal(current.continuationPlan?.remainingQuantityMt,0);assert.deepEqual(current.continuationPlan?.segments,[]);
  });

  it('commits an overdue same-ID reschedule with new demand atomically and deduplicates retry',async()=>{
    const zero={...stockReport(),digest:hash('zero-stock'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'flow-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`));
    response=await command(1,'flow-a',{type:'data.importBatch',inputs:[source('FLOW-A',context.targetIssueDate,context.asOfDate)]});assert.equal(response.status,200,await response.text());
    let draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,2)));assert.equal(draft.jobs.length,1);
    response=await command(2,'flow-first-plan',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:[]});let workspace=await json(response),originalId=workspace.state.jobs[0].id;
    await pool.query(`UPDATE jobs SET planning_date=$2::date,payload=jsonb_set(jsonb_set(payload,'{date}',to_jsonb($2::text)),'{notBefore}',to_jsonb(($2::date::text||'T07:00:00+08:00')::text)) WHERE id=$1`,[originalId,addDays(context.asOfDate,-1)]);
    response=await command(3,'flow-b',{type:'data.importBatch',inputs:[source('FLOW-B',context.targetIssueDate,context.asOfDate)]});workspace=await json(response);
    draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,3)));assert.equal(draft.carryovers.length,1);assert.equal(draft.carryovers[0].jobId,originalId);assert.ok(draft.jobs.length>=1);
    const commit={type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers};
    response=await command(4,'flow-combined',commit);workspace=await json(response);assert.equal(workspace.revision,5);assert.equal(workspace.state.jobs.filter((job:any)=>job.id===originalId).length,1);assert.ok(workspace.state.jobs.find((job:any)=>job.id===originalId).date>=context.asOfDate);
    const count=workspace.state.jobs.length;response=await command(4,'flow-combined',commit);workspace=await json(response);assert.equal(workspace.revision,5);assert.equal(workspace.state.jobs.length,count);
  });

  it('reschedules one overdue card across multiple days without cloning its ID',async()=>{
    const zero={...stockReport(),digest:hash('multiday-reschedule-stock'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'multiday-reschedule-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const today=contextDate(),yesterday=addDays(today,-1);
    response=await command(1,'multiday-reschedule-create',{type:'job.create',input:{date:today,lineId:'PM1',orderNo:'MULTIDAY-RESCHEDULE',productCode:'5220',description:'Large overdue bulk card',bin:'',mode:'bulk',bagCount:null,quantityMt:150,remarks:'',productionPurpose:'mts'}});let workspace=await json(response),jobId=workspace.state.jobs[0].id;
    await pool.query(`UPDATE jobs SET planning_date=$2::date,payload=jsonb_set(jsonb_set(payload,'{date}',to_jsonb($2::text)),'{notBefore}',to_jsonb(($2::date::text||'T07:00:00+08:00')::text)) WHERE id=$1`,[jobId,yesterday]);
    const draft=await json(await draftRequest(today,addDays(today,2))),carry=draft.carryovers.find((value:any)=>value.jobId===jobId);assert.ok(carry);assert.equal(carry.kind,'reschedule');
    const productionDates=new Set(carry.segments.filter((segment:any)=>segment.kind==='production').map((segment:any)=>new Date(segment.start+8*3_600_000).toISOString().slice(0,10)));assert.ok(productionDates.size>=2);
    response=await command(2,'multiday-reschedule-commit',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});workspace=await json(response);
    assert.equal(workspace.state.jobs.filter((value:any)=>value.id===jobId).length,1);const scheduled=getScheduledJobs(workspace.state).find(value=>value.id===jobId);assert.ok(scheduled?.plannedStart);assert.ok(scheduled?.plannedEnd);assert.ok((scheduled!.plannedEnd!-scheduled!.plannedStart!)/3_600_000>12);
  });

  it('commits older unplanned demand before a newer existing carryover on the same PM',async()=>{
    const zero={...stockReport(),digest:hash('interleave-stock'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'interleave-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const context=await json(await fetch(`${baseUrl}/api/data/import-context`)),input={...source('OLDER-DEMAND',context.targetIssueDate,context.asOfDate),digest:hash('interleave-orders'),rows:[row('OLDER-DEMAND',context.targetIssueDate),row('NEWER-CARRY',context.targetIssueDate)]};
    response=await command(1,'interleave-orders',{type:'data.importBatch',inputs:[input]});assert.equal(response.status,200,await response.text());
    const ids=await pool.query<{id:string;do_no:string}>('SELECT id,do_no FROM source_orders ORDER BY do_no'),newerId=ids.rows.find(value=>value.do_no==='NEWER-CARRY')!.id;
    const selectedResponse=await fetch(`${baseUrl}/api/inventory/draft`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({fromDate:context.asOfDate,toDate:addDays(context.asOfDate,2),demandThrough:addDays(context.asOfDate,2),sourceOrderIds:[newerId]})});let draft=await json(selectedResponse);
    response=await command(2,'interleave-newer-plan',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});let workspace=await json(response),newerJob=workspace.state.jobs.find((value:any)=>value.orderNo==='NEWER-CARRY');assert.ok(newerJob);
    const yesterday=addDays(context.asOfDate,-1);await pool.query(`UPDATE jobs SET planning_date=$2::date,payload=jsonb_set(jsonb_set(payload,'{date}',to_jsonb($2::text)),'{notBefore}',to_jsonb(($2::date::text||'T07:00:00+08:00')::text)) WHERE id=$1`,[newerJob.id,yesterday]);
    draft=await json(await draftRequest(context.asOfDate,addDays(context.asOfDate,2)));const olderDraft=draft.jobs.find((value:any)=>value.orderNo==='OLDER-DEMAND'),carry=draft.carryovers.find((value:any)=>value.jobId===newerJob.id);assert.ok(olderDraft);assert.ok(carry);assert.ok(Date.parse(olderDraft.notBefore)<=Date.parse(carry.notBefore));
    response=await command(3,'interleave-commit',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});workspace=await json(response);
    const olderJob=workspace.state.jobs.find((value:any)=>value.orderNo==='OLDER-DEMAND'),finalNewer=workspace.state.jobs.find((value:any)=>value.id===newerJob.id);assert.ok(olderJob);assert.ok(finalNewer);assert.equal(olderJob.lineId,finalNewer.lineId);assert.equal(olderJob.date,finalNewer.date);assert.ok(olderJob.sequence<finalNewer.sequence);
    const schedules=new Map(getScheduledJobs(workspace.state).map(value=>[value.id,value]));assert.ok(schedules.get(olderJob.id)!.plannedStart!<schedules.get(finalNewer.id)!.plannedStart!);
  });

  it('reserves a partial multi-day continuation and rejects a stale concurrent commit',async()=>{
    const zero={...stockReport(),digest:hash('multi-zero'),stockRows:stockReport().stockRows.map(item=>({...item,opening:0,closing:0}))};
    let response=await command(0,'multi-stock',{type:'inventory.importStockReports',reports:[zero],reconcile:false,reason:''});assert.equal(response.status,200,await response.text());
    const input={date:contextDate(),lineId:'PM1',orderNo:'MULTI',productCode:'5220',description:'Multi-day continuation',bin:'',mode:'bags',bagCount:2500,quantityMt:125,remarks:'',productionPurpose:'mts',bagWeightKgSnapshot:50};
    response=await command(1,'multi-create',{type:'job.create',input});let workspace=await json(response),jobId=workspace.state.jobs[0].id,now=new Date().toISOString();
    await pool.query(`UPDATE jobs SET status='running',payload=jsonb_set(jsonb_set(payload,'{status}','"running"'::jsonb),'{actualStart}',to_jsonb($2::text)) WHERE id=$1`,[jobId,now]);
    let draft=await json(await draftRequest(contextDate(),addDays(contextDate(),2)));assert.equal(draft.carryovers.length,1);assert.equal(draft.carryovers[0].kind,'continuation');
    const dates=new Set(draft.carryovers[0].segments.filter((segment:any)=>segment.kind==='production').map((segment:any)=>new Date(segment.start+8*3_600_000).toISOString().slice(0,10)));assert.ok(dates.size>=2);
    response=await command(2,'multi-start-race',{type:'job.pause',jobId,reason:'Concurrent operator pause'});workspace=await json(response);
    response=await command(2,'multi-stale',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'STALE_REVISION');
    draft=await json(await draftRequest(contextDate(),addDays(contextDate(),2)));response=await command(3,'multi-fresh',{type:'planning.commitDraft',previewRevision:draft.revision,jobs:draft.jobs,carryovers:draft.carryovers});workspace=await json(response);assert.ok(workspace.state.jobs.find((job:any)=>job.id===jobId).continuationPlan);assert.equal((await pool.query('SELECT 1 FROM job_continuation_reservations WHERE job_id=$1',[jobId])).rowCount,1);
  });

  async function preview(input:SourceImportInput){return fetch(`${baseUrl}/api/data/preview`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify(input)})}
  async function draftRequest(fromDate:string,toDate:string){return fetch(`${baseUrl}/api/inventory/draft`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({fromDate,toDate,demandThrough:toDate})})}
  async function command(expectedRevision:number,commandId:string,value:unknown){return fetch(`${baseUrl}/api/commands`,{method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({expectedRevision,commandId,command:value})})}
});

function source(doNo:string,deliveryDate:string,asOfDate:string,sheetName='Manual mapped'):SourceImportInput{return{fileName:'sap.xlsx',sheetName,digest:hash(`${doNo}-${sheetName}-${deliveryDate}`),asOfDate,rows:[row(doNo,deliveryDate)]}}
function row(doNo:string,deliveryDate:string):SourceOrderFields{return{doNo,deliveryDate,soldToParty:'Customer',shipToParty:'Customer',materialCode:'7.0312008522050',description:'FS 5220 BROILER FINISHER PELLET II 50KG',quantity:100,unit:'Bags',deliveryLeadDays:1,remark:'',daysOutstanding:null,medication:'',fmrOmed:''}}
function stockReport(){return{fileName:'stock.xlsm',digest:hash('stock'),sheetName:'19th',asOfDate:contextDate(),stockRows:[{materialCode:'7.0312008522050',description:'FS 5220 BROILER FINISHER PELLET II 50KG',unit:'Bags',bagWeightKg:50,strategy:'mto',targetQuantity:0,needsReview:false,opening:200,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:200,medication:'',fmrOmed:''}]}}
function contextDate(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));return`${value.year}-${value.month}-${value.day}`}
function addDays(date:string,days:number){const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
function hash(value:string){return createHash('sha256').update(value).digest('hex')}
async function json(response:Response){assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>}
