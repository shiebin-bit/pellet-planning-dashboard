import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Position = { left: number; top: number; scope: string | number };
const ListMemory = createContext<Map<string, unknown> | null>(null);

/** Navigation memory lasts for this app session; customer searches never enter browser storage. */
export function ListNavigationProvider({ children }: { children: ReactNode }) {
  const memory = useRef(new Map<string, unknown>());
  return <ListMemory.Provider value={memory.current}>{children}</ListMemory.Provider>;
}

export function useListState<T>(key: string | null, initial: T | (() => T)) {
  const memory = useContext(ListMemory);
  const [value, setValue] = useState<T>(() => key && memory?.has(key) ? memory.get(key) as T : typeof initial === 'function' ? (initial as () => T)() : initial);
  useLayoutEffect(() => { if (key) memory?.set(key, value); }, [memory, key, value]);
  return [value, setValue] as const;
}

/** Restore a table only for the same filters/page; a changed scope starts at its top-left. */
export function useListTableScroll(node: HTMLElement | null, key: string | null, scope: string | number, ready = true) {
  const memory = useContext(ListMemory);
  useLayoutEffect(() => {
    if (!node || !ready) return;
    const saved = key ? memory?.get(key) as Position | undefined : undefined;
    node.scrollTo({ left: saved?.scope === scope ? saved.left : 0, top: saved?.scope === scope ? saved.top : 0, behavior: 'instant' });
    const remember = () => { if (key) memory?.set(key, { left: node.scrollLeft, top: node.scrollTop, scope }); };
    node.addEventListener('scroll', remember, { passive: true });
    remember();
    return () => node.removeEventListener('scroll', remember);
  }, [memory, node, key, scope, ready]);
}

/** Wait for fetched rows before restoring page scroll, so short loading states cannot clamp it. */
export function useListPageScroll(key: string | null, ready: boolean) {
  const memory = useContext(ListMemory);
  const restored = useRef(false);
  const saved = useRef(key ? memory?.get(key) as Position | undefined : undefined);
  useEffect(() => {
    if (!key) return;
    const remember = () => { if (restored.current) memory?.set(key, { left: window.scrollX, top: window.scrollY, scope: '' }); };
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [memory, key]);
  useEffect(() => {
    if (!key || !ready || restored.current) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ left: saved.current?.left ?? 0, top: saved.current?.top ?? 0, behavior: 'instant' });
      restored.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [memory, key, ready]);
}
