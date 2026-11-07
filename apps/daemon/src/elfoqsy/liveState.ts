// The workspace state folded from the log, kept current as events are appended: the same fold the
// screens use, so Elfoqsy reads exactly what Alex sees.
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { fold, initialState, type WorkspaceState } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';

type Listener = (previous: WorkspaceState, event: AnyEnvelope, next: WorkspaceState) => void;

export class LiveState {
  private state: WorkspaceState = initialState;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribe: () => void;

  constructor(log: EventLog) {
    for (let after = 0; ; ) {
      const batch = log.readFrom(after, 5000);
      if (!batch.length) break;
      this.state = batch.reduce(fold, this.state);
      after = batch[batch.length - 1]!.seq;
    }
    this.unsubscribe = log.subscribe((event) => {
      const previous = this.state;
      this.state = fold(previous, event);
      for (const listener of this.listeners) listener(previous, event, this.state);
    });
  }

  get(): WorkspaceState {
    return this.state;
  }

  /** Called for every event appended from now on, after the state includes it. Not for history. */
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
