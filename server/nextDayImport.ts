import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SourceImportInput, SourceImportPreview } from '../src/domain/sourceTypes';
import type { AppState } from '../src/domain/types';
import { ApiError } from './errors';
import { recalculateReservations } from './inventory';
import { applySourceImport, previewSourceImport } from './sourceData';
import { syncSapOrders } from './dailyImport';

export const MALAYSIA_TIME_ZONE='Asia/Kuala_Lumpur' as const;

export interface SapImportContext { asOfDate:string; targetIssueDate:string; timeZone:typeof MALAYSIA_TIME_ZONE; revision:number }

export async function readSapImportContext(db:pg.Pool|pg.PoolClient,now=new Date()):Promise<SapImportContext>{
  const revision=await db.query<{revision:string}>('SELECT revision::text FROM workspace WHERE id=1');
  const asOfDate=malaysiaDate(now);
  return{asOfDate,targetIssueDate:addUtcDays(asOfDate,1),timeZone:MALAYSIA_TIME_ZONE,revision:Number(revision.rows[0]?.revision??0)};
}

export async function previewNextDaySourceImport(db:pg.Pool|pg.PoolClient,input:SourceImportInput,now=new Date()):Promise<SourceImportPreview&{asOfDate:string;targetIssueDate:string}>{
  const context=await readSapImportContext(db,now);
  validateNextDayInputs([input],context);
  return{...(await previewSourceImport(db,input)),asOfDate:context.asOfDate,targetIssueDate:context.targetIssueDate};
}

/** Strict public SAP admission wrapper. applySourceImport remains an internal historical-fixture primitive. */
export async function importNextDaySourceBatch(client:pg.PoolClient,state:AppState,inputs:SourceImportInput[],nowIso:string):Promise<AppState>{
  const context=await readSapImportContext(client,new Date(nowIso));
  validateNextDayInputs(inputs,context);
  const digest=canonicalHash(inputs.flatMap(input=>input.rows).map(row=>({doNo:row.doNo.trim().toUpperCase(),materialCode:row.materialCode.trim().toUpperCase(),fields:row})).sort((a,b)=>`${a.doNo}\0${a.materialCode}`.localeCompare(`${b.doNo}\0${b.materialCode}`)));
  let next=state;
  for(const input of inputs){
    const applied=await applySourceImport(client,next,input,nowIso);
    next=applied.state;
    await client.query(`UPDATE source_imports SET import_mode='sap-append' WHERE workspace_id=1 AND digest=$1 AND as_of_date=$2::date`,[input.digest,input.asOfDate]);
    await syncSapOrders(client,input,nowIso);
  }
  const existing=await client.query<{id:string}>('SELECT id FROM order_admission_batches WHERE workspace_id=1 AND target_date=$1::date AND semantic_digest=$2 FOR UPDATE',[context.targetIssueDate,digest]);
  const batchId=existing.rows[0]?.id??`admission-${randomUUID()}`;
  if(!existing.rowCount)await client.query(`INSERT INTO order_admission_batches(id,workspace_id,target_date,semantic_digest,accepted_at,row_count) VALUES($1,1,$2::date,$3,$4::timestamptz,$5)`,[batchId,context.targetIssueDate,digest,nowIso,inputs.reduce((sum,input)=>sum+input.rows.length,0)]);
  let ordinal=0;
  for(const input of inputs){
    for(const row of input.rows){
      const identity=await client.query<{id:string}>(`SELECT id FROM source_orders WHERE workspace_id=1 AND lower(btrim(do_no))=lower(btrim($1)) AND lower(btrim(material_code))=lower(btrim($2))`,[row.doNo,row.materialCode]);
      if(!identity.rowCount)throw new Error('Admitted source identity was not persisted.');
      const sourceOrderId=identity.rows[0].id;
      await client.query(`UPDATE inventory_orders SET admission_batch_id=COALESCE(admission_batch_id,$2),admission_ordinal=COALESCE(admission_ordinal,$3),updated_at=CASE WHEN admission_batch_id IS NULL THEN $4::timestamptz ELSE updated_at END WHERE source_order_id=$1`,[sourceOrderId,batchId,ordinal,nowIso]);
      const discrepancy=await client.query(`SELECT 1 FROM source_order_discrepancies WHERE workspace_id=1 AND source_order_id=$1 AND status='pending' LIMIT 1`,[sourceOrderId]);
      if(discrepancy.rowCount)await client.query(`UPDATE inventory_orders SET planning_control='review',planning_control_reason='SAP values differ from the retained order identity',planning_control_updated_at=$2::timestamptz,needs_review=true,updated_at=$2::timestamptz WHERE source_order_id=$1 AND planning_control='active'`,[sourceOrderId,nowIso]);
      ordinal++;
    }
  }
  await recalculateReservations(client,nowIso);
  return next;
}

export function validateNextDayInputs(inputs:SourceImportInput[],context:{asOfDate:string;targetIssueDate:string}):void{
  if(!inputs.length)throw new ApiError(400,'SAP_IMPORT_EMPTY','At least one SAP worksheet containing next-day orders is required.');
  const identities=new Set<string>();
  let count=0;
  for(const input of inputs){
    if(input.asOfDate!==context.asOfDate)throw new ApiError(409,'IMPORT_TARGET_DATE_CHANGED','The Malaysia import date changed. Refresh the import context and preview the workbook again.');
    for(const row of input.rows){
      count++;
      if(row.deliveryDate!==context.targetIssueDate)throw new ApiError(400,'SAP_ORDER_NOT_NEXT_DAY',`Only orders with Goods Issue Date ${context.targetIssueDate} can be imported.`);
      const key=`${row.doNo.trim().toUpperCase()}\0${row.materialCode.trim().toUpperCase()}`;
      if(identities.has(key))throw new ApiError(400,'SAP_ORDER_DUPLICATE','The same DO and material appears more than once across the selected worksheets.');
      identities.add(key);
    }
  }
  if(!count)throw new ApiError(400,'SAP_IMPORT_EMPTY','No next-day SAP orders were provided.');
}

function malaysiaDate(now:Date):string{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:MALAYSIA_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return`${value.year}-${value.month}-${value.day}`;
}
function addUtcDays(date:string,days:number):string{const parsed=new Date(`${date}T00:00:00Z`);parsed.setUTCDate(parsed.getUTCDate()+days);return parsed.toISOString().slice(0,10)}
function canonicalHash(value:unknown):string{return createHash('sha256').update(canonical(value)).digest('hex')}
function canonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;const row=value as Record<string,unknown>;return`{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`}
