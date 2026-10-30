import type { Ref } from 'react';
import { Combine, RefreshCw } from 'lucide-react';
import { getJobSourceAllocations } from '../domain/jobSources';
import type { Job } from '../domain/types';
import { useOrderMetadata } from '../lib/useOrderMetadata';
import { dateLabel, numberLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import './ProductionOrders.css';

/** Order quantities remain the card's saved allocations; optional metadata is read-only. */
export function ProductionOrderBreakdown({job, orderOutput, combineCount, onCombine, combineRef}: {
  job: Job;
  orderOutput: Record<string, number> | null;
  combineCount: number;
  onCombine: () => void;
  combineRef?: Ref<HTMLButtonElement>;
}) {
  const {storageMode, mutationLocked, hasConflict} = useWorkspace();
  const allocations = getJobSourceAllocations(job);
  const {metadata, loading, failed, retry} = useOrderMetadata([job], storageMode === 'database');

  if (!allocations.length) return null;
  return <section className="production-orders" aria-label="Production order allocations">
    <header className="production-orders-heading">
      <div><span className="production-orders-count">{allocations.length} {allocations.length === 1 ? 'order' : 'orders'}</span><h3>Orders in this batch</h3></div>
      <div className="production-orders-total"><strong>{numberLabel(job.quantityMt, 2)}<small>MT</small></strong><span>{job.mode === 'bags' ? `${numberLabel(job.bagCount ?? 0, 0)} bags${job.bagWeightKgSnapshot ? ` · ${job.bagWeightKgSnapshot}kg` : ''}` : 'Bulk production'}</span></div>
    </header>

    <ol className="combined-source-list production-order-rows">
      {allocations.map((allocation, index) => {
        const source = allocation.sourceSnapshot, current = metadata[allocation.sourceOrderId];
        const customer = source.shipToParty || source.soldToParty || current?.shipToParty || current?.soldToParty;
        const soldTo = source.soldToParty || current?.soldToParty;
        const delivery = source.deliveryDate || current?.deliveryDate;
        const digits = source.unit === 'Bags' ? 0 : 3;
        const produced = orderOutput ? orderOutput[allocation.sourceOrderId] ?? 0 : job.status === 'pending' ? 0 : null;
        return <li className="combined-source-item production-order-row" key={allocation.sourceOrderId}>
          <div className="production-order-main"><div className="production-order-reference"><span className="production-order-position" aria-label={`Allocation position ${index + 1}`}>{index + 1}</span><strong>DO {source.doNo}</strong></div><div className="production-order-quantity"><small>Planned</small><strong>{numberLabel(allocation.plannedQuantity, digits)} <span>{source.unit}</span></strong></div></div>
          <p className={'production-order-customer' + (!customer ? ' missing' : '')}>{customer || (loading ? 'Loading customer…' : 'Customer unavailable')}</p>
          {soldTo && customer && soldTo !== customer && <p className="production-order-sold-to">Sold to {soldTo}</p>}
          <div className="production-order-meta"><div><span>Delivery</span><strong>{delivery ? dateLabel(delivery, true) : loading ? 'Loading…' : 'Not recorded'}</strong></div><div><span>Produced on this card</span><strong>{produced === null ? '—' : `${numberLabel(produced, digits)} ${source.unit}`}</strong></div></div>
          {allocation.plannedQuantity !== source.quantity && <p className="production-order-partial">Part of {numberLabel(source.quantity, digits)} {source.unit} ordered</p>}
        </li>;
      })}
    </ol>
    {combineCount > 0 && <div className="production-orders-combine"><div><strong>{combineCount} more compatible {combineCount === 1 ? 'card' : 'cards'} on {job.lineId}</strong><span>Select orders to produce together in this batch.</span></div><button ref={combineRef} type="button" className="button secondary" disabled={mutationLocked || hasConflict} onClick={onCombine}><Combine size={15}/>Combine with other cards</button></div>}
    {failed && <p className="production-order-retry" role="status">Some customer or delivery details could not load. <button className="text-link" onClick={retry}><RefreshCw size={13}/>Retry details</button></p>}
    <details className="production-allocation-notes"><summary>How production is allocated</summary><p>Production is recorded once, then assigned to the orders in the sequence above. Extra output becomes stock. Customer collection is recorded separately.</p>{Object.keys(metadata).length > 0 && <p>Missing customer and delivery fields are shown from the saved order. The card's quantities and source snapshots stay unchanged.</p>}<ul>{allocations.map(row => <li key={row.sourceOrderId}>DO {row.sourceSnapshot.doNo} · source version {row.sourceOrderVersion}</li>)}</ul></details>
  </section>;
}
