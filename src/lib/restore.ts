import type { AppState } from '../domain/types';
import { validateWorkspaceBackup } from '../domain/backup';

export const WORKSPACE_KEY='millplan.workspace.v1';
export const PREVIOUS_WORKSPACE_KEY=WORKSPACE_KEY+'.before-restore';

/** No UI state changes until both writes succeed. A failed main write leaves the active workspace untouched. */
export function storeRestoredWorkspace(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,current:AppState,backup:AppState,now=new Date().toISOString()):{state:AppState;previous:AppState} {
  const restored=validateWorkspaceBackup(backup);
  restored.events.unshift({id:crypto.randomUUID(),at:now,type:'workspace.restored',message:`Restored workspace from JSON backup (${restored.jobs.length} production records). Previous workspace retained for download.`});
  validateWorkspaceBackup(restored);
  const previous=structuredClone(current);
  const previousJson=JSON.stringify(previous),nextJson=JSON.stringify(restored);
  const priorRecovery=storage.getItem(PREVIOUS_WORKSPACE_KEY);
  storage.setItem(PREVIOUS_WORKSPACE_KEY,previousJson);
  try{storage.setItem(WORKSPACE_KEY,nextJson);}
  catch(reason){
    try{if(priorRecovery===null)storage.removeItem(PREVIOUS_WORKSPACE_KEY);else storage.setItem(PREVIOUS_WORKSPACE_KEY,priorRecovery);}
    catch{throw new Error('The active workspace was not replaced. Browser storage also blocked recovery-copy rollback. Download your current workspace before retrying.');}
    throw reason;
  }
  return {state:restored,previous};
}
