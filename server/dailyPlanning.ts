import type pg from 'pg';
import { applyDraftCarryovers } from '../src/domain/inventoryPlanner';
import { getAvailableIntervals, getRate, getScheduledJobs } from '../src/domain/engine';
import { getJobSourceAllocations } from '../src/domain/jobSources';
import { quantityToScaled, scaledToQuantity } from '../src/domain/inventory';
import type { CarryoverCandidate, CarryoverPlanningContext, DraftCarryover, PortableDailyPlanning } from '../src/domain/dailyPlanning';
import {randomUUID} from 'node:crypto';
import type { AppState, HistoryEvent, Job } from '../src/domain/types';
import { ApiError } from './errors';

const MYT_OFFSET=8*60*60*1000;

interface AdmissionPriority { target_date:string|Date; admission_ordinal:number; planning_control:string }

export async function buildCarryoverPlanningContext(client:pg.PoolClient,state:AppState,nowIso:string):Promise<CarryoverPlanningContext>{
  const candidates:CarryoverCandidate[]=[];
  const seen=new Set<string>(),today=malaysiaDate(nowIso),now=Date.parse(nowIso);
  for(const job of state.jobs){
    if(seen.has(job.id)||job.status==='completed'||job.status==='cancelled')continue;
    const sourceIds=getJobSourceAllocations(job).map(row=>row.sourceOrderId);
    let priority:AdmissionPriority;
    if(sourceIds.length){
      const priorities=await client.query<AdmissionPriority>(`WITH ranked AS (SELECT io.source_order_id,b.target_date,io.planning_control,(row_number() OVER(PARTITION BY b.target_date ORDER BY b.accepted_at,b.id,io.admission_ordinal)-1)::integer admission_ordinal FROM inventory_orders io JOIN order_admission_batches b ON b.id=io.admission_batch_id WHERE io.workspace_id=1) SELECT target_date,admission_ordinal,planning_control FROM ranked WHERE source_order_id=ANY($1::text[]) ORDER BY target_date,admission_ordinal`,[sourceIds]);
      if(priorities.rowCount!==new Set(sourceIds).size||priorities.rows.some(row=>row.planning_control!=='active'))continue;
      priority=priorities.rows[0];
    }else priority={target_date:job.date,admission_ordinal:job.sequence,planning_control:'active'};
    const posted=await postedNative(client,job,state.settings.bagWeightKg);
    const movementHistory=await productionMovementHistory(client,job.id);
    const locked=job.lockedSegments?.length??0;
    if(job.date<today&&job.status==='pending'&&!job.actualStart&&!locked&&!movementHistory){
      seen.add(job.id);candidates.push(candidate(job,'reschedule',nativeTotal(job),priority));continue;
    }
    // A corrected-to-zero receipt still proves that physical production happened.
    // Keep it on the original PM and surface the whole remainder as continuation.
    if(!job.actualStart&&!locked&&posted===0&&!movementHistory&&job.status!=='running')continue;
    const unit=job.mode==='bags'?'Bags':'MT';
    const futureCapacity=quantizeDown(unit,nativeFutureLockedCapacity(state,job,now));
    const remaining=quantizeDown(unit,Math.max(0,nativeTotal(job)-posted-futureCapacity));
    if(remaining<=unitEpsilon(job))continue;
    seen.add(job.id);candidates.push(candidate(job,'continuation',remaining,priority));
  }
  candidates.sort((a,b)=>a.priorityDate.localeCompare(b.priorityDate)||a.ordinal-b.ordinal||(a.kind==='continuation'?-1:1)||a.jobId.localeCompare(b.jobId));
  return{candidates};
}

