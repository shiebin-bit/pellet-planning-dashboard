import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragEndEvent } from '@dnd-kit/core';
import { ArrowRightLeft, GripVertical, LockKeyhole, Plus } from 'lucide-react';
import { executeCommand } from '../domain/commands';
import { getJobSourceAllocations, getOrderTransferBatchIdentity, isTransferableOrderBatch } from '../domain/jobSources';
import { isJobPaused } from '../domain/production-results';
import type { Job, JobSourceAllocation, LineId, LineSchedule } from '../domain/types';
import type { MoveImpactInput } from '../domain/moveImpact';
import { dateLabel, durationLabel, fullDateTime, localDate, numberLabel, timeLabel, toDateTimeInput } from '../lib/format';
import { packagingLabel, productLabel } from '../lib/productLabel';
import { useOrderMetadata } from '../lib/useOrderMetadata';
import { useWorkspace } from '../lib/workspace';
import { StatusBadge } from './Shared';
import { DetailDialog } from './DetailDialog';
import './BatchPlanningBoard.css';

type TransferInput = {jobId:string;sourceOrderId:string;toLineId:LineId;targetJobId?:string};
type DragItem = {kind:'order'|'batch';jobId:string;sourceOrderId?:string};
const editable = isTransferableOrderBatch;
const compatible = (source:Job,target:Job) => editable(source)&&editable(target)&&source.id!==target.id&&getOrderTransferBatchIdentity(source)===getOrderTransferBatchIdentity(target);
const quantityLabel = (allocation:JobSourceAllocation) => `${numberLabel(allocation.plannedQuantity,allocation.sourceSnapshot.unit==='Bags'?0:3)} ${allocation.sourceSnapshot.unit}`;
const batchQuantity = (job:Job) => job.mode==='bags'?`${numberLabel(job.bagCount??0,0)} Bags`:`${numberLabel(job.quantityMt,3)} MT`;
const orderCollision:CollisionDetection = args => {
  const hits=args.pointerCoordinates?pointerWithin(args):rectIntersection(args);
  const batches=hits.filter(hit=>args.droppableContainers.find(container=>container.id===hit.id)?.data.current?.targetJobId);
  return batches.length?batches:hits;
};

