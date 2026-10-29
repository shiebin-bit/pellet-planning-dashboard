import { useEffect, useRef, useState } from 'react';
import { Combine, X } from 'lucide-react';
import { getJobSourceAllocations } from '../domain/jobSources';
import type { Job } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import { numberLabel } from '../lib/format';
import { productLabel } from '../lib/productLabel';
import { useModal } from './useModal';
import './CombinedProduction.css';

const key = (job: Job) => JSON.stringify([job.date, job.lineId, job.inventoryItemId ?? job.productCode.trim().toLowerCase(), job.productCode.trim().toLowerCase(), job.mode, job.bagWeightKgSnapshot ?? null, job.medication ?? '', job.fmrOmed ?? '', job.productionPurpose ?? 'mto']);
export function CombinePlanningButton() {
  const {storageMode, mutationLocked, hasConflict} = useWorkspace();
  const [open, setOpen] = useState(false);
  return <><button className="button secondary" disabled={storageMode !== 'database' || mutationLocked || hasConflict} onClick={() => setOpen(true)}><Combine size={15}/>Combine cards</button>{open && <CombinePlanningDialog onClose={() => setOpen(false)}/>}</>;
}
function CombinePlanningDialog({onClose}: {onClose: () => void}) {
  const {state, date, commit, mutationLocked, hasConflict, resolveConflict, confirmedRetry, toast} = useWorkspace();
  const dialog = useModal(onClose);
  const [selected, setSelected] = useState<string[]>([]);
  const [bin, setBin] = useState('');
  const [remarks, setRemarks] = useState('');
  const [failed, setFailed] = useState(false);
  const retry = useRef(confirmedRetry?.nonce ?? 0);
  useEffect(() => {if (confirmedRetry && confirmedRetry.nonce > retry.current && confirmedRetry.type === 'job.combinePending') onClose();}, [confirmedRetry?.nonce]);
  const candidates = state.jobs.filter(job => job.date === date && job.status === 'pending' && getJobSourceAllocations(job).length > 0).sort((a,b) => a.lineId.localeCompare(b.lineId) || a.sequence - b.sequence);
  const first = candidates.find(job => selected.includes(job.id));
  const picked = candidates.filter(job => selected.includes(job.id));
  const incompatible = (job: Job) => Boolean(first && key(first) !== key(job));
  function toggle(job: Job) {
    if (incompatible(job) || mutationLocked || hasConflict) return;
    if (!selected.length) {setBin(job.bin); setRemarks(job.remarks);}
    setSelected(ids => ids.includes(job.id) ? ids.filter(id => id !== job.id) : [...ids, job.id]);
    setFailed(false);
  }
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close combine cards" disabled={mutationLocked} onClick={onClose}/><section ref={dialog} tabIndex={-1} className="production-editor" role="dialog" aria-modal="true" aria-labelledby="combine-title">
    <header className="editor-header"><div><h2 id="combine-title">Combine production cards</h2><p>Combine not-started orders on the same day and line into one production run.</p></div><button className="icon-button" aria-label="Close combine cards" disabled={mutationLocked} onClick={onClose}><X size={21}/></button></header>
    <form onSubmit={async e => {e.preventDefault(); if (selected.length < 2) return; if (await commit({type:'job.combinePending', jobIds:selected, bin, remarks}, 'Production cards combined. Each order remains in the card details.')) onClose(); else setFailed(true);}}>
      <div className="editor-body">
        <p className="data-note">Only the same full material code, packaging, bag weight, Medication and FMR / OMED can be combined. The earliest selected position is kept. Original cards remain in History as cancelled records.</p>
        {hasConflict && <p className="notice warning" role="alert">The workspace changed. Review the latest cards before combining.<button type="button" className="text-link" onClick={() => {resolveConflict(); setSelected([]); setFailed(false);}}>Reload selection</button></p>}
        <fieldset className="combined-order-list" disabled={mutationLocked || hasConflict}><legend>Select cards · {date}</legend><div className="combine-card-list">{candidates.length ? candidates.map(job => <label className="combine-card-option" key={job.id} title={incompatible(job) ? 'Choose the same product, packaging, line and stock variant' : undefined}><input type="checkbox" aria-label={`Combine ${job.orderNo}`} checked={selected.includes(job.id)} disabled={incompatible(job)} onChange={() => toggle(job)}/><span><strong>{productLabel(job)} · {job.lineId} · {numberLabel(job.quantityMt,3)} MT</strong><span>{getJobSourceAllocations(job).map(a => a.sourceSnapshot.doNo).join(' · ')}</span><small>{job.productCode} · {job.mode === 'bags' ? `${job.bagWeightKgSnapshot ?? state.settings.bagWeightKg}kg bags` : 'Bulk'} · {job.medication || 'Standard'} / {job.fmrOmed || 'No FMR / OMED'}</small></span></label>) : <p className="data-empty">No not-started order cards on this date. Use Plan from Data to create a card with several orders.</p>}</div></fieldset>
        <p aria-live="polite"><strong>{picked.length} cards · {numberLabel(picked.reduce((n,j) => n+j.quantityMt,0),3)} MT</strong></p>
        {picked.length > 1 && <div className="field-grid"><label className="field span-2">Destination bin for combined card<input maxLength={120} value={bin} onChange={e => setBin(e.target.value)}/></label><label className="field span-2">Remarks for combined card<textarea maxLength={1000} value={remarks} onChange={e => setRemarks(e.target.value)}/></label></div>}
        {picked.length > 1 && (new Set(picked.map(j => j.bin)).size > 1 || new Set(picked.map(j => j.remarks)).size > 1) && <p className="notice warning">The selected cards have different bins or remarks. Check the combined values above; the original values stay in History.</p>}
        {failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
      </div><footer className="editor-footer"><button type="button" className="button secondary" disabled={mutationLocked} onClick={onClose}>Cancel</button><div className="toolbar-spacer"/><button className="button primary" disabled={selected.length < 2 || picked.length !== selected.length || mutationLocked || hasConflict}>{mutationLocked ? 'Combining…' : 'Combine selected cards'}</button></footer>
    </form>
  </section></div>;
}