export async function applyAndPersistDraftCarryovers(client:pg.PoolClient,state:AppState,rows:DraftCarryover[],nowIso:string):Promise<AppState>{
  if(!rows.length)return state;
  const normalizedRows=rows.map(row=>normalizeCarryoverAtCommit(state,row,nowIso));
  const trusted=await buildCarryoverPlanningContext(client,state,nowIso),byId=new Map(trusted.candidates.map(row=>[row.jobId,row]));
  if(new Set(normalizedRows.map(row=>row.jobId)).size!==normalizedRows.length)throw new ApiError(400,'DRAFT_CARRYOVER_DUPLICATE','A card may appear only once in carryover planning.');
  for(const row of normalizedRows){
    const fact=byId.get(row.jobId);
    if(!fact||fact.kind!==row.kind||fact.unit!==row.unit||Math.abs(fact.remainingQuantity-row.remainingQuantity)>unitEpsilonFromUnit(row.unit)||fact.priorityDate!==row.priorityDate||fact.ordinal!==row.ordinal||fact.originalDate!==row.originalDate||fact.originalLineId!==row.originalLineId)throw new ApiError(409,'STALE_CARRYOVER','Production status or posted output changed after this draft was generated. Generate it again.');
    validateCarryoverPlacement(state,row,nowIso);
  }
  let next:AppState;
  try{next=applyDraftCarryovers(state,normalizedRows,nowIso)}catch(error){throw new ApiError(409,'STALE_CARRYOVER',error instanceof Error?error.message:'Carryover is no longer valid.');}
  for(const row of normalizedRows.filter(row=>row.kind==='reschedule')){
    const scheduled=getScheduledJobs(next).find(job=>job.id===row.jobId);
    const last=[...row.segments].sort((a,b)=>b.end-a.end)[0],businessDate=last?businessDateForSegment(state,row.lineId,last):null,horizonEnd=businessDate?Math.max(...getAvailableIntervals(state.settings,row.lineId,businessDate).map(slot=>slot.end)):Number.NEGATIVE_INFINITY;
    if(!scheduled||scheduled.plannedStart===null||scheduled.plannedEnd===null||scheduled.lineId!==row.lineId||scheduled.plannedEnd>horizonEnd+1)throw new ApiError(409,'DRAFT_CAPACITY_CHANGED','The rescheduled card no longer fits the selected line and horizon. Generate the draft again.');
  }
  for(const row of normalizedRows){
    if(row.kind==='reschedule'){await client.query('DELETE FROM job_continuation_reservations WHERE job_id=$1',[row.jobId]);continue;}
    const job=next.jobs.find(candidate=>candidate.id===row.jobId)!;
    const unit=job.mode==='bags'?'Bags':'MT';
    const rawNative=unit==='Bags'?(job.continuationPlan!.remainingQuantityMt*1000/(job.bagWeightKgSnapshot??state.settings.bagWeightKg)):job.continuationPlan!.remainingQuantityMt;
    const plannedNative=unit==='Bags'?Math.round(rawNative):Math.round(rawNative*1_000)/1_000;
    if(plannedNative<=0||Math.abs(rawNative-plannedNative)>unitEpsilonFromUnit(unit))throw new ApiError(409,'DRAFT_CARRYOVER_QUANTITY_INVALID','Continuation capacity must represent whole bags or MT with at most three decimals.');
    await client.query(`INSERT INTO job_continuation_reservations(job_id,workspace_id,remaining_quantity_scaled,unit,planning_date,line_id,not_before,segments,planned_at) VALUES($1,1,$2,$3,$4::date,$5,$6::timestamptz,$7::jsonb,$8::timestamptz) ON CONFLICT(job_id) DO UPDATE SET remaining_quantity_scaled=EXCLUDED.remaining_quantity_scaled,unit=EXCLUDED.unit,planning_date=EXCLUDED.planning_date,line_id=EXCLUDED.line_id,not_before=EXCLUDED.not_before,segments=EXCLUDED.segments,planned_at=EXCLUDED.planned_at`,[row.jobId,quantityToScaled(unit,plannedNative),unit,row.date,row.lineId,row.notBefore,JSON.stringify(row.segments),nowIso]);
  }
  const events:HistoryEvent[]=normalizedRows.map(row=>{const job=next.jobs.find(candidate=>candidate.id===row.jobId),planned=row.kind==='continuation'&&job?.continuationPlan?(row.unit==='Bags'?job.continuationPlan.remainingQuantityMt*1_000/(job.bagWeightKgSnapshot??state.settings.bagWeightKg):job.continuationPlan.remainingQuantityMt):row.remainingQuantity;return{id:`event-${randomUUID()}`,at:nowIso,type:row.kind==='reschedule'?'planning.carryover.rescheduled':'planning.carryover.reserved',jobId:row.jobId,message:row.kind==='reschedule'?`Moved unfinished production from ${row.originalDate} ${row.originalLineId} to ${row.date} ${row.lineId}.`:`Reserved continuation capacity for ${Number(planned.toFixed(row.unit==='Bags'?0:3))} ${row.unit} on ${row.lineId}.`};});
  return{...next,jobs:next.jobs.map(job=>normalizedRows.some(row=>row.jobId===job.id)?{...job,updatedAt:nowIso}:job),events:[...next.events,...events]};
}

