// Tickets in full on the screens. The left screen says which ticket is open (watch_ticket, renewed while it
// stays open); it is read at once, also outside the sprint, then about every 10 seconds while watched. A sprint ticket
// that Jira says changed is read again too, so who changed what reaches the screens. Errors back off (twice as long
// each time, up to 5 minutes, or what a 429 asks); a ticket Jira will not give is marked unreadable once.
// The log gets a snapshot the first time and then only what changed.
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { applyDetail, fieldIdsOf, jiraTime, type JiraFieldIds, type TicketDetailView } from '@elfoqsy/state';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import { JiraError } from '../jira/client';
import { confluencePageIds, diffDetail, toDetail } from '../jira/detail';
import type { IssueStore } from '../jira/issues';
import { redact } from '../redact';

export const POLL_OPEN_MS = 10_000;
export const WATCH_TTL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface TicketDetailsDeps {
  log: EventLog;
  store: IssueStore;
  site: string;
  clock?: Clock;
  now?: () => number;
  pollMs?: number;
}

export class TicketDetails {
  private readonly details = new Map<string, TicketDetailView>();
  private readonly watched = new Map<string, number>();
  private readonly backoff = new Map<string, { until: number; delay: number }>();
  private readonly unreadable = new Map<string, string>();
  private readonly titles = new Map<string, string>();
  /** Confluence pages already looked up, found or not: each is asked once. */
  private readonly tried = new Set<string>();
  private readonly reading = new Map<string, Promise<TicketDetailView | undefined>>();
  /** Jira's updated of each sprint ticket, as the sprint poll last said it. */
  private readonly sprintUpdated = new Map<string, string>();
  private ids: JiraFieldIds = fieldIdsOf();
  private me: string | undefined;
  private timer: unknown;
  private readonly unsubscribe: () => void;
  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(private readonly d: TicketDetailsDeps) {
    this.clock = d.clock ?? realClock;
    this.now = d.now ?? Date.now;
    for (let after = 0; ; ) {
      const batch = d.log.readFrom(after, 5000, ['ticket.detail', 'ticket.unreadable', 'jira.fields', 'ticket.synced']);
      if (!batch.length) break;
      batch.forEach((e) => this.track(e));
      after = batch[batch.length - 1]!.seq;
    }
    this.unsubscribe = d.log.subscribe((e) => this.onEvent(e));
  }

  start(): void {
    const tick = () => {
      void this.poll();
      this.timer = this.clock.setTimeout(tick, this.d.pollMs ?? POLL_OPEN_MS);
    };
    this.timer = this.clock.setTimeout(tick, this.d.pollMs ?? POLL_OPEN_MS);
  }

  close(): void {
    this.unsubscribe();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
  }

  private track(e: AnyEnvelope): void {
    if (e.type === 'ticket.detail') {
      this.details.set(e.payload.key, applyDetail(this.details.get(e.payload.key), e.payload, Date.parse(e.ts)));
      for (const [id, title] of Object.entries(e.payload.confluence ?? {})) this.titles.set(id, title);
      this.unreadable.delete(e.payload.key);
    } else if (e.type === 'ticket.unreadable') this.unreadable.set(e.payload.key, e.payload.reason);
    else if (e.type === 'jira.fields') this.ids = fieldIdsOf(e.payload.fields);
    else if (e.type === 'ticket.synced' && e.payload.ticket.updatedAt) this.sprintUpdated.set(e.payload.ticket.key, e.payload.ticket.updatedAt);
  }

  private onEvent(e: AnyEnvelope): void {
    // A sprint ticket Jira says changed: read it again, so the sprint learns what changed and who changed it.
    const before = e.type === 'ticket.synced' ? this.sprintUpdated.get(e.payload.ticket.key) : undefined;
    this.track(e);
    if (e.type === 'ticket.synced' && e.payload.ticket.updatedAt && before && before !== e.payload.ticket.updatedAt) {
      const known = this.details.get(e.payload.ticket.key);
      if (!known || known.updated !== e.payload.ticket.updatedAt) void this.refresh(e.payload.ticket.key, before);
    }
  }

  /** The ticket as the log has it, if it has it. */
  view(key: string): TicketDetailView | undefined {
    return this.details.get(key);
  }

