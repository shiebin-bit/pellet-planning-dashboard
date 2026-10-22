import { useWorkspace } from '../lib/workspace';
import { getDowntimeMinutesForWindow, getProductionResult } from '../domain/production-results';
import type { Job, ScheduledJob } from '../domain/types';
import type { ProductionReport } from '../domain/reports';
import { dateLabel, durationLabel, fullDateTime, numberLabel, outputVarianceLabel, timeLabel, jobStatusLabel, stopDurationLabel } from '../lib/format';
export function PrintReport({report}:{report?:ProductionReport|null}){
  const {state,board}=useWorkspace();
  const asOf=Date.now();
  if(report)return <RangePrintReport report={report} siteName={state.settings.siteName}/>;
  return <div className="print-report">
    <div className="print-header"><div><strong>millplan.</strong><h1>Daily production planning</h1><p>{state.settings.siteName} · {dateLabel(board.date)} · MYT (UTC+8)</p></div><span>PLANNING REPORT<br/>{timeLabel(board.start)} — {timeLabel(board.end)}{board.end-board.start>=86400000?' next day':''}</span></div>
    <div className="print-summary">{board.lines.map(line=><div key={line.lineId}><strong>{line.lineId}</strong><span>{numberLabel(line.plannedMt)} MT planned</span><span>{line.utilisation===null?'—':numberLabel(line.utilisation*100,0)+'%'} planned utilisation</span><small>{durationLabel(line.productionMinutes)} production / {durationLabel(line.availableMinutes)} available</small><small>{stopDurationLabel(getDowntimeMinutesForWindow(state.jobs,board.start,board.end,asOf,line.lineId))} recorded downtime in this planning day</small></div>)}</div>
    {board.lines.map(line=><section className="print-line" key={line.lineId}>
      <h2>{line.lineId}<span>{line.jobs.length} tasks · {numberLabel(line.plannedMt)} MT planned</span></h2>
      <table><thead><tr><th>Order / product</th><th>Destination</th><th>Planned / actual output</th><th>Planned start → end</th><th>Actual start / end</th><th>Status / remarks</th></tr></thead><tbody>{line.jobs.map(job=><ReportRow key={job.id} job={job}/>)}</tbody></table>
      {line.jobs.length===0&&<p>No production scheduled.</p>}
    </section>)}
    <DailyStops jobs={state.jobs} start={board.start} end={board.end} asOf={asOf}/>
    {board.backlog.length>0&&<section className="print-backlog"><h2>Awaiting quantity</h2><p>{board.backlog.map(job=>job.lineId+' · '+job.productCode+' '+job.orderNo+(job.issue?' · Issue: '+job.issue.reason:'')).join(' | ')}</p></section>}
    <footer>Task rows show whole-task actual times and recorded stops. Daily downtime totals and the stop list are clipped to this planning day, including tasks assigned to other dates. Planned utilisation excludes changeover and is not OEE. Actual end is recorded when completion is confirmed. Elapsed minus recorded stops is not observed productive time. Unrecorded actual output is left unknown.</footer>
  </div>;
}

function RangePrintReport({report,siteName}:{report:ProductionReport;siteName:string}) {
  const lines=report.days.flatMap(day=>day.lines);
  const production=lines.reduce((sum,line)=>sum+line.productionMinutes,0),available=lines.reduce((sum,line)=>sum+line.availableMinutes,0);
  return <div className="print-report range-print-report">
    <div className="print-header"><div><strong>millplan.</strong><h1>Production planning report</h1><p>{siteName} · {dateLabel(report.selection.from,true)} – {dateLabel(report.selection.to,true)} · {report.selection.lineId==='all'?'All four lines':report.selection.lineId} · MYT (UTC+8)</p></div><span>{report.jobs.length} PRODUCTION RECORDS<br/>Selected by planning date</span></div>
    <div className="print-summary"><div><strong>{numberLabel(report.plannedMt,2)} MT</strong><span>Planned quantity</span><small>Cancelled quantities excluded</small></div><div><strong>{report.recordedCount?numberLabel(report.actualMt,2)+' MT':'Not recorded'}</strong><span>Actual output recorded</span><small>{report.recordedCount} / {report.completedCount} completed tasks recorded</small></div><div><strong>{available?numberLabel(production/available*100,0)+'%':'—'}</strong><span>Planned utilisation</span><small>{durationLabel(production)} / {durationLabel(available)} available</small></div><div><strong>{report.jobs.length} records</strong><span>{report.selection.lineId==='all'?'All four lines':report.selection.lineId}</span><small>Carry-over records listed once</small></div></div>
    {report.days.map(day=>day.lines.map(line=>{
      const jobs=report.jobs.filter(job=>job.date===day.date&&job.lineId===line.lineId);
      if(!jobs.length)return null;
      return <section className="print-line" key={day.date+line.lineId}><h2>{dateLabel(day.date,true)} · {line.lineId}<span>{jobs.length} records · {numberLabel(line.plannedMt,2)} MT planned</span></h2><table><thead><tr><th>Order / product</th><th>Destination</th><th>Planned / actual output</th><th>Planned start → end</th><th>Actual start / end</th><th>Status / remarks</th></tr></thead><tbody>{jobs.map(job=><ReportRow key={job.id} job={job}/>)}</tbody></table></section>;
    }))}
    <footer>Records follow their assigned planning date; carry-over is not repeated. Cancelled records remain visible and are excluded from planned quantity totals. Planned utilisation measures production within selected daily windows, including carry-over; it is not OEE. Actual elapsed time includes stops; only recorded pauses are deducted from net elapsed time. Unknown actual output remains unrecorded.</footer>
  </div>;
}

