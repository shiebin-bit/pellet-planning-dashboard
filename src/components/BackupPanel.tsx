import { useEffect,useRef,useState } from 'react';
import { HardDrive,Upload,Download } from 'lucide-react';
import type { AppState } from '../domain/types';
import { parseWorkspaceBackup } from '../domain/backup';
import { exportBackup } from '../lib/export';
import { dateLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import './ReportDialog.css';

export function BackupPanel(){
  const {state,restoreBackup,previousBackup,toast,storageMode,mutationLocked,hasConflict,confirmedRetry}=useWorkspace();
  const [candidate,setCandidate]=useState<AppState|null>(null);
  const [filename,setFilename]=useState('');
  const [reading,setReading]=useState(false);
  const [error,setError]=useState('');
  const [failed,setFailed]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const request=useRef(0);
  useEffect(()=>()=>{request.current++;},[]);
  useEffect(()=>{if(confirmedRetry?.type==='workspace.restore'){setCandidate(null);setFilename('');setFailed(false);}},[confirmedRetry?.nonce]);
  const dates=candidate?[...new Set(candidate.jobs.map(job=>job.date))].sort():[];
  async function read(file:File){
    const version=++request.current;setCandidate(null);setError('');setFailed(false);setFilename(file.name);setReading(true);
    try{
      if(file.size>10*1024*1024)throw new Error('Choose a JSON backup smaller than 10 MB.');
      const parsed=parseWorkspaceBackup(await file.text());
      if(version===request.current)setCandidate(parsed);
    }catch(reason){if(version===request.current)setError(reason instanceof Error?reason.message:'This backup could not be read.');}
    finally{if(version===request.current)setReading(false);}
  }
  return <div className="panel settings-info backup-panel"><HardDrive size={21}/><h3>Workspace backup</h3>{storageMode==='database'&&<p>Importing replaces this PostgreSQL workspace. To migrate browser records, export JSON from the offline file first, then select it here.</p>}<p>Save all records, settings and activity as JSON. Choose a backup to preview it before replacing this workspace.</p>
    <div className="backup-controls"><button type="button" className="button secondary full-width" onClick={()=>exportBackup(state)}><Download size={15}/>Download backup</button><button type="button" className="button secondary full-width" disabled={reading||mutationLocked||hasConflict} onClick={()=>input.current?.click()}><Upload size={15}/>{reading?'Reading backup…':'Restore JSON backup'}</button><input ref={input} type="file" accept=".json,application/json" hidden aria-label="Backup JSON file" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void read(file);}}/></div>
    {error&&<p role="alert" className="backup-error">{error}</p>}
    {candidate&&<section className="backup-preview" aria-label="Backup preview"><h4>Review before restoring</h4><dl><div><dt>File</dt><dd>{filename}</dd></div><div><dt>Site</dt><dd>{candidate.settings.siteName}</dd></div><div><dt>Production records</dt><dd>{candidate.jobs.length}</dd></div><div><dt>Planning dates</dt><dd>{dates.length?`${dateLabel(dates[0],true)} – ${dateLabel(dates[dates.length-1],true)}`:'No production records'}</dd></div><div><dt>Activity entries</dt><dd>{candidate.events.length}</dd></div></dl><p>This replaces the current {state.jobs.length} records, settings and activity. Records are not merged. A copy of the current workspace is kept for download after restoring.</p>{failed&&toast?.error&&<p role="alert" className="backup-error">{toast.message}</p>}<button type="button" className="button danger" disabled={mutationLocked||hasConflict} onClick={async()=>{if(await restoreBackup(candidate)){setCandidate(null);setFilename('');setFailed(false);}else setFailed(true);}}>Replace workspace with this backup</button><button type="button" className="text-link" disabled={mutationLocked} onClick={()=>{setCandidate(null);setFilename('');setFailed(false);}}>Cancel restore</button></section>}
    {previousBackup&&<div className="backup-previous"><p>The workspace saved immediately before the latest workspace replacement is available here.</p><button type="button" className="text-link" onClick={()=>exportBackup(previousBackup,'millplan-workspace-before-restore.json')}><Download size={14}/>Download previous workspace</button></div>}
  </div>;
}
