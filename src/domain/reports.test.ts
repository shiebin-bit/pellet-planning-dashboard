import { describe,expect,it } from 'vitest';
import { buildProductionReport,reportDates,reportWeek } from './reports';
import { createSampleState } from './sample';

describe('report selections',()=>{
  it('validates actual calendar dates, order and report length',()=>{
    expect(reportDates('2026-10-01','2026-10-31')).toHaveLength(31);
    expect(reportDates('2026-12-31','2027-01-01')).toEqual(['2026-12-31','2027-01-01']);
    for(const [from,to] of [['2026-02-30','2026-03-01'],['','2026-10-01'],['2026-10-16','2026-10-15'],['2026-10-01','2026-11-01']])expect(()=>reportDates(from,to)).toThrow();
    expect(reportWeek('2027-01-01')).toEqual({from:'2026-12-28',to:'2027-01-03'});
    expect(reportWeek('2026-10-18')).toEqual({from:'2026-10-12',to:'2026-10-18'});
  });
  it('selects by planning date and line while keeping backlog, cancelled and unknown actual records',()=>{
    const state=createSampleState('2026-10-15');
    const original=JSON.stringify(state);
    const report=buildProductionReport(state,{from:'2026-10-15',to:'2026-10-16',lineId:'PM1'});
    const expected=state.jobs.filter(job=>job.lineId==='PM1'&&job.date==='2026-10-15');
    expect(report.jobs.map(job=>job.id).sort()).toEqual(expected.map(job=>job.id).sort());
    expect(report.days).toHaveLength(2);
    expect(report.days.every(day=>day.lines.length===1&&day.lines[0].lineId==='PM1')).toBe(true);
    expect(new Set(report.jobs.map(job=>job.id)).size).toBe(report.jobs.length);
    expect(JSON.stringify(state)).toBe(original);
    const cancelled={...state.jobs[0],id:'cancelled-report',status:'cancelled' as const,quantityMt:9999};
    state.jobs.push(cancelled);
    const baseline=buildProductionReport(state,{from:'2026-10-15',to:'2026-10-15',lineId:'all'});
    expect(baseline.jobs.some(job=>job.id===cancelled.id)).toBe(true);
    expect(baseline.plannedMt).toBeCloseTo(state.jobs.filter(job=>job.status!=='cancelled').reduce((sum,job)=>sum+job.quantityMt,0));
    const legacy=state.jobs.find(job=>job.status==='completed')!;
    legacy.actualQuantityMt=undefined;
    const zero=state.jobs.find(job=>job.status==='completed'&&job.id!==legacy.id)!;zero.actualQuantityMt=0;
    const after=buildProductionReport(state,{from:'2026-10-15',to:'2026-10-15',lineId:'all'});
    expect(after.recordedCount).toBe(after.completedCount-1);
    expect(after.jobs.find(job=>job.id===zero.id)?.actualQuantityMt).toBe(0);
  });
  it('never adds previous-date carry-over as a second production record',()=>{
    const state=createSampleState('2026-10-15');
    const report=buildProductionReport(state,{from:'2026-10-16',to:'2026-10-16',lineId:'all'});
    expect(report.jobs).toEqual([]);
    expect(report.days[0].lines.some(line=>line.jobs.length>0)).toBe(true);
    expect(report.plannedMt).toBe(0);
    expect(()=>buildProductionReport(state,{from:'2026-10-15',to:'2026-10-15',lineId:'PM5' as 'PM1'})).toThrow();
  });
});
