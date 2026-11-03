import { timeLabel } from '../lib/format';
import './PlanningNow.css';

/** A shared, non-interactive marker; it never changes the saved schedule. */
export function PlanningNow({ now, start, end, label = false }: { now: number; start: number; end: number; label?: boolean }) {
  if (!Number.isFinite(now) || end <= start || now < start || now >= end) return null;
  const position = (now - start) / (end - start) * 100;
  return <span data-now-marker className={`planning-now${label ? ' with-label' : ''}${position < 6 ? ' near-start' : position > 94 ? ' near-end' : ''}`} style={{ left: `${position}%` }} aria-hidden="true">
    {label && <span>Now {timeLabel(now)}</span>}
  </span>;
}
