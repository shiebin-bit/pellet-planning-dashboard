import { useEffect, useRef, useState } from 'react';
import { Plus, Scissors, Trash2, X } from 'lucide-react';
import type { SplitPendingGroup } from '../domain/commands';
import { splitPendingJob, getBoard } from '../domain/engine';
import { getJobSourceAllocations } from '../domain/jobSources';
import { LINE_IDS, type Job } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import { numberLabel, timeLabel } from '../lib/format';
import { productLabel } from '../lib/productLabel';
import { useModal } from './useModal';
import './SplitPlanningDialog.css';

export function SplitPlanningDialog({job,onClose,onSaved}:{job:Job;onClose:()=>void;onSaved:()=>void}) {
  const {state,commit,mutationLocked,hasConflict,resolveConflict,toast,confirmedRetry}=useWorkspace();
  const allocations=getJobSourceAllocations(job), unit=job.mode==='bags'?'Bags':'MT';
  const total=job.mode==='bags'?job.bagCount!:job.quantityMt;
  const extra=Number((total-allocations.reduce((n,a)=>n+a.plannedQuantity,0)).toFixed(3));
  const blank=():SplitPendingGroup=>({date:job.date,lineId:job.lineId,bin:job.bin,remarks:job.remarks,allocations:[],unallocatedQuantity:0});
  const [groups,setGroups]=useState<SplitPendingGroup[]>(()=>[{...blank(),allocations:allocations.map(a=>({sourceOrderId:a.sourceOrderId,plannedQuantity:a.plannedQuantity})),unallocatedQuantity:extra},blank()]);
  const [failed,setFailed]=useState(false);
  const retry=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retry.current&&confirmedRetry.type==='job.splitPending')onSaved();},[confirmedRetry?.nonce]);
  const dialog=useModal(()=>{if(!mutationLocked)onClose();});
  let error='', preview:ReturnType<typeof getBoard>[]=[];
  try {const next=splitPendingJob(state,job.id,groups); preview=[...new Set(groups.map(g=>g.date))].map(date=>getBoard(next,date));}catch(reason){error=reason instanceof Error?reason.message:String(reason);}
  const remaining=(id?:string)=>Number(((id?allocations.find(a=>a.sourceOrderId===id)!.plannedQuantity:extra)-groups.reduce((n,g)=>n+(id?g.allocations.find(a=>a.sourceOrderId===id)?.plannedQuantity??0:g.unallocatedQuantity),0)).toFixed(3));
  function patch(index:number,update:Partial<SplitPendingGroup>){setFailed(false);setGroups(rows=>rows.map((row,n)=>n===index?{...row,...update}:row));}
  function quantity(index:number,id:string|undefined,value:number){const group=groups[index];if(id)patch(index,{allocations:[...group.allocations.filter(a=>a.sourceOrderId!==id),...(value>0?[{sourceOrderId:id,plannedQuantity:value}]:[])]});else patch(index,{unallocatedQuantity:value});}
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close split cards" disabled={mutationLocked} onClick={onClose}/><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="split-title" className="production-editor split-editor">
    <header className="editor-header"><div><h2 id="split-title">Split production card</h2><p>{productLabel(job)} · {numberLabel(total,unit==='Bags'?0:3)} {unit}. Divide orders or quantities across dates and lines.</p></div><button className="icon-button" aria-label="Close split cards" disabled={mutationLocked} onClick={onClose}><X size={21}/></button></header>
    <form onSubmit={async e=>{e.preventDefault();if(error)return;if(await commit({type:'job.splitPending',jobId:job.id,groups},'Production card split. Original retained in History.'))onSaved();else setFailed(true);}}>
      <div className="editor-body">
        <p className="data-note">Every order and any extra stock quantity must keep its original total. The original card will be cancelled and linked to the new cards. No stock is received by splitting.</p>
        {hasConflict&&<p className="notice warning" role="alert">The workspace changed. Your quantities are kept; refresh and review before saving.<button type="button" className="text-link" onClick={resolveConflict}>Review latest workspace</button></p>}
        <fieldset disabled={mutationLocked||hasConflict} className="split-groups"><legend className="sr-only">New production cards</legend>
          {groups.map((group,index)=><section className="split-group" key={index}><header><h3>Card {index+1}</h3>{groups.length>2&&<button className="icon-button" type="button" aria-label={`Remove card ${index+1}`} onClick={()=>setGroups(rows=>rows.filter((_,n)=>n!==index))}><Trash2 size={16}/></button>}</header>
            <div className="field-grid"><label className="field">Date<input type="date" required value={group.date} onChange={e=>patch(index,{date:e.target.value})}/></label><label className="field">Line<select value={group.lineId} onChange={e=>patch(index,{lineId:e.target.value as Job['lineId']})}>{LINE_IDS.map(id=><option key={id}>{id}</option>)}</select></label></div>
            <div className="split-quantities">{allocations.map(a=><label key={a.sourceOrderId}><span><strong>DO {a.sourceSnapshot.doNo}</strong><small>{a.sourceSnapshot.shipToParty||a.sourceSnapshot.soldToParty||'Customer not recorded'} · original {numberLabel(a.plannedQuantity,unit==='Bags'?0:3)} {unit}</small></span><input aria-label={`Card ${index+1} DO ${a.sourceSnapshot.doNo} quantity`} type="number" min="0" step={unit==='Bags'?1:0.001} value={group.allocations.find(row=>row.sourceOrderId===a.sourceOrderId)?.plannedQuantity??0} onChange={e=>quantity(index,a.sourceOrderId,Number(e.target.value))}/></label>)}{(extra>0||!allocations.length)&&<label><span><strong>{allocations.length?'Extra stock':'Production quantity'}</strong><small>Original {numberLabel(extra,unit==='Bags'?0:3)} {unit}</small></span><input aria-label={`Card ${index+1} stock quantity`} type="number" min="0" step={unit==='Bags'?1:0.001} value={group.unallocatedQuantity} onChange={e=>quantity(index,undefined,Number(e.target.value))}/></label>}</div>
            <div className="field-grid"><label className="field">Bin<input maxLength={200} value={group.bin} onChange={e=>patch(index,{bin:e.target.value})}/></label><label className="field">Remarks<input maxLength={1000} value={group.remarks} onChange={e=>patch(index,{remarks:e.target.value})}/></label></div>
          </section>)}
          <button type="button" className="button secondary" disabled={groups.length>=500} onClick={()=>setGroups(rows=>[...rows,blank()])}><Plus size={15}/>Add another card</button>
        </fieldset>
        <div className="split-balance" aria-live="polite"><strong>Quantity check</strong>{allocations.map(a=><span key={a.sourceOrderId}>DO {a.sourceSnapshot.doNo}: {numberLabel(remaining(a.sourceOrderId),unit==='Bags'?0:3)} {unit} remaining</span>)}{extra>0&&<span>Extra stock: {numberLabel(remaining(),unit==='Bags'?0:3)} {unit} remaining</span>}</div>
        {error?<p className="notice warning" role="status">{error}</p>:<div className="split-preview"><strong>Updated schedule</strong>{preview.flatMap(board=>board.lines.filter(line=>groups.some(g=>g.date===board.date&&g.lineId===line.lineId)).map(line=><p key={board.date+line.lineId}>{board.date} · {line.lineId} · {numberLabel(line.plannedMt,2)} MT · {numberLabel((line.utilisation??0)*100,0)}% planned{line.finishAt?` · finishes ${timeLabel(line.finishAt)}`:''}{line.overflowMinutes>0?' · continues beyond this shift':''}</p>))}</div>}
        {failed&&toast?.error&&<p className="data-error" role="alert">{toast.message}</p>}
      </div><footer className="editor-footer"><button type="button" className="button secondary" disabled={mutationLocked} onClick={onClose}>Cancel</button><div className="toolbar-spacer"/><button className="button primary" disabled={!!error||mutationLocked||hasConflict}><Scissors size={16}/>{mutationLocked?'Splitting…':'Save split cards'}</button></footer>
    </form>
  </section></div>;
}
