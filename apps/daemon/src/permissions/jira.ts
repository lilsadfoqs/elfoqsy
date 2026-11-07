// The jira and confluence proxies: structured actions, run with alex's Atlassian token. Reads are free. Linking
// the run's own PR in its ticket is done at once and reported. Filling an empty field of the run's ticket assigned to
// alex follows his delegation; comments, transitions, Description edits, filling over text, and creating
// or editing a Confluence page are asked. No action creates a Jira issue: only he does, from his own form or a
// draft card.
import { markdownToAdf } from '@elfoqsy/state';
import { z } from 'zod';
import { redact } from '../redact';
import { invalid, shortOutput, type Classified, type Outcome, type ProxyHandler, type Recorded, type RunRef } from './types';

const key = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/, 'a ticket key like SHOP-3492');
const text = (max: number) => z.string().max(max);

export const jiraSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), key }),
  z.object({ action: z.literal('search'), jql: text(2000).min(1), max: z.number().int().min(1).max(50).optional() }),
  z.object({ action: z.literal('link_pr'), key, url: z.url() }),
  z.object({ action: z.literal('unlink_pr'), key, url: z.url() }),
  z.object({ action: z.literal('fill'), key, rootCause: text(8000).optional(), solution: text(8000).optional(), ac: text(8000).optional() }),
  z.object({ action: z.literal('comment'), key, text: text(8000).min(1) }),
  z.object({ action: z.literal('transition'), key, to: text(80).min(1) }),
  z.object({ action: z.literal('edit_description'), key, description: text(20_000) }),
  // Any field by its Jira name or id: text as Markdown for a rich-text field, or a value in Jira's own shape.
  z.object({ action: z.literal('set_field'), key, field: text(120).min(1), text: text(20_000).optional(), value: z.unknown().optional() }),
]);
export type JiraRequest = z.infer<typeof jiraSchema>;

export const confluenceSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), cql: text(2000).min(1), limit: z.number().int().min(1).max(25).optional() }),
  z.object({ action: z.literal('get'), pageId: z.string().regex(/^\d+$/) }),
  z.object({ action: z.literal('create'), space: z.string().regex(/^[A-Za-z0-9~]+$/), title: text(250).min(1), body: text(100_000), parentId: z.string().regex(/^\d+$/).optional() }),
  z.object({ action: z.literal('edit'), pageId: z.string().regex(/^\d+$/), title: text(250).min(1).optional(), body: text(100_000) }),
  z.object({ action: z.literal('restore'), pageId: z.string().regex(/^\d+$/), version: z.number().int().positive() }),
]);
export type ConfluenceRequest = z.infer<typeof confluenceSchema>;

/** The bug fields the team fills: Root cause description, Solution and AC. */
export type BugField = 'rootCause' | 'solution' | 'ac';
export const BUG_FIELD_NAMES: Record<BugField, string> = { rootCause: 'Root cause', solution: 'Solution', ac: 'AC' };

/** A field of a ticket, read fresh, for set_field. */
export interface JiraFieldFacts {
  id: string;
  name: string;
  empty: boolean;
  /** Rich text (ADF). */
  rich: boolean;
  /** On this ticket's edit screen, and settable. */
  editable: boolean;
  /** Its value in Jira's shape (null when empty), and as text for the record. */
  value: unknown;
  text: string;
}

export interface JiraIssueFacts {
  key: string;
  /** For the agent: the issue as text, with its comments and links. */
  text: string;
  assigneeAccountId?: string;
  status: string;
}

