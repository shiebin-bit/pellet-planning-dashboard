import { useEffect,useRef,useState } from 'react';
import { FileSpreadsheet,Printer,X } from 'lucide-react';
import { buildProductionReport,reportWeek } from '../domain/reports';
import type { ProductionReport,ReportSelection } from '../domain/reports';
import { LINE_IDS } from '../domain/types';
import { exportRangeExcel } from '../lib/export';
import { dateLabel,numberLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import './ProductionEditor.css';
import './ReportDialog.css';

export function ReportDialog({onClose,onPrint}:{onClose:()=>void;onPrint:(report:ProductionReport)=>void}) {
  const {date,state,notify}=useWorkspace();
  const [preset,setPreset]=useState<'day'|'week'|'custom'>('day');
  const [selection,setSelection]=useState<ReportSelection>({from:date,to:date,lineId:'all'});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const dialog=useRef<HTMLElement>(null);
  const previousFocus=useRef(document.activeElement as HTMLElement|null);
  useEffect(()=>{
    dialog.current?.querySelector<HTMLButtonElement>('.report-presets button')?.focus();
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=overflow;requestAnimationFrame(()=>{const target=previousFocus.current;if(target?.isConnected&&!target.closest('[inert]'))target.focus();else document.querySelector<HTMLButtonElement>('[aria-label="Export"]')?.focus();});};
  },[]);
  let report:ProductionReport|null=null,validation='';
  try{report=buildProductionReport(state,selection);}catch(reason){validation=reason instanceof Error?reason.message:'Choose valid report dates.';}
  const choose=(value:typeof preset)=>{setPreset(value);if(value==='day')setSelection(old=>({...old,from:date,to:date}));if(value==='week')setSelection(old=>({...old,...reportWeek(date)}));setError('');};
  const excel=async()=>{
    if(!report)return;setBusy(true);setError('');
    try{await exportRangeExcel(report,state);notify('Date range Excel report downloaded.');onClose();}
    catch{setError('The report could not be generated. Please try again.');}
    finally{setBusy(false);}
  };
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close report options" onClick={()=>{if(!busy)onClose();}}/>
    <section ref={dialog} className="production-editor report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title" onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)onClose();}
      if(event.key==='Tab'){
        const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')??[]).filter(element=>element.offsetParent!==null);
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
      <header className="editor-header"><div><h2 id="report-title">Date range report</h2><p>Choose planning dates and a production line.</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close report options"><X size={21}/></button></header>
      <div className="editor-body">
        <div className="segmented-control report-presets" role="group" aria-label="Report period">{(['day','week','custom'] as const).map(value=><button type="button" key={value} aria-pressed={preset===value} className={preset===value?'selected':''} onClick={()=>choose(value)} disabled={busy}>{value==='day'?'Selected day':value==='week'?'This week':'Custom dates'}</button>)}</div>
        <div className="field-grid"><label className="field">Report from<input aria-label="Report from" type="date" required value={selection.from} disabled={busy} onChange={event=>{const value=event.target.value;setPreset('custom');setSelection(old=>({...old,from:value,to:value&&old.to&&value>old.to?value:old.to}));}}/></label><label className="field">Report to<input aria-label="Report to" type="date" required min={selection.from} value={selection.to} disabled={busy} onChange={event=>{const value=event.target.value;setPreset('custom');setSelection(old=>({...old,to:value,from:value&&old.from&&value<old.from?value:old.from}));}}/></label><label className="field span-2">Production line<select aria-label="Report line" value={selection.lineId} disabled={busy} onChange={event=>setSelection(old=>({...old,lineId:event.target.value as ReportSelection['lineId']}))}><option value="all">All four lines</option>{LINE_IDS.map(line=><option key={line}>{line}</option>)}</select></label></div>
        <p className="field-help">Up to 31 days per report. This week is Monday–Sunday around {dateLabel(date,true)}. Records follow their planning date; carry-over is listed once. Cancelled records remain visible; their quantities are excluded from planned totals.</p>
        {validation?<p role="alert" className="report-error">{validation}</p>:report&&<div className="report-preview" aria-live="polite"><div><span>Production records</span><strong>{report.jobs.length}</strong></div><div><span>Planned quantity</span><strong>{numberLabel(report.plannedMt,2)} MT</strong></div><div><span>Actual output recorded</span><strong>{report.recordedCount?numberLabel(report.actualMt,2)+' MT':'Not recorded'}</strong><small>{report.recordedCount} / {report.completedCount} completed tasks</small></div></div>}
        {report&&!report.jobs.length&&<p className="field-help">No records match these dates and line. Choose another period to export.</p>}
        {error&&<p className="report-error" role="alert">{error}</p>}
      </div>
      <footer className="editor-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><div className="toolbar-spacer"/><button type="button" className="button secondary" disabled={busy||!report?.jobs.length} onClick={()=>report&&onPrint(report)}><Printer size={16}/>Print / PDF</button><button type="button" className="button primary" disabled={busy||!report?.jobs.length} onClick={excel}><FileSpreadsheet size={16}/>{busy?'Exporting…':'Download Excel'}</button></footer>
    </section>
  </div>;
}
