import { useEffect,useRef,useState } from 'react';
import { CheckCheck,Save } from 'lucide-react';
import type { ScheduledJob } from '../domain/types';
import { getProductionResult } from '../domain/production-results';
import { useWorkspace } from '../lib/workspace';
import { durationLabel,numberLabel,outputVarianceLabel as varianceText } from '../lib/format';
import './ActualOutput.css';

export function ActualOutputForm({job,completing,onCancel,onSaved}:{job:ScheduledJob;completing:boolean;onCancel:()=>void;onSaved:()=>void}) {
  const {commit,toast,busy,storageWarning,storageMode,refresh,hasConflict,resolveConflict,mutationLocked}=useWorkspace();
  const result=getProductionResult(job);
  const [quantity,setQuantity]=useState(completing?String(job.quantityMt):result.actualQuantityMt===null?'':String(result.actualQuantityMt));
  const [note,setNote]=useState(job.completionNote??'');
  const [failed,setFailed]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{input.current?.focus();input.current?.select();},[]);
  const value=quantity.trim()===''?null:Number(quantity);
  const valid=value!==null&&Number.isFinite(value)&&value>=0;
  const variance=valid?value-job.quantityMt:null;
  return <form className="actual-output-form" aria-label={completing?'Complete production':'Record actual output'} onSubmit={async event=>{
    event.preventDefault();
    if(!valid||hasConflict){input.current?.focus();return;}
    const saved=await commit({type:completing?'job.complete':'job.recordActual',jobId:job.id,actualQuantityMt:value!,completionNote:note},completing?'Production completed. Actual output and end time recorded.':'Actual output saved.');
    if(saved)onSaved();else setFailed(true);
  }}>
    <label className="field">Actual quantity (MT)<div className="input-with-unit"><input ref={input} aria-label="Actual quantity (MT)" required disabled={mutationLocked||hasConflict} type="number" min="0" step="0.01" value={quantity} onChange={event=>setQuantity(event.target.value)}/><span>MT</span></div><small>Planned target: {numberLabel(job.quantityMt,2)} MT</small></label>
    {valid&&<p className={'output-preview '+(variance!==null&&variance<0?'shortfall':'')} aria-live="polite">{varianceText(variance)}</p>}
    <label className="field">Completion note (optional)<textarea rows={2} maxLength={1000} disabled={mutationLocked||hasConflict} value={note} onChange={event=>setNote(event.target.value)} placeholder="Reason for any difference or handover note…"/></label>
    <p className="field-help">{completing?'Confirm done records the current time as the actual end.'+(result.isPaused?' It also closes the ongoing pause at the same time.':''):'This updates actual output while keeping the recorded times and planned schedule.'}</p>
    {failed&&toast?.error&&<p role="alert" className="output-error">{toast.message}</p>}
    {hasConflict&&<p role="alert" className="output-error">Another planner changed this workspace. Your values are preserved. <button type="button" className="text-link" onClick={()=>{const latest=getProductionResult(job);setQuantity(completing?String(job.quantityMt):latest.actualQuantityMt===null?'':String(latest.actualQuantityMt));setNote(job.completionNote??'');setFailed(false);resolveConflict();}}>Reload latest output</button></p>}
    {storageMode==='database'&&storageWarning&&<button type="button" className="text-link" disabled={busy} onClick={()=>void refresh()}>Retry connection</button>}
    <div className="output-form-actions"><button type="button" className="button secondary" disabled={mutationLocked} onClick={onCancel}>Cancel {completing?'completion':'changes'}</button><button type="submit" className="button primary" disabled={!valid||mutationLocked||hasConflict}>{completing?<CheckCheck size={16}/>:<Save size={16}/>} {busy?'Saving…':completing?'Confirm done':'Save actual output'}</button></div>
  </form>;
}

export function ActualOutputResult({job}:{job:ScheduledJob}) {
  const result=getProductionResult(job);
  const timeDifference=result.elapsedMinutes===null?null:result.elapsedMinutes-job.durationMinutes;
  return <div className="actual-output-result">
    <div className="output-comparison"><div><span>Planned target</span><strong>{numberLabel(job.quantityMt,2)} <small>MT</small></strong></div><div><span>Actual output</span><strong>{result.actualQuantityMt===null?'Not recorded':<>{numberLabel(result.actualQuantityMt,2)} <small>MT</small></>}</strong></div></div>
    {result.varianceMt!==null&&<p className={'output-preview '+(result.varianceMt<0?'shortfall':'')}>{varianceText(result.varianceMt)}</p>}
    {timeDifference!==null&&<div className="actual-time-row"><span>Elapsed vs planned production</span><strong>{Math.abs(timeDifference)<0.5?'Same duration':`${durationLabel(Math.abs(timeDifference))} ${timeDifference>0?'longer':'shorter'}`}</strong></div>}
    {job.completionNote&&<p className="output-note"><strong>Completion note</strong>{job.completionNote}</p>}
  </div>;
}
