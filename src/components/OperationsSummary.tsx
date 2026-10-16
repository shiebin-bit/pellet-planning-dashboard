import { useEffect,useState } from 'react';
import { AlertTriangle,ArrowUpRight,CheckCircle2,ChevronDown } from 'lucide-react';
import type { Job } from '../domain/types';
import { getAttentionItems } from '../domain/attention';
import type { AttentionKind } from '../domain/attention';
import { getProductionResult } from '../domain/production-results';
import { useWorkspace } from '../lib/workspace';
import { fullDateTime,numberLabel,outputVarianceLabel as varianceText } from '../lib/format';
import './OperationsSummary.css';

const REASONS:Record<AttentionKind,string>={issue:'Issue',quantity:'Awaiting quantity',bin:'Review bin',completion:'Check completion'};

export function NeedsAttention() {
  const {board,openJob}=useWorkspace();
  const [now,setNow]=useState(Date.now);
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30_000);return()=>clearInterval(timer);},[]);
  useEffect(()=>setExpanded(false),[board.date]);
  const items=getAttentionItems(board,now);
  const visible=expanded?items:items.slice(0,3);
  return <section className="panel attention-panel" aria-labelledby="attention-title">
    <div className="operations-heading"><div><h2 id="attention-title">{items.length?<AlertTriangle size={17}/>:<CheckCircle2 size={17}/>}Needs attention<span className="count-tag">{items.length} tasks</span></h2><p>Quantity, bin and issue checks for this plan. Time checks refresh automatically.</p></div></div>
    {items.length?<><div className="attention-list">{visible.map(({job,kinds,plannedEnd})=><button type="button" className="attention-item" key={job.id} data-attention-job={job.id} onClick={()=>openJob(job.id)} aria-label={`Review ${job.productCode} on ${job.lineId}: ${kinds.map(kind=>REASONS[kind]).join(', ')}`}>
      <span className="attention-product"><strong>{job.productCode}</strong><small>{job.lineId} · {job.orderNo||'No order reference'}</small></span>
      <span className="attention-reasons">{kinds.map(kind=><span key={kind} className={'attention-reason '+kind}>{REASONS[kind]}</span>)}{job.issue?<small>{job.issue.reason}</small>:kinds.includes('completion')&&<small>Expected end {fullDateTime(plannedEnd)} · completion not recorded</small>}</span><ArrowUpRight size={16}/>
    </button>)}</div>{items.length>3&&<button type="button" className="attention-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show fewer':`View all ${items.length} tasks`}<ChevronDown size={14}/></button>}</>:<p className="attention-clear"><CheckCircle2 size={18}/>No tasks need attention for this plan.</p>}
  </section>;
}

export function ProductionResults({jobs}:{jobs:Job[]}) {
  const completed=jobs.filter(job=>job.status==='completed');
  const recorded=completed.map(job=>({job,result:getProductionResult(job)})).filter(item=>item.result.actualQuantityMt!==null);
  const planned=recorded.reduce((sum,item)=>sum+item.job.quantityMt,0);
  const actual=recorded.reduce((sum,item)=>sum+item.result.actualQuantityMt!,0);
  const variance=actual-planned;
  return <section className="panel results-panel" aria-labelledby="results-title">
    <div className="operations-heading"><div><h2 id="results-title">Plan vs actual</h2><p>Completed tasks from this planning date.</p></div><span className="results-coverage">{recorded.length} / {completed.length} recorded</span></div>
    {recorded.length?<><div className="results-values"><div><span>Planned target</span><strong>{numberLabel(planned,2)}<small>MT</small></strong></div><div><span>Actual recorded</span><strong>{numberLabel(actual,2)}<small>MT</small></strong></div></div><p className={'results-variance '+(variance<0?'shortfall':'')}>{varianceText(variance)}</p><p className="results-note">Compares the {recorded.length} completed {recorded.length===1?'task':'tasks'} with actual output recorded.{recorded.length<completed.length?` ${completed.length-recorded.length} completed tasks still need actual output.`:''}</p></>:<p className="results-empty">{completed.length?`Actual output has not been recorded for these ${completed.length} completed tasks. Open a completed card to add it.`:'Complete a production task to compare planned and actual output.'}</p>}
  </section>;
}
