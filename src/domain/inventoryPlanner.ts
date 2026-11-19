import { getAvailableIntervals, getBoard, getRate, getScheduledJobs, getShiftWindow, getWorkingHoursForDate } from './engine';
import { LINE_IDS, type AppState, type LineId, type ScheduleSegment } from './types';
import type { CarryoverPlanningContext, DraftCarryover } from './dailyPlanning';
import { allocateCarryover, applyDraftCarryovers } from './carryoverPlanner';
import { getLinePreferenceTier } from './linePreferences';
export { applyDraftCarryovers } from './carryoverPlanner';
import type { InventoryDraftJob, InventoryDraftPreview, InventoryDraftRequest, InventoryPlanningDemandRow } from './inventoryTypes';

const MINUTE = 60_000;
const addDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const malaysiaDate = (timestamp: number) => new Date(timestamp + 8 * 60 * MINUTE).toISOString().slice(0, 10);
const identity = (row: { materialCode: string; medication?: string; fmrOmed?: string }) => [row.materialCode, row.medication ?? '', row.fmrOmed ?? ''].map(x => x.trim().toLowerCase()).join('\u0000');

/** Bounded, deterministic append-only draft. It never moves an existing task. */
export function planInventoryDraft(state: AppState, demands: InventoryPlanningDemandRow[], request: InventoryDraftRequest, revision: number, nowIso: string, context?: CarryoverPlanningContext): InventoryDraftPreview {
  const days: string[] = [];
  for (let date = request.fromDate; date <= request.toDate; date = addDay(date)) {
    if (days.length >= 31) throw new Error('Generate up to 31 planning days at a time.');
    days.push(date);
  }
  if (!days.length) throw new Error('Planning end date must follow the start date.');
  let workingState = state;
  const existing = getScheduledJobs(state);
  const cursor = Object.fromEntries(LINE_IDS.map(line => [line, Math.max(Date.parse(nowIso), ...existing.filter(j => j.lineId === line && j.status !== 'cancelled').map(j => j.plannedEnd ?? 0))])) as Record<LineId, number>;
  const previous = Object.fromEntries(LINE_IDS.map(line => {
    const last = existing.filter(j => j.lineId === line && j.status !== 'cancelled' && j.plannedEnd !== null).sort((a, b) => b.plannedEnd! - a.plannedEnd!)[0];
    return [line, last ? identity({ materialCode: last.productCode, medication: last.medication, fmrOmed: last.fmrOmed }) : ''];
  })) as Record<LineId, string>;
  const jobs: InventoryDraftJob[] = [], backlog: InventoryPlanningDemandRow[] = [];
  const carryovers: DraftCarryover[] = [], carryoverBacklog: InventoryDraftPreview['carryoverBacklog'] = [];
  const extraOccupied: ScheduleSegment[] = [];
  const extraVariants = new Map<string,string>();
  const draftEnds = new Map<string, number>();
  const ordered = [...demands].sort((a, b) => (a.purpose === 'mts' ? 1 : 0) - (b.purpose === 'mts' ? 1 : 0) || (a.priorityDate ?? a.dueDate).localeCompare(b.priorityDate ?? b.dueDate) || (a.priorityOrdinal ?? 0) - (b.priorityOrdinal ?? 0) || a.key.localeCompare(b.key));
  const work = ordered.map(demand => {
    const scale = demand.unit === 'Bags' ? 1 : 1000;
    const quantityScaled = Math.round(demand.quantity * scale);
    const allocationScaled = demand.sourceOrderId
      ? Math.min(quantityScaled, Math.round((demand.sourceAllocationQuantity ?? demand.quantity) * scale))
      : 0;
    return { demand, scale, allocationRemaining: allocationScaled, extraRemaining: quantityScaled - allocationScaled };
  });
  const queue = [
    ...demandBatches(work, request.combineSameProduct !== false).map(batch => ({ type: 'new' as const, batch, tier: batch[0].demand.purpose === 'mts' ? 2 : 1, priority: batch[0].demand.priorityDate ?? batch[0].demand.dueDate, ordinal: batch[0].demand.priorityOrdinal ?? 0 })),
    ...(context?.candidates ?? []).map(candidate => ({ type: 'carry' as const, candidate, tier: candidate.kind === 'continuation' ? 0 : 1, priority: candidate.priorityDate, ordinal: candidate.ordinal })),
  ].sort((a,b) => a.tier - b.tier || a.priority.localeCompare(b.priority) || a.ordinal - b.ordinal);
  for (const entry of queue) {
    if (entry.type === 'carry') {
      const result = allocateCarryover(workingState, entry.candidate, days, nowIso, extraOccupied, extraVariants);
      if (!result) { carryoverBacklog.push(entry.candidate); continue; }
      carryovers.push(result);
      workingState = applyDraftCarryovers(workingState, [result], nowIso);
      const scheduled = getScheduledJobs(workingState);
      for (const line of LINE_IDS) {
        cursor[line] = Math.max(Date.parse(nowIso), ...scheduled.filter(job => job.lineId === line).map(job => job.plannedEnd ?? 0), ...extraOccupied.filter(segment => segment.lineId === line).map(segment => segment.end));
        const last = scheduled.filter(job => job.lineId === line && job.plannedEnd !== null).sort((a,b) => b.plannedEnd! - a.plannedEnd!)[0];
        if (last && !extraOccupied.some(segment => segment.lineId === line && segment.end >= last.plannedEnd!)) previous[line] = identity({ materialCode: last.productCode, medication: last.medication, fmrOmed: last.fmrOmed });
      }
      if (result.kind === 'continuation') {
        const original = workingState.jobs.find(job => job.id === result.jobId)!;
        const plannedMt = result.segments.filter(segment => segment.kind === 'production').reduce((sum,segment) => sum + (segment.end-segment.start)/MINUTE,0) / 60 * getRate(state.settings,result.lineId,original.productCode);
        const plannedNative = result.unit === 'Bags' ? plannedMt * 1000 / (original.bagWeightKgSnapshot ?? state.settings.bagWeightKg) : plannedMt;
        const scale = result.unit === 'Bags' ? 1 : 1000;
        const unplanned = Math.max(0, Math.round((result.remainingQuantity - plannedNative) * scale) / scale);
        if (unplanned > 0) carryoverBacklog.push({ ...entry.candidate, remainingQuantity: unplanned });
      }
      continue;
    }
    const batch = entry.batch;
    const demand = batch[0].demand;
    const scale = batch[0].scale;
    const mtPerBase = demand.unit === 'Bags' ? (demand.bagWeightKg ?? 0) / 1000 : 1;
    if (mtPerBase <= 0) continue;
    const notBefore = Math.max(Date.parse(nowIso), ...batch.map(row => Date.parse(row.demand.notBefore)));
    while (batchRemaining(batch) > 0 && jobs.length < 2000) {
      const pendingAllocations = batch.filter(row => row.allocationRemaining > 0);
      const allocationWindow = pendingAllocations.slice(0, 500);
      const iterationLimit = pendingAllocations.length > allocationWindow.length
        ? allocationWindow.reduce((sum, row) => sum + row.allocationRemaining, 0)
        : batchRemaining(batch);
      const candidates: Array<{ date: string; lineId: LineId; quantity: number; start: number; end: number }> = [];
      for (const date of days) for (const lineId of LINE_IDS) {
        const settings = getWorkingHoursForDate(state.settings, date, lineId);
        const shift = getShiftWindow(settings, date);
        const start = Math.max(shift.start, cursor[lineId], notBefore);
        if (start >= shift.end) continue;
        const slots = getAvailableIntervals(state.settings, lineId, date)
          .map(interval => [Math.max(start, interval.start), interval.end] as [number, number])
          .filter(([slotStart, slotEnd]) => slotStart < slotEnd);
        const free = slots.reduce((sum, [a, b]) => sum + (b - a) / MINUTE, 0);
        const change = previous[lineId] && previous[lineId] !== identity(demand) ? state.settings.changeoverMinutes : 0;
        const rate = getRate(state.settings, lineId, demand.materialCode);
        const maxScaled = Math.floor(Math.max(0, free - change) / 60 * rate / mtPerBase * scale + 1e-7);
        const quantity = Math.min(iterationLimit, maxScaled) / scale;
        if (quantity <= 0) continue;
        const minutes = change + quantity * mtPerBase / rate * 60;
        let needed = minutes * MINUTE, finish = start;
        for (const [a, b] of slots) { const used = Math.min(needed, b - a); finish = a + used; needed -= used; if (needed < 0.01) break; }
        candidates.push({ date, lineId, quantity, start, end: finish });
      }
      candidates.sort((a, b) => a.date.localeCompare(b.date) || getLinePreferenceTier(state.settings, demand, a.lineId) - getLinePreferenceTier(state.settings, demand, b.lineId) || a.end - b.end || a.start - b.start || a.lineId.localeCompare(b.lineId));
      const best = candidates[0];
      if (!best) break;
      let capacity = Math.round(best.quantity * scale);
      const sourceAllocations: Array<{ sourceOrderId: string; plannedQuantity: number }> = [];
      for (const row of batch) {
        if (!capacity || !row.demand.sourceOrderId || row.allocationRemaining <= 0) continue;
        const consumed = Math.min(capacity, row.allocationRemaining);
        sourceAllocations.push({ sourceOrderId: row.demand.sourceOrderId, plannedQuantity: consumed / scale });
        row.allocationRemaining -= consumed;
        capacity -= consumed;
      }
      for (const row of batch) {
        if (!capacity || row.extraRemaining <= 0) continue;
        const consumed = Math.min(capacity, row.extraRemaining);
        row.extraRemaining -= consumed;
        capacity -= consumed;
      }
      const quantityScaled = Math.round(best.quantity * scale) - capacity;
      const firstOrder = sourceAllocations.length
        ? batch.find(row => row.demand.sourceOrderId === sourceAllocations[0].sourceOrderId)?.demand
        : null;
      const draftId = `draft-${jobs.length + 1}`;
      jobs.push({
        draftId,
        itemId: demand.itemId,
        sourceOrderId: sourceAllocations.length === 1 ? sourceAllocations[0].sourceOrderId : null,
        ...(sourceAllocations.length ? { sourceAllocations } : {}),
        orderNo: firstOrder?.orderNo ? `${firstOrder.orderNo}${sourceAllocations.length > 1 ? ` +${sourceAllocations.length - 1}` : ''}` : `STOCK-${demand.materialCode}`,
        materialCode: demand.materialCode,
        description: demand.description,
        unit: demand.unit,
        bagWeightKg: demand.bagWeightKg,
        productionPurpose: demand.purpose,
        date: best.date,
        lineId: best.lineId,
        quantity: quantityScaled / scale,
        notBefore: new Date(best.start).toISOString(),
        bin: '',
        remarks: '',
        medication: demand.medication,
        fmrOmed: demand.fmrOmed,
      });
      draftEnds.set(draftId, best.end);
      // Preserve already allocated draft capacity while later carryovers are considered.
      extraOccupied.push({ jobId: draftId, lineId: best.lineId, kind: 'production', start: best.start, end: best.end });
      extraVariants.set(draftId, identity(demand));
      cursor[best.lineId] = best.end;
      previous[best.lineId] = identity(demand);
    }
  }
  for (const row of work) {
    const remaining = row.allocationRemaining + row.extraRemaining;
    if (remaining > 0) backlog.push({ ...row.demand, quantity: remaining / row.scale, ...(row.demand.sourceOrderId ? { sourceAllocationQuantity: row.allocationRemaining / row.scale } : {}) });
  }
  const utilization = days.flatMap(date => getBoard(workingState, date).lines.map(line => {
    const extra = jobs.filter(j => j.date === date && j.lineId === line.lineId).reduce((sum, j) => sum + (j.unit === 'Bags' ? j.quantity * j.bagWeightKg! / 1000 : j.quantity) / getRate(state.settings, line.lineId, j.materialCode), 0);
    return { date, lineId: line.lineId, hours: line.productionMinutes / 60 + extra, availableHours: line.availableMinutes / 60 };
  }));
  const late = ordered.flatMap(d => {
    const matched = jobs.filter(j => j.itemId === d.itemId && (j.sourceOrderId === d.sourceOrderId || j.sourceAllocations?.some(row => row.sourceOrderId === d.sourceOrderId)) && j.productionPurpose === d.purpose);
    const plannedEnd = Math.max(...matched.map(job => draftEnds.get(job.draftId) ?? Number.NEGATIVE_INFINITY));
    const plannedDate = Number.isFinite(plannedEnd) ? malaysiaDate(plannedEnd) : null;
    const unplanned = backlog.find(b => b.key === d.key)?.quantity ?? 0;
    return unplanned > 0 || plannedDate && plannedDate > d.dueDate ? [{ key: d.key, dueDate: d.dueDate, plannedDate, quantity: unplanned || d.quantity }] : [];
  });
  return { revision, generatedAt: nowIso, request, demand: ordered, jobs, backlog, utilization, late, carryovers, carryoverBacklog };
}

