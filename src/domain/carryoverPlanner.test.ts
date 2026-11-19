import { describe, expect, it } from 'vitest';
import { createEmptyState } from './defaults';
import { createJob, getScheduledJobs, plannedMtInWindow, startJob } from './engine';
import { applyDraftCarryovers, planInventoryDraft } from './inventoryPlanner';
import type { CarryoverCandidate } from './dailyPlanning';
import type { InventoryPlanningDemandRow } from './inventoryTypes';

const DAY = '2026-11-19', OLD = '2026-11-18', NOW = '2026-11-18T22:00:00.000Z';
const demand = (code: string, patch: Partial<InventoryPlanningDemandRow> = {}): InventoryPlanningDemandRow => ({ key: code, itemId: code, materialCode: `MAT-${code}`, description: `FS ${code} FEED`, unit: 'Bags', bagWeightKg: 50, strategy: 'mto', purpose: 'mto', sourceOrderId: code, orderNo: code, dueDate: DAY, priorityDate: DAY, priorityOrdinal: 1, notBefore: NOW, quantity: 20, medication: '', fmrOmed: '', ...patch });
const request = { fromDate: DAY, toDate: DAY };
function pending() { return createJob(createEmptyState(), { date: OLD, lineId: 'PM4', orderNo: 'OLD', productCode: 'MAT-5220', description: 'FS 5220 FEED', mode: 'bags', bagCount: 100, quantityMt: 0, bagWeightKgSnapshot: 50, bin: 'A', remarks: '' }); }
function candidate(state: ReturnType<typeof pending>, kind: CarryoverCandidate['kind'] = 'reschedule'): CarryoverCandidate { return { jobId: state.jobs[0].id, kind, remainingQuantity: 100, unit: 'Bags', priorityDate: OLD, ordinal: 1, originalDate: OLD, originalLineId: 'PM4' }; }

