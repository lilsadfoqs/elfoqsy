// Tickets read in full from Jira: every field with its name, schema and edit metadata, the changelog, and the
// remote links. One store, cached per issue: the ticket view, Elfoqsy's lookup_jira and the agents' `jira get` all read
// the same object, so she sees every field he does. Reads only.
import type { JiraFieldSchema } from '@elfoqsy/contracts';

export interface RawUser {
  accountId?: string;
  displayName?: string;
}

export interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  names?: Record<string, string>;
  schema?: Record<string, JiraFieldSchema & Record<string, unknown>>;
  editmeta?: { fields?: Record<string, { required?: boolean; operations?: string[]; allowedValues?: unknown[] }> };
  changelog?: { histories?: Array<{ id: string; author?: RawUser; created: string; items?: Array<Record<string, unknown>> }> };
}

export interface RawRemoteLink {
  id: number | string;
  relationship?: string;
  application?: { type?: string; name?: string };
  object?: { url?: string; title?: string };
}

/** What the store reads from Jira and Confluence: GETs only. */
export interface JiraReader {
  issue(key: string): Promise<RawIssue>;
  remoteLinks(key: string): Promise<RawRemoteLink[]>;
  /** A Confluence page's title, or null when it cannot be read. */
  confluenceTitle(pageId: string): Promise<string | null>;
  fields(): Promise<Array<{ id: string; name: string }>>;
  myself(): Promise<{ accountId: string; displayName: string }>;
  /** An attachment's bytes, for the ticket view. */
  attachment(id: string): Promise<{ bytes: Buffer; mediaType: string }>;
  /** The assignees of these tickets (one search), for the linked items' and sub-tasks' rows. */
  assignees(keys: string[]): Promise<Record<string, RawUser | null>>;
  /** A search with comments and changelogs, for Jira news in the digest. */
  news(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown>; changelog?: RawIssue['changelog'] }>>;
}

/** Linked items and sub-tasks carry no assignee in Jira's answer: add each one's, read in one search. */
async function withAssignees(issue: RawIssue, reader: JiraReader): Promise<RawIssue> {
  const others: Array<Record<string, unknown>> = [];
  for (const l of Array.isArray(issue.fields.issuelinks) ? (issue.fields.issuelinks as Array<Record<string, unknown>>) : []) {
    const other = (l.outwardIssue ?? l.inwardIssue) as Record<string, unknown> | undefined;
    if (other) others.push(other);
  }
  for (const s of Array.isArray(issue.fields.subtasks) ? (issue.fields.subtasks as Array<Record<string, unknown>>) : []) others.push(s);
  const keys = [...new Set(others.map((o) => o.key).filter((k): k is string => typeof k === 'string'))];
  if (!keys.length) return issue;
  const found = await reader.assignees(keys).catch(() => ({}) as Record<string, RawUser | null>);
  for (const o of others) {
    const key = o.key as string;
    if (key in found) o.fields = { ...((o.fields as Record<string, unknown> | undefined) ?? {}), assignee: found[key] };
  }
  return issue;
}

export interface IssueBundle {
  issue: RawIssue;
  remoteLinks: RawRemoteLink[];
  fetchedAt: number;
}

export class IssueStore {
  private readonly cache = new Map<string, IssueBundle>();
  private readonly reading = new Map<string, Promise<IssueBundle>>();

  constructor(
    readonly reader: JiraReader,
    private readonly now: () => number = Date.now,
  ) {}

  /** The issue, read again unless a cached one is at most maxAgeMs old. Two reads at once share one request. */
  async get(key: string, maxAgeMs?: number): Promise<IssueBundle> {
    const cached = this.cache.get(key);
    if (cached && maxAgeMs !== undefined && this.now() - cached.fetchedAt <= maxAgeMs) return cached;
    const pending = this.reading.get(key);
    if (pending) return pending;
    const read = (async () => {
      const [read, remoteLinks] = await Promise.all([this.reader.issue(key), this.reader.remoteLinks(key).catch(() => [] as RawRemoteLink[])]);
      const issue = await withAssignees(read, this.reader);
      const bundle = { issue, remoteLinks, fetchedAt: this.now() };
      this.cache.set(key, bundle);
      return bundle;
    })().finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  peek(key: string): IssueBundle | undefined {
    return this.cache.get(key);
  }

  /** An attachment of an issue read so far: the only ones the screens may ask for. */
  attachmentMeta(id: string): { filename?: string; mimeType?: string; size?: number } | undefined {
    for (const b of this.cache.values()) {
      const files = Array.isArray(b.issue.fields.attachment) ? (b.issue.fields.attachment as Array<{ id?: unknown; filename?: string; mimeType?: string; size?: number }>) : [];
      const file = files.find((f) => String(f.id) === id);
      if (file) return { ...(file.filename ? { filename: file.filename } : {}), ...(file.mimeType ? { mimeType: file.mimeType } : {}), ...(typeof file.size === 'number' ? { size: file.size } : {}) };
    }
    return undefined;
  }
}
