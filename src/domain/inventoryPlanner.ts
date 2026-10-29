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
  for (const demand of ordered) {
    let remaining = Math.round(demand.quantity * (demand.unit === 'Bags' ? 1 : 1000));
    const scale = demand.unit === 'Bags' ? 1 : 1000;
    let allocationRemaining = demand.sourceOrderId ? Math.round((demand.sourceAllocationQuantity ?? demand.quantity) * scale) : 0;
    const mtPerBase = demand.unit === 'Bags' ? (demand.bagWeightKg ?? 0) / 1000 : 1;
    if (mtPerBase <= 0) { backlog.push({ ...demand }); continue; }
    while (remaining > 0 && jobs.length < 2000) {
      const candidates: Array<{ date: string; lineId: LineId; quantity: number; start: number; end: number }> = [];
      for (const date of days) for (const lineId of LINE_IDS) {
        const settings = getCalendarForDate(state.settings, date);
        const start = Math.max(dayAt(date, settings.dayStart), cursor[lineId], Date.parse(demand.notBefore));
        const end = dayAt(date, settings.dayStart) + settings.availableHours * 60 * MINUTE;
        if (start >= end) continue;
        const slots = freeSlots(start, end, settings.downtime.filter(d => d.date === date && (d.lineId === 'all' || d.lineId === lineId)).map(d => [dayAt(date, d.start), dayAt(date, d.end) <= dayAt(date, d.start) ? dayAt(addDay(date), d.end) : dayAt(date, d.end)]));
        const free = slots.reduce((sum, [a, b]) => sum + (b - a) / MINUTE, 0);
        const change = previous[lineId] && previous[lineId] !== identity(demand) ? settings.changeoverMinutes : 0;
        const rate = getRate(state.settings, lineId, demand.materialCode);
        const maxScaled = Math.floor(Math.max(0, free - change) / 60 * rate / mtPerBase * scale + 1e-7);
        const quantity = Math.min(remaining, maxScaled) / scale;
        if (quantity <= 0) continue;
        const minutes = change + quantity * mtPerBase / rate * 60;
        let needed = minutes * MINUTE, finish = start;
        for (const [a, b] of slots) { const used = Math.min(needed, b - a); finish = a + used; needed -= used; if (needed < 0.01) break; }
        candidates.push({ date, lineId, quantity, start, end: finish });
      }
      candidates.sort((a, b) => a.start - b.start || a.end - b.end || a.lineId.localeCompare(b.lineId));
      const best = candidates[0];
      if (!best) break;
      const allocationScaled = Math.min(Math.round(best.quantity * scale), allocationRemaining);
      const allocationQuantity = allocationScaled / scale;
      const draft: InventoryDraftJob = { draftId: `draft-${jobs.length + 1}`, itemId: demand.itemId, sourceOrderId: allocationQuantity > 0 ? demand.sourceOrderId : null, ...(demand.sourceOrderId && allocationQuantity > 0 ? { sourceAllocations: [{ sourceOrderId: demand.sourceOrderId, plannedQuantity: allocationQuantity }] } : {}), orderNo: demand.orderNo ?? `STOCK-${demand.materialCode}`, materialCode: demand.materialCode, description: demand.description, unit: demand.unit, bagWeightKg: demand.bagWeightKg, productionPurpose: demand.purpose, date: best.date, lineId: best.lineId, quantity: best.quantity, notBefore: new Date(best.start).toISOString(), bin: '', remarks: '', medication: demand.medication, fmrOmed: demand.fmrOmed };
      const prior = [...jobs].reverse().find(job => job.date === draft.date && job.lineId === draft.lineId);
      if (prior && draftAllocations(prior).length > 0 && draftAllocations(prior).length < 500 && canCombineDrafts(prior, draft) && demand.sourceOrderId && allocationQuantity > 0 && !draftAllocationIds(prior).has(demand.sourceOrderId)) {
        const allocations = [...draftAllocations(prior), { sourceOrderId: demand.sourceOrderId, plannedQuantity: allocationQuantity }];
        prior.sourceOrderId = null;
        prior.sourceAllocations = allocations;
        prior.quantity += best.quantity;
        prior.orderNo = `${prior.orderNo.split(' +')[0]} +${allocations.length - 1}`;
      } else {
        jobs.push(draft);
      }
      remaining -= Math.round(best.quantity * scale);
      allocationRemaining -= allocationScaled;
      cursor[best.lineId] = best.end;
      previous[best.lineId] = identity(demand);
    }
    if (remaining > 0) backlog.push({ ...demand, quantity: remaining / scale, ...(demand.sourceOrderId ? { sourceAllocationQuantity: allocationRemaining / scale } : {}) });
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

function draftAllocations(job: InventoryDraftJob): Array<{ sourceOrderId: string; plannedQuantity: number }> {
  return job.sourceAllocations?.length ? job.sourceAllocations : job.sourceOrderId ? [{ sourceOrderId: job.sourceOrderId, plannedQuantity: job.quantity }] : [];
}

function draftAllocationIds(job: InventoryDraftJob): Set<string> {
  return new Set(draftAllocations(job).map(row => row.sourceOrderId));
}

function canCombineDrafts(left: InventoryDraftJob, right: InventoryDraftJob): boolean {
  return left.productionPurpose === 'mto' && right.productionPurpose === 'mto' && left.date === right.date && left.lineId === right.lineId &&
    left.itemId === right.itemId && left.unit === right.unit && left.bagWeightKg === right.bagWeightKg &&
    identity(left) === identity(right);
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
