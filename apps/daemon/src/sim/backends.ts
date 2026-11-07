// Simulated backends for the capability proxies: what Jira, GitHub, the clusters, AWS and Coralogix would answer, made
// up, so simulate mode runs the real tier policy (grants, batching, records, Undo, Elfoqsy's lines) and reaches
// nothing. A PR it opens or marks ready shows on the map as the GitHub poller would report it.
import type { EventLog } from '../eventLog';
import type { ProxyBackends } from '../permissions';
import type { BugField, ConfluenceBackend, JiraBackend } from '../permissions/jira';
import type { ExecResult } from '../permissions/types';

const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '' });
const SIM_ME = 'sim-alex';

export function simBackends(log: EventLog): ProxyBackends {
  let nextPr = 901;
  const prs = new Map<string, { repo: string; number: number; branch: string; ticket: string }>();
  const images = new Map<string, string>([['shop-api', 'shop-api:2.21.3']]);
  const issues = new Map<string, { fields: Record<BugField, string | null>; links: Array<{ id: string; url: string; title: string }>; description: string; status: string }>();
  const issue = (key: string) => {
    if (!issues.has(key)) issues.set(key, { fields: { rootCause: null, solution: null, ac: null }, links: [], description: '', status: 'To do' });
    return issues.get(key)!;
  };
  const value = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shortRepo = (repo: string) => repo.split('/')[1] ?? repo;

  const fields = new Map<string, unknown>();
  const jira: JiraBackend = {
    get: async (key) => ({ key, text: `${key}  Bug  ${issue(key).status}\n(simulated)`, status: issue(key).status, assigneeAccountId: SIM_ME }),
    search: async () => '(simulated search: no Jira is reached)',
    myAccountId: async () => SIM_ME,
    remoteLinks: async (key) => [...issue(key).links],
    addRemoteLink: async (key, url, title) => {
      const i = issue(key);
      if (!i.links.some((l) => l.url === url)) i.links.push({ id: String(i.links.length + 1), url, title });
    },
    deleteRemoteLink: async (key, id) => {
      const i = issue(key);
      i.links = i.links.filter((l) => l.id !== id);
    },
    bugFields: async (key) => ({ ...issue(key).fields }),
    setBugFields: async (key, values) => {
      for (const [f, v] of Object.entries(values)) issue(key).fields[f as BugField] = v || null;
    },
    comment: async () => undefined,
    transition: async (key, to) => ((issue(key).status = to), `Moved ${key} to ${to}.`),
    description: async (key) => issue(key).description,
    setDescription: async (key, text) => void (issue(key).description = text),
    field: async (key, field) => {
      const value = (fields.get(`${key}/${field}`) ?? null) as unknown;
      return { id: field, name: field, empty: value === null, rich: true, editable: true, value, text: value === null ? '' : JSON.stringify(value) };
    },
    setField: async (key, id, value) => void fields.set(`${key}/${id}`, value),
  };
  const confluence: ConfluenceBackend = {
    search: async () => '(simulated search: no Confluence is reached)',
    get: async (pageId) => ({ title: `Page ${pageId}`, version: 1, text: '(simulated)' }),
    create: async () => '9001',
    update: async () => 2,
    restore: async () => 3,
  };

  return {
    kubectl: async (args) => {
      const deployment = args.find((a) => a.startsWith('deployment/'))?.slice('deployment/'.length);
      if (args.includes('get') && args.includes('json') && deployment) {
        return ok(JSON.stringify({ kind: 'Deployment', metadata: { name: deployment, namespace: 'shop-dev', annotations: { 'deployment.kubernetes.io/revision': '12' } }, spec: { replicas: 1, template: { spec: { containers: [{ name: deployment, image: images.get(deployment) ?? `${deployment}:2.21.0` }] } } } }));
      }
      const set = args.indexOf('image');
      if (set >= 0 && deployment) {
        for (const pair of args.slice(set + 2)) if (pair.includes('=')) images.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
        return ok(`deployment.apps/${deployment} image updated`);
      }
      if (args.includes('get')) return ok('NAME              READY   STATUS    RESTARTS   AGE\nshop-api-7f9c-x2k 1/1     Running   0          3h');
      return ok('(simulated)');
    },
    aws: async () => ok('{"Account":"111111111111","Arn":"arn:aws:sts::111111111111:assumed-role/simulated"}'),
    gh: async (args) => {
      const [group, verb] = args;
      const repo = value(args, '--repo') ?? '';
      if (group === 'pr' && verb === 'create') {
        const branch = value(args, '--head') ?? '';
        const ticket = /([A-Z][A-Z0-9]+-\d+)/.exec(branch)?.[1] ?? '';
        const number = nextPr++;
        prs.set(`${repo}#${number}`, { repo, number, branch, ticket });
        log.append('github', 'pr.synced', { pr: { repo: shortRepo(repo), number, state: 'draft', ticket, url: '', checks: 'pending' } });
        return ok(`https://github.com/${repo}/pull/${number}\n`);
      }
      if (group === 'pr' && verb === 'ready') {
        const pr = prs.get(`${repo}#${args[2]}`);
        if (pr) log.append('github', 'pr.synced', { pr: { repo: shortRepo(repo), number: pr.number, state: args.includes('--undo') ? 'draft' : 'open', ticket: pr.ticket, url: '', checks: 'pending' } });
        return ok(`✓ Pull request ${repo}#${args[2]} is marked as ${args.includes('--undo') ? 'draft' : '"ready for review"'}`);
      }
      if (group === 'pr' && verb === 'view' && args.includes('headRefName')) {
        const pr = prs.get(`${repo}#${args[2]}`);
        return ok(JSON.stringify({ headRefName: pr?.branch ?? '' }));
      }
      return ok('(simulated)');
    },
    jira,
    confluence,
    logs: async () => '2026-10-11T09:58:12Z {"level":"warn","message":"401 from webhook target"} (simulated)',
  };
}