/** Detailed batch workspace. Timeline/List stay available for time-scale and compact views. */
export function BatchPlanningBoard({lines,start,end,onOpen,onAdd,onMove}:{
  lines:LineSchedule[];start:number;end:number;onOpen:(id:string)=>void;
  onAdd:(lineId:LineId)=>void;onMove:(input:MoveImpactInput)=>void;
}) {
  const {state,storageMode,commit,mutationLocked,hasConflict,toast,confirmedRetry}=useWorkspace();
  const disabled=mutationLocked||hasConflict;
  const [active,setActive]=useState<DragItem|null>(null);
  const [overJob,setOverJob]=useState<string|null>(null);
  const [overLine,setOverLine]=useState<LineId|null>(null);
  const [moving,setMoving]=useState<{jobId:string;sourceOrderId:string}|null>(null);
  const [feedback,setFeedback]=useState('');
  const [failed,setFailed]=useState(false);
  const [saveFailed,setSaveFailed]=useState(false);
  const retrySeen=useRef(confirmedRetry?.nonce);
  const visible=lines.map(line=>({...line,jobs:line.jobs.filter(job=>job.segments.some(segment=>segment.kind==='production'&&segment.end>start&&segment.start<end))}));
  const jobs=visible.flatMap(line=>line.jobs);
  const {metadata}=useOrderMetadata(jobs,storageMode==='database');
  const activeJob=state.jobs.find(job=>job.id===active?.jobId);
  const activeOrder=activeJob&&getJobSourceAllocations(activeJob).find(row=>row.sourceOrderId===active?.sourceOrderId);
  const sensors=useSensors(
    useSensor(MouseSensor,{activationConstraint:{distance:7}}),
    useSensor(TouchSensor,{activationConstraint:{delay:220,tolerance:6}}),
    useSensor(KeyboardSensor,{keyboardCodes:{start:['Space'],end:['Space','Enter'],cancel:['Escape']}}),
  );
  useEffect(()=>{if(saveFailed&&toast?.error)setFeedback(toast.message);},[saveFailed,toast]);
  useEffect(()=>{
    if(confirmedRetry?.nonce===retrySeen.current)return;
    retrySeen.current=confirmedRetry?.nonce;
    if(confirmedRetry?.type==='job.transferOrder'){setMoving(null);setFailed(false);setSaveFailed(false);setFeedback('Order move confirmed. Batch quantities and schedules updated.');}
  },[confirmedRetry]);
  useEffect(()=>{setActive(null);setOverJob(null);setOverLine(null);setMoving(null);setFeedback('');},[start]);

  async function transfer(input:TransferInput) {
    if(disabled)return false;
    setFailed(false);setSaveFailed(false);setFeedback('');
    const command={type:'job.transferOrder' as const,...input};
    try{executeCommand(state,command,{nowIso:new Date().toISOString()});}
    catch(error){setFailed(true);setFeedback(error instanceof Error?error.message:'This order cannot be moved.');return false;}
    const saved=await commit(command,'Order moved. Batch quantities and schedules updated.');
    if(saved){setMoving(null);setFeedback('Order moved. Batch quantities and times have been recalculated.');}
    else{setFailed(true);setSaveFailed(true);setFeedback('The order was not moved. Review the save message or latest workspace before retrying.');}
    return saved;
  }
  function endDrag(event:DragEndEvent) {
    setActive(null);setOverJob(null);setOverLine(null);
    if(disabled||!event.over)return;
    const item=event.active.data.current as DragItem|undefined;
    const target=event.over.data.current;
    if(!item||!target?.lineId||target.targetJobId===item.jobId)return;
    if(item.kind==='batch')onMove({jobId:item.jobId,toLineId:target.lineId,...(target.targetJobId?{beforeJobId:target.targetJobId}:{})});
    else if(item.sourceOrderId)void transfer({jobId:item.jobId,sourceOrderId:item.sourceOrderId,toLineId:target.lineId,...(target.targetJobId?{targetJobId:target.targetJobId}:{})});
  }
  const movingJob=state.jobs.find(job=>job.id===moving?.jobId);
  const movingOrder=movingJob&&getJobSourceAllocations(movingJob).find(row=>row.sourceOrderId===moving?.sourceOrderId);
  return <section className="batch-workspace" aria-label="Production batches and orders" aria-busy={mutationLocked}>
    <p className="batch-instructions"><strong>One box, one production batch.</strong> Drag an order into another compatible box to combine, or into a PM's new-batch area to separate it. Use the batch header handle to move the whole run.</p>
    {feedback&&<p className={failed?'notice warning':'batch-feedback'} role="status">{feedback}</p>}
    <DndContext sensors={sensors} collisionDetection={orderCollision} onDragStart={event=>{setFeedback('');setFailed(false);setActive(event.active.data.current as DragItem);}} onDragOver={event=>{setOverJob(event.over?.data.current?.targetJobId??null);setOverLine(event.over?.data.current?.lineId??null);}} onDragCancel={()=>{setActive(null);setOverJob(null);setOverLine(null);}} onDragEnd={endDrag} accessibility={{
      screenReaderInstructions:{draggable:'Press Space to pick up an order or batch. Use arrow keys to move, Space to drop, Escape to cancel. The Move order button provides a non-drag alternative.'},
      announcements:{onDragStart:()=> 'Picked up production item.',onDragOver:({over})=>over?`Over ${over.data.current?.targetJobId?'production batch':'new batch area'} on ${over.data.current?.lineId}.`:'Outside the production lines.',onDragEnd:()=> 'Drop finished. Check the save result.',onDragCancel:()=> 'Move cancelled.'},
    }}>
      <div className="batch-board-grid">
        {visible.map(line=><BatchLine key={line.lineId} line={line} disabled={disabled} active={active} overLine={overLine} overJob={overJob} onAdd={()=>onAdd(line.lineId)}>
          {line.jobs.map(job=><BatchBox key={job.id} job={job} disabled={disabled} active={active} overJob={overJob} allowed={!!activeJob&&compatible(activeJob,job)} onOpen={()=>onOpen(job.id)}>
            {getJobSourceAllocations(job).map(allocation=>{
              const source=allocation.sourceSnapshot,current=metadata[allocation.sourceOrderId];
              return <OrderTile key={allocation.sourceOrderId} job={job} allocation={allocation} customer={source.shipToParty||source.soldToParty||current?.shipToParty||current?.soldToParty||'Customer not recorded'} dueDate={source.deliveryDate||current?.deliveryDate} disabled={disabled||!editable(job)} active={active} onOpen={()=>onOpen(job.id)} onMove={()=>{setFeedback('');setFailed(false);setMoving({jobId:job.id,sourceOrderId:allocation.sourceOrderId});}}/>;
            })}
          </BatchBox>)}
        </BatchLine>)}
      </div>
      <DragOverlay dropAnimation={null}>{activeJob&&<div className="batch-order-overlay"><GripVertical size={17}/><div><strong>{activeOrder?`DO ${activeOrder.sourceSnapshot.doNo}`:productLabel(activeJob)}</strong><span>{activeOrder?quantityLabel(activeOrder):batchQuantity(activeJob)} · {activeJob.lineId}</span></div></div>}</DragOverlay>
    </DndContext>
    {movingJob&&movingOrder&&<OrderMoveDialog key={`${movingJob.id}-${movingOrder.sourceOrderId}`} job={movingJob} allocation={movingOrder} jobs={jobs} disabled={disabled} feedback={feedback} onClose={()=>setMoving(null)} onSave={transfer}/>}
  </section>;
}

