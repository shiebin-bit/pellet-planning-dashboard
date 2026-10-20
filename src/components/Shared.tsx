import { ArrowUpRight, Inbox, Search, X, AlertCircle, CheckCircle2, Circle, Clock3, CircleOff, Pause } from 'lucide-react';
import type { ReactNode } from 'react';
import type { JobStatus } from '../domain/types';
import { STATUS_LABELS } from '../lib/format';

export function StatusBadge({ status, issue = false, paused = false }: { status: JobStatus; issue?: boolean; paused?: boolean }) {
  const Icon = issue ? AlertCircle : paused ? Pause : status === 'completed' ? CheckCircle2 : status === 'running' ? Clock3 : status === 'cancelled' ? CircleOff : Circle;
  return <span className={'status-badge ' + (issue ? 'issue' : paused ? 'paused' : status)}><Icon size={13}/>{issue ? 'Issue' + (paused ? ' · Paused' : '') : paused ? 'Paused' : STATUS_LABELS[status]}</span>;
}
export function StatusLegend() {
  return <div className="status-legend" aria-label="Card status colours"><span>Card status</span><StatusBadge status="pending"/><StatusBadge status="running"/><StatusBadge status="running" paused/><StatusBadge status="completed"/><StatusBadge status="pending" issue/></div>;
}
export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
export function EmptyState({ title = 'Nothing planned here yet', text = 'Add a production task to start building this schedule.', action }: { title?: string; text?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={25} /></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}
export function SearchInput({ value, onChange, placeholder = 'Search product or order…' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-field"><Search size={16} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />{value && <button type="button" onClick={() => onChange('')} aria-label="Clear search"><X size={14} /></button>}</label>;
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={15} /></button>;
}
