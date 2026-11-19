import { getAvailableIntervals, getRate, getScheduledJobs } from './engine';
import { preferredLinesForProduct } from './linePreferences';
import type { CarryoverCandidate, DraftCarryover } from './dailyPlanning';
import { LINE_IDS, type AppState, type ScheduleSegment } from './types';

const MINUTE = 60_000;

/** Apply a trusted preview without changing original actuals, allocations or locks. */
export function applyDraftCarryovers(state: AppState, rows: DraftCarryover[], plannedAt = new Date().toISOString()): AppState {
  if (!rows.length) return state;
  const jobs = state.jobs.map(job => ({ ...job }));
  const involved = new Set(rows.map(row => row.jobId));
  // Removing an obsolete unlocked spill must not pull confirmed later cards
  // forward. Preserve their existing release position before applying carries.
  for (const scheduled of getScheduledJobs(state)) {
    if (involved.has(scheduled.id) || scheduled.status !== 'pending' || scheduled.plannedStart === null || (scheduled.plannedEnd ?? 0) <= Date.parse(plannedAt)) continue;
    const index = jobs.findIndex(job => job.id === scheduled.id);
    const floor = Math.max(scheduled.plannedStart, Date.parse(jobs[index].notBefore ?? '1970-01-01T00:00:00Z'));
    jobs[index] = { ...jobs[index], notBefore: new Date(floor).toISOString() };
  }
  for (const row of rows) {
    const index = jobs.findIndex(job => job.id === row.jobId);
    if (index < 0) throw new Error(`Carryover card ${row.jobId} no longer exists.`);
    const job = jobs[index];
    if (row.kind === 'reschedule') {
      if (job.status !== 'pending' || job.actualStart || job.lockedSegments?.length) throw new Error('Started production must continue on its original card and line.');
      const sequence = Math.max(0, ...jobs.filter(other => other.id !== job.id && other.date === row.date && other.lineId === row.lineId).map(other => other.sequence)) + 1;
      const { continuationPlan: _old, ...original } = job;
      jobs[index] = { ...original, date: row.date, lineId: row.lineId, sequence, notBefore: row.notBefore, binNeedsReview: job.binNeedsReview || job.lineId !== row.lineId };
    } else {
      if (row.lineId !== job.lineId) throw new Error('Continuation must retain the original PM.');
      const remainingMt = row.unit === 'Bags' ? row.remainingQuantity * (job.bagWeightKgSnapshot ?? state.settings.bagWeightKg) / 1000 : row.remainingQuantity;
      const minutes = row.segments.filter(segment => segment.kind === 'production').reduce((sum, segment) => sum + (segment.end - segment.start) / MINUTE, 0);
      jobs[index] = { ...job, continuationPlan: { remainingQuantityMt: Math.min(remainingMt, minutes / 60 * getRate(state.settings, job.lineId, job.productCode)), plannedAt, segments: row.segments.map(segment => ({ ...segment })) } };
    }
  }
  return { ...state, jobs };
}

