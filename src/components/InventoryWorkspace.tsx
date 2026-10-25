import { useEffect, useState, useRef } from 'react';
import { X, Settings2, RefreshCw } from 'lucide-react';
import type { InventoryItemSnapshot, InventoryLedgerEntry, InventoryOrderProgress, InventoryOrderJournalRow, InventoryDailyStockRow } from '../domain/inventoryTypes';
import { readInventory, readInventoryOrders, readDailyStock, readOrderJournal, readLedger, readJobProduction } from '../lib/inventoryApi';
import { useWorkspace } from '../lib/workspace';
import { localDate, numberLabel } from '../lib/format';
import type { Job } from '../domain/types';
import './InventoryWorkspace.css';
import { DetailDialog } from './DetailDialog';

const qty = (value: number, unit: string) => `${numberLabel(value, unit === 'Bags' ? 0 : 3)} ${unit}`;
const newKey = () => crypto.randomUUID();

export function StockBrowser({ policiesOnly = false }: { policiesOnly?: boolean }) {
  const { savedAt, commit, mutationLocked, hasConflict, toast } = useWorkspace();
  const [items, setItems] = useState<InventoryItemSnapshot[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [strategy, setStrategy] = useState('');
  const [variant, setVariant] = useState('');
  const [low, setLow] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<InventoryItemSnapshot | null>(null);
  const [ledger, setLedger] = useState<InventoryLedgerEntry[]>([]);
  const [reload, setReload] = useState(0);
  const [date, setDate] = useState('');
  const [baseline,setBaseline]=useState<string|null>(null);
  const [lastCount, setLastCount] = useState<string|null>(null);
  useEffect(() => {
    let active = true;
    readInventory().then(data => { if (active) { setItems(data.items); setDate(data.asOfDate); setBaseline(data.baselineDate); setLastCount(data.lastCountDate ?? data.baselineDate ?? null); setError(''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [savedAt, reload]);
  useEffect(() => { setPage(1); }, [search, strategy, variant, low]);
  useEffect(() => {
    let active = true; setLedger([]);
    if (selected) readLedger(selected.itemId).then(data => { if (active) setLedger(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [selected?.itemId, savedAt, reload]);
  const rows = items.filter(i => `${i.materialCode} ${i.description}`.toLowerCase().includes(search.toLowerCase()) && (!strategy || i.strategy === strategy) && (!low || i.strategy === 'mts' && (i.buckets.find(b=>!b.medication&&!b.fmrOmed)?.available ?? 0) < (i.targetQuantity ?? 0)));
  const buckets = rows.flatMap(i => (i.buckets.length ? i.buckets : [{ medication: '', fmrOmed: '', onHand: 0, reserved: 0, available: 0 }]).filter(b => !variant || `${b.medication} ${b.fmrOmed}`.toLowerCase().includes(variant.toLowerCase())).map(b => ({ ...b, item: i })));
  const display = policiesOnly ? rows : buckets;
  return <section className="inventory-workspace">
    <div className="inventory-toolbar"><label className="field">Product<input aria-label="Search stock" placeholder="Material or description" value={search} onChange={e => setSearch(e.target.value)}/></label><label className="field">Strategy<select value={strategy} onChange={e => setStrategy(e.target.value)}><option value="">All strategies</option><option value="mto">Make for order</option><option value="mts">Make for stock</option></select></label>{!policiesOnly && <><label className="field">Medication / FMR<input value={variant} onChange={e => setVariant(e.target.value)} placeholder="All stock variants"/></label><label className="checkbox-label"><input type="checkbox" checked={low} onChange={e => setLow(e.target.checked)}/>Below safety stock</label></>}<button className="button secondary" onClick={() => setReload(n => n + 1)}><RefreshCw size={15}/>Refresh</button></div>
    <p className="data-note">{items.length} finished-goods products · Ledger as of {date || '—'} · Baseline {baseline || 'not established'} · Last verified stock date {lastCount || 'not established'}. On hand includes reserved stock; available stock excludes it. Blank medication / FMR is a separate stock variant. Product safety stock targets apply to the standard variant; other variants are planned against their orders.</p>
    {error && <p className="data-error" role="alert">{error}</p>}
    {selected && <DetailDialog title="Manage stock" subtitle={`${selected.materialCode} · ${selected.description}`} closeLabel="Close stock details" onClose={() => setSelected(null)}><div className="inventory-workspace inventory-detail">{error && <p className="data-error" role="alert">{error}</p>}<StockConfiguration key={`${selected.itemId}-${savedAt}`} item={items.find(i => i.itemId === selected.itemId) ?? selected}/>{!policiesOnly && <><StockAdjustment item={selected}/><h3>Stock movements</h3><div className="table-scroll"><table><thead><tr><th>DATE</th><th>TYPE</th><th>CHANGE</th><th>VARIANT / NOTE</th><th/></tr></thead><tbody>{ledger.slice(0, 100).map(entry => <tr key={entry.id}><td>{entry.occurredOn}</td><td>{entry.movementType}</td><td>{qty(entry.quantityDelta, entry.unit)}</td><td>{entry.medication || 'Standard'} / {entry.fmrOmed || '—'}<small>{entry.note}</small></td><td><MovementCorrection entry={entry}/></td></tr>)}</tbody></table></div><p className="data-note">Latest 100 movements. The full ledger is included in database backups.</p></>}</div></DetailDialog>}
    <div className="panel table-scroll"><table className="source-table"><thead><tr><th>PRODUCT</th>{!policiesOnly && <><th>VARIANT</th><th>ON HAND</th><th>RESERVED</th><th>AVAILABLE</th></>}<th>STRATEGY / SAFETY STOCK</th><th>EXTRA</th><th/></tr></thead><tbody>{policiesOnly ? rows.slice((page - 1) * 50, page * 50).map(i => <tr key={i.itemId}><td><strong>{i.materialCode}</strong><small>{i.description} · {i.unit === 'Bags' ? `${i.bagWeightKg ?? '?'}kg / bag` : 'Bulk MT'}</small></td><td>{i.strategy?.toUpperCase() ?? 'Review'} · {qty(i.targetQuantity ?? 0, i.unit)}{i.needsReview && <small>Needs review</small>}</td><td>{extraLabel(i)}</td><td><button className="button secondary" onClick={() => setSelected(i)}><Settings2 size={14}/>Edit policy</button></td></tr>) : buckets.slice((page - 1) * 50, page * 50).map((b, n) => <tr key={`${b.item.itemId}-${n}`}><td><strong>{b.item.materialCode}</strong><small>{b.item.description} · {b.item.bagWeightKg ? `${b.item.bagWeightKg}kg` : 'Bulk'}</small></td><td>{b.medication || 'Standard'}<small>{b.fmrOmed || 'No FMR / OMED'}</small></td><td>{qty(b.onHand, b.item.unit)}</td><td>{qty(b.reserved, b.item.unit)}</td><td className={!b.medication && !b.fmrOmed && b.available < (b.item.targetQuantity ?? 0) && b.item.strategy === 'mts' ? 'days-overdue' : ''}><strong>{qty(b.available, b.item.unit)}</strong></td><td>{b.item.strategy?.toUpperCase() ?? 'Review'} · {qty(b.item.targetQuantity ?? 0, b.item.unit)}{b.item.needsReview && <small>Needs review</small>}</td><td>{extraLabel(b.item)}</td><td><button className="button secondary" onClick={() => setSelected(b.item)}>Manage stock</button></td></tr>)}</tbody></table>{!display.length && <p className="data-empty">No stock matches. Import the daily stock workbook to establish inventory.</p>}</div>
    <InventoryPagination total={display.length} page={page} setPage={setPage}/>
    {(mutationLocked || hasConflict) && <p className="data-note">Resolve the current workspace update before saving stock changes.</p>}{toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
  </section>;
}
function extraLabel(i: InventoryItemSnapshot) { return !i.defaultExtra ? '0' : i.defaultExtra.type === 'percent' ? `${i.defaultExtra.percent}%` : qty(i.defaultExtra.quantity, i.unit); }

function StockConfiguration({ item }: { item: InventoryItemSnapshot }) {
  const { commit, mutationLocked, hasConflict } = useWorkspace();
  const [strategy, setStrategy] = useState(item.strategy ?? 'mto');
  const [target, setTarget] = useState(item.targetQuantity ?? 0);
  const [extraType, setExtraType] = useState(item.defaultExtra?.type ?? 'fixed');
  const [extra, setExtra] = useState(item.defaultExtra ? item.defaultExtra.type === 'fixed' ? item.defaultExtra.quantity : item.defaultExtra.percent : 0);
  const [weight, setWeight] = useState(item.bagWeightKg ?? 50);
  return <form className="inventory-inline-form" onSubmit={async e => { e.preventDefault(); await commit({ type: 'inventory.configure', itemId: item.itemId, patch: { strategy, targetQuantity: target, bagWeightKg: item.unit === 'Bags' ? weight as 25 | 50 : null, defaultExtra: extra === 0 ? null : extraType === 'percent' ? { type: 'percent', percent: extra } : { type: 'fixed', quantity: extra }, needsReview: false } }, 'Stock policy saved. Historical records retained.'); }}><label className="field">Production strategy<select value={strategy} onChange={e => setStrategy(e.target.value as 'mto' | 'mts')}><option value="mto">Make for order</option><option value="mts">Make for stock</option></select></label><label className="field">Safety stock ({item.unit})<input type="number" required min="0" step={item.unit === 'Bags' ? 1 : 0.001} value={target} onChange={e => setTarget(+e.target.value)}/></label>{item.unit === 'Bags' && <label className="field">Bag weight<select value={weight} onChange={e => setWeight(+e.target.value as 25 | 50)}><option value={25}>25kg</option><option value={50}>50kg</option></select></label>}<label className="field">Extra type<select value={extraType} onChange={e => setExtraType(e.target.value as 'fixed' | 'percent')}><option value="fixed">Fixed {item.unit}</option><option value="percent">Percentage</option></select></label><label className="field">Default extra<input type="number" min="0" step={extraType === 'percent' ? .1 : item.unit === 'Bags' ? 1 : .001} value={extra} onChange={e => setExtra(+e.target.value)}/></label><button className="button primary" disabled={mutationLocked || hasConflict}>Save stock policy</button></form>;
}
function StockAdjustment({ item }: { item: InventoryItemSnapshot }) {
  const { commit, mutationLocked, hasConflict, confirmedRetry } = useWorkspace();
  const [movement, setMovement] = useState('adjustment');
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&['inventory.adjust','inventory.receive'].includes(confirmedRetry.type)){setDelta('');setReason('');}},[confirmedRetry?.nonce]);
  const [delta, setDelta] = useState(''), [reason, setReason] = useState(''), [medication, setMedication] = useState(''), [fmrOmed, setFmr] = useState(''), [date, setDate] = useState(localDate());
  return <details><summary>Record receiving, return, rework or physical-count adjustment</summary><form className="inventory-inline-form" onSubmit={async e => { e.preventDefault(); if (await commit(movement === 'adjustment' ? { type: 'inventory.adjust', itemId: item.itemId, quantityDelta: +delta, medication, fmrOmed, reason, occurredOn: date, postingKey: newKey() } : { type: 'inventory.receive', movementType: movement as 'received'|'return'|'rework', itemId: item.itemId, quantity: +delta, medication, fmrOmed, note: reason, occurredOn: date, postingKey: newKey() }, 'Stock adjustment recorded.')) { setDelta(''); setReason(''); } }}><label className="field">Date<input type="date" required value={date} onChange={e => setDate(e.target.value)}/></label><label className="field">Movement<select value={movement} onChange={e=>setMovement(e.target.value)}><option value="adjustment">Stock-count adjustment (+ / −)</option><option value="received">Received from other</option><option value="return">Sales return</option><option value="rework">Rework (deduct)</option></select></label><label className="field">{movement === 'adjustment' ? 'Change (+ / −)' : 'Quantity'} ({item.unit})<input type="number" required step={item.unit === 'Bags' ? 1 : .001} value={delta} onChange={e => setDelta(e.target.value)}/></label><label className="field">Medication<input value={medication} onChange={e => setMedication(e.target.value)}/></label><label className="field">FMR / OMED<input value={fmrOmed} onChange={e => setFmr(e.target.value)}/></label><label className="field">Reason<input required maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label><button className="button secondary" disabled={!+delta || mutationLocked || hasConflict}>Record adjustment</button></form></details>;
}
function MovementCorrection({ entry }: { entry: InventoryLedgerEntry }) {
  const { commit, mutationLocked, hasConflict, confirmedRetry } = useWorkspace();
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&['production.correct','delivery.reverse'].includes(confirmedRetry.type))setOpen(false);},[confirmedRetry?.nonce]);
  const [open, setOpen] = useState(false), [quantity, setQuantity] = useState(''), [reason, setReason] = useState('');
  if (!['production', 'dispatch'].includes(entry.movementType)) return null;
  if (!open) return <button className="text-link" onClick={() => setOpen(true)}>{entry.movementType === 'dispatch' ? 'Reverse collection' : 'Correct output'}</button>;
  return <form onSubmit={async e => { e.preventDefault(); const command = entry.movementType === 'dispatch' ? { type: 'delivery.reverse' as const, movementId: entry.id, quantity: +quantity, reason, postingKey: newKey() } : { type: 'production.correct' as const, movementId: entry.id, correctedTotalQuantity: +quantity, reason, postingKey: newKey() }; if (await commit(command, 'Correction recorded with its original entry retained.')) setOpen(false); }}><label className="field">{entry.movementType === 'dispatch' ? 'Quantity to return' : 'Correct total produced for this job'}<input aria-label="Correction quantity" required type="number" min="0" step={entry.unit === 'Bags' ? 1 : .001} value={quantity} onChange={e => setQuantity(e.target.value)}/></label><label className="field">Reason<input required value={reason} onChange={e => setReason(e.target.value)}/></label><button className="button secondary" disabled={mutationLocked || hasConflict}>Save correction</button><button type="button" className="text-link" onClick={() => setOpen(false)}>Cancel</button></form>;
}

function PhysicalCountForm({item,date,medication='',fmrOmed=''}:{item:InventoryItemSnapshot;date:string;medication?:string;fmrOmed?:string}){
  const {savedAt,commit,mutationLocked,hasConflict,confirmedRetry}=useWorkspace();
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&confirmedRetry.type==='inventory.adjust'){setCount('');setReason('');}},[confirmedRetry?.nonce]);
  const [count,setCount]=useState(''),[reason,setReason]=useState(''),[balance,setBalance]=useState<number|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;setBalance(null);readDailyStock(date).then(rows=>{if(active){setBalance(rows.find(row=>row.itemId===item.itemId&&row.medication===medication&&row.fmrOmed===fmrOmed)?.closing??0);setError('');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[item.itemId,date,medication,fmrOmed,savedAt]);
  const difference=balance===null?0:Math.round((+count-balance)*1000)/1000;
  return <form className="inventory-inline-form" onSubmit={async e=>{e.preventDefault();if(await commit({type:'inventory.adjust',itemId:item.itemId,medication,fmrOmed,countedQuantity:+count,quantityDelta:difference,occurredOn:date,reason,postingKey:newKey()},'Physical count difference recorded. Original ledger retained.')){setCount('');setReason('');}}}><div><strong>{item.materialCode} · {date}</strong><p>{medication||'Standard'} / {fmrOmed||'No FMR / OMED'} · Ledger closing {balance===null?'loading':qty(balance,item.unit)}</p></div><label className="field">Physical count ({item.unit})<input type="number" required min="0" step={item.unit==='Bags'?1:.001} value={count} onChange={e=>setCount(e.target.value)}/></label><label className="field">Count adjustment reason<input required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><p>Adjustment: {qty(difference,item.unit)}</p><button className="button primary" disabled={balance===null||count===''||!difference||mutationLocked||hasConflict}>Confirm physical count</button>{error&&<p className="data-error">{error}</p>}</form>;
}

export function StockOrderPanel({ orderId, onLeave }: { orderId: string; onLeave?: () => void }) {
  const { savedAt, commit, mutationLocked, hasConflict, confirmedRetry, state, openJob } = useWorkspace();
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&confirmedRetry.type==='delivery.record')setQuantity('');},[confirmedRetry?.nonce]);
  const [progress, setProgress] = useState<InventoryOrderProgress | null>(null), [journal, setJournal] = useState<InventoryOrderJournalRow[]>([]), [error, setError] = useState('');
  const [quantity, setQuantity] = useState(''), [date, setDate] = useState(localDate()), [medication, setMedication] = useState(''), [fmrOmed, setFmr] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([readInventoryOrders(), readOrderJournal(orderId),readInventory()]).then(([data, rows,stock]) => { if (active) { const p = stock.baselineDate ? data.orders.find(o => o.sourceOrderId === orderId) ?? null : null; setProgress(p); setJournal(rows); setMedication(p?.medication ?? ''); setFmr(p?.fmrOmed ?? ''); setError(''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [orderId, savedAt]);
  if (!progress) return error ? <p className="data-error">{error}</p> : null;
  return <div className="inventory-order-panel"><div className="inventory-metrics">{[['Ordered', progress.ordered], ['Stock reserved', progress.reserved], ['Produced', progress.produced], ['Collected', progress.delivered], ['Still to produce', progress.orderNeed], ['Scheduled, not received', progress.scheduledUnreceived], ['Still to plan', progress.netToPlan]].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{qty(Number(value), progress.unit)}</strong></div>)}</div><p className="data-note">Stock reservation includes received production. Produced quantity is shown for traceability and is not deducted a second time. Historical status: {progress.historicalStatus}.</p>
    <form className="inventory-inline-form" onSubmit={async e => { e.preventDefault(); if (await commit({ type: 'delivery.record', sourceOrderId: orderId, quantity: +quantity, occurredOn: date, postingKey: newKey() }, 'Customer collection recorded.')) setQuantity(''); }}><label className="field">Collection date<input type="date" required value={date} onChange={e => setDate(e.target.value)}/></label><label className="field">Collected quantity ({progress.unit})<input type="number" min={progress.unit === 'Bags' ? 1 : .001} max={progress.ordered - progress.delivered} step={progress.unit === 'Bags' ? 1 : .001} required value={quantity} onChange={e => setQuantity(e.target.value)}/></label><button className="button primary" disabled={mutationLocked || hasConflict || progress.delivered >= progress.ordered}>Record collection</button></form>
    <form className="inventory-inline-form" onSubmit={async e => { e.preventDefault(); await commit({ type: 'data.updateManualFields', sourceOrderId: orderId, patch: { medication, fmrOmed } }, 'Manual order details updated. Stock compatibility recalculated.'); }}><label className="field">Medication<input value={medication} onChange={e => setMedication(e.target.value)}/></label><label className="field">FMR / OMED<input value={fmrOmed} onChange={e => setFmr(e.target.value)}/></label><button className="button secondary" disabled={mutationLocked || hasConflict}>Save manual details</button></form>
    <details><summary>Production cards · {state.jobs.filter(job=>job.sourceOrderId===orderId).length}</summary>{state.jobs.filter(job=>job.sourceOrderId===orderId).map(job=><p key={job.id}><button className="text-link" disabled={mutationLocked} onClick={()=>{if(mutationLocked)return;onLeave?.();openJob(job.id,true);}}>{job.date} · {job.lineId} · {job.mode==='bags'?`${job.bagCount} Bags`:`${job.quantityMt} MT`} · {job.status}</button></p>)}</details>
    <details><summary>Daily production / collection journal · {journal.length} entries</summary><div className="table-scroll"><table><thead><tr><th>DATE</th><th>ACTIVITY</th><th>QUANTITY</th><th>NOTE</th></tr></thead><tbody>{journal.map((j, n) => <tr key={`${j.referenceId}-${n}`}><td>{j.occurredOn}</td><td>{j.eventType}</td><td>{qty(j.quantity, j.unit)}</td><td>{j.note || '—'}</td></tr>)}</tbody></table></div></details>{error && <p className="data-error" role="alert">{error}</p>}</div>;
}

export function DailyStockBrowser() {
  const { savedAt } = useWorkspace();
  const [countRow,setCountRow]=useState<InventoryDailyStockRow|null>(null),[countItem,setCountItem]=useState<InventoryItemSnapshot|null>(null);
  async function chooseCount(row:InventoryDailyStockRow){try{const stock=await readInventory();setCountItem(stock.items.find(item=>item.itemId===row.itemId)??null);setCountRow(row);}catch(e){setError(e instanceof Error?e.message:'Stock could not be loaded.');}}
  const [date, setDate] = useState(localDate()), [search, setSearch] = useState(''), [rows, setRows] = useState<InventoryDailyStockRow[]>([]), [error, setError] = useState(''), [page, setPage] = useState(1);
  useEffect(() => { let active = true; readDailyStock(date).then(data => { if (active) { setRows(data); setError(''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [date, savedAt]);
  const matched = rows.filter(r => `${r.materialCode} ${r.medication} ${r.fmrOmed}`.toLowerCase().includes(search.toLowerCase()));
  return <section><div className="inventory-toolbar"><label className="field">Stock date<input type="date" value={date} onChange={e => { setDate(e.target.value); setPage(1); }}/></label><label className="field">Product / variant<input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label></div><p className="data-note">Closing = Opening + Production + Received + Sales return − Rework − Issue + Adjustments. The imported baseline day retains its reported Excel totals.</p>{error && <p className="data-error" role="alert">{error}</p>}{countRow && countItem && <section className="panel inventory-detail"><header><h2>Physical stock count</h2><button className="icon-button" aria-label="Close physical count" onClick={()=>setCountRow(null)}><X size={18}/></button></header><PhysicalCountForm key={`${countRow.itemId}-${date}-${countRow.medication}-${countRow.fmrOmed}`} item={countItem} date={date} medication={countRow.medication} fmrOmed={countRow.fmrOmed}/></section>}<div className="panel table-scroll"><table className="source-table"><thead><tr>{['PRODUCT / VARIANT', 'UNIT', 'OPENING', 'PRODUCTION', 'RECEIVED', 'RETURN', 'REWORK', 'ISSUE', 'ADJUSTMENT', 'CLOSING', 'COUNT'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{matched.slice((page - 1) * 50, page * 50).map((r, n) => <tr key={n}><td>{r.materialCode}<small>{r.medication || 'Standard'} / {r.fmrOmed || '—'}</small></td><td>{r.unit}</td>{[r.opening, r.production, r.received, r.salesReturn, r.rework, r.dispatch, r.adjustment, r.closing].map((v, i) => <td key={i}>{numberLabel(v, r.unit === 'Bags' ? 0 : 3)}</td>)}<td><button className="text-link" onClick={()=>void chooseCount(r)}>Enter physical count</button></td></tr>)}</tbody></table>{!matched.length && <p className="data-empty">No stock records for this date.</p>}</div><InventoryPagination total={matched.length} page={page} setPage={setPage}/></section>;
}
export function InventoryReceiptForm({ job }: { job: Job }) {
  const { savedAt, commit, mutationLocked, hasConflict, confirmedRetry } = useWorkspace();
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&confirmedRetry.type==='production.recordReceipt')setQuantity('');},[confirmedRetry?.nonce]);
  const [recorded, setRecorded] = useState(0), [quantity, setQuantity] = useState(''), [date, setDate] = useState(localDate()), [error, setError] = useState('');
  useEffect(() => { let active = true; if (job.inventoryItemId) readJobProduction(job.id).then(result => { if (active) setRecorded(result.total); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [job.id, savedAt]);
  if (!job.inventoryItemId) return null;
  const unit = job.mode === 'bags' ? 'Bags' : 'MT';
  return <section className="drawer-section"><h3>Production received into stock</h3><p>{qty(recorded, unit)} recorded so far</p>{job.status === 'running' && <form onSubmit={async e => { e.preventDefault(); if (await commit({ type: 'production.recordReceipt', jobId: job.id, totalActualQuantity: Math.round((recorded + +quantity) * 1000) / 1000, occurredOn: date }, 'Production received. Order progress and stock updated.')) setQuantity(''); }}><div className="field-grid"><label className="field">Production date<input type="date" required value={date} onChange={e => setDate(e.target.value)}/></label><label className="field">New quantity ({unit})<input type="number" required min={unit === 'Bags' ? 1 : .001} step={unit === 'Bags' ? 1 : .001} value={quantity} onChange={e => setQuantity(e.target.value)}/></label></div><button className="button secondary full-width" disabled={mutationLocked || hasConflict || !+quantity}>Record production quantity</button></form>}<p className="field-help">Done asks for the final total, including quantities already recorded here.</p>{error && <p className="data-error">{error}</p>}</section>;
}
export function InventoryPagination({ total, page, setPage }: { total: number; page: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 50));
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages, setPage]);
  return <div className="data-pagination"><span>{total ? (page - 1) * 50 + 1 : 0}–{Math.min(page * 50, total)} of {total}</span><div><button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} / {pages}</span><button className="button secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></div>;
}
