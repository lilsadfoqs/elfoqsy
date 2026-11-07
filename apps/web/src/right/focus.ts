// A view action between the map and the terminals: clicking an agent on the map focuses its pane, opening it if
// needed. It changes nothing in the workspace, so it is not an event: the two columns of the right screen share it here,
// and (P2) the other window hears it too, for a map and terminals on different screens. With the terminals hidden nobody
// listens: the request is kept for a moment, the column is asked to open, and the panes take it once they are back.
import { bus } from '../panes/bus';

type Listener = (runId: string) => void;
const listeners = new Set<Listener>();
const openers = new Set<() => void>();
let kept: { runId: string; at: number } | null = null;
/** A request nobody took is kept only while it can still be what was just clicked. */
const KEEP_MS = 3000;

function deliver(runId: string): void {
  if (!listeners.size) {
    kept = { runId, at: Date.now() };
    for (const o of openers) o();
    return;
  }
  for (const l of listeners) l(runId);
}

export const focusRun = {
  /** An agent was clicked here: its pane takes focus, in this window or the other. */
  request(runId: string): void {
    deliver(runId);
    bus.emit({ t: 'focus_run', runId });
  },
  /** Heard from the other window. */
  fromElsewhere(runId: string): void {
    deliver(runId);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    if (kept) {
      const { runId, at } = kept;
      kept = null;
      if (Date.now() - at < KEEP_MS) l(runId);
    }
    return () => listeners.delete(l);
  },
  /** Called when a request finds the terminals hidden: the right screen opens them. */
  onHidden(o: () => void): () => void {
    openers.add(o);
    return () => openers.delete(o);
  },
};
