import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight, AlertTriangle } from 'lucide-react';
import { previewMoveImpact } from '../domain/moveImpact';
import type { MoveImpactInput, PlannedRange } from '../domain/moveImpact';
import type { AppState } from '../domain/types';
import { readInventoryOrders } from '../lib/inventoryApi';
import { useWorkspace } from '../lib/workspace';
import { fullDateTime, dateLabel, numberLabel } from '../lib/format';
import { productLabel } from '../lib/productLabel';
import { useModal } from './useModal';
import './MoveImpactDialog.css';

const rangeLabel = (range: PlannedRange) => `${fullDateTime(range.plannedStart)} → ${fullDateTime(range.plannedEnd)}`;

export function MoveImpactDialog({ input, onClose, onSaved }: { input: MoveImpactInput; onClose: () => void; onSaved: () => void }) {
  const { state, revision, storageMode, commit, mutationLocked, hasConflict, toast } = useWorkspace();
  const [base] = useState(() => ({ state, revision }));
  const [sourceState, setSourceState] = useState<AppState | null>(storageMode === 'offline' ? base.state : null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [riskPage, setRiskPage] = useState(1);
  const close = () => { if (!mutationLocked) onClose(); };
  const dialog = useModal(close, true);
  const stale = hasConflict || (storageMode === 'database' ? revision !== base.revision : state !== base.state);
  useEffect(() => {
    if (storageMode !== 'database') return;
    let active = true; setSourceState(null); setError('');
    readInventoryOrders().then(data => {
      if (!active) return;
      if (data.revision !== base.revision) throw new Error('The workspace changed. Close this preview and review the latest plan.');
      const dueDates = new Map(data.orders.map(order => [order.sourceOrderId, order.dueDate]));
      setSourceState({ ...base.state, jobs: base.state.jobs.map(job => ({ ...job,
        ...(job.sourceSnapshot && job.sourceOrderId && dueDates.has(job.sourceOrderId) ? { sourceSnapshot: { ...job.sourceSnapshot, deliveryDate: dueDates.get(job.sourceOrderId)! } } : {}),
        ...(job.sourceAllocations ? { sourceAllocations: job.sourceAllocations.map(allocation => ({ ...allocation, sourceSnapshot: { ...allocation.sourceSnapshot, ...(dueDates.has(allocation.sourceOrderId) ? { deliveryDate: dueDates.get(allocation.sourceOrderId)! } : {}) } })) } : {}),
      })) });
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Current order deadlines could not be loaded.'); });
    return () => { active = false; };
  }, [base, storageMode, reload]);
  const calculated = useMemo(() => {
    if (!sourceState) return null;
    try { return { preview: previewMoveImpact(sourceState, input, base.revision ?? undefined), error: '' }; }
    catch (reason) { return { preview: null, error: reason instanceof Error ? reason.message : 'This move cannot be scheduled.' }; }
  }, [sourceState, input, base.revision]);
  const preview = calculated?.preview;
  const job = base.state.jobs.find(row => row.id === input.jobId);
  const risks = preview?.dueRisks.filter(risk => risk.afterLate === true || !risk.dueDateKnown) ?? [];
  const newLate = risks.filter(risk => risk.afterLate === true && risk.beforeLate === false).length;
  const unknown = risks.filter(risk => !risk.dueDateKnown).length;
  const changed = preview?.changedJobs ?? [];
  return createPortal(<div className="editor-layer move-impact-layer"><button className="editor-scrim" disabled={mutationLocked} onClick={close} aria-label="Close move preview"/><section ref={dialog} tabIndex={-1} className="production-editor move-impact-dialog" role="dialog" aria-modal="true" aria-labelledby="move-impact-title">
    <header className="editor-header"><div><h2 id="move-impact-title">Review production move</h2><p>{job ? `${productLabel(job)} · ${job.lineId} → ${input.toLineId}` : 'Review schedule changes before saving.'}</p></div><button className="icon-button" disabled={mutationLocked} onClick={close} aria-label="Close move preview"><X/></button></header>
    <div className="editor-body">
      {toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
      {stale && <p className="notice warning" role="alert">The workspace changed after this preview. Close it and review the latest plan before moving.</p>}
      {(error || calculated?.error) && <p className="data-error" role="alert">{error || calculated?.error}{error && !stale && <button className="text-link" onClick={() => setReload(n => n + 1)}>Retry preview</button>}</p>}
      {!sourceState && !error && <p role="status">Checking current order deadlines and schedule…</p>}
      {preview && <><dl className="move-range"><div><dt>Current schedule</dt><dd>{rangeLabel(preview.moved.before)}</dd></div><ArrowRight size={19}/><div><dt>After move</dt><dd>{rangeLabel(preview.moved.after)}</dd></div></dl>
        <div className="move-capacity">{preview.lineUtilization.map(line => <span key={line.lineId}><strong>{line.lineId}</strong> {line.before === null ? '—' : numberLabel(line.before * 100, 0) + '%'} → {line.after === null ? '—' : numberLabel(line.after * 100, 0) + '%'} planned</span>)}</div>
        <p className={risks.length ? 'notice warning' : 'data-note'}>{risks.length > 0 && <AlertTriangle size={16}/>} {newLate} newly late order {newLate === 1 ? 'allocation' : 'allocations'} · {unknown} deadlines unavailable. {risks.length ? 'Review affected orders below.' : 'No late order completion found among affected cards with known deadlines.'}</p>
        <section className="move-impact-section"><h3>{changed.length} other production {changed.length === 1 ? 'task changes' : 'tasks change'}</h3>{changed.length ? <><div className="table-scroll"><table><thead><tr><th>PRODUCT / LINE</th><th>BEFORE</th><th>AFTER</th></tr></thead><tbody>{changed.slice((page - 1) * 20, page * 20).map(change => <tr key={change.jobId}><td><strong>{productLabel(base.state.jobs.find(row => row.id === change.jobId)!)}</strong><small>{change.lineId} · {change.orderNo}</small></td><td>{rangeLabel(change.before)}</td><td>{rangeLabel(change.after)}</td></tr>)}</tbody></table></div><div className="data-pagination"><span>{(page - 1) * 20 + 1}–{Math.min(page * 20, changed.length)} of {changed.length}</span><button className="button secondary" disabled={page === 1} onClick={() => setPage(n => n - 1)}>Previous changes</button><button className="button secondary" disabled={page * 20 >= changed.length} onClick={() => setPage(n => n + 1)}>Next changes</button></div></> : <p className="data-note">Other task start and end times stay the same.</p>}</section>
        {!!risks.length && <section className="move-impact-section"><h3>Order deadline checks · {risks.length}</h3><div className="move-risk-list">{risks.slice((riskPage - 1) * 20, riskPage * 20).map((risk, index) => <div key={risk.jobId + ':' + (risk.sourceOrderId ?? index)}><strong>{risk.orderNo || 'Manual production'}</strong><span>{risk.dueDateKnown ? `Due ${dateLabel(risk.dueDate!, true)}` : 'Deadline unavailable; verify before confirming'}</span><small>{risk.afterLate === true ? risk.beforeLate ? 'Already late before this move' : 'New late completion after this move' : 'Cannot assess deadline'} · New finish {fullDateTime(risk.afterPlannedEnd)}</small></div>)}</div>{risks.length > 20 && <div className="data-pagination"><span>{(riskPage - 1) * 20 + 1}–{Math.min(riskPage * 20, risks.length)} of {risks.length}</span><button className="button secondary" disabled={riskPage === 1} onClick={() => setRiskPage(n => n - 1)}>Previous deadlines</button><button className="button secondary" disabled={riskPage * 20 >= risks.length} onClick={() => setRiskPage(n => n + 1)}>Next deadlines</button></div>}</section>}
        <p className="data-note">Dates and quantities stay unchanged. Running, paused and completed plans remain locked. A line change still requires a bin check.</p>
      </>}
    </div><footer className="editor-footer"><button className="button secondary" disabled={mutationLocked} onClick={close}>Cancel move</button><div className="toolbar-spacer"/><button className="button primary" disabled={!preview || !!error || stale || mutationLocked} onClick={async () => { if (!stale && await commit({ type: 'job.move', ...input }, 'Production moved. Review its destination bin.', true)) onSaved(); }}>Confirm move</button></footer>
  </section></div>, document.body);
}
