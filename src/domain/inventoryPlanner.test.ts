import { describe, expect, it } from 'vitest';
import { createEmptyState } from './defaults';
import { createJob, getScheduledJobs, updateSettings } from './engine';
import { planInventoryDraft } from './inventoryPlanner';
import type { InventoryPlanningDemandRow } from './inventoryTypes';

const FROM = '2026-10-26', NOW = '2026-10-25T00:00:00Z';
const demand = (patch: Partial<InventoryPlanningDemandRow> = {}): InventoryPlanningDemandRow => ({ key: 'order-1', itemId: 'item-1', materialCode: '7.9999000000025', description: 'Feed', unit: 'Bags', bagWeightKg: 25, strategy: 'mto', purpose: 'mto', sourceOrderId: 'order-1', orderNo: 'DO1', dueDate: FROM, notBefore: `${FROM}T07:00:00+08:00`, quantity: 100, medication: '', fmrOmed: '', ...patch });
describe('inventory draft scheduling', () => {
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
});
