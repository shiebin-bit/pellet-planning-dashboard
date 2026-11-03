import { PROGRESS_MAX_SAMPLE_AGE_MINUTES } from '../domain/productionProgress';
import type { JobProductionProgress } from '../domain/productionProgress';
import { durationLabel, fullDateTime, numberLabel } from '../lib/format';
import { useLiveProduction } from '../lib/liveProduction';
import './LiveProduction.css';

export function receiptProgressLabel(progress: JobProductionProgress) {
  const digits = progress.unit === 'Bags' ? 0 : 3;
  return `${numberLabel(progress.actualTotal ?? 0, digits)} / ${numberLabel(progress.plannedTotal, digits)} ${progress.unit}`;
}

export function LiveProduction({ jobId, compact = false }: { jobId: string; compact?: boolean }) {
  const { jobs, stale, loading, error, retry, now } = useLiveProduction();
  const progress = jobs.get(jobId);
  if (!progress || progress.actualTotal === null) {
    if (compact) return null;
    return <div className="live-production-note">{loading ? 'Loading production progress…' : error || 'Stock receipt progress is unavailable for this production.'}{error && <button type="button" className="text-link" onClick={retry}>Retry progress</button>}</div>;
  }
  const ratio = progress.plannedTotal > 0 ? Math.max(0, Math.min(1, progress.actualTotal / progress.plannedTotal)) : 0;
  const latestSample = Math.max(...progress.samples.filter(sample => sample.trustworthy).map(sample => Date.parse(sample.sampledAt)));
  const estimate = !stale && progress.estimate && now >= latestSample && now - latestSample <= PROGRESS_MAX_SAMPLE_AGE_MINUTES * 60_000 ? progress.estimate : null;
  const unavailable = progress.estimateUnavailableReason === 'paused' ? 'Paused · estimate resumes after production continues.'
    : progress.estimateUnavailableReason === 'target-reached' ? 'Planned quantity received. Confirm Done when production finishes.'
    : progress.estimateUnavailableReason === 'not-running' ? ''
    : progress.estimateUnavailableReason === 'stale-sample' ? 'A recent output record is needed to estimate the finish.'
    : 'More current-time output records are needed to estimate the finish.';
  const Container = compact ? 'span' : 'div';
  return <Container className={`live-production${compact ? ' compact' : ''}${stale ? ' is-stale' : ''}`}>
    <span className="live-production-total"><strong>{receiptProgressLabel(progress)}</strong><span>received{stale ? ' · last known' : ''}</span></span>
    <span className="live-production-meter" role="progressbar" aria-label="Production received" aria-valuemin={0} aria-valuemax={Math.max(1, progress.plannedTotal)} aria-valuenow={Math.min(progress.actualTotal, Math.max(1, progress.plannedTotal))} aria-valuetext={`${receiptProgressLabel(progress)} received${stale ? ', last known' : ''}`}><i style={{ width: `${ratio * 100}%` }}/></span>
    {estimate && <span className="live-production-estimate">Estimated finish <strong>{fullDateTime(estimate.estimatedCompletionAt)}</strong><small>{estimate.status === 'on-plan' ? 'Close to planned finish' : `${durationLabel(Math.abs(estimate.deltaMinutes))} ${estimate.status === 'late' ? 'later' : 'earlier'} than plan`}</small></span>}
    {!compact && <>{stale ? <p className="live-production-note">{error} <button type="button" className="text-link" onClick={retry}>Retry progress</button></p> : estimate ? <p className="live-production-note">Estimate from {estimate.sampleCount} recorded output samples. Recorded pauses are excluded; future stops may change the finish.</p> : unavailable && <p className="live-production-note">{unavailable}</p>}</>}
  </Container>;
}