/** Recheck rescheduled cards after newly generated cards have been inserted/resequenced. */
export function assertFinalReschedulePlacements(state:AppState,rows:DraftCarryover[]):void{
  if(!rows.some(row=>row.kind==='reschedule'))return;
  const scheduledById=new Map(getScheduledJobs(state).map(job=>[job.id,job]));
  for(const row of rows){
    if(row.kind!=='reschedule')continue;
    const scheduled=scheduledById.get(row.jobId),last=[...row.segments].sort((a,b)=>b.end-a.end)[0];
    const businessDate=last?businessDateForSegment(state,row.lineId,last):null;
    const intervals=businessDate?getAvailableIntervals(state.settings,row.lineId,businessDate):[];
    const horizonEnd=intervals.length?Math.max(...intervals.map(slot=>slot.end)):Number.NEGATIVE_INFINITY;
    if(!scheduled||scheduled.plannedStart===null||scheduled.plannedEnd===null||scheduled.lineId!==row.lineId||scheduled.plannedEnd>horizonEnd+1){
      throw new ApiError(409,'DRAFT_CAPACITY_CHANGED','The rescheduled card no longer fits the selected line and horizon. Generate the draft again.');
    }
  }
}

export async function clearContinuationReservation(client:pg.PoolClient,jobId:string):Promise<void>{await client.query('DELETE FROM job_continuation_reservations WHERE job_id=$1',[jobId])}

/** Reconcile already-confirmed future capacity after an actual-output mutation. It never expands capacity. */
export async function reconcileContinuationReservation(client:pg.PoolClient,state:AppState,jobId:string,nowIso:string):Promise<AppState>{
  const job=state.jobs.find(candidate=>candidate.id===jobId);if(!job)return state;
  const stored=await client.query<{segments:any;unit:'Bags'|'MT';planning_date:string|Date;line_id:Job['lineId'];not_before:string|Date;planned_at:string|Date}>(`SELECT segments,unit,planning_date,line_id,not_before,planned_at FROM job_continuation_reservations WHERE job_id=$1 FOR UPDATE`,[jobId]);
  const history=await productionMovementHistory(client,jobId);
  if(!stored.rowCount){
    if(job.status==='pending'&&history)return persistZeroContinuation(client,state,job,history.lastRecordedAt,nowIso);
    return state;
  }
  if(job.status==='completed'||job.status==='cancelled')return removeContinuation(client,state,jobId);
  const unit=job.mode==='bags'?'Bags':'MT',now=Date.parse(nowIso),posted=await postedNative(client,job,state.settings.bagWeightKg);
  const fullRemaining=quantizeDown(unit,Math.max(0,nativeTotal(job)-posted-quantizeDown(unit,nativeFutureLockedCapacity(state,job,now))));
  if(fullRemaining<=unitEpsilonFromUnit(unit))return persistZeroContinuation(client,state,job,history?.lastRecordedAt??nowIso,nowIso);
  const future=(stored.rows[0].segments as DraftCarryover['segments']).filter(segment=>segment.end>now).sort((a,b)=>a.start-b.start);
  const rate=getRate(state.settings,job.lineId,job.productCode),mtPerNative=unit==='Bags'?(job.bagWeightKgSnapshot??state.settings.bagWeightKg)/1_000:1;
  let remainingMs=fullRemaining*mtPerNative/rate*60*60_000;
  const kept:DraftCarryover['segments']=[];
  for(const segment of future){
    if(segment.kind==='changeover'){if(remainingMs>0)kept.push(segment);continue;}
    if(remainingMs<=0)break;
    const start=Math.max(segment.start,now),used=Math.min(segment.end-start,remainingMs);
    if(used>0)kept.push({...segment,start,end:start+used});remainingMs-=used;
  }
  const productionMs=kept.filter(segment=>segment.kind==='production').reduce((sum,segment)=>sum+segment.end-segment.start,0);
  const rawNative=productionMs/3_600_000*rate/mtPerNative,plannedNative=unit==='Bags'?Math.floor(rawNative+1e-7):Math.floor((rawNative+1e-9)*1_000)/1_000;
  if(!kept.length||plannedNative<=0)return persistZeroContinuation(client,state,job,history?.lastRecordedAt??nowIso,nowIso);
  const finalSegments=trimProductionSegments(kept,plannedNative*mtPerNative/rate*3_600_000);
  await client.query(`UPDATE job_continuation_reservations SET remaining_quantity_scaled=$2,segments=$3::jsonb,not_before=$4::timestamptz WHERE job_id=$1`,[jobId,quantityToScaled(unit,plannedNative),JSON.stringify(finalSegments),new Date(finalSegments[0].start).toISOString()]);
  const remainingQuantityMt=plannedNative*mtPerNative;
  return{...state,jobs:state.jobs.map(candidate=>candidate.id===jobId?{...candidate,continuationPlan:{remainingQuantityMt,plannedAt:new Date(stored.rows[0].planned_at).toISOString(),segments:finalSegments}}:candidate)};
}

