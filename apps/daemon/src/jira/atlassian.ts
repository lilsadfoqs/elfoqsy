// Jira and Confluence for the orchestrator's proxies: the reads an agent asks for, and the writes the tier policy
// allows (a PR link, the bug fields, comments, transitions, new issues, Description edits, Confluence pages). Only the
// proxies call it, and only after the tier allows. The Authorization header is built here and never logged or put in an
// error. Text goes to Jira as Atlassian Document Format paragraphs.
import { adfToMarkdown, applyDetail, detailText, isEmptyValue, isRichText, valueText, type JiraFieldIds } from '@elfoqsy/state';
import type { BugField, ConfluenceBackend, JiraBackend, JiraFieldFacts, JiraIssueFacts } from '../permissions/jira';
import { redact } from '../redact';
import { adfToText } from './adf';
import { toDetail } from './detail';
import type { IssueStore } from './issues';

export interface AtlassianOptions {
  site: string;
  email: string;
  token: string;
  /** Custom field ids of Root cause description, Solution and AC; without them those fields cannot be read or filled. */
  bugFields: Partial<Record<BugField, string>>;
  fetch?: typeof fetch;
  /** Tickets in full: an agent's `jira get` reads the same store as the ticket view and Elfoqsy. */
  tickets?: { store: IssueStore; ids: () => JiraFieldIds };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Plain text as ADF: one paragraph per blank-line-separated block, line breaks kept. */
const URL_IN_TEXT = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

/** One line as ADF inline nodes: a link alone on its line is a card (his writing rules), a link in a sentence a link. */
function lineToAdf(line: string): Array<Record<string, unknown>> {
  const bare = line.trim();
  if (/^https?:\/\/\S+$/.test(bare)) return [{ type: 'inlineCard', attrs: { url: bare } }];
  const out: Array<Record<string, unknown>> = [];
  let last = 0;
  for (const m of line.matchAll(URL_IN_TEXT)) {
    if (m.index > last) out.push({ type: 'text', text: line.slice(last, m.index) });
    out.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

export function textToAdf(text: string): Record<string, unknown> {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: blocks.map((b) => ({
      type: 'paragraph',
      content: b.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? lineToAdf(line) : [])]),
    })),
  };
}

const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  return adfToText(value).trim() || null;
};

