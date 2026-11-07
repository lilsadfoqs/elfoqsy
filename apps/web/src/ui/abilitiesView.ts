// Whether this window shows the Abilities view, which card is selected and which tool it is
// filtered to: the window's own view state, like its folds (panes/folds.ts). It opens on the screen where it was asked for,
// from Elfoqsy's pane or from her notice's card, and is not saved: a reload shows the panes.
import { useSyncExternalStore } from 'react';
import type { AbilityTool } from '@elfoqsy/contracts';

export interface AbilitiesViewState {
  open: boolean;
  /** The card shown in the detail; the first card when none was chosen. */
  selected: string | null;
  filter: AbilityTool | null;
}

const CLOSED: AbilitiesViewState = { open: false, selected: null, filter: null };
let current = CLOSED;
const listeners = new Set<() => void>();
const set = (next: AbilitiesViewState) => {
  current = next;
  for (const l of listeners) l();
};

export const abilitiesView = {
  get: (): AbilitiesViewState => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Opens it, on a card when one is named (the notice's card), with no filter. */
  open(name?: string): void {
    set({ open: true, selected: name ?? current.selected, filter: null });
  },
  close(): void {
    if (current.open) set({ ...current, open: false });
  },
  select(name: string): void {
    set({ ...current, selected: name });
  },
  filter(tool: AbilityTool | null): void {
    set({ ...current, filter: tool });
  },
  /** Closed, nothing chosen (tests). */
  reset(): void {
    set(CLOSED);
  },
};

export const useAbilitiesView = (): AbilitiesViewState => useSyncExternalStore(abilitiesView.subscribe, abilitiesView.get, abilitiesView.get);
