import { useEffect, useRef, useState } from 'react';
import { Database, Warehouse, LayoutDashboard, CalendarRange, Plus, History, Settings2, Download, Menu, X, ChevronDown, FileSpreadsheet, Printer, Check, HardDrive, PanelLeftClose, Undo2 } from 'lucide-react';
import { ListNavigationProvider } from './lib/listNavigation';
import { WorkspaceProvider, useWorkspace } from './lib/workspace';
import type { Page } from './lib/workspace';
import { dateLabel, localDate } from './lib/format';
import { exportExcel, printReport } from './lib/export';
import logo from './assets/ffm-logo.jpg';
import { DataPage } from './pages/Data';
import { StockPage } from './pages/Stock';
import { ImportDialog } from './components/ImportDialog';
import { SourcePlanningDialog } from './components/SourcePlanningDialog';
import { Overview } from './pages/Overview';
import { Planning } from './pages/Planning';
import { ProductionEditor } from './components/ProductionEditor';
import { HistoryPage } from './pages/History';
import { SettingsPage } from './pages/Settings';
import { JobDrawer } from './components/JobDrawer';
import { PrintReport } from './components/PrintReport';
import { DatePicker } from './components/DatePicker';
import { ReportDialog } from './components/ReportDialog';
import { CopyPlanningDialog } from './components/CopyPlanningDialog';
import type { ProductionReport } from './domain/reports';

const navigation = [
  { id: 'overview' as Page, label: 'Overview', icon: LayoutDashboard },
  { id: 'planning' as Page, label: 'Planning board', icon: CalendarRange },
  { id: 'data' as Page, label: 'Data', icon: Database },
  { id: 'stock' as Page, label: 'Stock', icon: Warehouse },
  { id: 'history' as Page, label: 'History', icon: History },
  { id: 'settings' as Page, label: 'Settings', icon: Settings2 },
];
export function App() { return <WorkspaceProvider><ListNavigationProvider><Dashboard /></ListNavigationProvider></WorkspaceProvider>; }