function BatchLine({line,disabled,active,overLine,overJob,onAdd,children}:{line:LineSchedule;disabled:boolean;active:DragItem|null;overLine:LineId|null;overJob:string|null;onAdd:()=>void;children:ReactNode}) {
  const {setNodeRef,isOver}=useDroppable({id:`batch-line-${line.lineId}`,data:{lineId:line.lineId},disabled});
  const highlighted=!!active&&overLine===line.lineId&&!overJob;
  return <section className="batch-line" aria-labelledby={`batch-line-title-${line.lineId}`}>
    <header className="batch-line-header"><div><h2 id={`batch-line-title-${line.lineId}`}>{line.lineId}</h2><span>{numberLabel(line.plannedMt)} MT · {line.utilisation===null?'No available hours':`${numberLabel(line.utilisation*100,0)}% planned`}</span></div><button className="icon-button" type="button" disabled={disabled} aria-label={`Add production to ${line.lineId}`} onClick={onAdd}><Plus size={18}/></button></header>
    <div className="batch-line-runs">{children}</div>
    <div ref={setNodeRef} className={`batch-new-target ${highlighted||isOver?'is-over':''}`} data-batch-line={line.lineId}><Plus size={18}/><strong>{line.jobs.length?'New separate batch':'No production planned'}</strong><span>Drop an order here · {line.lineId}</span></div>
  </section>;
}

function BatchBox({job,disabled,active,overJob,allowed,onOpen,children}:{job:Job&{durationMinutes:number;plannedStart:number|null;plannedEnd:number|null};disabled:boolean;active:DragItem|null;overJob:string|null;allowed:boolean;onOpen:()=>void;children:ReactNode}) {
  const allocations=getJobSourceAllocations(job),locked=!editable(job);
  const paused=isJobPaused(job);
  const crossDay=toDateTimeInput(job.plannedStart).slice(0,10)!==job.date||toDateTimeInput(job.plannedEnd).slice(0,10)!==job.date;
  const labelTime=crossDay?fullDateTime:timeLabel;
  const {setNodeRef:dragRef,attributes,listeners}=useDraggable({id:`batch-whole-${job.id}`,data:{kind:'batch',jobId:job.id},disabled:disabled||locked});
  const {setNodeRef:dropRef}=useDroppable({id:`batch-drop-${job.id}`,data:{lineId:job.lineId,targetJobId:job.id},disabled});
  const hovering=!!active&&active.jobId!==job.id&&overJob===job.id;
  const extra=Math.max(0,(job.mode==='bags'?job.bagCount??0:job.quantityMt)-allocations.reduce((sum,row)=>sum+row.plannedQuantity,0));
  return <article ref={node=>{dragRef(node);dropRef(node);}} className={`batch-box ${job.issue?'issue':paused?'paused':job.status}${hovering?(active.kind==='batch'||allowed?' can-receive':' cannot-receive'):''}`} data-job-id={job.id} data-batch-id={job.id}>
    <header className="batch-box-header"><button type="button" className="batch-box-title" onClick={onOpen} aria-label={`Open ${productLabel(job)} batch on ${job.lineId}`}><strong>{productLabel(job)}</strong><span>{packagingLabel({unit:job.mode==='bags'?'Bags':'MT',bagWeightKg:job.bagWeightKgSnapshot,description:job.description})}</span></button><div className="batch-box-total"><strong>{batchQuantity(job)}</strong>{job.mode==='bags'&&<span>{numberLabel(job.quantityMt,3)} MT</span>}</div><button type="button" className="batch-grip" {...attributes} {...listeners} disabled={disabled||locked} aria-label={`Drag whole ${productLabel(job)} batch on ${job.lineId}`}>{locked?<LockKeyhole size={15}/>:<GripVertical size={18}/>}</button></header>
    <div className="batch-box-schedule"><span>{labelTime(job.plannedStart)}–{labelTime(job.plannedEnd)}</span><span>{durationLabel(job.durationMinutes,true)}</span></div>
    <div className="batch-box-state"><StatusBadge status={job.status} issue={!!job.issue} paused={paused}/><span>{allocations.length} {allocations.length===1?'order':'orders'}</span></div>
    <div className="batch-order-list">{children}</div>
    {!allocations.length&&<p className="batch-manual-note">{job.orderNo||'Manual production'} · No linked order cards</p>}
    {extra>0&&allocations.length>0&&<p className="batch-extra">Extra stock · {numberLabel(extra,job.mode==='bags'?0:3)} {job.mode==='bags'?'Bags':'MT'}</p>}
    {locked&&<p className="batch-lock-note"><LockKeyhole size={12}/>Started or recorded · order allocations locked</p>}
    {hovering&&<p className={`batch-drop-caption ${!allowed&&active.kind==='order'?'invalid':''}`} role="status">{active.kind==='batch'?'Place this batch before it':allowed?'Drop to combine this order':'Different product / variant, date or locked batch'}</p>}
  </article>;
}

