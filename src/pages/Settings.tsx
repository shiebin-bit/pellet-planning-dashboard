import { useEffect, useRef, useState } from 'react';
import { Save, Clock3, Factory, Plus, Trash2, Info, RotateCcw, Wrench } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { LINE_IDS } from '../domain/types';
import type { Settings, Downtime } from '../domain/types';
import { BackupPanel } from '../components/BackupPanel';
import { StockBrowser } from '../components/InventoryWorkspace';
import { CatalogPanel } from '../components/CatalogPanel';
import './Settings.css';

type SettingsTab = 'general' | 'rates' | 'downtime' | 'catalog' | 'stock' | 'backup';
const TABS: {id: SettingsTab; label: string}[] = [
  {id:'general',label:'Workspace'}, {id:'rates',label:'Production rules'},
  {id:'downtime',label:'Unavailable periods'}, {id:'catalog',label:'Products'},
  {id:'stock',label:'Stock policies'}, {id:'backup',label:'Backup & recovery'},
];

export function SettingsPage() {
  const {state,date,commit,resetDemo,busy,storageMode,hasConflict,resolveConflict,mutationLocked,confirmedRetry}=useWorkspace();
  const [form,setForm]=useState<Settings>(()=>structuredClone(state.settings));
  const [dirty,setDirty]=useState(false);
  const [tab,setTab]=useState<SettingsTab>('general');
  const formRef=useRef<HTMLFormElement>(null);
  const tabs=TABS.filter(item=>item.id!=='stock'||storageMode==='database');
  const panelProps=(id:SettingsTab)=>({id:`settings-panel-${id}`,role:'tabpanel',hidden:tab!==id,'aria-labelledby':`settings-tab-${id}`});
  function changeTab(id:SettingsTab){setTab(id);setConfirmReset(false);}
  function tabKey(event:React.KeyboardEvent,index:number){
    const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
    if(next===null)return;event.preventDefault();changeTab(tabs[next].id);document.getElementById(`settings-tab-${tabs[next].id}`)?.focus();
  }
  const [confirmReset,setConfirmReset]=useState(false);
  const [exception,setException]=useState<Omit<Downtime,'id'>>({date,lineId:'all',start:'12:00',end:'13:00',reason:''});
  useEffect(()=>{if(!dirty&&!hasConflict)setForm(structuredClone(state.settings));},[state.settings,dirty,hasConflict]);
  useEffect(()=>{
    if(confirmedRetry?.type==='settings.update'||confirmedRetry?.type==='workspace.restore'||confirmedRetry?.type==='workspace.resetDemo'){
      setForm(structuredClone(state.settings));setDirty(false);
    }
    if(confirmedRetry?.type==='workspace.restore'||confirmedRetry?.type==='workspace.resetDemo')setConfirmReset(false);
  },[confirmedRetry?.nonce]);
  const set=<K extends keyof Settings>(key:K,value:Settings[K])=>{setDirty(true);setForm(old=>({...old,[key]:value}));};
  async function save(event:React.FormEvent){
    event.preventDefault();if(hasConflict||mutationLocked)return;
    const invalid=formRef.current?.querySelector<HTMLInputElement>('input:invalid,select:invalid,textarea:invalid');
    if(invalid){
      const section=invalid.closest('[data-settings-section]')?.getAttribute('data-settings-section') as SettingsTab;
      if(section)setTab(section);
      requestAnimationFrame(()=>{invalid.focus();invalid.reportValidity();});return;
    }
    if(await commit({type:'settings.update',settings:form},'Settings saved. Pending tasks recalculated.'))setDirty(false);
  }
  function addException(){
    if(!exception.reason.trim()){document.getElementById('downtime-reason')?.focus();return;}
    set('downtime',[...form.downtime,{...exception,id:crypto.randomUUID()}]);
    setException(old=>({...old,reason:''}));
  }
  return <div className="page settings-page"><div className="page-heading"><div><h1>Workspace settings</h1><p>Set the working calendar, line capacities and planning rules.</p></div><span className="outline-badge">{storageMode==='database'?'Database configuration':'Local configuration'}</span></div>
    <div className="settings-controls">
      <div className="settings-savebar"><div className="settings-save-state" role="status"><i className={dirty?'unsaved':''}/><strong>{dirty?'Unsaved planning settings':'Planning settings saved'}</strong><span>{dirty?'Workspace, production rules and unavailable periods share this save.':'Product and stock changes save separately.'}</span></div><button className="button primary" type="submit" form="planning-settings" disabled={mutationLocked||hasConflict||!dirty}><Save size={16}/>{busy?'Saving…':'Save settings'}</button></div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">{tabs.map((item,index)=><button key={item.id} id={'settings-tab-'+item.id} role="tab" type="button" aria-selected={tab===item.id} aria-controls={'settings-panel-'+item.id} tabIndex={tab===item.id?0:-1} onKeyDown={event=>tabKey(event,index)} onClick={()=>changeTab(item.id)}>{item.label}</button>)}</div>
    </div>
    {hasConflict&&<div className="notice warning" role="alert">Your settings draft is preserved. <button type="button" className="text-link" onClick={()=>{setForm(structuredClone(state.settings));setDirty(false);resolveConflict();}}>Reload latest settings</button></div>}
    <form id="planning-settings" ref={formRef} onSubmit={save} noValidate>
      <div {...panelProps('general')} data-settings-section="general"><section className="panel form-panel" inert={mutationLocked||hasConflict}><div className="form-section-heading"><span><Factory size={18}/></span><div><h2>Workspace & working day</h2><p>A shared daily calendar for all four pelleting lines.</p></div></div><div className="field-grid"><label className="field span-2">Site name<input required value={form.siteName} onChange={e=>set('siteName',e.target.value)} maxLength={80}/></label><label className="field">Planning day starts<input disabled={!!form.calendarCutover} type="time" required value={form.dayStart} onChange={e=>set('dayStart',e.target.value)}/></label><label className="field">Daily available hours<div className="input-with-unit"><input disabled={!!form.calendarCutover} required type="number" min="0.5" max="24" step="0.5" value={form.availableHours} onChange={e=>set('availableHours',Number(e.target.value))}/><span>hrs</span></div></label><div className="field span-2"><div className="inline-info"><Info size={16}/><p>Production runs <strong>07:00–19:00 (12 hours)</strong> by default. Work that exceeds the shift continues the next day. After the production calendar is activated, shift hours are fixed. Downtime below is deducted from the available hours.</p></div></div><label className="field span-2">Time zone<input readOnly value="Asia/Kuala_Lumpur · MYT (UTC+8)"/></label></div></section></div>
      <div {...panelProps('rates')} data-settings-section="rates" className="settings-rules-layout"><section className="panel form-panel" inert={mutationLocked||hasConflict}><div className="form-section-heading"><span><Clock3 size={18}/></span><div><h2>Production rates & changeover</h2><p>Rates from the supplied production planning workbook.</p></div></div>
        <div className="rate-grid">{LINE_IDS.map(line=><label className="field rate-field" key={line}><span className="line-id">{line}</span><div className="input-with-unit"><input required type="number" min=".1" max="100" step=".1" value={form.rates[line]} onChange={e=>set('rates',{...form.rates,[line]:Number(e.target.value)})}/><span>MT/hr</span></div></label>)}</div>
        <div className="field-grid settings-rule-grid"><label className="field">PM2 slow-product prefixes<input value={form.slowProductPrefixes.join(', ')} onChange={e=>set('slowProductPrefixes',e.target.value.split(',').map(value=>value.trim()))}/><small>Comma-separated; compared with the start of the product code.</small></label><label className="field">PM2 slow-product rate<div className="input-with-unit"><input required type="number" min=".1" max="100" step=".1" value={form.slowRatePM2} onChange={e=>set('slowRatePM2',Number(e.target.value))}/><span>MT/hr</span></div></label><label className="field">Changeover duration<div className="input-with-unit"><input required type="number" min="0" max="240" step="1" value={form.changeoverMinutes} onChange={e=>set('changeoverMinutes',Number(e.target.value))}/><span>min</span></div><small>Imported orders compare the full material code. Manual cards compare the first four characters.</small></label><label className="field">Bag weight<div className="input-with-unit"><input required type="number" min="1" max="1000" step=".1" value={form.bagWeightKg} onChange={e=>set('bagWeightKg',Number(e.target.value))}/><span>kg</span></div><small>Recalculates pending manual bagged tasks. Imported cards retain their saved bag weight.</small></label></div>
      </section><div className="panel settings-info"><h3>Planned utilisation</h3><p>Planned utilisation = production hours within the day ÷ available line hours.</p><div className="formula-visual"><span>Production time</span><i/><strong>Available time</strong></div><p>Changeover is shown separately. Actual start and Done timestamps record elapsed time; they do not measure OEE.</p></div></div>
      <div {...panelProps('downtime')} data-settings-section="downtime"><section className="panel form-panel" inert={mutationLocked||hasConflict}><div className="form-section-heading"><span><Wrench size={18}/></span><div><h2>Unavailable periods</h2><p>Production pauses around maintenance or other planned downtime.</p></div></div>
        {form.downtime.length>0?<div className="downtime-list">{form.downtime.map(item=><div key={item.id}><span className="line-tag">{item.lineId==='all'?'All lines':item.lineId}</span><div><strong>{item.reason}</strong><small>{item.date} · {item.start}–{item.end}</small></div><button type="button" className="icon-button danger-text" aria-label={'Remove '+item.reason} onClick={()=>set('downtime',form.downtime.filter(old=>old.id!==item.id))}><Trash2 size={16}/></button></div>)}</div>:<div className="subtle-empty">No unavailable periods added. The daily calendar applies.</div>}
        <div className="exception-fields"><label className="field">Planning date<input type="date" value={exception.date} onChange={e=>setException(old=>({...old,date:e.target.value}))}/></label><label className="field">Line<select value={exception.lineId} onChange={e=>setException(old=>({...old,lineId:e.target.value as Downtime['lineId']}))}><option value="all">All lines</option>{LINE_IDS.map(line=><option key={line}>{line}</option>)}</select></label><label className="field">From<input type="time" value={exception.start} onChange={e=>setException(old=>({...old,start:e.target.value}))}/></label><label className="field">To<input type="time" value={exception.end} onChange={e=>setException(old=>({...old,end:e.target.value}))}/></label><label className="field exception-reason">Reason<input id="downtime-reason" value={exception.reason} onChange={e=>setException(old=>({...old,reason:e.target.value}))} placeholder="e.g. Planned maintenance"/></label><button type="button" className="button secondary" onClick={addException}><Plus size={15}/>Add period</button></div><p className="field-help">Times before the planning-day start belong to the following morning. Select Save settings to apply this list.</p>
      </section></div>
    </form>
    <div {...panelProps('catalog')}><CatalogPanel/></div>
    {storageMode==='database'&&<div {...panelProps('stock')}><section className="panel form-panel"><h2>Stock policies</h2><p>Set per-product bag weight, make-for-stock targets and production extra. Each change saves separately.</p><StockBrowser policiesOnly/></section></div>}
    <div {...panelProps('backup')} className="settings-backup-layout"><BackupPanel/><div className="reset-area"><h4>Reset sample schedule</h4><p>{storageMode==='database'?'Replaces all database records with the demo for the selected day. A recovery copy is kept.':'Replaces all locally saved records with the original demo for the selected day.'}</p>{confirmReset?<div className="reset-confirm"><strong>Replace the {storageMode==='database'?'database':'local'} workspace?</strong><button type="button" className="button danger" disabled={mutationLocked||hasConflict} onClick={async()=>{if(await resetDemo())setConfirmReset(false);}}>Replace with demo</button><button type="button" className="text-link" disabled={mutationLocked} onClick={()=>setConfirmReset(false)}>Keep my records</button></div>:<button type="button" className="text-link danger-text" disabled={mutationLocked||hasConflict} onClick={()=>setConfirmReset(true)}><RotateCcw size={14}/>Reset demo</button>}</div></div>
    <p className="settings-footnote">Running and completed tasks keep their locked schedule. Switching settings sections keeps your drafts.</p>
  </div>;
}
