// A Jira for tests and simulate mode: the captured fixtures (test/fixtures/jira, redacted), served as Jira would,
// with every request recorded. Tests change a ticket "as someone else" with `change`, and read what the workspace asked
// for in `requests`. Nothing here reaches the real Jira.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@elfoqsy/contracts';
import { JiraError, type DevPullRequest } from './client';
import type { JiraReader, RawIssue, RawRemoteLink, RawUser } from './issues';
import type { JiraWriter, RawTransition } from './writer';

export interface FakeRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

interface Fixture {
  issue: RawIssue;
  remoteLinks: RawRemoteLink[];
  transitions?: { transitions?: unknown[] };
}

/** A 1×1 PNG, for attachments. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export interface CreateScreenField {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
  schema?: Record<string, unknown>;
  allowedValues?: unknown[];
}
export interface CreateScreen {
  project: string;
  types: Array<{ id: string; name: string; subtask: boolean }>;
  fields: Record<string, CreateScreenField[]>;
}

export class FakeJira implements JiraReader, JiraWriter {
  readonly requests: FakeRequest[] = [];
  readonly issues = new Map<string, Fixture>();
  readonly pages = new Map<string, string>();
  /** Jira's create screens, captured per project (createmeta-SHOP.json). */
  readonly createScreens = new Map<string, CreateScreen>();
  siteFields: Array<{ id: string; name: string }> = [];
  me = { accountId: 'acc-me', displayName: 'Alex Rivera' };
  /** Make the next reads fail, as Jira does when it is down or slowing callers. */
  failing: JiraError | null = null;
  /** For a key it has no fixture of: simulate mode builds one from the sim's ticket. */
  fallback: ((key: string) => Fixture | undefined) | undefined;

  static fromFixtures(dir: string): FakeJira {
    const jira = new FakeJira();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
      if (file === 'fields.json') jira.siteFields = data as Array<{ id: string; name: string }>;
      else if (file.startsWith('createmeta-')) {
        const screen = data as CreateScreen;
        jira.createScreens.set(screen.project, screen);
      } else jira.add(data as Fixture);
    }
    return jira;
  }

  add(f: Fixture): void {
    this.issues.set(f.issue.key, structuredClone({ ...f, remoteLinks: f.remoteLinks ?? [] }));
  }

  private found(key: string): Fixture {
    if (this.failing) throw this.failing;
    let f = this.issues.get(key);
    if (!f && this.fallback) {
      const made = this.fallback(key);
      if (made) this.add(made);
      f = this.issues.get(key);
    }
    if (!f) throw new JiraError('HTTP 404: Issue does not exist or you do not have permission to see it.', 404);
    return f;
  }

  /**
   * Someone else changes a ticket, as Jira would record it: the fields set, a history entry by them, updated moved on.
   * at: when (ISO, Jira's offset form is fine).
   */
  change(key: string, by: { accountId: string; displayName: string }, set: Record<string, unknown>, items: Array<{ field: string; fieldId?: string; fromString?: string | null; toString?: string | null }>, at: string): void {
    const f = this.found(key);
    Object.assign(f.issue.fields, set, { updated: at });
    const histories = (f.issue.changelog ??= { histories: [] }).histories!;
    histories.push({ id: String(900000 + histories.length), author: by, created: at, items });
  }

  async issue(key: string): Promise<RawIssue> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/issue/${key}` });
    return structuredClone(this.found(key).issue);
  }

  async remoteLinks(key: string): Promise<RawRemoteLink[]> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/issue/${key}/remotelink` });
    return structuredClone(this.found(key).remoteLinks);
  }

  async confluenceTitle(pageId: string): Promise<string | null> {
    this.requests.push({ method: 'GET', path: `/wiki/rest/api/content/${pageId}` });
    return this.pages.get(pageId) ?? null;
  }

  async fields(): Promise<Array<{ id: string; name: string }>> {
    this.requests.push({ method: 'GET', path: '/rest/api/3/field' });
    return structuredClone(this.siteFields);
  }

  async assignees(keys: string[]): Promise<Record<string, { accountId?: string; displayName?: string } | null>> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/search/jql?jql=key in (${keys.join(', ')})` });
    const known: Record<string, { accountId?: string; displayName?: string } | null> = { 'SHOP-3543': { displayName: 'Morgan Diaz' }, 'SHOP-3537': { displayName: 'Jordan Park' } };
    return Object.fromEntries(keys.map((k) => [k, (this.issues.get(k)?.issue.fields.assignee as { displayName?: string } | null | undefined) ?? known[k] ?? null]));
  }

  /** Tickets updated in the last N minutes (the JQL's -Nm) that are his or mention him in a comment. */
  async news(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown>; changelog?: RawIssue['changelog'] }>> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/search/jql?jql=${jql}&expand=changelog` });
    if (this.failing) throw this.failing;
    const minutes = Number(/updated >= -(\d+)m/.exec(jql)?.[1] ?? 0);
    const since = Date.now() - minutes * 60_000;
    return [...this.issues.values()]
      .filter((f) => {
        const updated = Date.parse(String(f.issue.fields.updated ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
        const mine = (f.issue.fields.assignee as { accountId?: string } | null)?.accountId === this.me.accountId || (f.issue.fields.reporter as { accountId?: string } | null)?.accountId === this.me.accountId;
        const mentioned = JSON.stringify(f.issue.fields.comment ?? null).includes(`"id":"${this.me.accountId}"`);
        return updated >= since && (mine || mentioned);
      })
      .slice(0, max)
      .map((f) => ({ key: f.issue.key, fields: structuredClone(f.issue.fields), changelog: structuredClone(f.issue.changelog ?? { histories: [] }) }));
  }

  async myself(): Promise<{ accountId: string; displayName: string }> {
    return this.me;
  }

  async attachment(id: string): Promise<{ bytes: Buffer; mediaType: string }> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/attachment/content/${id}` });
    for (const f of this.issues.values()) {
      const file = ((f.issue.fields.attachment as Array<{ id?: unknown; mimeType?: string }> | undefined) ?? []).find((a) => String(a.id) === id);
      if (file) return { bytes: PIXEL, mediaType: file.mimeType ?? 'application/octet-stream' };
    }
    throw new JiraError('HTTP 404: no such attachment', 404);
  }

  /** Issue types a project offers, as Jira's create screen lists them. */
  async createTypes(project: string): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/issue/createmeta/${project}/issuetypes` });
    return this.createScreens.get(project)?.types ?? [];
  }

  /** A type's create screen, as captured from Jira. */
  async createFields(project: string, typeId: string): Promise<CreateScreenField[]> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/issue/createmeta/${project}/issuetypes/${typeId}` });
    return this.createScreens.get(project)?.fields[typeId] ?? [];
  }

  /** A new issue, as Jira would make it: the next key, the fields given, the sprint and parent resolved. */
  async create(fields: Record<string, unknown>): Promise<string> {
    this.requests.push({ method: 'POST', path: '/rest/api/3/issue', body: { fields } });
    const project = (fields.project as { key?: string; id?: string } | undefined)?.key ?? 'SHOP';
    const typeId = (fields.issuetype as { id?: string } | undefined)?.id ?? '';
    const screen = this.createScreens.get(project);
    const type = screen?.types.find((t) => t.id === typeId);
    if (screen && !type) throw new JiraError('HTTP 400: Specify a valid issue type.', 400);
    // Jira refuses a required field left empty, and names the first.
    const missing = (screen?.fields[typeId] ?? [{ fieldId: 'summary', name: 'Summary', required: true }]).find((f) => f.required && !f.hasDefaultValue && !['project', 'issuetype'].includes(f.fieldId) && (fields[f.fieldId] === undefined || fields[f.fieldId] === null || fields[f.fieldId] === ''));
    if (missing) throw new JiraError(`HTTP 400: ${missing.name} is required.`, 400);
    const key = `${project}-${9001 + [...this.issues.keys()].filter((k) => /-9\d{3}$/.test(k)).length}`;
    const sprintId = fields.customfield_10521;
    const known = [...this.issues.values()].flatMap((f) => (f.issue.fields.customfield_10521 as Array<{ id: number }> | undefined) ?? []).find((s) => s.id === sprintId);
    const issue: RawIssue = {
      id: String(Date.now() % 100000),
      key,
      fields: {
        ...fields,
        customfield_10521: known ? [known] : null,
        status: { name: 'OPEN', statusCategory: { key: 'new' } },
        issuetype: { id: typeId, name: type?.name ?? 'Bug', subtask: !!type?.subtask },
        created: new Date().toISOString().replace('Z', '+0000'),
        updated: new Date().toISOString().replace('Z', '+0000'),
        reporter: this.me,
        creator: this.me,
        issuelinks: [],
        comment: { comments: [] },
        ...(fields.parent ? { parent: { key: (fields.parent as { key: string }).key, fields: { summary: this.issues.get((fields.parent as { key: string }).key)?.issue.fields.summary ?? '' } } } : {}),
      },
      names: { summary: 'Summary', description: 'Description', labels: 'Labels', priority: 'Priority', customfield_10521: 'Sprint', customfield_16486: 'Story point estimate' },
      schema: { description: { type: 'string', system: 'description' } },
      editmeta: { fields: { summary: { required: true, operations: ['set'] }, description: { required: false, operations: ['set'] } } },
      changelog: { histories: [] },
    };
    this.add({ issue, remoteLinks: [] });
    return key;
  }

  /** The writes asked for. */
  writes(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  /** Each write as Jira records it: a history entry by him, updated moved on. */
  private wrote(key: string, items: Array<Record<string, unknown>>): void {
    const f = this.found(key);
    const at = new Date(Date.now()).toISOString().replace('Z', '+0000');
    f.issue.fields.updated = at;
    const histories = (f.issue.changelog ??= { histories: [] }).histories!;
    histories.push({ id: String(800000 + this.requests.length), author: this.me, created: at, items });
  }

  async setFields(key: string, fields: Record<string, unknown>): Promise<void> {
    this.requests.push({ method: 'PUT', path: `/rest/api/3/issue/${key}`, body: { fields } });
    const f = this.found(key);
    for (const [id, v] of Object.entries(fields)) f.issue.fields[id] = v;
    this.wrote(key, Object.keys(fields).map((id) => ({ field: f.issue.names?.[id] ?? id, fieldId: id })));
  }

  async transitions(key: string): Promise<RawTransition[]> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/issue/${key}/transitions` });
    return structuredClone((this.found(key).transitions?.transitions ?? []) as RawTransition[]);
  }

  async transition(key: string, id: string, fields?: Record<string, unknown>): Promise<void> {
    this.requests.push({ method: 'POST', path: `/rest/api/3/issue/${key}/transitions`, body: { transition: { id }, ...(fields ? { fields } : {}) } });
    const f = this.found(key);
    const t = ((f.transitions?.transitions ?? []) as RawTransition[]).find((x) => String(x.id) === id);
    if (!t) throw new JiraError(`HTTP 400: transition ${id} is not valid for ${key}`, 400);
    const required = Object.entries(t.fields ?? {}).filter(([, m]) => m.required).map(([fid]) => fid);
    const missing = required.filter((fid) => fields?.[fid] === undefined && f.issue.fields[fid] === undefined);
    if (missing.length) throw new JiraError(`HTTP 400: ${missing.join(', ')} is required`, 400);
    const from = (f.issue.fields.status as { name?: string } | undefined)?.name;
    f.issue.fields.status = { name: t.to?.name ?? t.name, statusCategory: t.to?.statusCategory ?? { key: 'indeterminate' } };
    Object.assign(f.issue.fields, fields ?? {});
    this.wrote(key, [{ field: 'status', fieldId: 'status', fromString: from ?? null, toString: t.to?.name ?? t.name }]);
  }

  async addComment(key: string, body: unknown): Promise<string> {
    this.requests.push({ method: 'POST', path: `/rest/api/3/issue/${key}/comment`, body: { body } });
    const f = this.found(key);
    const comments = ((f.issue.fields.comment ??= { comments: [] }) as { comments: Array<Record<string, unknown>> }).comments;
    const id = String(700000 + this.requests.length);
    const at = new Date().toISOString().replace('Z', '+0000');
    comments.push({ id, author: this.me, created: at, updated: at, body });
    this.wrote(key, []);
    return id;
  }

  private comment(key: string, id: string): Record<string, unknown> {
    const c = ((this.found(key).issue.fields.comment as { comments?: Array<Record<string, unknown>> } | undefined)?.comments ?? []).find((x) => String(x.id) === id);
    if (!c) throw new JiraError('HTTP 404: no such comment', 404);
    return c;
  }

  async editComment(key: string, id: string, body: unknown): Promise<void> {
    this.requests.push({ method: 'PUT', path: `/rest/api/3/issue/${key}/comment/${id}`, body: { body } });
    Object.assign(this.comment(key, id), { body, updated: new Date().toISOString().replace('Z', '+0000') });
    this.wrote(key, []);
  }

  async deleteComment(key: string, id: string): Promise<void> {
    this.requests.push({ method: 'DELETE', path: `/rest/api/3/issue/${key}/comment/${id}` });
    this.comment(key, id);
    const holder = this.found(key).issue.fields.comment as { comments: Array<Record<string, unknown>> };
    holder.comments = holder.comments.filter((c) => String(c.id) !== id);
    this.wrote(key, []);
  }

  async addLink(type: string, inward: string, outward: string): Promise<void> {
    this.requests.push({ method: 'POST', path: '/rest/api/3/issueLink', body: { type: { name: type }, inwardIssue: { key: inward }, outwardIssue: { key: outward } } });
    const known = (await this.linkTypes()).find((t) => t.name === type) ?? { id: '1', name: type, inward: type, outward: type };
    const id = String(600000 + this.requests.length);
    // Each side shows the other: the outward issue sees it under the inward wording, and the other way round.
    for (const [mine, other, side] of [[outward, inward, 'inwardIssue'], [inward, outward, 'outwardIssue']] as const) {
      const f = this.issues.get(mine);
      if (!f) continue;
      const links = ((f.issue.fields.issuelinks ??= []) as Array<Record<string, unknown>>);
      links.push({ id, type: known, [side]: { key: other, fields: { summary: this.issues.get(other)?.issue.fields.summary ?? other, status: this.issues.get(other)?.issue.fields.status ?? { name: 'OPEN' }, priority: this.issues.get(other)?.issue.fields.priority ?? { name: 'Major' } } } });
      this.wrote(mine, []);
    }
  }

  async deleteLink(id: string): Promise<void> {
    this.requests.push({ method: 'DELETE', path: `/rest/api/3/issueLink/${id}` });
    for (const f of this.issues.values()) {
      const links = f.issue.fields.issuelinks as Array<Record<string, unknown>> | undefined;
      if (links?.some((l) => String(l.id) === id)) {
        f.issue.fields.issuelinks = links.filter((l) => String(l.id) !== id);
        this.wrote(f.issue.key, []);
      }
    }
  }

  async users(project: string): Promise<RawUser[]> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/user/assignable/multiProjectSearch?projectKeys=${project}` });
    const found = new Map<string, RawUser>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.accountId === 'string' && typeof o.displayName === 'string') found.set(o.accountId, { accountId: o.accountId, displayName: o.displayName });
        Object.values(o).forEach(walk);
      }
    };
    for (const f of this.issues.values()) walk(f.issue.fields);
    return [...found.values()].sort((a, b) => a.displayName!.localeCompare(b.displayName!));
  }

  async sprints(boardId: number): Promise<Array<{ id: number; name: string; state: string; goal?: string }>> {
    this.requests.push({ method: 'GET', path: `/rest/agile/1.0/board/${boardId}/sprint` });
    const found = new Map<number, { id: number; name: string; state: string; goal?: string }>();
    for (const f of this.issues.values()) {
      for (const s of (f.issue.fields.customfield_10521 as Array<{ id: number; name: string; state: string; goal?: string; boardId?: number }> | undefined) ?? []) {
        if (s.boardId === boardId && s.state !== 'closed') found.set(s.id, { id: s.id, name: s.name, state: s.state, ...(s.goal ? { goal: s.goal } : {}) });
      }
    }
    return [...found.values()];
  }

  async linkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>> {
    const found = new Map<string, { id: string; name: string; inward: string; outward: string }>();
    for (const f of this.issues.values()) {
      for (const l of (f.issue.fields.issuelinks as Array<{ type?: { id: string; name: string; inward: string; outward: string } }> | undefined) ?? []) if (l.type) found.set(l.type.id, { id: l.type.id, name: l.type.name, inward: l.type.inward, outward: l.type.outward });
    }
    return [...found.values()];
  }

  async labels(): Promise<string[]> {
    return [...new Set([...this.issues.values()].flatMap((f) => (f.issue.fields.labels as string[] | undefined) ?? []))].sort();
  }

  /** The pull requests Jira's Development field links, by issue id: what the study's linker reads. */
  readonly devPrs = new Map<string, DevPullRequest[]>();

  async devPullRequests(issueId: string, instanceType: string): Promise<DevPullRequest[]> {
    this.requests.push({ method: 'GET', path: `/rest/dev-status/latest/issue/detail?issueId=${issueId}&applicationType=${instanceType}&dataType=pullrequest` });
    return structuredClone(this.devPrs.get(issueId) ?? []);
  }

  /** Confluence pages' current version numbers, for the study's upkeep of cited pages. */
  readonly pageVersions = new Map<string, number>();
  /** Issues per page of a scan, small in tests so paging is exercised. */
  scanPageSize = 100;

  /**
   * The study's Jira index reads this way: `project in (A, B)` or `project = A`, optionally `AND updated >= "…"`,
   * oldest updated first, page by page.
   */
  async scan(jql: string, _fields: string[], onPage: (issues: Array<{ id?: string; key: string; fields: Record<string, unknown> }>) => void | Promise<void>): Promise<number> {
    if (this.failing) throw this.failing;
    const projects = (/project\s+in\s*\(([^)]*)\)/i.exec(jql)?.[1] ?? /project\s*=\s*([A-Z][A-Z0-9_]*)/i.exec(jql)?.[1] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const after = /updated\s*>=\s*"([^"]+)"/i.exec(jql)?.[1];
    const since = after ? Date.parse(after.replace(' ', 'T')) : -Infinity;
    const all = [...this.issues.values()]
      .filter((f) => !projects.length || projects.includes(f.issue.key.split('-')[0]!))
      .filter((f) => Date.parse(String(f.issue.fields.updated ?? 0)) >= since)
      .sort((a, b) => Date.parse(String(a.issue.fields.updated)) - Date.parse(String(b.issue.fields.updated)) || a.issue.key.localeCompare(b.issue.key));
    for (let i = 0; i < all.length || i === 0; i += this.scanPageSize) {
      this.requests.push({ method: 'GET', path: `/rest/api/3/search/jql?jql=${jql}&page=${i / this.scanPageSize}` });
      await onPage(all.slice(i, i + this.scanPageSize).map((f) => ({ ...(f.issue.id ? { id: String(f.issue.id) } : {}), key: f.issue.key, fields: structuredClone(f.issue.fields) })));
      if (!all.length) break;
    }
    return all.length;
  }

  async confluenceVersion(pageId: string): Promise<number | undefined> {
    this.requests.push({ method: 'GET', path: `/wiki/rest/api/content/${pageId}?expand=version` });
    return this.pageVersions.get(pageId);
  }

  async search(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown> }>> {
    this.requests.push({ method: 'GET', path: `/rest/api/3/search/jql?jql=${jql}` });
    const words = /summary ~ "([^"]*)"/.exec(jql)?.[1]?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return [...this.issues.values()]
      .filter((f) => words.every((w) => String(f.issue.fields.summary ?? '').toLowerCase().includes(w)))
      .slice(0, max)
      .map((f) => ({ key: f.issue.key, fields: structuredClone(f.issue.fields) }));
  }
}

const CATEGORY: Record<Ticket['status'], { key: string; name: string }> = {
  'To do': { key: 'new', name: 'OPEN' },
  'In progress': { key: 'indeterminate', name: 'IN PROGRESS' },
  Blocked: { key: 'indeterminate', name: 'BLOCKED' },
  Done: { key: 'done', name: 'WORK-DONE' },
  Released: { key: 'done', name: 'RELEASED' },
  Cancelled: { key: 'done', name: 'CLOSE - CANCELLED' },
};

/** A simulated ticket as Jira would give it: its fields, its description as paragraphs, a story-points field. */
export function issueFromTicket(t: Ticket, storyPointsField = 'customfield_16486'): Fixture {
  const status = t.workflowStatus ? { name: t.workflowStatus.name, statusCategory: { key: t.workflowStatus.category } } : { name: CATEGORY[t.status].name, statusCategory: { key: CATEGORY[t.status].key } };
  const description = {
    type: 'doc',
    version: 1,
    content: t.description
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.trim() }] })),
  };
  return {
    issue: {
      id: String(100000 + Number(t.key.split('-')[1] ?? 0)),
      key: t.key,
      fields: {
        summary: t.summary,
        issuetype: { name: t.type, subtask: t.type === 'Sub-task' },
        status,
        priority: { name: t.priority },
        labels: t.labels,
        reporter: { displayName: t.reporter || 'Someone' },
        assignee: { accountId: 'acc-me', displayName: 'Alex Rivera' },
        created: new Date(Date.parse(t.created) || Date.now()).toISOString(),
        updated: new Date(Date.parse(t.updated) || Date.now()).toISOString(),
        description: description.content.length ? description : null,
        [storyPointsField]: t.storyPoints,
        issuelinks: [],
        comment: { comments: [] },
      },
      names: { summary: 'Summary', issuetype: 'Issue Type', status: 'Status', priority: 'Priority', labels: 'Labels', reporter: 'Reporter', assignee: 'Assignee', created: 'Created', updated: 'Updated', description: 'Description', [storyPointsField]: 'Story point estimate' },
      schema: { description: { type: 'string', system: 'description' }, labels: { type: 'array', items: 'string', system: 'labels' }, [storyPointsField]: { type: 'number' } },
      editmeta: { fields: {} },
      changelog: { histories: [] },
    },
    remoteLinks: [],
  };
}