/** Calls to the Atlassian site with alex's token. */
export class AtlassianHttp {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(protected readonly o: AtlassianOptions) {
    this.authorization = `Basic ${Buffer.from(`${o.email}:${o.token}`).toString('base64')}`;
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  protected async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`${this.o.site.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: this.authorization, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = redact((await response.text().catch(() => '')).slice(0, 300)).replace(/\s+/g, ' ');
      throw new Error(`${method} ${path.split('?')[0]} answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export class AtlassianJira extends AtlassianHttp implements JiraBackend {
  private me: string | undefined;

  private check(key: string): string {
    if (!ISSUE_KEY.test(key)) throw new Error(`Not an issue key: ${key}`);
    return key;
  }

  async get(key: string): Promise<JiraIssueFacts> {
    if (this.o.tickets) {
      const bundle = await this.o.tickets.store.get(this.check(key), 30_000);
      const view = applyDetail(undefined, toDetail(bundle, this.o.tickets.ids()), bundle.fetchedAt);
      const assignee = bundle.issue.fields.assignee as { accountId?: string } | null | undefined;
      const status = bundle.issue.fields.status as { name?: string } | undefined;
      return { key: bundle.issue.key, text: detailText(view, this.o.tickets.ids(), this.o.site), ...(assignee?.accountId ? { assigneeAccountId: assignee.accountId } : {}), status: status?.name ?? '' };
    }
    type Issue = {
      key: string;
      fields: {
        summary?: string;
        status?: { name?: string };
        assignee?: { accountId?: string; displayName?: string } | null;
        issuetype?: { name?: string };
        priority?: { name?: string };
        description?: unknown;
        comment?: { comments?: Array<{ author?: { displayName?: string }; created?: string; body?: unknown }> };
        issuelinks?: Array<{ type?: { outward?: string; inward?: string }; outwardIssue?: { key?: string }; inwardIssue?: { key?: string } }>;
      };
    };
    const i = await this.call<Issue>('GET', `/rest/api/3/issue/${this.check(key)}?fields=summary,status,assignee,issuetype,priority,description,comment,issuelinks`);
    const f = i.fields;
    const comments = (f.comment?.comments ?? []).map((c) => `- ${c.author?.displayName ?? 'someone'}, ${c.created?.slice(0, 10) ?? ''}: ${asText(c.body) ?? ''}`);
    const links = (f.issuelinks ?? []).map((l) => (l.outwardIssue ? `${l.type?.outward ?? 'relates to'} ${l.outwardIssue.key}` : `${l.type?.inward ?? 'relates to'} ${l.inwardIssue?.key}`));
    const text = [
      `${i.key}  ${f.issuetype?.name ?? ''}  ${f.status?.name ?? ''}  ${f.priority?.name ?? ''}`.trim(),
      f.summary ?? '',
      `Assignee: ${f.assignee?.displayName ?? 'unassigned'}`,
      '',
      asText(f.description) ?? '(no description)',
      ...(links.length ? ['', 'Links:', ...links.map((l) => `- ${l}`)] : []),
      ...(comments.length ? ['', `Comments (${comments.length}):`, ...comments] : []),
    ].join('\n');
    return { key: i.key, text, ...(f.assignee?.accountId ? { assigneeAccountId: f.assignee.accountId } : {}), status: f.status?.name ?? '' };
  }

  async search(jql: string, max: number): Promise<string> {
    const params = new URLSearchParams({ jql, maxResults: String(max), fields: 'summary,status,assignee,issuetype' });
    const r = await this.call<{ issues?: Array<{ key: string; fields: { summary?: string; status?: { name?: string }; assignee?: { displayName?: string } | null; issuetype?: { name?: string } } }> }>('GET', `/rest/api/3/search/jql?${params}`);
    return (r.issues ?? []).map((i) => `${i.key}  ${i.fields.issuetype?.name ?? ''}  ${i.fields.status?.name ?? ''}  ${i.fields.assignee?.displayName ?? 'unassigned'}  ${i.fields.summary ?? ''}`).join('\n') || 'No issues.';
  }

  async myAccountId(): Promise<string> {
    this.me ??= (await this.call<{ accountId: string }>('GET', '/rest/api/3/myself')).accountId;
    return this.me;
  }

  async remoteLinks(key: string): Promise<Array<{ id: string; url: string; title: string }>> {
    const links = await this.call<Array<{ id: number; object?: { url?: string; title?: string } }>>('GET', `/rest/api/3/issue/${this.check(key)}/remotelink`);
    return links.map((l) => ({ id: String(l.id), url: l.object?.url ?? '', title: l.object?.title ?? '' }));
  }

  async addRemoteLink(key: string, url: string, title: string): Promise<void> {
    // The URL is the global id, so linking the same PR twice changes nothing.
    await this.call('POST', `/rest/api/3/issue/${this.check(key)}/remotelink`, { globalId: url, object: { url, title } });
  }

  async deleteRemoteLink(key: string, id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`Not a link id: ${id}`);
    await this.call('DELETE', `/rest/api/3/issue/${this.check(key)}/remotelink/${id}`);
  }

  private fieldIds(): Record<BugField, string> {
    const { rootCause, solution, ac } = this.o.bugFields;
    if (!rootCause || !solution || !ac) throw new Error('The Jira field ids of Root cause, Solution and AC are not configured (JIRA_ROOT_CAUSE_FIELD, JIRA_SOLUTION_FIELD, JIRA_AC_FIELD).');
    return { rootCause, solution, ac };
  }

  async bugFields(key: string): Promise<Record<BugField, string | null>> {
    const ids = this.fieldIds();
    const i = await this.call<{ fields: Record<string, unknown> }>('GET', `/rest/api/3/issue/${this.check(key)}?fields=${Object.values(ids).join(',')}`);
    return { rootCause: asText(i.fields[ids.rootCause]), solution: asText(i.fields[ids.solution]), ac: asText(i.fields[ids.ac]) };
  }

  async setBugFields(key: string, values: Partial<Record<BugField, string>>): Promise<void> {
    const ids = this.fieldIds();
    const fields = Object.fromEntries(Object.entries(values).map(([f, text]) => [ids[f as BugField], text ? textToAdf(text) : null]));
    await this.call('PUT', `/rest/api/3/issue/${this.check(key)}`, { fields });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call('POST', `/rest/api/3/issue/${this.check(key)}/comment`, { body: textToAdf(text) });
  }

  async transition(key: string, to: string): Promise<string> {
    const { transitions = [] } = await this.call<{ transitions?: Array<{ id: string; name: string; to?: { name?: string } }> }>('GET', `/rest/api/3/issue/${this.check(key)}/transitions`);
    const t = transitions.find((x) => x.name.toLowerCase() === to.toLowerCase() || x.to?.name?.toLowerCase() === to.toLowerCase());
    if (!t) throw new Error(`${key} has no transition to ${to}. Available: ${transitions.map((x) => x.to?.name ?? x.name).join(', ') || 'none'}.`);
    await this.call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    return `Moved ${key} to ${t.to?.name ?? t.name}.`;
  }


  async description(key: string): Promise<string> {
    const i = await this.call<{ fields: { description?: unknown } }>('GET', `/rest/api/3/issue/${this.check(key)}?fields=description`);
    return asText(i.fields.description) ?? '';
  }

