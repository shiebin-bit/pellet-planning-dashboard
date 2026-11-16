import { describe,expect,it } from 'vitest';
import { createEmptyState } from './defaults';
import { createJob,splitPendingJob,combinePendingJobs } from './engine';
import { parseCommand } from './commands';
import { validateWorkspaceBackup } from './backup';
import { getJobSourceAllocations } from './jobSources';
import type { Job } from './types';

function fixture(mode:'bags'|'bulk'='bags') {
  const state=createJob(createEmptyState(),{date:'2026-10-30',lineId:'PM1',orderNo:'TEST-A',productCode:'TEST-5220',description:'FS 5220 TEST',bin:'B1',mode,bagCount:mode==='bags'?120:null,quantityMt:mode==='bags'?3:3.001,remarks:'Keep'});
  const job=state.jobs[0];
  job.bagWeightKgSnapshot=25;
  job.sourceAllocations=[{sourceOrderId:'source-a',sourceOrderVersion:2,sourceSnapshot:{doNo:'TEST-A',materialCode:job.productCode,description:job.description,quantity:200,unit:mode==='bags'?'Bags':'MT'},plannedQuantity:mode==='bags'?100:2}];
  return {state,job};
}
const group=(quantity:number,extra:number,date='2026-10-30',lineId:Job['lineId']='PM1')=>({date,lineId,bin:'B1',remarks:'Split',allocations:quantity?[{sourceOrderId:'source-a',plannedQuantity:quantity}]:[],unallocatedQuantity:extra});

describe('pending-card split',()=>{
  it('conserves each order and extra stock, saves bag weight and appends after target cards',()=>{
    const {state,job}=fixture();
    const next=splitPendingJob(state,job.id,[group(40,5),group(60,15,'2026-10-31','PM2')]);
    const children=next.jobs.filter(j=>j.derivedFromJobId===job.id);
    expect(next.jobs.find(j=>j.id===job.id)?.status).toBe('cancelled');
    expect(state.jobs[0].status).toBe('pending');
    expect(children.map(j=>j.bagCount)).toEqual([45,75]);
    expect(children.map(j=>j.quantityMt)).toEqual([1.125,1.875]);
    expect(children.map(j=>j.sourceAllocations![0].plannedQuantity)).toEqual([40,60]);
    expect(children.every(j=>j.status==='pending'&&j.actualStart===null&&j.actualEnd===null&&!j.lockedSegments&&!j.issue)).toBe(true);
    expect(validateWorkspaceBackup(next).jobs.filter(j=>j.derivedFromJobId===job.id)).toHaveLength(2);
    expect(()=>validateWorkspaceBackup({...next,jobs:next.jobs.filter(j=>j.id!==job.id)})).toThrow('missing original');
    expect(next.events.at(-1)?.type).toBe('job.split');
  });
  it('recombines same-order portions into one allocation without changing physical total',()=>{
    const {state,job}=fixture();
    const split=splitPendingJob(state,job.id,[group(40,5),group(60,15)]);
    const children=split.jobs.filter(j=>j.derivedFromJobId===job.id);
    const combined=combinePendingJobs(split,children.map(j=>j.id),'B1','Rejoined');
    const survivor=combined.jobs.find(j=>j.status==='pending')!;
    expect(survivor.bagCount).toBe(120);expect(survivor.quantityMt).toBe(3);
    expect(getJobSourceAllocations(survivor)).toHaveLength(1);
    expect(getJobSourceAllocations(survivor)[0].plannedQuantity).toBe(100);
    const stale=structuredClone(split);stale.jobs.find(j=>j.id===children[1].id)!.sourceAllocations![0].sourceOrderVersion++;
    expect(()=>combinePendingJobs(stale,children.map(j=>j.id),'','')).toThrow('different saved versions');
  });
  it('rejects lost order quantity, extra output, empty cards and fractional bags atomically',()=>{
    const {state,job}=fixture();
    for(const groups of [[group(40,5),group(59,15)],[group(40,5),group(60,14)],[group(100,20),group(0,0)],[group(40.5,5),group(59.5,15)]])expect(()=>splitPendingJob(state,job.id,groups)).toThrow();
    expect(state.jobs).toHaveLength(1);expect(state.jobs[0].status).toBe('pending');
    expect(()=>splitPendingJob({...state,jobs:[{...job,status:'running'}]},job.id,[group(50,10),group(50,10)])).toThrow('pending');
    expect(()=>splitPendingJob({...state,jobs:[{...job,actualQuantityMt:0}]},job.id,[group(50,10),group(50,10)])).toThrow('without actual output');
  });
  it('keeps exact bulk millitonnes and allows manual stock-only cards',()=>{
    const {state,job}=fixture('bulk');
    const next=splitPendingJob(state,job.id,[group(0.999,0.001),group(1.001,1)]);
    expect(next.jobs.filter(j=>j.status==='pending').map(j=>j.quantityMt)).toEqual([1,2.001]);
    expect(()=>splitPendingJob(state,job.id,[group(0.9995,0.001),group(1.0005,1)])).toThrow('three decimal');
    const manual={...state,jobs:[{...job,sourceAllocations:undefined}]};
    expect(splitPendingJob(manual,job.id,[group(0,1),group(0,2.001)]).jobs.filter(j=>j.status==='pending')).toHaveLength(2);
  });
  it('validates strict split command contracts and refuses forged lineage input',()=>{
    const command={type:'job.splitPending',jobId:'job-test',groups:[group(40,5),group(60,15)]};
    expect(parseCommand(command)).toEqual(command);
    expect(()=>parseCommand({...command,groups:[command.groups[0]]})).toThrow('at least two');
    expect(()=>parseCommand({...command,derivedFromJobId:'forged'})).toThrow();
    expect(()=>parseCommand({...command,groups:[{...command.groups[0],allocations:[...command.groups[0].allocations,...command.groups[0].allocations]},command.groups[1]]})).toThrow('duplicate');
  });
});
