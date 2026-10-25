import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { dateLabel, localDate } from '../lib/format';

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const asDate = (value: string) => new Date(value + 'T00:00:00Z');
const iso = (value: Date) => value.toISOString().slice(0, 10);
const monthStart = (value: string) => value.slice(0, 7) + '-01';

/** A direct month/year calendar. Planning always retains a valid selected day. */
export function DatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(monthStart(value));
  const [focused, setFocused] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const today = localDate();
  const year = asDate(view).getUTCFullYear();
  const month = asDate(view).getUTCMonth();
  const first = asDate(view);
  first.setUTCDate(1 - first.getUTCDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(first);
    day.setUTCDate(day.getUTCDate() + index);
    return iso(day);
  });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function focusDay(day: string) {
    setFocused(day);
    setView(monthStart(day));
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-date="' + day + '"]')?.focus());
  }
  function changeMonth(nextYear: number, nextMonth: number) {
    const day = iso(new Date(Date.UTC(nextYear, nextMonth, 1)));
    setView(day);
    setFocused(day);
  }
  function choose(day: string) {
    onChange(day);
    setOpen(false);
    trigger.current?.focus();
  }
  function moveDay(event: React.KeyboardEvent, day: string) {
    const date = asDate(day);
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getUTCDay(), End: 6 - date.getUTCDay() };
    if (event.key in offsets) date.setUTCDate(date.getUTCDate() + offsets[event.key]);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const direction = event.key === 'PageUp' ? -1 : 1;
      const destination = new Date(Date.UTC(date.getUTCFullYear() + (event.shiftKey ? direction : 0), date.getUTCMonth() + (event.shiftKey ? 0 : direction), 1));
      const lastDay = new Date(Date.UTC(destination.getUTCFullYear(), destination.getUTCMonth() + 1, 0)).getUTCDate();
      destination.setUTCDate(Math.min(date.getUTCDate(), lastDay));
      date.setTime(destination.getTime());
    } else return;
    event.preventDefault();
    focusDay(iso(date));
  }
  return <div className="date-picker" ref={root} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button type="button" className={'date-picker-trigger ' + (open ? 'is-open' : '')} ref={trigger}
      aria-label={'Planning date: ' + dateLabel(value)} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        if (open) { setOpen(false); return; }
        setView(monthStart(value)); setFocused(value); setOpen(true);
        requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-date="' + value + '"]')?.focus());
      }}>
      <CalendarDays size={18}/><span className="date-picker-value"><small>Planning date</small><span>{dateLabel(value)}</span></span><ChevronDown size={16}/>
    </button>
    {open && <div className="calendar-popover" role="dialog" aria-label="Choose planning date">
      <div className="calendar-heading">
        <button type="button" className="icon-button" aria-label="Previous month" onClick={() => changeMonth(year, month - 1)}><ChevronLeft size={19}/></button>
        <select aria-label="Calendar month" value={month} onChange={event => changeMonth(year, Number(event.target.value))}>{months.map((label, index) => <option key={label} value={index}>{label}</option>)}</select>
        <select aria-label="Calendar year" value={year} onChange={event => changeMonth(Number(event.target.value), month)}>{Array.from({length: 151}, (_, index) => 1970 + index).map(item => <option key={item}>{item}</option>)}</select>
        <button type="button" className="icon-button" aria-label="Next month" onClick={() => changeMonth(year, month + 1)}><ChevronRight size={19}/></button>
      </div>
      <span className="sr-only" aria-live="polite">{months[month]} {year}</span>
      <div className="calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-days" role="group" aria-label="Dates">
        {days.map(day => <button type="button" key={day} data-date={day}
          className={'calendar-day ' + (day.slice(0, 7) !== view.slice(0, 7) ? 'outside ' : '') + (day === value ? 'selected ' : '') + (day === today ? 'current-day' : '')}
          aria-label={new Intl.DateTimeFormat('en-GB', {dateStyle: 'full', timeZone: 'UTC'}).format(asDate(day))}
          aria-pressed={day === value} aria-current={day === today ? 'date' : undefined}
          tabIndex={day === focused ? 0 : -1} onFocus={() => setFocused(day)}
          onKeyDown={event => moveDay(event, day)} onClick={() => choose(day)}>{asDate(day).getUTCDate()}</button>)}
      </div>
      <div className="calendar-footer"><span>Select month & year above</span><button type="button" onClick={() => choose(today)}>Today</button></div>
    </div>}
  </div>;
}