async function removeContinuation(client:pg.PoolClient,state:AppState,jobId:string):Promise<AppState>{await clearContinuationReservation(client,jobId);return{...state,jobs:state.jobs.map(job=>{if(job.id!==jobId)return job;const{continuationPlan:_removed,...rest}=job;return rest;})}}

async function persistZeroContinuation(client:pg.PoolClient,state:AppState,job:Job,plannedAt:string,nowIso:string):Promise<AppState>{
  if(job.status!=='pending')return removeContinuation(client,state,job.id);
  const anchored=anchorUnaffectedFutureJobs(state,job.id,plannedAt);
  await client.query(`INSERT INTO job_continuation_reservations(job_id,workspace_id,remaining_quantity_scaled,unit,planning_date,line_id,not_before,segments,planned_at) VALUES($1,1,0,$2,$3::date,$4,$5::timestamptz,'[]'::jsonb,$6::timestamptz) ON CONFLICT(job_id) DO UPDATE SET remaining_quantity_scaled=0,unit=EXCLUDED.unit,planning_date=EXCLUDED.planning_date,line_id=EXCLUDED.line_id,not_before=EXCLUDED.not_before,segments='[]'::jsonb,planned_at=EXCLUDED.planned_at`,[job.id,job.mode==='bags'?'Bags':'MT',job.date,job.lineId,plannedAt,plannedAt]);
  return{...anchored,jobs:anchored.jobs.map(candidate=>candidate.id===job.id?{...candidate,updatedAt:nowIso,continuationPlan:{remainingQuantityMt:0,plannedAt,segments:[]}}:candidate)};
}

function anchorUnaffectedFutureJobs(state:AppState,jobId:string,plannedAt:string):AppState{
  const cutoff=Date.parse(plannedAt),scheduled=getScheduledJobs(state);
  const floors=new Map(scheduled.filter(row=>row.id!==jobId&&row.status==='pending'&&row.plannedStart!==null&&(row.plannedEnd??0)>cutoff).map(row=>[row.id,row.plannedStart!]));
  if(!floors.size)return state;
  return{...state,jobs:state.jobs.map(job=>{const floor=floors.get(job.id);return floor===undefined?job:{...job,notBefore:new Date(Math.max(floor,Date.parse(job.notBefore??'1970-01-01T00:00:00Z'))).toISOString()};})};
}

