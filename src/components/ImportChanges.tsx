import type { SourceImportPreviewRow, SourceOrderFields } from '../domain/sourceTypes';
import { dateLabel } from '../lib/format';
import './ImportChanges.css';

const labels: Record<string, string> = {
  doNo: 'DO no', deliveryDate: 'Delivery date', soldToParty: 'Sold to Party',
  shipToParty: 'Ship to Party', materialCode: 'Material code', description: 'Description',
  quantity: 'Quantity', unit: 'Unit', deliveryLeadDays: 'Delivery lead days', remark: 'Remark',
  daysOutstanding: 'Days of outstanding', medication: 'Medication', fmrOmed: 'FMR / OMED',
  asOfDate: 'Excel as-of date', goodsMovementStatus: 'Goods movement status',
  sourceSheet: 'Worksheet', sourceRow: 'Worksheet row',
};

function display(value: unknown, field: string, fields: SourceOrderFields) {
  if (value === null || value === undefined) return 'Not provided';
  if (value === '') return 'Empty';
  if (field === 'quantity') return `${value} ${fields.unit}`;
  if ((field === 'deliveryDate' || field === 'asOfDate') && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return dateLabel(String(value));
  return String(value);
}

/** Differences are informational: repeat imports keep the saved order. */
export function ImportChanges({ row, asOfDate }: { row: SourceImportPreviewRow; asOfDate: string }) {
  if (row.disposition === 'added') return <span className="import-change-note">New order</span>;
  if (!row.changedFields.length) return <span className="import-change-note">Existing order skipped. Saved data is retained.</span>;
  return <div><p className="import-change-note">Existing order skipped. These Excel differences will not be applied.</p><dl className="import-changes" aria-label="Import changes">{row.changedFields.map(field => {
    const before = field === 'asOfDate' ? row.previousAsOfDate : row.previousFields?.[field as keyof SourceOrderFields];
    const after = field === 'asOfDate' ? asOfDate : row.fields[field as keyof SourceOrderFields];
    return <div key={field}><dt>{labels[field] ?? field}</dt><dd>
      <span className="import-change-before"><span>Saved · retained</span>{row.previousFields ? display(before, field, row.previousFields) : 'Previous value unavailable'}</span>
      <span className="import-change-after"><span>Excel · skipped</span>{display(after, field, row.fields)}</span>
    </dd></div>;
  })}</dl></div>;
}
