// The little state Elfoqsy's column and the conversation share (P1): which conversation is open. It was the left screen's;
// the two panes can now be anywhere, so it lives here, and a choice made in one window reaches the other as an intent.
import { useSyncExternalStore } from 'react';
import { bus } from './bus';

interface Session {
  /** undefined: not chosen yet (the latest is shown); null: a new conversation; else its id. */
  chosen: string | null | undefined;
  /** When his first message in a new conversation was sent, to open it when it appears. */
  sentAt: number | null;
}

let current: Session = { chosen: undefined, sentAt: null };
const listeners = new Set<() => void>();
const set = (next: Session) => {
  current = next;
  for (const l of listeners) l();
};

export const session = {
  get: (): Session => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** He picked a conversation here: it is open in this window's conversation pane, and the other window's. */
  choose(id: string | null): void {
    set({ ...current, chosen: id });
    bus.emit({ t: 'select_conversation', id });
  },
  /** Heard from the other window. */
  chooseFromElsewhere(id: string | null): void {
    set({ ...current, chosen: id });
  },
  /** A first message went to a new conversation: it opens when it appears. */
  sent(at: number | null): void {
    set({ ...current, sentAt: at });
  },
  /** Back to nothing chosen (tests). */
  reset(): void {
    set({ chosen: undefined, sentAt: null });
  },
};

export const useSession = (): Session => useSyncExternalStore(session.subscribe, session.get);
