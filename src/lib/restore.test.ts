import { describe,expect,it } from 'vitest';
import { createSampleState } from '../domain/sample';
import { PREVIOUS_WORKSPACE_KEY,WORKSPACE_KEY,storeRestoredWorkspace } from './restore';

const storageFor=(entries:Map<string,string>)=>({getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,value);},removeItem:(key:string)=>{entries.delete(key);}});

describe('recoverable backup replacement',()=>{
  it('retains the previous state, clones imported records and audits only after validation',()=>{
    const previous=createSampleState('2026-10-15'),backup=createSampleState('2026-10-16');
    const source=JSON.stringify(backup),original=JSON.stringify(previous);
    const entries=new Map<string,string>();
    const result=storeRestoredWorkspace(storageFor(entries),previous,backup,'2026-10-16T03:00:00Z');
    expect(entries.get(PREVIOUS_WORKSPACE_KEY)).toBe(original);
    expect(JSON.parse(entries.get(WORKSPACE_KEY)!)).toEqual(result.state);
    expect(result.state.events[0].type).toBe('workspace.restored');
    expect(JSON.stringify(backup)).toBe(source);expect(JSON.stringify(previous)).toBe(original);
    result.state.jobs[0].productCode='changed';expect(backup.jobs[0].productCode).not.toBe('changed');
  });
  it('never writes invalid input or replaces the active workspace after a safety-copy failure',()=>{
    const current=createSampleState('2026-10-15');let writes=0;
    expect(()=>storeRestoredWorkspace({...storageFor(new Map()),setItem:()=>{writes++;}},current,{...current,schemaVersion:999} as never)).toThrow();
    expect(writes).toBe(0);
    const entries=new Map([[WORKSPACE_KEY,JSON.stringify(current)]]);
    expect(()=>storeRestoredWorkspace({...storageFor(entries),setItem:()=>{throw new Error('Storage full');}},current,createSampleState('2026-10-16'))).toThrow('Storage full');
    expect(entries.get(WORKSPACE_KEY)).toBe(JSON.stringify(current));
  });
  it('keeps active records and rolls back the recovery key if the replacement write fails',()=>{
    const current=createSampleState('2026-10-15');
    for(const priorRecovery of [null,JSON.stringify(createSampleState('2026-10-14'))]){
      const entries=new Map([[WORKSPACE_KEY,JSON.stringify(current)]]);if(priorRecovery!==null)entries.set(PREVIOUS_WORKSPACE_KEY,priorRecovery);
      expect(()=>storeRestoredWorkspace({...storageFor(entries),setItem:(key,value)=>{if(key===WORKSPACE_KEY)throw new Error('Quota');entries.set(key,value);}},current,createSampleState('2026-10-16'))).toThrow('Quota');
      expect(entries.get(WORKSPACE_KEY)).toBe(JSON.stringify(current));expect(entries.get(PREVIOUS_WORKSPACE_KEY)??null).toBe(priorRecovery);
    }
  });
});
