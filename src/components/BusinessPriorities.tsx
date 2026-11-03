import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { OperationsSummary } from '../domain/operationsSummary';
import { dataRequest } from '../lib/dataApi';
import { dateLabel, fullDateTime, numberLabel } from '../lib/format';
import { useListPreset } from '../lib/listNavigation';
import { useWorkspace } from '../lib/workspace';
import './BusinessPriorities.css';

type Priority = keyof OperationsSummary['counts'];
const EMPTY_FILTERS = { deliveryFrom: '', deliveryTo: '', unit: '', productionStatus: '', deliveryStatus: '', overdue: '', importId: '' };

export function BusinessPriorities() {
  const { storageMode, revision, savedAt, refresh, navigate, mutationLocked, hasConflict } = useWorkspace();
  const preset = useListPreset();
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (storageMode !== 'database') return;
    let active = true;
    setLoading(true); setError(false);
    dataRequest<OperationsSummary>('/api/operations-summary').then(data => {
      if (!active) return;
      setSummary(data);
      if (data.revision !== revision) void refresh();
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [storageMode, revision, savedAt, reload, refresh]);
  useEffect(() => {
    if (storageMode !== 'database') return;
    const update = () => { if (document.visibilityState === 'visible') setReload(value => value + 1); };
    const timer = setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [storageMode]);
  if (storageMode !== 'database') return null;
  const ready = !loading && !!summary && summary.revision === revision && !error;
  const disabled = !ready || mutationLocked || hasConflict;
  const range = summary ? `${dateLabel(summary.asOfDate, true)}–${dateLabel(summary.dueSoonThrough, true)}` : 'Upcoming delivery dates';
  const items: Array<{ key: Priority; label: string; detail: string; tone: string }> = [
    { key: 'overdueToPlan', label: 'Overdue · still to plan', detail: 'Uncovered order quantities', tone: 'urgent' },
    { key: 'dueSoon', label: 'Orders due soon', detail: range, tone: 'upcoming' },
    { key: 'stockShortages', label: 'Below safety stock', detail: 'Standard make-for-stock products', tone: 'stock' },
    { key: 'pendingImportReviews', label: 'Excel reviews pending', detail: 'Changes awaiting a decision', tone: 'review' },
  ];
  function open(key: Priority) {
    if (!summary || disabled) return;
    const page = key === 'stockShortages' ? 'stock' : 'data';
    if (!navigate(page)) return;
    if (key === 'stockShortages') {
      preset({ 'stock.tab': 'stock', 'stock.list.search': '', 'stock.list.strategy': 'mts', 'stock.list.variant': '', 'stock.list.low': true, 'stock.list.page': 1 }, ['stock.position', 'stock.list.table']);
    } else if (key === 'pendingImportReviews') {
      preset({ 'data.section': 'reviews', 'reviews.status': 'pending', 'reviews.page': 1 });
    } else {
      const yesterday = new Date(Date.parse(`${summary.asOfDate}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const filters = key === 'overdueToPlan'
        ? { ...EMPTY_FILTERS, deliveryTo: yesterday }
        : { ...EMPTY_FILTERS, deliveryStatus: 'pending', deliveryFrom: summary.asOfDate, deliveryTo: summary.dueSoonThrough };
      preset({ 'data.section': 'orders', 'orders.search': '', 'orders.page': 1, 'orders.view': key === 'overdueToPlan' ? 'needs-production' : 'all', 'orders.filters': filters, 'orders.filtersOpen': false }, ['orders.position', 'orders.table']);
    }
  }
  return <section className="business-priorities" aria-labelledby="business-priorities-title" aria-busy={loading}>
    <div className="business-priorities-heading"><h2 id="business-priorities-title">Orders & stock priorities</h2><span>{ready ? `As of ${dateLabel(summary.asOfDate, true)} · MYT` : error ? 'Could not load priorities' : 'Updating priorities…'}</span><button type="button" className="text-link" disabled={loading} onClick={() => setReload(value => value + 1)} aria-label="Refresh business priorities"><RefreshCw size={14}/>{error ? 'Retry' : 'Refresh'}</button></div>
    {error && <p className="business-priorities-error" role="alert">Priorities and source dates are unavailable. Retry to load the current figures.</p>}
    <div className="business-priority-grid">{items.map(item => <button type="button" key={item.key} data-priority={item.key} className={`business-priority ${item.tone}`} disabled={disabled} onClick={() => open(item.key)}>
      <strong className="business-priority-count">{ready ? numberLabel(summary.counts[item.key], 0) : '—'}</strong><span><b>{item.label}</b><small>{item.detail}</small></span><ArrowUpRight size={16}/>
    </button>)}</div>
    <details className="overview-freshness">
      <summary>Source dates<span>{ready ? `Newest order Excel: ${summary.freshness.newestExcelAsOfDate ? dateLabel(summary.freshness.newestExcelAsOfDate, true) : 'None imported'} · Stock count: ${summary.freshness.lastVerifiedStockCountDate ? dateLabel(summary.freshness.lastVerifiedStockCountDate, true) : 'Not established'}` : 'Unavailable until priorities load'}</span></summary>
      {ready && <dl>
        <div><dt>Newest order Excel date</dt><dd>{summary.freshness.newestExcelAsOfDate ? dateLabel(summary.freshness.newestExcelAsOfDate, true) : 'None imported'}</dd></div>
        <div><dt>Latest order upload</dt><dd>{summary.freshness.latestOrderImport ? fullDateTime(summary.freshness.latestOrderImport.importedAt) : 'None imported'}{summary.freshness.latestOrderImport && <small>File dated {dateLabel(summary.freshness.latestOrderImport.asOfDate, true)}</small>}</dd></div>
        <div><dt>Inventory baseline</dt><dd>{summary.freshness.inventoryBaselineDate ? dateLabel(summary.freshness.inventoryBaselineDate, true) : 'Not established'}</dd></div>
        <div><dt>Last verified stock count</dt><dd>{summary.freshness.lastVerifiedStockCountDate ? dateLabel(summary.freshness.lastVerifiedStockCountDate, true) : 'Not established'}</dd></div>
      </dl>}
      <p>Excel dates describe imported files; they do not confirm that every order is current. Stock changes with posted production and collections. Priorities use today's date, independently of the selected planning day.</p>
    </details>
  </section>;
}
