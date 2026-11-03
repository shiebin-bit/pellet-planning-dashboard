import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { SourceImportReview, SourceImportReviewStatus, SourceOrderFieldName, SourceOrderFields } from '../domain/sourceTypes';
import type { Command } from '../domain/commands';
import { readSourceImportReviews } from '../lib/dataApi';
import { dateLabel, fullDateTime, numberLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import { useModal } from './useModal';
import './ProductionEditor.css';
import './DetailDialog.css';

const STATUS: Array<{ id: SourceImportReviewStatus; label: string }> = [
  { id: 'pending', label: 'Pending' }, { id: 'applied', label: 'Applied' }, { id: 'dismissed', label: 'Dismissed' },
];
const LABELS: Record<SourceOrderFieldName, string> = {
  goodsMovementStatus: 'Goods movement status', sourceSheet: 'Worksheet', sourceRow: 'Worksheet row', doNo: 'DO no',
  deliveryDate: 'Delivery date', soldToParty: 'Sold to Party', shipToParty: 'Ship to Party', materialCode: 'Material code',
  description: 'Description', quantity: 'Quantity', unit: 'Unit', deliveryLeadDays: 'Delivery lead days', remark: 'Remark',
  daysOutstanding: 'Days outstanding', medication: 'Medication', fmrOmed: 'FMR / OMED',
};

export function ImportReviewQueue() {
  const { savedAt, commit, mutationLocked, hasConflict } = useWorkspace();
  const [status,setStatus]=useState<SourceImportReviewStatus>('pending');
  const [page,setPage]=useState(1);
  const [reload,setReload]=useState(0);
  const [result,setResult]=useState<Awaited<ReturnType<typeof readSourceImportReviews>>|null>(null);
  const [selected,setSelected]=useState<SourceImportReview|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{let active=true;setLoading(true);setError('');readSourceImportReviews(status,page).then(data=>{
    if(!active)return;setResult(data);if(data.page!==page)setPage(data.page);
    setSelected(current=>current?data.items.find(item=>item.id===current.id)??null:null);
  }).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Import reviews could not be loaded.');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};},[status,page,reload,savedAt]);
  const total=result?.total??0,pages=Math.max(1,Math.ceil(total/50));
  return <section className="panel import-review-queue" aria-labelledby="import-review-title">
    <div className="import-review-heading"><div><h2 id="import-review-title">Import review queue</h2><p>Workbook differences are saved here without changing the active order. Apply only the fields you have verified.</p></div>
      <button className="button secondary" disabled={loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={15}/>Refresh</button></div>
    <div className="order-views" role="group" aria-label="Import review status">{STATUS.map(item=><button key={item.id} aria-pressed={status===item.id} onClick={()=>{setStatus(item.id);setPage(1);setSelected(null);}}>{item.label}{result?` (${result.counts[item.id]})`:''}</button>)}</div>
    {error?<div className="data-empty" role="alert"><p>{error}</p><button className="button secondary" onClick={()=>setReload(value=>value+1)}>Retry</button></div>:
      loading?<div className="data-empty" role="status">Loading import reviews…</div>:
      result?.items.length?<div className="import-review-list">{result.items.map(item=><button key={item.id} className="import-review-row" onClick={()=>setSelected(item)}>
        <span><strong>{item.doNo}</strong><small>{item.materialCode}</small></span><span><strong>{item.changedFields.length} changed {item.changedFields.length===1?'field':'fields'}</strong><small>{item.sourceImport.fileName} · {dateLabel(item.sourceImport.asOfDate,true)}</small></span>
        <span><strong className={`source-tag ${item.status==='pending'?'review':'completed'}`}>{item.status}</strong><small>{fullDateTime(item.createdAt)}</small></span>
      </button>)}</div>:<div className="data-empty"><p>No {status} import reviews.</p></div>}
    <div className="table-foot data-pagination"><span>{total?(page-1)*50+1:0}–{Math.min(page*50,total)} of {total} reviews</span><nav aria-label="Import review pages"><button className="button secondary" disabled={loading||page<=1} onClick={()=>setPage(value=>value-1)}><ChevronLeft size={15}/>Previous</button><span>Page {page} of {pages}</span><button className="button secondary" disabled={loading||page>=pages} onClick={()=>setPage(value=>value+1)}>Next<ChevronRight size={15}/></button></nav></div>
    {selected&&<ReviewDialog key={selected.id} review={selected} locked={mutationLocked||hasConflict} conflict={hasConflict} onClose={()=>setSelected(null)} onCommit={async(command,message)=>{
      const saved=await commit(command,message);
      if(saved){setSelected(null);setReload(value=>value+1);}
      return saved;
    }}/>} 
  </section>;
}

function ReviewDialog({review,locked,conflict,onClose,onCommit}:{review:SourceImportReview;locked:boolean;conflict:boolean;onClose:()=>void;onCommit:(command:Command,message:string)=>Promise<boolean>}) {
  const [fields,setFields]=useState<SourceOrderFieldName[]>([]);
  const [reason,setReason]=useState('');
  const [feedback,setFeedback]=useState('');
  const titleId=useId();
  const stale=review.observedSourceVersion!==review.currentSourceVersion;
  const pending=review.status==='pending';
  const toggle=(field:SourceOrderFieldName)=>setFields(current=>current.includes(field)?current.filter(item=>item!==field):[...current,field]);
  const close=()=>{if(!locked)onClose();};
  const dialog=useModal(close,true);
  async function resolve(command:Command,message:string){
    setFeedback('');
    if(!await onCommit(command,message))setFeedback('The review was not saved. Your selected fields and reason are still here; review the message above and try again.');
  }
  return createPortal(<div className="editor-layer detail-layer"><button className="editor-scrim" tabIndex={-1} disabled={locked} onClick={close} aria-label="Dismiss import review"/><section ref={dialog} tabIndex={-1} className="detail-dialog import-review-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header className="editor-header"><div><h2 id={titleId}>Review {review.doNo}</h2><p>{review.materialCode} · {review.sourceImport.fileName}</p></div><button className="icon-button" data-autofocus disabled={locked} aria-label="Close import review" onClick={close}><X size={18}/></button></header>
    <div className="dialog-body detail-dialog-body">{conflict&&<div className="notice warning" role="alert">The workspace changed in another session. Your review draft is preserved; reload the latest workspace before applying it.</div>}{feedback&&<div className="data-error" role="alert">{feedback}</div>}<div className="notice"><strong>Original import retained.</strong> Nothing changes unless you select fields, enter a reason, and confirm. Ledger movements and existing production cards are never rewritten.</div>
      {stale&&pending&&<div className="notice warning">This review was captured at source version {review.observedSourceVersion}; the order is now version {review.currentSourceVersion}. It cannot be applied, but it can be dismissed with a reason.</div>}
      <dl className="review-provenance"><div><dt>Imported</dt><dd>{fullDateTime(review.sourceImport.importedAt)}</dd></div><div><dt>Excel as-of</dt><dd>{dateLabel(review.sourceImport.asOfDate,true)}</dd></div><div><dt>Status</dt><dd>{review.status}</dd></div></dl>
      <div className="review-field-list">{review.changedFields.map(field=>{const isProtected=review.protectedFields.includes(field);return <label key={field} className={isProtected?'protected':''}>
        {pending&&<input type="checkbox" checked={fields.includes(field)} disabled={locked||stale||isProtected} onChange={()=>toggle(field)}/>}<span><strong>{LABELS[field]}</strong>{isProtected&&<em>Protected</em>}</span>
        <span className="review-values"><span><small>Current</small>{display(review.currentFields[field],field,review.currentFields)}</span><span><small>Imported candidate</small>{display(review.candidateFields[field],field,review.candidateFields)}</span></span>
      </label>;})}</div>
      {pending?<label className="field">Reason (required)<textarea value={reason} maxLength={1000} rows={3} onChange={event=>setReason(event.target.value)} placeholder="Why is this correction or dismissal appropriate?"/></label>:
        <div className="notice"><strong>Resolution reason</strong><p>{review.resolutionReason}</p>{review.selectedFields?.length?<p>Applied fields: {review.selectedFields.map(field=>LABELS[field]).join(', ')}</p>:null}</div>}
    </div><footer>{pending&&<><button className="button primary" disabled={locked||stale||!fields.length||!reason.trim()} onClick={()=>void resolve({type:'data.applySourceCorrection',reviewId:review.id,expectedSourceVersion:review.currentSourceVersion,selectedFields:fields,reason:reason.trim()},'Source correction applied.')}>Apply selected fields</button>
      <button className="button danger" disabled={locked||!reason.trim()} onClick={()=>void resolve({type:'data.dismissSourceCorrection',reviewId:review.id,expectedSourceVersion:review.currentSourceVersion,reason:reason.trim()},'Import review dismissed.')}>Dismiss review</button></>}<button className="button secondary" disabled={locked} onClick={close}>Close</button></footer>
  </section></div>,document.body);
}

function display(value: unknown, field: SourceOrderFieldName, fields: SourceOrderFields): string {
  if(value===null||value===undefined||value==='')return '—';
  if(field==='deliveryDate')return dateLabel(String(value),true);
  if(field==='quantity')return `${numberLabel(Number(value),fields.unit==='Bags'?0:3)} ${fields.unit}`;
  return String(value);
}
