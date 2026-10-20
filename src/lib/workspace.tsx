import { createContext, useContext, useState, useRef, useMemo, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Board, ScheduledJob, LineId } from '../domain/types';
import type { Command, WorkspaceEnvelope } from '../domain/commands';
import { executeCommand } from '../domain/commands';
import { createEmptyState } from '../domain/defaults';
import { getBoard } from '../domain/engine';
import { createMoveUndoEvent } from '../domain/audit';
import { createSampleState } from '../domain/sample';
import { localDate } from './format';
import { parseWorkspaceBackup } from '../domain/backup';
import { PREVIOUS_WORKSPACE_KEY, storeRestoredWorkspace } from './restore';
import { ApiError, readDatabaseWorkspace, sendCommand } from './api';
import type { CommandRequest } from './api';

export type Page = 'overview' | 'planning' | 'history' | 'settings';
const STORAGE_KEY = 'millplan.workspace.v1';
const PAGES: Page[] = ['overview', 'planning', 'history', 'settings'];
const databaseMode = window.location.protocol !== 'file:';
function readPage(): Page {
  const candidate = window.location.hash.replace('#/', '').split('?')[0];
  if (candidate === 'input') return 'planning';
  return PAGES.includes(candidate as Page) ? candidate as Page : 'overview';
}
function loadState() {
  if (databaseMode) return { state: createEmptyState(), isDemo: false, warning: '' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const value = parseWorkspaceBackup(raw);
      return { state: value, isDemo: localStorage.getItem(STORAGE_KEY + '.demo') !== 'false', warning: '' };
    }
  } catch {
    return { state: createSampleState(localDate()), isDemo: true, warning: 'Saved data is unavailable. The sample schedule is shown; export a backup before closing this browser.' };
  }
  return { state: createSampleState(localDate()), isDemo: true, warning: '' };
}
interface Workspace {
  state: AppState; board: Board; date: string; setDate: (date: string) => void;
  page: Page; navigate: (page: Page) => void;
  selectedId: string | null; selectedJob: ScheduledJob | null;
  openJob: (id: string, goToPlanning?: boolean) => void; closeJob: () => void;
  editor: { jobId: string | null; lineId: LineId } | null;
  openInput: (lineId?: LineId) => void; closeInput: () => void; editJob: (id: string) => void;
  copyDialog: { id: string; targetDate: string } | null;
  openCopy: () => void; closeCopy: () => void;
  commit: (command: Command, message: string, undoable?: boolean) => Promise<boolean>;
  undo: () => Promise<void>; canUndo: boolean; toast: { message: string; error: boolean } | null;
  notify: (message: string, error?: boolean) => void;
  resetDemo: () => Promise<boolean>; isDemo: boolean; savedAt: string | null; storageWarning: string;
  restoreBackup: (backup: AppState) => Promise<boolean>; previousBackup: AppState | null;
  storageMode: 'database' | 'offline'; busy: boolean; refresh: () => Promise<void>;
  hasConflict: boolean; resolveConflict: () => void; mutationLocked: boolean;
  confirmedRetry: { nonce: number; type: Command['type'] } | null;
}
const WorkspaceContext = createContext<Workspace | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadState);
  const [state, setState] = useState(initial.state);
  const stateRef = useRef(state);
  const [date, setDateState] = useState(localDate());
  const [page, setPage] = useState<Page>(readPage);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedSnapshot = useRef<ScheduledJob | null>(null);
  const [editor, setEditor] = useState<Workspace['editor']>(() => window.location.hash === '#/input' ? { jobId: null, lineId: 'PM1' } : null);
  const [copyDialog, setCopyDialog] = useState<Workspace['copyDialog']>(null);
  const [toast, setToast] = useState<Workspace['toast']>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(initial.isDemo);
  const [storageWarning, setStorageWarning] = useState(initial.warning);
  const undoState = useRef<AppState | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const reading = useRef(false);
  const remote = useRef<WorkspaceEnvelope | null>(null);
  const uncertain = useRef<CommandRequest | null>(null);
  const uncertainSource = useRef<{ editor: string | null; selectedId: string | null; page: Page; copyId: string | null } | null>(null);
  const awaitingConfirmation = useRef(false);
  const [awaiting, setAwaiting] = useState(false);
  const conflict = useRef(false);
  const [hasConflict, setHasConflict] = useState(false);
  const [confirmedRetry, setConfirmedRetry] = useState<Workspace['confirmedRetry']>(null);
  const confirmationNonce = useRef(0);
  const [loaded, setLoaded] = useState(!databaseMode);
  const [loadError, setLoadError] = useState('');
  const interaction = useRef(false);
  interaction.current = Boolean(editor || selectedId || copyDialog || page === 'settings');
  const editorRef = useRef(editor); editorRef.current = editor;
  const copyRef = useRef(copyDialog); copyRef.current = copyDialog;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const pageRef = useRef(page); pageRef.current = page;
  const [previousBackup, setPreviousBackup] = useState<AppState | null>(() => {
    if (databaseMode) return null;
    try { const raw = localStorage.getItem(PREVIOUS_WORKSPACE_KEY); return raw ? parseWorkspaceBackup(raw) : null; } catch { return null; }
  });
  const board = useMemo(() => getBoard(state, date), [state, date]);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const registerConflict = useCallback(() => { conflict.current = true; setHasConflict(true); }, []);
  const resolveConflict = useCallback(() => { conflict.current = false; setHasConflict(false); }, []);
  const clearUncertain = useCallback(() => {
    uncertain.current = null; uncertainSource.current = null;
    awaitingConfirmation.current = false; setAwaiting(false);
  }, []);
  const acceptRemote = useCallback((next: WorkspaceEnvelope) => {
    if (remote.current && next.revision < remote.current.revision) return;
    if (!remote.current || next.revision !== remote.current.revision) {
      stateRef.current = next.state; setState(next.state);
    }
    remote.current = next;
    setIsDemo(next.isDemo); setPreviousBackup(next.previousBackup); setSavedAt(next.updatedAt);
    setCanUndo(next.canUndo); setStorageWarning(''); setLoadError(''); setLoaded(true);
  }, []);
  const refresh = useCallback(async (force = true) => {
    if (!databaseMode || saving.current || reading.current || (!force && interaction.current && remote.current)) return;
    reading.current = true;
    try {
      if (uncertain.current) {
        const pending = uncertain.current;
        const source = uncertainSource.current;
        const result = await sendCommand(pending);
        clearUncertain(); acceptRemote(result);
        setConfirmedRetry({ nonce: ++confirmationNonce.current, type: pending.command.type });
        const currentEditor = editorRef.current;
        const currentEditorKey = currentEditor ? `${currentEditor.jobId ?? 'new'}:${currentEditor.lineId}` : null;
        if (source?.editor && source.editor === currentEditorKey) setEditor(null);
        if (source?.selectedId && source.selectedId === selectedRef.current) setSelectedId(null);
        if (source?.copyId && source.copyId === copyRef.current?.id && pending.command.type === 'job.copyBatch') {
          setCopyDialog(null); setDateState(pending.command.targetDate);
        }
        notify('The previous change is confirmed in PostgreSQL.');
      } else {
        const next = await readDatabaseWorkspace();
        if (!force && interaction.current && remote.current) return;
        const changed = Boolean(remote.current && next.revision > remote.current.revision);
        const draftConflict = Boolean(force && changed && interaction.current);
        acceptRemote(next);
        if (draftConflict) {
          registerConflict();
          notify('Another planner updated the workspace. Your open draft is preserved; reload the latest data before applying it.', true);
        } else if (changed) notify('Workspace updated from PostgreSQL.');
      }
    } catch (error) {
      if (error instanceof ApiError && error.workspace) {
        clearUncertain(); acceptRemote(error.workspace); registerConflict();
        notify('Another planner updated the workspace. The last action was not applied; review the latest plan and try again.', true);
      } else {
        if (error instanceof ApiError && error.code !== 'DATABASE_UNAVAILABLE') clearUncertain();
        const message = uncertain.current
          ? 'The last save could not be confirmed. Retry connection to check it before making another change.'
          : 'PostgreSQL is unavailable. Reconnect before saving changes.';
        setStorageWarning(message);
        if (!remote.current) setLoadError('Cannot connect to the planning database. Start the Docker services, then retry.');
      }
    } finally { reading.current = false; }
  }, [acceptRemote, clearUncertain, notify, registerConflict]);
  useEffect(() => {
    if (!databaseMode) return;
    void refresh(false);
    const timer = setInterval(() => { void refresh(false); }, 15_000);
    const focus = () => { void refresh(false); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [refresh]);
  useEffect(() => {
    const update = () => {
      const requested = readPage();
      const legacyInput = window.location.hash.replace('#/', '').split('?')[0] === 'input';
      if ((saving.current || awaitingConfirmation.current) && (legacyInput || requested !== pageRef.current)) {
        window.history.replaceState(null, '', '#/' + pageRef.current);
        blocked();
        return;
      }
      if (legacyInput) {
        setSelectedId(null); setEditor({ jobId: null, lineId: 'PM1' });
        window.history.replaceState(null, '', '#/planning');
      }
      setPage(requested);
    };
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), toast.error ? 8000 : 4200);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (databaseMode) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const next = parseWorkspaceBackup(event.newValue);
        if (JSON.stringify(next) === JSON.stringify(stateRef.current)) return;
        getBoard(next, date); stateRef.current = next; setState(next);
        if (interaction.current) registerConflict();
        undoState.current = null; setCanUndo(false); notify('Workspace updated from another tab.');
      } catch { notify('Could not read the workspace update from another tab.', true); }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [date, notify, registerConflict]);
  const locked = () => saving.current || awaitingConfirmation.current;
  const blocked = () => { notify('Confirm the pending database save before leaving this work.', true); };
  const navigate = (next: Page) => {
    if (locked()) { blocked(); return; }
    window.location.hash = '/' + next; setPage(next);
  };
  const changeDate = (next: string) => {
    if (locked()) { blocked(); return; }
    setDateState(next);
  };
  const persist = (next: AppState) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    stateRef.current = next; setState(next); setSavedAt(new Date().toISOString()); setStorageWarning('');
  };
  const commit: Workspace['commit'] = async (command, message, undoable = false) => {
    if (saving.current) { notify('A change is still being saved. Please wait.', true); return false; }
    if (conflict.current) { notify('Reload the latest data before applying another change.', true); return false; }
    if (databaseMode && (!remote.current || uncertain.current)) {
      notify('Retry the database connection to confirm the previous save first.', true); return false;
    }
    saving.current = true; setBusy(true);
    try {
      if (databaseMode) {
        const request = { expectedRevision: remote.current!.revision, commandId: crypto.randomUUID(), command };
        uncertain.current = request;
        const currentEditor = editorRef.current;
        uncertainSource.current = {
          editor: currentEditor ? `${currentEditor.jobId ?? 'new'}:${currentEditor.lineId}` : null,
          selectedId: selectedRef.current,
          page: pageRef.current,
          copyId: copyRef.current?.id ?? null,
        };
        const next = await sendCommand(request);
        clearUncertain(); acceptRemote(next);
      } else {
        const previous = stateRef.current;
        if (command.type === 'workspace.restore') {
          const restored = storeRestoredWorkspace(localStorage, previous, command.backup);
          stateRef.current = restored.state; setState(restored.state); setPreviousBackup(restored.previous);
          setIsDemo(false); setSavedAt(new Date().toISOString()); setStorageWarning('');
          try { localStorage.setItem(STORAGE_KEY + '.demo', 'false'); } catch { /* Cosmetic metadata. */ }
        } else if (command.type === 'workspace.resetDemo') {
          persist(createSampleState(command.date)); setIsDemo(true);
          try { localStorage.setItem(STORAGE_KEY + '.demo', 'true'); } catch { /* Cosmetic metadata. */ }
        } else if (command.type === 'workspace.undoLastMove') {
          if (!undoState.current) throw new Error('No planning move is available to undo.');
          persist({ ...undoState.current, events: [...previous.events, createMoveUndoEvent(previous, undoState.current, crypto.randomUUID(), new Date().toISOString())] });
        } else {
          persist(executeCommand(previous, command, { nowIso: new Date().toISOString() }));
        }
        undoState.current = undoable ? structuredClone(previous) : null;
        setCanUndo(undoState.current !== null);
      }
      if (command.type === 'workspace.restore' || command.type === 'workspace.resetDemo') {
        setConfirmedRetry({ nonce: ++confirmationNonce.current, type: command.type });
      }
      notify(message); return true;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code !== 'DATABASE_UNAVAILABLE') clearUncertain();
        if (error.workspace) {
          acceptRemote(error.workspace); registerConflict();
          notify('Another planner updated the workspace. This action was not applied; review the latest plan and try again.', true);
        } else notify(error.message, true);
        if (error.code === 'DATABASE_UNAVAILABLE') {
          awaitingConfirmation.current = true; setAwaiting(true);
          setStorageWarning('The last save could not be confirmed. Retry the connection to check it before making another change.');
        }
      } else if (databaseMode) {
        awaitingConfirmation.current = true; setAwaiting(true);
        setStorageWarning('The last save could not be confirmed. Retry connection before making another change.');
        notify('The save could not be confirmed. Keep this form open and retry the database connection.', true);
      } else notify(error instanceof Error ? error.message : 'The change could not be saved.', true);
      return false;
    } finally { saving.current = false; setBusy(false); }
  };
  const undo = async () => { if (canUndo) await commit({ type: 'workspace.undoLastMove' }, 'Previous schedule restored.'); };
  const resetDemo = async () => {
    const saved = await commit({ type: 'workspace.resetDemo', date }, 'Sample schedule restored.');
    if (saved) { setSelectedId(null); setEditor(null); setCopyDialog(null); }
    return saved;
  };
  const restoreBackup = async (backup: AppState) => {
    const saved = await commit({ type: 'workspace.restore', backup }, 'Backup restored. Your previous workspace is available to download in Settings.');
    if (saved) {
      setSelectedId(null); setEditor(null); setCopyDialog(null);
      const dates = [...new Set(backup.jobs.map(job => job.date))].sort();
      if (dates.length && !dates.includes(date)) setDateState(dates[dates.length - 1]);
    }
    return saved;
  };
  let selectedJob: ScheduledJob | null = null;
  if (selectedId) {
    selectedJob = board.lines.flatMap(line => line.jobs).find(job => job.id === selectedId) || null;
    if (!selectedJob) {
      const job = state.jobs.find(job => job.id === selectedId);
      if (job) selectedJob = getBoard(state, job.date).lines.flatMap(line => line.jobs).find(item => item.id === selectedId) || {
        ...job, plannedStart: null, plannedEnd: null, durationMinutes: 0, rate: 0, changeoverMinutes: 0, segments: [], overflow: false,
      };
    }
    if (selectedJob) selectedSnapshot.current = selectedJob;
    else if (selectedSnapshot.current?.id === selectedId) selectedJob = selectedSnapshot.current;
  }
  return <WorkspaceContext.Provider value={{
    state, board, date, setDate: changeDate, page, navigate, selectedId, selectedJob,
    openJob: (id, goToPlanning = false) => { if (locked()) { blocked(); return; } setCopyDialog(null); setEditor(null); setSelectedId(id); if (goToPlanning) navigate('planning'); },
    closeJob: () => { if (locked()) { blocked(); return; } setSelectedId(null); }, editor,
    openInput: (lineId = 'PM1') => { if (locked()) { blocked(); return; } if (conflict.current) { notify('Reload the latest data before adding another task.', true); return; } setCopyDialog(null); setSelectedId(null); setEditor({ jobId: null, lineId }); },
    closeInput: () => { if (locked()) { blocked(); return; } setEditor(null); },
    copyDialog,
    openCopy: () => { if (locked()) { blocked(); return; } if (conflict.current) { notify('Reload the latest data before copying a plan.', true); return; } setEditor(null); setSelectedId(null); setCopyDialog({ id: crypto.randomUUID(), targetDate: date }); },
    closeCopy: () => { if (locked()) { blocked(); return; } setCopyDialog(null); },
    editJob: id => { if (locked()) { blocked(); return; } if (conflict.current) { notify('Reload the latest data before editing another task.', true); return; } const job = stateRef.current.jobs.find(item => item.id === id); if (job) { setSelectedId(null); setEditor({ jobId: id, lineId: job.lineId }); } },
    commit, undo, canUndo: canUndo && !busy, toast, notify, resetDemo, isDemo, savedAt, storageWarning, restoreBackup, previousBackup,
    storageMode: databaseMode ? 'database' : 'offline', busy, refresh,
    hasConflict, resolveConflict, mutationLocked: busy || awaiting, confirmedRetry,
  }}>
    {databaseMode && !loaded ? <main className="connection-screen"><div className="panel"><span className="eyebrow">MILLPLAN · POSTGRESQL</span><h1>{loadError ? 'Database connection needed' : 'Opening your workspace…'}</h1><p role={loadError ? 'alert' : 'status'}>{loadError || 'Loading the saved production plan.'}</p>{loadError && <button className="button primary" onClick={() => { setLoadError(''); void refresh(); }}>Retry connection</button>}</div></main> : children}
  </WorkspaceContext.Provider>;
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('Workspace provider is missing.');
  return context;
}
