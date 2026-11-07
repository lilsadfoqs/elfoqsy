// Which panes this window has folded (today's hide buttons): a window's own view state, as it always was, now kept outside the
// screen's component so that it is the same in today's columns and in a free layout, and survives the screen being taken
// apart by a drag and put together again. It is not the layout: it is not saved, and a reload shows every pane open.
import { useSyncExternalStore } from 'react';
import type { PaneId } from '@elfoqsy/state';

let current: ReadonlySet<PaneId> = new Set();
const listeners = new Set<() => void>();
const set = (next: ReadonlySet<PaneId>) => {
  current = next;
  for (const l of listeners) l();
};

export const folds = {
  get: (): ReadonlySet<PaneId> => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  fold(pane: PaneId): void {
    if (!current.has(pane)) set(new Set([...current, pane]));
  },
  unfold(pane: PaneId): void {
    if (current.has(pane)) set(new Set([...current].filter((p) => p !== pane)));
  },
  /** A pane that is not on this screen is not folded here: it comes back open. */
  keepOnly(panes: readonly PaneId[]): void {
    const kept = [...current].filter((p) => panes.includes(p));
    if (kept.length !== current.size) set(new Set(kept));
  },
  /** Nothing folded (tests). */
  reset(): void {
    if (current.size) set(new Set());
  },
};

export const useFolds = (): ReadonlySet<PaneId> => useSyncExternalStore(folds.subscribe, folds.get);
