// An orchestrator on a real git world and a fake SDK, with fake proxy backends: what a test needs when it wants to start
// runs, read as Elfoqsy, or look at folders, without any of the larger scenarios' machinery. Nothing leaves the test.
import { Mirrors } from '../../src/agents/mirrors';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Git } from '../../src/agents/git';
import { Orchestrator, type OrchestratorDeps } from '../../src/agents/orchestrator';
import { UsageState } from '../../src/claude/usage';
import { LiveState } from '../../src/elfoqsy/liveState';
import { EventLog } from '../../src/eventLog';
import { Kubeconfigs } from '../../src/permissions/kubeconfig';
import { runContexts } from '../../src/permissions/environments';
import { ManualClock, fakeSdk } from './fakeSdk';
import { gitEnv, gitWorld, type GitWorld } from './realGit';
import { environments, fakeBackends, type FakeBackends } from './proxyFakes';

export const SHOP_API = 'acme/shop-api';
export const T0 = Date.parse('2026-10-18T08:00:00Z');

export interface OrchestratorWorld {
  world: GitWorld;
  clock: ManualClock;
  log: EventLog;
  live: LiveState;
  usage: UsageState;
  backends: FakeBackends;
  sdk: ReturnType<typeof fakeSdk>;
  orchestrator: Orchestrator;
  /** How many times her kubeconfig's source was read. */
  kubeconfigReads: () => number;
  close(): Promise<void>;
}

export function orchestratorWorld(
  o: {
    kubeconfig?: string;
    worktreesRoot?: (world: GitWorld) => string;
    /** Ticket folders under the world's root (~/tickets): a ticket run then holds its own. */
    tickets?: boolean;
    /** Changes the fake backends before the orchestrator takes them (a backend that never answers, say). */
    prepare?: (backends: FakeBackends) => void;
    overrides?: Partial<OrchestratorDeps>;
  } = {},
): OrchestratorWorld {
  const world = gitWorld();
  const worktrees = o.worktreesRoot?.(world) ?? world.worktrees;
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(join(world.root, 'runs'), { recursive: true });
  const clock = new ManualClock(T0);
  const log = new EventLog(':memory:', () => new Date(clock.now));
  const live = new LiveState(log);
  const usage = new UsageState(log, clock, () => clock.now);
  const backends = fakeBackends();
  o.prepare?.(backends);
  const sdk = fakeSdk();
  let reads = 0;
  const orchestrator = new Orchestrator({
    log,
    live,
    usage,
    git: new Git(undefined, gitEnv),
    environments,
    backends,
    queryFn: sdk.queryFn,
    ...(o.kubeconfig !== undefined ? { kubeconfigs: new Kubeconfigs(join(world.root, 'runs'), async () => (reads++, o.kubeconfig!), runContexts(environments)) } : {}),
    config: {
      GITHUB_REPOS: [SHOP_API],
      MAX_PARALLEL_AGENTS: 6,
      AGENT_MAX_MINUTES: 45,
      AGENT_MAX_TOKENS: 3_000_000,
      AGENT_HEARTBEAT_MINUTES: 5,
      TICKET_AGENT_MODEL: 'claude-opus-5-5',
      TICKET_AGENT_EFFORT: 'xhigh',
      SUBAGENT_MODELS: ['claude-haiku-5-5'],
      SUBAGENT_EFFORTS: ['low'],
      MAX_PARALLEL_SUBAGENTS: 4,
      USAGE_WARN_FIVE_HOUR: 60,
      USAGE_WARN_SEVEN_DAY: 80,
      worktreesRoot: worktrees,
      agentCacheDir: join(dirname(worktrees), 'cache'),
    },
    policies: {},
    clones: new Map([[SHOP_API, world.clone]]),
    mirrors: new Mirrors(new Git(undefined, gitEnv), join(dirname(worktrees), 'mirrors'), { runsRoot: worktrees, warn: () => undefined }),
    baseEnv: { HOME: '/home/alex', PATH: '/usr/bin' },
    hosts: { jira: ['acme.atlassian.net'], github: ['github.com'], registry: ['registry.npmjs.org'] },
    protectedPaths: [world.reposRoot],
    home: world.root,
    ...(o.tickets ? { tickets: { root: join(world.root, 'tickets') } } : {}),
    clock,
    now: () => clock.now,
    ...o.overrides,
  });
  return {
    world,
    clock,
    log,
    live,
    usage,
    backends,
    sdk,
    orchestrator,
    kubeconfigReads: () => reads,
    close: async () => {
      await orchestrator.close();
      usage.close();
      live.close();
      log.close();
      world.cleanup();
    },
  };
}