/** Reserve original-card work around all confirmed cards. Pending cards remain whole. */
export function allocateCarryover(state: AppState, candidate: CarryoverCandidate, days: string[], nowIso: string, extraOccupied: ScheduleSegment[] = [], extraVariants: ReadonlyMap<string,string> = new Map()): DraftCarryover | null {
  const job = state.jobs.find(row => row.id === candidate.jobId);
  if (!job) return null;
  const existing = getScheduledJobs(state);
  const mtPerBase = candidate.unit === 'Bags' ? (job.bagWeightKgSnapshot ?? state.settings.bagWeightKg) / 1000 : 1;
  const preferred = preferredLinesForProduct(state.settings, { description: job.description, productCode: job.productCode, mode: job.mode });
  const now = Date.parse(nowIso);
  const variant = (id: string) => {
    const owner = state.jobs.find(row => row.id === id);
    return owner ? [owner.productCode, owner.medication ?? '', owner.fmrOmed ?? ''].map(value => value.trim().toLowerCase()).join('\0') : extraVariants.get(id) ?? id;
  };
  if (candidate.kind === 'continuation') {
    const rate = getRate(state.settings, job.lineId, job.productCode);
    let remaining = candidate.remainingQuantity;
    const segments: ScheduleSegment[] = [];
    const occupied = [...existing.flatMap(row => row.segments).flatMap(segment => {
      if (segment.jobId !== job.id) return [segment];
      if (job.continuationPlan?.segments.some(old => old.start === segment.start && old.end === segment.end)) return [];
      if (job.lockedSegments?.length) return [segment];
      return segment.start < now ? [{ ...segment, end: Math.min(segment.end, now) }] : [];
    }), ...extraOccupied];
    let firstPlanningDate: string | null = null;
    const scale = candidate.unit === 'Bags' ? 1 : 1000;
    for (const date of days) for (const slot of freeSlots(state, job.lineId, date, occupied, now)) {
      if (remaining <= 0) break;
      const before = [...occupied, ...segments].filter(segment => segment.lineId === job.lineId && segment.end <= slot.start).sort((a,b) => b.end - a.end)[0];
      const after = occupied.filter(segment => segment.lineId === job.lineId && segment.start >= slot.end).sort((a,b) => a.start - b.start)[0];
      const prefix = before && variant(before.jobId) !== variant(job.id) ? state.settings.changeoverMinutes * MINUTE : 0;
      // Inserting into a gap must also preserve the already-confirmed next card.
      const suffix = after && after.kind !== 'changeover' && variant(after.jobId) !== variant(job.id) ? state.settings.changeoverMinutes * MINUTE : 0;
      const free = Math.max(0, slot.end - slot.start - prefix - suffix);
      const quantity = Math.min(remaining, Math.floor(free / MINUTE / 60 * rate / mtPerBase * scale + 1e-7) / scale);
      if (quantity <= 0) continue;
      firstPlanningDate ??= date;
      let cursor = slot.start;
      if (prefix) { segments.push({jobId:job.id,lineId:job.lineId,kind:'changeover',start:cursor,end:cursor+prefix}); cursor += prefix; }
      const runtime = quantity * mtPerBase / rate * 60 * MINUTE;
      segments.push({jobId:job.id,lineId:job.lineId,kind:'production',start:cursor,end:cursor+runtime}); cursor += runtime;
      if (suffix) segments.push({jobId:job.id,lineId:job.lineId,kind:'changeover',start:cursor,end:cursor+suffix});
      remaining = Math.max(0, Math.round((remaining - quantity) * scale) / scale);
    }
    if (!segments.length) return null;
    return { ...candidate, date: firstPlanningDate!, lineId: job.lineId, notBefore: new Date(segments[0].start).toISOString(), segments };
  }
  const candidates: DraftCarryover[] = [];
  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) for (const lineId of LINE_IDS) {
    const other = existing.filter(row => row.id !== job.id && row.lineId === lineId);
    const occupied = [...other.flatMap(row => row.segments), ...extraOccupied];
    const end = Math.max(now, ...occupied.filter(segment => segment.lineId === lineId).map(segment => segment.end));
    const last = occupied.filter(segment => segment.lineId === lineId).sort((a,b) => b.end-a.end)[0];
    const changed = last && variant(last.jobId) !== variant(job.id);
    let change = changed ? state.settings.changeoverMinutes * MINUTE : 0;
    let needed = candidate.remainingQuantity * mtPerBase / getRate(state.settings, lineId, job.productCode) * 60 * MINUTE;
    const segments: ScheduleSegment[] = [];
    let firstPlanningDate: string | null = null;
    for (const date of days.slice(dayIndex)) {
      for (const slot of freeSlots(state, lineId, date, occupied, end)) {
        firstPlanningDate ??= date;
        let cursor = slot.start;
        if (change > 0) { const used = Math.min(change, slot.end - cursor); segments.push({ jobId: job.id, lineId, kind: 'changeover', start: cursor, end: cursor + used }); cursor += used; change -= used; }
        if (cursor < slot.end && needed > 0) { const used = Math.min(needed, slot.end - cursor); segments.push({ jobId: job.id, lineId, kind: 'production', start: cursor, end: cursor + used }); needed -= used; }
        if (needed < 0.001 && change < 0.001) break;
      }
      if (needed < 0.001 && change < 0.001) break;
    }
    if (segments.length && needed < 0.001 && change < 0.001) candidates.push({ ...candidate, date: firstPlanningDate!, lineId, notBefore: new Date(segments[0].start).toISOString(), segments });
  }
  candidates.sort((a,b) => a.date.localeCompare(b.date) || Number(!preferred.includes(a.lineId)) - Number(!preferred.includes(b.lineId)) || a.segments.at(-1)!.end - b.segments.at(-1)!.end || a.lineId.localeCompare(b.lineId));
  return candidates[0] ?? null;
}

function freeSlots(state: AppState, line: typeof LINE_IDS[number], date: string, occupied: ScheduleSegment[], floor: number): Array<{start:number;end:number}> {
  let slots = getAvailableIntervals(state.settings, line, date).map(slot => ({ start: Math.max(slot.start, floor), end: slot.end })).filter(slot => slot.start < slot.end);
  for (const busy of occupied.filter(segment => segment.lineId === line).sort((a,b) => a.start - b.start)) {
    slots = slots.flatMap(slot => busy.end <= slot.start || busy.start >= slot.end ? [slot] : [{ start: slot.start, end: Math.min(slot.end, busy.start) }, { start: Math.max(slot.start, busy.end), end: slot.end }].filter(part => part.start < part.end));
  }
  return slots;
}
