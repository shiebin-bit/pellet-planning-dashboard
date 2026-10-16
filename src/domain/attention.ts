import type { Board, Job, ScheduledJob } from './types';

export type AttentionKind = 'issue' | 'quantity' | 'bin' | 'completion';
export interface AttentionItem {
  job: Job;
  kinds: AttentionKind[];
  plannedEnd: number | null;
}
const PRIORITY: Record<AttentionKind,number>={issue:0,quantity:1,bin:2,completion:3};

/** Selected-day work, including carry-over. A late plan is a check, not evidence of an actual stoppage. */
export function getAttentionItems(board:Board,now:number):AttentionItem[] {
  const jobs=new Map<string,Job|ScheduledJob>();
  for(const job of [...board.lines.flatMap(line=>line.jobs),...board.backlog])jobs.set(job.id,job);
  const items:AttentionItem[]=[];
  for(const job of jobs.values()){
    if(job.status!=='pending'&&job.status!=='running')continue;
    const kinds:AttentionKind[]=[];
    const end='plannedEnd' in job&&typeof job.plannedEnd==='number'&&Number.isFinite(job.plannedEnd)?job.plannedEnd:null;
    if(job.issue)kinds.push('issue');
    if(job.quantityMt<=0)kinds.push('quantity');
    if(job.binNeedsReview)kinds.push('bin');
    if(end!==null&&Number.isFinite(now)&&end<now)kinds.push('completion');
    if(kinds.length)items.push({job,kinds,plannedEnd:end});
  }
  return items.sort((a,b)=>PRIORITY[a.kinds[0]]-PRIORITY[b.kinds[0]]||(a.plannedEnd??Infinity)-(b.plannedEnd??Infinity)||a.job.lineId.localeCompare(b.job.lineId)||a.job.sequence-b.job.sequence);
}
