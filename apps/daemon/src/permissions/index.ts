// The capability proxies, put together: one handler per proxy over its backend (live, simulated or a test's fake).
import type { Approvals } from '../agents/approvals';
import type { EventLog } from '../eventLog';
import { AwsProxy, type AwsCli } from './aws';
import { DockerProxy, type DockerBackend } from './docker';
import { ShopProxy, type ShopBackend } from './shop';
import type { AwsSession } from './awsSession';
import type { Environments } from './environments';
import { GhProxy, type GhCli } from './gh';
import type { Grants } from './grants';
import { ConfluenceProxy, JiraProxy, type ConfluenceBackend, type JiraBackend } from './jira';
import { KubeProxy, type Kubectl } from './kube';
import { LogsProxy, type LogsQuery } from './logs';
import { Proxies, type ProxiesDeps } from './proxy';
import type { ProxyHandler, RunRef } from './types';

export interface ProxyBackends {
  kubectl: Kubectl;
  aws: AwsCli;
  gh: GhCli;
  jira?: JiraBackend;
  confluence?: ConfluenceBackend;
  /** Absent without CORALOGIX_API_KEY: the logs proxy says it is not configured. */
  logs?: LogsQuery;
  docker?: DockerBackend;
  /** shop.sh, from alex's shop-local-deploy (source), with what the script needs of the daemon's environment. */
  shop?: { backend: ShopBackend; source?: string; env: Record<string, string> };
}

export interface CreateProxies {
  log: EventLog;
  approvals: Approvals;
  grants: Grants;
  environments: Environments;
  backends: ProxyBackends;
  /** Repositories gh may write to (GITHUB_REPOS). */
  repos: string[];
  aws?: AwsSession;
  say: (run: RunRef, text: string) => void;
  endedRun?: ProxiesDeps['endedRun'];
  firstResponder?: ProxiesDeps['firstResponder'];
  afterWrite?: ProxiesDeps['afterWrite'];
  now?: () => number;
}

/** The head branch of a PR, read with gh, so only the run's own PR is linked in Jira at once. */
const prHead = (gh: GhCli) => async (repo: string, number: number): Promise<string | null> => {
  const r = await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefName']);
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.stdout) as { headRefName?: string }).headRefName ?? null;
  } catch {
    return null;
  }
};

export function createProxies(o: CreateProxies): Proxies {
  const b = o.backends;
  const handlers: Array<ProxyHandler<never>> = [
    new KubeProxy(o.environments, b.kubectl),
    new AwsProxy(o.environments, b.aws),
    new GhProxy({ repos: o.repos }, b.gh),
    new LogsProxy(o.environments, b.logs, o.now),
    ...(b.docker ? [new DockerProxy(o.environments, b.docker)] : []),
    ...(b.shop ? [new ShopProxy(o.environments, b.shop.source, b.shop.backend, b.kubectl, b.shop.env)] : []),
    ...(b.jira ? [new JiraProxy(b.jira, prHead(b.gh))] : []),
    ...(b.confluence ? [new ConfluenceProxy(b.confluence)] : []),
  ] as unknown as Array<ProxyHandler<never>>;
  return new Proxies({
    log: o.log,
    approvals: o.approvals,
    grants: o.grants,
    handlers,
    say: o.say,
    ...(o.aws ? { aws: o.aws } : {}),
    ...(o.endedRun ? { endedRun: o.endedRun } : {}),
    ...(o.firstResponder ? { firstResponder: o.firstResponder } : {}),
    ...(o.afterWrite ? { afterWrite: o.afterWrite } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}

export { Proxies };