  /** An attachment of a ticket the log has. */
  attachmentMeta(id: string): { filename?: string; mimeType?: string } | undefined {
    for (const d of this.details.values()) {
      const files = Array.isArray(d.fields.attachment) ? (d.fields.attachment as Array<{ id?: unknown; filename?: string; mimeType?: string }>) : [];
      const file = files.find((f) => String(f.id) === id);
      if (file) return { ...(file.filename ? { filename: file.filename } : {}), ...(file.mimeType ? { mimeType: file.mimeType } : {}) };
    }
    return undefined;
  }

  /** The left screen has this ticket open: read it now unless it was read in the last poll interval. */
  watch(key: string): void {
    const first = !this.watched.has(key) || this.now() - this.watched.get(key)! > WATCH_TTL_MS;
    this.watched.set(key, this.now());
    const fresh = this.details.get(key);
    if (first || !fresh || this.now() - fresh.fetchedAt > (this.d.pollMs ?? POLL_OPEN_MS)) void this.refresh(key);
  }

  /** Every watched ticket again, those backing off excepted. */
  async poll(): Promise<void> {
    const now = this.now();
    for (const [key, at] of [...this.watched]) {
      if (now - at > WATCH_TTL_MS) {
        this.watched.delete(key);
        continue;
      }
      if ((this.backoff.get(key)?.until ?? 0) > now) continue;
      await this.refresh(key);
    }
  }

  /** Reads the ticket and writes what changed. Returns the stored view, or undefined when it could not be read. Two reads
   * of the same ticket at once share one. */
  refresh(key: string, changedSince?: string): Promise<TicketDetailView | undefined> {
    const pending = this.reading.get(key);
    if (pending) return pending;
    const read = this.read(key, changedSince).finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  private async read(key: string, changedSince?: string): Promise<TicketDetailView | undefined> {
    try {
      this.me ??= (await this.d.store.reader.myself()).accountId;
      const bundle = await this.d.store.get(key);
      const next = toDetail(bundle, this.ids);
      const missing = confluencePageIds(next, this.d.site).filter((id) => !this.titles.has(id) && !this.tried.has(id));
      const titles: Record<string, string> = {};
      for (const id of missing.slice(0, 10)) {
        this.tried.add(id);
        const title = await this.d.store.reader.confluenceTitle(id).catch(() => null);
        if (title) titles[id] = title;
      }
      const prev = this.details.get(key);
      const patch = diffDetail(prev, next, this.me);
      // A sprint ticket read for the first time because it changed: what others changed since the sprint last saw it.
      if (patch && !prev && changedSince) {
        const since = jiraTime(changedSince);
        const theirs = (next.history ?? [])
          .filter((h) => jiraTime(h.created) > since && h.author?.accountId !== this.me)
          .flatMap((h) => h.items.map((it) => ({ fieldId: it.fieldId ?? it.field, name: (it.fieldId && next.names?.[it.fieldId]) || it.field, by: h.author?.displayName ?? 'someone', at: h.created })));
        if (theirs.length) patch.changes = theirs;
      }
      if (patch || Object.keys(titles).length) this.d.log.append('jira', 'ticket.detail', { ...(patch ?? { key: next.key, id: next.id, updated: next.updated, fetchedAt: next.fetchedAt }), ...(Object.keys(titles).length ? { confluence: titles } : {}) });
      this.backoff.delete(key);
      return this.details.get(key);
    } catch (error) {
      this.failed(key, error);
      return undefined;
    }
  }

  private failed(key: string, error: unknown): void {
    const status = error instanceof JiraError ? error.status : undefined;
    const prev = this.backoff.get(key)?.delay ?? 0;
    const delay = error instanceof JiraError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : Math.min(MAX_BACKOFF_MS, Math.max(20_000, prev * 2));
    this.backoff.set(key, { until: this.now() + delay, delay });
    const reason =
      status === 404 || status === 403 || status === 401
        ? `Jira says ${key} does not exist, or you cannot see it.`
        : status === 429
          ? 'Jira asked to slow down; reading it again shortly.'
          : `Jira could not be reached (${redact(error instanceof Error ? error.message : String(error)).slice(0, 120)}); reading it again shortly.`;
    // Said once per reason; a ticket already shown keeps showing while Jira is away.
    if (this.unreadable.get(key) === reason || (this.details.has(key) && status !== 404 && status !== 403)) return;
    this.d.log.append('jira', 'ticket.unreadable', { key, reason });
  }
}
