import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { DataBrowser, SourceStatus, canPlanSource } from '../pages/Data';
import type { SourceOrderSummary } from '../domain/sourceTypes';
import { LINE_IDS, type LineId } from '../domain/types';
import { getRate } from '../domain/engine';
import { dateLabel, durationLabel, numberLabel } from '../lib/format';
import { productLabel } from '../lib/productLabel';
import { useModal } from './useModal';
import { readInventory, readInventoryOrders } from '../lib/inventoryApi';
import type { InventoryItemSnapshot, InventoryOrderProgress } from '../domain/inventoryTypes';
import './ProductionEditor.css';
import './CombinedProduction.css';

type SelectedOrder = { order: SourceOrderSummary; quantity: string };
const normalized = (value: string) => value.trim().toLowerCase();

export function SourcePlanningDialog() {
  const { sourceDialog, closeSource, state, date, setDate, navigate, commit, mutationLocked, hasConflict, resolveConflict, storageWarning, refresh, toast, confirmedRetry, savedAt } = useWorkspace();
  const [orders, setOrders] = useState<SelectedOrder[]>(() => sourceDialog?.order ? [{order: sourceDialog.order, quantity: String(sourceDialog.order.netToPlan ?? sourceDialog.order.quantity)}] : []);
  const [choosing, setChoosing] = useState(!sourceDialog?.order);
  const [line, setLine] = useState<LineId>('PM1');
  const [planningDate, setPlanningDate] = useState(date);
  const [bin, setBin] = useState('');
  const [remarks, setRemarks] = useState('');
  const [failed, setFailed] = useState(false);
  const [stockItems, setStockItems] = useState<InventoryItemSnapshot[]>([]);
  const [progress, setProgress] = useState<InventoryOrderProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true; setLoading(true); setLoadError('');
    Promise.all([readInventory(), readInventoryOrders()]).then(([stock, p]) => {
      if (!active) return;
      setStockItems(stock.items); setProgress(stock.baselineDate ? p.orders : []);
      setOrders(rows => rows.map(row => {
        const live = stock.baselineDate ? p.orders.find(o => o.sourceOrderId === row.order.id) : null;
        return live ? {...row, quantity: String(live.netToPlan)} : row;
      }));
    }).catch(error => { if (active) setLoadError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [savedAt]);
  const first = orders[0]?.order;
  const itemFor = (order: SourceOrderSummary) => stockItems.find(i => normalized(i.materialCode) === normalized(order.materialCode));
  const bucketFor = (order: SourceOrderSummary) => {
    const p = progress.find(p => p.sourceOrderId === order.id);
    return [normalized(p?.medication ?? order.medication), normalized(p?.fmrOmed ?? order.fmrOmed)].join('\0');
  };
  const bagWeight = first ? itemFor(first)?.bagWeightKg ?? state.settings.bagWeightKg : state.settings.bagWeightKg;
  const totalQuantity = orders.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const quantityMt = first?.unit === 'Bags' ? totalQuantity * bagWeight / 1000 : totalQuantity;
  const rate = first ? getRate(state.settings, line, first.materialCode) : 0;
  const retryAtMount = useRef(confirmedRetry?.nonce ?? 0);
  const dialog = useModal(closeSource);
  const finish = () => { closeSource(); setDate(planningDate); navigate('planning'); };
  useEffect(() => {
    if (confirmedRetry && confirmedRetry.nonce > retryAtMount.current && ['job.createFromSources', 'job.createFromSource', 'planning.commitDraft'].includes(confirmedRetry.type)) finish();
  }, [confirmedRetry?.nonce]);
  function blockedReason(order: SourceOrderSummary) {
    if (orders.some(row => row.order.id === order.id)) return 'Already added';
    if (!first) return null;
    if (normalized(order.materialCode) !== normalized(first.materialCode) || order.unit !== first.unit) return 'Different product / packaging';
    if (bucketFor(order) !== bucketFor(first)) return 'Different Medication / FMR';
    if (order.unit === 'Bags' && (itemFor(order)?.bagWeightKg ?? state.settings.bagWeightKg) !== bagWeight) return 'Different bag weight';
    return null;
  }
  function choose(order: SourceOrderSummary) {
    if (!canPlanSource(order) || blockedReason(order)) return;
    const p = progress.find(p => p.sourceOrderId === order.id);
    setOrders(rows => [...rows, {order, quantity: String(p?.netToPlan ?? order.netToPlan ?? order.quantity)}]);
    setChoosing(false); setFailed(false);
  }
  const valid = orders.length > 0 && orders.every(row => {
    const q = Number(row.quantity);
    return Number.isFinite(q) && q > 0 && (row.order.unit !== 'Bags' || Number.isInteger(q));
  });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || hasConflict || loading || loadError) return;
    const saved = await commit({type: 'job.createFromSources', input: {
      orders: orders.map(row => ({sourceOrderId: row.order.id, sourceOrderVersion: row.order.version, plannedQuantity: Number(row.quantity)})),
      date: planningDate, lineId: line, bin, remarks,
    }}, `${orders.length} ${orders.length === 1 ? 'order' : 'orders'} added as one production card.`);
    if (saved) finish(); else setFailed(true);
  }
  return <div className="editor-layer">
    <button className="editor-scrim" disabled={mutationLocked} onClick={closeSource} aria-label="Close order planning"/>
    <section ref={dialog} tabIndex={-1} className={'production-editor source-planning-dialog ' + (choosing ? 'source-picker' : '')} role="dialog" aria-modal="true" aria-labelledby="source-plan-title">
      <header className="editor-header"><div><h2 id="source-plan-title">{choosing ? first ? 'Add orders to this production' : 'Choose an order to plan' : orders.length > 1 ? 'Plan production from orders' : 'Plan production from order'}</h2><p>{choosing ? 'Choose compatible orders to produce together on one card.' : 'One production card. Each order keeps its own quantity and progress.'}</p></div><button className="icon-button" disabled={mutationLocked} onClick={closeSource} aria-label="Close order planning"><X size={21}/></button></header>
      {choosing ? <><div className="editor-body">{first && <p className="notice">Adding to {productLabel(first)} · {first.unit} · {orders.length} selected</p>}<DataBrowser compact initialSearch={first?.materialCode ?? ''} onChoose={choose} chooseBlockedReason={blockedReason}/></div>{orders.length > 0 && <footer className="editor-footer"><button className="button secondary" type="button" onClick={() => setChoosing(false)}><ArrowLeft size={15}/>Back to {orders.length} selected orders</button></footer>}</> : <form onSubmit={submit}>
        <div className="editor-body">
          {first && <div className="source-plan-order"><strong className="combined-product-title">{productLabel(first)}</strong><p>{first.materialCode}</p><small>{first.description}</small><div><strong>{numberLabel(totalQuantity, first.unit === 'Bags' ? 0 : 3)} {first.unit}</strong><span>{first.unit === 'Bags' && `${numberLabel(quantityMt, 3)} MT · `}{orders.length} {orders.length === 1 ? 'order' : 'orders'}</span></div></div>}
          {hasConflict && <div className="notice warning" role="alert">The workspace changed. Choose the orders again to load their latest quantities.<button type="button" className="text-link" disabled={mutationLocked} onClick={() => {resolveConflict(); setOrders([]); setChoosing(true); setFailed(false);}}>Reload order data</button></div>}
          {storageWarning && <div className="notice warning">{storageWarning}<button type="button" className="text-link" onClick={() => void refresh()}>Retry connection</button></div>}
          {loading && <p role="status">Loading stock reservations…</p>}{loadError && <p role="alert" className="data-error">{loadError}<button type="button" className="text-link" onClick={() => void refresh()}>Retry loading</button></p>}
          <fieldset className="combined-order-list" disabled={mutationLocked || hasConflict || loading}>
            <legend>Order allocations</legend>
            {orders.map(row => {
              const p = progress.find(p => p.sourceOrderId === row.order.id);
              const remaining = p?.netToPlan ?? row.order.netToPlan ?? row.order.quantity;
              return <div className="combined-order-row" key={row.order.id}>
                <div><strong>{row.order.doNo}</strong><span>{row.order.shipToParty || row.order.soldToParty || 'No customer name'}</span><small>Delivery {dateLabel(row.order.deliveryDate, true)} · {numberLabel(remaining, row.order.unit === 'Bags' ? 0 : 3)} {row.order.unit} to plan</small><SourceStatus order={row.order}/></div>
                <label className="field">Production quantity ({row.order.unit})<input aria-label={`Production quantity ${row.order.doNo}`} type="number" min={row.order.unit === 'Bags' ? 1 : .001} step={row.order.unit === 'Bags' ? 1 : .001} required value={row.quantity} onChange={e => setOrders(rows => rows.map(r => r.order.id === row.order.id ? {...r, quantity: e.target.value} : r))}/></label>
                <button type="button" className="icon-button danger-text" aria-label={`Remove order ${row.order.doNo}`} onClick={() => {setOrders(rows => rows.filter(r => r.order.id !== row.order.id)); if (orders.length === 1) setChoosing(true);}}><Trash2 size={16}/></button>
              </div>;
            })}
            <button type="button" className="button secondary" onClick={() => setChoosing(true)}><Plus size={15}/>Add same-product order</button>
          </fieldset>
          <div className="field-grid" inert={mutationLocked || hasConflict}>
            <label className="field">Production line<select aria-label="Production line" value={line} onChange={e => setLine(e.target.value as LineId)}>{LINE_IDS.map(id => <option key={id}>{id}</option>)}</select></label>
            <label className="field">Planning date<input type="date" required value={planningDate} onChange={e => setPlanningDate(e.target.value)}/></label>
            <label className="field span-2">Destination bin<input maxLength={120} value={bin} onChange={e => setBin(e.target.value)}/></label>
            <label className="field span-2">Production remarks<textarea maxLength={1000} rows={2} value={remarks} onChange={e => setRemarks(e.target.value)}/></label>
          </div>
          <div className="editor-estimate"><strong>{durationLabel(rate > 0 ? quantityMt / rate * 60 : 0)}</strong><span>at {numberLabel(rate)} MT / hr</span></div>
          <p className="data-note">One card is appended to the selected line. Production uses the working hours saved in Settings; carry-over continues in the next working window. {first?.unit === 'Bags' && `${bagWeight} kg per bag is saved with this card.`} Existing orders are never overwritten by Excel imports.</p>
          {failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
        </div>
        <footer className="editor-footer"><button type="button" className="button secondary" disabled={mutationLocked} onClick={closeSource}>Cancel</button><div className="toolbar-spacer"/><button type="submit" className="button primary" disabled={!valid || loading || !!loadError || mutationLocked || hasConflict}>{mutationLocked ? 'Saving…' : 'Add to planning'}</button></footer>
      </form>}
    </section>
  </div>;
}
