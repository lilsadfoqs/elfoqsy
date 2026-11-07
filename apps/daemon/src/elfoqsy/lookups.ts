// Elfoqsy's read-only lookups, run by the orchestrator with no model involved: Jira and Confluence
// (same Atlassian site and credentials, GET only), GitHub through the read-only gh allowlist, grep and
// read over the clones under REPOS_ROOT, and Coralogix logs of the non-prod environments. Results
// are trimmed here; the tool layer redacts them before they reach a model.
import { applyDetail, detailText, type JiraFieldIds } from '@elfoqsy/state';
import type { GhReadOnly } from '../github/gh';
import type { JiraClient } from '../jira/client';
import { confluencePageIds, toDetail } from '../jira/detail';
import type { IssueStore } from '../jira/issues';
import type { Environments } from '../permissions/environments';
import { LogsProxy, type LogsQuery, type LogsRequest } from '../permissions/logs';
import type { CodeReader } from './code';

export interface LookupDeps {
  jira?: JiraClient;
  /** Tickets in full: the same store the ticket view reads, so she sees every field he does. */
  tickets?: { store: IssueStore; ids: () => JiraFieldIds };
  gh?: GhReadOnly;
  code?: CodeReader;
  /** https://acme.atlassian.net, for links. */
  site: string;
  /** Coralogix, for the non-prod environments only; without a query (no CORALOGIX_API_KEY) logs say so. */
  logs?: { envs: Environments; query?: LogsQuery; now?: () => number };
}

