import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getScheduledJobs } from '../domain/engine';
import { useWorkspace } from '../lib/workspace';

/** Old-calendar reservations can fall outside the new 12-hour display window. */
export function LegacyCarryoverNotice() {
  const { state, board, openJob } = useWorkspace();
  const outside = useMemo(() => {
    const cutover = state.settings.calendarCutover;
    if (!cutover || board.date < cutover.effectiveFrom) return [];
    const start = Date.parse(board.date + 'T00:00:00+08:00'), end = start + 86_400_000;
    return getScheduledJobs(state).filter(job => job.date <= board.date && job.segments.some(segment =>
      segment.kind === 'production' && segment.start < end && segment.end > start &&
      (Math.max(segment.start, start) < board.start || Math.min(segment.end, end) > board.end),
    ));
  }, [state, board.date, board.start, board.end]);
  if (!outside.length) return null;
  return <div className="notice warning legacy-carryover"><AlertTriangle size={16}/><div><strong>{outside.length} retained plan{outside.length === 1 ? '' : 's'} extend outside this shift.</strong><p>These reservations use the earlier calendar or a locked plan. Open a card to review its complete dates and times.</p><div>{outside.map(job => <button className="text-link" key={job.id} onClick={() => openJob(job.id)}>{job.lineId} · {job.productCode}</button>)}</div></div></div>;
}
