import { LegacyCarryoverNotice } from '../components/LegacyCarryoverNotice';
import { useEffect, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, pointerWithin,
  rectIntersection, useDndContext, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import type { Active, CollisionDetection, DragEndEvent, Over } from '@dnd-kit/core';
import { AlertTriangle, ArrowUpRight, ChevronDown, Copy, GripVertical, LockKeyhole, Plus, Undo2 } from 'lucide-react';
import { StatusLegend } from '../components/Shared';
import { getCalendarForDate } from '../domain/engine';
import { isJobPaused } from '../domain/production-results';
import type { Downtime, LineId, LineSchedule, ScheduledJob, ScheduleSegment } from '../domain/types';
import { downtimeRange, durationLabel, numberLabel, timeLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import './Planning.css';

type PlanRange = 'day' | 'full';

const collision: CollisionDetection = args => {
  const candidates = (args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args)).filter(hit => {
    const data = args.droppableContainers.find(container => container.id === hit.id)?.data.current;
    return !data?.beforeId || data.date === args.active.data.current?.date;
  });
  const insertionTargets = candidates.filter(hit => String(hit.id).startsWith('hplan-before-'));
  return insertionTargets.length ? insertionTargets : candidates;
};

export function Planning() {
  const { board, state, openJob, openInput, openCopy, openSource, storageMode, selectedId, commit, canUndo, undo, mutationLocked, hasConflict } = useWorkspace();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [range, setRange] = useState<PlanRange>('day');
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 7 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space'], end: ['Space', 'Enter'], cancel: ['Escape'] } }),
  );
  const calendar = getCalendarForDate(state.settings, board.date);
  const jobs = board.lines.flatMap(line => line.jobs);
  const previousPlan = useRef({ boardStart: board.start, ends: plannedEnds(jobs) });
  const active = jobs.find(job => job.id === activeId);
  const latestEnd = Math.max(board.end, ...jobs.map(job => job.plannedEnd ?? board.end));
  const dayHours = (board.end - board.start) / 3_600_000;
  const fullHours = Math.min(168, Math.max(dayHours, Math.ceil((latestEnd - board.start) / 3_600_000)));
  const hours = range === 'full' ? fullHours : dayHours;
  const windowEnd = board.start + hours * 3_600_000;
  const ticks = getTicks(hours);

  function dragName(item: Active) {
    const job = jobs.find(job => job.id === item.data.current?.jobId);
    return job ? `${job.productCode} on ${job.lineId}` : 'Production card';
  }

  function dropName(over: Over | null) {
    if (!over) return 'outside the production lines';
    const target = jobs.find(job => job.id === over.data.current?.beforeId);
    return target ? `before ${target.productCode} on ${target.lineId}` : `at the end of ${over.data.current?.lineId}`;
  }

  useEffect(() => {
    const currentEnds = plannedEnds(jobs);
    const previous = previousPlan.current;
    if (previous.boardStart === board.start) {
      const extendsPastDay = jobs.some(job => {
        if (job.plannedEnd === null || job.plannedEnd <= board.end) return false;
        if (!previous.ends.has(job.id)) return true;
        const previousEnd = previous.ends.get(job.id);
        return previousEnd == null || job.plannedEnd > previousEnd;
      });
      if (extendsPastDay) setRange('full');
    }
    previousPlan.current = { boardStart: board.start, ends: currentEnds };
  }, [board.end, board.start, jobs]);

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (!event.over) return;
    const data = event.over.data.current;
    const lineId = data?.lineId as LineId | undefined;
    if (!lineId) return;
    const id = String(event.active.data.current?.jobId ?? event.active.id);
    const beforeId = data?.beforeId as string | undefined;
    if (beforeId === id) return;
    const source = jobs.find(job => job.id === id);
    void commit({type:'job.move',jobId:id,toLineId:lineId,...(beforeId?{beforeJobId:beforeId}:{})}, source?.lineId !== lineId ? `Moved to ${lineId}. Check the destination bin.` : 'Production order updated.', true);
  }

  return <div className={`page planning-page hplan-page ${activeId?'is-dragging':''}`}>
    <div className="page-heading hplan-heading">
      <div><h1>Planning board</h1><p>Drag a not-started card to another line. Click for details.</p></div>
      <div className="hplan-actions">
        {storageMode === 'database' && <button type="button" className="button secondary" disabled={mutationLocked || hasConflict} onClick={() => openSource()}><Plus size={15}/>Plan from Data</button>}
        <button type="button" className="button secondary" disabled={mutationLocked || hasConflict} onClick={openCopy}><Copy size={15}/>Copy planning</button>
        <button type="button" className="button secondary" disabled={!canUndo} onClick={undo}><Undo2 size={15}/>Undo</button>
        {fullHours > dayHours && <div className="hplan-range" aria-label="Planning range">
          <button type="button" className={range === 'day' ? 'active' : ''} aria-pressed={range === 'day'} onClick={() => setRange('day')}>Day</button>
          <button type="button" className={range === 'full' ? 'active' : ''} aria-pressed={range === 'full'} onClick={() => setRange('full')}>Full plan</button>
        </div>}
      </div>
    </div>

    <DndContext sensors={sensors} collisionDetection={collision} accessibility={{
      screenReaderInstructions: { draggable: 'Press Enter to open production details. Press Space to pick up a card, arrow keys to move, Space to drop, or Escape to cancel. On a touch screen, hold the card briefly before dragging.' },
      announcements: {
        onDragStart: ({ active }) => `Picked up ${dragName(active)}.`,
        onDragOver: ({ active, over }) => `${dragName(active)} is ${dropName(over)}.`,
        onDragEnd: ({ active, over }) => `Released ${dragName(active)} ${dropName(over)}.`,
        onDragCancel: ({ active }) => `Move cancelled for ${dragName(active)}.`,
      },
    }} onDragStart={event => setActiveId(String(event.active.data.current?.jobId ?? event.active.id))} onDragCancel={() => setActiveId(null)} onDragEnd={onDragEnd}>
      <section className="hplan-board" data-board-range={range} aria-label={`${hours}-hour production plan`}>
        <div className="hplan-axis-label"><strong>MYT</strong><span>UTC+8</span></div>
        <div className="hplan-axis" aria-hidden="true">{ticks.map(hour => <div key={hour} className="hplan-axis-tick" style={{ left: `${hour / hours * 100}%` }}><span>{timeLabel(board.start + hour * 3_600_000)}</span>{hour >= 24 && hour % 24 === 0 && <small>+{hour / 24}d</small>}</div>)}</div>
        {board.lines.map(line => <LineRow key={line.lineId} line={line} start={board.start} end={windowEnd} hours={hours} downtime={state.settings.downtime} dayStart={calendar.dayStart} availableHours={calendar.availableHours} activeId={activeId} selectedId={selectedId} onOpen={openJob} onAdd={openInput}/>) }
      </section>
      <DragOverlay dropAnimation={null}>{active ? <div className={`hplan-drag-card ${active.issue ? 'issue' : active.status}`}><GripVertical size={17}/><div><strong>{active.productCode}</strong><span>{numberLabel(active.quantityMt)} MT</span></div><small>{active.lineId}</small></div> : null}</DragOverlay>
    </DndContext>

    <div className="hplan-below"><div className="hplan-legend"><StatusLegend/>{state.settings.changeoverMinutes>0&&<span className="hplan-interval-key"><i className="changeover-key"/>Changeover / line clean-up · {durationLabel(state.settings.changeoverMinutes)}</span>}<span className="hplan-interval-key"><i className="unavailable-key"/>Unavailable</span></div>{fullHours > dayHours && range === 'day' && <span className="hplan-carry-note">Carry-over continues for up to {fullHours} hours. Use Full plan to view it.</span>}</div>
    <LegacyCarryoverNotice/>
    {board.backlog.length > 0 && <details className="hplan-backlog"><summary><span><AlertTriangle size={16}/>Awaiting quantity</span><strong>{board.backlog.length}</strong><ChevronDown size={16}/></summary><div className="hplan-backlog-grid">{board.backlog.map(job => <button type="button" key={job.id} className={job.issue ? 'issue' : ''} onClick={() => openJob(job.id)}><div><strong>{job.productCode}</strong><span>{job.lineId} · {job.orderNo || 'No order reference'}</span></div><small>{job.issue ? 'Issue' : 'Add quantity'}</small><ArrowUpRight size={15}/></button>)}</div></details>}
  </div>;
}

