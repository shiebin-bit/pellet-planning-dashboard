import { describe, expect, it } from 'vitest';
import { validateWorkspaceBackup } from './backup';
import { parseCommand } from './commands';
import { createEmptyState } from './defaults';
import {
  createJob,
  getAvailableIntervals,
  getBoard,
  getScheduledJobs,
  getWorkingHoursForDate,
  replaceWorkingHoursOverrides,
  updateSettings,
} from './engine';
import { planInventoryDraft } from './inventoryPlanner';
import type { AppState, Job } from './types';
import type { InventoryPlanningDemandRow } from './inventoryTypes';

const DATE = '2026-11-04';
const NEXT = '2026-11-05';
const NOW = '2026-11-03T02:00:00.000Z'; // 10:00 MYT
const local = (date:string,time:string)=>Date.parse(`${date}T${time}:00+08:00`);

function bulkJob(state:AppState,quantityMt:number,lineId:'PM1'|'PM2'|'PM3'|'PM4'='PM1'):AppState {
  return createJob(state,{
    date:DATE,lineId,orderNo:'DO-1',productCode:'5220',description:'Feed',bin:'',mode:'bulk',bagCount:null,
    quantityMt,remarks:'',notBefore:new Date(local(DATE,'07:00')).toISOString(),
  });
}

function legacyRunningJob():Job {
  return {
    id:'running',date:DATE,lineId:'PM2',sequence:1,orderNo:'RUN',productCode:'5220',description:'Feed',bin:'',
    mode:'bulk',bagCount:null,quantityMt:7.5,status:'running',remarks:'',actualStart:new Date(local(DATE,'07:00')).toISOString(),
    actualEnd:null,binNeedsReview:false,createdAt:NOW,updatedAt:NOW,
  };
}

