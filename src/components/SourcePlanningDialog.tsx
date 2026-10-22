import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { DataBrowser, SourceStatus, canPlanSource } from '../pages/Data';
import type { SourceOrderSummary } from '../domain/sourceTypes';
import { LINE_IDS } from '../domain/types';
import type { LineId } from '../domain/types';
import { getRate } from '../domain/engine';
import { durationLabel, numberLabel } from '../lib/format';
import { useModal } from './useModal';
import './ProductionEditor.css';

export function SourcePlanningDialog() {
  const { sourceDialog, closeSource, state, date, setDate, navigate, commit, mutationLocked, hasConflict, resolveConflict, storageWarning, refresh, toast, confirmedRetry } = useWorkspace();
  const [order, setOrder] = useState<SourceOrderSummary | null>(sourceDialog!.order);
  const [line, setLine] = useState<LineId>('PM1');
  const [planningDate, setPlanningDate] = useState(date);
  const [bin, setBin] = useState('');
  const [remarks, setRemarks] = useState('');
  const [failed, setFailed] = useState(false);
  const retryAtMount = useRef(confirmedRetry?.nonce ?? 0);
  const dialog = useModal(closeSource);
  useEffect(() => { if (confirmedRetry && confirmedRetry.nonce > retryAtMount.current && confirmedRetry.type === 'job.createFromSource') { closeSource(); setDate(planningDate); navigate('planning'); } }, [confirmedRetry?.nonce]);
  const quantity = !order ? 0 : order.unit === 'Bags' ? order.quantity * state.settings.bagWeightKg / 1000 : order.quantity;
  const rate = order ? getRate(state.settings, line, order.materialCode) : 0;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!order || !canPlanSource(order)) return;
    const saved = await commit({ type: 'job.createFromSource', input: { sourceOrderId: order.id, sourceOrderVersion: order.version, date: planningDate, lineId: line, bin, remarks } }, 'Order added to the planning board.');
    if (saved) { closeSource(); setDate(planningDate); navigate('planning'); }
    else setFailed(true);
  }
  return <div className="editor-layer"><button className="editor-scrim" disabled={mutationLocked} onClick={closeSource} aria-label="Close order planning"/><section ref={dialog} tabIndex={-1} className={'production-editor source-planning-dialog ' + (!order ? 'source-picker' : '')} role="dialog" aria-modal="true" aria-labelledby="source-plan-title"><header className="editor-header"><div><h2 id="source-plan-title">{order ? 'Plan production from order' : 'Choose an order to plan'}</h2><p>One complete order becomes one production card.</p></div><button className="icon-button" disabled={mutationLocked} onClick={closeSource} aria-label="Close order planning"><X size={21}/></button></header>{!order ? <div className="editor-body"><DataBrowser compact onChoose={value => { if (canPlanSource(value)) setOrder(value); }}/></div> : <form onSubmit={submit}><div className="editor-body"><div className="source-plan-order"><strong>{order.doNo} · {order.materialCode}</strong><p>{order.description}</p><small>{order.shipToParty || order.soldToParty}</small><SourceStatus order={order}/><div><strong>{numberLabel(order.quantity, order.unit === 'Bags' ? 0 : 2)} {order.unit}</strong><span>{numberLabel(quantity, 2)} MT</span></div></div>{hasConflict && <div className="notice warning" role="alert">The workspace changed. Choose the order again to load its latest version.<button className="text-link" disabled={mutationLocked} onClick={() => { resolveConflict(); setOrder(null); setFailed(false); }}>Reload order data</button></div>}{storageWarning && <div className="notice warning">{storageWarning}<button className="text-link" onClick={() => void refresh()}>Retry connection</button></div>}<div className="field-grid" inert={mutationLocked || hasConflict}><label className="field">Production line<select aria-label="Production line" value={line} onChange={event => setLine(event.target.value as LineId)}>{LINE_IDS.map(id => <option key={id}>{id}</option>)}</select></label><label className="field">Planning date<input aria-label="Planning date" type="date" required value={planningDate} onChange={event => setPlanningDate(event.target.value)}/></label><label className="field span-2">Destination bin<input aria-label="Destination bin" maxLength={120} value={bin} onChange={event => setBin(event.target.value)}/></label><label className="field span-2">Production remarks<textarea aria-label="Production remarks" maxLength={1000} rows={2} value={remarks} onChange={event => setRemarks(event.target.value)}/></label></div><div className="editor-estimate"><strong>{durationLabel(quantity / rate * 60)}</strong><span>at {numberLabel(rate)} MT / hr</span></div><p className="data-note">Appended to the selected line. Production uses the 07:00–19:00 work window; remaining work continues the next day. {order.unit === 'Bags' ? `${state.settings.bagWeightKg} kg per bag is saved with this card.` : 'Quantity and material come from this order.'} To change source details, import an updated Excel file.</p>{failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}</div><footer className="editor-footer"><button type="button" className="button secondary" disabled={mutationLocked} onClick={() => { setOrder(null); setFailed(false); }}><ArrowLeft size={15}/>Choose another order</button><div className="toolbar-spacer"/><button type="submit" className="button primary" disabled={mutationLocked || hasConflict || !canPlanSource(order)}>{mutationLocked ? 'Saving…' : 'Add to planning'}</button></footer></form>}</section></div>;
}
