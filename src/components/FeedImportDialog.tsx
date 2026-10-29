import { useEffect, useState, useRef } from 'react';
import { X, Check, ArrowLeft } from 'lucide-react';
import type { FeedWorkbookData } from '../lib/feedWorkbook';
import { useWorkspace } from '../lib/workspace';
import { readInventory, readDailyStock } from '../lib/inventoryApi';
import { previewSourceImport } from '../lib/dataApi';
import { useModal } from './useModal';
import { ImportChanges } from './ImportChanges';
import type { SourceImportPreviewRow } from '../domain/sourceTypes';
import { numberLabel } from '../lib/format';

export function FeedImportDialog({ data, onBack }: { data: FeedWorkbookData; onBack: () => void }) {
  const { commit, closeImport, navigate, mutationLocked, hasConflict, resolveConflict, toast,confirmedRetry } = useWorkspace();
  const retryAtMount=useRef(confirmedRetry?.nonce??0);
  useEffect(()=>{if(confirmedRetry&&confirmedRetry.nonce>retryAtMount.current&&['inventory.importBaseline','inventory.importWorkbook'].includes(confirmedRetry.type)){closeImport();navigate('data');}},[confirmedRetry?.nonce]);
  const [baseline, setBaseline] = useState(false);
  const [existing, setExisting] = useState<boolean | null>(null);
  const [previewRows, setPreviewRows] = useState<SourceImportPreviewRow[]>([]);
  const [summary, setSummary] = useState({ added: 0, changed: 0, unchanged: 0, operationalChanged: 0 });
  const [comparing,setComparing] = useState(true);
  const [comparisonError,setComparisonError] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [page, setPage] = useState(1);
  const [reconcile, setReconcile] = useState(false);
  const [countBalances, setCountBalances] = useState<Record<string,number>>({});
  const dialog = useModal(closeImport);
  useEffect(() => {
    let active = true;
    readInventory().then(stock => {
      if (!active) return;
      const hasStock = stock.baselineDate !== null;
      setExisting(hasStock); setBaseline(!hasStock);
      if(hasStock)readDailyStock(data.asOfDate).then(rows=>{if(active)setCountBalances(Object.fromEntries(rows.map(row=>[`${row.materialCode}\0${row.medication}\0${row.fmrOmed}`,row.closing])));}).catch(e=>{if(active)setError(e.message);});

    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [data]);
  useEffect(() => {
    if (existing === null) return;
    let active = true;
    setComparing(true); setComparisonError(''); setPreviewRows([]); setConfirmed(false);
    Promise.all(data.orders.map(batch => previewSourceImport(batch, {includeBaseline: baseline, annotations: data.annotations}))).then(previews => {
      if (!active) return;
      setPreviewRows(previews.flatMap(p => p.rows));
      setSummary(previews.reduce((sum,p) => ({added:sum.added+p.added,changed:sum.changed+p.changed,unchanged:sum.unchanged+p.unchanged,operationalChanged:sum.operationalChanged+(p.operationalChanged??0)}),{added:0,changed:0,unchanged:0,operationalChanged:0}));
    }).catch(e => { if(active) setComparisonError(e.message); }).finally(() => { if(active) setComparing(false); });
    return () => { active = false; };
  }, [data, existing, baseline]);
  const rows = data.orders.flatMap(batch => batch.rows);
  const comparisons = new Map(previewRows.map(row => [row.fields.doNo + '\0' + row.fields.materialCode, row]));
  const bag = data.items.filter(i => i.unit === 'Bags');
  const bulk = data.items.filter(i => i.unit === 'MT');
  const totalMt = data.items.reduce((sum, i) => sum + (i.unit === 'MT' ? i.closing : i.closing * i.bagWeightKg! / 1000), 0);
  async function save() {
    if (await commit({ type: 'inventory.importWorkbook', input: { ...data, includeBaseline: baseline, reconcileStock: reconcile } }, 'Workbook imported. New orders added; existing orders kept as-is.')) { closeImport(); navigate('data'); }
  }
  return <div className="editor-layer"><button className="editor-scrim" aria-label="Close workbook import" disabled={mutationLocked} onClick={closeImport}/><section ref={dialog} className="production-editor import-dialog" role="dialog" aria-modal="true" aria-labelledby="feed-import-title" tabIndex={-1}>
    <header className="editor-header"><div><h2 id="feed-import-title">Daily stock workbook</h2><p>{data.fileName} · As of {data.asOfDate}</p></div><button className="icon-button" disabled={mutationLocked} onClick={closeImport} aria-label="Close workbook import"><X/></button></header>
    <div className="editor-body">
      {hasConflict && <div className="notice warning">The workspace changed. Your workbook is preserved. <button className="text-link" onClick={() => { resolveConflict(); setConfirmed(false); }}>Refresh before confirming</button></div>}
      <div className="import-summary"><div><strong>{rows.length}</strong><span>SAP orders · {data.orders.map(b => `${b.sheetName}: ${b.rows.length}`).join(' / ')}</span></div><div><strong>{data.items.length}</strong><span>Stock items · {bag.length} bag / {bulk.length} bulk</span></div><div><strong>{numberLabel(totalMt, 3)} MT</strong><span>Reported closing stock</span></div></div>
      {comparing ? <p role="status">Comparing workbook values…</p> : <p>{summary.added} new orders · {summary.changed + summary.unchanged} existing orders skipped · {summary.changed} differ in Excel (kept as-is)</p>}
      <p className="data-note">Only the initial stock baseline reads Medication / FMR and historical DONE / OUT from the dated daily sheet. Later imports keep existing order data as-is. DONE is production ready; OUT is collected. Neither posts another stock movement against the closing baseline.</p>
      <label className="checkbox-label"><input type="checkbox" checked={baseline} disabled={existing === null || existing || mutationLocked} onChange={e => { setBaseline(e.target.checked); setConfirmed(false); }}/>Establish opening inventory from {data.asOfDate} Closing</label>
      {existing && <><p className="notice warning">Only new orders are added. Existing orders and physical stock are kept as-is. Only confirm a physical count if this workbook contains a verified count.</p><label className="checkbox-label"><input type="checkbox" checked={reconcile} disabled={mutationLocked} onChange={e=>{setReconcile(e.target.checked);setConfirmed(false);}}/>Reconcile {data.asOfDate} physical Closing with the ledger</label></>}
      {reconcile && <div className="notice warning"><strong>Physical count differences — {data.items.filter(i=>i.closing!==(countBalances[`${i.materialCode}\0${i.medication}\0${i.fmrOmed}`]??0)).length} items</strong><p>Confirmation records each difference as a dated adjustment and preserves all original movements.</p><div className="table-scroll"><table><thead><tr><th>PRODUCT</th><th>LEDGER CLOSING</th><th>COUNTED</th><th>ADJUSTMENT</th></tr></thead><tbody>{data.items.map(i=>{const current=countBalances[`${i.materialCode}\0${i.medication}\0${i.fmrOmed}`]??0;return <tr key={i.materialCode}><td>{i.materialCode}</td><td>{current} {i.unit}</td><td>{i.closing} {i.unit}</td><td>{numberLabel(i.closing-current,3)}</td></tr>;})}</tbody></table></div></div>}
      {baseline && <p className="notice warning">This is an {data.asOfDate} stock snapshot. Production and deliveries after that date must be recorded separately. {data.items.filter(i => i.strategy === 'mts').length} products have numeric safety stock; {data.items.filter(i => i.needsReview).length} need policy review.</p>}
      <div className="table-scroll import-preview" role="region" aria-label="Workbook import comparison" tabIndex={0}><table><colgroup>{[12,22,12,10,12,32].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup><thead><tr><th>DO</th><th>MATERIAL</th><th>DELIVERY</th><th>QUANTITY</th><th>SHEET</th><th>RESULT / CHANGES</th></tr></thead><tbody>{rows.slice((page - 1) * 50, page * 50).map((r, n) => { const comparison = comparisons.get(r.doNo + "\0" + r.materialCode); return <tr key={n}><td>{r.doNo}</td><td><strong>{r.materialCode}</strong><small>{r.description}</small></td><td>{r.deliveryDate}</td><td>{r.quantity} {r.unit}</td><td>{r.sourceSheet}</td><td>{comparison ? <><span className={"source-tag " + (comparison.operationalChanged ? "changed" : comparison.disposition)}>{comparison.disposition === "added" ? "New" : "Skipped"}</span><ImportChanges row={comparison} asOfDate={data.asOfDate}/></> : "Comparing…"}</td></tr>; })}</tbody></table></div>
      <div className="data-pagination"><span>{(page - 1) * 50 + 1}–{Math.min(page * 50, rows.length)} of {rows.length}</span><div><button className="button secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button><button className="button secondary" disabled={page * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>Next</button></div></div>
      <details><summary>Stock baseline · {data.items.length} items</summary><div className="table-scroll"><table><thead><tr><th>PRODUCT</th><th>OPENING</th><th>PRODUCTION</th><th>ISSUE</th><th>CLOSING</th><th>STRATEGY / TARGET</th></tr></thead><tbody>{data.items.map(i => <tr key={i.materialCode}><td>{i.materialCode}<small>{i.description} · {i.bagWeightKg ? `${i.bagWeightKg}kg` : 'Bulk'}</small></td><td>{i.opening}</td><td>{i.production}</td><td>{i.issue}</td><td>{i.closing} {i.unit}</td><td>{i.strategy.toUpperCase()} / {i.targetQuantity}{i.needsReview ? ' · Review' : ''}</td></tr>)}</tbody></table></div></details>
      {data.packingBinTotal !== null && <p className="data-note">Packing bin total: {data.packingBinTotal} (reference only; excluded from allocatable stock).</p>}
      <label className="checkbox-label import-confirm"><input type="checkbox" checked={confirmed} disabled={comparing || !!comparisonError} onChange={e => setConfirmed(e.target.checked)}/>I checked the orders, stock date and historical statuses.</label>
      {(error || comparisonError || toast?.error) && <p className="data-error" role="alert">{error || comparisonError || toast?.message}</p>}
    </div><footer className="editor-footer"><button className="button secondary" disabled={mutationLocked} onClick={onBack}><ArrowLeft size={15}/>Choose another workbook</button><div className="toolbar-spacer"/><button className="button primary" disabled={!confirmed || existing === null || comparing || !!comparisonError || !!error || mutationLocked || hasConflict} onClick={() => void save()}><Check size={15}/>Confirm import</button></footer>
  </section></div>;
}
