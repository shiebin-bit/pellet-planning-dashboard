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
  it('appends work while retaining the demand release floor and item weights', () => {
    const state = createJob(createEmptyState(), { date: FROM, lineId: 'PM1', orderNo: 'OLD', productCode: 'OLD', description: '', bin: '', mode: 'bags', bagCount: 100, quantityMt: 0, remarks: '', bagWeightKgSnapshot: 25, inventoryItemId: 'old' });
    const changed = updateSettings(state, { ...state.settings, bagWeightKg: 50 });
    expect(changed.jobs[0].quantityMt).toBe(2.5);
    const draft = planInventoryDraft(state, [demand()], { fromDate: FROM, toDate: FROM }, 1, NOW);
    expect(draft.jobs.every(j => j.notBefore === new Date(`${FROM}T07:00:00+08:00`).toISOString())).toBe(true);
    expect(draft.jobs.every(j => j.lineId !== 'PM1')).toBe(true);
  });

  it('changes draft splits with 8-hour versus 12-hour capacity', () => {
    const state = createEmptyState();
    state.settings.dayStart = '08:00';
    state.settings.availableHours = 8;
    state.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    const large = demand({ unit: 'MT', bagWeightKg: null, quantity: 1000, notBefore: `${FROM}T08:00:00+08:00` });
    const short = planInventoryDraft(state, [large], { fromDate: FROM, toDate: FROM }, 1, NOW);
    expect(short.jobs).toHaveLength(4);
    expect(short.jobs.reduce((sum, job) => sum + job.quantity, 0)).toBe(320);
    state.settings.availableHours = 12;
    const long = planInventoryDraft(state, [large], { fromDate: FROM, toDate: FROM }, 2, NOW);
    expect(long.jobs).toHaveLength(4);
    expect(long.jobs.reduce((sum, job) => sum + job.quantity, 0)).toBe(480);
  });

  it('maps post-midnight downtime inside an overnight shift and reports the actual finish date', () => {
    const state = createEmptyState();
    state.settings.dayStart = '22:00';
    state.settings.availableHours = 8;
    state.settings.rates = { PM1: 10, PM2: 10, PM3: 10, PM4: 10 };
    state.settings.downtime = [{ id: 'overnight-stop', date: FROM, lineId: 'all', start: '01:00', end: '02:00', reason: 'Maintenance' }];
    const large = demand({ unit: 'MT', bagWeightKg: null, quantity: 1000, notBefore: `${FROM}T22:00:00+08:00` });
    const draft = planInventoryDraft(state, [large], { fromDate: FROM, toDate: FROM }, 1, NOW);
    expect(draft.jobs.reduce((sum, job) => sum + job.quantity, 0)).toBe(280);
    expect(draft.jobs.every(job => job.notBefore === new Date(`${FROM}T22:00:00+08:00`).toISOString())).toBe(true);
    expect(draft.late[0]).toMatchObject({ dueDate: FROM, plannedDate: '2026-10-27' });
    const committed = draft.jobs.reduce((current, job) => createJob(current, {
      date: job.date, lineId: job.lineId, orderNo: job.orderNo, productCode: job.materialCode, description: job.description,
      bin: '', mode: 'bulk', bagCount: null, quantityMt: job.quantity, remarks: '', inventoryItemId: job.itemId,
      productionPurpose: job.productionPurpose, notBefore: job.notBefore, medication: '', fmrOmed: '',
    }), state);
    expect(Math.max(...getScheduledJobs(committed).map(job => job.plannedEnd!))).toBe(Date.parse('2026-10-27T06:00:00+08:00'));
  });

  it('waits for a future shift start and has no same-day capacity after shift end', () => {
    const state = createEmptyState();
    state.settings.dayStart = '08:00';
    state.settings.availableHours = 8;
    const before = planInventoryDraft(state, [demand({ notBefore: `${FROM}T08:00:00+08:00` })], { fromDate: FROM, toDate: FROM }, 1, `${FROM}T06:00:00+08:00`);
    expect(before.jobs).toHaveLength(1);
    const after = planInventoryDraft(state, [demand({ notBefore: `${FROM}T20:00:00+08:00` })], { fromDate: FROM, toDate: FROM }, 1, `${FROM}T20:00:00+08:00`);
    expect(after.jobs).toEqual([]);
    expect(after.backlog[0].quantity).toBe(100);
  });
  it('stores the current-time release floor so committed preview work cannot move earlier', () => {
    const state = createEmptyState();
    const now = `${FROM}T09:00:00+08:00`;
    const draft = planInventoryDraft(state, [demand()], { fromDate: FROM, toDate: FROM }, 1, now);
    expect(draft.jobs[0].notBefore).toBe(new Date(now).toISOString());
    const committed = createJob(state, {
      date: draft.jobs[0].date, lineId: draft.jobs[0].lineId, orderNo: draft.jobs[0].orderNo,
      productCode: draft.jobs[0].materialCode, description: '', bin: '', mode: 'bags', bagCount: draft.jobs[0].quantity,
      quantityMt: 0, remarks: '', inventoryItemId: draft.jobs[0].itemId, productionPurpose: 'mto',
      bagWeightKgSnapshot: 25, notBefore: draft.jobs[0].notBefore,
    });
    expect(getScheduledJobs(committed)[0].plannedStart).toBeGreaterThanOrEqual(Date.parse(now));
  });
  it('combines adjacent compatible MTO orders scheduled on the same day and line', () => {
    const state = createEmptyState();
    const result = planInventoryDraft(state, [demand(), demand({ key: 'order-2', sourceOrderId: 'order-2', orderNo: 'DO2', quantity: 50 })], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ sourceOrderId: null, lineId: 'PM1', quantity: 150 });
    expect(result.jobs[0].sourceAllocations).toEqual([
      { sourceOrderId: 'order-1', plannedQuantity: 100 },
      { sourceOrderId: 'order-2', plannedQuantity: 50 },
    ]);
  });
  it('batches compatible orders by due date without pulling a later order across another product', () => {
    const state = createEmptyState();
    state.settings.downtime = ['PM2', 'PM3', 'PM4'].map((lineId, index) => ({ id: `stop-${index}`, date: FROM, lineId: lineId as 'PM2'|'PM3'|'PM4', start: '07:00', end: '07:00', reason: 'Unavailable' }));
    const next = '2026-10-27', later = '2026-10-28';
    const result = planInventoryDraft(state, [
      demand({ key: 'a-1', sourceOrderId: 'a-1', orderNo: 'A1', materialCode: 'MAT-A', unit: 'MT', bagWeightKg: null, quantity: 4 }),
      demand({ key: 'b-1', sourceOrderId: 'b-1', orderNo: 'B1', materialCode: 'MAT-B', itemId: 'item-b', unit: 'MT', bagWeightKg: null, quantity: 3, dueDate: next }),
      demand({ key: 'a-3', sourceOrderId: 'a-3', orderNo: 'A3', materialCode: 'MAT-A', unit: 'MT', bagWeightKg: null, quantity: 2, dueDate: later }),
      demand({ key: 'a-2', sourceOrderId: 'a-2', orderNo: 'A2', materialCode: 'MAT-A', unit: 'MT', bagWeightKg: null, quantity: 5 }),
    ], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs.map(job => job.materialCode)).toEqual(['MAT-A', 'MAT-B', 'MAT-A']);
    expect(result.jobs[0]).toMatchObject({ quantity: 9, orderNo: 'A1 +1' });
    expect(result.jobs[0].sourceAllocations).toEqual([
      { sourceOrderId: 'a-1', plannedQuantity: 4 },
      { sourceOrderId: 'a-2', plannedQuantity: 5 },
    ]);
    expect(result.jobs[2].sourceAllocations).toEqual([{ sourceOrderId: 'a-3', plannedQuantity: 2 }]);
  });
  it('can keep compatible orders as separate cards when requested', () => {
    const state = createEmptyState();
    const result = planInventoryDraft(state, [
      demand({ key: 'a-1', sourceOrderId: 'a-1', orderNo: 'A1', unit: 'MT', bagWeightKg: null, quantity: 4 }),
      demand({ key: 'a-2', sourceOrderId: 'a-2', orderNo: 'A2', unit: 'MT', bagWeightKg: null, quantity: 5 }),
    ], { fromDate: FROM, toDate: FROM, combineSameProduct: false }, 3, NOW);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map(job => job.orderNo)).toEqual(['A1', 'A2']);
    expect(result.jobs.map(job => job.lineId)).toEqual(['PM1', 'PM2']);
  });
  it('caps a combined physical card at 500 distinct source orders', () => {
    const orders = Array.from({ length: 501 }, (_, index) => demand({
      key: `order-${String(index).padStart(3, '0')}`,
      sourceOrderId: `order-${index}`,
      orderNo: `DO${index}`,
      unit: 'MT',
      bagWeightKg: null,
      quantity: .001,
    }));
    const result = planInventoryDraft(createEmptyState(), orders, { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map(job => job.sourceAllocations?.length)).toEqual([500, 1]);
    expect(result.jobs.reduce((sum, job) => sum + job.quantity, 0)).toBeCloseTo(.501, 6);
    expect(new Set(result.jobs.flatMap(job => job.sourceAllocations?.map(row => row.sourceOrderId) ?? [])).size).toBe(501);
  });
  it('keeps separate cards contiguous without changeover for the same full product and stock variant', () => {
    const state = createEmptyState();
    state.settings.downtime = ['PM2', 'PM3', 'PM4'].map(lineId => ({id:lineId,date:FROM,lineId:lineId as 'PM2'|'PM3'|'PM4',start:'07:00',end:'07:00',reason:'Unavailable'}));
    const draft = planInventoryDraft(state, [demand(), demand({key:'order-2',sourceOrderId:'order-2',orderNo:'DO2',quantity:50})], {fromDate:FROM,toDate:FROM,combineSameProduct:false}, 1, NOW);
    const saved = draft.jobs.reduce((current, job) => createJob(current, {
      date:job.date,lineId:job.lineId,orderNo:job.orderNo,productCode:job.materialCode,description:job.description,
      bin:'',mode:'bags',bagCount:job.quantity,bagWeightKgSnapshot:25,quantityMt:0,remarks:'',
      inventoryItemId:job.itemId,notBefore:job.notBefore,medication:job.medication,fmrOmed:job.fmrOmed,
    }), state);
    const scheduled = getScheduledJobs(saved);
    expect(scheduled).toHaveLength(2);
    expect(scheduled.flatMap(job => job.segments).filter(segment => segment.kind === 'changeover')).toEqual([]);
    expect(scheduled[1].plannedStart).toBe(scheduled[0].plannedEnd);
  });
  it('preserves every order share and stock extra when a due-date batch splits around capacity and downtime', () => {
    const state = createEmptyState();
    const next = '2026-10-27';
    state.settings.downtime = [FROM, next].flatMap(date => ['PM2', 'PM3', 'PM4'].map((lineId, index) => ({ id: `${date}-stop-${index}`, date, lineId: lineId as 'PM2'|'PM3'|'PM4', start: '07:00', end: '07:00', reason: 'Unavailable' })));
    const result = planInventoryDraft(state, [
      demand({ key: 'a', sourceOrderId: 'a', orderNo: 'A', unit: 'MT', bagWeightKg: null, quantity: 100, sourceAllocationQuantity: 80 }),
      demand({ key: 'b', sourceOrderId: 'b', orderNo: 'B', unit: 'MT', bagWeightKg: null, quantity: 50, sourceAllocationQuantity: 40 }),
    ], { fromDate: FROM, toDate: next }, 3, NOW);
    const allocations = new Map<string, number>();
    for (const row of result.jobs.flatMap(job => job.sourceAllocations ?? [])) allocations.set(row.sourceOrderId, (allocations.get(row.sourceOrderId) ?? 0) + row.plannedQuantity);
    const physical = result.jobs.reduce((sum, job) => sum + job.quantity, 0);
    const allocated = [...allocations.values()].reduce((sum, quantity) => sum + quantity, 0);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map(job => job.date)).toEqual([FROM, next]);
    expect(result.jobs.every(job => job.lineId === 'PM1')).toBe(true);
    expect(Object.fromEntries(allocations)).toEqual({ a: 80, b: 40 });
    expect(physical).toBe(150);
    expect(physical - allocated).toBe(30);
    expect(result.backlog).toEqual([]);
  });
  it('does not combine orders that only share the visible FS alias', () => {
    const common = { description: 'FS 5220 BROILER FIN PELLET II IN BULK', unit: 'MT' as const, bagWeightKg: null };
    const result = planInventoryDraft(createEmptyState(), [
      demand({ ...common, key: 'base', sourceOrderId: 'base', orderNo: 'BASE', itemId: 'item-a', materialCode: '7.03120085220000', quantity: 2 }),
      demand({ ...common, key: 'material', sourceOrderId: 'material', orderNo: 'MATERIAL', itemId: 'item-b', materialCode: '7.03130085220000', quantity: 2 }),
      demand({ ...common, key: 'variant', sourceOrderId: 'variant', orderNo: 'VARIANT', itemId: 'item-a', materialCode: '7.03120085220000', medication: 'MED-X', quantity: 2 }),
    ], { fromDate: FROM, toDate: FROM }, 3, NOW);
    expect(result.jobs).toHaveLength(3);
    expect(result.jobs.flatMap(job => job.sourceAllocations?.map(row => row.sourceOrderId) ?? [])).toEqual(['base', 'material', 'variant']);
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
