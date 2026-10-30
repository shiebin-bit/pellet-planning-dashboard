import { productLabel } from '../lib/productLabel';
import { useMemo, useState, useEffect, useRef } from 'react';
import { X, CalendarRange, Trash2 } from 'lucide-react';
import type { InventoryDraftPreview, InventoryDraftJob, InventoryPlanningDemandRow } from '../domain/inventoryTypes';
import { LINE_IDS, type Job, type LineId } from '../domain/types';
import { getBoard, getCalendarForDate, getShiftWindow, getScheduledJobs } from '../domain/engine';
import { previewInventoryDraft, readInventory } from '../lib/inventoryApi';
import { useWorkspace } from '../lib/workspace';
import { localDate, numberLabel, fullDateTime, dateLabel } from '../lib/format';
import { useModal } from './useModal';
import './ProductionEditor.css';
import './InventoryWorkspace.css';

export function AutoPlanningButton() {
  const { storageMode, mutationLocked } = useWorkspace();
  const [open, setOpen] = useState(false);
  return <><button className="button secondary" disabled={storageMode !== 'database' || mutationLocked} onClick={() => setOpen(true)}><CalendarRange size={16}/>Generate planning</button>{open && <InventoryDraftDialog onClose={() => setOpen(false)}/>}</>;
}
export function InventoryDraftDialog({ onClose }: { onClose: () => void }) {
  const { state, date, setDate, navigate, commit, mutationLocked, hasConflict, resolveConflict, toast, refresh, confirmedRetry } = useWorkspace();
  const start = date < localDate() ? localDate() : date;
  const [from, setFrom] = useState(start), [to, setTo] = useState(new Date(Date.parse(`${start}T12:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10));
  const [demandThrough,setDemandThrough]=useState(new Date(Date.parse(`${localDate()}T12:00:00Z`)+3*86400000).toISOString().slice(0,10));
  const [combineSameProduct, setCombineSameProduct] = useState(true);
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&confirmedRetry.type==='planning.commitDraft'){setDate(from);navigate('planning');onClose();}},[confirmedRetry?.nonce]);
  const [preview, setPreview] = useState<InventoryDraftPreview | null>(null), [jobs, setJobs] = useState<InventoryDraftJob[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(1);
  const dialog = useModal(onClose);
  const calculated = useMemo(() => {
    if (!preview) return null;
    try {
      const additional: Job[] = jobs.map((j, index) => ({ id: j.draftId, inventoryItemId: j.itemId, ...(j.sourceOrderId ? { sourceOrderId: j.sourceOrderId } : {}), productCode: j.materialCode, description: j.description, date: j.date, lineId: j.lineId, orderNo: j.orderNo, bin: j.bin, mode: j.unit === 'Bags' ? 'bags' : 'bulk', bagCount: j.unit === 'Bags' ? j.quantity : null, quantityMt: j.unit === 'Bags' ? j.quantity * j.bagWeightKg! / 1000 : j.quantity, status: 'pending', actualStart: null, actualEnd: null, binNeedsReview: false, sequence: Math.max(0, ...state.jobs.filter(old => old.lineId === j.lineId && old.date === j.date).map(old => old.sequence)) + index + 1, remarks: j.remarks, createdAt: preview.generatedAt, updatedAt: preview.generatedAt, notBefore: j.notBefore, medication: j.medication, fmrOmed: j.fmrOmed }));
      const augmented = { ...state, jobs: [...state.jobs, ...additional] };
      const schedule = getScheduledJobs(augmented);
      const byId = new Map(schedule.map(j => [j.id, j]));
      const dates = [...new Set(jobs.map(j => j.date))].sort();
      const utilization = dates.flatMap(d => getBoard(augmented, d).lines.map(l => ({ date: d, lineId: l.lineId, hours: l.productionMinutes / 60, available: l.availableMinutes / 60 })));
      const invalid = jobs.some(j => {
        const calendar=getCalendarForDate(state.settings,j.date);
        const end=getShiftWindow(calendar,j.date).end;
        return !Number.isFinite(j.quantity) || (j.unit==='Bags' && !Number.isInteger(j.quantity)) || (byId.get(j.draftId)?.plannedEnd ?? Infinity)>end;
      });
      const demandProgress=preview.demand.map(d=>{const matched=jobs.filter(j=>j.itemId===d.itemId&&(j.sourceOrderId===d.sourceOrderId||!!d.sourceOrderId&&j.sourceAllocations?.some(a=>a.sourceOrderId===d.sourceOrderId))&&j.productionPurpose===d.purpose);const quantity=matched.reduce((sum,j)=>sum+(d.sourceOrderId&&j.sourceAllocations?.length?j.sourceAllocations.filter(a=>a.sourceOrderId===d.sourceOrderId).reduce((n,a)=>n+a.plannedQuantity,0):j.quantity),0);const remaining=Math.max(0,Math.round(((d.sourceAllocationQuantity ?? d.quantity)-quantity)*1000)/1000);const finish=Math.max(0,...matched.map(j=>byId.get(j.draftId)?.plannedEnd??0));const plannedDate=finish?new Date(finish+8*3600000).toISOString().slice(0,10):null;return{d,remaining,plannedDate};});
      const stockExtra = new Map<string,{d:InventoryPlanningDemandRow;target:number}>();
      const bucket = (value:{itemId:string;medication:string;fmrOmed:string}) => JSON.stringify([value.itemId,value.medication.trim().toLowerCase(),value.fmrOmed.trim().toLowerCase()]);
      for (const d of preview.demand) {
        const extra = d.sourceOrderId ? Math.max(0,d.quantity-(d.sourceAllocationQuantity??d.quantity)) : 0;
        if (!extra) continue;
        const key=bucket(d), old=stockExtra.get(key);
        stockExtra.set(key,{d:old?.d??d,target:(old?.target??0)+extra});
      }
      const extraProgress=[...stockExtra.entries()].map(([key,{d,target}])=>{
        const matched=jobs.filter(j=>bucket(j)===key&&j.productionPurpose==='mto');
        const planned=matched.reduce((sum,j)=>sum+Math.max(0,j.quantity-(j.sourceAllocations?.reduce((n,a)=>n+a.plannedQuantity,0)??(j.sourceOrderId?j.quantity:0))),0);
        const remaining=Math.max(0,Math.round((target-planned)*1000)/1000);
        const finish=Math.max(0,...matched.map(j=>byId.get(j.draftId)?.plannedEnd??0));
        return {d:{...d,key:'extra-'+key,sourceOrderId:null,orderNo:'Extra for stock',quantity:target,sourceAllocationQuantity:0},remaining,plannedDate:finish?new Date(finish+8*3600000).toISOString().slice(0,10):null};
      });
      const progress=[...demandProgress,...extraProgress];
      const backlog=progress.filter(row=>row.remaining>0).map(row=>({...row.d,quantity:row.remaining}));
      const late=progress.filter(row=>row.remaining>0||row.plannedDate&&row.plannedDate>row.d.dueDate);
      return { byId, utilization, invalid, backlog, late };
    } catch { return null; }
  }, [state, jobs, preview]);
  async function generate() {
    setBusy(true); setError('');
    try { const p = await previewInventoryDraft({ fromDate: from, toDate: to, demandThrough, combineSameProduct }); setPreview(p); setJobs(p.jobs); setPage(1); }
    catch (e) { setError(e instanceof Error ? e.message : 'Draft could not be generated.'); }
    finally { setBusy(false); }
  }
  const update = (id: string, patch: Partial<InventoryDraftJob>) => setJobs(rows => rows.map(j => j.draftId === id ? { ...j, ...patch, ...(patch.quantity !== undefined && j.sourceAllocations?.length === 1 ? {sourceAllocations: [{...j.sourceAllocations[0], plannedQuantity: Math.min(j.sourceAllocations[0].plannedQuantity, patch.quantity)}]} : {}) } : j));
  const updateAllocation = (id: string, sourceOrderId: string, quantity: number) => setJobs(rows => rows.map(j => {
    if (j.draftId !== id) return j;
    const extra = Math.max(0, j.quantity - j.sourceAllocations!.reduce((n,a)=>n+a.plannedQuantity,0));
    const sourceAllocations = j.sourceAllocations!.map(a => a.sourceOrderId === sourceOrderId ? {...a, plannedQuantity:quantity} : a);
    return {...j, sourceAllocations, quantity: Math.round((extra+sourceAllocations.reduce((n,a)=>n+a.plannedQuantity,0))*1000)/1000};
  }));
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close planning draft" disabled={mutationLocked || busy} onClick={onClose}/><section ref={dialog} tabIndex={-1} className="production-editor import-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-title"><header className="editor-header"><div><h2 id="draft-title">Generate planning draft</h2><p>Reserve existing stock, plan order shortages, then replenish safety stock.</p></div><button className="icon-button" aria-label="Close planning draft" disabled={mutationLocked || busy} onClick={onClose}><X/></button></header><div className="editor-body">
    <div className="inventory-toolbar"><label className="field">Plan from<input type="date" min={localDate()} value={from} onChange={e => { setFrom(e.target.value); setPreview(null); }}/></label><label className="field">Plan through<input type="date" min={from} value={to} onChange={e => { setTo(e.target.value); setPreview(null); }}/></label><label className="field">Orders due by<input type="date" value={demandThrough} onChange={e=>{setDemandThrough(e.target.value);setPreview(null);}}/></label><button className="button secondary" disabled={busy || mutationLocked || hasConflict || !from || !to || !demandThrough || to < from} onClick={() => void generate()}>{busy ? 'Calculating…' : preview ? 'Regenerate draft' : 'Generate draft'}</button></div>
    <label className="draft-combine-option"><input type="checkbox" checked={combineSameProduct} onChange={e => {setCombineSameProduct(e.target.checked); setPreview(null);}}/>Combine same-product orders with the same due date</label>
    <p className="data-note">Earlier due dates are planned first. Compatible orders with the same due date can share a batch; turn this off to keep separate cards. Existing tasks stay in place. Changeover time applies when the product or stock variant changes. All four lines use the saved working hours and unavailable periods; capacity shortages remain unplanned.</p>
    {hasConflict && <p className="notice warning">The workspace changed; your draft is preserved. <button className="text-link" onClick={async () => {await refresh();const latest=await readInventory();resolveConflict();setPreview(p=>p?{...p,revision:latest.revision}:p);}}>Refresh and review retained draft</button></p>}
    {preview && <><div className="draft-summary"><div><strong>{jobs.length}</strong><span>Production cards</span></div><div><strong>{calculated?.backlog.length??preview.backlog.length}</strong><span>Demand rows still unplanned</span></div><div><strong>{calculated?.late.length??preview.late.length}</strong><span>Late / capacity warnings</span></div></div>
      <div className="draft-line-stats">{calculated?.utilization.map(l => <span key={`${l.date}-${l.lineId}`}>{l.date} · {l.lineId} <strong>{l.available > 0 ? Math.round(l.hours / l.available * 100) : 0}%</strong></span>)}</div>
      <div className="table-scroll draft-edit-table"><table><thead><tr><th>PRODUCTION BATCH / ORDERS</th><th>DATE</th><th>LINE</th><th>QUANTITY</th><th>ESTIMATED FINISH</th><th/></tr></thead><tbody>{jobs.slice((page - 1) * 50, page * 50).map(j => <tr key={j.draftId}><td><strong>{productLabel(j)}</strong><small>{j.productionPurpose.toUpperCase()} · {j.sourceAllocations?.length || (j.sourceOrderId ? 1 : 0)} orders</small><small>{j.orderNo}</small><small>{j.materialCode}</small><small>{j.medication || 'Standard'} / {j.fmrOmed || '—'}</small>{j.sourceAllocations && j.sourceAllocations.length > 0 && <details><summary>{j.sourceAllocations.length} {j.sourceAllocations.length===1?'order allocation':'order allocations'} · quantities and due dates</summary>{j.sourceAllocations.map(a => <label className="field" key={a.sourceOrderId}>{preview.demand.find(d=>d.sourceOrderId===a.sourceOrderId)?.orderNo || a.sourceOrderId}<small>Due {dateLabel(preview.demand.find(d=>d.sourceOrderId===a.sourceOrderId)!.dueDate, true)} · {j.unit}</small><input aria-label={`Allocation ${j.draftId} ${a.sourceOrderId}`} type="number" min={j.unit==='Bags'?1:.001} step={j.unit==='Bags'?1:.001} value={a.plannedQuantity} onChange={e=>updateAllocation(j.draftId,a.sourceOrderId,+e.target.value)}/></label>)}<label className="field">Extra for stock ({j.unit})<input aria-label={`Stock extra ${j.draftId}`} type="number" min="0" step={j.unit==='Bags'?1:.001} value={Math.max(0,Math.round((j.quantity-j.sourceAllocations.reduce((n,a)=>n+a.plannedQuantity,0))*1000)/1000)} onChange={e=>update(j.draftId,{quantity:Math.round((j.sourceAllocations!.reduce((n,a)=>n+a.plannedQuantity,0)+Number(e.target.value))*1000)/1000})}/></label></details>}</td><td><input type="date" min={from} max={to} aria-label={`Date ${j.draftId}`} value={j.date} onChange={e => e.target.value && update(j.draftId, { date: e.target.value, notBefore: new Date(Math.max(getShiftWindow(getCalendarForDate(state.settings,e.target.value),e.target.value).start, Date.now())).toISOString() })}/></td><td><select aria-label={`Line ${j.draftId}`} value={j.lineId} onChange={e => update(j.draftId, { lineId: e.target.value as LineId })}>{LINE_IDS.map(l => <option key={l}>{l}</option>)}</select></td><td><input aria-label={`Quantity ${j.draftId}`} readOnly={(j.sourceAllocations?.length ?? 0) > 1} title={(j.sourceAllocations?.length ?? 0) > 1 ? 'Edit individual order allocations to change this total' : undefined} type="number" min={j.unit === 'Bags' ? 1 : .001} step={j.unit === 'Bags' ? 1 : .001} value={j.quantity} onChange={e => update(j.draftId, { quantity: +e.target.value })}/><small>{j.unit} · {numberLabel(j.unit === 'Bags' ? j.quantity * j.bagWeightKg! / 1000 : j.quantity, 3)} MT</small></td><td>{fullDateTime(calculated?.byId.get(j.draftId)?.plannedEnd ?? null)}</td><td><button className="icon-button danger-text" aria-label={`Remove ${j.draftId}`} onClick={() => setJobs(rows => rows.filter(row => row.draftId !== j.draftId))}><Trash2 size={16}/></button></td></tr>)}</tbody></table></div>
      <div className="data-pagination"><span>{jobs.length ? (page - 1) * 50 + 1 : 0}–{Math.min(page * 50, jobs.length)} of {jobs.length}</span><div><button className="button secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button><button className="button secondary" disabled={page * 50 >= jobs.length} onClick={() => setPage(p => p + 1)}>Next</button></div></div>
      {(calculated?.backlog.length??preview.backlog.length) > 0 && <details><summary>Unscheduled demand</summary>{(calculated?.backlog??preview.backlog).map(d => <p key={d.key}>{d.orderNo || 'Stock replenishment'} · {d.materialCode}: {numberLabel(d.quantity, 3)} {d.unit} · due {d.dueDate}</p>)}</details>}
      {calculated?.invalid && <p className="notice warning">An edited card extends beyond its day. Reduce its quantity or assign another day before saving.</p>}
      {!jobs.length && <p className="data-empty">No cards to save. Stock and existing plans may cover demand, or no capacity is available in this range.</p>}
    </>}{(error || toast?.error) && <p className="data-error" role="alert">{error || toast?.message}</p>}
  </div><footer className="editor-footer"><button className="button secondary" disabled={mutationLocked || busy} onClick={onClose}>Cancel</button><div className="toolbar-spacer"/><button className="button primary" disabled={!preview || !jobs.length || busy || mutationLocked || hasConflict || !calculated || calculated.invalid || jobs.some(j => j.quantity <= 0 || j.sourceAllocations?.some(a => a.plannedQuantity <= 0))} onClick={async () => { if (preview && await commit({ type: 'planning.commitDraft', previewRevision: preview.revision, jobs }, 'Planning draft saved.')) { setDate(from); navigate('planning'); onClose(); } }}>Confirm {jobs.length} cards</button></footer></section></div>;
}
