import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AutomaticBackupStatus as Status } from '../domain/automaticBackup';
import { dataRequest } from '../lib/dataApi';
import { fullDateTime } from '../lib/format';
import './AutomaticBackupStatus.css';

export function AutomaticBackupStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    dataRequest<Status>('/api/backup/status').then(value => {
      if (!active) return;
      setStatus(value);
      setError(false);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setReload(value => value + 1); };
    const timer = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  const warning = status?.state === 'degraded' || status?.lastAttempt?.result === 'failed' || status?.lastAttempt?.result === 'success_with_warning';
  return <section className={`automatic-backup-status${warning || error ? ' warning' : ''}`} aria-label="Automatic backup status" aria-busy={loading}>
    <div className="automatic-backup-heading"><h4>Automatic recovery copies</h4><button type="button" className="text-link" disabled={loading} onClick={() => setReload(value => value + 1)} aria-label="Refresh automatic backup status"><RefreshCw size={14}/>{error ? 'Retry' : 'Refresh'}</button></div>
    {error ? <p role="alert">Automatic backup status is unavailable. Manual download and restore remain available.</p>
      : !status || loading && !status ? <p>Checking automatic backup status…</p>
        : !status.enabled ? <p>Automatic backups are disabled on this server.</p>
          : <><dl>
            <div><dt>State</dt><dd>{stateLabel(status)}</dd></div>
            <div><dt>Last saved</dt><dd>{status.lastSuccess ? fullDateTime(status.lastSuccess.at) : 'No successful copy yet'}</dd></div>
            <div><dt>Next attempt</dt><dd>{status.nextAttemptAt ? fullDateTime(status.nextAttemptAt) : status.state === 'running' ? 'In progress' : 'Not scheduled'}</dd></div>
            <div><dt>Retention</dt><dd>Newest {status.retentionCount} copies · every {status.intervalHours}h</dd></div>
          </dl>
          {warning && <p role="alert">{status.lastAttempt?.sanitizedMessage ?? 'Automatic backups need attention. Retry is scheduled automatically.'}</p>}</>}
  </section>;
}

function stateLabel(status: Status): string {
  if (status.state === 'running') return 'Saving now';
  if (status.state === 'degraded') return 'Needs attention';
  if (status.state === 'disabled') return 'Disabled';
  return status.lastSuccess ? 'Backup saved' : 'Waiting for first copy';
}