function Dashboard() {
  const { state, board, date, setDate, page, navigate, openInput, editor, copyDialog, importOpen, sourceDialog, selectedId, toast, savedAt, storageWarning, notify, canUndo, undo,isDemo,storageMode,busy,refresh,hasConflict,resolveConflict,mutationLocked } = useWorkspace();
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [exportsOpen, setExportsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reportOpen,setReportOpen]=useState(false);
  const [printJob,setPrintJob]=useState<{report:ProductionReport|null}|null>(null);
  const modalOpen=!!editor||!!copyDialog||reportOpen||importOpen||!!sourceDialog;
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  const navigationRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeNavigationRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const planningTools = page === 'overview' || page === 'planning';
  const reportTools = planningTools || page === 'history';
  const toolbarContext = {data:'Customer orders · filter by delivery date below',stock:'Stock balances · Daily stock uses its own date',history:'Production records · filter by planning date below',settings:'Shared workspace settings'};
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const changed = () => setSmallScreen(media.matches);
    media.addEventListener('change', changed);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileNav(false); setExportsOpen(false); } };
    window.addEventListener('keydown', key);
    return () => { media.removeEventListener('change', changed); window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    if (!mobileNav || !smallScreen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeNavigationRef.current?.focus();
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(navigationRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []).filter(element => element.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', containFocus);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', containFocus);
      menuRef.current?.focus();
    };
  }, [mobileNav, smallScreen]);
  useEffect(() => { setMobileNav(false); setExportsOpen(false); window.scrollTo(0, 0); }, [page]);
  useEffect(()=>{if(!printJob)return;const frame=requestAnimationFrame(()=>printReport());return()=>cancelAnimationFrame(frame);},[printJob]);
  useEffect(()=>{const finished=()=>setPrintJob(null);window.addEventListener('afterprint',finished);return()=>window.removeEventListener('afterprint',finished);},[]);
  const excel = async () => {
    setExportsOpen(false); setExporting(true);
    try { await exportExcel(board, state); notify('Excel report downloaded.'); }
    catch { notify('The Excel report could not be generated. Please try again.', true); }
    finally { setExporting(false); }
  };
  return <div className={'app-shell page-is-'+page+' ' + (collapsed ? 'nav-collapsed ' : '') + (mobileNav ? 'nav-open' : '')}>
    {mobileNav && <button className="nav-scrim" tabIndex={-1} aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className="sidebar" id="workspace-navigation" ref={navigationRef} role={smallScreen ? 'dialog' : undefined} aria-modal={smallScreen && mobileNav ? true : undefined} aria-label={smallScreen ? 'Workspace navigation' : undefined} inert={modalOpen || (smallScreen && !mobileNav)} aria-hidden={modalOpen || (smallScreen && !mobileNav)}>
      <button className="brand" disabled={mutationLocked} onClick={() => { navigate('overview'); setMobileNav(false); }} aria-label="Millplan overview">
        <img className="brand-logo" src={logo} alt="FFM"/><span className="brand-name">millplan</span>
      </button>
      <button ref={closeNavigationRef} className="mobile-close icon-button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={20} /></button>
      <div className="site-switch"><strong>{state.settings.siteName}</strong><span>Production planning</span></div>
      <nav aria-label="Main navigation">{navigation.map(item => <button key={item.id} disabled={mutationLocked} className={'nav-item ' + (page === item.id ? 'active' : '')} aria-current={page === item.id ? 'page' : undefined} onClick={() => { navigate(item.id); setMobileNav(false); }} title={item.label}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom">
        <div className="workspace-note"><HardDrive size={15}/><div><strong>{storageMode==='database'?'PostgreSQL workspace':'Local workspace'}</strong><p>{storageMode==='database'?'PostgreSQL connected':'Saved on this browser'}</p></div></div>
        {isDemo&&<div className="demo-note">Demo workspace</div>}
        <button className="collapse-nav" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><PanelLeftClose size={17} /><span>Collapse sidebar</span></button>
      </div>
    </aside>
    <div className="workspace" inert={modalOpen || (smallScreen && mobileNav)} aria-hidden={modalOpen || (smallScreen && mobileNav) ? true : undefined}>
      <header className="topbar">
        <button ref={menuRef} className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation" aria-expanded={mobileNav} aria-controls="workspace-navigation"><Menu size={21} /></button>
        <div className={'page-toolbar '+(planningTools?'planning-tools':'context-tools')} aria-label="Workspace toolbar">
          {planningTools?<><DatePicker value={date} onChange={setDate}/><button className="today-button" disabled={mutationLocked} onClick={() => setDate(localDate())}>Today</button></>:<span className="toolbar-context">{toolbarContext[page as keyof typeof toolbarContext]}</span>}
          <div className="toolbar-spacer" />
          <span className="save-indicator"><Check size={14} />{busy?'Saving…':storageWarning?'Connection / storage issue':hasConflict?'Review latest changes':savedAt?'All changes saved':storageMode==='database'?'Database connected':'Local workspace'}</span>
          {reportTools&&<div className="export-container" onKeyDown={event => { if (event.key === 'Escape') { setExportsOpen(false); exportRef.current?.focus(); } }}><button ref={exportRef} className="button secondary" aria-label={exporting ? 'Exporting report' : 'Export'} onClick={() => setExportsOpen(!exportsOpen)} aria-expanded={exportsOpen} disabled={exporting}><Download size={15} /><span>{exporting ? 'Exporting…' : 'Export'}</span><ChevronDown size={13} /></button>
            {exportsOpen && <><button className="menu-scrim" tabIndex={-1} onClick={() => setExportsOpen(false)} aria-label="Close export menu" /><div className="dropdown export-menu"><span className="dropdown-label">PLANNING-DAY REPORTS · {dateLabel(date, true)}</span><button onClick={excel}><FileSpreadsheet size={17} /><div><strong>Excel report</strong><small>Planning date: {dateLabel(date, true)} · all four lines</small></div></button><button onClick={() => { setExportsOpen(false); setPrintJob({report:null}); }}><Printer size={17} /><div><strong>Print / save as PDF</strong><small>Planning date: {dateLabel(date, true)} · all four lines</small></div></button><button disabled={mutationLocked} onClick={()=>{setExportsOpen(false);setReportOpen(true);}}><CalendarRange size={17}/><div><strong>Date range report</strong><small>Choose planning dates and production lines</small></div></button><p className="export-scope-note">Quick reports use {dateLabel(date, true)}, all four lines. History filters do not apply. Choose Date range report for other dates or lines.</p></div></>}
          </div>}
          {page==='history'&&<button className="button primary history-report-button" disabled={mutationLocked} onClick={()=>setReportOpen(true)}><CalendarRange size={16}/><span>Date range report</span></button>}
          {planningTools&&<button className="button primary add-production-button" disabled={mutationLocked||hasConflict} onClick={()=>openInput()}><Plus size={17} /><span>Add production</span></button>}
        </div>
      </header>
      <main id="main-content">
        {storageWarning && <div className="notice warning">{storageWarning}{storageMode==='database'&&<button className="text-link" disabled={busy} onClick={()=>void refresh()}>Retry connection</button>}</div>}
        {hasConflict&&!editor&&!selectedId&&page!=='settings'&&<div className="notice warning" role="alert">Another planner updated this workspace. Review the latest data before making another change. <button type="button" className="text-link" onClick={resolveConflict}>Reload latest workspace</button></div>}
        {page === 'overview' && <Overview />}
        {page === 'planning' && <Planning />}
        {page === 'data' && <DataPage />}
        {page === 'stock' && <StockPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage />}
        <footer className="page-footer"><span>{state.settings.siteName}</span><span>{storageMode==='database'?'Database workspace · MYT (UTC+8)':'Offline · Browser storage · MYT (UTC+8)'}</span></footer>
      </main>
    </div>
    <JobDrawer />
    {importOpen && <ImportDialog/>}
    {sourceDialog && <SourcePlanningDialog/>}
    {editor && <ProductionEditor/>}
    {copyDialog && <CopyPlanningDialog key={copyDialog.id}/>}
    {reportOpen&&<ReportDialog onClose={()=>setReportOpen(false)} onPrint={report=>{setReportOpen(false);setPrintJob({report});}}/>}
    {toast && !modalOpen && <div className={'toast ' + (selectedId?'production-toast ':'') + (toast.error ? 'error' : '')} role={toast.error ? 'alert' : 'status'}><span className="toast-symbol">{toast.error ? '!' : <Check size={16} />}</span><span>{toast.message}</span>{canUndo && <button onClick={undo}><Undo2 size={14} />Undo</button>}</div>}
    <PrintReport report={printJob?.report}/>
  </div>;
}
