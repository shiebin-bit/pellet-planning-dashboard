import type { Downtime, LineId } from '../domain/types';

export const TIME_ZONE = 'Asia/Kuala_Lumpur';
export function localDate(value: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function dateLabel(date: string, short = false) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: short ? 'short' : 'long', year: 'numeric', timeZone: TIME_ZONE }).format(new Date(date + 'T12:00:00Z'));
}
export function timeLabel(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE }).format(new Date(value));
}
export function fullDateTime(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE }).format(new Date(value));
}
export function toDateTimeInput(value: string | number | null) {
  if (!value) return '';
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
  return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute');
}
export function fromDateTimeInput(value: string) {
  return new Date(value + ':00+08:00').toISOString();
}
export function downtimeRange(item: Downtime, dayStart: string) {
  let start = Date.parse(item.date + 'T' + item.start + ':00+08:00');
  let end = Date.parse(item.date + 'T' + item.end + ':00+08:00');
  if (item.start < dayStart) start += 86400000;
  if (item.end < dayStart) end += 86400000;
  if (end <= start) end += 86400000;
  return { start, end };
}
export function durationLabel(minutes: number, compact = false) {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return compact ? (minutes / 60).toFixed(1) + ' h' : (hours ? hours + 'h ' : '') + (mins ? mins + 'm' : hours ? '' : '0m');
}
export function numberLabel(value: number, decimals = 1) {
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(value);
}
export function outputVarianceLabel(variance:number|null):string {
  if(variance===null)return 'Actual output not recorded';
  if(Math.abs(variance)<0.000001)return 'On target';
  return `${numberLabel(Math.abs(variance),2)} MT ${variance<0?'below':'above'} plan`;
}
const productColors: Record<string, string> = { '6220': '#b6d88e', '6210': '#80bbae', '6211': '#d9bd86', '6222': '#b6a7d3', '6148': '#8eafcf', '6178': '#d59d94', '6811': '#d5a96f', '6542': '#89b9c7' };
export function productColor(code: string) { return productColors[code.trim().slice(0, 4)] || '#a5b8a5'; }
export function lineLabel(line: LineId) { return 'Pellet mill ' + line.slice(-1).padStart(2, '0'); }
export const STATUS_LABELS = { pending: 'Not started', running: 'Running', completed: 'Completed', cancelled: 'Cancelled' };