  async setDescription(key: string, text: string): Promise<void> {
    await this.call('PUT', `/rest/api/3/issue/${this.check(key)}`, { fields: { description: text ? textToAdf(text) : null } });
  }

  /** A field by its id or its Jira name, read fresh. Names are not unique here: an editable one wins. */
  async field(key: string, field: string): Promise<JiraFieldFacts> {
    if (!this.o.tickets) throw new Error('Tickets in full are not set up here.');
    const { issue } = await this.o.tickets.store.get(this.check(key));
    const names = issue.names ?? {};
    const editable = issue.editmeta?.fields ?? {};
    const byName = Object.keys(names).filter((id) => names[id]!.toLowerCase() === field.trim().toLowerCase());
    const id = field in names || field in editable ? field : (byName.find((x) => x in editable) ?? byName[0]);
    if (!id) throw new Error(`${key} has no field called ${field}.`);
    const value = issue.fields[id] ?? null;
    const schema = issue.schema?.[id];
    const rich = isRichText(schema, value);
    return {
      id,
      name: names[id] ?? id,
      empty: isEmptyValue(value),
      rich,
      editable: (editable[id]?.operations ?? []).includes('set'),
      value,
      text: rich ? adfToMarkdown(value) : valueText(value, schema),
    };
  }

  async setField(key: string, id: string, value: unknown): Promise<void> {
    await this.call('PUT', `/rest/api/3/issue/${this.check(key)}`, { fields: { [id]: value } });
  }
}

export class AtlassianConfluence extends AtlassianHttp implements ConfluenceBackend {
  private page(id: string): string {
    if (!/^\d+$/.test(id)) throw new Error(`Not a page id: ${id}`);
    return id;
  }

  async search(cql: string, limit: number): Promise<string> {
    const params = new URLSearchParams({ cql, limit: String(limit) });
    const r = await this.call<{ results?: Array<{ title?: string; excerpt?: string; url?: string; content?: { id?: string; space?: { key?: string } } }> }>('GET', `/wiki/rest/api/search?${params}`);
    return (r.results ?? []).map((x) => `${x.content?.id ?? ''}  ${x.content?.space?.key ?? ''}  ${x.title ?? ''}${x.excerpt ? ` — ${x.excerpt.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n') || 'No pages.';
  }

  async get(pageId: string): Promise<{ title: string; version: number; text: string }> {
    const p = await this.call<{ title: string; version?: { number?: number }; body?: { storage?: { value?: string } } }>('GET', `/wiki/rest/api/content/${this.page(pageId)}?expand=body.storage,version`);
    return { title: p.title, version: p.version?.number ?? 0, text: storageToText(p.body?.storage?.value ?? '') };
  }

  async create(space: string, title: string, body: string, parentId?: string): Promise<string> {
    const r = await this.call<{ id: string }>('POST', '/wiki/rest/api/content', {
      type: 'page',
      title,
      space: { key: space },
      ...(parentId ? { ancestors: [{ id: this.page(parentId) }] } : {}),
      body: { storage: { value: textToStorage(body), representation: 'storage' } },
    });
    return r.id;
  }

  async update(pageId: string, title: string | undefined, body: string): Promise<number> {
    const now = await this.call<{ title: string; version?: { number?: number } }>('GET', `/wiki/rest/api/content/${this.page(pageId)}?expand=version`);
    const next = (now.version?.number ?? 0) + 1;
    await this.call('PUT', `/wiki/rest/api/content/${pageId}`, { type: 'page', title: title ?? now.title, version: { number: next }, body: { storage: { value: textToStorage(body), representation: 'storage' } } });
    return next;
  }

  async restore(pageId: string, version: number): Promise<number> {
    const old = await this.call<{ title: string; body?: { storage?: { value?: string } } }>('GET', `/wiki/rest/api/content/${this.page(pageId)}?status=historical&version=${version}&expand=body.storage`);
    const now = await this.call<{ version?: { number?: number } }>('GET', `/wiki/rest/api/content/${pageId}?expand=version`);
    const next = (now.version?.number ?? 0) + 1;
    await this.call('PUT', `/wiki/rest/api/content/${pageId}`, { type: 'page', title: old.title, version: { number: next, message: `Restored version ${version}` }, body: { storage: { value: old.body?.storage?.value ?? '', representation: 'storage' } } });
    return next;
  }
}

/** Plain text or Markdown-ish text as Confluence storage: one paragraph per block, escaped. */
export function textToStorage(text: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => `<p>${b.split('\n').map(esc).join('<br/>')}</p>`)
    .join('');
}

/** Confluence storage as readable text: tags dropped, blocks on their own lines. */
export function storageToText(storage: string): string {
  return storage
    .replace(/<(br|\/p|\/h\d|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
