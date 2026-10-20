import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { ScheduledJob } from '../domain/types';
import { getProductionResult } from '../domain/production-results';
import { useWorkspace } from '../lib/workspace';
import { useCurrentTime } from '../lib/useCurrentTime';
import { stopDurationLabel, fullDateTime } from '../lib/format';
import './ProductionStops.css';

export function ProductionStops({ job }: { job: ScheduledJob }) {
  const { commit, mutationLocked, hasConflict, toast } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const now = useCurrentTime(job.status === 'running');
  const result = getProductionResult(job, now);
  const pauses = job.pauseIntervals ?? [];
  useEffect(() => { if (failed && toast?.error) setError(toast.message); }, [failed, toast]);
  if (job.status !== 'running' && job.status !== 'completed') return null;

  async function savePause(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim() || mutationLocked || hasConflict) return;
    setFailed(false); setError('');
    if (await commit({ type: 'job.pause', jobId: job.id, reason: reason.trim() }, 'Production paused. Stop time and reason recorded.')) {
      setEditing(false); setReason('');
    } else setFailed(true);
  }
  return <section className="drawer-section production-stops" aria-labelledby="production-stops-title">
    <div className="drawer-section-title"><Pause size={16}/><h3 id="production-stops-title">Stops & runtime</h3>{result.isPaused && <span className="stop-state">Paused</span>}</div>
    <div className="stop-totals"><div><span>Recorded downtime</span><strong data-stop-total>{stopDurationLabel(result.downtimeMinutes)}</strong></div><div><span>Elapsed minus recorded stops</span><strong>{result.netProductionMinutes === null ? '—' : stopDurationLabel(result.netProductionMinutes)}</strong></div></div>
    <p className="field-help">Only recorded pauses are deducted. Planned times stay locked; this is not a measurement of productive time or OEE.</p>
    {job.status === 'running' && <div className="stop-actions">
      {result.isPaused ? <button type="button" className="button primary full-width" disabled={mutationLocked || hasConflict} onClick={async () => {
        setFailed(false); setError('');
        if (!await commit({ type: 'job.resume', jobId: job.id }, 'Production resumed. Stop duration recorded.')) setFailed(true);
      }}><Play size={15}/>Resume production</button> : editing ? <form aria-label="Pause production" onSubmit={savePause}>
        <label className="field">Reason for pause<textarea autoFocus required maxLength={1000} rows={2} disabled={mutationLocked || hasConflict} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Material shortage or machine adjustment"/></label>
        <p className="field-help">Confirm pause records the current time. The task keeps its production line.</p>
        <div className="stop-form-actions"><button type="button" className="button secondary" disabled={mutationLocked} onClick={() => { setEditing(false); setError(''); }}>Cancel pause</button><button type="submit" className="button secondary stop-pause-button" disabled={mutationLocked || hasConflict || !reason.trim()}><Pause size={15}/>Confirm pause</button></div>
      </form> : <button type="button" className="button secondary full-width stop-pause-button" disabled={mutationLocked || hasConflict} onClick={() => setEditing(true)}><Pause size={15}/>Pause production</button>}
    </div>}
    {failed && error && <p role="alert" className="stop-error">{error}</p>}
    {pauses.length ? <details className="stop-history" open={result.isPaused || undefined}><summary>{pauses.length} recorded {pauses.length === 1 ? 'pause' : 'pauses'}</summary><ol>{[...pauses].reverse().map((pause, index) => {
      const minutes = Math.max(0, ((pause.resumedAt ? Date.parse(pause.resumedAt) : now) - Date.parse(pause.pausedAt)) / 60_000);
      return <li key={pause.pausedAt + '-' + index}><div><strong>{pause.reason}</strong><span>{stopDurationLabel(minutes)}{!pause.resumedAt && ' · Ongoing'}</span></div><small>{fullDateTime(pause.pausedAt)} → {pause.resumedAt ? fullDateTime(pause.resumedAt) : 'Awaiting resume or completion'}</small></li>;
    })}</ol></details> : <p className="stop-empty">No pauses recorded for this task.</p>}
  </section>;
}
