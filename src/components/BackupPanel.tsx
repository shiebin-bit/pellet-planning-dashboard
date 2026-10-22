import { useEffect,useRef,useState } from 'react';
import { HardDrive,Upload,Download } from 'lucide-react';
import type { PortableWorkspaceBackupV3 } from '../domain/sourceTypes';
import type { AppState } from '../domain/types';
import { parseWorkspaceBackup } from '../domain/backup';
import { exportBackup, exportDatabaseBackup } from '../lib/export';
import { dateLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import './ReportDialog.css';

export function BackupPanel(){
  const {state,restoreBackup,previousBackup,toast,storageMode,mutationLocked,hasConflict,confirmedRetry,notify}=useWorkspace();
  const [candidate,setCandidate]=useState<AppState|PortableWorkspaceBackupV3|null>(null);
  const [legacy,setLegacy]=useState(false);
  const [filename,setFilename]=useState('');
  const [reading,setReading]=useState(false);
  const [error,setError]=useState('');
  const [failed,setFailed]=useState(false);
  const [failureMessage,setFailureMessage]=useState('');
  useEffect(()=>{if(failed&&toast?.error)setFailureMessage(toast.message);},[failed,toast]);
  const input=useRef<HTMLInputElement>(null);
  const request=useRef(0);
  useEffect(()=>()=>{request.current++;},[]);
  useEffect(()=>{if(confirmedRetry?.type==='workspace.restore'){setCandidate(null);setFilename('');setFailed(false);}},[confirmedRetry?.nonce]);
  const planning=candidate?('planning' in candidate?candidate.planning:candidate):null;
  const dates=planning?[...new Set(planning.jobs.map(job=>job.date))].sort():[];
  const sourceOrders=candidate&&'planning' in candidate?candidate.sourceData.orders.length:0;
  async function download(previous=false){try{if(storageMode==='database')await exportDatabaseBackup(previous);else exportBackup(previous?previousBackup!:state,previous?'millplan-workspace-before-restore.json':undefined);}catch(reason){notify(reason instanceof Error?reason.message:'The backup could not be downloaded.',true);}}
  async function read(file:File){
    const version=++request.current;setCandidate(null);setLegacy(false);setError('');setFailed(false);setFilename(file.name);setReading(true);
    try{
      if(file.size>64*1024*1024)throw new Error('Choose a JSON backup smaller than 64 MB.');
      const text=await file.text();
      const raw=JSON.parse(text.replace(/^\uFEFF/,''));
      let parsed:AppState|PortableWorkspaceBackupV3;
      if(raw.schemaVersion===3){
        if(!raw.sourceData||!Array.isArray(raw.sourceData.orders)||!Array.isArray(raw.sourceData.imports)||!Array.isArray(raw.sourceData.versions))throw new Error('This backup has invalid order data.');
        if(storageMode==='offline'&&(raw.sourceData.orders.length||raw.sourceData.imports.length||raw.sourceData.versions.length))throw new Error('Restore this backup in the PostgreSQL workspace to retain imported order data.');
        parsed={...raw,planning:parseWorkspaceBackup(JSON.stringify(raw.planning))};
      }else parsed=parseWorkspaceBackup(text);
      if(version===request.current){setCandidate(parsed);setLegacy(raw.schemaVersion<3);}
    }catch(reason){if(version===request.current)setError(reason instanceof Error?reason.message:'This backup could not be read.');}
    finally{if(version===request.current)setReading(false);}
  }
  return <div className="panel settings-info backup-panel"><HardDrive size={21}/><h3>Workspace backup</h3>{storageMode==='database'&&<p>Importing replaces this PostgreSQL workspace. To migrate browser records, export JSON from the offline file first, then select it here.</p>}<p>Save all production records, imported orders, import versions, products, settings and activity as JSON. Choose a backup to preview it before replacing this workspace.</p>
    <div className="backup-controls"><button type="button" className="button secondary full-width" onClick={()=>void download()}><Download size={15}/>Download backup</button><button type="button" className="button secondary full-width" disabled={reading||mutationLocked||hasConflict} onClick={()=>input.current?.click()}><Upload size={15}/>{reading?'Reading backup…':'Restore JSON backup'}</button><input ref={input} type="file" accept=".json,application/json" hidden aria-label="Backup JSON file" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void read(file);}}/></div>
    {error&&<p role="alert" className="backup-error">{error}</p>}
    {candidate&&<section className="backup-preview" aria-label="Backup preview"><h4>Review before restoring</h4><dl><div><dt>File</dt><dd>{filename}</dd></div><div><dt>Site</dt><dd>{planning!.settings.siteName}</dd></div><div><dt>Production records</dt><dd>{planning!.jobs.length}</dd></div><div><dt>Planning dates</dt><dd>{dates.length?`${dateLabel(dates[0],true)} – ${dateLabel(dates[dates.length-1],true)}`:'No production records'}</dd></div><div><dt>Catalog products</dt><dd>{planning!.catalog.length}</dd></div><div><dt>Imported orders</dt><dd>{sourceOrders}</dd></div><div><dt>Activity entries</dt><dd>{planning!.events.length}</dd></div></dl>{legacy&&<p className="backup-error" role="alert">This older backup has no imported order data. Restoring it clears the current Data orders and source links; a full recovery copy is retained. Version 1 also has no product catalog.</p>}<p>This replaces the current {state.jobs.length} records, imported orders, products, settings and activity. Final validation runs before saving. Records are not merged. A copy of the current workspace is kept for download after restoring.</p>{failed&&failureMessage&&<p role="alert" className="backup-error">{failureMessage}</p>}<button type="button" className="button danger" disabled={mutationLocked||hasConflict} onClick={async()=>{if(await restoreBackup(candidate)){setCandidate(null);setFilename('');setFailed(false);}else setFailed(true);}}>Replace workspace with this backup</button><button type="button" className="text-link" disabled={mutationLocked} onClick={()=>{setCandidate(null);setFilename('');setFailed(false);}}>Cancel restore</button></section>}
    {previousBackup&&<div className="backup-previous"><p>The workspace saved immediately before the latest workspace replacement is available here.</p><button type="button" className="text-link" onClick={()=>void download(true)}><Download size={14}/>Download previous workspace</button></div>}
  </div>;
}