function LineRow({ line, start, end, hours, downtime, dayStart, availableHours, activeId, selectedId, onOpen, onAdd }: {
  line: LineSchedule; start: number; end: number; hours: number; downtime: Downtime[];
  dayStart: string; availableHours: number; activeId: string | null; selectedId: string | null;
  onOpen: (id: string) => void; onAdd: (lineId?: LineId) => void;
}) {
  const { setNodeRef } = useDroppable({ id: `hplan-line-${line.lineId}`, data: { lineId: line.lineId } });
  const { setNodeRef: labelRef } = useDroppable({ id: `hplan-label-${line.lineId}`, data: { lineId: line.lineId } });
  const { over } = useDndContext();
  const isTarget = Boolean(activeId && over?.data.current?.lineId === line.lineId);
  const hasVisibleProduction = line.jobs.some(job => job.segments.some(segment => segment.kind === 'production' && segment.end > start && segment.start < end));
  return <>
    <div ref={labelRef} data-line-label={line.lineId} className={`hplan-line-label ${isTarget ? 'is-over' : ''}`}><div><strong>{line.lineId}</strong><button type="button" onClick={() => onAdd(line.lineId)} aria-label={`Add production to ${line.lineId}`}><Plus size={15}/></button></div><span>{numberLabel(line.plannedMt)} MT</span><small>{line.utilisation === null ? '—' : `${numberLabel(line.utilisation * 100, 0)}% planned`}</small></div>
    <div ref={setNodeRef} data-line-id={line.lineId} className={`hplan-track ${isTarget ? 'is-over' : ''}`} aria-label={`${line.lineId} timeline`}>
      {getTicks(hours).map(hour => <span key={hour} className={`hplan-gridline ${hour > 0 && hour % 24 === 0 ? 'day-boundary' : ''}`} style={{ left: `${hour / hours * 100}%` }}/>) }
      {Array.from({ length: Math.ceil(hours / 24) }, (_, day) => {
        const offStart = day * 24 + availableHours;
        const offEnd = Math.min((day + 1) * 24, hours);
        return offStart < hours && offEnd > offStart ? <span key={`off-${day}`} className="hplan-off-hours" style={{ left: `${offStart / hours * 100}%`, width: `${(offEnd - offStart) / hours * 100}%` }} title="Outside available hours"/> : null;
      })}
      {downtime.filter(item => item.lineId === line.lineId || item.lineId === 'all').map(item => <BackgroundInterval key={item.id} className="hplan-downtime" interval={downtimeRange(item, dayStart)} start={start} end={end} title={`Unavailable · ${item.reason}`}/>) }
      {line.jobs.map(job => <JobSegments key={job.id} job={job} start={start} end={end} activeId={activeId} selected={selectedId === job.id} onOpen={() => onOpen(job.id)}/>) }
      {!hasVisibleProduction && <button type="button" className="hplan-empty" onClick={() => onAdd(line.lineId)}><Plus size={17}/>Add to {line.lineId}</button>}
      {isTarget && <span className="hplan-append">Drop here · {line.lineId}</span>}
    </div>
  </>;
}

