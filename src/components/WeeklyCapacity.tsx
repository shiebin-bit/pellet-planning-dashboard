import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getWeeklyCapacity } from '../domain/weeklyCapacity';
import type { AppState } from '../domain/types';
import { addDays, dateLabel, numberLabel } from '../lib/format';
import './WeeklyCapacity.css';

export function WeeklyCapacity({ state, date, disabled, onDate, onOpen }: {
  state: AppState; date: string; disabled: boolean; onDate: (date: string) => void; onOpen: (date: string) => void;
}) {
  const week = useMemo(() => getWeeklyCapacity(state, date), [state, date]);
  return <section className="weekly-capacity" aria-label="Weekly line capacity">
    <div className="weekly-capacity-toolbar"><div><strong>{dateLabel(week.startDate, true)} – {dateLabel(week.endDate, true)}</strong><span>Monday–Sunday · MYT</span></div><div><button type="button" className="icon-button" disabled={disabled} aria-label="Previous capacity week" onClick={() => onDate(addDays(date, -7))}><ChevronLeft size={17}/></button><button type="button" className="icon-button" disabled={disabled} aria-label="Next capacity week" onClick={() => onDate(addDays(date, 7))}><ChevronRight size={17}/></button></div></div>
    <div className="weekly-capacity-grid">
      <div className="weekly-capacity-axis" aria-hidden="true"><span>LINE</span>{['PM1', 'PM2', 'PM3', 'PM4'].map(line => <strong key={line}>{line}</strong>)}</div>
      {week.days.map(day => <section key={day.date} className={'weekly-capacity-day' + (day.date === date ? ' selected' : '')} aria-label={dateLabel(day.date)}>
        <h3><span>{new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))}</span>{dateLabel(day.date, true)}</h3>
        <div className="weekly-capacity-day-lines">{day.lines.map(line => {
          const booked = line.productionMinutes + line.changeoverMinutes;
          const review = line.unavailableWorkMinutes > .001 || (line.load !== null && line.load > 1.00001);
          const status = review ? 'review' : line.availableMinutes === 0 ? 'closed' : booked > 0 ? 'planned' : 'open';
          const description = `${line.lineId}, ${dateLabel(day.date)}. ${numberLabel(line.productionMinutes / 60, 2)} production hours, ${numberLabel(line.changeoverMinutes / 60, 2)} changeover hours, ${numberLabel(line.availableMinutes / 60, 2)} available hours, ${numberLabel(line.openMinutes / 60, 2)} open hours. ${numberLabel(line.plannedMt, 3)} MT planned within this shift. ${line.carryInCount} carry-in, ${line.carryOutCount} continuing, ${line.queuedCount} queued for later, ${line.backlogCount} awaiting quantity.${line.exception ? ' Working-hours exception.' : ''}${review ? ' Review work outside availability.' : ''}`;
          return <button key={line.lineId} type="button" className={`weekly-capacity-cell ${status}`} disabled={disabled} aria-label={`Open ${line.lineId} planning for ${day.date}`} aria-description={description} title={description} onClick={() => onOpen(day.date)}>
            <span className="weekly-cell-line">{line.lineId}</span><strong>{line.availableMinutes === 0 ? review ? 'Review' : line.backlogCount ? 'Needs quantity' : 'Closed' : line.load! > 0 && line.load! < .01 ? '<1%' : `${numberLabel(line.load! * 100, 0)}%`}</strong>
            <span>{numberLabel(booked / 60, 1)} / {numberLabel(line.availableMinutes / 60, 1)} hrs</span>
            <span>{numberLabel(line.plannedMt, line.plannedMt > 0 && line.plannedMt < 1 ? 3 : 1)} MT</span>
            <i className="weekly-load-track" aria-hidden="true"><i style={{ width: `${Math.min(100, (line.load ?? 0) * 100)}%` }}/></i>
            <small>{review ? 'Check availability' : line.backlogCount ? `${line.backlogCount} need quantity` : line.queuedCount ? `${line.queuedCount} queued` : line.carryOutCount ? `${line.carryOutCount} continue` : line.carryInCount ? `${line.carryInCount} carry-in` : line.exception ? 'Hours exception' : `${numberLabel(line.openMinutes / 60, 1)} hrs open`}</small>
          </button>;
        })}</div>
      </section>)}
    </div>
    <p className="weekly-capacity-note">Load includes production and changeover; unavailable periods reduce available hours. MT is the planned portion inside each line's shift, including carry-in. Select a cell to open that day's board.</p>
  </section>;
}