describe('date and line working hours',()=>{
  it('validates the public replacement command and rejects client audit metadata',()=>{
    expect(parseCommand({type:'settings.replaceWorkingHoursOverrides',date:DATE,reason:'Urgent orders',lines:[
      {lineId:'PM1',dayStart:'06:00',availableHours:15},
      {lineId:'PM3',dayStart:'07:00',availableHours:0},
    ]})).toMatchObject({type:'settings.replaceWorkingHoursOverrides',date:DATE});
    expect(()=>parseCommand({type:'settings.replaceWorkingHoursOverrides',date:DATE,reason:'Duplicate',lines:[
      {lineId:'PM1',dayStart:'06:00',availableHours:8},
      {lineId:'PM1',dayStart:'07:00',availableHours:8},
    ]})).toThrow(/duplicate production lines/i);
    expect(()=>parseCommand({type:'settings.replaceWorkingHoursOverrides',date:DATE,reason:'Too long',lines:[
      {lineId:'PM1',dayStart:'06:00',availableHours:25},
    ]})).toThrow(/24 or less/i);
    expect(()=>parseCommand({type:'settings.replaceWorkingHoursOverrides',date:DATE,reason:'Tampered',lines:[
      {lineId:'PM1',dayStart:'06:00',availableHours:8,activatedAt:NOW},
    ]})).toThrow(/activatedAt.*not supported/i);
  });

  it('uses line overrides for the board envelope, capacity, downtime and zero-hour closures',()=>{
    const state=createEmptyState();
    state.settings.workingHoursOverrides=[
      {date:DATE,lineId:'PM1',dayStart:'06:00',availableHours:15,reason:'Overtime',activatedAt:NOW},
      {date:DATE,lineId:'PM2',dayStart:'08:00',availableHours:8,reason:'Short shift',activatedAt:NOW},
      {date:DATE,lineId:'PM3',dayStart:'07:00',availableHours:0,reason:'Closed',activatedAt:NOW},
      {date:DATE,lineId:'PM4',dayStart:'07:00',availableHours:0,reason:'Closed',activatedAt:NOW},
    ];
    state.settings.downtime=[{id:'lunch',date:DATE,lineId:'PM1',start:'12:00',end:'13:30',reason:'Maintenance'}];
    const board=getBoard(state,DATE);
    expect(board.start).toBe(local(DATE,'06:00'));
    expect(board.end).toBe(local(DATE,'21:00'));
    expect(board.lines.map(line=>[line.lineId,line.availableMinutes,line.workingWindow.source])).toEqual([
      ['PM1',13.5*60,'override'],['PM2',8*60,'override'],['PM3',0,'override'],['PM4',0,'override'],
    ]);
    expect(getAvailableIntervals(state.settings,'PM1',DATE)).toEqual([
      {start:local(DATE,'06:00'),end:local(DATE,'12:00')},
      {start:local(DATE,'13:30'),end:local(DATE,'21:00')},
    ]);
    expect(getWorkingHoursForDate(state.settings,NEXT,'PM1')).toMatchObject({dayStart:'07:00',availableHours:12,source:'calendar'});
  });

  it('falls back to the normal display window when every line is closed',()=>{
    const state=createEmptyState();
    state.settings.workingHoursOverrides=['PM1','PM2','PM3','PM4'].map(lineId=>({
      date:DATE,lineId:lineId as 'PM1'|'PM2'|'PM3'|'PM4',dayStart:'07:00',availableHours:0,reason:'Plant closed',activatedAt:NOW,
    }));
    const board=getBoard(state,DATE);
    expect([board.start,board.end]).toEqual([local(DATE,'07:00'),local(DATE,'19:00')]);
    expect(board.lines.every(line=>line.availableMinutes===0&&line.utilisation===null)).toBe(true);
  });

  it('reselects each future date calendar when production rolls out of an override',()=>{
    const state=createEmptyState();
    state.settings.rates.PM1=10;
    state.settings.workingHoursOverrides=[{date:DATE,lineId:'PM1',dayStart:'07:00',availableHours:2,reason:'Short day',activatedAt:NOW}];
    const scheduled=getScheduledJobs(bulkJob(state,30))[0];
    const production=scheduled.segments.filter(segment=>segment.kind==='production');
    expect(production).toEqual([
      expect.objectContaining({start:local(DATE,'07:00'),end:local(DATE,'09:00')}),
      expect.objectContaining({start:local(NEXT,'07:00'),end:local(NEXT,'08:00')}),
    ]);
    expect(getBoard(bulkJob(state,30),DATE).lines[0].overflowMinutes).toBe(60);
  });

  it('carries pending work from a closed assigned line-day to the next normal shift',()=>{
    const state=createEmptyState();
    state.settings.workingHoursOverrides=[{date:DATE,lineId:'PM1',dayStart:'07:00',availableHours:0,reason:'Closed',activatedAt:NOW}];
    const scheduled=getScheduledJobs(bulkJob(state,8.5))[0];
    expect(scheduled.plannedStart).toBe(local(NEXT,'07:00'));
    expect(scheduled.segments).toHaveLength(1);
  });

  it('rejects overnight windows that collide with the following line-day',()=>{
    const state=createEmptyState();
    state.settings.workingHoursOverrides=[
      {date:DATE,lineId:'PM1',dayStart:'22:00',availableHours:8,reason:'Night shift',activatedAt:NOW},
      {date:NEXT,lineId:'PM1',dayStart:'05:00',availableHours:8,reason:'Early shift',activatedAt:NOW},
    ];
    expect(()=>getBoard(state,DATE)).toThrow(/PM1.*overlap/i);
  });

  it('uses trusted activation time, protects past dates, rebases generated floors and freezes legacy active work',()=>{
    const todayNow='2026-11-04T02:00:00.000Z'; // 10:00 MYT on DATE
    const state=bulkJob(createEmptyState(),8.5);
    const generated=state.jobs[0];
    generated.calendarManagedRelease=true;
    generated.notBefore=new Date(local(DATE,'07:00')).toISOString();
    state.jobs.push(legacyRunningJob());
    const originalRunningSegments=getScheduledJobs(state).find(job=>job.id==='running')!.segments;
    const originalFacts=state.jobs.map(job=>[job.id,job.orderNo,job.quantityMt]);
    const changed=replaceWorkingHoursOverrides(state,DATE,[
      {lineId:'PM1',dayStart:'06:00',availableHours:15},
      {lineId:'PM2',dayStart:'08:00',availableHours:11},
    ],'Urgent production',todayNow);
    expect(changed.settings.workingHoursOverrides?.[0]).toMatchObject({reason:'Urgent production',activatedAt:todayNow});
    expect(changed.jobs.find(job=>job.id===generated.id)?.notBefore).toBe(todayNow);
    expect(changed.jobs.find(job=>job.id==='running')?.lockedSegments).toEqual(originalRunningSegments);
    expect(changed.jobs.map(job=>[job.id,job.orderNo,job.quantityMt])).toEqual(originalFacts);
    expect(changed.events.at(-1)).toMatchObject({type:'settings.workingHours.updated'});
    expect(()=>replaceWorkingHoursOverrides(state,'2026-11-03',[],'Old day',todayNow)).toThrow(/past.*cannot be changed/i);
  });

  it('freezes only active history whose projected schedule changes',()=>{
    const state=createEmptyState();
    const affected={...legacyRunningJob(),id:'affected',lineId:'PM1' as const};
    const unrelated={...legacyRunningJob(),id:'unrelated',lineId:'PM4' as const,status:'completed' as const,actualEnd:'2026-11-04T01:00:00.000Z'};
    state.jobs.push(affected,unrelated);
    const unrelatedBefore=structuredClone(unrelated);
    const oldAffected=getScheduledJobs(state).find(job=>job.id===affected.id)!.segments;
    const changed=replaceWorkingHoursOverrides(state,DATE,[{lineId:'PM1',dayStart:'10:00',availableHours:9}],'PM1 late start',NOW);
    expect(changed.jobs.find(job=>job.id===affected.id)?.lockedSegments).toEqual(oldAffected);
    expect(changed.jobs.find(job=>job.id===unrelated.id)).toEqual(unrelatedBefore);
  });

  it('rejects ordinary settings tampering with override metadata',()=>{
    const state=replaceWorkingHoursOverrides(createEmptyState(),DATE,[{lineId:'PM1',dayStart:'06:00',availableHours:15}],'Urgent',NOW);
    const tampered=structuredClone(state.settings);
    tampered.workingHoursOverrides![0].activatedAt='2026-11-03T03:00:00.000Z';
    expect(()=>updateSettings(state,tampered,NOW)).toThrow(/metadata cannot be edited/i);
  });
});

