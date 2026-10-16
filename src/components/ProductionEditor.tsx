import { useEffect, useRef, useState } from 'react';
import { Check, Clock3, Layers3, Package, Save, X } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { getRate } from '../domain/engine';
import { LINE_IDS } from '../domain/types';
import type { Job, JobInput, LineId } from '../domain/types';
import { durationLabel, numberLabel } from '../lib/format';
import './ProductionEditor.css';

function blank(date: string, lineId: LineId): JobInput {
  return {date,lineId,orderNo:'',productCode:'',description:'',bin:'',mode:'bags',bagCount:0,quantityMt:0,remarks:''};
}
function fromJob(job: Job): JobInput {
  return {date:job.date,lineId:job.lineId,orderNo:job.orderNo,productCode:job.productCode,description:job.description,bin:job.bin,mode:job.mode,bagCount:job.bagCount,quantityMt:job.quantityMt,remarks:job.remarks};
}
export function ProductionEditor() {
  const {editor,state,date,setDate,commit,closeInput,toast,busy,storageWarning,storageMode,refresh,hasConflict,resolveConflict,mutationLocked}=useWorkspace();
  const editing=editor!.jobId!==null;
  const existing=state.jobs.find(job=>job.id===editor?.jobId);
  const [form,setForm]=useState<JobInput>(()=>existing?fromJob(existing):blank(date,editor!.lineId));
  const [another,setAnother]=useState(false);
  const [showFeedback,setShowFeedback]=useState(false);
  const dialog=useRef<HTMLElement>(null);
  const product=useRef<HTMLInputElement>(null);
  const previousFocus=useRef(document.activeElement as HTMLElement | null);
  useEffect(()=>{
    product.current?.focus();
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    return ()=>{
      document.body.style.overflow=overflow;
      const target=previousFocus.current;
      if(target?.isConnected&&!target.closest('[inert]')) target.focus();
      else document.querySelector<HTMLButtonElement>('.add-production-button')?.focus();
    };
  },[]);
  const set=<K extends keyof JobInput>(key:K,value:JobInput[K])=>setForm(previous=>({...previous,[key]:value}));
  const quantity=form.mode==='bags'?(form.bagCount||0)*state.settings.bagWeightKg/1000:form.quantityMt;
  const rate=getRate(state.settings,form.lineId,form.productCode);
  async function submit(event:React.FormEvent) {
    event.preventDefault();
    if(hasConflict||editing&&!existing)return;
    const input={...form,bagCount:form.mode==='bags'?(form.bagCount??0):null,quantityMt:quantity};
    const saved=await commit(editing?{type:'job.update',jobId:editor!.jobId!,patch:input}:{type:'job.create',input},editing?'Production task updated.':'Production task added.');
    setShowFeedback(true);
    if(!saved)return;
    setDate(form.date);
    if(another&&!editing){setForm(blank(form.date,form.lineId));product.current?.focus();}
    else closeInput();
  }
  return <div className="editor-layer">
    <button className="editor-scrim" aria-label="Close production form" onClick={closeInput} disabled={mutationLocked}/>
    <section ref={dialog} className="production-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" aria-describedby="editor-description" onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeInput();}
      if(event.key==='Tab'){
        const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')||[]).filter(element=>element.offsetParent!==null);
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
      <header className="editor-header"><div><h2 id="editor-title">{editing?'Edit production':'Add production'}</h2><p id="editor-description">Enter the task. Production time is calculated automatically.</p></div><button type="button" className="icon-button" onClick={closeInput} aria-label="Close production form" disabled={mutationLocked}><X size={21}/></button></header>
      <form onSubmit={submit}>
        <div className="editor-body" inert={mutationLocked||hasConflict}>
          <div className="field-grid">
            <label className="field">Production line<select value={form.lineId} onChange={event=>set('lineId',event.target.value as LineId)}>{LINE_IDS.map(line=><option key={line}>{line}</option>)}</select></label>
            <label className="field">Planning date<input type="date" required value={form.date} onChange={event=>set('date',event.target.value)}/></label>
            <label className="field">Product code <span className="required">*</span><input ref={product} required maxLength={80} value={form.productCode} onChange={event=>set('productCode',event.target.value)} placeholder="e.g. 6220"/></label>
            <label className="field">Destination bin<input maxLength={120} value={form.bin} onChange={event=>set('bin',event.target.value)} placeholder="e.g. 86 87"/></label>
            <div className="field">Delivery mode<div className="segmented-control" role="group" aria-label="Delivery mode"><button type="button" aria-pressed={form.mode==='bags'} className={form.mode==='bags'?'selected':''} onClick={()=>set('mode','bags')}><Package size={15}/>Bags{form.mode==='bags'&&<Check size={13}/>}</button><button type="button" aria-pressed={form.mode==='bulk'} className={form.mode==='bulk'?'selected':''} onClick={()=>set('mode','bulk')}><Layers3 size={15}/>Bulk{form.mode==='bulk'&&<Check size={13}/>}</button></div></div>
            {form.mode==='bags'?<label className="field">Number of bags<div className="input-with-unit"><input type="number" min="0" step="1" value={form.bagCount??''} onChange={event=>set('bagCount',event.target.value===''?null:Number(event.target.value))}/><span>bags</span></div><small>{numberLabel(state.settings.bagWeightKg,0)} kg per bag</small></label>:<label className="field">Bulk quantity<div className="input-with-unit"><input type="number" min="0" step="0.01" value={form.quantityMt||''} onChange={event=>set('quantityMt',Number(event.target.value))}/><span>MT</span></div></label>}
            <label className="field span-2">Order reference <span className="required">*</span><input required maxLength={120} value={form.orderNo} onChange={event=>set('orderNo',event.target.value)} placeholder="Order or customer reference"/></label>
          </div>
          <div className="editor-estimate" aria-live="polite"><Clock3 size={18}/><strong>{numberLabel(quantity,2)} MT</strong><span>{quantity>0?durationLabel(quantity/rate*60)+' production':'Awaiting quantity'}</span><small>{numberLabel(rate)} MT / hr</small></div>
          <details className="editor-more" key={editor?.jobId||'new'}><summary>More details <span>Description & remarks</span></summary><div className="editor-extra"><label className="field">Product description<input maxLength={200} value={form.description} onChange={event=>set('description',event.target.value)} placeholder="Product name or specification"/></label><label className="field">Remarks<textarea rows={2} maxLength={1000} value={form.remarks} onChange={event=>set('remarks',event.target.value)} placeholder="Special instructions or packaging notes…"/></label></div></details>
        </div>
        {editing&&!existing&&<div className="editor-feedback error" role="alert">This task is no longer in the latest workspace. Your draft was not converted into a new task. <button type="button" className="text-link" onClick={()=>{resolveConflict();closeInput();}}>Close editor</button></div>}
        {hasConflict&&(!editing||!!existing)&&<div className="editor-feedback error" role="alert">The workspace changed while this draft was open. Your draft is preserved. <button type="button" className="text-link" onClick={()=>{if(existing)setForm(fromJob(existing));resolveConflict();setShowFeedback(false);}}> {editing?'Reload latest task':'Reload latest plan'} </button></div>}
        {showFeedback&&toast&&<p className={'editor-feedback'+(toast.error?' error':'')} role={toast.error?'alert':'status'}>{toast.message}</p>}
        {storageMode==='database'&&storageWarning&&<p className="editor-feedback error"><button type="button" className="text-link" disabled={busy} onClick={()=>void refresh()}>Retry connection</button></p>}
        <footer className="editor-footer">{!editing&&<label className="checkbox-label"><input type="checkbox" checked={another} disabled={mutationLocked||hasConflict} onChange={event=>setAnother(event.target.checked)}/>Add another</label>}<div className="toolbar-spacer"/><button type="button" className="button secondary" onClick={closeInput} disabled={mutationLocked}>Cancel</button><button type="submit" className="button primary" disabled={mutationLocked||hasConflict||editing&&!existing}><Save size={16}/>{busy?'Saving…':editing?'Save changes':'Add to planning'}</button></footer>
      </form>
    </section>
  </div>;
}
