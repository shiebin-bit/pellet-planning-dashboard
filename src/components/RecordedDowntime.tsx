import { Pause } from 'lucide-react';
import { getDowntimeMinutesForWindow, isJobPaused } from '../domain/production-results';
import { useWorkspace } from '../lib/workspace';
import { useCurrentTime } from '../lib/useCurrentTime';
import { stopDurationLabel } from '../lib/format';
import './RecordedDowntime.css';

export function RecordedDowntime() {
  const { state, board } = useWorkspace();
  const now = useCurrentTime(state.jobs.some(isJobPaused));
  const total = getDowntimeMinutesForWindow(state.jobs, board.start, board.end, now);
  const open = state.jobs.filter(job => isJobPaused(job) && Math.max(board.start, Date.parse(job.pauseIntervals!.at(-1)!.pausedAt)) < Math.min(board.end, now));
  return <section className="panel recorded-downtime" aria-label="Recorded downtime for selected planning day">
    <div><span className="downtime-icon"><Pause size={17}/></span><div><h2>Recorded downtime</h2><p>Selected planning day · summed across mills · recorded pauses only</p></div></div>
    <strong data-daily-downtime>{stopDurationLabel(total)}</strong>
    <div className="downtime-lines">{board.lines.map(line => <span key={line.lineId}>{line.lineId}<strong>{stopDurationLabel(getDowntimeMinutesForWindow(state.jobs, board.start, board.end, now, line.lineId))}</strong></span>)}</div>
    {open.length > 0 && <span className="downtime-open">{open.length} ongoing {open.length === 1 ? 'pause' : 'pauses'}</span>}
  </section>;
}
