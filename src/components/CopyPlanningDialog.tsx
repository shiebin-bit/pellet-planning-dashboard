import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Copy, X } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { addDays, fullDateTime, numberLabel } from '../lib/format';
import { executeCommand } from '../domain/commands';
import type { CopyBatchItem } from '../domain/commands';
import { getBoard } from '../domain/engine';
import { LINE_IDS } from '../domain/types';
import type { AppState, Job, LineId } from '../domain/types';
import { EmptyState } from './Shared';
import './ProductionEditor.css';
import './CopyPlanningDialog.css';

interface Draft { selected: boolean; orderNo: string; quantity: string; mode: Job['mode'] }
function sourceJobs(state: AppState, date: string) {
  return state.jobs.filter(job => job.date === date && job.status !== 'cancelled')
    .sort((a, b) => a.lineId.localeCompare(b.lineId) || a.sequence - b.sequence);
}
function newDraft(job: Job, selected = true): Draft {
  return { selected, orderNo: '', quantity: String(job.mode === 'bags' ? job.bagCount ?? 0 : job.quantityMt), mode: job.mode };
}
function initialDrafts(state: AppState, date: string) {
  return Object.fromEntries(sourceJobs(state, date).map(job => [job.id, newDraft(job)]));
}

export function CopyPlanningDialog() {
  const { state, copyDialog, closeCopy, setDate, commit, mutationLocked, hasConflict, resolveConflict, storageWarning, refresh, busy, toast } = useWorkspace();
  const [from, setFrom] = useState(() => addDays(copyDialog!.targetDate, -1));
  const [to, setTo] = useState(copyDialog!.targetDate);
  const [line, setLine] = useState<LineId | 'all'>('all');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => initialDrafts(state, from));
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState('');
  useEffect(() => { if (failed && toast?.error) setFailureMessage(toast.message); }, [failed, toast]);
  const dialog = useRef<HTMLElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    firstField.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; previousFocus.current?.isConnected && previousFocus.current.focus(); };
  }, []);
  const sources = useMemo(() => sourceJobs(state, from), [state.jobs, from]);
  const visible = useMemo(() => sources.filter(job => line === 'all' || job.lineId === line), [sources, line]);
  const selected = useMemo(() => visible.filter(job => drafts[job.id]?.selected), [visible, drafts]);
  const allSelected = visible.length > 0 && selected.length === visible.length;
  const missingOrders = selected.filter(job => !drafts[job.id]?.orderNo.trim()).length;
  const update = (job: Job, patch: Partial<Draft>) => setDrafts(previous => ({ ...previous, [job.id]: { ...(previous[job.id] ?? newDraft(job, false)), ...patch } }));
  const items = useMemo((): CopyBatchItem[] => selected.map(job => ({
    sourceJobId: job.id,
    orderNo: drafts[job.id].orderNo.trim(),
    quantity: job.mode === 'bags' ? { mode: 'bags', bagCount: Number(drafts[job.id].quantity) } : { mode: 'bulk', quantityMt: Number(drafts[job.id].quantity) },
  })), [selected, drafts]);
  const preview = useMemo(() => {
    try {
      if (!from || !to) throw new Error('Choose a source date and a target date.');
      if (from === to) throw new Error('Choose a target date different from the source date.');
      if (selected.length > 500) throw new Error('Select up to 500 cards per copy.');
      if (selected.some(job => drafts[job.id].quantity.trim() === '' || !Number.isFinite(Number(drafts[job.id].quantity)))) throw new Error('Enter a valid quantity for every selected card.');
      // The preview is an in-memory command only. Placeholder references never reach the API.
      const candidate = items.length ? executeCommand(state, { type: 'job.copyBatch', sourceDate: from, targetDate: to, items: items.map(item => ({ ...item, orderNo: item.orderNo || 'New order (preview)' })) }) : state;
      return { board: getBoard(candidate, to), error: '' };
    } catch (error) { return { board: null, error: error instanceof Error ? error.message : 'The copied plan cannot be scheduled.' }; }
  }, [state, from, to, items, selected, drafts]);
  const existing = state.jobs.filter(job => job.date === to && job.status !== 'cancelled').length;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!items.length || missingOrders || preview.error || mutationLocked || hasConflict) return;
    setFailed(false); setFailureMessage('');
    if (await commit({ type: 'job.copyBatch', sourceDate: from, targetDate: to, items }, `Copied ${items.length} production tasks to ${to}.`)) {
      setDate(to); closeCopy();
    } else setFailed(true);
  }
  return <div className="editor-layer">
    <button className="editor-scrim" aria-label="Close copy planning" disabled={mutationLocked} onClick={closeCopy}/>
    <section className="production-editor copy-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="copy-title" aria-describedby="copy-description" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCopy(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])') ?? []).filter(element => element.offsetParent !== null && !element.closest('[inert]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="editor-header"><div><h2 id="copy-title">Copy planning</h2><p id="copy-description">Choose cards, enter new order references and review the target day before saving.</p></div><button type="button" className="icon-button" disabled={mutationLocked} aria-label="Close copy planning" onClick={closeCopy}><X size={21}/></button></header>
      <form onSubmit={submit}>
        <div className="editor-body" inert={mutationLocked || hasConflict}>
          <div className="copy-controls">
            <label className="field">Copy from<input ref={firstField} type="date" required value={from} onChange={event => { setFrom(event.target.value); setDrafts(initialDrafts(state, event.target.value)); setFailed(false); }}/></label>
            <label className="field">Target date<input type="date" required value={to} onChange={event => setTo(event.target.value)}/></label>
            <label className="field">Source line<select value={line} onChange={event => setLine(event.target.value as LineId | 'all')}><option value="all">All lines</option>{LINE_IDS.map(id => <option key={id}>{id}</option>)}</select></label>
          </div>
          <p className="copy-note">{existing ? `${existing} existing tasks on the target date will be kept. New cards are appended on the same lines.` : 'New cards will start on the same lines, with status Not started.'} Cancelled source tasks are excluded.</p>
          {preview.board && <div className="copy-line-preview" aria-label="Target day preview">{preview.board.lines.map(schedule => <div key={schedule.lineId}>
            <strong>{schedule.lineId}<span>{numberLabel(schedule.plannedMt)} MT</span></strong>
            <span>{schedule.utilisation === null ? '—' : numberLabel(schedule.utilisation * 100, 0) + '%'} planned utilisation</span>
            <small className={schedule.finishAt !== null && schedule.finishAt > preview.board!.end ? 'copy-overflow' : ''}>{schedule.finishAt ? `Finish ${fullDateTime(schedule.finishAt)}` : 'No production scheduled'}{schedule.finishAt !== null && schedule.finishAt > preview.board!.end ? ' · Carry-over' : ''}</small>
          </div>)}</div>}
          {preview.error && <p className="copy-validation" role="alert"><AlertTriangle size={16}/>{preview.error}</p>}
          {visible.length ? <div className="copy-table-scroll"><table className="copy-table"><thead><tr><th><input type="checkbox" aria-label="Select all visible cards" checked={allSelected} onChange={() => setDrafts(previous => ({ ...previous, ...Object.fromEntries(visible.map(job => [job.id, { ...(previous[job.id] ?? newDraft(job, false)), selected: !allSelected }])) }))}/></th><th>PRODUCT / LINE</th><th>NEW ORDER REFERENCE *</th><th>QUANTITY</th></tr></thead><tbody>{visible.map(job => {
            const draft = drafts[job.id] ?? newDraft(job, false);
            return <tr key={job.id} className={draft.selected ? '' : 'copy-unselected'} data-copy-source={job.id}>
              <td><input type="checkbox" aria-label={'Copy ' + job.productCode + ' on ' + job.lineId + ' position ' + job.sequence} checked={draft.selected} onChange={() => update(job, { selected: !draft.selected })}/></td>
              <td><strong>{job.productCode}</strong><small>{job.lineId} · {job.mode === 'bags' ? 'Bags' : 'Bulk'} · #{job.sequence}</small></td>
              <td><input type="text" aria-label={`New order reference ${job.productCode} on ${job.lineId} position ${job.sequence}`} required={draft.selected} disabled={!draft.selected} maxLength={120} placeholder="Enter new order reference" value={draft.orderNo} onChange={event => update(job, { orderNo: event.target.value })}/></td>
              <td><div className="input-with-unit"><input type="number" aria-label={`Copy quantity ${job.productCode} on ${job.lineId} in ${job.mode === 'bags' ? 'bags' : 'MT'}`} required={draft.selected} disabled={!draft.selected} min="0" step={job.mode === 'bags' ? '1' : '0.01'} value={draft.quantity} onChange={event => update(job, { quantity: event.target.value })}/><span>{job.mode === 'bags' ? 'bags' : 'MT'}</span></div></td>
            </tr>;
          })}</tbody></table></div> : <EmptyState title="No cards to copy" text="Choose another source date or line with non-cancelled production tasks."/>}
          <p className="copy-note" aria-live="polite">{selected.length} cards selected{missingOrders ? ` · ${missingOrders} new order references still required` : ''}. Actual results, recorded pauses, problems and completion details are cleared on the new cards.</p>
        </div>
        {hasConflict && <div className="editor-feedback error" role="alert">The workspace changed. Your order references are preserved. Review the source and quantities; changed packaging reloads its source quantity. <button type="button" className="text-link" onClick={() => {
          setDrafts(previous => Object.fromEntries(sourceJobs(state, from).map(job => {
            const old = previous[job.id];
            return [job.id, !old ? newDraft(job, false) : old.mode === job.mode ? old : { ...old, mode: job.mode, quantity: newDraft(job).quantity }];
          }))); resolveConflict(); setFailed(false); setFailureMessage('');
        }}>Review latest source plan</button></div>}
        {failed && failureMessage && <p className="editor-feedback error" role="alert">{failureMessage}</p>}
        {storageWarning && <div className="editor-feedback error" role="alert">{storageWarning} <button className="text-link" type="button" disabled={busy} onClick={() => void refresh()}>Retry connection</button></div>}
        <footer className="editor-footer"><span className="copy-save-note">One batch · new cards only</span><div className="toolbar-spacer"/><button type="button" className="button secondary" disabled={mutationLocked} onClick={closeCopy}>Cancel</button><button type="submit" className="button primary" disabled={mutationLocked || hasConflict || !selected.length || !!missingOrders || !!preview.error}><Copy size={16}/>{busy ? 'Saving…' : `Copy ${selected.length} cards`}</button></footer>
      </form>
    </section>
  </div>;
}
