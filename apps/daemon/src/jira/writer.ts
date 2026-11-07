// alex's own edits of his tickets: straight to Jira with his credentials, logged as his, no tier and no
// approval. Also the reads his pickers need: assignable people, the board's sprints, link types, labels, a search.
// Only the edit service calls it, and only for a frame he sent; Elfoqsy and the agents go through the Jira proxy.
import { AtlassianHttp } from './atlassian';
import type { RawUser } from './issues';

export interface RawTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
  fields?: Record<string, { required?: boolean; name?: string; schema?: Record<string, unknown>; allowedValues?: unknown[] }>;
}

export interface JiraWriter {
  setFields(key: string, fields: Record<string, unknown>): Promise<void>;
  transitions(key: string): Promise<RawTransition[]>;
  transition(key: string, id: string, fields?: Record<string, unknown>): Promise<void>;
  addComment(key: string, body: unknown): Promise<string>;
  editComment(key: string, id: string, body: unknown): Promise<void>;
  deleteComment(key: string, id: string): Promise<void>;
  /** A link of this type: inward is blocked by outward, for "Blocks". */
  addLink(type: string, inward: string, outward: string): Promise<void>;
  deleteLink(id: string): Promise<void>;
  users(project: string): Promise<RawUser[]>;
  sprints(boardId: number): Promise<Array<{ id: number; name: string; state: string; goal?: string }>>;
  linkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>>;
  labels(): Promise<string[]>;
  search(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown> }>>;
  /** Jira's create screen: a project's issue types, and one type's fields. */
  createTypes(project: string): Promise<Array<{ id: string; name: string; subtask: boolean }>>;
  createFields(project: string, typeId: string): Promise<Array<{ fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: Record<string, unknown>; allowedValues?: unknown[] }>>;
  /** Creates an issue: only ever for his own Create. */
  create(fields: Record<string, unknown>): Promise<string>;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const check = (key: string): string => {
  if (!ISSUE_KEY.test(key)) throw new Error(`Not an issue key: ${key}`);
  return key;
};
const num = (id: string): string => {
  if (!/^\d+$/.test(id)) throw new Error(`Not an id: ${id}`);
  return id;
};

export class AtlassianWriter extends AtlassianHttp implements JiraWriter {
  async setFields(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.call('PUT', `/rest/api/3/issue/${check(key)}`, { fields });
  }

  async transitions(key: string): Promise<RawTransition[]> {
    return (await this.call<{ transitions?: RawTransition[] }>('GET', `/rest/api/3/issue/${check(key)}/transitions?expand=transitions.fields`)).transitions ?? [];
  }

  async transition(key: string, id: string, fields?: Record<string, unknown>): Promise<void> {
    await this.call('POST', `/rest/api/3/issue/${check(key)}/transitions`, { transition: { id: num(id) }, ...(fields && Object.keys(fields).length ? { fields } : {}) });
  }

  async addComment(key: string, body: unknown): Promise<string> {
    return (await this.call<{ id: string }>('POST', `/rest/api/3/issue/${check(key)}/comment`, { body })).id;
  }

  async editComment(key: string, id: string, body: unknown): Promise<void> {
    await this.call('PUT', `/rest/api/3/issue/${check(key)}/comment/${num(id)}`, { body });
  }

  async deleteComment(key: string, id: string): Promise<void> {
    await this.call('DELETE', `/rest/api/3/issue/${check(key)}/comment/${num(id)}`);
  }

  async addLink(type: string, inward: string, outward: string): Promise<void> {
    await this.call('POST', '/rest/api/3/issueLink', { type: { name: type }, inwardIssue: { key: check(inward) }, outwardIssue: { key: check(outward) } });
  }

  async deleteLink(id: string): Promise<void> {
    await this.call('DELETE', `/rest/api/3/issueLink/${num(id)}`);
  }

  async users(project: string): Promise<RawUser[]> {
    if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`Not a project key: ${project}`);
    return this.call('GET', `/rest/api/3/user/assignable/multiProjectSearch?projectKeys=${project}&maxResults=1000`);
  }

  async sprints(boardId: number): Promise<Array<{ id: number; name: string; state: string; goal?: string }>> {
    const r = await this.call<{ values?: Array<{ id: number; name: string; state: string; goal?: string }> }>('GET', `/rest/agile/1.0/board/${Math.trunc(boardId)}/sprint?state=active,future&maxResults=50`);
    return (r.values ?? []).map((s) => ({ id: s.id, name: s.name, state: s.state, ...(s.goal ? { goal: s.goal } : {}) }));
  }

  async linkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>> {
    const r = await this.call<{ issueLinkTypes?: Array<{ id: string; name: string; inward: string; outward: string }> }>('GET', '/rest/api/3/issueLinkType');
    return (r.issueLinkTypes ?? []).map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }));
  }

  async labels(): Promise<string[]> {
    return (await this.call<{ values?: string[] }>('GET', '/rest/api/3/label?maxResults=1000')).values ?? [];
  }

  async createTypes(project: string): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
    if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`Not a project key: ${project}`);
    const r = await this.call<{ issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>; values?: Array<{ id: string; name: string; subtask?: boolean }> }>('GET', `/rest/api/3/issue/createmeta/${project}/issuetypes?maxResults=100`);
    return (r.issueTypes ?? r.values ?? []).map((t) => ({ id: String(t.id), name: t.name, subtask: !!t.subtask }));
  }

  async createFields(project: string, typeId: string): Promise<Array<{ fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: Record<string, unknown>; allowedValues?: unknown[] }>> {
    if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`Not a project key: ${project}`);
    const r = await this.call<{ fields?: Array<{ fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: Record<string, unknown>; allowedValues?: unknown[] }>; values?: Array<{ fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: Record<string, unknown>; allowedValues?: unknown[] }> }>('GET', `/rest/api/3/issue/createmeta/${project}/issuetypes/${num(typeId)}?maxResults=200`);
    return r.fields ?? r.values ?? [];
  }

  async create(fields: Record<string, unknown>): Promise<string> {
    return (await this.call<{ key: string }>('POST', '/rest/api/3/issue', { fields })).key;
  }

  async search(jql: string, max: number): Promise<Array<{ key: string; fields: Record<string, unknown> }>> {
    const params = new URLSearchParams({ jql, maxResults: String(Math.min(max, 50)), fields: 'summary,status,issuetype,customfield_10521' });
    return (await this.call<{ issues?: Array<{ key: string; fields: Record<string, unknown> }> }>('GET', `/rest/api/3/search/jql?${params}`)).issues ?? [];
  }
}