function ReportRow({job}:{job:ScheduledJob}) {
  const result=getProductionResult(job);
  return <tr>
    <td><strong>{job.productCode}</strong><br/>{job.orderNo}</td>
    <td>{job.bin||'—'}{job.binNeedsReview?' · Review':''}</td>
    <td>{numberLabel(job.quantityMt,2)} MT planned<br/>{job.mode==='bags'?numberLabel(job.bagCount||0,0)+' bags':'Bulk'}{job.status==='completed'&&<><br/><strong>{result.actualQuantityMt===null?'Actual not recorded':`${numberLabel(result.actualQuantityMt,2)} MT actual`}</strong>{result.varianceMt!==null&&<><br/>{outputVarianceLabel(result.varianceMt)}</>}</>}</td>
    <td>{fullDateTime(job.plannedStart)}<br/>→ {fullDateTime(job.plannedEnd)}<br/>{durationLabel(job.durationMinutes)} production</td>
    <td>{fullDateTime(job.actualStart)}<br/>{fullDateTime(job.actualEnd)}{result.elapsedMinutes!==null&&<><br/>{durationLabel(result.elapsedMinutes)} whole-task elapsed (incl. stops)<br/>{stopDurationLabel(result.downtimeMinutes)} recorded stops (whole task)<br/>{stopDurationLabel(result.netProductionMinutes!)} elapsed minus stops</>}</td>
    <td>{job.quantityMt===0&&job.status==='pending'&&!job.issue?'Awaiting quantity':jobStatusLabel(job)}{job.issue&&<><br/>Issue: {job.issue.reason}</>}{job.pauseIntervals?.map((pause,index)=><span key={index}><br/>Pause: {pause.reason} ({fullDateTime(pause.pausedAt)} → {pause.resumedAt?fullDateTime(pause.resumedAt):'Ongoing'})</span>)}{job.remarks&&<><br/>{job.remarks}</>}{job.completionNote&&<><br/>Completion: {job.completionNote}</>}</td>
  </tr>;
}

function DailyStops({jobs,start,end,asOf}:{jobs:readonly Job[];start:number;end:number;asOf:number}) {
  const rows=jobs.flatMap(job=>(job.pauseIntervals??[]).map((pause,index)=>({job,pause,index,minutes:Math.max(0,Math.min(end,pause.resumedAt?Date.parse(pause.resumedAt):asOf)-Math.max(start,Date.parse(pause.pausedAt)))/60_000}))).filter(row=>row.minutes>0);
  if(!rows.length)return null;
  return <section className="print-line daily-stops"><h2>Recorded downtime inside this planning day<span>Includes tasks assigned to earlier dates</span></h2><table><thead><tr><th>Line / product</th><th>Planning date / order</th><th>Pause start (MYT)</th><th>Resumed / completed (MYT)</th><th>Minutes in this day</th><th>Reason</th></tr></thead><tbody>{rows.map(({job,pause,index,minutes})=><tr key={job.id+'-'+index}><td>{job.lineId} · {job.productCode}</td><td>{job.date}<br/>{job.orderNo}</td><td>{fullDateTime(pause.pausedAt)}</td><td>{pause.resumedAt?fullDateTime(pause.resumedAt):'Ongoing'}</td><td>{numberLabel(minutes,2)}</td><td>{pause.reason}</td></tr>)}</tbody></table></section>;
}
