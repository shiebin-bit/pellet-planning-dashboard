import { describe,expect,it } from 'vitest';
import { getAttentionItems } from './attention';
import { createSampleState } from './sample';
import { getBoard } from './engine';

describe('needs-attention selection',()=>{
  it('combines reasons for one active task without duplicate rows',()=>{
    const board=getBoard(createSampleState('2026-10-15'),'2026-10-15');
    const job=board.lines[2].jobs.find(item=>item.status==='pending')!;
    job.issue={reason:'Check feed',reportedAt:'2026-10-15T02:00:00Z'};
    job.binNeedsReview=true;
    const result=getAttentionItems(board,job.plannedEnd!+1);
    expect(result.filter(item=>item.job.id===job.id)).toHaveLength(1);
    expect(result.find(item=>item.job.id===job.id)?.kinds).toEqual(['issue','bin','completion']);
    expect(result[0].job.id).toBe(job.id);
  });
  it('includes missing quantities but excludes cancelled and completed work',()=>{
    const board=getBoard(createSampleState('2026-10-15'),'2026-10-15');
    const missing=board.backlog[0];
    missing.issue={reason:'Unknown quantity',reportedAt:'2026-10-15T02:00:00Z'};
    board.backlog.push({...missing,id:'cancelled',status:'cancelled'});
    const completed=board.lines.flatMap(line=>line.jobs).find(job=>job.status==='completed')!;
    completed.binNeedsReview=true;
    const items=getAttentionItems(board,Infinity);
    expect(items.find(item=>item.job.id===missing.id)?.kinds).toEqual(['issue','quantity']);
    expect(items.some(item=>item.job.id==='cancelled'||item.job.id===completed.id)).toBe(false);
  });
  it('flags only past finish times, including carried-over work, and leaves future plans alone',()=>{
    const state=createSampleState('2026-10-15');
    const board=getBoard(state,'2026-10-15');
    const job=board.lines[3].jobs.find(item=>item.status==='pending')!;
    expect(getAttentionItems(board,job.plannedEnd!).find(item=>item.job.id===job.id)).toBeUndefined();
    expect(getAttentionItems(board,job.plannedEnd!+1).find(item=>item.job.id===job.id)?.kinds).toContain('completion');
    const tomorrow=getBoard(state,'2026-10-16');
    const carry=tomorrow.lines.flatMap(line=>line.jobs).find(item=>item.date==='2026-10-15'&&item.status==='pending')!;
    expect(getAttentionItems(tomorrow,carry.plannedEnd!+1).find(item=>item.job.id===carry.id)?.kinds).toContain('completion');
    const future=getBoard(state,'2026-10-18');
    expect(getAttentionItems(future,Date.parse('2026-10-15T03:00:00Z'))).toEqual([]);
  });
});
