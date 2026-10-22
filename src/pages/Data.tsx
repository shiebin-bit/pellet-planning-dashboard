import { useEffect, useRef, useState } from 'react';
import { Upload, RefreshCw, ArrowUpRight, X, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { SourceOrderDetail, SourceOrderPage, SourceOrderSummary } from '../domain/sourceTypes';
import { readImportBatches, readSourceOrder, readSourceOrders } from '../lib/dataApi';
import type { ImportBatchOption } from '../lib/dataApi';
import { dateLabel, fullDateTime, localDate, numberLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import { EmptyState } from '../components/Shared';
import './Data.css';

const productionLabels: Record<string, string> = { unplanned: 'Unplanned', pending: 'Planned', running: 'Running', completed: 'Completed', cancelled: 'Unplanned', 'external-complete': 'External complete' };
export function canPlanSource(order: SourceOrderSummary) { return order.deliveryStatus !== 'delivered' && !order.linkedJobId && order.quantity > 0; }
export function SourceStatus({ order }: { order: SourceOrderSummary }) {
  return <div className="source-status"><span className={'source-tag ' + order.productionStatus}>{productionLabels[order.productionStatus]}</span>{order.deliveryStatus === 'delivered' && <span className="source-tag completed">Delivered</span>}{order.needsReview && <span className="source-tag review">Needs review</span>}</div>;
}
export function DayCount({ value, stopped, label }: { value: number | null; stopped?: boolean; label: string }) {
  if (stopped) return <span className="muted">Complete</span>;
  return <span className={value !== null && value < 0 ? 'days-overdue' : value === 0 ? 'days-today' : ''}>{value === null ? 'Unknown' : value < 0 ? `${Math.abs(value)}d overdue` : value === 0 ? 'Today' : `${value}d left`}<span className="sr-only"> {label}</span></span>;
}
export function DataPage() {
  const { storageMode, openImport, mutationLocked, hasConflict } = useWorkspace();
  return <div className="page data-page"><div className="page-heading"><div><h1>Order data</h1><p>Import the SAP Excel list, review orders and send them to production.</p></div><button className="button primary" disabled={storageMode !== 'database' || mutationLocked || hasConflict} onClick={openImport}><Upload size={16}/>Import Excel</button></div>{storageMode === 'database' ? <DataBrowser/> : <div className="notice warning">Order imports and queries require the PostgreSQL workspace. Manual production planning remains available offline.</div>}</div>;
}

export function DataBrowser({ onChoose, compact = false }: { onChoose?: (order: SourceOrderSummary) => void; compact?: boolean }) {
  const { savedAt, openSource, openJob, mutationLocked, hasConflict, notify } = useWorkspace();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ deliveryFrom: '', deliveryTo: '', unit: '', productionStatus: '', deliveryStatus: '', overdue: '', importId: '' });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SourceOrderPage | null>(null);
  const [batches, setBatches] = useState<ImportBatchOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [today, setToday] = useState(localDate());
  const [detail, setDetail] = useState<SourceOrderDetail | null>(null);
  const request = useRef(0);
  const detailRequest = useRef(0);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); detailRequest.current++; setDetail(null); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const tick = () => setToday(localDate());
    const timer = setInterval(tick, 30_000); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  useEffect(() => {
    let current = true;
    readImportBatches().then(rows => { if (current) setBatches(rows); }).catch(() => { /* List still works if the batch menu is temporarily unavailable. */ });
    return () => { current = false; };
  }, [savedAt, reload]);
  useEffect(() => {
    const version = ++request.current;
    setLoading(true); setError('');
    const params = new URLSearchParams(Object.entries({ page: String(page), search: query, ...filters }).filter(([, value]) => value !== ''));
    readSourceOrders(params).then(data => {
      if (version !== request.current) return;
      setResult(data); if (data.page !== page) setPage(data.page);
    }).catch(reason => { if (version === request.current) setError(reason instanceof Error ? reason.message : 'Orders could not be loaded.'); }).finally(() => { if (version === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [query, filters, page, savedAt, reload, today]);
  useEffect(() => { if (detail) void showDetail(detail.id); }, [savedAt]);
  useEffect(() => () => { detailRequest.current++; }, []);
  const change = (key: keyof typeof filters, value: string) => { setFilters(previous => ({ ...previous, [key]: value })); setPage(1); detailRequest.current++; setDetail(null); };
  async function showDetail(id: string) {
    const version = ++detailRequest.current;
    try { const data = await readSourceOrder(id); if (version === detailRequest.current) setDetail(data); }
    catch (reason) { if (version === detailRequest.current) notify(reason instanceof Error ? reason.message : 'Order could not be loaded.', true); }
  }
  const awaitingSearch = search !== query;
  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  useEffect(() => { if (!loading && page > pages) setPage(pages); }, [loading, page, pages]);
  return <div className={'data-browser ' + (compact ? 'compact' : '')}>
    {!compact && result && <div className="data-stats" aria-label="Filtered order summary"><div><span>Matching orders</span><strong>{result.stats.total}</strong></div><div><span>Planned / running</span><strong>{result.stats.planned} / {result.stats.running}</strong></div><div><span>Production complete</span><strong>{result.stats.completed}</strong></div><div><span>Delivered / pickup overdue</span><strong>{result.stats.delivered} / <em>{result.stats.overdue}</em></strong></div></div>}
    {detail && !compact && <SourceDetail order={detail} onClose={() => { detailRequest.current++; setDetail(null); }} onReload={() => { void showDetail(detail.id); setReload(value => value + 1); }}/>}
    <section className="panel data-list"><div className="data-filters">
      <label className="data-search"><Search size={16}/><input aria-label="Search order data" placeholder="DO no, customer, material or description" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <button className="button secondary" disabled={loading} onClick={() => setReload(value => value + 1)} aria-label="Refresh order data"><RefreshCw size={15}/><span>Refresh</span></button>
      <div className="data-filter-row">
        <label>Delivery from<input type="date" value={filters.deliveryFrom} onChange={event => change('deliveryFrom', event.target.value)}/></label><label>Delivery to<input type="date" min={filters.deliveryFrom} value={filters.deliveryTo} onChange={event => change('deliveryTo', event.target.value)}/></label>
        <label>Unit<select value={filters.unit} onChange={event => change('unit', event.target.value)}><option value="">All units</option><option>MT</option><option>Bags</option></select></label>
        <label>Production<select value={filters.productionStatus} onChange={event => change('productionStatus', event.target.value)}><option value="">All production</option><option value="unplanned">Unplanned</option><option value="pending">Planned</option><option value="running">Running</option><option value="completed">Completed</option><option value="external-complete">External complete</option></select></label>
        <label>Delivery<select value={filters.deliveryStatus} onChange={event => change('deliveryStatus', event.target.value)}><option value="">All deliveries</option><option value="pending">Not delivered</option><option value="delivered">Delivered</option></select></label>
        <label>Deadline<select value={filters.overdue} onChange={event => change('overdue', event.target.value)}><option value="">All deadlines</option><option value="production">Production overdue</option><option value="pickup">Pickup overdue</option></select></label>
        <label>Import batch<select value={filters.importId} onChange={event => change('importId', event.target.value)}><option value="">All imports</option>{batches.map(batch => <option key={batch.id} value={batch.id}>{batch.fileName} · {batch.asOfDate} · {batch.id.slice(0, 8)}</option>)}</select></label>
        {(search || Object.values(filters).some(Boolean)) && <button className="text-link" onClick={() => { detailRequest.current++; setDetail(null); setSearch(''); setQuery(''); setFilters({ deliveryFrom: '', deliveryTo: '', unit: '', productionStatus: '', deliveryStatus: '', overdue: '', importId: '' }); setPage(1); }}>Clear filters</button>}
      </div></div>
      {error ? <div className="data-empty" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setReload(value => value + 1)}>Retry loading</button></div> : loading || awaitingSearch ? <div className="data-empty" role="status">Loading orders…</div> : result?.items.length ? <div className="table-scroll"><table className="source-table"><thead><tr><th>DO / CUSTOMER</th><th>MATERIAL / DESCRIPTION</th><th>DELIVERY</th><th>QUANTITY</th><th>PRODUCE BY</th><th>PICKUP IN</th><th>STATUS</th><th/></tr></thead><tbody>{result.items.map(order => <tr key={order.id}><td><button className="data-order-link" onClick={() => compact ? onChoose?.(order) : void showDetail(order.id)}>{order.doNo}</button><small>{order.shipToParty || order.soldToParty || '—'}</small></td><td><strong className="data-material">{order.materialCode}</strong><small>{order.description || '—'}</small></td><td>{dateLabel(order.deliveryDate, true)}</td><td className="tabular">{numberLabel(order.quantity, order.unit === 'Bags' ? 0 : 2)} {order.unit}</td><td><DayCount label="production" value={order.currentDeliveryLeadDays} stopped={['completed', 'external-complete'].includes(order.productionStatus)}/></td><td><DayCount label="pickup" value={order.currentDaysOutstanding} stopped={order.deliveryStatus === 'delivered'}/></td><td><SourceStatus order={order}/></td><td>{canPlanSource(order) ? <button className="button secondary" disabled={mutationLocked || hasConflict} onClick={() => onChoose ? onChoose(order) : openSource(order)}>Plan production</button> : order.linkedJobId && !compact ? <button className="text-link" disabled={mutationLocked} onClick={() => openJob(order.linkedJobId!, true)}>View card<ArrowUpRight size={14}/></button> : <span className="muted small">{order.quantity === 0 ? 'No quantity' : order.needsReview ? 'Review order' : 'Already processed'}</span>}</td></tr>)}</tbody></table></div> : <EmptyState title="No matching orders" text="Import an Excel workbook or adjust the filters."/>}
      <div className="table-foot data-pagination"><span aria-live="polite">{total ? (page - 1) * 50 + 1 : 0}–{Math.min(page * 50, total)} of {total} orders</span><nav aria-label="Order data pages"><button className="button secondary" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15}/>Previous</button><span>Page {page} of {pages}</span><button className="button secondary" disabled={loading || page >= pages} onClick={() => setPage(value => value + 1)}>Next<ChevronRight size={15}/></button></nav></div>
    </section><p className="data-note">Day counts use calendar days from the Excel as-of date and update daily in MYT. Blank values remain unknown. Production completion and delivery are recorded separately.</p>
  </div>;
}

function SourceDetail({ order, onClose, onReload }: { order: SourceOrderDetail; onClose: () => void; onReload: () => void }) {
  const { commit, mutationLocked, hasConflict, openSource, openJob, toast } = useWorkspace();
  const [action, setAction] = useState<'deliver' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { setAction(null); setReason(''); setFailed(false); }, [order.id]);
  const mayDeliver = !order.linkedJobId || order.productionStatus === 'completed';
  async function save() {
    if (await commit({ type: 'data.setDeliveryStatus', sourceOrderId: order.id, delivered: action === 'deliver', ...(reason.trim() ? { reason: reason.trim() } : {}) }, action === 'deliver' ? 'Delivery recorded.' : 'Delivery reopened.')) { setAction(null); setFailed(false); onReload(); }
    else setFailed(true);
  }
  return <section className="panel source-detail" aria-label="Order details"><header><div><span className="eyebrow">ORDER DETAILS</span><h2>{order.doNo} · {order.materialCode}</h2><p>{order.description}</p></div><button className="icon-button" aria-label="Close order details" onClick={onClose}><X size={19}/></button></header><SourceStatus order={order}/>{order.needsReview && <div className="notice warning">The imported order differs from its production card, or delivery was reported before production finished. Review both records. Existing production quantities and timestamps are retained.</div>}<dl className="source-details-grid">{[
    ['Delivery date', dateLabel(order.deliveryDate)], ['Sold to Party', order.soldToParty], ['Ship to Party', order.shipToParty], ['Quantity', `${order.quantity} ${order.unit}`], ['Remark (Excel)', order.remark], ['Medication', order.medication], ['FMR / OMED', order.fmrOmed], ['Original production lead days', order.deliveryLeadDays], ['Original pickup days', order.daysOutstanding], ['Excel as-of date', order.importAsOfDate], ['Delivery source', order.deliverySource], ['Delivery recorded at', order.deliveryRecordedAt ? fullDateTime(order.deliveryRecordedAt) : 'Not recorded'], ['Delivery reason', order.deliveryReason], ['Latest import', order.importFileName], ['Order version', order.version],
  ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null || value === '' ? '—' : value}</dd></div>)}</dl><div className="source-detail-actions">{canPlanSource(order) && <button className="button primary" disabled={mutationLocked || hasConflict} onClick={() => openSource(order)}>Plan production</button>}{order.linkedJobId && <button className="button secondary" disabled={mutationLocked} onClick={() => openJob(order.linkedJobId!, true)}>Open production card</button>}{order.deliveryStatus === 'delivered' ? <button className="button secondary" disabled={mutationLocked || hasConflict} onClick={() => setAction('reopen')}>Reopen delivery</button> : <button className="button secondary" disabled={!mayDeliver || mutationLocked || hasConflict} title={!mayDeliver ? 'Complete the linked production card first' : undefined} onClick={() => setAction('deliver')}>Mark delivered</button>}</div>{action && <div className="source-delivery-confirm"><p>{action === 'reopen' ? 'Give a reason to reopen this delivery.' : order.linkedJobId ? 'Confirm that the customer has collected this order.' : 'This order has no production card. Confirm external production and customer collection. No actual production timestamps will be created.'}</p><label className="field">{action === 'reopen' ? 'Reason (required)' : 'Delivery note (optional)'}<input value={reason} maxLength={1000} onChange={event => setReason(event.target.value)}/></label>{failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}<button className="button primary" disabled={mutationLocked || hasConflict || action === 'reopen' && !reason.trim()} onClick={() => void save()}>Confirm {action === 'reopen' ? 'reopen' : 'delivery'}</button><button className="button secondary" disabled={mutationLocked} onClick={() => setAction(null)}>Cancel</button></div>}<details className="source-versions"><summary>Import history · {order.versionTotal ?? order.versions.length} version{(order.versionTotal ?? order.versions.length) === 1 ? '' : 's'}</summary>{(order.versionTotal ?? order.versions.length)>order.versions.length&&<p className="data-note">Showing the latest {order.versions.length} versions. The full history is included in database backups.</p>}{order.versions.map(version => <div key={version.version}><strong>Version {version.version}</strong> · {fullDateTime(version.importedAt)}<pre>{JSON.stringify(version.fields, null, 2)}</pre></div>)}</details><p className="data-note">“Delivery recorded at” is when this system received the confirmation; it may differ from the physical collection time.</p></section>;
}
