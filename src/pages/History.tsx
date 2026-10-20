import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clock3, ListFilter, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { SearchInput, StatusBadge, EmptyState } from '../components/Shared';
import { dateLabel, fullDateTime, localDate, numberLabel, productColor, outputVarianceLabel, stopDurationLabel } from '../lib/format';
import { getProductionResult, isJobPaused } from '../domain/production-results';
import { LINE_IDS } from '../domain/types';
import type { Job, LineId } from '../domain/types';
import { HistoryChanges, historyFieldLabel } from '../components/HistoryChanges';
import { useCurrentTime } from '../lib/useCurrentTime';
import './History.css';

const PAGE_SIZE = 50;

export function HistoryPage() {
  const { state, date, openJob, storageMode } = useWorkspace();
  const now = useCurrentTime(state.jobs.some(isJobPaused));
  const [tab, setTab] = useState<'records' | 'activity'>('records');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('all');
  const [line, setLine] = useState<LineId | 'all'>('all');
  const [page, setPage] = useState(1);
  const search = query.trim().toLowerCase();
  const records = useMemo(() => state.jobs.filter(job =>
    (!from || job.date >= from) && (!to || job.date <= to) &&
    (line === 'all' || job.lineId === line) &&
    (status === 'all' || (status === 'paused' ? isJobPaused(job) : status === 'issue' ? !!job.issue : !job.issue && job.status === status && (status !== 'running' || !isJobPaused(job)))) &&
    [job.productCode, job.description, job.orderNo, job.bin, job.lineId, job.remarks, job.completionNote, job.issue?.reason, ...(job.pauseIntervals ?? []).map(pause => pause.reason)].join(' ').toLowerCase().includes(search)
  ).sort((a, b) => b.date.localeCompare(a.date) || a.lineId.localeCompare(b.lineId) || a.sequence - b.sequence), [state.jobs, from, to, line, status, search]);
  const events = useMemo(() => state.events.filter(event =>
    [event.message, ...(event.changes ?? []).flatMap(change => [historyFieldLabel(change.field), change.before, change.after])].join(' ').toLowerCase().includes(search) && (!from || localDate(new Date(event.at)) >= from) && (!to || localDate(new Date(event.at)) <= to)
  ).sort((a, b) => b.at.localeCompare(a.at)), [state.events, search, from, to]);
  const completed = records.filter(job => job.status === 'completed');
  const actuals = completed.map(job => getProductionResult(job)).filter(result => result.actualQuantityMt !== null);
  const plannedMt = records.filter(job => job.status !== 'cancelled').reduce((sum, job) => sum + job.quantityMt, 0);
  const actualMt = actuals.reduce((sum, result) => sum + result.actualQuantityMt!, 0);
  const hasFilters = query || from || to || (tab === 'records' && (status !== 'all' || line !== 'all'));
  const count = tab === 'records' ? records.length : events.length;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  useEffect(() => { setPage(previous => Math.min(previous, pages)); }, [pages]);
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const changeFilter = (change: () => void) => { change(); setPage(1); };

  return <div className="page history-page">
    <div className="page-heading"><div><span className="eyebrow">A RECORD OF THE WORK</span><h1>Production history<span className="heading-dot">.</span></h1><p>Review production records and the changes behind the plan.</p></div><span className="outline-badge"><Clock3 size={13}/>{storageMode === 'database' ? 'PostgreSQL records' : 'Offline records'}</span></div>
    {tab === 'records' ? <div className="history-stats" aria-label="Filtered production summary">
      <div><span>MATCHING RECORDS</span><strong data-summary="records">{records.length}</strong></div>
      <div><span>COMPLETED TASKS</span><strong data-summary="completed">{completed.length}</strong></div>
      <div><span>PLANNED OUTPUT</span><strong data-summary="planned">{numberLabel(plannedMt)}<small> MT</small></strong><small className="history-coverage">Cancelled tasks excluded</small></div>
      <div><span>RECORDED ACTUAL OUTPUT</span><strong data-summary="actual">{actuals.length ? numberLabel(actualMt) : '—'}<small> MT</small></strong><small className="history-coverage">{actuals.length} / {completed.length} completed tasks recorded</small></div>
    </div> : <p className="history-activity-summary" role="status"><strong>{events.length}</strong> matching activity entries · filtered by search and dates</p>}
    <section className="panel">
      <div className="tab-bar"><button aria-pressed={tab === 'records'} className={tab === 'records' ? 'active' : ''} onClick={() => changeFilter(() => setTab('records'))}>Production records<span>{state.jobs.length}</span></button><button aria-pressed={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => changeFilter(() => setTab('activity'))}>Activity log<span>{state.events.length}</span></button></div>
      <div className="table-filters">
        <SearchInput value={query} onChange={value => changeFilter(() => setQuery(value))}/>
        <div className="filter-dates"><CalendarDays size={15}/><input type="date" aria-label="History from date" value={from} onChange={e => changeFilter(() => { const value = e.target.value; setFrom(value); if (value && to && value > to) setTo(value); })}/><span>—</span><input type="date" aria-label="History to date" value={to} min={from} onChange={e => changeFilter(() => { const value = e.target.value; setTo(value); if (value && from && value < from) setFrom(value); })}/></div>
        {tab === 'records' && <><label className="status-filter line-filter"><span>Line</span><select aria-label="Filter line" value={line} onChange={e => changeFilter(() => setLine(e.target.value as LineId | 'all'))}><option value="all">All lines</option>{LINE_IDS.map(lineId => <option key={lineId} value={lineId}>{lineId}</option>)}</select></label><label className="status-filter"><ListFilter size={15}/><select aria-label="Filter status" value={status} onChange={e => changeFilter(() => setStatus(e.target.value))}><option value="all">All statuses</option><option value="pending">Not started</option><option value="issue">Issue</option><option value="running">Running</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label></>}
        {hasFilters && <button className="text-link" onClick={() => changeFilter(() => { setQuery(''); setFrom(''); setTo(''); setStatus('all'); setLine('all'); })}>Clear filters</button>}
      </div>
      {tab === 'records' ? (records.length ? <div className="table-scroll"><table><thead><tr><th>PLANNING DATE</th><th>PRODUCT / ORDER</th><th>LINE</th><th>PLANNED / ACTUAL</th><th>ACTUAL START</th><th>ACTUAL END</th><th>STATUS</th><th/></tr></thead><tbody>{records.slice(offset, offset + PAGE_SIZE).map(job => <tr className="clickable-row" key={job.id} onClick={() => openJob(job.id)}><td>{dateLabel(job.date, true)}</td><td><div className="product-cell"><i style={{ background: productColor(job.productCode) }}/><div><strong>{job.productCode}</strong><small>{job.orderNo || 'No order reference'}</small></div></div></td><td><span className="line-tag">{job.lineId}</span></td><td><HistoryQuantity job={job} now={now}/></td><td className="tabular muted">{fullDateTime(job.actualStart)}</td><td className="tabular muted">{fullDateTime(job.actualEnd)}</td><td><StatusBadge status={job.status} issue={!!job.issue} paused={isJobPaused(job)}/></td><td><button className="icon-button" aria-label={'View ' + job.productCode + ' record'} onClick={e => { e.stopPropagation(); openJob(job.id); }}><ArrowUpRight size={16}/></button></td></tr>)}</tbody></table></div> : <EmptyState title="No matching records" text="Try another line, date range, status or product reference."/>) :
        events.length ? <div className="activity-list">{events.slice(offset, offset + PAGE_SIZE).map(event => <div className="activity-event" key={event.id}><span className={'activity-dot ' + event.type}/><div><strong>{event.message}</strong><span>{fullDateTime(event.at)} · {event.type.replace(/[._-]+/g, ' ')}</span><HistoryChanges event={event}/></div>{event.jobId && state.jobs.some(job => job.id === event.jobId) && <button className="icon-button" onClick={() => openJob(event.jobId!)} aria-label="Open related production"><ArrowUpRight size={16}/></button>}</div>)}</div> : <EmptyState title="No matching activity" text="Try another search or date range."/>}
      <div className="table-foot history-pagination">
        <span aria-live="polite">{count ? offset + 1 : 0}–{Math.min(offset + PAGE_SIZE, count)} of {count} matching {tab === 'records' ? 'records' : 'events'}</span>
        <nav aria-label="History pages"><button className="button secondary" aria-label="Previous history page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15}/>Previous</button><span>Page {currentPage} of {pages}</span><button className="button secondary" aria-label="Next history page" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next<ChevronRight size={15}/></button></nav>
      </div>
      <p className="history-export-note">Statistics include every matching record across all pages. Quick export uses the selected planning day: {dateLabel(date, true)}.</p>
    </section>
  </div>;
}

function HistoryQuantity({ job, now }: { job: Job; now: number }) {
  const result = getProductionResult(job, now);
  return <div className="history-output"><span>{numberLabel(job.quantityMt, 2)} MT planned</span>{job.status === 'completed' && <><strong>{result.actualQuantityMt === null ? 'Actual not recorded' : `${numberLabel(result.actualQuantityMt, 2)} MT actual`}</strong>{result.varianceMt !== null && <small className={result.varianceMt < 0 ? 'shortfall' : ''}>{outputVarianceLabel(result.varianceMt)}</small>}</>}{!!job.pauseIntervals?.length && <small>{stopDurationLabel(result.downtimeMinutes)} recorded stops</small>}</div>;
}