export async function exportDailyPlanning(db:pg.Pool|pg.PoolClient):Promise<PortableDailyPlanning>{
  const batches=await db.query<any>('SELECT * FROM order_admission_batches WHERE workspace_id=1 ORDER BY target_date,accepted_at,id');
  const orders=await db.query<any>('SELECT admission_batch_id,source_order_id,admission_ordinal FROM inventory_orders WHERE workspace_id=1 AND admission_batch_id IS NOT NULL ORDER BY admission_batch_id,admission_ordinal');
  const continuations=await db.query<any>('SELECT * FROM job_continuation_reservations WHERE workspace_id=1 ORDER BY job_id');
  return{admissionBatches:batches.rows.map((row:any)=>({id:row.id,targetDate:dbDate(row.target_date),semanticDigest:row.semantic_digest,acceptedAt:new Date(row.accepted_at).toISOString(),rowCount:row.row_count})),orderAdmissions:orders.rows.map((row:any)=>({batchId:row.admission_batch_id,sourceOrderId:row.source_order_id,ordinal:row.admission_ordinal})),continuationReservations:continuations.rows.map((row:any)=>({jobId:row.job_id,remainingQuantity:scaledToQuantity(row.unit,Number(row.remaining_quantity_scaled)),unit:row.unit,date:dbDate(row.planning_date),lineId:row.line_id,notBefore:new Date(row.not_before).toISOString(),segments:row.segments,plannedAt:new Date(row.planned_at).toISOString()}))};
}

export async function clearDailyPlanning(client:pg.PoolClient):Promise<void>{await client.query('DELETE FROM job_continuation_reservations WHERE workspace_id=1');await client.query('UPDATE inventory_orders SET admission_batch_id=NULL,admission_ordinal=NULL WHERE workspace_id=1');await client.query('DELETE FROM order_admission_batches WHERE workspace_id=1')}

export async function restoreDailyPlanning(client:pg.PoolClient,data:PortableDailyPlanning):Promise<void>{
  await clearDailyPlanning(client);
  for(const batch of data.admissionBatches)await client.query(`INSERT INTO order_admission_batches(id,workspace_id,target_date,semantic_digest,accepted_at,row_count) VALUES($1,1,$2::date,$3,$4::timestamptz,$5)`,[batch.id,batch.targetDate,batch.semanticDigest,batch.acceptedAt,batch.rowCount]);
  for(const admission of data.orderAdmissions)await client.query('UPDATE inventory_orders SET admission_batch_id=$2,admission_ordinal=$3 WHERE source_order_id=$1',[admission.sourceOrderId,admission.batchId,admission.ordinal]);
  for(const row of data.continuationReservations)await client.query(`INSERT INTO job_continuation_reservations(job_id,workspace_id,remaining_quantity_scaled,unit,planning_date,line_id,not_before,segments,planned_at) VALUES($1,1,$2,$3,$4::date,$5,$6::timestamptz,$7::jsonb,$8::timestamptz)`,[row.jobId,quantityToScaled(row.unit,row.remainingQuantity),row.unit,row.date,row.lineId,row.notBefore,JSON.stringify(row.segments),row.plannedAt]);
}

