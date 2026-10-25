import { useEffect, useRef } from 'react';

/** Shared keyboard/focus behaviour for the Data dialogs. */
export function useModal(onClose: () => void, isolateBackground = false) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const background = isolateBackground ? Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialog.current) && !['SCRIPT', 'STYLE'].includes(element.tagName)).map(element => ({ element, inert: element.inert })) : [];
    background.forEach(({ element }) => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLElement>('[data-autofocus],button,input,select')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]') ?? []).filter(element => element.offsetParent !== null && element.tabIndex >= 0 && !element.closest('[inert]'));
        if (!controls.length) { event.preventDefault(); dialog.current?.focus(); return; }
        const first = controls[0], last = controls.at(-1)!;
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', key); background.forEach(({ element, inert }) => { element.inert = inert; }); if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }); };
  }, [isolateBackground]);
  return dialog;
}
