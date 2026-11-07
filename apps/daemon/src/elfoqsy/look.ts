// Elfoqsy's look. When her state changes (broken, needs you, done, thinking, working, quiet) one of its
// three portraits is picked at random, never the one she had the last time she was in that state, and
// recorded as an event: both screens then show the same picture, and a reload does not change it.
// "Done" ends with time alone, so the state is also checked every 10 seconds.
import { mood, pickVariant } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';
import { LiveState } from './liveState';

const CHECK_MS = 10_000;

export class LookWatcher {
  private readonly live: LiveState;
  private readonly timer: ReturnType<typeof setInterval>;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private readonly stopListening: () => void;

  constructor(
    private readonly log: EventLog,
    private readonly options: { now?: () => number; random?: () => number } = {},
  ) {
    this.live = new LiveState(log);
    // After the event that changed things has reached every subscriber, never in the middle of it.
    this.stopListening = this.live.onEvent((_previous, event) => {
      if (event.type !== 'elfoqsy.look') this.schedule();
    });
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.schedule();
  }

  private schedule(): void {
    this.pending ??= setTimeout(() => {
      this.pending = null;
      this.check();
    }, 0);
  }

  check(): void {
    const s = this.live.get();
    const now = this.options.now?.() ?? Date.now();
    const current = mood(s, now);
    if (s.look?.mood === current) return;
    this.log.append('orchestrator', 'elfoqsy.look', { mood: current, variant: pickVariant(s.lastVariant[current], undefined, this.options.random) });
  }

  close(): void {
    clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.stopListening();
    this.live.close();
  }
}
