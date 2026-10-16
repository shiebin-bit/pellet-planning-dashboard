import { getBoard,getRate } from './engine';
import { LINE_IDS } from './types';
import type { AppState,LineId,LineSchedule,ScheduledJob } from './types';

export const MAX_REPORT_DAYS=31;
export interface ReportSelection {from:string;to:string;lineId:LineId|'all'}
export interface ProductionReport {
  selection:ReportSelection;
  days:{date:string;lines:LineSchedule[]}[];
  jobs:ScheduledJob[];
  plannedMt:number;
  actualMt:number;
  completedCount:number;
  recordedCount:number;
}

function dateValue(value:string):number {
  const timestamp=Date.parse(value+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==value)throw new Error('Choose a valid report date.');
  return timestamp;
}
export function reportDates(from:string,to:string):string[] {
  const start=dateValue(from),end=dateValue(to);
  if(end<start)throw new Error('The report end date must be on or after the start date.');
  const count=Math.round((end-start)/86_400_000)+1;
  if(count>MAX_REPORT_DAYS)throw new Error(`Choose up to ${MAX_REPORT_DAYS} days per report.`);
  return Array.from({length:count},(_,index)=>new Date(start+index*86_400_000).toISOString().slice(0,10));
}
export function reportWeek(date:string):{from:string;to:string} {
  const timestamp=dateValue(date);
  const monday=timestamp-((new Date(timestamp).getUTCDay()+6)%7)*86_400_000;
  return {from:new Date(monday).toISOString().slice(0,10),to:new Date(monday+6*86_400_000).toISOString().slice(0,10)};
}
export function buildProductionReport(state:AppState,selection:ReportSelection):ProductionReport {
  if(selection.lineId!=='all'&&!LINE_IDS.includes(selection.lineId))throw new Error('Choose a valid production line.');
  const dates=reportDates(selection.from,selection.to);
  const source=state.jobs.filter(job=>job.date>=selection.from&&job.date<=selection.to&&(selection.lineId==='all'||job.lineId===selection.lineId));
  const byId=new Map<string,ScheduledJob>();
  const days=dates.map(date=>{
    const board=getBoard(state,date);
    const lines=board.lines.filter(line=>selection.lineId==='all'||line.lineId===selection.lineId);
    for(const line of lines)for(const job of line.jobs)if(job.date===date)byId.set(job.id,job);
    return {date,lines};
  });
  const jobs=source.map(job=>byId.get(job.id)??{
    ...job,plannedStart:null,plannedEnd:null,durationMinutes:0,rate:getRate(state.settings,job.lineId,job.productCode),changeoverMinutes:0,segments:[],overflow:false,
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.lineId.localeCompare(b.lineId)||a.sequence-b.sequence);
  const completed=jobs.filter(job=>job.status==='completed');
  const recorded=completed.filter(job=>typeof job.actualQuantityMt==='number'&&Number.isFinite(job.actualQuantityMt)&&job.actualQuantityMt>=0);
  return {selection:{...selection},days,jobs,plannedMt:jobs.filter(job=>job.status!=='cancelled').reduce((sum,job)=>sum+job.quantityMt,0),actualMt:recorded.reduce((sum,job)=>sum+job.actualQuantityMt!,0),completedCount:completed.length,recordedCount:recorded.length};
}
