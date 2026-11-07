// Per-ticket grants: "Allow for this ticket" on a tier-2 approval lets the same kind of action, on the same ticket and in
// the same environment, run without asking until it expires (8 hours) or the run that asked ends. Grants live only as
// long as their run, which never outlives the daemon, so they are not restored at start.
import type { Actor } from '@elfoqsy/contracts';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import { ulid } from '../ulid';

export const GRANT_HOURS = 8;

export interface Grant {
  grantId: string;
  ticket: string;
  runId: string;
  kind: string;
  environment?: string;
  expiresAt: number;
}

export class Grants {
  private readonly live = new Map<string, Grant & { timer: unknown }>();
  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(
    private readonly log: EventLog,
    options: { clock?: Clock; now?: () => number } = {},
  ) {
    this.clock = options.clock ?? realClock;
    this.now = options.now ?? Date.now;
  }

  /** A live grant for this kind of action on this ticket in this environment, if there is one. */
  find(ticket: string, kind: string, environment: string | undefined): Grant | undefined {
    for (const g of this.live.values()) {
      if (g.ticket !== ticket || g.kind !== kind || g.environment !== environment) continue;
      if (g.expiresAt <= this.now()) {
        this.end(g.grantId, 'expired');
        continue;
      }
      return g;
    }
    return undefined;
  }

  create(o: { ticket: string; runId: string; kind: string; environment?: string; by: Actor; approvalId: string }): Grant {
    const grant: Grant = {
      grantId: ulid(),
      ticket: o.ticket,
      runId: o.runId,
      kind: o.kind,
      ...(o.environment ? { environment: o.environment } : {}),
      expiresAt: this.now() + GRANT_HOURS * 3_600_000,
    };
    const timer = this.clock.setTimeout(() => this.end(grant.grantId, 'expired'), GRANT_HOURS * 3_600_000);
    this.live.set(grant.grantId, { ...grant, timer });
    this.log.append('orchestrator', 'grant.created', {
      grantId: grant.grantId,
      ticket: grant.ticket,
      runId: grant.runId,
      kind: grant.kind,
      ...(grant.environment ? { environment: grant.environment } : {}),
      expiresAt: new Date(grant.expiresAt).toISOString(),
      by: o.by,
      approvalId: o.approvalId,
    });
    return grant;
  }

  /** The run ended: its grants end with it. */
  endRun(runId: string): void {
    for (const g of [...this.live.values()]) if (g.runId === runId) this.end(g.grantId, 'run_ended');
  }

  private end(grantId: string, reason: 'expired' | 'run_ended'): void {
    const g = this.live.get(grantId);
    if (!g) return;
    this.clock.clearTimeout(g.timer);
    this.live.delete(grantId);
    this.log.append('orchestrator', 'grant.ended', { grantId, reason });
  }

  close(): void {
    for (const g of this.live.values()) this.clock.clearTimeout(g.timer);
    this.live.clear();
  }
}
