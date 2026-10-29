import { productLabel } from '../lib/productLabel';
import { LegacyCarryoverNotice } from '../components/LegacyCarryoverNotice';
import { ArrowUpRight, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { dateLabel, downtimeRange, durationLabel, fullDateTime, numberLabel, productColor, timeLabel, STATUS_LABELS } from '../lib/format';
import type { LineSchedule } from '../domain/types';
import { SectionHeading, StatusBadge, EmptyState, TextLink } from '../components/Shared';
import { NeedsAttention,ProductionResults } from '../components/OperationsSummary';
import { RecordedDowntime } from '../components/RecordedDowntime';
import { getCalendarForDate } from '../domain/engine';
import { getProductionResult, isJobPaused } from '../domain/production-results';

export function Overview() {
  const { board, state, navigate, openJob } = useWorkspace();
  const totalMt = board.lines.reduce((sum, line) => sum + line.plannedMt, 0);
  const available = board.lines.reduce((sum, line) => sum + line.availableMinutes, 0);
  const production = board.lines.reduce((sum, line) => sum + line.productionMinutes, 0);
  const jobs = board.lines.flatMap(line => line.jobs).filter(job => job.status !== 'cancelled');
  const uniqueJobs = [...new Map(jobs.map(job => [job.id, job])).values()];
  const completed = uniqueJobs.filter(job => job.status === 'completed').length;
  const completedFromDate=state.jobs.filter(job=>job.date===board.date&&job.status==='completed');
  const actualRecorded=completedFromDate.map(job=>getProductionResult(job)).filter(result=>result.actualQuantityMt!==null);
  const actualMt=actualRecorded.reduce((sum,result)=>sum+result.actualQuantityMt!,0);
  const overflows = board.lines.filter(line => line.overflowMinutes > 0);
  const queue = uniqueJobs.filter(job => job.status === 'pending' || job.status === 'running').sort((a,b) => (a.plannedStart || Infinity) - (b.plannedStart || Infinity)).slice(0, 6);
  const calendar = getCalendarForDate(state.settings, board.date);
  const span = board.end - board.start;
  const ticks = Array.from({length: 9}, (_, index) => board.start + span * index / 8);
  return <div className="page overview-page">
    <div className="page-heading"><div><h1>Production overview</h1><p>Daily volume, capacity and production status.</p></div><span className="context-label">Daily production · 4 lines</span></div>
    <div className="metrics-grid">
      <Metric label="Planned volume" value={numberLabel(totalMt)} unit="MT" caption={uniqueJobs.length + ' scheduled tasks · ' + board.backlog.length + ' awaiting quantity'} />
      <Metric label="Recorded output" value={actualRecorded.length?numberLabel(actualMt):'—'} unit="MT" caption={actualRecorded.length+' / '+completedFromDate.length+' completed tasks recorded · '+dateLabel(board.date)} />
      <Metric label="Planned utilisation" value={available ? numberLabel(production / available * 100, 0) : '—'} unit="%" caption={numberLabel(production / 60) + ' production hrs / ' + numberLabel(available / 60) + ' available hrs'} />
      <Metric label="Tasks completed" value={String(completed)} unit={'/ ' + String(uniqueJobs.length)} caption="Confirmed with the Done action" />
    </div>
    <section className="panel schedule-panel">
      <SectionHeading title="Daily line schedule" description="Select a product to view its production details." action={<TextLink onClick={() => navigate('planning')}>Open planning board</TextLink>} />
      <div className="timeline-scroll"><div className="overview-timeline">
        <div className="timeline-axis"><span className="axis-label">LINE / PRODUCT</span><div className="axis-ticks">{ticks.map((tick,index) => <span key={tick} style={{left: index / 8 * 100 + '%'}}>{timeLabel(tick)}{index === 8 && span >= 86400000 && <small>+1 day</small>}</span>)}</div><span className="axis-total">PLANNED</span></div>
        {board.lines.map(line => <div className="timeline-row" key={line.lineId}>
          <button className="timeline-line-label" onClick={() => navigate('planning')}><span className="line-id">{line.lineId}</span><small>{numberLabel(line.plannedMt)} MT</small></button>
          <div className="timeline-track">
            {ticks.map(tick => <span className="timeline-gridline" key={tick} style={{left:(tick-board.start)/span*100+'%'}} />)}
            {state.settings.downtime.filter(item => item.lineId === line.lineId || item.lineId === 'all').map(item => {
              const {start,end} = downtimeRange(item,calendar.dayStart);
              const left = Math.max(start, board.start), right = Math.min(end, board.end);
              return right > left && <span key={item.id} className="downtime-block" style={{left:(left-board.start)/span*100+'%',width:(right-left)/span*100+'%'}} title={'Unavailable: ' + item.reason} />;
            })}
            {line.segments.filter(segment => segment.end > board.start && segment.start < board.end).map((segment,index) => {
              const job = line.jobs.find(job => job.id === segment.jobId);
              if(!job) return null;
              const left = Math.max(segment.start, board.start), right = Math.min(segment.end, board.end);
              const width = (right-left)/span*100;
              return <button key={job.id+'-'+index} className={'timeline-segment ' + segment.kind + ' ' + (isJobPaused(job) ? 'paused' : job.status) + (job.issue ? ' issue' : '')} style={{left:(left-board.start)/span*100+'%',width:width+'%', '--product-color':productColor(productLabel(job))} as React.CSSProperties} onClick={() => openJob(job.id,true)} aria-label={(segment.kind==='changeover'?'Changeover / line clean-up before ':'') + line.lineId + ' ' + productLabel(job) + ', ' + numberLabel(job.quantityMt) + ' MT, ' + (job.issue ? 'Issue, ' : '') + (isJobPaused(job) ? 'Paused, ' : STATUS_LABELS[job.status] + ', ') + fullDateTime(segment.start) + ' to ' + fullDateTime(segment.end)} title={(segment.kind === 'changeover' ? 'Changeover / line clean-up before ' : '') + productLabel(job) + (isJobPaused(job) ? ' · Paused' : ' · ' + STATUS_LABELS[job.status]) + (job.issue ? ' · Issue: ' + job.issue.reason : '') + ' · ' + numberLabel(job.quantityMt) + ' MT\n' + fullDateTime(segment.start) + ' → ' + fullDateTime(segment.end)}>
                {segment.kind === 'production' && <><strong>{productLabel(job)}</strong>{width > 13 && <small>{numberLabel(job.quantityMt)} MT</small>}</>}
              </button>;
            })}
          </div>
          <div className="timeline-total"><strong>{line.utilisation === null ? '—' : numberLabel((line.utilisation || 0)*100,0)+'%'}</strong><small>{durationLabel(line.productionMinutes,true)}</small></div>
        </div>)}
        <div className="timeline-date-label"><span>{dateLabel(board.date, true)}</span><span>{timeLabel(board.start)} — {timeLabel(board.end)}{span >= 86400000 ? ' next day' : ''} · MYT</span></div>
      </div></div>
      <div className="schedule-legend"><span><i className="legend-pending" />Not started</span><span><i className="legend-running" />Running</span><span><i className="legend-paused" />Paused</span><span><i className="legend-completed" />Completed</span><span><i className="legend-issue" />Issue</span><span><i className="legend-changeover" />Changeover / line clean-up</span><span><i className="legend-downtime" />Unavailable</span><span className="legend-note">Time scale · {numberLabel(span / 3600000, 0)} hours</span></div>
    </section>
    <LegacyCarryoverNotice/>
    {(overflows.length > 0 || board.backlog.length > 0) && <div className="planning-notice"><AlertTriangle size={17} /><p>{overflows.length > 0 && <><strong>{overflows.map(line => line.lineId).join(', ')}</strong> continues beyond this planning day. </>}{board.backlog.length > 0 && <><strong>{board.backlog.length} tasks</strong> need a quantity before they can be scheduled.</>}</p><button onClick={() => navigate('planning')}>Review<ChevronRight size={15} /></button></div>}
    <div className="overview-analysis"><NeedsAttention/><ProductionResults jobs={state.jobs.filter(job=>job.date===board.date)}/></div>
    <details className="panel capacity-panel" aria-label="Production line summaries">
      <summary className="queue-toggle"><strong>Line capacity details</strong><span>Production, open time & carry-over<ChevronDown size={16}/></span></summary>
        <div className="capacity-scroll"><div className="capacity-ledger">
          <div className="capacity-head" aria-hidden="true"><span>Line / status</span><span>Planned</span><span>Utilisation</span><span>Production / open</span><span>Quantity / carry-over</span><span/></div>
          {board.lines.map(line => <LineSummary key={line.lineId} line={line} backlog={board.backlog.filter(job => job.lineId === line.lineId).length} onOpen={() => navigate('planning')}/>)}</div></div>
    </details>
    <RecordedDowntime/>
    <details className="panel queue-panel"><summary className="queue-toggle"><strong>Next production tasks</strong><span>{queue.length} tasks<ChevronDown size={16}/></span></summary>
      {queue.length ? <div className="table-scroll"><table><thead><tr><th>PRODUCT / ORDER</th><th>LINE</th><th>QUANTITY</th><th>PLANNED TIME</th><th>DESTINATION</th><th>STATUS</th><th /></tr></thead><tbody>{queue.map(job => <tr key={job.id} className="clickable-row" onClick={() => openJob(job.id)}><td><div className="product-cell"><i style={{background:productColor(productLabel(job))}} /><div><strong>{productLabel(job)}</strong><small>{job.orderNo || 'No order reference'}</small></div></div></td><td><span className="line-tag">{job.lineId}</span></td><td className="tabular">{numberLabel(job.quantityMt)} <span className="muted">MT</span></td><td className="tabular">{timeLabel(job.plannedStart)}<span className="time-arrow">→</span>{timeLabel(job.plannedEnd)}{job.overflow && <small className="text-amber"> carry-over</small>}</td><td>{job.bin ? 'Bin ' + job.bin : '—'}{job.binNeedsReview && <span className="review-dot" title="Review destination bin" />}</td><td><StatusBadge status={job.status} issue={!!job.issue} paused={isJobPaused(job)} /></td><td><button className="icon-button" aria-label={'View ' + productLabel(job) + ' details'} onClick={event => {event.stopPropagation();openJob(job.id);}}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <EmptyState title="The queue is clear" text="Add a production task to plan the next run." />}
    </details>
  </div>;
}
function LineSummary({line,backlog,onOpen}:{line:LineSchedule;backlog:number;onOpen:()=>void}) {
  const issueCount=line.jobs.filter(job=>job.issue).length;
  const running=line.jobs.some(job=>job.status==='running');
  const paused=line.jobs.some(isJobPaused);
  const complete=line.jobs.length>0&&line.jobs.every(job=>job.status==='completed');
  const status=issueCount?'issue':paused?'paused':running?'running':complete?'completed':'pending';
  const statusLabel=issueCount?`${issueCount} issue${issueCount===1?'':'s'}`:paused?'Paused':running?'Running':complete?'Completed':line.jobs.length?'Scheduled':'No schedule';
  const openMinutes=Math.max(0,line.availableMinutes-line.productionMinutes-line.changeoverMinutes);
  const utilisation=line.utilisation===null?'—':numberLabel(line.utilisation*100,0)+'%';
  const summary=`${statusLabel}. ${numberLabel(line.plannedMt)} MT, ${line.jobs.length} tasks. Planned utilisation ${utilisation}. ${durationLabel(line.productionMinutes,true)} production, ${durationLabel(openMinutes,true)} open. ${backlog} awaiting quantity. ${durationLabel(line.overflowMinutes,true)} carry-over.`;
  return <button type="button" className={'line-summary '+status} onClick={onOpen} aria-label={`View ${line.lineId} planning`} aria-description={summary}>
    <span className="capacity-line"><strong className="line-id">{line.lineId}</strong><span className={'tiny-status '+status}>{statusLabel}</span></span>
    <span className="capacity-volume"><strong>{numberLabel(line.plannedMt)} <small>MT</small></strong><span>{line.jobs.length} tasks</span></span>
    <span className="capacity-utilisation"><strong>{utilisation}</strong><span className="utilisation-track" aria-hidden="true"><i style={{width:Math.min(100,Math.max(0,(line.utilisation??0)*100))+'%'}}/></span></span>
    <span className="capacity-time"><span>{durationLabel(line.productionMinutes,true)} production</span><small>{durationLabel(openMinutes,true)} open</small></span>
    <span className="capacity-note"><span>{backlog?`${backlog} awaiting quantity`:'Quantity confirmed'}</span>{line.overflowMinutes>0&&<strong>+{durationLabel(line.overflowMinutes,true)} carry-over</strong>}</span>
    <ArrowUpRight size={15}/>
  </button>;
}
function Metric({label,value,unit,caption}:{label:string;value:string;unit:string;caption:string}) {
  return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value">{value}<small>{unit}</small></div><p>{caption}</p></div>;
}
