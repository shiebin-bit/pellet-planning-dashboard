import { getJobSourceAllocations } from '../domain/jobSources';
import { productLabel } from '../lib/productLabel';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ScheduledJob } from '../domain/types';
import { numberLabel, STATUS_LABELS, TIME_ZONE } from '../lib/format';
import { isJobPaused } from '../domain/production-results';
import './PlanningCardPreview.css';

// Removing a hovered portal can expose a different card under the same pointer.
// Wait for an intentional pointer movement before allowing any card to reopen.
const previewDateTime=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:TIME_ZONE});
const plannedTime=(value:number|null|undefined)=>value==null?'Not scheduled':previewDateTime.format(new Date(value));
let pointerPreviewDismissed=false;
let activePreview:{id:string;close:()=>void;isFocused:()=>boolean}|null=null;

// A portal keeps the preview outside the time track's clipping and container queries.
export function usePlanningCardPreview(job: ScheduledJob, dragging: boolean) {
  const id=useId();
  const anchor=useRef<HTMLDivElement>(null);
  const tooltip=useRef<HTMLDivElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focused=useRef(false);
  const dismissed=useRef(false);
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState<{left:number;top:number}|null>(null);
  const clearTimer=()=>{clearTimeout(timer.current);};
  const close=()=>{clearTimer();if(activePreview?.id===id)activePreview=null;setOpen(false);setPosition(null);};
  const show=()=>{
    clearTimer();if(dragging||dismissed.current)return;
    if(activePreview&&activePreview.id!==id){
      if(activePreview.isFocused()&&!focused.current)return;
      activePreview.close();
    }
    activePreview={id,close,isFocused:()=>focused.current};setOpen(true);
  };
  const leave=()=>{clearTimer();if(!focused.current)timer.current=setTimeout(close,120);};
  useEffect(()=>()=>{clearTimeout(timer.current);if(activePreview?.id===id)activePreview=null;},[id]);
  useEffect(()=>{if(dragging)close();},[dragging]);
  useEffect(()=>{
    if(!open)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){pointerPreviewDismissed=true;dismissed.current=true;close();}};
    const scroll=(event:Event)=>{if(!(event.target instanceof Node)||!tooltip.current?.contains(event.target))close();};
    window.addEventListener('keydown',escape);window.addEventListener('resize',close);
    window.addEventListener('scroll',scroll,true);
    return()=>{window.removeEventListener('keydown',escape);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true);};
  },[open]);
  useLayoutEffect(()=>{
    if(!open||!anchor.current||!tooltip.current)return;
    const rect=anchor.current.getBoundingClientRect(),box=tooltip.current.getBoundingClientRect();
    const left=Math.max(12,Math.min(rect.left,window.innerWidth-box.width-12));
    const below=rect.bottom+8;
    const top=below+box.height<=window.innerHeight-12?below:Math.max(12,rect.top-box.height-8);
    setPosition({left,top});
  },[open,job]);
  const preview=open&&!dragging?createPortal(<div id={id} ref={tooltip} role="tooltip" className="planning-card-preview" style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}} onPointerEnter={clearTimer} onPointerLeave={leave}>
    <div className="planning-preview-heading"><strong>{productLabel(job)}</strong><span>{job.lineId}</span></div>
    <p>{job.productCode}</p><p>{job.description||'No product description'}</p>
    <dl><div><dt>Quantity</dt><dd>{job.mode==='bags'&&job.bagCount!==null?`${numberLabel(job.bagCount,0)} Bags · `:''}{numberLabel(job.quantityMt)} MT</dd></div><div><dt>Order</dt><dd>{getJobSourceAllocations(job).length > 1 ? `${getJobSourceAllocations(job).length} orders: ${getJobSourceAllocations(job).map(a=>a.sourceSnapshot.doNo).join(', ')}` : job.orderNo||'No order reference'}</dd></div><div><dt>Planned start</dt><dd>{plannedTime(job.plannedStart)}</dd></div><div><dt>Planned end</dt><dd>{plannedTime(job.plannedEnd)}</dd></div><div><dt>Status</dt><dd>{job.issue?'Issue':isJobPaused(job)?'Paused':STATUS_LABELS[job.status]}</dd></div><div><dt>Destination</dt><dd>{job.bin?`Bin ${job.bin}`:'Not assigned'}</dd></div></dl>
    {job.issue&&<p className="planning-preview-issue">{job.issue.reason}</p>}
    <small>Times in MYT. Click or press Enter for full details.</small>
  </div>,document.body):null;
  return {anchor,preview,close,descriptionId:open&&!dragging?id:undefined,events:{
    onPointerEnter:(event:React.PointerEvent)=>{if(event.pointerType==='mouse'&&!pointerPreviewDismissed)show();},
    onPointerMove:(event:React.PointerEvent)=>{if(event.pointerType==='mouse'&&(event.movementX||event.movementY)){pointerPreviewDismissed=false;dismissed.current=false;show();}},
    onPointerLeave:(event:React.PointerEvent)=>{const next=event.relatedTarget;if(next instanceof Node&&(anchor.current?.contains(next)||tooltip.current?.contains(next)))return;dismissed.current=false;leave();},
    onFocusCapture:()=>{focused.current=true;pointerPreviewDismissed=false;dismissed.current=false;show();},onBlurCapture:()=>{focused.current=false;dismissed.current=false;close();},
  }};
}