/** alex's Jira, as the proxy uses it. Every write here runs only after the tier allows it. */
export interface JiraBackend {
  get(key: string): Promise<JiraIssueFacts>;
  search(jql: string, max: number): Promise<string>;
  myAccountId(): Promise<string>;
  remoteLinks(key: string): Promise<Array<{ id: string; url: string; title: string }>>;
  addRemoteLink(key: string, url: string, title: string): Promise<void>;
  deleteRemoteLink(key: string, id: string): Promise<void>;
  /** The bug fields as plain text; null when empty. Throws when their field ids are not configured. */
  bugFields(key: string): Promise<Record<BugField, string | null>>;
  setBugFields(key: string, values: Partial<Record<BugField, string>>): Promise<void>;
  comment(key: string, text: string): Promise<void>;
  transition(key: string, to: string): Promise<string>;
  description(key: string): Promise<string>;
  setDescription(key: string, text: string): Promise<void>;
  /** A field by its Jira name or id; throws when the ticket has no such field. */
  field(key: string, field: string): Promise<JiraFieldFacts>;
  setField(key: string, id: string, value: unknown): Promise<void>;
}

export interface ConfluenceBackend {
  search(cql: string, limit: number): Promise<string>;
  get(pageId: string): Promise<{ title: string; version: number; text: string }>;
  create(space: string, title: string, body: string, parentId?: string): Promise<string>;
  update(pageId: string, title: string | undefined, body: string): Promise<number>;
  restore(pageId: string, version: number): Promise<number>;
}

/** Is it one of this run's PRs: github.com/<one of its repositories>/pull/<n>? */
export function runPr(url: string, run: RunRef): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!m) return null;
  const repo = run.targets.find((t) => t.repo.toLowerCase() === m[1]!.toLowerCase())?.repo;
  return repo ? { repo, number: Number(m[2]) } : null;
}

export class JiraProxy implements ProxyHandler<JiraRequest> {
  readonly name = 'jira' as const;
  readonly schema = jiraSchema;

  constructor(
    private readonly jira: JiraBackend,
    /** The head branch of a PR, read from GitHub, so only the run's own PR is linked at once. */
    private readonly prHead?: (repo: string, number: number) => Promise<string | null>,
  ) {}

  async classify(r: JiraRequest, run: RunRef): Promise<Classified> {
    const summary = describeJira(r);
    const base = { kind: `jira.${r.action}`, summary, ...targetOf(r) };
    switch (r.action) {
      case 'get':
      case 'search':
        return { ...base, tier: 0, reason: 'A read.' };
      case 'link_pr':
      case 'unlink_pr': {
        const pr = runPr(r.url, run);
        const own = r.key === run.ticket && pr !== null && (!this.prHead || (await this.prHead(pr.repo, pr.number).catch(() => null)) === run.branch);
        return own
          ? { ...base, tier: 1, reason: `${r.action === 'link_pr' ? 'Linking' : 'Unlinking'} the run's own PR in its ticket is done at once.` }
          : { ...base, tier: 2, reason: `Only the run's own PR on ${run.ticket} is linked at once; this is asked first.` };
      }
      case 'fill': {
        const named = (['rootCause', 'solution', 'ac'] as const).filter((f) => r[f] !== undefined);
        if (!named.length) return invalid('jira.fill', summary, 'Give at least one of rootCause, solution and ac.');
        let current: Record<BugField, string | null>;
        let issue: JiraIssueFacts;
        let me: string;
        try {
          [current, issue, me] = await Promise.all([this.jira.bugFields(r.key), this.jira.get(r.key), this.jira.myAccountId()]);
        } catch (error) {
          return invalid('jira.fill', summary, error instanceof Error ? error.message : String(error));
        }
        const over = named.filter((f) => current[f]?.trim());
        if (r.key !== run.ticket) return { ...base, tier: 2, kind: 'jira.fill_other', reason: `Filling fields on ${r.key}, not this run's ticket, is asked first.` };
        if (issue.assigneeAccountId !== me) return { ...base, tier: 2, kind: 'jira.fill_other', reason: `${r.key} is not assigned to alex: filling its fields is asked first.` };
        if (over.length) return { ...base, tier: 2, kind: 'jira.fill_over', reason: `${over.map((f) => BUG_FIELD_NAMES[f]).join(', ')} already ${over.length === 1 ? 'has' : 'have'} text: writing over it is asked first.` };
        // Filling empty fields of his own ticket is his delegation's to decide: decide and tell him by default.
        return { ...base, tier: 2, reason: 'Filling empty Root cause, Solution and AC on alex\'s own ticket.' };
      }
      case 'set_field': {
        let f: JiraFieldFacts;
        let issue: JiraIssueFacts;
        let me: string;
        try {
          [f, issue, me] = await Promise.all([this.jira.field(r.key, r.field), this.jira.get(r.key), this.jira.myAccountId()]);
        } catch (error) {
          return invalid('jira.set_field', summary, error instanceof Error ? error.message : String(error));
        }
        if (!f.editable) return invalid('jira.set_field', summary, `${f.name} cannot be set on ${r.key}: it is not on its edit screen.`);
        if (r.text === undefined && r.value === undefined) return invalid('jira.set_field', summary, 'Give text (Markdown for rich text) or a value in Jira\'s shape.');
        const named = { ...base, target: { key: r.key, fieldId: f.id, what: 'field' as const }, summary: `Set ${f.name} on ${r.key}` };
        if (run.actor !== 'elfoqsy' && r.key !== run.ticket) return { ...named, tier: 2, kind: 'jira.fill_other', reason: `Setting fields on ${r.key}, not this run's ticket, is asked first.` };
        if (issue.assigneeAccountId !== me) return { ...named, tier: 2, kind: 'jira.fill_other', reason: `${r.key} is not assigned to alex: setting its fields is asked first.` };
        if (!f.empty) return { ...named, tier: 2, kind: 'jira.fill_over', reason: `${f.name} already has a value: writing over it is asked first.` };
        return { ...named, tier: 2, reason: `Filling the empty ${f.name} of alex's own ticket.` };
      }
      case 'comment':
        return { ...base, tier: 2, reason: 'A Jira comment is asked first.' };
      case 'transition':
        return { ...base, tier: 2, reason: 'Transitions are alex\'s: asked first.' };
      case 'edit_description':
        return { ...base, tier: 2, reason: 'Editing a Description is asked first.' };
    }
  }

