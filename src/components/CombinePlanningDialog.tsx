import { useEffect, useRef, useState } from 'react';
import { Combine, X } from 'lucide-react';
import { getCompatiblePendingJobs, getJobSourceAllocations, getProductionBatchIdentity } from '../domain/jobSources';
import type { Job } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import { dateLabel, numberLabel } from '../lib/format';
import { productLabel } from '../lib/productLabel';
import { useOrderMetadata } from '../lib/useOrderMetadata';
import { useModal } from './useModal';
import './CombinedProduction.css';

export function CombinePlanningButton() {
  const {storageMode, mutationLocked, hasConflict} = useWorkspace();
  const [open, setOpen] = useState(false);
  return <><button className="button secondary" disabled={storageMode !== 'database' || mutationLocked || hasConflict} onClick={() => setOpen(true)}><Combine size={15}/>Combine cards</button>{open && <CombinePlanningDialog onClose={() => setOpen(false)}/>}</>;
}
export function CombinePlanningDialog({onClose, anchorJobId, onSaved}: {onClose: () => void; anchorJobId?: string; onSaved?: (survivorId: string) => void}) {
  const {state, date, commit, mutationLocked, hasConflict, resolveConflict, confirmedRetry, toast, storageWarning, refresh, busy, storageMode} = useWorkspace();
  const anchor = state.jobs.find(job => job.id === anchorJobId);
  const planningDate = anchor?.date ?? date;
  const dialog = useModal(() => {if (!mutationLocked) onClose();});
  const [selected, setSelected] = useState<string[]>(anchorJobId ? [anchorJobId] : []);
  const [bin, setBin] = useState(anchor?.bin ?? '');
  const [remarks, setRemarks] = useState(anchor?.remarks ?? '');
  const [failed, setFailed] = useState(false);
  const retry = useRef(confirmedRetry?.nonce ?? 0);
  useEffect(() => {if (confirmedRetry && confirmedRetry.nonce > retry.current && confirmedRetry.type === 'job.combinePending') onClose();}, [confirmedRetry?.nonce]);
  const candidates = anchorJobId ? anchor ? getCompatiblePendingJobs(state.jobs, anchor) : [] : state.jobs.filter(job => job.date === date && job.status === 'pending' && getJobSourceAllocations(job).length > 0).sort((a,b) => a.lineId.localeCompare(b.lineId) || a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const {metadata, loading, failed: metadataFailed, retry: retryMetadata} = useOrderMetadata(candidates, storageMode === 'database');
  const first = candidates.find(job => selected.includes(job.id));
  const picked = candidates.filter(job => selected.includes(job.id));
  const selectedSources = picked.flatMap(getJobSourceAllocations);
  const selectedSourceIds = new Set(selectedSources.map(row => row.sourceOrderId));
  const incompatible = (job: Job) => !selected.includes(job.id) && Boolean(first && getProductionBatchIdentity(first) !== getProductionBatchIdentity(job) || getJobSourceAllocations(job).some(row => selectedSourceIds.has(row.sourceOrderId)) || selectedSources.length + getJobSourceAllocations(job).length > 500);
  function toggle(job: Job) {
    if (incompatible(job) || job.id === anchorJobId || mutationLocked || hasConflict) return;
    if (!selected.length) {setBin(job.bin); setRemarks(job.remarks);}
    setSelected(ids => ids.includes(job.id) ? ids.filter(id => id !== job.id) : [...ids, job.id]);
    setFailed(false);
  }
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close combine cards" disabled={mutationLocked} onClick={onClose}/><section ref={dialog} tabIndex={-1} className="production-editor" role="dialog" aria-modal="true" aria-labelledby="combine-title">
    <header className="editor-header"><div><h2 id="combine-title">Combine production cards</h2><p>Combine not-started orders on the same day and line into one production run.</p></div><button className="icon-button" aria-label="Close combine cards" disabled={mutationLocked} onClick={onClose}><X size={21}/></button></header>
    <form onSubmit={async e => {e.preventDefault(); if (selected.length < 2 || picked.length !== selected.length) return; if (await commit({type:'job.combinePending', jobIds:selected, bin, remarks}, 'Production cards combined. Each order remains in the card details.')) {if (onSaved) onSaved(picked[0].id); else onClose();} else setFailed(true);}}>
      <div className="editor-body">
        <p className="data-note">Choose the orders you want to produce in one batch and check their delivery dates below. Combining is optional. Only the same full material code, packaging, bag weight, Medication and FMR / OMED can be combined. The earliest selected position is kept. Original cards remain in History as cancelled records.</p>
        {anchor && <p className="combine-anchor-note"><strong>{productLabel(anchor)} · {anchor.lineId} · {dateLabel(planningDate, true)}</strong><span>The current card is selected. Choose the other orders to add to this batch.</span></p>}
        {hasConflict && <p className="notice warning" role="alert">The workspace changed. Review the latest cards before combining.<button type="button" className="text-link" onClick={() => {resolveConflict(); setSelected(anchor && candidates.some(job => job.id === anchor.id) ? [anchor.id] : []); setFailed(false);}}>Reload selection</button></p>}
        <fieldset className="combined-order-list" disabled={mutationLocked || hasConflict}><legend>Select cards · {planningDate}</legend><div className="combine-card-list">{candidates.length ? candidates.map(job => <label className="combine-card-option" key={job.id} title={incompatible(job) ? 'Choose the same product, packaging, line and stock variant within 500 orders' : undefined}><input type="checkbox" aria-label={`Combine ${job.orderNo}`} checked={selected.includes(job.id)} disabled={incompatible(job) || job.id === anchorJobId} onChange={() => toggle(job)}/><span><strong>{productLabel(job)} · {job.lineId} · {numberLabel(job.quantityMt,3)} MT</strong><span>{getJobSourceAllocations(job).map(a => {
          const source = a.sourceSnapshot, current = metadata[a.sourceOrderId];
          const delivery = source.deliveryDate || current?.deliveryDate;
          const customer = source.shipToParty || source.soldToParty || current?.shipToParty || current?.soldToParty;
          return <span className="combine-order-detail" key={a.sourceOrderId}><b>DO {source.doNo} · {numberLabel(a.plannedQuantity, source.unit === 'Bags' ? 0 : 3)} {source.unit}</b><small>{customer || (loading ? 'Loading customer…' : 'Customer unavailable')}</small><small>Delivery {delivery ? dateLabel(delivery, true) : loading ? 'loading…' : 'not recorded'}</small></span>;
        })}</span><small>{job.productCode} · {job.mode === 'bags' ? `${job.bagWeightKgSnapshot ?? state.settings.bagWeightKg}kg bags` : 'Bulk'} · {job.medication || 'Standard'} / {job.fmrOmed || 'No FMR / OMED'}</small></span></label>) : <p className="data-empty">No not-started order cards on this date. Use Plan from Data to create a card with several orders.</p>}</div></fieldset>
        {metadataFailed && <p role="status">Some customer or delivery details could not load. <button type="button" className="text-link" onClick={retryMetadata}>Retry details</button></p>}
        <p aria-live="polite"><strong>{picked.length} {picked.length === 1 ? 'card' : 'cards'} → {selectedSources.length} {selectedSources.length === 1 ? 'order' : 'orders'} · {numberLabel(picked.reduce((n,j) => n+j.quantityMt,0),3)} MT</strong></p>
        {picked.length > 1 && <div className="field-grid"><label className="field span-2">Destination bin for combined card<input maxLength={120} value={bin} onChange={e => setBin(e.target.value)}/></label><label className="field span-2">Remarks for combined card<textarea maxLength={1000} value={remarks} onChange={e => setRemarks(e.target.value)}/></label></div>}
        {picked.length > 1 && (new Set(picked.map(j => j.bin)).size > 1 || new Set(picked.map(j => j.remarks)).size > 1) && <p className="notice warning">The selected cards have different bins or remarks. Check the combined values above; the original values stay in History.</p>}
        {failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
        {storageWarning && <div className="notice warning" role="alert">{storageWarning}<button type="button" className="text-link" disabled={busy} onClick={() => void refresh()}>Retry connection</button></div>}
      </div><footer className="editor-footer"><button type="button" className="button secondary" disabled={mutationLocked} onClick={onClose}>Cancel</button><div className="toolbar-spacer"/><button className="button primary" disabled={selected.length < 2 || picked.length !== selected.length || mutationLocked || hasConflict}>{mutationLocked ? 'Combining…' : 'Combine selected cards'}</button></footer>
    </form>
  </section></div>;
}
