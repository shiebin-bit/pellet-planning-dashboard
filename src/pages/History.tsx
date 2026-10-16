import { useMemo, useState } from 'react';
import { ArrowUpRight, Clock3, ListFilter, CalendarDays } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { SearchInput, StatusBadge, EmptyState } from '../components/Shared';
import { dateLabel, fullDateTime, localDate, numberLabel, productColor, outputVarianceLabel } from '../lib/format';
import { getProductionResult } from '../domain/production-results';
import { LINE_IDS } from '../domain/types';
import type { Job, LineId } from '../domain/types';

export function HistoryPage() {
  const {state,date,openJob}=useWorkspace();
  const [tab,setTab]=useState<'records'|'activity'>('records');
  const [query,setQuery]=useState('');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [status,setStatus]=useState('all');
  const [line,setLine]=useState<LineId|'all'>('all');
  const records=useMemo(()=>state.jobs.filter(job=>(!from||job.date>=from)&&(!to||job.date<=to)&&(line==='all'||job.lineId===line)&&(status==='all'||(status==='issue'?!!job.issue:!job.issue&&job.status===status))&&[job.productCode,job.orderNo,job.bin,job.lineId,job.remarks,job.completionNote,job.issue?.reason].join(' ').toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.date.localeCompare(a.date)||a.lineId.localeCompare(b.lineId)||a.sequence-b.sequence),[state.jobs,from,to,line,status,query]);
  const matchingMt=records.reduce((sum,job)=>sum+job.quantityMt,0);
  const completed=state.jobs.filter(job=>job.status==='completed');
  const actuals=completed.map(getProductionResult).filter(result=>result.actualQuantityMt!==null);
  const actualMt=actuals.reduce((sum,result)=>sum+result.actualQuantityMt!,0);
  const hasFilters=query||from||to||(tab==='records'&&(status!=='all'||line!=='all'));
  const events=state.events.filter(event=>event.message.toLowerCase().includes(query.toLowerCase())&&(!from||localDate(new Date(event.at))>=from)&&(!to||localDate(new Date(event.at))<=to)).sort((a,b)=>b.at.localeCompare(a.at));
  return <div className="page history-page"><div className="page-heading"><div><span className="eyebrow">A RECORD OF THE WORK</span><h1>Production history<span className="heading-dot">.</span></h1><p>Review production records and the changes behind the plan.</p></div><span className="outline-badge"><Clock3 size={13}/>All locally saved records</span></div>
    <div className="history-stats"><div><span>PRODUCTION RECORDS</span><strong>{String(state.jobs.length).padStart(2,'0')}</strong></div><div><span>COMPLETED TASKS</span><strong>{String(completed.length).padStart(2,'0')}</strong></div><div><span>RECORDED ACTIVITY</span><strong>{String(state.events.length).padStart(2,'0')}</strong></div><div><span>RECORDED ACTUAL OUTPUT</span><strong>{actuals.length?numberLabel(actualMt):'—'}<small> MT</small></strong><small className="history-coverage">{actuals.length} / {completed.length} completed tasks recorded</small></div></div>
    <section className="panel">
      <div className="tab-bar"><button aria-pressed={tab==='records'} className={tab==='records'?'active':''} onClick={()=>setTab('records')}>Production records<span>{state.jobs.length}</span></button><button aria-pressed={tab==='activity'} className={tab==='activity'?'active':''} onClick={()=>setTab('activity')}>Activity log<span>{state.events.length}</span></button></div>
      <div className="table-filters"><SearchInput value={query} onChange={setQuery}/><div className="filter-dates"><CalendarDays size={15}/><input type="date" aria-label="History from date" value={from} onChange={e=>{const value=e.target.value;setFrom(value);if(value&&to&&value>to)setTo(value);}}/><span>—</span><input type="date" aria-label="History to date" value={to} min={from} onChange={e=>{const value=e.target.value;setTo(value);if(value&&from&&value<from)setFrom(value);}}/></div>{tab==='records'&&<><label className="status-filter line-filter"><span>Line</span><select aria-label="Filter line" value={line} onChange={e=>setLine(e.target.value as LineId|'all')}><option value="all">All lines</option>{LINE_IDS.map(lineId=><option key={lineId} value={lineId}>{lineId}</option>)}</select></label><label className="status-filter"><ListFilter size={15}/><select aria-label="Filter status" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="pending">Not started</option><option value="issue">Issue</option><option value="running">Running</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label></>}{hasFilters&&<button className="text-link" onClick={()=>{setQuery('');setFrom('');setTo('');setStatus('all');setLine('all');}}>Clear filters</button>}</div>
      {tab==='records'?(records.length?<div className="table-scroll"><table><thead><tr><th>PLANNING DATE</th><th>PRODUCT / ORDER</th><th>LINE</th><th>PLANNED / ACTUAL</th><th>ACTUAL START</th><th>ACTUAL END</th><th>STATUS</th><th/></tr></thead><tbody>{records.map(job=><tr className="clickable-row" key={job.id} onClick={()=>openJob(job.id)}><td>{dateLabel(job.date,true)}</td><td><div className="product-cell"><i style={{background:productColor(job.productCode)}}/><div><strong>{job.productCode}</strong><small>{job.orderNo||'No order reference'}</small></div></div></td><td><span className="line-tag">{job.lineId}</span></td><td><HistoryQuantity job={job}/></td><td className="tabular muted">{fullDateTime(job.actualStart)}</td><td className="tabular muted">{fullDateTime(job.actualEnd)}</td><td><StatusBadge status={job.status} issue={!!job.issue}/></td><td><button className="icon-button" aria-label={'View '+job.productCode+' record'} onClick={e=>{e.stopPropagation();openJob(job.id);}}><ArrowUpRight size={16}/></button></td></tr>)}</tbody></table></div>:<EmptyState title="No matching records" text="Try another line, date range, status or product reference."/>):
      events.length?<div className="activity-list">{events.map(event=><div className="activity-event" key={event.id}><span className={'activity-dot '+event.type}/><div><strong>{event.message}</strong><span>{fullDateTime(event.at)} · {event.type.replace(/[._-]+/g,' ')}</span></div>{event.jobId&&state.jobs.some(job=>job.id===event.jobId)&&<button className="icon-button" onClick={()=>openJob(event.jobId!)} aria-label="Open related production"><ArrowUpRight size={16}/></button>}</div>)}</div>:<EmptyState title="No activity yet" text="Planning changes will appear here as the team works."/>}
      <div className="table-foot"><span>{tab==='records'?records.length+' of '+state.jobs.length+' records · '+numberLabel(matchingMt)+' MT planned':events.length+' events'}</span><span>Quick export uses the selected planning day: {dateLabel(date,true)}</span></div>
    </section>
  </div>;
}

function HistoryQuantity({job}:{job:Job}) {
  const result=getProductionResult(job);
  return <div className="history-output"><span>{numberLabel(job.quantityMt,2)} MT planned</span>{job.status==='completed'&&<><strong>{result.actualQuantityMt===null?'Actual not recorded':`${numberLabel(result.actualQuantityMt,2)} MT actual`}</strong>{result.varianceMt!==null&&<small className={result.varianceMt<0?'shortfall':''}>{outputVarianceLabel(result.varianceMt)}</small>}</>}</div>;
}