  async record(r: JiraRequest, c: Classified): Promise<Recorded | null> {
    if (c.tier === 0) return null;
    switch (r.action) {
      case 'link_pr': {
        const links = await this.jira.remoteLinks(r.key);
        return {
          target: `${r.key}'s links`,
          before: links.length ? links.map((l) => l.url).join(', ') : 'No links.',
          ...(links.some((l) => l.url === r.url) ? { noUndo: 'The link was already there.' } : { undo: { proxy: 'jira', summary: `Remove the link to ${r.url} from ${r.key}`, request: { action: 'unlink_pr', key: r.key, url: r.url } } }),
        };
      }
      case 'unlink_pr':
        return { target: `${r.key}'s links`, before: r.url, undo: { proxy: 'jira', summary: `Link ${r.url} in ${r.key} again`, request: { action: 'link_pr', key: r.key, url: r.url } } };
      case 'fill': {
        const current = await this.jira.bugFields(r.key);
        const named = (['rootCause', 'solution', 'ac'] as const).filter((f) => r[f] !== undefined);
        return {
          target: `${r.key}: ${named.map((f) => BUG_FIELD_NAMES[f]).join(', ')}`,
          before: named.map((f) => `${BUG_FIELD_NAMES[f]}: ${current[f] ? `"${current[f]!.slice(0, 300)}"` : 'empty'}`).join('; '),
          undo: { proxy: 'jira', summary: `Put ${named.map((f) => BUG_FIELD_NAMES[f]).join(', ')} on ${r.key} back`, request: { action: 'fill', key: r.key, ...Object.fromEntries(named.map((f) => [f, current[f] ?? ''])) } },
        };
      }
      case 'set_field': {
        const f = await this.jira.field(r.key, r.field);
        return {
          target: `${r.key}'s ${f.name}`,
          before: f.empty ? 'Empty.' : f.text.slice(0, 500),
          undo: { proxy: 'jira', summary: `Put ${r.key}'s ${f.name} back`, request: { action: 'set_field', key: r.key, field: f.id, value: f.value } },
        };
      }
      case 'edit_description': {
        const before = await this.jira.description(r.key);
        return { target: `${r.key}'s Description`, before: before.slice(0, 500) || 'Empty.', undo: { proxy: 'jira', summary: `Put ${r.key}'s Description back`, request: { action: 'edit_description', key: r.key, description: before } } };
      }
      case 'transition': {
        const issue = await this.jira.get(r.key);
        return { target: `${r.key}'s status`, before: issue.status, noUndo: 'Transitions back are alex\'s to make.' };
      }
      case 'comment':
        return { target: `${r.key}'s comments`, before: 'Without this comment.', noUndo: 'The comment stays; delete it in Jira if it should go.' };
      default:
        return null;
    }
  }