const cut = (text: string | undefined | null, max: number): string => {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)} [cut]` : t;
};
const name = (u: unknown): string | undefined => (u && typeof u === 'object' && 'displayName' in u ? String((u as { displayName: unknown }).displayName) : undefined);
const field = <T>(f: Record<string, unknown>, k: string): T | undefined => f[k] as T | undefined;

/** Confluence's stored XHTML as plain text. */
export function storageToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/div)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const NOT_SET_UP = (what: string) => ({ error: 'not_configured', message: `${what} is not set up here.` });

/** A ticket read this recently is not read again for her. */
const TICKET_MAX_AGE_MS = 30_000;

export class Lookups {
  constructor(private readonly d: LookupDeps) {}

  /** One ticket with its comments and history, or a JQL search (at most 20). */
  async jira(args: { key?: string; jql?: string; limit?: number }) {
    if (args.key) {
      if (!this.d.tickets) return NOT_SET_UP('Jira tickets');
      const key = args.key.toUpperCase();
      // What the ticket view shows, in its order: every named field, rich text as Markdown, links, comments, history.
      const bundle = await this.d.tickets.store.get(key, TICKET_MAX_AGE_MS);
      const view = applyDetail(undefined, toDetail(bundle, this.d.tickets.ids()), bundle.fetchedAt);
      const status = view.fields.status as { name?: string } | undefined;
      return { key, url: `${this.d.site}/browse/${key}`, status: status?.name, text: cut(detailText(view, this.d.tickets.ids(), this.d.site), 40_000) };
    }
    if (!args.jql) return { error: 'bad_request', message: 'Give a ticket key or a JQL query.' };
    if (!this.d.jira) return NOT_SET_UP('Jira');
    const fields = ['summary', 'status', 'priority', 'issuetype', 'assignee', 'updated'];
    const { issues, more } = await this.d.jira.searchPage(args.jql, fields, Math.min(args.limit ?? 20, 20));
    return {
      issues: issues.map((i) => ({
        key: i.key,
        summary: field<string>(i.fields, 'summary'),
        status: field<{ name?: string }>(i.fields, 'status')?.name,
        priority: field<{ name?: string }>(i.fields, 'priority')?.name,
        type: field<{ name?: string }>(i.fields, 'issuetype')?.name,
        assignee: name(field(i.fields, 'assignee')),
        updated: field<string>(i.fields, 'updated'),
      })),
      more,
    };
  }

  /** A Confluence search (at most 10 results), or one page as text. */

  /**
   * What a ticket points at that a sweep follows: its linked Test tickets, and the Confluence
   * pages it links (in its fields, its comments and its remote links).
   */
  async trail(key: string): Promise<{ tests: string[]; pages: string[] }> {
    if (!this.d.tickets) return { tests: [], pages: [] };
    const bundle = await this.d.tickets.store.get(key.toUpperCase(), TICKET_MAX_AGE_MS);
    type Linked = { key?: string; fields?: { issuetype?: { name?: string } } };
    const links = (Array.isArray(bundle.issue.fields.issuelinks) ? bundle.issue.fields.issuelinks : []) as Array<{ type?: { name?: string; inward?: string; outward?: string }; inwardIssue?: Linked; outwardIssue?: Linked }>;
    const tests = links
      .map((l) => ({ other: l.outwardIssue ?? l.inwardIssue, type: `${l.type?.name ?? ''} ${l.type?.inward ?? ''} ${l.type?.outward ?? ''}` }))
      .filter((l) => l.other?.key && (/^test$/i.test(l.other.fields?.issuetype?.name ?? '') || /\btest/i.test(l.type)))
      .map((l) => l.other!.key!);
    const host = this.d.site.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const page = new RegExp(`https?://${host.replace(/\./g, '\\.')}/wiki/[^\\s"'<>]*?pages/(?:viewpage\\.action\\?pageId=)?(\\d+)`);
    const remote = bundle.remoteLinks.map((l) => page.exec(l.object?.url ?? '')?.[1]).filter((x): x is string => !!x);
    const pages = [...new Set([...confluencePageIds(toDetail(bundle, this.d.tickets.ids()), this.d.site), ...remote])];
    return { tests: [...new Set(tests)].sort(), pages: pages.sort() };
  }

  async confluence(args: { cql?: string; pageId?: string; limit?: number }) {
    if (!this.d.jira) return NOT_SET_UP('Confluence');
    if (args.pageId) {
      const page = await this.d.jira.confluencePage(args.pageId);
      return {
        id: page.id,
        title: page.title,
        space: page.space?.name ?? page.space?.key,
        updated: page.version?.when,
        by: page.version?.by?.displayName,
        url: page._links?.webui ? `${this.d.site}/wiki${page._links.webui}` : undefined,
        text: cut(storageToText(page.body?.storage?.value ?? ''), 12_000),
      };
    }
    if (!args.cql) return { error: 'bad_request', message: 'Give a CQL query or a page id.' };
    const found = await this.d.jira.confluenceSearch(args.cql, Math.min(args.limit ?? 10, 10));
    return {
      results: (found.results ?? []).map((r) => ({
        pageId: r.content?.id,
        title: r.title,
        space: r.content?.space?.name ?? r.content?.space?.key,
        excerpt: cut((r.excerpt ?? '').replace(/@@@(end)?hl@@@/g, ''), 400),
        url: r.url ? `${this.d.site}/wiki${r.url}` : undefined,
        updated: r.lastModified,
      })),
    };
  }

  /** Read-only GitHub: one PR, a repo's PRs, its commits, a commit's checks, or code search. */
  async github(args: { repo: string; what: 'pr' | 'prs' | 'commits' | 'checks' | 'search'; number?: number; ref?: string; query?: string }) {
    const gh = this.d.gh;
    if (!gh) return NOT_SET_UP('GitHub');
    const repo = args.repo;
    switch (args.what) {
      case 'pr': {
        if (!args.number) return { error: 'bad_request', message: 'Give the PR number.' };
        const pr = await gh.json<{
          number: number;
          title: string;
          state: string;
          isDraft: boolean;
          author?: { login?: string };
          headRefName: string;
          baseRefName: string;
          url: string;
          body?: string;
          updatedAt: string;
          mergedAt?: string | null;
          files?: Array<{ path: string; additions: number; deletions: number }>;
          comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
          reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
          statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
        }>(['pr', 'view', String(args.number), '--repo', repo, '--json', 'number,title,state,isDraft,author,headRefName,baseRefName,url,body,updatedAt,mergedAt,files,comments,reviews,statusCheckRollup']);
        return {
          ...pr,
          author: pr.author?.login,
          body: cut(pr.body, 4000),
          files: (pr.files ?? []).slice(0, 100),
          comments: (pr.comments ?? []).slice(-20).map((c) => ({ author: c.author?.login, at: c.createdAt, text: cut(c.body, 1000) })),
          reviews: (pr.reviews ?? []).slice(-20).map((r) => ({ author: r.author?.login, state: r.state, text: cut(r.body, 600) })),
          statusCheckRollup: (pr.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context, status: c.status ?? c.state, conclusion: c.conclusion })),
        };
      }
      case 'prs':
        return {
          prs: await gh.json(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '20', '--json', 'number,title,state,isDraft,headRefName,author,updatedAt,url', ...(args.query ? ['--search', args.query] : [])]),
        };
      case 'commits': {
        const ref = args.ref ? `&sha=${encodeURIComponent(args.ref)}` : '';
        const commits = await gh.json<Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } } }>>(['api', `repos/${repo}/commits?per_page=20${ref}`]);
        return { commits: commits.map((c) => ({ sha: c.sha.slice(0, 12), title: c.commit.message.split('\n')[0], author: c.commit.author?.name, date: c.commit.author?.date, url: c.html_url })) };
      }
      case 'checks': {
        if (!args.ref) return { error: 'bad_request', message: 'Give the commit SHA or branch.' };
        const runs = await gh.json<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null; html_url?: string }> }>(['api', `repos/${repo}/commits/${encodeURIComponent(args.ref)}/check-runs?per_page=50`]);
        return { checks: (runs.check_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })) };
      }
      case 'search': {
        if (!args.query?.trim()) return { error: 'bad_request', message: 'Give what to search for.' };
        const q = `${args.query.replace(/\b(repo|org|user):\S+/g, '').trim()} repo:${repo}`;
        const found = await gh.json<{ total_count: number; items?: Array<{ path: string; html_url: string; text_matches?: Array<{ fragment?: string }> }> }>([
          'api',
          '-H',
          'Accept: application/vnd.github.text-match+json',
          `search/code?q=${encodeURIComponent(q)}&per_page=20`,
        ]);
        return { total: found.total_count, files: (found.items ?? []).map((i) => ({ path: i.path, url: i.html_url, fragments: (i.text_matches ?? []).map((m) => cut(m.fragment, 300)) })) };
      }
    }
  }

  /** Grep (a literal string) or read part of a file in one of the clones. */
  code(args: { repo: string; text?: string; glob?: string; ignoreCase?: boolean; path?: string; from?: number; lines?: number }) {
    if (!this.d.code) return NOT_SET_UP('Reading the code');
    if (args.path) return this.d.code.read({ repo: args.repo, path: args.path, ...(args.from ? { from: args.from } : {}), ...(args.lines ? { lines: args.lines } : {}) });
    if (!args.text) return { error: 'bad_request', message: 'Give text to search for, or a path to read.' };
    return this.d.code.grep({ repo: args.repo, text: args.text, ...(args.glob ? { glob: args.glob } : {}), ...(args.ignoreCase ? { ignoreCase: true } : {}) });
  }

  /**
   * Coralogix logs, read-only and non-prod only: the same filter as an agent's logs tool, which
   * writes the source and the application filter itself. Prod is refused here: only an agent's logs tool asks him for it.
   */
  async logs(args: LogsRequest) {
    if (!this.d.logs) return NOT_SET_UP('Coralogix');
    const proxy = new LogsProxy(this.d.logs.envs, this.d.logs.query, this.d.logs.now);
    const c = await proxy.classify(args);
    if (c.environment === 'prod') return { error: 'prod_refused', message: "Prod logs are not read here. An agent's logs tool asks alex for them." };
    if (c.tier !== 0) return { error: 'refused', message: c.reason };
    const out = await proxy.execute(args);
    return out.ok ? { environment: c.environment ?? 'non-prod', query: args.query, logs: out.output } : { error: 'failed', message: out.output };
  }
}
