import { useEffect, useState } from 'react';
import { getJobSourceAllocations } from '../domain/jobSources';
import type { Job } from '../domain/types';
import type { SourceOrderDetail } from '../domain/sourceTypes';
import { readSourceOrder } from './dataApi';

/** Fill legacy display gaps without changing saved allocations or source snapshots. */
export function useOrderMetadata(jobs: Job[], enabled: boolean) {
  const requests = new Map<string, string>();
  for (const job of jobs) for (const row of getJobSourceAllocations(job)) {
    if (!row.sourceSnapshot.deliveryDate || !(row.sourceSnapshot.shipToParty || row.sourceSnapshot.soldToParty)) {
      requests.set(row.sourceOrderId, job.productCode.trim().toLowerCase());
    }
  }
  const requestKey = JSON.stringify([...requests].sort(([a], [b]) => a.localeCompare(b)));
  const [metadata, setMetadata] = useState<Record<string, SourceOrderDetail>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, index = 0;
    const rows = JSON.parse(requestKey) as [string, string][];
    setMetadata({}); setFailed(false);
    if (!enabled || !rows.length) {setLoading(false); return;}
    setLoading(true);
    const worker = async () => {
      while (active && index < rows.length) {
        const [id, material] = rows[index++];
        try {
          const detail = await readSourceOrder(id);
          if (active && detail.materialCode.trim().toLowerCase() === material) {
            setMetadata(previous => ({...previous, [id]: detail}));
          }
        } catch {if (active) setFailed(true);}
      }
    };
    void Promise.all(Array.from({length: Math.min(4, rows.length)}, worker)).then(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [requestKey, enabled, attempt]);
  return {metadata, loading, failed, retry: () => setAttempt(value => value + 1)};
}
