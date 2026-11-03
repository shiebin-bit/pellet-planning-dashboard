import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { JobProductionProgress, ProductionProgressSnapshot } from '../domain/productionProgress';
import { inventoryRequest } from './inventoryApi';
import { useCurrentTime } from './useCurrentTime';
import { useWorkspace } from './workspace';

interface LiveProductionState {
  jobs: Map<string, JobProductionProgress>;
  now: number;
  loading: boolean;
  stale: boolean;
  error: string;
  retry: () => void;
}
const LiveProductionContext = createContext<LiveProductionState | null>(null);

export function LiveProductionProvider({ children }: { children: ReactNode }) {
  const { board, selectedJob, page, storageMode, revision, savedAt, refresh } = useWorkspace();
  const ids = [...new Set([
    ...(page === 'planning' ? board.lines.flatMap(line => line.jobs) : []),
    ...(selectedJob ? [selectedJob] : []),
  ].filter(job => job.inventoryItemId && (job.status === 'running' || job.status === 'completed')).map(job => job.id))].sort();
  const key = ids.join('\n');
  const running = (page === 'planning' && board.lines.some(line => line.jobs.some(job => job.status === 'running'))) || selectedJob?.status === 'running';
  const [snapshot, setSnapshot] = useState<{ key: string; data: ProductionProgressSnapshot } | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const clock = useCurrentTime();

  useEffect(() => {
    if (storageMode !== 'database' || !key) { setLoading(false); setError(''); return; }
    let active = true, inFlight = false;
    const requestedIds = key.split('\n');
    const load = async () => {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true; setLoading(true);
      const started = Date.now();
      try {
        const batches: ProductionProgressSnapshot[] = [];
        for (let offset = 0; offset < requestedIds.length; offset += 100) {
          const query = new URLSearchParams();
          requestedIds.slice(offset, offset + 100).forEach(id => query.append('jobId', id));
          batches.push(await inventoryRequest<ProductionProgressSnapshot>('/api/inventory/production-progress?' + query));
        }
        if (!active) return;
        if (batches.some(batch => batch.revision !== revision)) throw new Error('Production records changed. Refresh the workspace to see current progress.');
        const data = { ...batches[0], jobs: batches.flatMap(batch => batch.jobs) };
        setSnapshot({ key, data }); setError('');
        const serverTime = Date.parse(data.serverNow);
        if (Number.isFinite(serverTime)) setClockOffset(serverTime - (started + Date.now()) / 2);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Production progress could not be loaded.');
      } finally { inFlight = false; if (active) setLoading(false); }
    };
    void load();
    const visibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visibility);
    const timer = running ? setInterval(() => void load(), 15_000) : undefined;
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [key, revision, savedAt, storageMode, running, attempt]);

  const current = snapshot?.key === key && snapshot.data.revision === revision ? snapshot.data : null;
  const jobs = useMemo(() => new Map(current?.jobs.map(job => [job.jobId, job]) ?? []), [current]);
  const value: LiveProductionState = { jobs, now: Math.max(clock, Date.now()) + clockOffset, loading, stale: !!error, error, retry: () => { void refresh().finally(() => setAttempt(n => n + 1)); } };
  return <LiveProductionContext.Provider value={value}>{children}</LiveProductionContext.Provider>;
}

export function useLiveProduction() {
  const value = useContext(LiveProductionContext);
  if (!value) throw new Error('Live production must be used inside its provider.');
  return value;
}
