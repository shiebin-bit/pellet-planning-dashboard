import {describe,expect,it} from 'vitest';
import {draftConfirmationDeadline,draftPlanningFloor,isDraftStartPassed} from './draftTiming';

describe('planning confirmation window',()=>{
  it('uses the same future review floor for generated and edited production',()=>{
    expect(draftPlanningFloor('2026-11-23T04:01:00Z')).toBe('2026-11-23T04:10:00.000Z');
    expect(draftPlanningFloor('2026-11-23T04:05:01Z')).toBe('2026-11-23T04:15:00.000Z');
    expect(isDraftStartPassed([{notBefore:draftPlanningFloor('2026-11-23T04:01:00Z')}],Date.parse('2026-11-23T04:03:00Z'))).toBe(false);
  });
  it('expires when the earliest proposed new card or carryover starts',()=>{
    const rows=[{notBefore:'2026-11-23T04:20:00Z'},{notBefore:'2026-11-23T04:10:00Z'}];
    expect(draftConfirmationDeadline(rows)).toBe(Date.parse('2026-11-23T04:10:00Z'));
    expect(isDraftStartPassed(rows,Date.parse('2026-11-23T04:09:59Z'))).toBe(false);
    expect(isDraftStartPassed(rows,Date.parse('2026-11-23T04:10:00Z'))).toBe(true);
  });
  it('does not expire an empty proposal or an untouched future-day draft',()=>{
    expect(draftConfirmationDeadline([])).toBeNull();
    expect(isDraftStartPassed([],Date.now())).toBe(false);
    expect(isDraftStartPassed([{notBefore:'2026-11-24T00:00:00Z'}],Date.parse('2026-11-23T15:59:59Z'))).toBe(false);
  });
  it('also checks a carryover-only proposal without any new cards',()=>{
    const carryovers=[{notBefore:'2026-11-23T04:10:00Z'}];
    expect(isDraftStartPassed(carryovers,Date.parse('2026-11-23T04:12:00Z'))).toBe(true);
  });
});