function candidate(job:Job,kind:'reschedule'|'continuation',remaining:number,priority:AdmissionPriority):CarryoverCandidate{return{jobId:job.id,kind,remainingQuantity:remaining,unit:job.mode==='bags'?'Bags':'MT',priorityDate:dbDate(priority.target_date),ordinal:priority.admission_ordinal,originalDate:job.date,originalLineId:job.lineId}}
function nativeTotal(job:Job):number{return job.mode==='bags'?job.bagCount??0:job.quantityMt}
async function postedNative(client:pg.PoolClient,job:Job,defaultBagWeightKg:number):Promise<number>{const result=await client.query<{total:string}>(`SELECT COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0)::text total FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.job_id=$1`,[job.id]);const ledger=scaledToQuantity(job.mode==='bags'?'Bags':'MT',Number(result.rows[0].total));if(job.inventoryItemId)return ledger;const actual=typeof job.actualQuantityMt==='number'?job.mode==='bags'?job.actualQuantityMt*1_000/(job.bagWeightKgSnapshot??defaultBagWeightKg):job.actualQuantityMt:0;return Math.max(ledger,actual)}
async function productionMovementHistory(client:pg.PoolClient,jobId:string):Promise<{lastRecordedAt:string}|null>{const result=await client.query<{last_recorded_at:string|Date}>(`SELECT max(l.recorded_at) last_recorded_at FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.job_id=$1 AND (l.movement_type='production' OR (l.movement_type='reversal' AND original.movement_type='production'))`,[jobId]);const value=result.rows[0]?.last_recorded_at;return value?{lastRecordedAt:new Date(value).toISOString()}:null}
function nativeFutureLockedCapacity(state:AppState,job:Job,now:number):number{const minutes=(job.lockedSegments??[]).filter(segment=>segment.kind==='production'&&segment.end>now).reduce((sum,segment)=>sum+(segment.end-Math.max(segment.start,now))/60_000,0);const mt=minutes/60*getRate(state.settings,job.lineId,job.productCode);return job.mode==='bags'?mt*1000/(job.bagWeightKgSnapshot??state.settings.bagWeightKg):mt}
function validateCarryoverPlacement(state:AppState,row:DraftCarryover,nowIso:string):void{
  if(!row.segments.length)throw new ApiError(400,'DRAFT_CARRYOVER_EMPTY','A carryover must reserve production time.');
  if(row.kind==='continuation'&&row.lineId!==row.originalLineId)throw new ApiError(400,'CONTINUATION_LINE_FIXED','Started production must continue on its original PM.');
  const job=state.jobs.find(job=>job.id===row.jobId);if(!job)throw new ApiError(409,'STALE_CARRYOVER','The production card no longer exists.');
  if(row.kind==='reschedule')return;
  const occupied=[...getScheduledJobs(state).filter(scheduled=>scheduled.id!==row.jobId).flatMap(scheduled=>scheduled.segments),...(row.kind==='continuation'?job.lockedSegments??[]:[])];
  const now=Date.parse(nowIso);
  let productionMinutes=0;
  const ordered=[...row.segments].sort((a,b)=>a.start-b.start||a.end-b.end);
  if(ordered.some((segment,index)=>index>0&&segment.start<ordered[index-1].end))throw new ApiError(400,'DRAFT_CARRYOVER_SEGMENT_OVERLAP','Carryover segments cannot overlap each other.');
  if(!getAvailableIntervals(state.settings,row.lineId,row.date).some(slot=>ordered[0].start>=slot.start&&ordered[0].end<=slot.end))throw new ApiError(400,'DRAFT_CARRYOVER_DATE_INVALID','Carryover date must match the working day of its first reserved segment.');
  for(const segment of ordered){
    if(segment.jobId!==row.jobId||segment.lineId!==row.lineId)throw new ApiError(400,'DRAFT_CARRYOVER_SEGMENT_INVALID','Carryover segments do not match the selected card and PM.');
    if(segment.start<now)throw new ApiError(409,'DRAFT_CARRYOVER_PAST','Carryover capacity cannot start in the past. Generate the draft again.');
    const mytDate=new Date(segment.start+MYT_OFFSET).toISOString().slice(0,10),previous=addDays(mytDate,-1);
    const within=[mytDate,previous].some(date=>getAvailableIntervals(state.settings,row.lineId,date).some(slot=>segment.start>=slot.start&&segment.end<=slot.end));
    if(!within||occupied.some(other=>other.lineId===row.lineId&&segment.start<other.end&&segment.end>other.start))throw new ApiError(409,'DRAFT_CAPACITY_CHANGED','Carryover time is no longer available. Generate the draft again.');
    if(segment.kind==='production')productionMinutes+=(segment.end-segment.start)/60_000;
  }
  const mt=productionMinutes/60*getRate(state.settings,row.lineId,job.productCode),native=row.unit==='Bags'?mt*1_000/(job.bagWeightKgSnapshot??state.settings.bagWeightKg):mt;
  if(native-row.remainingQuantity>unitEpsilonFromUnit(row.unit))throw new ApiError(400,'DRAFT_CARRYOVER_EXCEEDS_REMAINING','Continuation capacity exceeds the trusted unfinished quantity.');
}
function malaysiaDate(nowIso:string):string{return new Date(Date.parse(nowIso)+MYT_OFFSET).toISOString().slice(0,10)}
function dbDate(value:string|Date):string{return value instanceof Date?`${value.getFullYear().toString().padStart(4,'0')}-${(value.getMonth()+1).toString().padStart(2,'0')}-${value.getDate().toString().padStart(2,'0')}`:String(value).slice(0,10)}
function unitEpsilon(job:Job):number{return unitEpsilonFromUnit(job.mode==='bags'?'Bags':'MT')}
function unitEpsilonFromUnit(unit:'Bags'|'MT'):number{return unit==='Bags'?0.5:0.0005}
function quantizeDown(unit:'Bags'|'MT',value:number):number{return unit==='Bags'?Math.floor(value+1e-9):Math.floor((value+1e-9)*1_000)/1_000}
function addDays(date:string,days:number):string{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
function businessDateForSegment(state:AppState,lineId:Job['lineId'],segment:{start:number;end:number}):string|null{const mytDate=new Date(segment.start+MYT_OFFSET).toISOString().slice(0,10);return[mytDate,addDays(mytDate,-1)].find(date=>getAvailableIntervals(state.settings,lineId,date).some(slot=>segment.start>=slot.start&&segment.end<=slot.end))??null}
function trimProductionSegments(segments:DraftCarryover['segments'],targetMs:number):DraftCarryover['segments']{let remaining=targetMs;const result:DraftCarryover['segments']=[];for(const segment of segments){if(segment.kind==='changeover'){if(remaining>0)result.push(segment);continue;}if(remaining<=0)break;const used=Math.min(segment.end-segment.start,remaining);if(used>0)result.push({...segment,end:segment.start+used});remaining-=used;}return result}
function normalizeCarryoverAtCommit(state:AppState,row:DraftCarryover,nowIso:string):DraftCarryover{
  const now=Date.parse(nowIso);if(row.kind==='reschedule')return{...row,notBefore:new Date(Math.max(now,Date.parse(row.notBefore))).toISOString()};
  const job=state.jobs.find(candidate=>candidate.id===row.jobId);if(!job)throw new ApiError(409,'STALE_CARRYOVER','The production card no longer exists.');
  let segments=row.segments.filter(segment=>segment.end>now).map(segment=>segment.start<now?{...segment,start:now}:segment);
  const productionMs=segments.filter(segment=>segment.kind==='production').reduce((sum,segment)=>sum+segment.end-segment.start,0),rate=getRate(state.settings,row.lineId,job.productCode),mtPerNative=row.unit==='Bags'?(job.bagWeightKgSnapshot??state.settings.bagWeightKg)/1_000:1;
  const quantity=quantizeDown(row.unit,Math.min(row.remainingQuantity,productionMs/3_600_000*rate/mtPerNative));
  if(quantity<=0)throw new ApiError(409,'DRAFT_CARRYOVER_EXPIRED','The proposed continuation capacity has elapsed. Generate the draft again.');
  segments=trimProductionSegments(segments,quantity*mtPerNative/rate*3_600_000);
  const first=Math.min(...segments.map(segment=>segment.start)),mytDate=new Date(first+MYT_OFFSET).toISOString().slice(0,10),dates=[row.date,mytDate,addDays(mytDate,-1)];
  const date=dates.find((candidate,index)=>dates.indexOf(candidate)===index&&getAvailableIntervals(state.settings,row.lineId,candidate).some(slot=>first>=slot.start&&segments[0].end<=slot.end));
  if(!date)throw new ApiError(409,'DRAFT_CAPACITY_CHANGED','The remaining continuation capacity is outside the production calendar. Generate the draft again.');
  return{...row,date,notBefore:new Date(first).toISOString(),segments};
}
