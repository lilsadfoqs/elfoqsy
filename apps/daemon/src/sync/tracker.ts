// Remembers what the log last said about each ticket, PR, CI run and source, so pollers emit only
// changes. It is rebuilt from the log at start, so a daemon restart does not re-emit everything.
import type { AnyEnvelope, PayloadOf, PullRequest, Ticket } from '@elfoqsy/contracts';
import { parsePayload } from '@elfoqsy/contracts';
import type { EventLog } from '../eventLog';
import { redactDeep } from '../redact';

type Source = PayloadOf<'sync.status'>['source'];

/** JSON with sorted keys, so equal values always compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const prKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

export class SyncTracker {
  private readonly tickets = new Map<string, string>();
  private readonly prs = new Map<string, PullRequest>();
  private readonly ci = new Map<string, string>();
  private readonly sources = new Map<Source, PayloadOf<'sync.status'>['state']>();
  private readonly unsubscribe: () => void;

  constructor(private readonly log: EventLog) {
    for (let after = 0; ; ) {
      const batch = log.readFrom(after, 5000);
      if (!batch.length) break;
      batch.forEach((e) => this.track(e));
      after = batch[batch.length - 1]!.seq;
    }
    this.unsubscribe = log.subscribe((e) => this.track(e));
  }

  close(): void {
    this.unsubscribe();
  }

  /** Emits ticket.synced for new or changed tickets and ticket.removed for tickets no longer in the set. */
  applyTickets(tickets: Ticket[]): { changed: number; removed: number } {
    let changed = 0;
    const seen = new Set<string>();
    for (const ticket of tickets) {
      seen.add(ticket.key);
      // Compare what would be stored (validated, redacted) with what is stored.
      const stored = canonical(redactDeep(parsePayload('ticket.synced', { ticket }).ticket));
      if (this.tickets.get(ticket.key) === stored) continue;
      this.log.append('jira', 'ticket.synced', { ticket });
      changed++;
    }
    const gone = [...this.tickets.keys()].filter((key) => !seen.has(key));
    for (const key of gone) this.log.append('jira', 'ticket.removed', { key });
    return { changed, removed: gone.length };
  }

  /** PRs the log still shows as open or draft on these repositories. */
  openPrs(repos: string[]): PullRequest[] {
    const wanted = new Set(repos.map((r) => r.toLowerCase()));
    return [...this.prs.values()].filter((p) => (p.state === 'open' || p.state === 'draft') && wanted.has(p.repo.toLowerCase()));
  }

  applyPrs(prs: PullRequest[]): number {
    let changed = 0;
    for (const pr of prs) {
      const known = this.prs.get(prKey(pr.repo, pr.number));
      if (known && canonical(known) === canonical(redactDeep(parsePayload('pr.synced', { pr }).pr))) continue;
      this.log.append('github', 'pr.synced', { pr });
      changed++;
    }
    return changed;
  }

  applyCi(statuses: Array<PayloadOf<'ci.status'>>): number {
    let changed = 0;
    for (const s of statuses) {
      if (this.ci.get(prKey(s.repo, s.pr)) === `${s.status}@${s.sha}`) continue;
      this.log.append('github', 'ci.status', s);
      changed++;
    }
    return changed;
  }

  sourceState(source: Source): PayloadOf<'sync.status'>['state'] {
    return this.sources.get(source) ?? 'ok';
  }

  private track(event: AnyEnvelope): void {
    switch (event.type) {
      case 'ticket.synced':
        this.tickets.set(event.payload.ticket.key, canonical(event.payload.ticket));
        break;
      case 'ticket.removed':
        this.tickets.delete(event.payload.key);
        break;
      case 'pr.synced':
        this.prs.set(prKey(event.payload.pr.repo, event.payload.pr.number), event.payload.pr);
        break;
      case 'ci.status':
        this.ci.set(prKey(event.payload.repo, event.payload.pr), `${event.payload.status}@${event.payload.sha}`);
        break;
      case 'sync.status':
        this.sources.set(event.payload.source, event.payload.state);
        break;
    }
  }
}
