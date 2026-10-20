import { useEffect, useState } from 'react';
import { LayoutDashboard, CalendarRange, Plus, History, Settings2, ChevronRight, Download, Menu, X, ChevronDown, FileSpreadsheet, Printer, Check, HardDrive, PanelLeftClose, Undo2 } from 'lucide-react';
import { WorkspaceProvider, useWorkspace } from './lib/workspace';
import type { Page } from './lib/workspace';
import { dateLabel, localDate } from './lib/format';
import { exportExcel, exportBackup, printReport } from './lib/export';
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
  { id: 'history' as Page, label: 'History', icon: History },
  { id: 'settings' as Page, label: 'Settings', icon: Settings2 },
];
export function App() { return <WorkspaceProvider><Dashboard /></WorkspaceProvider>; }

function Dashboard() {
  const { state, board, date, setDate, page, navigate, openInput, editor, copyDialog, selectedId, toast, savedAt, storageWarning, notify, canUndo, undo,isDemo,storageMode,busy,refresh,hasConflict,resolveConflict,mutationLocked } = useWorkspace();
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [exportsOpen, setExportsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reportOpen,setReportOpen]=useState(false);
  const [printJob,setPrintJob]=useState<{report:ProductionReport|null}|null>(null);
  const modalOpen=!!editor||!!copyDialog||reportOpen;
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const changed = () => setSmallScreen(media.matches);
    media.addEventListener('change', changed);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileNav(false); setExportsOpen(false); } };
    window.addEventListener('keydown', key);
    return () => { media.removeEventListener('change', changed); window.removeEventListener('keydown', key); };
  }, []);
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
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className="sidebar" id="workspace-navigation" inert={modalOpen || (smallScreen && !mobileNav)} aria-hidden={modalOpen || (smallScreen && !mobileNav)}>
      <button className="brand" disabled={mutationLocked} onClick={() => navigate('overview')} aria-label="Millplan overview">
        <span className="brand-mark"><i /><i /><i /><i /></span><span className="brand-name">millplan<span className="brand-dot">.</span></span>
      </button>
      <button className="mobile-close icon-button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={20} /></button>
      <div className="site-switch"><span className="site-symbol">PI</span><div><strong>{state.settings.siteName}</strong><span>Production workspace</span></div></div>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(item => <button key={item.id} disabled={mutationLocked} className={'nav-item ' + (page === item.id ? 'active' : '')} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)} title={item.label}><item.icon size={19} /><span>{item.label}</span>{page === item.id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="workspace-note"><span className="live-dot" /><div><strong>{storageMode==='database'?'PostgreSQL workspace':'Local workspace'}</strong><p>{storageMode==='database'?'Saved in the database':'Saved on this browser'}</p></div><HardDrive size={16} /></div>
        {isDemo&&<div className="demo-note"><span>DEMO DATA</span><p>Sample schedule based on your Excel. Ready to explore.</p></div>}
        <button className="collapse-nav" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><PanelLeftClose size={17} /><span>Collapse sidebar</span></button>
      </div>
    </aside>
    <div className="workspace" inert={modalOpen} aria-hidden={modalOpen ? true : undefined}>
      <header className="topbar">
        <div className="breadcrumbs"><button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation" aria-expanded={mobileNav} aria-controls="workspace-navigation"><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{navigation.find(item => item.id === page)?.label}</strong></div>
        <div className="topbar-right"><span className="save-indicator"><Check size={13} />{busy?'Saving…':storageWarning?'Connection / storage issue':hasConflict?'Review latest changes':savedAt?'All changes saved':storageMode==='database'?'Database connected':'Local workspace'}</span><span className="avatar">PL</span></div>
      </header>
      <main id="main-content">
        {storageWarning && <div className="notice warning">{storageWarning}{storageMode==='database'&&<button className="text-link" disabled={busy} onClick={()=>void refresh()}>Retry connection</button>}</div>}
        {hasConflict&&!editor&&!selectedId&&page!=='settings'&&<div className="notice warning" role="alert">Another planner updated this workspace. Review the latest data before making another change. <button type="button" className="text-link" onClick={resolveConflict}>Reload latest workspace</button></div>}
        <div className="page-toolbar">
          <DatePicker value={date} onChange={setDate}/>
          <button className="today-button" disabled={mutationLocked} onClick={() => setDate(localDate())}>Today</button>
          <div className="toolbar-spacer" />
          <div className="export-container"><button className="button secondary" aria-label={exporting ? 'Exporting report' : 'Export'} onClick={() => setExportsOpen(!exportsOpen)} aria-expanded={exportsOpen} disabled={exporting}><Download size={15} /><span>{exporting ? 'Exporting…' : 'Export'}</span><ChevronDown size={13} /></button>
            {exportsOpen && <><button className="menu-scrim" onClick={() => setExportsOpen(false)} aria-label="Close export menu" /><div className="dropdown export-menu"><span className="dropdown-label">REPORT FOR {dateLabel(date, true)}</span><button onClick={excel}><FileSpreadsheet size={17} /><div><strong>Excel report</strong><small>Four lines + actual timestamps</small></div></button><button onClick={() => { setExportsOpen(false); setPrintJob({report:null}); }}><Printer size={17} /><div><strong>Print / save as PDF</strong><small>Daily planning report</small></div></button><button disabled={mutationLocked} onClick={()=>{setExportsOpen(false);setReportOpen(true);}}><CalendarRange size={17}/><div><strong>Date range report</strong><small>Day, week or custom dates · line filter</small></div></button><button onClick={() => { exportBackup(state); setExportsOpen(false); }}><HardDrive size={17} /><div><strong>Workspace backup</strong><small>All records as JSON</small></div></button></div></>}
          </div>
          <button className="button primary add-production-button" disabled={mutationLocked||hasConflict} onClick={()=>openInput()}><Plus size={17} /><span>Add production</span></button>
        </div>
        {page === 'overview' && <Overview />}
        {page === 'planning' && <Planning />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage />}
        <footer className="page-footer"><span>millplan. <span className="footer-separator">/</span> Production, in perspective.</span><span><span className="live-dot" />{storageMode==='database'?'PostgreSQL · MYT (UTC+8)':'Offline · Browser storage · MYT (UTC+8)'}</span></footer>
      </main>
    </div>
    <JobDrawer />
    {editor && <ProductionEditor/>}
    {copyDialog && <CopyPlanningDialog key={copyDialog.id}/>}
    {reportOpen&&<ReportDialog onClose={()=>setReportOpen(false)} onPrint={report=>{setReportOpen(false);setPrintJob({report});}}/>}
    {toast && !modalOpen && <div className={'toast ' + (toast.error ? 'error' : '')} role={toast.error ? 'alert' : 'status'}><span className="toast-symbol">{toast.error ? '!' : <Check size={16} />}</span><span>{toast.message}</span>{canUndo && <button onClick={undo}><Undo2 size={14} />Undo</button>}</div>}
    <PrintReport report={printJob?.report}/>
  </div>;
}