describe('daily queue and PM preferences', () => {
  it.each([['5220','Bags','PM1'],['5220M','Bags','PM1'],['5220','MT','PM1'],['5811','Bags','PM2'],['5211','Bags','PM2'],['5210','Bags','PM2'],['5210','MT','PM2'],['5222','Bags','PM2'],['5220MER','Bags','PM3'],['5220CCB','MT','PM3']])('uses exact %s %s preference', (code, unit, pm) => {
    const state = createEmptyState(); state.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    const row = demand(code, unit === 'MT' ? { unit: 'MT', bagWeightKg: null } : {});
    expect(planInventoryDraft(state, [row], request, 1, NOW).jobs[0].lineId).toBe(pm);
  });
  it('uses earliest finish among equally preferred PMs and diverts on the same day', () => {
    const state = createEmptyState(); state.settings.rates.PM4 = 20;
    const row = demand('5220', { unit: 'MT', bagWeightKg: null, quantity: 10 });
    expect(planInventoryDraft(state, [row], request, 1, NOW).jobs[0].lineId).toBe('PM4');
    state.settings.downtime = ['PM1','PM4'].map(lineId => ({ id: lineId, date: DAY, lineId: lineId as 'PM1'|'PM4', start: '07:00', end: '19:00', reason: 'Service' }));
    const draft = planInventoryDraft(state, [row], { ...request, toDate: '2026-11-20' }, 1, NOW);
    expect(draft.jobs[0]).toMatchObject({ date: DAY, lineId: 'PM2' });
  });
  it('retains earlier admitted demand ahead of a newer batch', () => {
    const state = createEmptyState();
    const draft = planInventoryDraft(state, [demand('5220', { priorityDate: DAY, key: 'new' }), demand('5811', { priorityDate: OLD, key: 'old' })], request, 1, NOW);
    expect(draft.jobs.map(job => job.materialCode)).toEqual(['MAT-5811','MAT-5220']);
  });
  it('does not pull a later matching product ahead of the intervening imported order', () => {
    const first=demand('5220',{key:'first',sourceOrderId:'first',priorityOrdinal:0});
    const middle=demand('5811',{key:'middle',sourceOrderId:'middle',priorityOrdinal:1});
    const last=demand('5220',{key:'last',sourceOrderId:'last',priorityOrdinal:2});
    const draft=planInventoryDraft(createEmptyState(),[last,middle,first],request,1,NOW);
    expect(draft.jobs.map(job=>job.materialCode)).toEqual(['MAT-5220','MAT-5811','MAT-5220']);
    expect(draft.jobs.flatMap(job=>job.sourceAllocations?.map(row=>row.sourceOrderId)??[])).toEqual(['first','middle','last']);
  });
  it('reschedules the original pending card without copying quantities or allocations', () => {
    const state = pending(), original = structuredClone(state.jobs[0]);
    const draft = planInventoryDraft(state, [], request, 1, NOW, { candidates: [candidate(state)] });
    expect(draft.jobs).toEqual([]); expect(draft.carryovers).toHaveLength(1);
    const applied = applyDraftCarryovers(state, draft.carryovers, NOW);
    expect(applied.jobs).toHaveLength(1);
    expect(applied.jobs[0]).toMatchObject({ id: original.id, date: DAY, lineId: 'PM1', quantityMt: original.quantityMt, bagCount: 100, status: 'pending' });
    expect(state.jobs[0]).toEqual(original);
    expect(getScheduledJobs(applied)[0].plannedEnd).toBeLessThanOrEqual(Date.parse(`${DAY}T19:00:00+08:00`));
  });
  it('does not split or clone an oversized pending carryover', () => {
    const state = pending(); state.jobs[0].bagCount = 10000; state.jobs[0].quantityMt = 500;
    const draft = planInventoryDraft(state, [], request, 1, NOW, { candidates: [{ ...candidate(state), remainingQuantity: 10000 }] });
    expect(draft.carryovers).toEqual([]); expect(draft.carryoverBacklog[0].remainingQuantity).toBe(10000); expect(draft.jobs).toEqual([]);
  });
  it('keeps one original pending card when its production spans the selected days', () => {
    const state = pending(); state.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    state.jobs[0].bagCount = 3000; state.jobs[0].quantityMt = 150;
    const draft = planInventoryDraft(state, [], { ...request, toDate: '2026-11-20' }, 1, NOW, { candidates: [{ ...candidate(state), remainingQuantity: 3000 }] });
    expect(draft.carryovers).toHaveLength(1); expect(draft.carryoverBacklog).toEqual([]); expect(draft.jobs).toEqual([]);
    const applied = applyDraftCarryovers(state, draft.carryovers, NOW);
    expect(applied.jobs).toHaveLength(1); expect(applied.jobs[0]).toMatchObject({ id: state.jobs[0].id, bagCount: 3000, quantityMt: 150 });
    const scheduled = getScheduledJobs(applied)[0];
    expect(new Date(scheduled.plannedEnd! + 8*3600000).toISOString().slice(0,10)).toBe('2026-11-20');
    expect(draft.utilization.find(row => row.date === '2026-11-20' && row.lineId === 'PM1')?.hours).toBeCloseTo(3);
  });
  it('reserves partial continuation on the same PM without modifying historical locks', () => {
    let state = pending(); state = startJob(state, state.jobs[0].id, `${OLD}T07:00:00+08:00`);
    const locked = structuredClone(state.jobs[0].lockedSegments);
    state.settings.availableHours = 1;
    const row = { ...candidate(state,'continuation'), remainingQuantity: 200 };
    const draft = planInventoryDraft(state, [], request, 1, NOW, { candidates: [row] });
    expect(draft.jobs).toEqual([]); expect(draft.carryovers[0].lineId).toBe('PM4'); expect(draft.carryoverBacklog[0].remainingQuantity).toBe(60);
    const applied = applyDraftCarryovers(state, draft.carryovers, NOW);
    expect(applied.jobs[0].lockedSegments).toEqual(locked); expect(applied.jobs[0].actualStart).toBe(state.jobs[0].actualStart);
    const scheduled = getScheduledJobs(applied)[0];
    expect(plannedMtInWindow(scheduled, Date.parse(`${DAY}T07:00:00+08:00`), Date.parse(`${DAY}T08:00:00+08:00`))).toBeCloseTo(7);
  });
  it('keeps continuation capacity separate when a previously posted pending card starts', () => {
    const state = pending();
    const draft = planInventoryDraft(state, [], request, 1, NOW, { candidates: [candidate(state,'continuation')] });
    const applied = applyDraftCarryovers(state, draft.carryovers, NOW);
    const started = startJob(applied, applied.jobs[0].id, `${DAY}T07:00:00+08:00`);
    expect(started.jobs[0].lockedSegments?.every(segment => segment.end <= Date.parse(NOW))).toBe(true);
    expect(getScheduledJobs(started)[0].segments.filter(segment => segment.start >= Date.parse(NOW))).toEqual(draft.carryovers[0].segments);
  });
  it('reserves changeover when continuing after another confirmed product', () => {
    let state = pending(); state.settings.rates.PM4 = 10;
    state = startJob(state,state.jobs[0].id,`${OLD}T07:00:00+08:00`);
    state = createJob(state,{date:DAY,lineId:'PM4',orderNo:'OTHER',productCode:'MAT-5811',description:'FS 5811 FEED',mode:'bulk',bagCount:null,quantityMt:10,bin:'',remarks:''});
    const original = getScheduledJobs(state).find(job=>job.orderNo==='OTHER')!;
    const draft = planInventoryDraft(state,[],request,1,NOW,{candidates:[candidate(state,'continuation')]});
    const continuation=draft.carryovers[0];
    expect(continuation.segments[0]).toMatchObject({kind:'changeover',start:original.plannedEnd});
    expect(continuation.segments[1].start-continuation.segments[0].start).toBe(30*60_000);
    expect(getScheduledJobs(applyDraftCarryovers(state,draft.carryovers,NOW)).find(job=>job.orderNo==='OTHER')!.segments).toEqual(original.segments);
  });
  it('keeps earlier unplanned demand before a newer pending carry with the required changeover', () => {
    const state = pending(); state.settings.rates.PM1 = 10;
    state.settings.downtime = ['PM2','PM3','PM4'].map(lineId => ({ id: lineId, lineId: lineId as 'PM2'|'PM3'|'PM4', date: DAY, start: '07:00', end: '19:00', reason: 'Service' }));
    const draft = planInventoryDraft(state, [demand('5811', { priorityDate: '2026-11-17' })], request, 1, NOW, { candidates: [candidate(state)] });
    expect(draft.jobs[0].lineId).toBe('PM1');
    expect(draft.carryovers[0].segments[0]).toMatchObject({ kind: 'changeover', start: Date.parse(`${DAY}T07:06:00+08:00`) });
    expect(draft.carryovers[0].segments[1].start).toBe(Date.parse(`${DAY}T07:36:00+08:00`));
  });
  it('replaces obsolete unlocked spill capacity without moving a confirmed future card', () => {
    let state = pending(); state.settings.rates.PM4 = 10;
    state.jobs[0].mode='bulk'; state.jobs[0].bagCount=null; state.jobs[0].quantityMt=200;
    state = createJob(state,{date:DAY,lineId:'PM4',orderNo:'LATER',productCode:'MAT-5811',description:'FS 5811 FEED',mode:'bulk',bagCount:null,quantityMt:10,bin:'',remarks:''});
    const old = getScheduledJobs(state).find(job=>job.orderNo==='LATER')!;
    const draft=planInventoryDraft(state,[],request,1,NOW,{candidates:[{...candidate(state,'continuation'),unit:'MT',remainingQuantity:100}]});
    expect(draft.carryoverBacklog).toEqual([]);
    const applied=applyDraftCarryovers(state,draft.carryovers,NOW);
    expect(getScheduledJobs(applied).find(job=>job.orderNo==='LATER')!.segments).toEqual(old.segments);
    expect(applied.jobs[0].quantityMt).toBe(200);
  });
  it('keeps the working date when continuation starts after midnight in an overnight shift', () => {
    const state=pending(); state.settings.dayStart='22:00';state.settings.availableHours=8;
    state.settings.downtime=[{id:'night-service',lineId:'PM4',date:DAY,start:'22:00',end:'00:00',reason:'Service'}];
    const draft=planInventoryDraft(state,[],request,1,NOW,{candidates:[candidate(state,'continuation')]});
    expect(draft.carryovers[0].date).toBe(DAY);
    expect(new Date(draft.carryovers[0].segments[0].start+8*3600000).toISOString().slice(0,10)).toBe('2026-11-20');
  });
});