describe('working-hours persistence and generated planning',()=>{
  it('round-trips canonical rows, sorts them, and rejects duplicate or incomplete metadata',()=>{
    const raw=structuredClone(createEmptyState()) as any;
    raw.settings.workingHoursOverrides=[
      {date:DATE,lineId:'PM4',dayStart:'08:00',availableHours:5,reason:'Short',activatedAt:NOW},
      {date:DATE,lineId:'PM1',dayStart:'06:00',availableHours:15,reason:'Overtime',activatedAt:NOW},
    ];
    const restored=validateWorkspaceBackup(raw);
    expect(restored.settings.workingHoursOverrides?.map(row=>row.lineId)).toEqual(['PM1','PM4']);
    const duplicate=structuredClone(raw);
    duplicate.settings.workingHoursOverrides.push({...duplicate.settings.workingHoursOverrides[0]});
    expect(()=>validateWorkspaceBackup(duplicate)).toThrow(/duplicates PM4/i);
    const tampered=structuredClone(raw);
    delete tampered.settings.workingHoursOverrides[0].activatedAt;
    expect(()=>validateWorkspaceBackup(tampered)).toThrow(/activatedAt.*required/i);
  });

  it('gives the draft generator capacity only on open lines',()=>{
    const state=createEmptyState();
    state.settings.rates={PM1:10,PM2:10,PM3:10,PM4:10};
    state.settings.workingHoursOverrides=[
      {date:DATE,lineId:'PM1',dayStart:'07:00',availableHours:2,reason:'Short',activatedAt:NOW},
      ...(['PM2','PM3','PM4'] as const).map(lineId=>({date:DATE,lineId,dayStart:'07:00',availableHours:0,reason:'Closed',activatedAt:NOW})),
    ];
    const demand:InventoryPlanningDemandRow={
      key:'order-1',itemId:'item-1',materialCode:'5220',description:'Feed',unit:'MT',bagWeightKg:null,
      strategy:'mto',purpose:'mto',sourceOrderId:'source-1',orderNo:'DO-1',dueDate:DATE,
      notBefore:new Date(local(DATE,'07:00')).toISOString(),quantity:100,medication:'',fmrOmed:'',
    };
    const draft=planInventoryDraft(state,[demand],{fromDate:DATE,toDate:DATE},4,NOW);
    expect(draft.jobs).toHaveLength(1);
    expect(draft.jobs[0]).toMatchObject({lineId:'PM1',quantity:20});
    expect(draft.backlog[0].quantity).toBe(80);
    expect(draft.utilization.find(row=>row.lineId==='PM3')?.availableHours).toBe(0);
  });
});
