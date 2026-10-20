import { ArrowUpRight, ChevronRight, ChevronDown, Layers3, Activity, AlertTriangle, CheckCheck, Clock3 } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { dateLabel, downtimeRange, durationLabel, fullDateTime, numberLabel, productColor, timeLabel } from '../lib/format';
import type { LineSchedule } from '../domain/types';
import { SectionHeading, StatusBadge, EmptyState, TextLink } from '../components/Shared';
import { NeedsAttention,ProductionResults } from '../components/OperationsSummary';
import { RecordedDowntime } from '../components/RecordedDowntime';
import { isJobPaused } from '../domain/production-results';

export function Overview() {
  const { board, state, navigate, openJob } = useWorkspace();
  const totalMt = board.lines.reduce((sum, line) => sum + line.plannedMt, 0);
  const available = board.lines.reduce((sum, line) => sum + line.availableMinutes, 0);
  const production = board.lines.reduce((sum, line) => sum + line.productionMinutes, 0);
  const jobs = board.lines.flatMap(line => line.jobs).filter(job => job.status !== 'cancelled');
  const uniqueJobs = [...new Map(jobs.map(job => [job.id, job])).values()];
  const completed = uniqueJobs.filter(job => job.status === 'completed').length;
  const overflows = board.lines.filter(line => line.overflowMinutes > 0);
  const queue = uniqueJobs.filter(job => job.status === 'pending' || job.status === 'running').sort((a,b) => (a.plannedStart || Infinity) - (b.plannedStart || Infinity)).slice(0, 6);
  const span = board.end - board.start;
  const ticks = Array.from({length: 9}, (_, index) => board.start + span * index / 8);
  return <div className="page overview-page">
    <div className="page-heading"><div><h1>Production overview<span className="heading-dot">.</span></h1><p>Daily volume, capacity and production status.</p></div><span className="outline-badge"><span className="live-dot" />Manual planning</span></div>
    <div className="metrics-grid">
      <Metric icon={<Layers3 size={18} />} label="PLANNED VOLUME" value={numberLabel(totalMt)} unit="MT" caption={uniqueJobs.length + ' scheduled tasks · ' + board.backlog.length + ' awaiting quantity'} />
      <Metric icon={<Activity size={18} />} label="PLANNED UTILISATION" value={available ? numberLabel(production / available * 100, 0) : '—'} unit="%" caption={numberLabel(production / 60) + ' production hrs / ' + numberLabel(available / 60) + ' available hrs'} accent />
      <Metric icon={<Clock3 size={18} />} label="PRODUCTION LOAD" value={numberLabel(production / 60)} unit="hrs" caption={numberLabel(available / 60) + ' available line hours today'} />
      <Metric icon={<CheckCheck size={18} />} label="TASKS COMPLETED" value={String(completed).padStart(2, '0')} unit={'/ ' + String(uniqueJobs.length).padStart(2,'0')} caption="Confirmed with the Done action" />
    </div>
    <div className="line-summary-grid" aria-label="Production line summaries">{board.lines.map(line => <LineSummary key={line.lineId} line={line} backlog={board.backlog.filter(job => job.lineId === line.lineId).length} onOpen={() => navigate('planning')}/>)}</div>
    <div className="operations-grid"><NeedsAttention/><ProductionResults jobs={state.jobs.filter(job=>job.date===board.date)}/></div>
    <RecordedDowntime/>
    <section className="panel schedule-panel">
      <SectionHeading title="Four lines at a glance" description="Select any task for details. Colours show production status." action={<TextLink onClick={() => navigate('planning')}>Open planning board</TextLink>} />
      <div className="timeline-scroll"><div className="overview-timeline">
        <div className="timeline-axis"><span className="axis-label">LINE / PRODUCT</span><div className="axis-ticks">{ticks.map((tick,index) => <span key={tick} style={{left: index / 8 * 100 + '%'}}>{timeLabel(tick)}{index === 8 && <small>+1 day</small>}</span>)}</div><span className="axis-total">PLANNED</span></div>
        {board.lines.map(line => <div className="timeline-row" key={line.lineId}>
          <button className="timeline-line-label" onClick={() => navigate('planning')}><span className="line-id">{line.lineId}</span><small>{numberLabel(line.plannedMt)} MT</small></button>
          <div className="timeline-track">
            {ticks.map(tick => <span className="timeline-gridline" key={tick} style={{left:(tick-board.start)/span*100+'%'}} />)}
            <span className="downtime-block regular-off-hours" style={{left:state.settings.availableHours/24*100+'%',width:(24-state.settings.availableHours)/24*100+'%'}} title="Outside daily available hours" />
            {state.settings.downtime.filter(item => item.lineId === line.lineId || item.lineId === 'all').map(item => {
              const {start,end} = downtimeRange(item,state.settings.dayStart);
              const left = Math.max(start, board.start), right = Math.min(end, board.end);
              return right > left && <span key={item.id} className="downtime-block" style={{left:(left-board.start)/span*100+'%',width:(right-left)/span*100+'%'}} title={'Unavailable: ' + item.reason} />;
            })}
            {line.segments.filter(segment => segment.end > board.start && segment.start < board.end).map((segment,index) => {
              const job = line.jobs.find(job => job.id === segment.jobId);
              if(!job) return null;
              const left = Math.max(segment.start, board.start), right = Math.min(segment.end, board.end);
              const width = (right-left)/span*100;
              return <button key={job.id+'-'+index} className={'timeline-segment ' + segment.kind + ' ' + (isJobPaused(job) ? 'paused' : job.status) + (job.issue ? ' issue' : '')} style={{left:(left-board.start)/span*100+'%',width:width+'%', '--product-color':productColor(job.productCode)} as React.CSSProperties} onClick={() => openJob(job.id,true)} aria-label={(segment.kind==='changeover'?'Changeover / line clean-up before ':'') + line.lineId + ' ' + job.productCode + ', ' + numberLabel(job.quantityMt) + ' MT, ' + (job.issue ? 'Issue, ' : '') + (isJobPaused(job) ? 'Paused, ' : '') + fullDateTime(segment.start) + ' to ' + fullDateTime(segment.end)} title={(segment.kind === 'changeover' ? 'Changeover / line clean-up before ' : '') + job.productCode + (isJobPaused(job) ? ' · Paused' : '') + (job.issue ? ' · Issue: ' + job.issue.reason : '') + ' · ' + numberLabel(job.quantityMt) + ' MT\n' + fullDateTime(segment.start) + ' → ' + fullDateTime(segment.end)}>
                {segment.kind === 'production' && <><strong>{width<5?job.productCode.slice(0,4):job.productCode}</strong>{width > 13 && <small>{numberLabel(job.quantityMt)} MT</small>}</>}
              </button>;
            })}
          </div>
          <div className="timeline-total"><strong>{line.utilisation === null ? '—' : numberLabel((line.utilisation || 0)*100,0)+'%'}</strong><small>{durationLabel(line.productionMinutes,true)}</small></div>
        </div>)}
        <div className="timeline-date-label"><span>{dateLabel(board.date, true)}</span><span>{timeLabel(board.start)} — {timeLabel(board.end)} next day · MYT</span></div>
      </div></div>
      <div className="schedule-legend"><span><i className="legend-pending" />Not started</span><span><i className="legend-running" />Running</span><span><i className="legend-paused" />Paused</span><span><i className="legend-completed" />Completed</span><span><i className="legend-issue" />Issue</span><span><i className="legend-changeover" />Changeover / line clean-up</span><span><i className="legend-downtime" />Unavailable</span><span className="legend-note">Time scale · 24 hours</span></div>
    </section>
    {(overflows.length > 0 || board.backlog.length > 0) && <div className="planning-notice"><AlertTriangle size={17} /><p>{overflows.length > 0 && <><strong>{overflows.map(line => line.lineId).join(', ')}</strong> continues beyond this planning day. </>}{board.backlog.length > 0 && <><strong>{board.backlog.length} tasks</strong> need a quantity before they can be scheduled.</>}</p><button onClick={() => navigate('planning')}>Review<ChevronRight size={15} /></button></div>}
    <details className="panel queue-panel" open><summary className="queue-toggle"><strong>Next production tasks</strong><span>{queue.length} tasks<ChevronDown size={16}/></span></summary>
      {queue.length ? <div className="table-scroll"><table><thead><tr><th>PRODUCT / ORDER</th><th>LINE</th><th>QUANTITY</th><th>PLANNED TIME</th><th>DESTINATION</th><th>STATUS</th><th /></tr></thead><tbody>{queue.map(job => <tr key={job.id} className="clickable-row" onClick={() => openJob(job.id)}><td><div className="product-cell"><i style={{background:productColor(job.productCode)}} /><div><strong>{job.productCode}</strong><small>{job.orderNo || 'No order reference'}</small></div></div></td><td><span className="line-tag">{job.lineId}</span></td><td className="tabular">{numberLabel(job.quantityMt)} <span className="muted">MT</span></td><td className="tabular">{timeLabel(job.plannedStart)}<span className="time-arrow">→</span>{timeLabel(job.plannedEnd)}{job.overflow && <small className="text-amber"> +1d</small>}</td><td>{job.bin ? 'Bin ' + job.bin : '—'}{job.binNeedsReview && <span className="review-dot" title="Review destination bin" />}</td><td><StatusBadge status={job.status} issue={!!job.issue} paused={isJobPaused(job)} /></td><td><button className="icon-button" aria-label={'View ' + job.productCode + ' details'} onClick={event => {event.stopPropagation();openJob(job.id);}}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <EmptyState title="The queue is clear" text="Add a production task to plan the next run." />}
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
    <div className="line-summary-top"><strong className="line-id">{line.lineId}</strong><span className={'tiny-status '+status}><span/>{statusLabel}</span><ArrowUpRight size={15}/></div>
    <p className="line-caption">Pellet mill {line.lineId.slice(2).padStart(2,'0')}</p>
    <div className="line-volume">{numberLabel(line.plannedMt)}<small>MT</small><span>{line.jobs.length} tasks</span></div>
    <div className="utilisation-label"><span>Planned utilisation</span><strong>{utilisation}</strong></div>
    <div className="utilisation-track" aria-hidden="true"><i style={{width:Math.min(100,Math.max(0,(line.utilisation??0)*100))+'%'}}/></div>
    <div className="line-summary-bottom"><span>{durationLabel(line.productionMinutes,true)} production</span><span>{durationLabel(openMinutes,true)} open</span></div>
    <div className="line-summary-note"><span>{backlog?`${backlog} awaiting quantity`:'Quantity confirmed'}</span>{line.overflowMinutes>0&&<strong>+{durationLabel(line.overflowMinutes,true)} carry-over</strong>}</div>
  </button>;
}
function Metric({icon,label,value,unit,caption,accent=false}:{icon:React.ReactNode;label:string;value:string;unit:string;caption:string;accent?:boolean}) {
  return <div className={'metric '+(accent?'metric-accent':'')}><div className="metric-label">{label}<span>{icon}</span></div><div className="metric-value">{value}<small>{unit}</small></div><p>{caption}</p></div>;
}