function BackgroundInterval({ interval, start, end, className, title }: { interval: { start: number; end: number }; start: number; end: number; className: string; title: string }) {
  const clippedStart = Math.max(start, interval.start);
  const clippedEnd = Math.min(end, interval.end);
  if (clippedEnd <= clippedStart) return null;
  return <span className={className} style={intervalStyle(clippedStart, clippedEnd, start, end)} title={title}/>;
}

function JobSegments({ job, start, end, activeId, selected, onOpen }: { job: ScheduledJob; start: number; end: number; activeId: string | null; selected: boolean; onOpen: () => void }) {
  const visible = job.segments.filter(segment => segment.end > start && segment.start < end);
  const firstProduction = visible.findIndex(segment => segment.kind === 'production');
  return <>{visible.map((segment, index) => segment.kind === 'changeover'
    ? <ChangeoverSegment key={`${segment.start}-${index}`} segment={segment} job={job} start={start} end={end} onOpen={onOpen}/>
    : <ProductionSegment key={`${segment.start}-${index}`} segment={segment} job={job} start={start} end={end} primary={index === firstProduction} activeId={activeId} selected={selected} onOpen={onOpen}/>)}</>;
}

function ProductionSegment({ segment, job, start, end, primary, activeId, selected, onOpen }: {
  segment: ScheduleSegment; job: ScheduledJob; start: number; end: number; primary: boolean;
  activeId: string | null; selected: boolean; onOpen: () => void;
}) {
  const locked = job.status !== 'pending';
  const { attributes, listeners, setNodeRef: dragRef } = useDraggable({
    id: primary ? job.id : `hplan-segment-${job.id}-${segment.start}`,
    disabled: locked,
    data: { lineId: job.lineId, jobId: job.id, date: job.date },
  });
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: primary ? `hplan-before-${job.id}` : `hplan-before-segment-${job.id}-${segment.start}`,
    data: { lineId: job.lineId, beforeId: job.id, date: job.date },
  });
  const clippedStart = Math.max(start, segment.start);
  const clippedEnd = Math.min(end, segment.end);
  const paused = isJobPaused(job);
  const status = job.issue ? 'issue' : paused ? 'paused' : job.status;
  const detail = `${job.productCode} · ${numberLabel(job.quantityMt)} MT · ${timeLabel(segment.start)}–${timeLabel(segment.end)} · ${job.issue ? `Issue: ${job.issue.reason}` : paused ? 'Paused' : job.status}`;
  const insert=isOver&&activeId&&activeId!==job.id;
  return <div ref={node => {dragRef(node);dropRef(node);}} data-job-id={primary ? job.id : undefined} data-production-job={job.id} data-draggable={!locked} className={`hplan-card ${status} ${selected ? 'selected' : ''} ${activeId===job.id ? 'dragging' : ''} ${insert ? 'drop-before' : ''} ${segment.end > end ? 'clipped-end' : ''}`} style={intervalStyle(clippedStart, clippedEnd, start, end)} title={detail}>
    <button type="button" className="hplan-card-open" {...(!locked?attributes:{})} {...(!locked?listeners:{})} onClick={onOpen} aria-label={`Open ${job.productCode} on ${job.lineId}${primary?'':' continued segment'}`} aria-description={`${detail}. ${locked?'This production plan is locked.':'Drag anywhere on this card to move it. On touch screens, hold briefly then drag. Enter opens details; Space starts a keyboard move.'}`}/>
    <div className="hplan-card-content" aria-hidden="true"><strong className="hplan-code-short">{job.productCode.trim().slice(0, 4)}</strong><strong className="hplan-code-full">{job.productCode}</strong><span className="hplan-quantity">{numberLabel(job.quantityMt)} MT</span><span className="hplan-time">{timeLabel(segment.start)}–{timeLabel(segment.end)}</span><span className="hplan-state">{job.issue ? <AlertTriangle size={12}/> : locked ? <LockKeyhole size={11}/> : null}{job.issue ? 'Issue' + (paused ? ' · Paused' : '') : paused ? 'Paused' : job.status === 'running' ? 'Running' : job.status === 'completed' ? 'Done' : primary ? 'Planned' : 'Continued'}</span></div>
    {!locked && <span className="hplan-drag-handle" aria-hidden="true"><GripVertical size={15}/></span>}
    {insert && <span className="hplan-insert">Insert</span>}
  </div>;
}

