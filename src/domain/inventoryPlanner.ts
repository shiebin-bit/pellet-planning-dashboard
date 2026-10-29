import { getCalendarForDate, getRate, getScheduledJobs, getBoard } from './engine';
import { LINE_IDS, type AppState, type LineId } from './types';
import type { InventoryDraftJob, InventoryDraftPreview, InventoryDraftRequest, InventoryPlanningDemandRow } from './inventoryTypes';

const MINUTE = 60_000;
const dayAt = (date: string, time: string) => Date.parse(`${date}T${time}:00+08:00`);
const addDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const identity = (row: { materialCode: string; medication?: string; fmrOmed?: string }) => [row.materialCode, row.medication ?? '', row.fmrOmed ?? ''].map(x => x.trim().toLowerCase()).join('\u0000');

/** Bounded, deterministic append-only draft. It never moves an existing task. */
export function planInventoryDraft(state: AppState, demands: InventoryPlanningDemandRow[], request: InventoryDraftRequest, revision: number, nowIso: string): InventoryDraftPreview {
  const days: string[] = [];
  for (let date = request.fromDate; date <= request.toDate; date = addDay(date)) {
    if (days.length >= 31) throw new Error('Generate up to 31 planning days at a time.');
    days.push(date);
  }
  if (!days.length) throw new Error('Planning end date must follow the start date.');
  const existing = getScheduledJobs(state);
  const cursor = Object.fromEntries(LINE_IDS.map(line => [line, Math.max(Date.parse(nowIso), ...existing.filter(j => j.lineId === line && j.status !== 'cancelled').map(j => j.plannedEnd ?? 0))])) as Record<LineId, number>;
  const previous = Object.fromEntries(LINE_IDS.map(line => {
    const last = existing.filter(j => j.lineId === line && j.status !== 'cancelled' && j.plannedEnd !== null).sort((a, b) => b.plannedEnd! - a.plannedEnd!)[0];
    return [line, last ? identity({ materialCode: last.productCode, medication: last.medication, fmrOmed: last.fmrOmed }) : ''];
  })) as Record<LineId, string>;
  const jobs: InventoryDraftJob[] = [], backlog: InventoryPlanningDemandRow[] = [];
  const ordered = [...demands].sort((a, b) => (a.purpose === 'mts' ? 1 : 0) - (b.purpose === 'mts' ? 1 : 0) || a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
  const work = ordered.map(demand => {
    const scale = demand.unit === 'Bags' ? 1 : 1000;
    const quantityScaled = Math.round(demand.quantity * scale);
    const allocationScaled = demand.sourceOrderId
      ? Math.min(quantityScaled, Math.round((demand.sourceAllocationQuantity ?? demand.quantity) * scale))
      : 0;
    return { demand, scale, allocationRemaining: allocationScaled, extraRemaining: quantityScaled - allocationScaled };
  });
  for (const batch of demandBatches(work, request.combineSameProduct !== false)) {
    const demand = batch[0].demand;
    const scale = batch[0].scale;
    const mtPerBase = demand.unit === 'Bags' ? (demand.bagWeightKg ?? 0) / 1000 : 1;
    if (mtPerBase <= 0) continue;
    const notBefore = Math.max(...batch.map(row => Date.parse(row.demand.notBefore)));
    while (batchRemaining(batch) > 0 && jobs.length < 2000) {
      const pendingAllocations = batch.filter(row => row.allocationRemaining > 0);
      const allocationWindow = pendingAllocations.slice(0, 500);
      const iterationLimit = pendingAllocations.length > allocationWindow.length
        ? allocationWindow.reduce((sum, row) => sum + row.allocationRemaining, 0)
        : batchRemaining(batch);
      const candidates: Array<{ date: string; lineId: LineId; quantity: number; start: number; end: number }> = [];
      for (const date of days) for (const lineId of LINE_IDS) {
        const settings = getCalendarForDate(state.settings, date);
        const start = Math.max(dayAt(date, settings.dayStart), cursor[lineId], notBefore);
        const end = dayAt(date, settings.dayStart) + settings.availableHours * 60 * MINUTE;
        if (start >= end) continue;
        const slots = freeSlots(start, end, settings.downtime.filter(d => d.date === date && (d.lineId === 'all' || d.lineId === lineId)).map(d => [dayAt(date, d.start), dayAt(date, d.end) <= dayAt(date, d.start) ? dayAt(addDay(date), d.end) : dayAt(date, d.end)]));
        const free = slots.reduce((sum, [a, b]) => sum + (b - a) / MINUTE, 0);
        const change = previous[lineId] && previous[lineId] !== identity(demand) ? settings.changeoverMinutes : 0;
        const rate = getRate(state.settings, lineId, demand.materialCode);
        const maxScaled = Math.floor(Math.max(0, free - change) / 60 * rate / mtPerBase * scale + 1e-7);
        const quantity = Math.min(iterationLimit, maxScaled) / scale;
        if (quantity <= 0) continue;
        const minutes = change + quantity * mtPerBase / rate * 60;
        let needed = minutes * MINUTE, finish = start;
        for (const [a, b] of slots) { const used = Math.min(needed, b - a); finish = a + used; needed -= used; if (needed < 0.01) break; }
        candidates.push({ date, lineId, quantity, start, end: finish });
      }
      candidates.sort((a, b) => a.start - b.start || a.end - b.end || a.lineId.localeCompare(b.lineId));
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
      jobs.push({
        draftId: `draft-${jobs.length + 1}`,
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
      cursor[best.lineId] = best.end;
      previous[best.lineId] = identity(demand);
    }
  }
  for (const row of work) {
    const remaining = row.allocationRemaining + row.extraRemaining;
    if (remaining > 0) backlog.push({ ...row.demand, quantity: remaining / row.scale, ...(row.demand.sourceOrderId ? { sourceAllocationQuantity: row.allocationRemaining / row.scale } : {}) });
  }
  const utilization = days.flatMap(date => getBoard(state, date).lines.map(line => {
    const extra = jobs.filter(j => j.date === date && j.lineId === line.lineId).reduce((sum, j) => sum + (j.unit === 'Bags' ? j.quantity * j.bagWeightKg! / 1000 : j.quantity) / getRate(state.settings, line.lineId, j.materialCode), 0);
    return { date, lineId: line.lineId, hours: line.productionMinutes / 60 + extra, availableHours: line.availableMinutes / 60 };
  }));
  const late = ordered.flatMap(d => {
    const matched = jobs.filter(j => j.itemId === d.itemId && (j.sourceOrderId === d.sourceOrderId || j.sourceAllocations?.some(row => row.sourceOrderId === d.sourceOrderId)) && j.productionPurpose === d.purpose);
    const plannedDate = matched.at(-1)?.date ?? null;
    const unplanned = backlog.find(b => b.key === d.key)?.quantity ?? 0;
    return unplanned > 0 || plannedDate && plannedDate > d.dueDate ? [{ key: d.key, dueDate: d.dueDate, plannedDate, quantity: unplanned || d.quantity }] : [];
  });
  return { revision, generatedAt: nowIso, request, demand: ordered, jobs, backlog, utilization, late };
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
  const byKey = new Map<string, DemandWork[]>();
  for (const row of rows) {
    if (row.demand.purpose !== 'mto' || !row.demand.sourceOrderId) {
      result.push([row]);
      continue;
    }
    const key = JSON.stringify([
      row.demand.dueDate,
      row.demand.itemId,
      row.demand.materialCode.trim().toLowerCase(),
      row.demand.unit,
      row.demand.bagWeightKg,
      identity(row.demand),
    ]);
    const batch = byKey.get(key);
    if (batch) batch.push(row);
    else {
      const created = [row];
      byKey.set(key, created);
      result.push(created);
    }
  }
  return result;
}

function batchRemaining(batch: DemandWork[]): number {
  return batch.reduce((sum, row) => sum + row.allocationRemaining + row.extraRemaining, 0);
}

function freeSlots(start: number, end: number, blocked: number[][]): number[][] {
  let cursor = start;
  const slots: number[][] = [];
  for (const [a, b] of blocked.sort((x, y) => x[0] - y[0])) {
    if (b <= cursor || a >= end) continue;
    if (a > cursor) slots.push([cursor, Math.min(a, end)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) slots.push([cursor, end]);
  return slots;
}
