// alex's edits of his tickets, from the left screen: straight to Jira with his credentials, logged as his
// (jira.edited, by you), then the ticket read back. No tier, no approval: he is the one asking.
// - A field or comment is saved only over the value his editor started from. If Jira's differs, nothing is written and
//   theirs comes back (jira.edit_conflict) with who changed it: never overwritten silently.
// - Only fields Jira lets him set on this ticket (its edit metadata), and never one holding text the workspace masks.
// - Comments: he edits and deletes his own only.
// Also the reads behind his pickers: the transitions of a ticket, a ticket search, and a project's people, sprints,
// link types and labels.
import type { AnyEnvelope, JiraChange, JiraTransition, PayloadOf } from '@elfoqsy/contracts';
import { categoryOf, currentSprint, isEmptyValue, type JiraFieldIds } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';
import type { IssueBundle, IssueStore } from '../jira/issues';
import type { JiraWriter } from '../jira/writer';
import { redact, redactDeep } from '../redact';
import { canonical } from './tracker';
import type { TicketDetails } from './details';

export const OPTIONS_MAX_AGE_MS = 60 * 60_000;
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export interface TicketEditsDeps {
  log: EventLog;
  store: IssueStore;
  writer: JiraWriter;
  details: TicketDetails;
  ids: () => JiraFieldIds;
  now?: () => number;
}

/** Jira's empty values all compare as one. */
const same = (a: unknown, b: unknown): boolean => canonical(isEmptyValue(a) ? null : a) === canonical(isEmptyValue(b) ? null : b);

