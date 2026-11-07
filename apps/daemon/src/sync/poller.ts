// Runs one sync on a fixed interval, never two at once. Three failures in a row mark the source
// unreachable (sync.status, since the first of them); the next success marks it ok again.
import type { PayloadOf } from '@elfoqsy/contracts';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import { redact } from '../redact';
import type { SyncTracker } from './tracker';

export const FAILURES_BEFORE_UNREACHABLE = 3;

export interface PollerOptions {
  source: PayloadOf<'sync.status'>['source'];
  intervalMs: number;
  sync: () => Promise<void>;
  log: EventLog;
  tracker: SyncTracker;
  clock?: Clock;
  now?: () => number;
}

export class Poller {
  private streak = 0;
  private firstFailureAt: number | null = null;
  private handle: unknown;
  private stopped = false;
  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(private readonly o: PollerOptions) {
    this.clock = o.clock ?? realClock;
    this.now = o.now ?? Date.now;
  }

  /** Polls now, then every interval after the previous poll ends. */
  start(): Promise<void> {
    return this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
  }

  private async tick(): Promise<void> {
    let delay = this.o.intervalMs;
    try {
      await this.o.sync();
      this.succeeded();
    } catch (error) {
      delay = Math.max(delay, this.failed(error));
    }
    if (!this.stopped) this.handle = this.clock.setTimeout(() => void this.tick(), delay);
  }

  private succeeded(): void {
    if (this.o.tracker.sourceState(this.o.source) === 'unreachable') {
      this.o.log.append('orchestrator', 'sync.status', { source: this.o.source, state: 'ok', since: new Date(this.now()).toISOString() });
      console.log(`${this.o.source}: reachable again`);
    }
    this.streak = 0;
    this.firstFailureAt = null;
  }

  /** Records a failure; returns how long the source asked us to wait (Retry-After), in ms. */
  private failed(error: unknown): number {
    this.streak++;
    this.firstFailureAt ??= this.now();
    const reason = redact(error instanceof Error ? error.message : String(error)).slice(0, 160);
    console.warn(`${this.o.source} poll failed (${this.streak} in a row): ${reason}`);
    if (this.streak >= FAILURES_BEFORE_UNREACHABLE && this.o.tracker.sourceState(this.o.source) !== 'unreachable') {
      this.o.log.append('orchestrator', 'sync.status', {
        source: this.o.source,
        state: 'unreachable',
        since: new Date(this.firstFailureAt).toISOString(),
        reason,
      });
    }
    const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
    return typeof retryAfter === 'number' ? retryAfter * 1000 : 0;
  }
}
