import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { useModal } from './useModal';
import './ProductionEditor.css';
import './DetailDialog.css';

export function DetailDialog({ title, subtitle, closeLabel, onClose, children }: {
  title: string; subtitle: string; closeLabel: string; onClose: () => void; children: ReactNode;
}) {
  const { mutationLocked, busy, hasConflict, resolveConflict, storageWarning, refresh, toast } = useWorkspace();
  const initialToast = useRef(toast);
  const titleId = useId();
  const close = () => { if (!mutationLocked) onClose(); };
  const dialog = useModal(close, true);

  return createPortal(<div className="editor-layer detail-layer">
    <button className="editor-scrim" tabIndex={-1} disabled={mutationLocked} onClick={close} aria-label="Dismiss details"/>
    <section ref={dialog} tabIndex={-1} className="detail-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="editor-header">
        <div><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div>
        <button className="icon-button" disabled={mutationLocked} onClick={close} aria-label={closeLabel}><X size={21}/></button>
      </header>
      <div className="detail-dialog-body">
        {hasConflict && <div className="notice warning" role="alert">Another planner updated this workspace. Review the latest data before saving.<button className="text-link" disabled={mutationLocked} onClick={resolveConflict}>Reload latest workspace</button></div>}
        {storageWarning && <div className="notice warning">{storageWarning}<button className="text-link" disabled={busy} onClick={() => void refresh()}>Retry connection</button></div>}
        {toast && toast !== initialToast.current && <p className={toast.error ? 'data-error' : 'detail-dialog-status'} role={toast.error ? 'alert' : 'status'}>{toast.message}</p>}
        {children}
      </div>
    </section>
  </div>, document.body);
}
