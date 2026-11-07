// Read-only Jira Cloud client: one JQL search through /rest/api/3/search/jql, paged with
// nextPageToken; one page of a search for Elfoqsy's lookups; one issue in full with its remote links, the site's
// fields, attachments and Confluence titles for the ticket view; Confluence on the same site with the same
// credentials. Every request is a GET.
// The Authorization header is built here and never logged or put in an error.
import { redact } from '../redact';
import type { JiraReader, RawIssue, RawRemoteLink } from './issues';
import type { JiraIssue } from './map';

export interface JiraClientOptions {
  site: string;
  email: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const PAGE_SIZE = 100;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export interface JiraHistory {
  created?: string;
  author?: { displayName?: string };
  items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }>;
}

export interface ConfluenceResult {
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
  content?: { id?: string; type?: string; space?: { key?: string; name?: string } };
}

/** A pull request Jira's Development field links to a ticket. */
export interface DevPullRequest {
  /** owner/name, as GitHub has it. */
  repo: string;
  number: number;
  title: string;
  /** MERGED, OPEN or DECLINED. */
  status: string;
  branch: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  space?: { key?: string; name?: string };
  version?: { number?: number; when?: string; by?: { displayName?: string } };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}
const MAX_PAGES = 20;

interface SearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

export class JiraClient implements JiraReader {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: JiraClientOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Every issue matching the JQL, all pages, or a JiraError. Never a partial result. */
  async search(jql: string, fields: string[]): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(PAGE_SIZE) });
      if (token) params.set('nextPageToken', token);
      const body = await this.get<SearchPage>(`/rest/api/3/search/jql?${params}`);
      issues.push(...(body.issues ?? []));
      if (body.isLast || !body.nextPageToken) return issues;
      token = body.nextPageToken;
    }
    throw new JiraError(`More than ${MAX_PAGES * PAGE_SIZE} issues; refusing a partial result`);
  }

  /**
   * Every issue matching the JQL, handed over page by page so a caller can save its place (the study's Jira index, which
   * reads thousands). At most `maxPages` pages; returns how many issues it read.
   */
  async scan(jql: string, fields: string[], onPage: (issues: JiraIssue[]) => void | Promise<void>, maxPages = 500): Promise<number> {
    let token: string | undefined;
    let read = 0;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(PAGE_SIZE) });
      if (token) params.set('nextPageToken', token);
      const body = await this.get<SearchPage>(`/rest/api/3/search/jql?${params}`);
      read += body.issues?.length ?? 0;
      await onPage(body.issues ?? []);
      if (body.isLast || !body.nextPageToken) return read;
      token = body.nextPageToken;
    }
    throw new JiraError(`More than ${maxPages * PAGE_SIZE} issues; the pages read so far are kept`);
  }

  /** At most `max` issues of a search, for a lookup: one page, never paged further. */
  async searchPage(jql: string, fields: string[], max: number): Promise<{ issues: JiraIssue[]; more: boolean }> {
    const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(Math.min(max, PAGE_SIZE)) });
    const body = await this.get<SearchPage>(`/rest/api/3/search/jql?${params}`);
    return { issues: body.issues ?? [], more: !body.isLast && !!body.nextPageToken };
  }

  /** One issue in full: every field with its name, schema and edit metadata, and the changelog. */
  async issue(key: string): Promise<RawIssue & { changelog?: { histories?: JiraHistory[] } }> {
    if (!ISSUE_KEY.test(key)) throw new JiraError(`Not a ticket key: ${key}`);
    return this.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names,schema,editmeta,changelog`);
  }

  async remoteLinks(key: string): Promise<RawRemoteLink[]> {
    if (!ISSUE_KEY.test(key)) throw new JiraError(`Not a ticket key: ${key}`);
    return this.get(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`);
  }

  /** Every field on the site, for the field map's start-up check. */
  async fields(): Promise<Array<{ id: string; name: string }>> {
    return this.get('/rest/api/3/field');
  }

  async assignees(keys: string[]): Promise<Record<string, { accountId?: string; displayName?: string } | null>> {
    const valid = keys.filter((k) => ISSUE_KEY.test(k)).slice(0, 50);
    if (!valid.length) return {};
    const { issues } = await this.searchPage(`key in (${valid.join(', ')})`, ['assignee'], valid.length);
    return Object.fromEntries(issues.map((i) => [i.key, (i.fields.assignee as { accountId?: string; displayName?: string } | null) ?? null]));
  }

  async news(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown>; changelog?: RawIssue['changelog'] }>> {
    const params = new URLSearchParams({ jql, fields: 'summary,assignee,reporter,comment,updated', expand: 'changelog', maxResults: String(Math.min(max, 50)) });
    return (await this.get<{ issues?: Array<{ key: string; fields: Record<string, unknown>; changelog?: RawIssue['changelog'] }> }>(`/rest/api/3/search/jql?${params}`)).issues ?? [];
  }

  async myself(): Promise<{ accountId: string; displayName: string }> {
    return this.get('/rest/api/3/myself');
  }

  async confluenceTitle(pageId: string): Promise<string | null> {
    if (!/^\d+$/.test(pageId)) return null;
    return (await this.get<{ title?: string }>(`/wiki/rest/api/content/${pageId}?fields=title`)).title ?? null;
  }

  /** An attachment's bytes: Jira answers with a redirect to its media store, which fetch follows. */
  async attachment(id: string): Promise<{ bytes: Buffer; mediaType: string }> {
    if (!/^\d+$/.test(id)) throw new JiraError(`Not an attachment id: ${id}`);
    const response = await this.raw(`/rest/api/3/attachment/content/${id}`, '*/*');
    return { bytes: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** Confluence search (CQL) on the same site, with the same credentials. */
  async confluenceSearch(cql: string, limit: number): Promise<{ results?: ConfluenceResult[] }> {
    const params = new URLSearchParams({ cql, limit: String(Math.min(limit, 25)) });
    return this.get(`/wiki/rest/api/search?${params}`);
  }

  /** One Confluence page, its body as stored. */
  async confluencePage(id: string): Promise<ConfluencePage> {
    if (!/^\d+$/.test(id)) throw new JiraError(`Not a Confluence page id: ${id}`);
    return this.get(`/wiki/rest/api/content/${id}?expand=body.storage,space,version`);
  }

  /**
   * The pull requests Jira's Development field links to an issue, read through the app instance the field names
   * (oAuth-com.github.integration.production for the GitHub app): repository, number, title, status and branch.
   */
  async devPullRequests(issueId: string, instanceType: string): Promise<DevPullRequest[]> {
    if (!/^\d+$/.test(issueId)) throw new JiraError(`Not an issue id: ${issueId}`);
    const params = new URLSearchParams({ issueId, applicationType: instanceType, dataType: 'pullrequest' });
    const body = await this.get<{ detail?: Array<{ pullRequests?: Array<Record<string, unknown>> }> }>(`/rest/dev-status/latest/issue/detail?${params}`);
    return (body.detail ?? []).flatMap((d) => d.pullRequests ?? []).flatMap((p) => {
      const number = Number(String(p.id ?? '').replace(/^#/, ''));
      const repo = typeof p.repositoryName === 'string' ? p.repositoryName : '';
      if (!repo || !Number.isInteger(number) || number <= 0) return [];
      return [{ repo, number, title: String(p.name ?? ''), status: String(p.status ?? ''), branch: String((p.source as { branch?: unknown } | undefined)?.branch ?? '') }];
    });
  }

  /** A Confluence page's current version number, for the study's upkeep of the pages records cite. */
  async confluenceVersion(id: string): Promise<number | undefined> {
    if (!/^\d+$/.test(id)) throw new JiraError(`Not a Confluence page id: ${id}`);
    return (await this.get<{ version?: { number?: number } }>(`/wiki/rest/api/content/${id}?expand=version`)).version?.number;
  }

  private async get<T>(path: string): Promise<T> {
    return (await (await this.raw(path, 'application/json')).json()) as T;
  }

  /** A GET with his credentials; a JiraError for anything but a 2xx. */
  private async raw(path: string, accept: string): Promise<Response> {
    const url = `${this.options.site.replace(/\/$/, '')}${path}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authorization, Accept: accept },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      const cause = error instanceof Error ? (error.name === 'TimeoutError' ? 'timed out' : error.message) : 'unknown error';
      throw new JiraError(`Jira request failed: ${redact(cause)}`);
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const detail = redact((await response.text().catch(() => '')).slice(0, 200)).replace(/\s+/g, ' ');
      throw new JiraError(
        `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return response;
  }
}

/** Alex's tickets in the open sprints of the configured projects. Keys are validated, so no injection. */
export function sprintJql(projects: string[]): string {
  for (const p of projects) if (!/^[A-Z][A-Z0-9_]+$/.test(p)) throw new JiraError(`Invalid Jira project key: ${p}`);
  return `project in (${projects.join(', ')}) AND sprint in openSprints() AND assignee = currentUser() ORDER BY key`;
}
