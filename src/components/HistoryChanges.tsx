import type { HistoryEvent } from '../domain/types';
import { STATUS_LABELS, toDateTimeInput } from '../lib/format';
import './HistoryChanges.css';

const LABELS: Record<string, string> = {
  date: 'Planning date', lineId: 'Production line', sequence: 'Line position', orderNo: 'Order reference',
  productCode: 'Product code', description: 'Description', bin: 'Destination bin', mode: 'Delivery mode',
  bagCount: 'Bag quantity', quantityMt: 'Planned quantity', remarks: 'Remarks', status: 'Status',
  actualStart: 'Actual start', actualEnd: 'Actual end', actualQuantityMt: 'Actual output', completionNote: 'Completion note',
  binNeedsReview: 'Bin review required', 'issue.reason': 'Problem details', pauseState: 'Production state', pauseReason: 'Pause reason',
  'settings.siteName': 'Site name', 'settings.timeZone': 'Time zone', 'settings.dayStart': 'Planning day starts', 'settings.availableHours': 'Daily available hours',
  'settings.changeoverMinutes': 'Changeover minutes', 'settings.bagWeightKg': 'Bag weight (kg)',
  'settings.slowRatePM2': 'PM2 slow-product rate', 'settings.slowProductPrefixes': 'Slow-product prefixes',
  'settings.downtime': 'Unavailable periods', 'catalog.code': 'Product code', 'catalog.description': 'Product description',
  'catalog.defaultMode': 'Default delivery', 'catalog.active': 'Product active',
};
export function historyFieldLabel(field: string) {
  return LABELS[field] ?? (field.startsWith('settings.rates.') ? field.slice(-3) + ' rate (MT/hr)' : field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' '));
}
export function historyValueLabel(field: string, value: string | number | boolean | null): string {
  if (value === null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 17 }).format(value) + (field === 'bagCount' ? ' bags' : ['quantityMt', 'actualQuantityMt'].includes(field) ? ' MT' : '');
  if (['actualStart', 'actualEnd'].includes(field)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return toDateTimeInput(value).replace('T', ' ') + ':' + date.toISOString().slice(17, 23) + ' MYT';
  }
  if (field === 'status' && value in STATUS_LABELS) return STATUS_LABELS[value as keyof typeof STATUS_LABELS];
  if (field === 'pauseState') return value === 'paused' ? 'Paused' : value === 'running' ? 'Running' : value;
  if (['mode', 'catalog.defaultMode'].includes(field)) return value === 'bags' ? 'Bags' : value === 'bulk' ? 'Bulk' : value;
  return value;
}

export function HistoryChanges({ event }: { event: HistoryEvent }) {
  if (!event.changes?.length) return null;
  const rows = (changes: NonNullable<HistoryEvent['changes']>) => <table className="change-table" aria-label="Recorded changes"><thead><tr><th>FIELD</th><th>BEFORE</th><th>AFTER</th></tr></thead><tbody>{changes.map(change => <tr key={change.field}><th scope="row">{historyFieldLabel(change.field)}</th><td>{historyValueLabel(change.field, change.before)}</td><td>{historyValueLabel(change.field, change.after)}</td></tr>)}</tbody></table>;
  return <div className="history-changes">{rows(event.changes.slice(0, 4))}{event.changes.length > 4 && <details><summary>{event.changes.length - 4} more changes</summary>{rows(event.changes.slice(4))}</details>}</div>;
}
