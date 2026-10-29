import { describe, expect, it } from 'vitest';
import { createEmptyState } from './defaults';
import { createJob, getScheduledJobs, updateSettings } from './engine';
import { planInventoryDraft } from './inventoryPlanner';
import type { InventoryPlanningDemandRow } from './inventoryTypes';

const FROM = '2026-10-26', NOW = '2026-10-25T00:00:00Z';
const demand = (patch: Partial<InventoryPlanningDemandRow> = {}): InventoryPlanningDemandRow => ({ key: 'order-1', itemId: 'item-1', materialCode: '7.9999000000025', description: 'Feed', unit: 'Bags', bagWeightKg: 25, strategy: 'mto', purpose: 'mto', sourceOrderId: 'order-1', orderNo: 'DO1', dueDate: FROM, notBefore: `${FROM}T07:00:00+08:00`, quantity: 100, medication: '', fmrOmed: '', ...patch });
describe('inventory draft scheduling', () => {
  it('keeps a stock-only continuation separate from a later order card', () => {
    const state=createEmptyState();
    const next='2026-10-27';
    state.settings.downtime=[FROM,next].flatMap(date=>['PM2','PM3','PM4'].map(lineId=>({id:`${date}-${lineId}`,date,lineId:lineId as 'PM2'|'PM3'|'PM4',start:'07:00',end:'07:00',reason:'Unavailable'})));
    const result=planInventoryDraft(state,[demand({unit:'MT',bagWeightKg:null,quantity:130,sourceAllocationQuantity:50}),demand({key:'order-2',sourceOrderId:'order-2',orderNo:'DO2',unit:'MT',bagWeightKg:null,quantity:1,sourceAllocationQuantity:1,dueDate:next})],{fromDate:FROM,toDate:next},3,NOW);
    const stockOnly=result.jobs.find(job=>job.date===next&&!job.sourceOrderId&&!job.sourceAllocations?.length);
    const order=result.jobs.find(job=>job.sourceAllocations?.some(allocation=>allocation.sourceOrderId==='order-2'));
    expect(stockOnly).toBeDefined();
    expect(order).toMatchObject({orderNo:'DO2',quantity:1,date:next});
    expect(result.jobs).toHaveLength(3);
  });
  it('honors per-item bag weight and plans order demand before stock replenishment', () => {
    const result = planInventoryDraft(createEmptyState(), [demand({ key: 'stock', purpose: 'mts', sourceOrderId: null }), demand()], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs[0].sourceOrderId).toBe('order-1');
    expect(result.jobs.reduce((s, j) => s + j.quantity, 0)).toBe(200);
    expect(result.jobs.every(j => Number.isInteger(j.quantity))).toBe(true);
    expect(result.backlog).toEqual([]);
  });
  it('splits large demands across lines/days without planning outside the horizon', () => {
    const result = planInventoryDraft(createEmptyState(), [demand({ quantity: 100000 })], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs.length).toBe(4);
    expect(result.backlog[0].quantity).toBeGreaterThan(0);
    expect(result.jobs.every(j => j.date === FROM)).toBe(true);
    expect(result.jobs.reduce((s, j) => s + j.quantity, 0) + result.backlog[0].quantity).toBe(100000);
  });
  it('respects downtime and starts today after the current time', () => {
    const state = createEmptyState(); state.settings.downtime = [{ id: 'stop', date: FROM, lineId: 'all', start: '07:00', end: '18:00', reason: 'Maintenance' }];
    const result = planInventoryDraft(state, [demand()], { fromDate: FROM, toDate: FROM }, 1, `${FROM}T09:00:00+08:00`);
    expect(result.jobs[0].notBefore).toBe(new Date(`${FROM}T09:00:00+08:00`).toISOString());
    expect(result.utilization.every(u => u.hours <= u.availableHours + 1e-8)).toBe(true);
  });
  it('appends work and preserves item weights when changing global settings', () => {
    const state = createJob(createEmptyState(), { date: FROM, lineId: 'PM1', orderNo: 'OLD', productCode: 'OLD', description: '', bin: '', mode: 'bags', bagCount: 100, quantityMt: 0, remarks: '', bagWeightKgSnapshot: 25, inventoryItemId: 'old' });
    const changed = updateSettings(state, { ...state.settings, bagWeightKg: 50 });
    expect(changed.jobs[0].quantityMt).toBe(2.5);
    const oldEnd = getScheduledJobs(state)[0].plannedEnd!;
    const draft = planInventoryDraft(state, [demand()], { fromDate: FROM, toDate: FROM }, 1, NOW);
    expect(draft.jobs.filter(j => j.lineId === 'PM1').every(j => Date.parse(j.notBefore) >= oldEnd)).toBe(true);
  });
  it('combines adjacent compatible MTO orders scheduled on the same day and line', () => {
    const state = createEmptyState();
    state.settings.downtime = ['PM2', 'PM3', 'PM4'].map((lineId, index) => ({ id: `stop-${index}`, date: FROM, lineId: lineId as 'PM2'|'PM3'|'PM4', start: '07:00', end: '07:00', reason: 'Unavailable' }));
    const result = planInventoryDraft(state, [demand(), demand({ key: 'order-2', sourceOrderId: 'order-2', orderNo: 'DO2', quantity: 50 })], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ sourceOrderId: null, lineId: 'PM1', quantity: 150 });
    expect(result.jobs[0].sourceAllocations).toEqual([
      { sourceOrderId: 'order-1', plannedQuantity: 100 },
      { sourceOrderId: 'order-2', plannedQuantity: 50 },
    ]);
  });
  it('keeps deliberate extra output outside the source-order allocation, including split cards', () => {
    const state = createEmptyState();
    const result = planInventoryDraft(state, [demand({ quantity: 10000, sourceAllocationQuantity: 7000 })], { fromDate: FROM, toDate: FROM }, 3, NOW);
    const physical = result.jobs.reduce((sum, job) => sum + job.quantity, 0);
    const allocated = result.jobs.flatMap(job => job.sourceAllocations ?? []).reduce((sum, allocation) => sum + allocation.plannedQuantity, 0);
    expect(physical).toBeGreaterThan(allocated);
    expect(physical).toBe(10000);
    expect(allocated).toBe(7000);
    expect(result.jobs.length).toBeGreaterThan(1);
    expect(result.backlog).toEqual([]);
  });
});
