// What one pane asks of another (P1): "open this ticket", "show this conversation", "find a ticket". A pane never reaches into
// another; it says what it wants, and whichever pane owns it does it. The request is delivered to this window's panes, and
// the daemon passes it to the other window (panes/relay.ts), so it works when the two panes are on different screens.
import { useEffect, useRef } from 'react';
import type { Intent } from '@elfoqsy/contracts';

export type { Intent };

type Listener = (intent: Intent) => void;
const listeners = new Set<Listener>();
/** Where the socket hooks in to send an intent to the other window. */
let relay: ((intent: Intent) => void) | undefined;

export const bus = {
  /** Ask for something: this window's panes hear it at once, and the other window's after the daemon relays it. */
  emit(intent: Intent): void {
    for (const l of [...listeners]) l(intent);
    relay?.(intent);
  },
  /** An intent that came from the other window: heard here, never sent back. */
  receive(intent: Intent): void {
    for (const l of [...listeners]) l(intent);
  },
  setRelay(fn: ((intent: Intent) => void) | undefined): void {
    relay = fn;
  },
  /** Hear every intent this window's panes are asked (a pane does it with useIntent); returns how to stop. */
  listen(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** A pane listens for the intents it owns. The handler may change on every render. */
export function useIntent(handler: Listener): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => bus.listen((i) => latest.current(i)), []);
}