function ChangeoverSegment({ segment, job, start, end, onOpen }: { segment: ScheduleSegment; job: ScheduledJob; start: number; end: number; onOpen: () => void }) {
  const clippedStart = Math.max(start, segment.start);
  const clippedEnd = Math.min(end, segment.end);
  const detail=`Changeover / line clean-up before ${job.productCode} on ${job.lineId} · ${durationLabel((segment.end - segment.start) / 60_000)}`;
  return <button type="button" className="hplan-changeover" style={intervalStyle(clippedStart, clippedEnd, start, end)} onClick={onOpen} aria-label={detail} title={detail}/>;
}

function intervalStyle(intervalStart: number, intervalEnd: number, start: number, end: number) {
  const span = end - start;
  return { left: `${(intervalStart - start) / span * 100}%`, width: `${(intervalEnd - intervalStart) / span * 100}%` };
}

function getTicks(hours: number) {
  const interval = hours <= 24 ? 3 : hours <= 48 ? 6 : 12;
  const ticks = Array.from({ length: Math.floor(hours / interval) + 1 }, (_, index) => index * interval);
  if (ticks.at(-1) !== hours) ticks.push(hours);
  return ticks;
}

function plannedEnds(jobs: ScheduledJob[]) {
  return new Map(jobs.map(job => [job.id, job.plannedEnd]));
}