export class TicketEdits {
  private readonly optionsAt = new Map<string, number>();
  /** The sprint's tickets and their sprint, for "Sprint 52" or "not in sprint" in search results. */
  private readonly sprint = new Map<string, string>();
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly d: TicketEditsDeps) {
    this.now = d.now ?? Date.now;
    for (const e of d.log.readFrom(0, 10_000_000, ['jira.options', 'ticket.synced', 'ticket.removed'])) this.track(e);
    this.unsubscribe = d.log.subscribe((e) => this.track(e));
  }

  close(): void {
    this.unsubscribe();
  }

  private track(e: AnyEnvelope): void {
    if (e.type === 'jira.options') this.optionsAt.set(e.payload.project, Date.parse(e.payload.fetchedAt));
    else if (e.type === 'ticket.synced') this.sprint.set(e.payload.ticket.key, e.payload.ticket.sprint);
    else if (e.type === 'ticket.removed') this.sprint.delete(e.payload.key);
  }

  /** The options of a ticket's project, with the sprints of the board its sprint is on. */
  async optionsFor(key: string): Promise<void> {
    const project = key.split('-')[0]!;
    if (this.now() - (this.optionsAt.get(project) ?? 0) < OPTIONS_MAX_AGE_MS) return;
    const view = this.d.details.view(key) ?? (await this.d.details.refresh(key));
    const sprints = view?.fields[this.d.ids().sprint];
    const boardId = Array.isArray(sprints) ? (sprints as Array<{ boardId?: number }>).find((s) => typeof s.boardId === 'number')?.boardId : undefined;
    await this.options(project, boardId);
  }

  /** The options of a project, for his create form: through one of its sprint tickets, so its board's sprints come too. */
  async optionsForProject(project: string): Promise<void> {
    const key = [...this.sprint.keys()].find((k) => k.startsWith(`${project}-`));
    await (key ? this.optionsFor(key) : this.options(project));
  }

  private edited(p: Omit<PayloadOf<'jira.edited'>, 'by'>): void {
    this.d.log.append('orchestrator', 'jira.edited', { by: 'you', ...p, ...(p.error ? { error: redact(p.error).slice(0, 300) } : {}) });
  }

  /** His edit, from the frame he sent. */
  async edit(editId: string, key: string, change: JiraChange): Promise<void> {
    const base = { editId, key, what: change.op, ...('fieldId' in change ? { fieldId: change.fieldId } : {}) };
    try {
      const refused = await this.apply(editId, key, change);
      if (refused === 'conflict') return;
      if (refused) {
        this.edited({ ...base, ok: false, error: refused });
        return;
      }
      this.edited({ ...base, ok: true });
    } catch (error) {
      this.edited({ ...base, ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Read back from Jira, so the screens show what Jira holds now.
    await this.d.details.refresh(key);
  }

  /** Does it, or says why not ('conflict' when theirs came back). */
  private async apply(editId: string, key: string, c: JiraChange): Promise<string | 'conflict' | null> {
    const w = this.d.writer;
    switch (c.op) {
      case 'field': {
        const b = await this.d.store.get(key);
        const meta = b.issue.editmeta?.fields?.[c.fieldId];
        if (!meta || !(meta.operations ?? []).includes('set')) return 'Jira does not let this field be set on this ticket.';
        const current = b.issue.fields[c.fieldId];
        if (canonical(redactDeep(current)) !== canonical(current)) return 'This field holds text the workspace masks; edit it in Jira.';
        if (!same(current, c.base)) return this.conflict(editId, key, c.fieldId, current, b);
        await w.setFields(key, { [c.fieldId]: c.value });
        return null;
      }
      case 'transition':
        await w.transition(key, c.transitionId, c.fields);
        return null;
      case 'comment_add':
        await w.addComment(key, c.body);
        return null;
      case 'comment_edit':
      case 'comment_delete': {
        const b = await this.d.store.get(key);
        const comment = commentsOf(b).find((x) => String(x.id) === c.commentId);
        if (!comment) return 'That comment is not on the ticket any more.';
        const me = (await this.d.store.reader.myself()).accountId;
        if (comment.author?.accountId !== me) return 'Only your own comments can be changed here.';
        if (c.op === 'comment_delete') {
          await w.deleteComment(key, c.commentId);
          return null;
        }
        if (canonical(redactDeep(comment.body)) !== canonical(comment.body)) return 'This comment holds text the workspace masks; edit it in Jira.';
        if (!same(comment.body, c.base)) return this.conflict(editId, key, `comment:${c.commentId}`, comment.body, b, comment.updated);
        await w.editComment(key, c.commentId, c.body);
        return null;
      }
      case 'link_add':
        // Jira reads a link as "inward <outward wording> outward": SHOP-3543 blocks SHOP-3538 is
        // { inwardIssue: SHOP-3543, outwardIssue: SHOP-3538 }, and SHOP-3538 shows it as "is blocked by".
        if (c.direction === 'inward') await w.addLink(c.linkType, c.other, key);
        else await w.addLink(c.linkType, key, c.other);
        return null;
      case 'link_remove':
        await w.deleteLink(c.linkId);
        return null;
    }
  }

  /** Theirs, and who changed it last, from the changelog. */
  private conflict(editId: string, key: string, fieldId: string, theirs: unknown, b: IssueBundle, at?: string): 'conflict' {
    const histories = [...(b.issue.changelog?.histories ?? [])].sort((x, y) => x.created.localeCompare(y.created));
    const last = [...histories].reverse().find((h) => (h.items ?? []).some((i) => i.fieldId === fieldId || i.field === fieldId || (b.issue.names?.[fieldId] && i.field === b.issue.names[fieldId])));
    this.d.log.append('orchestrator', 'jira.edit_conflict', {
      editId,
      key,
      fieldId,
      theirs: theirs ?? null,
      ...(last?.author?.displayName ? { by: last.author.displayName } : {}),
      ...(last?.created ? { at: last.created } : at ? { at } : {}),
    });
    return 'conflict';
  }

  /** The transitions Jira offers on the ticket now, for its status menu. */
  async transitions(key: string): Promise<void> {
    const raw = await this.d.writer.transitions(key);
    const transitions: JiraTransition[] = raw.map((t) => ({
      id: String(t.id),
      name: t.name,
      to: { name: t.to?.name ?? t.name, category: categoryOf({ statusCategory: t.to?.statusCategory }) },
      fields: Object.entries(t.fields ?? {}).map(([id, f]) => ({
        id,
        name: f.name ?? id,
        required: !!f.required,
        ...(f.schema ? { schema: { type: String(f.schema.type ?? 'any'), ...(f.schema.items ? { items: String(f.schema.items) } : {}), ...(f.schema.custom ? { custom: String(f.schema.custom) } : {}), ...(f.schema.system ? { system: String(f.schema.system) } : {}) } } : {}),
        ...(f.allowedValues ? { allowedValues: f.allowedValues.slice(0, 200).map((v) => pickValue(v)) } : {}),
      })),
    }));
    this.d.log.append('jira', 'ticket.transitions', { key, transitions });
  }

  /** Tickets by key, or by summary words, in the sprint or not. */
  async search(query: string): Promise<void> {
    const q = query.trim();
    const sprint = this.sprint;
    const results: PayloadOf<'ticket.search'>['results'] = [];
    const seen = new Set<string>();
    const add = (key: string, f: Record<string, unknown>) => {
      if (seen.has(key)) return;
      seen.add(key);
      const status = (f.status ?? {}) as { name?: string };
      const sprintName = sprint.get(key) ?? currentSprint(f[this.d.ids().sprint])?.name;
      results.push({ key, summary: String(f.summary ?? ''), type: String((f.issuetype as { name?: string } | undefined)?.name ?? ''), status: { name: status.name ?? '', category: categoryOf(status) }, inSprint: sprint.has(key), ...(sprintName && sprint.has(key) ? { sprint: sprintName } : {}) });
    };
    const key = q.toUpperCase();
    if (KEY.test(key)) {
      const exact = await this.d.store.get(key, 60_000).catch(() => undefined);
      if (exact) add(key, exact.issue.fields);
    }
    // Summary words, as Jira's text search reads them; anything else is dropped so the JQL stays plain.
    const words = q.replace(/[^\p{L}\p{N}\s._-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (words.length >= 2 && !KEY.test(key)) {
      for (const i of await this.d.writer.search(`summary ~ "${words}" ORDER BY updated DESC`, 20)) add(i.key, i.fields);
    }
    this.d.log.append('jira', 'ticket.search', { query: q, results });
  }

  /** His pickers' options for a project, read again after an hour. boardId: the board of the project's sprint. */
  async options(project: string, boardId?: number): Promise<void> {
    if (this.now() - (this.optionsAt.get(project) ?? 0) < OPTIONS_MAX_AGE_MS) return;
    this.optionsAt.set(project, this.now());
    const w = this.d.writer;
    const [me, users, sprints, linkTypes, labels] = await Promise.all([
      this.d.store.reader.myself(),
      w.users(project).catch(() => []),
      boardId ? w.sprints(boardId).catch(() => []) : Promise.resolve([]),
      w.linkTypes().catch(() => []),
      w.labels().catch(() => []),
    ]);
    this.d.log.append('jira', 'jira.options', {
      project,
      me: { accountId: me.accountId, displayName: me.displayName },
      users: users.filter((u) => u.accountId && u.displayName).map((u) => ({ accountId: u.accountId!, displayName: u.displayName! })),
      sprints,
      linkTypes,
      labels,
      fetchedAt: new Date(this.now()).toISOString(),
    });
  }
}

const pickValue = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    ...(o.id !== undefined ? { id: String(o.id) } : {}),
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.value === 'string' ? { value: o.value } : {}),
  };
};

const commentsOf = (b: IssueBundle) => ((b.issue.fields.comment as { comments?: Array<{ id: string; author?: { accountId?: string }; body?: unknown; updated?: string }> } | undefined)?.comments ?? []);
