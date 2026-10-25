import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './RecordTable.css';

/** Keep wide, paginated operational tables navigable without scrolling to their last row. */
export function RecordTable({ label, resetKey, children }: { label: string; resetKey: string | number; children: ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const update = () => {
      const left = node.scrollLeft > 1, right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
      setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); node.removeEventListener('scroll', update); };
  }, []);
  useEffect(() => { area.current?.scrollTo({ top: 0, left: 0 }); }, [resetKey]);
  return <div className="record-table">
    {(edges.left || edges.right) && <div className="record-table-tools" role="group" aria-label={`${label} scrolling`}>
      <span>More columns</span>
      <button type="button" className="button secondary" aria-label={`Scroll ${label.toLowerCase()} left`} disabled={!edges.left} onClick={() => area.current?.scrollBy({ left: -area.current.clientWidth * .7 })}><ChevronLeft size={15}/>Left</button>
      <button type="button" className="button secondary" aria-label={`Scroll ${label.toLowerCase()} right`} disabled={!edges.right} onClick={() => area.current?.scrollBy({ left: area.current.clientWidth * .7 })}>Right<ChevronRight size={15}/></button>
    </div>}
    <div ref={area} className="table-scroll record-table-scroll" tabIndex={0} role="region" aria-label={`${label} — scroll for more columns`}>
      {children}
    </div>
  </div>;
}

export function RecordPagination({ label, position, total, page, onChange, itemLabel = 'records' }: {
  label: string; position: 'top' | 'bottom'; total: number; page: number; onChange: (page: number) => void; itemLabel?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / 50));
  return <div className={`record-pagination record-pagination-${position}`}>
    <span aria-live={position === 'top' ? 'polite' : 'off'}>{total ? (page - 1) * 50 + 1 : 0}–{Math.min(page * 50, total)} of {total} {itemLabel}</span>
    <nav aria-label={`${label} pages — ${position}`}>
      <button type="button" className="button secondary" aria-label={`Previous ${label.toLowerCase()} page`} disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={15}/>Previous</button>
      <span>Page {page} of {pages}</span>
      <button type="button" className="button secondary" aria-label={`Next ${label.toLowerCase()} page`} disabled={page >= pages} onClick={() => onChange(page + 1)}>Next<ChevronRight size={15}/></button>
    </nav>
  </div>;
}
