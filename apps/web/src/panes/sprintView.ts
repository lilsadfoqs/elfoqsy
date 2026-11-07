// What the Sprint pane shows (the map, a ticket, a brief, a handoff, the create form), kept outside the pane so that it
// survives the pane being taken out of one arrangement and put in another (P2): a drag from today's screens, a pane moved to
// the other window. A change is passed to the other window as it happens and again when the pane leaves this one, so the
// window the pane lands in already has it. Nothing else of the pane follows: a ticket's scroll, a form half typed.
import { useSyncExternalStore } from 'react';
import type { Intent } from '@elfoqsy/contracts';
import type { SprintView } from '../left/sprint/SprintColumn';
import { bus } from './bus';

let current: SprintView = { kind: 'map' };
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** The part of a view the other window gets: which thing is open, not where it was scrolled to. */
export function forTheOtherWindow(view: SprintView): Extract<Intent, { t: 'sprint_view' }>['view'] {
  switch (view.kind) {
    case 'ticket':
      return { kind: 'ticket', key: view.key };
    case 'create':
      return view.draftId ? { kind: 'create', draftId: view.draftId } : { kind: 'create' };
    default:
      return view;
  }
}

export const sprintView = {
  get: (): SprintView => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Opened, closed or changed here: shown, and passed on. */
  set(view: SprintView): void {
    current = view;
    notify();
    bus.emit({ t: 'sprint_view', view: forTheOtherWindow(view) });
  },
  /** The pane is leaving this window: the other one is told what it showed, in case it has not been. */
  leaving(): void {
    bus.emit({ t: 'sprint_view', view: forTheOtherWindow(current) });
  },
  /** Heard from the other window. */
  fromElsewhere(view: Extract<Intent, { t: 'sprint_view' }>['view']): void {
    current = view;
    notify();
  },
  /** Back to the map (tests). */
  reset(): void {
    current = { kind: 'map' };
    notify();
  },
};

export const useSprintView = (): SprintView => useSyncExternalStore(sprintView.subscribe, sprintView.get);