function OrderTile({job,allocation,customer,dueDate,disabled,active,onOpen,onMove}:{job:Job;allocation:JobSourceAllocation;customer:string;dueDate?:string;disabled:boolean;active:DragItem|null;onOpen:()=>void;onMove:()=>void}) {
  const source=allocation.sourceSnapshot;
  const {setNodeRef,attributes,listeners,isDragging}=useDraggable({id:`batch-order-${job.id}-${allocation.sourceOrderId}`,data:{kind:'order',jobId:job.id,sourceOrderId:allocation.sourceOrderId},disabled});
  const partial=allocation.plannedQuantity!==source.quantity;
  return <div ref={setNodeRef} className={`batch-order ${isDragging?'dragging':''}`} data-order-id={allocation.sourceOrderId}>
    <button type="button" className="batch-order-main" {...(!disabled?attributes:{})} {...(!disabled?listeners:{})} onClick={()=>{if(!active)onOpen();}} aria-label={`Order ${source.doNo}, ${quantityLabel(allocation)}, ${customer}`} aria-description={disabled?'Order allocation is locked.':'Drag to another batch or PM. Enter opens production details; Space starts a keyboard move.'}>
      <span className="batch-order-top"><strong>DO {source.doNo}</strong><GripVertical size={14} aria-hidden="true"/></span>
      <span className="batch-order-customer" title={customer}>{customer}</span>
      <span className="batch-order-bottom"><strong>{quantityLabel(allocation)}</strong><span className={dueDate&&dueDate<localDate()?'overdue':''}>{dueDate?`Due ${dateLabel(dueDate)}`:'Due date unknown'}</span></span>
      {partial&&<span className="batch-order-share">of {numberLabel(source.quantity,source.unit==='Bags'?0:3)} {source.unit} ordered</span>}
    </button>
    <button type="button" className="batch-order-move" disabled={disabled} onClick={onMove} aria-label={`Move order ${source.doNo}`} title="Move order without dragging"><ArrowRightLeft size={15}/></button>
  </div>;
}

function OrderMoveDialog({job,allocation,jobs,disabled,feedback,onClose,onSave}:{job:Job;allocation:JobSourceAllocation;jobs:Job[];disabled:boolean;feedback:string;onClose:()=>void;onSave:(input:TransferInput)=>Promise<boolean>}) {
  const [line,setLine]=useState<LineId>(job.lineId),[target,setTarget]=useState('');
  const choices=jobs.filter(candidate=>candidate.lineId===line&&compatible(job,candidate));
  const stillValid=editable(job)&&(!target||choices.some(candidate=>candidate.id===target));
  return <DetailDialog title={`Move order ${allocation.sourceSnapshot.doNo}`} subtitle={`${quantityLabel(allocation)} · ${productLabel(job)} · ${dateLabel(job.date,true)}`} closeLabel="Close order move" onClose={onClose}>
    <form className="batch-move-form" onSubmit={async event=>{event.preventDefault();if(stillValid)await onSave({jobId:job.id,sourceOrderId:allocation.sourceOrderId,toLineId:line,...(target?{targetJobId:target}:{})});}}>
      <label className="field">Destination PM<select value={line} disabled={disabled} onChange={event=>{setLine(event.target.value as LineId);setTarget('');}}>{(['PM1','PM2','PM3','PM4'] as const).map(id=><option key={id}>{id}</option>)}</select></label>
      <label className="field">Destination batch<select value={target} disabled={disabled} onChange={event=>setTarget(event.target.value)}><option value="">New separate batch</option>{choices.map(candidate=><option key={candidate.id} value={candidate.id}>{productLabel(candidate)} · {batchQuantity(candidate)} · {getJobSourceAllocations(candidate).length} orders</option>)}</select></label>
      <p className="data-note">Only this card's allocated quantity moves. Extra stock stays in its batch. Both batch totals and schedules are recalculated; check the new finish times and destination bin.</p>
      {!stillValid&&<p className="notice warning">This batch changed or is no longer editable. Close and review the latest production cards.</p>}
      {feedback&&<p role="status" className="data-note">{feedback}</p>}
      <div className="batch-move-actions"><button type="button" className="button secondary" disabled={disabled} onClick={onClose}>Cancel</button><button className="button primary" disabled={disabled||!stillValid}>Move order</button></div>
    </form>
  </DetailDialog>;
}
