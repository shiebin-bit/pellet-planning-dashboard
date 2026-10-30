import { ArrowUpRight, Plus } from 'lucide-react';
import type { Downtime, LineId, LineSchedule } from '../domain/types';
import { getJobSourceAllocations } from '../domain/jobSources';
import { isJobPaused } from '../domain/production-results';
import { dateLabel, downtimeRange, durationLabel, fullDateTime, numberLabel, timeLabel, toDateTimeInput } from '../lib/format';
import { packagingLabel, productLabel } from '../lib/productLabel';
import { StatusBadge } from './Shared';
import './ProductionList.css';

export function ProductionList({lines,start,end,date,downtime,dayStart,bagWeightKg,selectedId,disabled,onOpen,onAdd}: {
  lines: LineSchedule[]; start: number; end: number; date: string; downtime: Downtime[]; dayStart: string;
  bagWeightKg: number; selectedId: string|null; disabled: boolean;
  onOpen: (id: string)=>void; onAdd: (lineId: LineId)=>void;
}) {
  return <section className="production-list" aria-label="Production by line">
    <p className="production-list-context">{dateLabel(date,true)} · {fullDateTime(start)}–{fullDateTime(end)} MYT</p>
    {lines.map(line=>{
      const jobs=line.jobs.filter(job=>job.segments.some(segment=>segment.kind==='production'&&segment.end>start&&segment.start<end));
      const unavailable=downtime.filter(item=>item.lineId===line.lineId||item.lineId==='all').filter(item=>{const interval=downtimeRange(item,dayStart);return interval.start<end&&interval.end>start;});
      return <section key={line.lineId} className="production-list-line" aria-labelledby={`production-list-${line.lineId}`}>
        <header><div><h2 id={`production-list-${line.lineId}`}>{line.lineId}</h2><p>{numberLabel(line.plannedMt)} MT · {line.utilisation===null?'Utilisation unavailable':`${numberLabel(line.utilisation*100,0)}% planned`}</p></div><button type="button" className="button secondary" disabled={disabled} aria-label={`Add production to ${line.lineId}`} onClick={()=>onAdd(line.lineId)}><Plus size={17}/>Add</button></header>
        {unavailable.map(item=>{const interval=downtimeRange(item,dayStart);return <p className="production-list-unavailable" key={item.id}>Unavailable · {fullDateTime(Math.max(start,interval.start))}–{fullDateTime(Math.min(end,interval.end))} · {item.reason}</p>;})}
        {jobs.length?<ol>{jobs.map(job=>{
          const allocations=getJobSourceAllocations(job),paused=isJobPaused(job);
          const state=job.issue?'issue':paused?'paused':job.status;
          const crossDay=toDateTimeInput(job.plannedStart).slice(0,10)!==date||toDateTimeInput(job.plannedEnd).slice(0,10)!==date;
          const labelTime=crossDay?fullDateTime:timeLabel;
          return <li key={job.id} data-job-id={job.id} className={`production-list-card ${state}${selectedId===job.id?' selected':''}`}>
            <button type="button" className="production-list-open" onClick={()=>onOpen(job.id)}>
              <span className="sr-only">Open production details on {line.lineId}. </span>
              <span className="production-list-product"><strong>{productLabel(job)}</strong><span>{packagingLabel({unit:job.mode==='bags'?'Bags':'MT',bagWeightKg:job.bagWeightKgSnapshot??(job.mode==='bags'?bagWeightKg:null),description:job.description})}</span></span>
              <StatusBadge status={job.status} issue={!!job.issue} paused={paused}/>
              <span className="production-list-quantity"><strong>{job.mode==='bags'?`${numberLabel(job.bagCount??0,0)} Bags`:`${numberLabel(job.quantityMt,3)} MT`}</strong>{job.mode==='bags'&&<span>{numberLabel(job.quantityMt,3)} MT</span>}</span>
              <span className="production-list-time">{labelTime(job.plannedStart)}–{labelTime(job.plannedEnd)}</span>
              <span className="production-list-reference">{allocations.length?`${allocations.length} ${allocations.length===1?'order':'orders'}`:job.orderNo||(job.productionPurpose==='mts'?'Make for stock':'No order reference')}{job.changeoverMinutes>0&&<span> · Changeover {durationLabel(job.changeoverMinutes)}</span>}</span>
              <ArrowUpRight className="production-list-arrow" size={16}/>
            </button>
          </li>;
        })}</ol>:<p className="production-list-empty">No production in this range.</p>}
      </section>;
    })}
  </section>;
}
