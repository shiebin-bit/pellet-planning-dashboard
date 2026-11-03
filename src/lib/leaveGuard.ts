import { useEffect } from 'react';

const guards = new Map<string, string>();

/** Only unsaved forms register; confirmed saves and saved browser drafts are safe to leave. */
export function useLeaveGuard(key: string, dirty: boolean, message: string) {
  useEffect(() => {
    if (dirty) guards.set(key, message);
    else guards.delete(key);
    return () => { guards.delete(key); };
  }, [key, dirty, message]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
}

export function clearLeaveGuard(key: string) { guards.delete(key); }

export function confirmLeave(key?: string) {
  const messages = key ? [guards.get(key)].filter(Boolean) : [...new Set(guards.values())];
  return !messages.length || window.confirm(messages.join('\n\n') + '\n\nDiscard unsaved changes and leave?');
}
