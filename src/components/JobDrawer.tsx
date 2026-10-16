import { useEffect, useRef, useState } from 'react';
import { X, Clock3, Package, ArrowRight, Play, CheckCheck, Pencil, LockKeyhole, AlertTriangle, Check, Ban, MoveRight, CalendarDays } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { getProductionResult } from '../domain/production-results';
import { LINE_IDS } from '../domain/types';
import type { LineId } from '../domain/types';
import { durationLabel, fullDateTime, fromDateTimeInput, numberLabel, productColor, toDateTimeInput, dateLabel, timeLabel } from '../lib/format';
import { StatusBadge } from './Shared';
import { ActualOutputForm,ActualOutputResult } from './ActualOutput';

export function JobDrawer() {
  const {selectedJob:job,closeJob,editJob,state,board,commit,notify,busy,storageWarning,storageMode,refresh,hasConflict,resolveConflict,mutationLocked}=useWorkspace();
  const [actualStart,setActualStart]=useState('');
  const [toLine,setToLine]=useState<LineId>('PM1');
  const [beforeId,setBeforeId]=useState('');
  const [showMove,setShowMove]=useState(false);
  const [confirmCancel,setConfirmCancel]=useState(false);
  const [showIssue,setShowIssue]=useState(false);
  const [issueReason,setIssueReason]=useState('');
  const [showOutput,setShowOutput]=useState(false);
  const outputToggle=useRef<HTMLButtonElement>(null);
  const drawerRef=useRef<HTMLElement>(null);
  const closeRef=useRef<HTMLButtonElement>(null);
  const previousFocus=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    if(!job)return;
    setActualStart(job.actualStart?toDateTimeInput(job.actualStart):'');
    setToLine(job.lineId);setBeforeId('');setShowMove(false);setConfirmCancel(false);
    setShowIssue(false);setIssueReason('');setShowOutput(false);
  },[job?.id]);
  useEffect(()=>{
    if(!job)return;
    previousFocus.current=document.activeElement as HTMLElement;
    closeRef.current?.focus();
    const originalOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape')closeJob();
      if(event.key==='Tab'){
        const controls=Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')||[]).filter(element=>element.offsetParent!==null);
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    window.addEventListener('keydown',key);
    return()=>{document.body.style.overflow=originalOverflow;window.removeEventListener('keydown',key);previousFocus.current?.focus();};
  },[job?.id]);
  if(!job)return null;
  const pending=job.status==='pending';
  const movableJobs=board.lines.find(line=>line.lineId===toLine)?.jobs.filter(item=>item.id!==job.id&&item.date===job.date&&item.status==='pending')||[];
  function start(){
    if(!actualStart){document.getElementById('actual-start')?.focus();return;}
    const timestamp=fromDateTimeInput(actualStart);
    if(new Date(timestamp).getTime()>Date.now()){notify('Actual start must be in the past or the current time.',true);return;}
    void commit({type:'job.start',jobId:job!.id,actualStart:timestamp},'Actual start recorded. Production is running.');
  }
  const result=getProductionResult(job);
  const elapsed=result.elapsedMinutes;
  const missing=!state.jobs.some(item=>item.id===job.id);
  const closeOutput=()=>{setShowOutput(false);requestAnimationFrame(()=>outputToggle.current?.focus());};
  const reloadLatest=()=>{
    if(missing){resolveConflict();closeJob();return;}
    setActualStart(job.actualStart?toDateTimeInput(job.actualStart):'');
    setToLine(job.lineId);setBeforeId('');setShowMove(false);setConfirmCancel(false);
    setShowIssue(false);setIssueReason('');setShowOutput(false);resolveConflict();
  };
  return <div className="drawer-layer"><button className="drawer-scrim" aria-label="Close production details" disabled={mutationLocked} onClick={closeJob}/><aside className="job-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
    <div className="drawer-top"><span>PRODUCTION DETAILS</span><button ref={closeRef} className="icon-button" disabled={mutationLocked} onClick={closeJob} aria-label="Close production details"><X size={21}/></button></div>
    <div className="drawer-body">
      <div className="drawer-product"><span className="drawer-product-color" style={{background:productColor(job.productCode)}}/><div><h2 id="drawer-title">{job.productCode}</h2><p>{job.description||'Pellet production'}</p></div><span className="line-id">{job.lineId}</span></div>
      <div className="drawer-status-row"><StatusBadge status={job.status} issue={!!job.issue}/><span>{dateLabel(job.date,true)}</span></div>
      {storageWarning&&storageMode==='database'&&<div className="notice warning" role="alert">{storageWarning}<button className="text-link" disabled={busy} onClick={()=>void refresh()}>Retry connection</button></div>}
      {hasConflict&&(!showOutput||missing)&&<div className="notice warning" role="alert">{missing?'This task is no longer in the latest workspace. Its open details are preserved for review.':'The latest workspace changed while this task was open. Your entries are preserved.'} <button type="button" className="text-link" onClick={reloadLatest}>{missing?'Close details':'Reload latest task'}</button></div>}
      {job.issue&&<section className="issue-banner" aria-label="Reported production issue" inert={mutationLocked||hasConflict}><div><AlertTriangle size={19}/><strong>Production issue</strong><StatusBadge status={job.status}/></div><p>{job.issue.reason}</p><small>Reported {fullDateTime(job.issue.reportedAt)}</small><button className="button secondary full-width" onClick={()=>commit({type:'job.resolveIssue',jobId:job.id},'Issue resolved. Original production status retained.')}><Check size={15}/>Resolve issue</button></section>}
      {job.binNeedsReview&&<div className="bin-review-box" inert={mutationLocked||hasConflict}><AlertTriangle size={18}/><div><strong>Review the destination bin</strong><p>This task changed production line. Confirm that bin {job.bin||'—'} is suitable for {job.lineId}.</p><button className="text-link" onClick={()=>commit({type:'job.confirmBin',jobId:job.id},'Destination bin confirmed.')}><Check size={14}/>Confirm bin assignment</button></div></div>}
      <div className="drawer-volume"><span>{numberLabel(job.quantityMt,2)}<small>MT</small></span><div><Package size={16}/>{job.mode==='bags'?numberLabel(job.bagCount||0,0)+' bags':'Bulk production'}</div></div>
      <div className="detail-grid"><Detail label="ORDER REFERENCE" value={job.orderNo||'—'}/><Detail label="DESTINATION BIN" value={job.bin||'Not assigned'}/><Detail label="PRODUCTION RATE" value={numberLabel(job.rate)+' MT / hr'}/><Detail label="PRODUCTION TIME" value={durationLabel(job.durationMinutes)}/></div>
      <section className="drawer-section"><div className="drawer-section-title"><CalendarDays size={16}/><h3>Planned schedule</h3>{job.overflow&&<span className="pill amber">Carry-over</span>}</div>
        {job.plannedStart?<><div className="planned-time-range"><div><span>START</span><strong>{timeLabel(job.plannedStart)}</strong><small>{dateLabel(toDateTimeInput(job.plannedStart).slice(0,10),true)}</small></div><ArrowRight size={20}/><div><span>END</span><strong>{timeLabel(job.plannedEnd)}</strong><small>{dateLabel(toDateTimeInput(job.plannedEnd).slice(0,10),true)}</small></div></div><div className="schedule-breakdown"><span>Changeover before this task</span><strong>{durationLabel(job.changeoverMinutes,true)}</strong></div>{job.segments.filter(segment=>segment.kind==='production').length>1&&<p className="field-help">Production is split around unavailable time. All segments belong to this task.</p>}</>:<p className="subtle-empty">Add a quantity to calculate the planned time.</p>}
      </section>
      <section className="drawer-section" inert={missing&&hasConflict}><div className="drawer-section-title"><Clock3 size={16}/><h3>Actual production</h3><span className="muted small">MYT</span></div>
        {pending?<><label className="field">Actual start time<input id="actual-start" disabled={mutationLocked||hasConflict} type="datetime-local" value={actualStart} max={toDateTimeInput(new Date().toISOString())} onChange={e=>setActualStart(e.target.value)}/><small>Enter the time production actually started, then select Start production.</small></label><button className="button primary full-width" disabled={mutationLocked||hasConflict||!actualStart||!job.quantityMt} onClick={start}><Play size={15}/>Start production</button></>:
        <><div className="actual-time-row"><span>Actual start</span><strong>{fullDateTime(job.actualStart)}</strong></div><div className="actual-time-row"><span>Actual end</span><strong>{fullDateTime(job.actualEnd)}</strong></div>{elapsed!==null&&<div className="actual-time-row"><span>Elapsed time</span><strong>{durationLabel(elapsed)}</strong></div>}
        {job.status==='completed'&&<><ActualOutputResult job={job}/><p className="field-help">Elapsed time includes any stops. It is separate from planned production time.</p></>}
        {(job.status==='running'||job.status==='completed')&&(showOutput?<ActualOutputForm key={job.id} job={job} completing={job.status==='running'} onCancel={closeOutput} onSaved={closeOutput}/>:<button ref={outputToggle} disabled={mutationLocked||hasConflict} className={'button full-width '+(job.status==='running'?'primary':'secondary')} onClick={()=>setShowOutput(true)} aria-expanded={false}><CheckCheck size={17}/>{job.status==='running'?'Mark as done':result.actualQuantityMt===null?'Record actual output':'Edit actual output'}</button>)}
        </>}
      </section>
      {(job.status==='pending'||job.status==='running')&&!job.issue&&<section className="drawer-section issue-actions" inert={mutationLocked||hasConflict}><button className="text-link danger-text" onClick={()=>setShowIssue(!showIssue)} aria-expanded={showIssue}><AlertTriangle size={16}/>Report a problem</button>{showIssue&&<div className="issue-form"><label className="field">Problem details<textarea value={issueReason} onChange={event=>setIssueReason(event.target.value)} placeholder="Describe the problem for the team…" maxLength={1000}/><small>The card turns red until the problem is resolved or production is completed.</small></label><button className="button danger full-width" disabled={busy||!issueReason.trim()} onClick={async()=>{if(await commit({type:'job.reportIssue',jobId:job.id,reason:issueReason},'Problem recorded. The card is now marked red.')){setShowIssue(false);setIssueReason('');}}}><AlertTriangle size={16}/>Mark as issue</button></div>}</section>}
      {job.remarks&&<section className="drawer-section"><h3>Remarks</h3><p className="drawer-remarks">{job.remarks}</p></section>}
      {pending&&<section className="drawer-section" inert={mutationLocked||hasConflict}><button className="drawer-move-toggle" onClick={()=>setShowMove(!showMove)} aria-expanded={showMove}><MoveRight size={16}/><span>Move to another line or position</span><ArrowRight size={15}/></button>{showMove&&<div className="drawer-move-form"><div className="field-grid"><label className="field">Line<select value={toLine} onChange={e=>{setToLine(e.target.value as LineId);setBeforeId('');}}>{LINE_IDS.map(line=><option key={line}>{line}</option>)}</select></label><label className="field">Position<select value={beforeId} onChange={e=>setBeforeId(e.target.value)}><option value="">After the last task</option>{movableJobs.map(item=><option value={item.id} key={item.id}>Before {item.productCode} · {numberLabel(item.quantityMt)} MT</option>)}</select></label></div><button className="button secondary full-width" disabled={busy} onClick={async()=>{if(await commit({type:'job.move',jobId:job.id,toLineId:toLine,...(beforeId?{beforeJobId:beforeId}:{})},'Task moved. Check the destination bin.',true))setShowMove(false);}}>Apply move<ArrowRight size={15}/></button></div>}</section>}
      <div className="drawer-created">Created {fullDateTime(job.createdAt)}<br/>Last updated {fullDateTime(job.updatedAt)}</div>
    </div>
    <div className="drawer-footer" inert={mutationLocked||hasConflict}>{pending?<><button className="button secondary" onClick={()=>editJob(job.id)}><Pencil size={15}/>Edit details</button>{confirmCancel?<div className="cancel-confirm"><button className="button danger" disabled={mutationLocked||hasConflict} onClick={async()=>{if(await commit({type:'job.cancel',jobId:job.id},'Production task cancelled.'))closeJob();}}>Confirm cancel</button><button className="icon-button" aria-label="Keep production task" onClick={()=>setConfirmCancel(false)}><X size={16}/></button></div>:<button className="text-link danger-text" onClick={()=>setConfirmCancel(true)}><Ban size={14}/>Cancel task</button>}</>:<span className="locked-note"><LockKeyhole size={15}/>The {job.status} task's plan is locked.</span>}</div>
  </aside></div>;
}
function Detail({label,value}:{label:string;value:string}){return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;}
