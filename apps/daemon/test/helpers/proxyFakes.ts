// Fakes for the proxies' backends: nothing reaches a cluster, AWS, GitHub, Jira, Confluence or Coralogix. Every call is
// recorded, and each backend answers from a table the test can change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvironments, type Environments } from '../../src/permissions/environments';
import type { ProxyBackends } from '../../src/permissions';
import type { BugField, ConfluenceBackend, JiraBackend, JiraIssueFacts } from '../../src/permissions/jira';
import type { ExecResult } from '../../src/permissions/types';

/** The repository's own config/environments.yaml: account ids and names, no secrets. It has no local cluster yet. */
export const configured: Environments = parseEnvironments(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'config', 'environments.yaml'), 'utf8'));

/** The same, with a local minikube added as it will be once one appears. */
export const environments: Environments = { ...configured, list: [...configured.list, { name: 'local', kubeContext: 'minikube', namespace: 'shop-local' }] };

export const ME = 'acct-alex';

export interface FakeBackends extends ProxyBackends {
  calls: { kubectl: Array<{ args: string[]; kubeconfig: string }>; aws: string[][]; gh: string[][]; jira: Array<[string, ...unknown[]]>; confluence: Array<[string, ...unknown[]]>; logs: string[] };
  /** Answers by the first word(s) of the call: the longest matching prefix of the joined args wins. */
  kubeAnswers: Map<string, ExecResult>;
  awsAnswers: Map<string, ExecResult>;
  ghAnswers: Map<string, ExecResult>;
  issues: Map<string, { assignee?: string; status: string; fields: Record<BugField, string | null>; links: Array<{ id: string; url: string; title: string }>; description: string }>;
}

const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '' });

function answer(table: Map<string, ExecResult>, args: string[], fallback: ExecResult): ExecResult {
  const joined = args.join(' ');
  let best: string | undefined;
  for (const prefix of table.keys()) if (joined.includes(prefix) && (!best || prefix.length > best.length)) best = prefix;
  return best ? table.get(best)! : fallback;
}

export function fakeBackends(): FakeBackends {
  const calls: FakeBackends['calls'] = { kubectl: [], aws: [], gh: [], jira: [], confluence: [], logs: [] };
  const kubeAnswers = new Map<string, ExecResult>();
  const awsAnswers = new Map<string, ExecResult>();
  const ghAnswers = new Map<string, ExecResult>([['pr create', ok('https://github.com/acme/shop-api/pull/9\n')]]);
  const issues: FakeBackends['issues'] = new Map();
  const issue = (key: string) => {
    if (!issues.has(key)) issues.set(key, { assignee: ME, status: 'To do', fields: { rootCause: null, solution: null, ac: null }, links: [], description: '' });
    return issues.get(key)!;
  };
  const jira: JiraBackend = {
    async get(key): Promise<JiraIssueFacts> {
      calls.jira.push(['get', key]);
      const i = issue(key);
      return { key, text: `${key}  Bug  ${i.status}`, status: i.status, ...(i.assignee ? { assigneeAccountId: i.assignee } : {}) };
    },
    async search(jql, max) {
      calls.jira.push(['search', jql, max]);
      return 'SHOP-3546  Bug  To do';
    },
    async myAccountId() {
      return ME;
    },
    async remoteLinks(key) {
      return [...issue(key).links];
    },
    async addRemoteLink(key, url, title) {
      calls.jira.push(['addRemoteLink', key, url]);
      const i = issue(key);
      if (!i.links.some((l) => l.url === url)) i.links.push({ id: String(i.links.length + 1), url, title });
    },
    async deleteRemoteLink(key, id) {
      calls.jira.push(['deleteRemoteLink', key, id]);
      const i = issue(key);
      i.links = i.links.filter((l) => l.id !== id);
    },
    async bugFields(key) {
      return { ...issue(key).fields };
    },
    async setBugFields(key, values) {
      calls.jira.push(['setBugFields', key, values]);
      const i = issue(key);
      for (const [f, v] of Object.entries(values)) i.fields[f as BugField] = v || null;
    },
    async comment(key, text) {
      calls.jira.push(['comment', key, text]);
    },
    async transition(key, to) {
      calls.jira.push(['transition', key, to]);
      issue(key).status = to;
      return `Moved ${key} to ${to}.`;
    },
    async description(key) {
      return issue(key).description;
    },
    async setDescription(key, text) {
      calls.jira.push(['setDescription', key, text]);
      issue(key).description = text;
    },
    // Fields by name (v1.4): rich text unless the name says Points; empty until set.
    async field(key, field) {
      const i = issue(key);
      const extra = (i as { extra?: Record<string, unknown> }).extra ?? {};
      const value = extra[field] ?? null;
      return { id: field, name: field, empty: value === null || value === '', rich: !/points/i.test(field), editable: field !== 'Locked', value, text: typeof value === 'string' ? value : JSON.stringify(value) };
    },
    async setField(key, id, value) {
      calls.jira.push(['setField', key, id, value]);
      const i = issue(key) as { extra?: Record<string, unknown> };
      (i.extra ??= {})[id] = value;
    },
  };
  const pages = new Map<string, { title: string; version: number; text: string; history: string[] }>([['100', { title: 'Provider errors', version: 3, text: 'v3', history: ['v1', 'v2', 'v3'] }]]);
  const confluence: ConfluenceBackend = {
    async search(cql) {
      calls.confluence.push(['search', cql]);
      return '100  SHOP  Provider errors';
    },
    async get(pageId) {
      const p = pages.get(pageId)!;
      return { title: p.title, version: p.version, text: p.text };
    },
    async create(space, title) {
      calls.confluence.push(['create', space, title]);
      return '200';
    },
    async update(pageId, title, body) {
      calls.confluence.push(['update', pageId, body]);
      const p = pages.get(pageId)!;
      p.version += 1;
      p.text = body;
      p.history.push(body);
      return p.version;
    },
    async restore(pageId, version) {
      calls.confluence.push(['restore', pageId, version]);
      const p = pages.get(pageId)!;
      p.version += 1;
      p.text = p.history[version - 1]!;
      return p.version;
    },
  };
  return {
    calls,
    kubeAnswers,
    awsAnswers,
    ghAnswers,
    issues,
    kubectl: async (args, kubeconfig) => {
      calls.kubectl.push({ args, kubeconfig });
      return answer(kubeAnswers, args, ok(''));
    },
    aws: async (args) => {
      calls.aws.push(args);
      return answer(awsAnswers, args, ok('{}'));
    },
    gh: async (args) => {
      calls.gh.push(args);
      return answer(ghAnswers, args, ok(''));
    },
    jira,
    confluence,
    logs: async (query) => {
      calls.logs.push(query);
      return '2026-10-11T10:00:00Z {"message":"401 from webhook"}';
    },
  };
}

/** A deployment as kubectl get -o json prints it. */
export const deploymentJson = (name: string, image: string, o: { replicas?: number; revision?: string; namespace?: string } = {}): ExecResult =>
  ok(
    JSON.stringify({
      kind: 'Deployment',
      metadata: { name, namespace: o.namespace ?? 'shop-dev', labels: { app: name }, annotations: { 'deployment.kubernetes.io/revision': o.revision ?? '7' } },
      spec: { replicas: o.replicas ?? 1, template: { spec: { containers: [{ name, image }] } } },
    }),
  );
