import { useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryDraftJob, InventoryDraftPreview } from '../domain/inventoryTypes';
import { readDatabaseWorkspace } from './api';
import { previewInventoryDraft } from './inventoryApi';
import { useWorkspace } from './workspace';
import { localDate } from './format';
import { useCurrentTime } from './useCurrentTime';
import { clearLeaveGuard, confirmLeave, useLeaveGuard } from './leaveGuard';
import { PLANNING_DRAFT_STORAGE_KEY, clearPlanningDraft, createPlanningDraft, isPlanningDraftStale, planningDraftFingerprint, preparePlanningDraftCommit, readPlanningDraft, savePlanningDraft } from './planningDraftStorage';
import type { PlanningDraftUiState, SavedPlanningDraft } from './planningDraftStorage';

const storage = { getItem: (key: string) => window.localStorage.getItem(key), setItem: (key: string, value: string) => window.localStorage.setItem(key, value), removeItem: (key: string) => window.localStorage.removeItem(key) };
const content = (draft: SavedPlanningDraft) => JSON.stringify({ preview: draft.preview, jobs: draft.jobs, ui: draft.ui });

/** A local draft is separate from production. Its exact pending request survives a reload. */
export function usePlanningDraft(onClose: () => void) {
  const { date, revision, workspaceUpdatedAt, refresh, resolveConflict, commitPrepared, confirmedRetry, mutationLocked, setDate, navigate, notify } = useWorkspace();
  const [initial] = useState(() => readPlanningDraft(storage));
  const initialSaved = initial.ok ? initial.value.draft : null;
  const start = date < localDate() ? localDate() : date;
  const [ui, setUi] = useState<PlanningDraftUiState>(() => initialSaved?.pendingCommit ? initialSaved.ui : { from: start, to: new Date(Date.parse(start + 'T12:00:00Z') + 3 * 86400000).toISOString().slice(0, 10), demandThrough: new Date(Date.parse(localDate() + 'T12:00:00Z') + 3 * 86400000).toISOString().slice(0, 10), combineSameProduct: true });
  const [stored, setStored] = useState(initialSaved);
  const storedRef = useRef(stored); storedRef.current = stored;
  const [preview, setPreview] = useState<InventoryDraftPreview | null>(initialSaved?.pendingCommit ? initialSaved.preview : null);
  const [jobs, setJobs] = useState<InventoryDraftJob[]>(initialSaved?.pendingCommit ? initialSaved.jobs : []);
  const [identity, setIdentity] = useState(initialSaved?.pendingCommit ? initialSaved.draftInstanceId : crypto.randomUUID());
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(initialSaved?.pendingCommit ? initialSaved.baseUpdatedAt : '');
  const [savedContent, setSavedContent] = useState(initialSaved?.pendingCommit ? content(initialSaved) : '');
  const [error, setError] = useState(initial.ok ? '' : initial.error);
  const [invalidSaved, setInvalidSaved] = useState(!initial.ok && initial.code === 'invalid');
  const [busy, setBusy] = useState(false);
  const [crossTab, setCrossTab] = useState(false);
  const [localStatus, setLocalStatus] = useState('');
  const pending = stored?.draftInstanceId === identity ? stored.pendingCommit : undefined;
  const currentContent = useMemo(() => JSON.stringify({ preview, jobs, ui }), [preview, jobs, ui]);
  const dirty = !!preview && currentContent !== savedContent && !pending;
  useLeaveGuard('planning-draft', dirty, 'Your planning draft has changes that are not saved in this browser.');
  const now = useCurrentTime(!!preview);
  const datePassed = jobs.some(job => job.date < localDate(new Date(now)));
  const stale = !!preview && (datePassed || isPlanningDraftStale({ baseRevision: preview.revision, baseUpdatedAt } as SavedPlanningDraft, { revision, updatedAt: workspaceUpdatedAt }));
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === PLANNING_DRAFT_STORAGE_KEY || event.key === null) { setCrossTab(true); setLocalStatus(''); } };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
  const expectation = () => stored ? { draftInstanceId: stored.draftInstanceId, savedAt: stored.savedAt, draftFingerprint: planningDraftFingerprint(stored), pendingCommandId: stored.pendingCommit?.commandId ?? null } : { draftInstanceId: null };
  function snapshot() {
    if (!preview || !baseUpdatedAt) throw new Error('Generate a planning draft before saving it.');
    return createPlanningDraft({ baseRevision: preview.revision, baseUpdatedAt, preview, jobs, ui, draftInstanceId: identity });
  }
  function saveLocal() {
    if (pending || crossTab) return false;
    try {
      const result = savePlanningDraft(storage, snapshot(), expectation());
      if (!result.ok) { setError(result.error); return false; }
      setStored(result.value); setSavedContent(content(result.value)); setError(''); setLocalStatus('Saved in this browser only. It is not yet production planning.'); clearLeaveGuard('planning-draft'); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Draft could not be saved.'); return false; }
  }
  function resume() {
    if (!confirmLeave('planning-draft')) return;
    const result = readPlanningDraft(storage);
    if (!result.ok) { setError(result.error); setInvalidSaved(result.code === 'invalid'); return; }
    const draft = result.value.draft; setInvalidSaved(false);
    setStored(draft); setCrossTab(false); setError('');
    if (!draft) { setPreview(null); setJobs([]); setLocalStatus('No saved planning draft remains in this browser.'); clearLeaveGuard('planning-draft'); return; }
    setPreview(draft.preview); setJobs(draft.jobs); setUi(draft.ui); setIdentity(draft.draftInstanceId); setBaseUpdatedAt(draft.baseUpdatedAt); setSavedContent(content(draft)); setLocalStatus('Saved in this browser only. Review before confirming production.'); clearLeaveGuard('planning-draft');
  }
  function discard() {
    if (stored?.pendingCommit) { setError('Check the previous save before discarding or generating another draft.'); return; }
    if (!window.confirm('Discard the saved planning draft from this browser? Production records will stay unchanged.')) return;
    // Native confirmation can queue a different tab's storage event. Re-read before
    // deleting an unreadable value so a newly valid/pending draft is preserved.
    if (!stored) {
      const latest = readPlanningDraft(storage);
      if (latest.ok && latest.value.draft) { setCrossTab(true); setError('Another tab saved a readable draft. Load it before making changes.'); return; }
      if (!latest.ok && latest.code !== 'invalid') { setError(latest.error); return; }
    }
    const result = clearPlanningDraft(storage, stored ? expectation() : undefined);
    if (!result.ok) { setError(result.error); return; }
    setStored(null); setInvalidSaved(false); setCrossTab(false); setError(''); setPreview(null); setJobs([]); setSavedContent(''); setLocalStatus('Saved browser draft discarded.'); clearLeaveGuard('planning-draft');
  }
  function finish(draft: SavedPlanningDraft) {
    const result = clearPlanningDraft(storage, { draftInstanceId: draft.draftInstanceId, pendingCommandId: draft.pendingCommit?.commandId ?? null });
    // A confirmed command must never be submitted as a new batch, even if local cleanup fails.
    clearLeaveGuard('planning-draft'); setPreview(null); setJobs([]); setStored(null); setSavedContent('');
    if (!result.ok) notify('Production is confirmed. The saved browser draft could not be removed; its original request ID remains safe to check.', true);
    setDate(draft.ui.from); navigate('planning'); onClose();
  }
  const retryAtMount = useRef(confirmedRetry?.nonce ?? 0);
  useEffect(() => {
    const draft = storedRef.current;
    if (confirmedRetry && confirmedRetry.nonce > retryAtMount.current && confirmedRetry.type === 'planning.commitDraft' && draft?.pendingCommit) finish(draft);
  }, [confirmedRetry?.nonce]);
  async function submit() {
    if (busy || crossTab || mutationLocked) return;
    setBusy(true); setError('');
    try {
      let draft = stored;
      if (!pending) {
        if (stale) throw new Error('The workspace changed. Regenerate the draft before confirming.');
        const saved = savePlanningDraft(storage, snapshot(), expectation());
        if (!saved.ok) throw new Error(saved.error);
        const prepared = preparePlanningDraftCommit(storage, saved.value, crypto.randomUUID());
        if (!prepared.ok) throw new Error(prepared.error);
        draft = prepared.value.draft; setStored(draft); setSavedContent(content(draft)); clearLeaveGuard('planning-draft');
      }
      if (!draft?.pendingCommit) throw new Error('No pending production request is available.');
      const result = await commitPrepared(draft.pendingCommit, 'Planning confirmed. Production cards saved.');
      if (result.confirmed) finish(draft);
      else if (!result.uncertain) {
        const { pendingCommit: _pending, ...retained } = draft;
        const saved = savePlanningDraft(storage, retained, { draftInstanceId: draft.draftInstanceId, pendingCommandId: draft.pendingCommit.commandId, savedAt: draft.savedAt, draftFingerprint: planningDraftFingerprint(draft) });
        if (saved.ok) { setStored(saved.value); setSavedContent(content(saved.value)); }
        setError('The request was rejected; no new cards were saved. Review the latest workspace and regenerate the draft.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Planning could not be confirmed.'); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (stored?.pendingCommit || crossTab || busy) return;
    if (dirty && !window.confirm('Regenerate this draft and replace its unsaved edits?')) return;
    setBusy(true); setError('');
    try {
      const p = await previewInventoryDraft({ fromDate: ui.from, toDate: ui.to, demandThrough: ui.demandThrough, combineSameProduct: ui.combineSameProduct });
      const current = await readDatabaseWorkspace();
      if (current.revision !== p.revision) throw new Error('The workspace changed during generation. Generate the draft again.');
      await refresh(); resolveConflict(); setPreview(p); setJobs(p.jobs); setBaseUpdatedAt(current.updatedAt); setIdentity(crypto.randomUUID()); setSavedContent(''); setLocalStatus('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Draft could not be generated.'); }
    finally { setBusy(false); }
  }
  const close = () => { if (!busy && !mutationLocked && confirmLeave('planning-draft')) { clearLeaveGuard('planning-draft'); onClose(); } };
  function changeUi(patch: Partial<PlanningDraftUiState>) {
    if (pending || crossTab) return;
    if (preview && !confirmLeave('planning-draft')) return;
    setUi(previous => ({ ...previous, ...patch })); setPreview(null); setJobs([]); setLocalStatus(''); clearLeaveGuard('planning-draft');
  }
  return { ui, changeUi, preview, jobs, setJobs, error, busy, stored, pending, stale, datePassed, invalidSaved, crossTab, localStatus, dirty, saveLocal, resume, discard, generate, submit, close };
}