  async execute(r: JiraRequest): Promise<Outcome> {
    try {
      switch (r.action) {
        case 'get':
          return { ok: true, output: shortOutput(redact((await this.jira.get(r.key)).text)) };
        case 'search':
          return { ok: true, output: shortOutput(redact(await this.jira.search(r.jql, r.max ?? 20))) };
        case 'link_pr':
          await this.jira.addRemoteLink(r.key, r.url, prTitle(r.url));
          return { ok: true, output: `Linked ${r.url} in ${r.key}.`, done: `linked ${prTitle(r.url)} in ${r.key}`, doneVi: `đã gắn ${prTitle(r.url)} vào ${r.key}` };
        case 'unlink_pr': {
          const link = (await this.jira.remoteLinks(r.key)).find((l) => l.url === r.url);
          if (link) await this.jira.deleteRemoteLink(r.key, link.id);
          return { ok: true, output: link ? `Removed the link to ${r.url}.` : 'There was no such link.', done: `removed the link to ${prTitle(r.url)} from ${r.key}`, doneVi: `đã gỡ liên kết tới ${prTitle(r.url)} khỏi ${r.key}` };
        }
        case 'fill': {
          const values = Object.fromEntries((['rootCause', 'solution', 'ac'] as const).filter((f) => r[f] !== undefined).map((f) => [f, r[f]!]));
          await this.jira.setBugFields(r.key, values);
          const names = Object.keys(values).map((f) => BUG_FIELD_NAMES[f as BugField]);
          return { ok: true, output: `Filled ${names.join(', ')} on ${r.key}.`, done: `filled ${listed(names)} on ${r.key}`, doneVi: `đã điền ${listedVi(names)} của ${r.key}` };
        }
        case 'comment':
          await this.jira.comment(r.key, r.text);
          return { ok: true, output: `Commented on ${r.key}.`, done: `commented on ${r.key}`, doneVi: `đã comment vào ${r.key}` };
        case 'transition':
          return { ok: true, output: await this.jira.transition(r.key, r.to), done: `moved ${r.key} to ${r.to}`, doneVi: `đã chuyển ${r.key} sang ${r.to}` };
        case 'edit_description':
          await this.jira.setDescription(r.key, r.description);
          return { ok: true, output: `Updated ${r.key}'s Description.`, done: `updated ${r.key}'s Description`, doneVi: `đã cập nhật Description của ${r.key}` };
        case 'set_field': {
          const f = await this.jira.field(r.key, r.field);
          const value = r.text !== undefined ? (f.rich ? markdownToAdf(r.text) : r.text) : r.value;
          await this.jira.setField(r.key, f.id, value ?? null);
          return { ok: true, output: `Set ${f.name} on ${r.key}.`, done: `set ${f.name} on ${r.key}`, doneVi: `đã đặt ${f.name} của ${r.key}` };
        }
      }
    } catch (error) {
      return { ok: false, output: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }
}

export class ConfluenceProxy implements ProxyHandler<ConfluenceRequest> {
  readonly name = 'confluence' as const;
  readonly schema = confluenceSchema;

  constructor(private readonly confluence: ConfluenceBackend) {}

  async classify(r: ConfluenceRequest): Promise<Classified> {
    const summary = r.action === 'search' ? `Confluence search ${r.cql}` : r.action === 'create' ? `Create the Confluence page "${r.title}" in ${r.space}` : `Confluence ${r.action} page ${r.pageId}`;
    const base = { kind: `confluence.${r.action}`, summary };
    if (r.action === 'search' || r.action === 'get') return { ...base, tier: 0, reason: 'A read.' };
    return { ...base, tier: 2, reason: 'Creating or editing a Confluence page is asked first.' };
  }

  async record(r: ConfluenceRequest, c: Classified): Promise<Recorded | null> {
    if (c.tier === 0) return null;
    if (r.action === 'create') return { target: `a new page in ${r.space}`, before: 'It did not exist.', noUndo: 'Deleting a page is alex\'s to do.' };
    if (r.action === 'edit' || r.action === 'restore') {
      const page = await this.confluence.get(r.pageId);
      return { target: `the page "${page.title}"`, before: `version ${page.version}`, undo: { proxy: 'confluence', summary: `Put "${page.title}" back to version ${page.version}`, request: { action: 'restore', pageId: r.pageId, version: page.version } } };
    }
    return null;
  }

  async execute(r: ConfluenceRequest): Promise<Outcome> {
    try {
      switch (r.action) {
        case 'search':
          return { ok: true, output: shortOutput(redact(await this.confluence.search(r.cql, r.limit ?? 10))) };
        case 'get': {
          const page = await this.confluence.get(r.pageId);
          return { ok: true, output: shortOutput(redact(`${page.title} (version ${page.version})\n\n${page.text}`)) };
        }
        case 'create': {
          const id = await this.confluence.create(r.space, r.title, r.body, r.parentId);
          return { ok: true, output: `Created page ${id}.`, done: `created the Confluence page "${r.title}"`, doneVi: `đã tạo trang Confluence "${r.title}"` };
        }
        case 'edit': {
          const version = await this.confluence.update(r.pageId, r.title, r.body);
          return { ok: true, output: `Saved version ${version}.`, done: `edited Confluence page ${r.pageId}`, doneVi: `đã sửa trang Confluence ${r.pageId}` };
        }
        case 'restore': {
          const version = await this.confluence.restore(r.pageId, r.version);
          return { ok: true, output: `Restored version ${r.version} as version ${version}.`, done: `put Confluence page ${r.pageId} back to version ${r.version}`, doneVi: `đã đưa trang Confluence ${r.pageId} về lại phiên bản ${r.version}` };
        }
      }
    } catch (error) {
      return { ok: false, output: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }
}

function describeJira(r: JiraRequest): string {
  switch (r.action) {
    case 'get':
      return `Read ${r.key}`;
    case 'search':
      return `Search Jira: ${r.jql}`;
    case 'link_pr':
      return `Link ${r.url} in ${r.key}`;
    case 'unlink_pr':
      return `Remove the link to ${r.url} from ${r.key}`;
    case 'fill':
      return `Fill ${listed((['rootCause', 'solution', 'ac'] as const).filter((f) => r[f] !== undefined).map((f) => BUG_FIELD_NAMES[f]))} on ${r.key}`;
    case 'comment':
      return `Comment on ${r.key}: "${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}"`;
    case 'transition':
      return `Move ${r.key} to ${r.to}`;
    case 'edit_description':
      return `Edit ${r.key}'s Description`;
    case 'set_field':
      return `Set ${r.field} on ${r.key}`;
  }
}

/** The ticket a write lands on, so it is logged as an edit there and the ticket read back. */
function targetOf(r: JiraRequest): { target?: Classified['target'] } {
  switch (r.action) {
    case 'comment':
      return { target: { key: r.key, what: 'comment_add' } };
    case 'transition':
      return { target: { key: r.key, what: 'transition' } };
    case 'fill':
    case 'edit_description':
    case 'link_pr':
    case 'unlink_pr':
      return { target: { key: r.key, what: 'field' } };
    default:
      return {};
  }
}

const prTitle = (url: string): string => {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]} #${m[2]}` : url;
};

const listed = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const listedVi = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} và ${items.at(-1)}`);