type DemandWork = {
  demand: InventoryPlanningDemandRow;
  scale: number;
  allocationRemaining: number;
  extraRemaining: number;
};

function demandBatches(rows: DemandWork[], combine: boolean): DemandWork[][] {
  if (!combine) return rows.map(row => [row]);
  const result: DemandWork[][] = [];
  let previousKey: string | null = null;
  for (const row of rows) {
    if (row.demand.purpose !== 'mto' || !row.demand.sourceOrderId) {
      result.push([row]);
      previousKey = null;
      continue;
    }
    const key = JSON.stringify([
      row.demand.priorityDate ?? row.demand.dueDate,
      row.demand.dueDate,
      row.demand.itemId,
      row.demand.materialCode.trim().toLowerCase(),
      row.demand.unit,
      row.demand.bagWeightKg,
      identity(row.demand),
    ]);
    // Preserve admission order: a later compatible order cannot jump over
    // another product merely to make a larger physical batch.
    const batch = previousKey === key ? result.at(-1) : undefined;
    if (batch) batch.push(row);
    else {
      const created = [row];
      result.push(created);
    }
    previousKey = key;
  }
  return result;
}

function batchRemaining(batch: DemandWork[]): number {
  return batch.reduce((sum, row) => sum + row.allocationRemaining + row.extraRemaining, 0);
}
