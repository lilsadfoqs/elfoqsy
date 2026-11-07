import { execFileSync } from 'node:child_process';
import { Mirrors } from '../src/agents/mirrors';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanUseTool, HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, EventType, PayloadOf, Ticket } from '@elfoqsy/contracts';
import { Git, TRAILER, agentGitEnv } from '../src/agents/git';
import { Orchestrator, type OrchestratorDeps } from '../src/agents/orchestrator';
import { runPrompt } from '../src/agents/prompt';
import { endStateFor, runsExactly } from '../src/agents/run';
import type { RepoPolicy } from '../src/agents/repoPolicy';
import { UsageState } from '../src/claude/usage';
import { LiveState } from '../src/elfoqsy/liveState';
import { language } from '../src/elfoqsy/voice';
import { EventLog } from '../src/eventLog';
import type { CommitCi } from '../src/github/gh';
import { ManualClock, cutShort, fakeSdk, rateLimit, result, runTool, text, tick } from './helpers/fakeSdk';
import { gitEnv, gitWorld, type GitWorld } from './helpers/realGit';
import { environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const T0 = Date.parse('2026-10-09T08:00:00Z');

const ticket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  board: key.split('-')[0]!,
  summary: `Summary of ${key}`,
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 2,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 1,
  epic: null,
  reporter: 'Quinn Bauer',
  created: '8 Oct 2026',
  updated: '8 Oct 2026',
  labels: [],
  linked: [],
  description: 'Lift error_code from details.',
  ...overrides,
});

const apiPolicy: RepoPolicy = {
  needs: [],
  setup: ['npm install --no-save'],
  unitTests: ['npm run test:unit'],
  allowedTestCommands: ['npm run test:unit', 'JEST_TIERS=unit npx jest'],
  testsIn: 'local',
  notes: 'Only the unit tier runs in-process.',
};

let world: GitWorld;
let log: EventLog;
let live: LiveState;
let usage: UsageState;
let clock: ManualClock;
let sdk: ReturnType<typeof fakeSdk>;
let backends: FakeBackends;
let orchestrator: Orchestrator;
let deps: OrchestratorDeps;

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const checks = () => payloads('run.check_changed').map((c) => [c.checkId, c.status]);

/** A commit on the run branch in a run clone, pushed to the bare remote as the orchestrator would after approval. */
function commitAndPush(clone: string, file: string): string {
  const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
  writeFileSync(join(clone, file), `${file}\n`);
  execFileSync('git', ['add', '.'], { cwd: clone, env });
  execFileSync('git', ['commit', '--quiet', '-m', file], { cwd: clone, env });
  execFileSync('git', ['push', '--quiet', 'origin', 'feature/SHOP-3546'], { cwd: clone, env: gitEnv });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
}

function build(overrides: Partial<OrchestratorDeps> = {}) {
  deps = {
    log,
    live,
    usage,
    git: new Git(undefined, gitEnv),
    environments,
    backends,
    queryFn: sdk.queryFn,
    config: {
      GITHUB_REPOS: [SHOP_API, 'acme/shop-infra'],
      MAX_PARALLEL_AGENTS: 3,
      AGENT_MAX_MINUTES: 45,
      AGENT_MAX_TOKENS: 3_000_000,
      AGENT_HEARTBEAT_MINUTES: 5,
      TICKET_AGENT_MODEL: 'claude-opus-5-5',
      TICKET_AGENT_EFFORT: 'xhigh',
      SUBAGENT_MODELS: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
      SUBAGENT_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
      MAX_PARALLEL_SUBAGENTS: 4,
      USAGE_WARN_FIVE_HOUR: 60,
      USAGE_WARN_SEVEN_DAY: 80,
      worktreesRoot: world.worktrees,
      agentCacheDir: join(dirname(world.worktrees), 'cache'),
    },
    policies: { [SHOP_API]: apiPolicy },
    clones: new Map([[SHOP_API, world.clone]]),
    mirrors: new Mirrors(new Git(undefined, gitEnv), join(dirname(world.worktrees), 'mirrors'), { runsRoot: world.worktrees, warn: () => undefined }),
    baseEnv: { HOME: '/home/alex', PATH: '/usr/bin' },
    hosts: { jira: ['acme.atlassian.net'], github: ['github.com'], registry: ['registry.npmjs.org'] },
    protectedPaths: [world.reposRoot],
    home: world.root, // the test's own folder plays alex's home
    clock,
    now: () => clock.now,
    ...overrides,
  };
  orchestrator = new Orchestrator(deps);
}

beforeEach(() => {
  world = gitWorld();
  clock = new ManualClock(T0);
  // One clock for the log and the runs, so commit times can be told against both.
  log = new EventLog(':memory:', () => new Date(clock.now));
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546', { linked: ['CORE-18891'] }) });
  log.append('jira', 'ticket.synced', { ticket: ticket('CORE-18891', { board: 'CORE' }) });
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3490', { status: 'Done' }) });
  live = new LiveState(log);
  usage = new UsageState(log, clock, () => clock.now);
  sdk = fakeSdk();
  backends = fakeBackends();
  build();
});

afterEach(async () => {
  language.current = 'en';
  await orchestrator.close();
  usage.close();
  live.close();
  log.close();
  world.cleanup();
});

async function spawn() {
  const r = await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
  if (!('runId' in r)) throw new Error(JSON.stringify(r));
  await tick();
  return { ...r, session: sdk.sessions.at(-1)!, runRoot: payloads('run.created').at(-1)!.worktree };
}

/** Waits until `ready` holds, for work that takes as long as git takes (a busy disk makes it slow). */
async function until(ready: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await tick(20);
  await tick(20); // and what follows it in the same read, such as scheduling the next one
}
const lastCheck = () => payloads('run.check_changed').at(-1);

/** The verdict that lets an agent change code (v1.2): a bug, its reported symptom quoted and reproduced, its input classes declared. */
async function canChangeCode(session: { options: Parameters<typeof runTool>[0] }): Promise<void> {
  await runTool(session.options, 'report_understanding', { claim: 'Lift error_code from details', input: 'a result with error_code in details', actual: 'error_code stays nested', expected: 'error_code at the top', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] });
  await runTool(session.options, 'report_verdict', {
    siblingAt: { kind: 'code', ref: 'shop-api/src/map.ts:31' },
    chain: [{ ref: 'shop-api/src/map.ts:44', role: 'fault' }],
    verdict: 'VALID',
    reproduced: true,
    summary: 'error_code stays in details, so the platform never sees it.',
    symptom: 'Lift error_code from details',
    sibling: 'The warning path in the same mapper lifts it; the error path does not.',
    findings: [{ text: 'A new test fails: error_code is missing at the top.', sources: [{ kind: 'code', ref: 'shop-api/test/map.test.ts:12' }] }],
  });
  await runTool(session.options, 'declare_inputs', { classes: ['a result with error_code in details', 'a result without error_code'] });
}

/** And the one fresh review before the first push. */
async function canPush(session: Parameters<typeof hook>[0] & { options: Parameters<typeof runTool>[0] }): Promise<void> {
  await canChangeCode(session);
  await hook(session, 'SubagentStart')({ agent_id: 'review-1', agent_type: 'reviewer' });
  await hook(session, 'SubagentStop')({ agent_id: 'review-1', agent_type: 'reviewer', last_assistant_message: 'No Blocker or Major.\nCONTRACT: none\nCACHE_BYPASS: none\nCRITERIA: none stated\nRESULT: success', stop_hook_active: false });
}

const hook = (session: { options: { hooks?: Record<string, Array<{ hooks: HookCallback[] }>> } }, name: string) =>
  (input: Record<string, unknown>) =>
    session.options.hooks![name]![0]!.hooks[0]!({ hook_event_name: name, session_id: 's', transcript_path: '', ...input } as unknown as HookInput, undefined, { signal: new AbortController().signal });

const decision = async (session: Parameters<typeof hook>[0], tool_name: string, tool_input: Record<string, unknown>, cwd: string, id = 't1') =>
  ((await hook(session, 'PreToolUse')({ tool_name, tool_input, tool_use_id: id, cwd })) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
    .permissionDecision;

describe('the end state: the agent’s own checks, proven', () => {
  const check = (id: string, status: 'pending' | 'passed' | 'failed', proof: 'command' | 'ci' | 'approval' = 'command') =>
    ({ check: { id, description: `${id} passes`, proof, ...(proof === 'command' ? { command: `npm run ${id}` } : {}) }, status }) as const;
  const report = (result: 'succeeded' | 'failed' | 'blocked', summary = 'Lifted error_code') => ({ result, summary }) as const;

  it.each([
    ['every check proven', [check('unit', 'passed'), check('ci', 'passed', 'ci')], report('succeeded'), 'succeeded', 'Lifted error_code. All 2 checks have passing evidence.'],
    ['proven, with no report', [check('unit', 'passed')], undefined, 'succeeded', 'Last words. All 1 check have passing evidence.'],
    ['a check without evidence', [check('unit', 'passed'), check('ci', 'pending', 'ci')], report('succeeded'), 'stopped', 'Lifted error_code. Not counted as succeeded: "ci passes" (no evidence yet).'],
    ['a failed check', [check('unit', 'failed'), check('page', 'pending', 'approval')], report('succeeded'), 'stopped', 'Lifted error_code. Not counted as succeeded: "unit passes" (failed), "page passes" (no evidence yet).'],
    ['no plan', undefined, report('succeeded'), 'stopped', 'Lifted error_code. No plan was declared, so nothing proves the ticket done.'],
    ['the agent failed', [check('unit', 'passed')], report('failed', 'Could not reproduce it.'), 'failed', 'Could not reproduce it.'],
    ['the agent is blocked', [check('unit', 'passed')], report('blocked', 'Needs protoc'), 'stopped', 'Needs protoc.'],
  ] as const)('%s', (_name, checks, r, state, reason) => {
    expect(endStateFor(checks ? checks.map((c) => ({ ...c, check: { ...c.check } })) : undefined, r, 'Last words')).toEqual({ state, reason });
  });

  it('adds no full stop after an ellipsis', () => {
    expect(endStateFor(undefined, undefined, 'A long line cut short…').reason).toBe('A long line cut short… No plan was declared, so nothing proves the ticket done.');
  });

  it.each([
    ['npm run test:unit', 'npm run test:unit', true],
    ['  npm   run test:unit ', 'npm run test:unit', true],
    ['cd shop-api && npm run test:unit', 'npm run test:unit', true],
    ['cd shop-api && npm run test:unit', 'cd shop-api && npm run test:unit', true],
    ['npm run test:unit 2>&1 | tail -20', 'npm run test:unit', false],
    ['npm run test:unit -- src/one.spec.ts', 'npm run test:unit', false],
    ['npm run test:unit; true', 'npm run test:unit', false],
    ['cd $(mktemp -d) && npm run test:unit', 'npm run test:unit', false],
    ['', '', false],
  ])('counts %j as running %j exactly: %s', (command, declared, expected) => {
    expect(runsExactly(command, declared)).toBe(expected);
  });
});

describe('spawn_agent: who may start', () => {
  it('refuses unknown or closed tickets, and needs to know the repositories', async () => {
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-1' })).toMatchObject({ error: 'unknown_ticket' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3490' })).toMatchObject({ error: 'ticket_closed' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546' })).toMatchObject({ error: 'repo_needed', message: expect.stringContaining(SHOP_API) });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: ['someone/else'] })).toMatchObject({ error: 'unknown_repo' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: ['acme/shop-infra'] })).toMatchObject({ error: 'repo_missing' });
    expect(sdk.queryFn).not.toHaveBeenCalled();
  });

  it('starts from a brief only when it is that ticket’s, and hands the brief over as its first instruction', async () => {
    const sections = [
      { heading: 'Goal', markdown: 'Provider errors reach checkout.' },
      { heading: 'Done when', markdown: '- `npm run test:fast` passes.' },
    ];
    log.append('elfoqsy', 'brief.created', { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-3546', title: 'Surface provider errors', sections });
    log.append('elfoqsy', 'brief.created', { briefId: 'b2', conversationId: 'c1', ticket: 'SHOP-2091', title: 'Other', sections });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], briefId: 'nope' })).toMatchObject({ error: 'unknown_brief' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], briefId: 'b2' })).toMatchObject({ error: 'wrong_brief' });
    const r = await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], briefId: 'b1', conversationId: 'c1' });
    expect(r).toMatchObject({ agentNumber: 1 });
    await tick();
    expect(payloads('brief.handed_off')).toEqual([{ briefId: 'b1', runId: (r as { runId: string }).runId }]);
    const first = sdk.sessions.at(-1)!.sent[0]!;
    expect(first).toContain('## The brief\nalex and Elfoqsy agreed on this plan for the ticket. Work from it: declare your goal and checks from its "Done when"');
    expect(first).toContain('### Surface provider errors\n\n#### Goal\n\nProvider errors reach checkout.\n\n#### Done when\n\n- `npm run test:fast` passes.');
  });

  it('uses the repositories of the ticket’s open PRs when none are named', async () => {
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 7, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'none' } });
    expect(await orchestrator.spawn({ ticketKey: 'shop-3546' })).toMatchObject({ agentNumber: 1 });
  });

  it('starts exactly one agent per ticket, and respects the cap', async () => {
    await spawn();
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ error: 'already_running' });
    await orchestrator.close();
    build({ config: { ...deps.config, MAX_PARALLEL_AGENTS: 1 } });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3547') });
    await orchestrator.spawn({ ticketKey: 'SHOP-3547', repos: [SHOP_API] });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3548') });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3548', repos: [SHOP_API] })).toMatchObject({ error: 'cap_reached' });
  });

  it('starts at once when the plan’s usage is high, and says so as information: nothing to confirm', async () => {
    usage.observe({ status: 'allowed', utilization: 0.72, rateLimitType: 'five_hour', resetsAt: T0 / 1000 + 3600 });
    const started = await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
    expect(started).toMatchObject({ agentNumber: 1, notice: { kind: 'usage_high', message: expect.stringContaining('72% of the 5-hour limit') } });
    expect(started).not.toHaveProperty('warning');
    expect(sdk.queryFn).toHaveBeenCalled();
    expect(payloads('approval.requested')).toEqual([]);
  });

  it('says nothing about usage when it is not high', async () => {
    usage.observe({ status: 'allowed', utilization: 0.2, rateLimitType: 'five_hour', resetsAt: T0 / 1000 + 3600 });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).not.toHaveProperty('notice');
  });

  it('never waits for Claude’s answer about usage: it reads the last figure, and refreshes it for next time', async () => {
    let answer: (v: { sevenDay: { utilization: number }; fiveHour: { utilization: number }; at: number }) => void = () => undefined;
    const slow = new Promise<{ sevenDay: { utilization: number }; fiveHour: { utilization: number }; at: number }>((resolve) => (answer = resolve));
    build({ usageProbe: () => slow });
    // The probe has not answered, and the agent starts all the same, with no figure to report yet.
    const first = await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
    expect(first).toMatchObject({ agentNumber: 1 });
    expect(first).not.toHaveProperty('notice');
    // What the probe says later is kept and published for the left screen's meters, and the next start reports it.
    answer({ sevenDay: { utilization: 85 }, fiveHour: { utilization: 10 }, at: T0 });
    await tick();
    expect(payloads('usage.status')).toEqual([{ fiveHourPct: 10, sevenDayPct: 85 }]);
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3547') });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3547', repos: [SHOP_API] })).toMatchObject({ notice: { message: expect.stringContaining('85% of the weekly limit') } });
  });

  it('keeps the last figure when the probe fails, and counts a rate-limit warning as high usage', async () => {
    usage.record({ sevenDay: { utilization: 85 }, fiveHour: { utilization: 10 }, at: T0 });
    build({ usageProbe: async () => Promise.reject(new Error('not supported')) });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ notice: { message: expect.stringContaining('85% of the weekly limit') } });
    usage.observe({ status: 'allowed_warning', rateLimitType: 'five_hour' });
    expect(usage.latest?.status).toBe('allowed_warning');
  });

  it('does not start while Claude is paused for a usage limit that is already reached', async () => {
    usage.limit('limit', 'five_hour', T0 + 3_600_000);
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ error: 'paused' });
  });

  it('refuses a branch with unpushed work in Alex’s own clone', async () => {
    world.git(world.clone.path, 'branch', 'feature/SHOP-3546');
    world.git(world.clone.path, 'switch', '--quiet', 'feature/SHOP-3546');
    writeFileSync(join(world.clone.path, 'wip.txt'), 'wip');
    world.git(world.clone.path, 'add', '.');
    world.git(world.clone.path, 'commit', '--quiet', '-m', 'wip');
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ error: 'branch_busy' });
  });

  it('starts when the branch in Alex’s own clone only points at a commit GitHub has, as SHOP-1164’s did', async () => {
    world.git(world.clone.path, 'branch', 'feature/SHOP-3546'); // at master, which GitHub has
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ agentNumber: 1 });
  });
});

/** A commit in a run's clone, dated: who made it is told by when. Returns its short sha. */
function commitAt(clone: string, file: string, message: string, at: number): string {
  const date = `@${Math.floor(at / 1000)} +0000`;
  const env = { ...process.env, ...agentGitEnv(world.clone.identity), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  writeFileSync(join(clone, file), `${file}\n`);
  execFileSync('git', ['add', '.'], { cwd: clone, env });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: clone, env });
  return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: clone, env }).toString().trim();
}

describe('tester runs and kept work', () => {
  const started = async (args: { test?: boolean; fromRun?: string } = {}) => {
    const r = await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], ...args });
    if (!('runId' in r)) throw new Error(JSON.stringify(r));
    await tick();
    const created = payloads('run.created').at(-1)!;
    return { ...r, root: created.worktree, clone: join(created.worktree, 'shop-api'), session: sdk.sessions.at(-1)! };
  };

  it('removes a tester’s run folder when it ends with nothing but uncommitted changes', async () => {
    const run = await started({ test: true });
    expect(payloads('run.created').at(-1)).toMatchObject({ test: true });
    writeFileSync(join(run.clone, 'wip.ts'), 'wip');
    await orchestrator.cancel(run.runId, 'Test over.');
    expect(existsSync(run.root)).toBe(false);
    expect(payloads('run.state_changed').at(-1)!.reason).toContain('uncommitted changes, removed with the folder. The run folder was removed.');
    expect(payloads('run.folder_removed')).toEqual([{ runId: run.runId, folder: run.root, reason: "A tester's run, with no commits missing from GitHub." }]);
    expect(payloads('memory.saved')).toEqual([]);
  });

  it('says what is kept in Vietnamese, with tôi and cậu, when his latest message was', async () => {
    language.current = 'vi';
    const first = await started({ test: true });
    clock.advance(60_000);
    const kept = commitAt(first.clone, 'provider.ts', 'SHOP-3546: carry provider errors', clock.now);
    writeFileSync(join(first.clone, 'wip.ts'), 'wip');
    await orchestrator.cancel(first.runId, 'Test over.');
    await until(() => payloads('memory.saved').length > 0);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({
      role: 'elfoqsy',
      text: `Agent 1 đã bị hủy, và công việc của nó được giữ lại cho lượt chạy tiếp theo trên SHOP-3546: ${kept} "SHOP-3546: carry provider errors" trên feature/SHOP-3546, chưa có trên GitHub, và các thay đổi chưa commit, trong ${first.root}. Một run mới có thể bắt đầu từ đó; khi push, nó sẽ liệt kê các commit này cho cậu. Các thay đổi chưa commit chỉ nằm trong thư mục đó.`,
    });
    // What she keeps in memory for the model stays as it was written: English.
    expect(payloads('memory.saved').at(-1)!.statement).toContain('Offer it as the starting point of the next run');
  });

  it('keeps a run folder with uncommitted changes when the run is not the tester’s', async () => {
    const run = await started();
    writeFileSync(join(run.clone, 'wip.ts'), 'wip');
    await orchestrator.cancel(run.runId, 'Stop.');
    expect(existsSync(run.root)).toBe(true);
  });

  it('keeps and reports a tester’s run with commits; a new run starts from it, and its push lists what came before and who made it', async () => {
    const first = await started({ test: true });
    const his = commitAt(first.clone, 'note.md', 'A note of his', T0 - 3_600_000); // outside any agent's working time
    clock.advance(60_000);
    const kept = commitAt(first.clone, 'provider.ts', 'SHOP-3546: carry provider errors', clock.now);
    clock.advance(60_000);
    await orchestrator.cancel(first.runId, 'Test over.');
    await until(() => payloads('memory.saved').length > 0);
    expect(existsSync(first.root)).toBe(true);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({
      role: 'elfoqsy',
      text: `Agent 1 was cancelled, and its work is kept for the next run on SHOP-3546: 2 commits, the latest ${kept} "SHOP-3546: carry provider errors" on feature/SHOP-3546, not on GitHub, in ${first.root}. A new run can start from it; its push will list these commits for you.`,
    });
    expect(payloads('memory.saved').at(-1)).toMatchObject({ factId: `kept-${first.runId}`, origin: 'run', statement: expect.stringContaining(`spawn_agent with fromRun ${first.runId}`) });
    expect(await orchestrator.noteKeptWork(first.runId, 'cancelled')).toBe(false); // said once

    clock.advance(60_000);
    const second = await started({ fromRun: first.runId });
    expect(payloads('run.created').at(-1)).toMatchObject({ agentNumber: 2, startedFrom: first.runId });
    expect(execFileSync('git', ['log', '--format=%h', '-2'], { cwd: second.clone }).toString().trim().split('\n')).toEqual([kept, his]);
    expect(payloads('memory.forgotten')).toContainEqual({ factId: `kept-${first.runId}`, by: 'orchestrator' }); // the offer is taken
    expect(second.session.sent[0]).toContain(`  - ${kept} "SHOP-3546: carry provider errors" (Agent 1)\n  - ${his} "A note of his" (alex)`);
    expect(existsSync(first.clone)).toBe(true); // fetched from, never moved

    clock.advance(60_000);
    commitAt(second.clone, 'fix.ts', 'SHOP-3546: test it', clock.now);
    await canPush(second.session);
    await decision(second.session, 'Bash', { command: 'git push' }, second.clone, 'push2');
    // Pushing the run branch is tier 1: done at once, and Elfoqsy's line lists what came before and who made it.
    const pushed = await (second.session.options.canUseTool as CanUseTool)('Bash', { command: 'git push' }, { signal: new AbortController().signal, toolUseID: 'push2', requestId: 'r' });
    expect(pushed).toMatchObject({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    expect(payloads('approval.requested')).toEqual([]);
    expect(payloads('elfoqsy.message').at(-1)!.text).toBe(
      `Agent 2 pushed feature/SHOP-3546 to shop-api (3 commits; 2 of them made before this run: ${kept} "SHOP-3546: carry provider errors" (Agent 1); ${his} "A note of his" (alex)).`,
    );
    expect(world.git(world.remote, 'log', '--format=%s', '-1', 'feature/SHOP-3546')).toBe('SHOP-3546: test it');
  });

  it('pushes alex’s own commit from a kept folder untouched; only the agent’s carries Elfoqsy’s line', async () => {
    const first = await started();
    clock.advance(60_000);
    const agents = commitAt(first.clone, 'provider.ts', 'SHOP-3546: carry provider errors', clock.now); // while Agent 1 works
    clock.advance(60_000);
    await orchestrator.cancel(first.runId, 'Stop.');
    await until(() => payloads('memory.saved').length > 0); // kept: a commit GitHub lacks
    clock.advance(60_000);
    const mineMessage = "A note of his\n\nCo-Authored-By: alex' Claude <noreply@anthropic.com>";
    const mine = commitAt(first.clone, 'note.md', mineMessage, clock.now); // his, in the kept folder, after the run
    const mineFull = world.git(first.clone, 'rev-parse', 'HEAD');
    expect(world.git(first.clone, 'log', '--format=%B', '-2')).toBe(`${mineMessage}\n\nSHOP-3546: carry provider errors\n\n${TRAILER}`);

    clock.advance(60_000);
    const second = await started({ fromRun: first.runId });
    await canPush(second.session);
    await decision(second.session, 'Bash', { command: 'git push' }, second.clone, 'push2');
    const pushed = await (second.session.options.canUseTool as CanUseTool)('Bash', { command: 'git push' }, { signal: new AbortController().signal, toolUseID: 'push2', requestId: 'r' });
    // Not refused: his commit's own co-author line is his business.
    expect(pushed).toEqual({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    expect(payloads('elfoqsy.message').at(-1)!.text).toBe(
      `Agent 2 pushed feature/SHOP-3546 to shop-api (2 commits; 2 of them made before this run: ${mine} "A note of his" (alex); ${agents} "SHOP-3546: carry provider errors" (Agent 1)).`,
    );
    expect(world.git(world.remote, 'rev-parse', 'feature/SHOP-3546')).toBe(mineFull); // the very commit he made
    expect(world.git(world.remote, 'log', '--format=%B', '-2', 'feature/SHOP-3546')).toBe(`${mineMessage}\n\nSHOP-3546: carry provider errors\n\n${TRAILER}`);
  });

  it('starts from kept work only of an ended run of the same ticket whose folder is there', async () => {
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], fromRun: 'nope' })).toMatchObject({ error: 'unknown_run' });
    log.append('orchestrator', 'run.created', { runId: 'gone', ticket: 'SHOP-3546', worktree: join(world.worktrees, 'gone'), branch: 'feature/SHOP-3546', agentNumber: 7, repos: [SHOP_API] });
    log.append('orchestrator', 'run.state_changed', { runId: 'gone', state: 'cancelled' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], fromRun: 'gone' })).toMatchObject({ error: 'no_kept_work' });
    log.append('orchestrator', 'run.created', { runId: 'other', ticket: 'SHOP-3490', worktree: world.worktrees, branch: 'feature/SHOP-3490', agentNumber: 8, repos: [SHOP_API] });
    log.append('orchestrator', 'run.state_changed', { runId: 'other', state: 'cancelled' });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API], fromRun: 'other' })).toMatchObject({ error: 'wrong_run' });
  });

  it('brings facts about kept work up to date at start, and forgets them when the folder is gone', async () => {
    const run = await started({ test: true });
    commitAt(run.clone, 'provider.ts', 'SHOP-3546: carry provider errors', clock.now);
    await orchestrator.cancel(run.runId, 'Test over.');
    await until(() => payloads('memory.saved').length > 0);
    // The first kind of fact, saved under a fresh id and worded the old way.
    log.append('orchestrator', 'memory.forgotten', { factId: `kept-${run.runId}`, by: 'orchestrator' });
    log.append('orchestrator', 'memory.saved', { factId: 'fact-old', statement: 'Once alex pushes it, a new agent starts from it.', sources: [{ kind: 'ticket', ref: 'SHOP-3546', label: "Agent 1's kept run folder" }], freshUntil: '2036-01-01T00:00:00.000Z', origin: 'run' });
    expect(await orchestrator.refreshKeptWork()).toBe(2);
    expect(payloads('memory.forgotten').at(-1)).toEqual({ factId: 'fact-old', by: 'orchestrator' });
    expect(payloads('memory.saved').at(-1)).toMatchObject({ factId: `kept-${run.runId}`, statement: expect.stringContaining('fromRun') });
    expect(await orchestrator.refreshKeptWork()).toBe(0);
    rmSync(run.root, { recursive: true, force: true });
    expect(await orchestrator.refreshKeptWork()).toBe(1);
    expect(payloads('memory.forgotten').at(-1)).toEqual({ factId: `kept-${run.runId}`, by: 'orchestrator' });
  });

  it('runs the ticket agent on TICKET_AGENT_MODEL and TICKET_AGENT_EFFORT when a probe sets them', async () => {
    await orchestrator.close();
    build({ config: { ...deps.config, TICKET_AGENT_MODEL: 'claude-haiku-5-5', TICKET_AGENT_EFFORT: 'low' } });
    const run = await started();
    expect(run.session.options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(payloads('run.created').at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
  });
});

describe('the ticket agent', () => {
  it('runs Opus 5.5 at xhigh, isolated, sandboxed, without credentials, with 12 named sub-agents and the reviewer', async () => {
    const { session, runRoot } = await spawn();
    const o = session.options;
    expect(o).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { autoMemoryEnabled: false, attribution: { commit: '', pr: '', sessionUrl: false } }, // no co-author line from Claude Code
      cwd: runRoot,
      taskBudget: { total: 3_000_000 },
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
    });
    // The web is the agent's own (v1.3), checked by the gate before a request leaves; never its sub-agents'.
    expect(o.disallowedTools).toBeUndefined();
    expect(Object.keys(o.agents!)).toHaveLength(13);
    // The reviewer reads files and nothing else, by configuration: no shell, no writer (v1.5).
    expect(o.agents!.reviewer).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', tools: ['Read', 'Grep', 'Glob', 'LS'], disallowedTools: expect.arrayContaining(['mcp__run', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'WebFetch']) });
    expect(o.agents!['sonnet-5.5-high']).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', disallowedTools: ['mcp__run', 'Agent', 'Task', 'WebFetch', 'WebSearch'] });
    expect(o.agents!['sonnet-5.5-high']!.tools).toEqual(['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'TodoWrite']);
    // The run's own tools wait as long as alex may take: 72 hours and a margin, before the SDK would end a call.
    expect((o.mcpServers!.run as { instance?: unknown }).instance).toBeDefined();
    expect(o.agents!['haiku-5.5-low']).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(o.sandbox!.filesystem!.denyRead).toEqual(expect.arrayContaining([world.reposRoot, '/home/alex/.ssh'.replace('/home/alex', process.env.HOME!)]));
    const env = o.env!;
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'JIRA_API_TOKEN', 'DBUS_SESSION_BUS_ADDRESS']) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: 'Alex Rivera', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_KEY_0: 'credential.helper' });
    expect(env.GIT_SSH_COMMAND).toContain('Agents cannot reach GitHub');
    // The team-dev skill reads both: which run holds the ticket folder, and the one co-author line.
    expect(env).toMatchObject({ ELFOQSY_RUN_ID: payloads('run.created')[0]!.runId, COAUTHOR_TRAILER: TRAILER });
    // The first turn: the ticket, where the code is, how to test, the sub-agents.
    const prompt = session.sent[0]!;
    expect(prompt).toContain('SHOP-3546');
    expect(prompt).toContain('shop-api/ (acme/shop-api) on branch feature/SHOP-3546');
    expect(prompt).toContain('unit tests: npm run test:unit');
    expect(prompt).toContain('Tests, builds and commits in this folder are free once your verdict allows them');
    expect(prompt).toContain('- In a loop, change directory inside a subshell, `(cd "$d" && …)`, rather than `cd` and `cd ..`, so the gate never has to ask.');
    expect(prompt).toContain('Your verdict comes before any code change, with report_verdict, in the team-dev validity labels.');
    expect(prompt).toContain('Environments: dev: --context dev, namespace shop-dev, --profile dev-shop;');
    expect(prompt).toContain('The only deployments you may change are the test harness (shop-integration-test)');
    expect(prompt).not.toContain('request_pull_request');
    // Its kube and AWS files point where its sandbox cannot reach, so nothing it runs changes alex's own.
    expect(o.sandbox!.filesystem!.denyRead).toEqual(expect.arrayContaining([join(process.env.HOME!, '.aws'), join(process.env.HOME!, '.kube'), join(process.env.HOME!, '.docker')]));
    expect(env).toMatchObject({ KUBECONFIG: expect.stringContaining('.no-cloud'), AWS_CONFIG_FILE: expect.stringContaining('.no-cloud'), AWS_SHARED_CREDENTIALS_FILE: expect.stringContaining('.no-cloud') });
    expect(prompt).toContain('sonnet-5.5-high');
    expect(prompt).toContain('# Notes for agents'); // the repo's CLAUDE.md, as text
    expect(payloads('run.created')[0]).toMatchObject({ ticket: 'SHOP-3546', branch: 'feature/SHOP-3546', agentNumber: 1 });
    expect(payloads('run.state_changed').map((p) => p.state)).toEqual(['queued', 'running']);
  });

  it('gives each run its own temp folder; /tmp is free to read, a file tool in alex’s home is asked, and a shell command there is logged for the sandbox', async () => {
    const { session, runRoot, runId } = await spawn();
    const tmp = join(runRoot, '.tmp');
    expect(runRoot).toBe(join(world.worktrees, `SHOP-3546-${runId.slice(-6).toLowerCase()}`)); // short: the sandbox's sockets live in .tmp
    expect(existsSync(tmp)).toBe(true);
    expect(session.options.env).toMatchObject({ TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    const cwd = join(runRoot, 'shop-api');
    expect(await decision(session, 'Read', { file_path: join(tmp, 'pack.log') }, cwd)).toBe('allow');
    expect(await decision(session, 'Bash', { command: `tail -20 ${tmp}/pack.log` }, cwd)).toBe('allow');
    expect(await decision(session, 'Bash', { command: 'tail -20 "$TMPDIR/pack.log"' }, cwd)).toBe('allow');
    expect(await decision(session, 'Bash', { command: 'tail -20 /tmp/sm-pack-logs/logger.log' }, cwd)).toBe('allow');
    expect(await decision(session, 'Read', { file_path: '/tmp/sm-pack-logs/logger.log' }, cwd)).toBe('allow');
    expect(await decision(session, 'Read', { file_path: join(world.root, 'notes.txt') }, cwd)).toBe('ask');
    // A shell command is inside the sandbox, which decides what it may reach (v1.5): allowed, and its path is logged.
    const outside = `cat ${join(world.root, 'notes.txt')}`;
    expect(await decision(session, 'Bash', { command: outside }, cwd, 'outside-1')).toBe('allow');
    const called = events('tool.called').map((e) => e.payload as { toolUseId?: string; allowed: boolean; outside?: string });
    expect(called.find((c) => c.toolUseId === 'outside-1')).toMatchObject({ allowed: true, outside: expect.stringContaining(join(world.root, 'notes.txt')) });
    // A command that stays in the run folder has nothing to log.
    expect(called.find((c) => c.toolUseId === 't1')).not.toHaveProperty('outside');
    expect(await decision(session, 'Write', { file_path: '/tmp/out.txt', content: 'x' }, cwd)).toBe('ask'); // writing outside the run folder
  });

  it('reads $TMPDIR as its real path: inside the run folder it is allowed, pointed outside it is logged for the sandbox', async () => {
    const { session, runRoot } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    // What Agent 5 ran in the M12 probe, asked then: now its own temp folder is simply allowed.
    const probe = 'mkdir -p "$TMPDIR/provider-check" && cd "$TMPDIR/provider-check" && ls';
    expect(await decision(session, 'Bash', { command: probe }, cwd, 'p1')).toBe('allow');
    expect(await decision(session, 'Bash', { command: 'cd "$TMPDIR/../.." && ls' }, cwd, 'p2')).toBe('allow');
    expect(events('tool.called').find((e) => (e.payload as { toolUseId?: string }).toolUseId === 'p2')?.payload).toMatchObject({ outside: expect.any(String) });
    // A link put in its place: the real path is outside, so the same command is asked.
    const elsewhere = join(world.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    rmSync(join(runRoot, '.tmp'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(runRoot, '.tmp'));
    expect(await decision(session, 'Bash', { command: probe }, cwd, 'p3')).toBe('allow');
    expect(events('tool.called').find((e) => (e.payload as { toolUseId?: string }).toolUseId === 'p3')?.payload).toMatchObject({ outside: expect.stringContaining('elsewhere') });
  });

  it('refuses a run whose temp folder would be too long for the sandbox’s sockets', async () => {
    await orchestrator.close();
    build({ config: { ...deps.config, worktreesRoot: join(world.worktrees, 'x'.repeat(60)) } });
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).toMatchObject({ error: 'setup_failed', message: expect.stringContaining('too long') });
    expect(sdk.queryFn).not.toHaveBeenCalled();
  });

  it('leaves the plan to the agent, and says which repository’s tests cannot run here', () => {
    const prompt = runPrompt({
      ticket: ticket('SHOP-3546'),
      linked: [],
      branch: 'feature/SHOP-3546',
      repos: [{ repo: 'acme/shop-worker', path: '/r/shop-worker', role: 'target', base: 'master' }],
      policies: { 'acme/shop-worker': { ...apiPolicy, testsIn: 'ci', notes: 'protoc is missing here.' } },
      subagents: ['haiku-5.5-low'],
      maxSubagents: 4,
    });
    expect(prompt).toContain("- shop-worker: its tests can't run on this host; CI runs them. Plan around that.");
    expect(prompt).not.toContain('unit tests (run freely)');
    // The goal and what done means are the agent's, and its steps form as it goes; the prompt says how checks are proven.
    expect(prompt).toContain('you do not declare steps in advance');
    expect(prompt).toContain('call declare_goal with your goal and the checks');
    expect(prompt).toContain('Call begin_step whenever the nature of your work changes');
    expect(prompt).toContain('Every 5 minutes of working time, call heartbeat');
    expect(prompt).toContain('The run counts as succeeded only when every check you declared has passing evidence');
    expect(prompt).not.toMatch(/declare_plan|report_step/);
    expect(prompt).not.toMatch(/plan, code, test, pr, ci|Alex/);
  });

  it('gates every call: sub-agents by name and capped, no web, tests free, remote tools only through the proxies', async () => {
    const { session, runRoot } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    expect(await decision(session, 'Agent', { subagent_type: 'sonnet-5.5-high', description: 'Find error_code', prompt: 'x' }, cwd)).toBe('allow');
    expect(await decision(session, 'Agent', { subagent_type: 'general-purpose', description: 'x', prompt: 'x' }, cwd)).toBe('deny');
    expect(await decision(session, 'Agent', { subagent_type: 'opus-5.5-low', model: 'opus', description: 'x', prompt: 'x' }, cwd)).toBe('deny');
    expect(await decision(session, 'WebFetch', { url: 'https://example.com' }, cwd)).toBe('deny');
    expect(await decision(session, 'Bash', { command: 'curl https://example.com' }, cwd)).toBe('deny');
    expect(await decision(session, 'Bash', { command: 'npm run test:unit' }, cwd)).toBe('allow');
    expect(await decision(session, 'Bash', { command: 'npm run test:integration' }, cwd)).toBe('allow');
    expect(await decision(session, 'Bash', { command: 'git push' }, cwd)).toBe('ask'); // the orchestrator pushes it, at once
    expect(await decision(session, 'Bash', { command: 'git push --force' }, cwd)).toBe('deny');
    expect(await decision(session, 'Bash', { command: 'kubectl --context dev-shop get pods' }, cwd)).toBe('deny');
    expect(await decision(session, 'mcp__run__kube', { args: ['--context', 'dev-shop', 'get', 'pods'] }, cwd)).toBe('allow');
    expect(await decision(session, 'Read', { file_path: join(world.reposRoot, 'shop-api', 'README.md') }, cwd)).toBe('deny');
    for (const id of ['a1', 'a2', 'a3', 'a4']) await hook(session, 'SubagentStart')({ agent_id: id, agent_type: 'haiku-5.5-low' });
    expect(await decision(session, 'Agent', { subagent_type: 'haiku-5.5-low', description: 'x', prompt: 'x' }, cwd)).toBe('deny');
    const called = payloads('tool.called');
    expect(called.filter((p) => !p.allowed).map((p) => p.tool)).toEqual(['Agent', 'Agent', 'WebFetch', 'Bash', 'Bash', 'Bash', 'Read', 'Agent']);
  });

  it('keeps a full record of every sub-agent: who started it, model and effort, its tool calls, tokens and result', async () => {
    const { session, runRoot } = await spawn();
    await decision(session, 'Agent', { subagent_type: 'sonnet-5.5-high', description: 'Run the unit tests', prompt: 'x' }, runRoot, 'toolu_agent');
    clock.advance(1_000);
    await hook(session, 'SubagentStart')({ agent_id: 'sa1', agent_type: 'sonnet-5.5-high' });
    session.emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: [], usage: { input_tokens: 9_000, output_tokens: 1_000, cache_creation_input_tokens: 500 } }, uuid: 'u', session_id: 's' } as never);
    await tick(20);
    await hook(session, 'PostToolUseFailure')({ agent_id: 'sa1', tool_name: 'Bash', tool_input: { command: 'npm run test:unit' }, tool_use_id: 'toolu_b', error: 'Exit code 1\n2 failed', cwd: '' });
    clock.advance(42_000);
    await hook(session, 'SubagentStop')({ agent_id: 'sa1', agent_type: 'sonnet-5.5-high', stop_hook_active: false, agent_transcript_path: '', last_assistant_message: 'Two specs fail on undefined error_code.\nRESULT: failure, two specs fail' });
    expect(payloads('subagent.started')).toEqual([
      { runId: expect.any(String), subagentId: 'sa1', parentToolUseId: 'toolu_agent', model: 'claude-sonnet-5-5', effort: 'high', task: 'Run the unit tests' },
    ]);
    expect(payloads('subagent.tool_called')).toEqual([
      { runId: expect.any(String), subagentId: 'sa1', toolUseId: 'toolu_b', tool: 'Bash', inputSummary: 'npm run test:unit', outputSummary: 'Exit code 1\n2 failed', ok: false },
    ]);
    expect(payloads('subagent.finished')).toEqual([
      { runId: expect.any(String), subagentId: 'sa1', outcome: 'failed', result: 'Two specs fail on undefined error_code.', tokens: 10_500, toolCalls: 1, durationMs: 42_000 },
    ]);
  });

  it('cancels the sub-agents still running when the run ends, and says so in their records', async () => {
    const { runId, session, runRoot } = await spawn();
    await decision(session, 'Agent', { subagent_type: 'haiku-5.5-low', description: 'Search for error_code', prompt: 'x' }, runRoot, 'toolu_a');
    await hook(session, 'SubagentStart')({ agent_id: 'sa9', agent_type: 'haiku-5.5-low' });
    await orchestrator.cancel(runId, 'Not needed');
    expect(payloads('subagent.finished')).toEqual([
      { runId, subagentId: 'sa9', outcome: 'cancelled', by: 'orchestrator', reason: 'The run ended.', result: '', tokens: 0, toolCalls: 0, durationMs: 0 },
    ]);
  });

  it('writes its own tool calls into its transcript in plain words, with how each one ended', async () => {
    const { session, runRoot } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    await decision(session, 'Bash', { command: 'npm run test:unit' }, cwd, 'toolu_1');
    await hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command: 'npm run test:unit' }, tool_use_id: 'toolu_1', cwd, duration_ms: 72_000, tool_response: { stdout: 'PASS a\nPASS b\n\n41 passed', stderr: '', interrupted: false } });
    await decision(session, 'Edit', { file_path: join(cwd, 'src/payments/provider.ts'), old_string: 'a', new_string: 'b' }, cwd, 'toolu_2');
    await hook(session, 'PostToolUse')({ tool_name: 'Edit', tool_input: {}, tool_use_id: 'toolu_2', cwd, tool_response: { structuredPatch: [{ lines: [' x', '-a', '+b', '+c'] }] } });
    expect(payloads('tool.called').map((p) => [p.toolUseId, p.tool, p.title, p.where])).toEqual([
      ['toolu_1', 'Bash', 'npm run test:unit', 'shop-api'],
      ['toolu_2', 'Edit', 'shop-api/src/payments/provider.ts', 'shop-api'],
    ]);
    expect(payloads('tool.finished')).toEqual([
      { runId: expect.any(String), toolUseId: 'toolu_1', ok: true, outputSummary: 'PASS a\nPASS b\n41 passed', durationMs: 72_000 },
      { runId: expect.any(String), toolUseId: 'toolu_2', ok: true, outputSummary: '-a\n+b\n+c', stats: '+2 −1' },
    ]);
  });

  it('keeps an Edit’s hunks with their line numbers for its card, redacted', async () => {
    const { session, runRoot } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    await decision(session, 'Edit', { file_path: join(cwd, 'src/webhook/auth.ts'), old_string: 'a', new_string: 'b' }, cwd, 'toolu_e');
    const patch = [{ oldStart: 26, oldLines: 3, newStart: 26, newLines: 4, lines: ['   const token = config.token.trim();', '-  headers.Authorization = `Basic ${token}`;', '+  const value = token.replace(/^Basic\\s+/i, "");', '+  headers.Authorization = `Basic ${value}`;', '+  // was Authorization: Basic dXNlcjpwYXNz'] }];
    await hook(session, 'PostToolUse')({ tool_name: 'Edit', tool_input: {}, tool_use_id: 'toolu_e', cwd, tool_response: { structuredPatch: patch } });
    const finished = payloads('tool.finished').at(-1)!;
    expect(finished.diff).toEqual({
      hunks: [{ oldStart: 26, newStart: 26, lines: [patch[0]!.lines[0], patch[0]!.lines[1], patch[0]!.lines[2], patch[0]!.lines[3], '+  // was Authorization: Basic [redacted credentials]'] }],
    });
  });

  it('writes its reasoning as thoughts, and a sub-agent’s under its own id', async () => {
    const { session, runRoot, runId } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    session.emit(text('The config value already carries "Basic ", and auth.ts adds it again.\n\nThat is a bug, not intended.'));
    await tick(20);
    await decision(session, 'Agent', { subagent_type: 'haiku-5.5-low', description: 'Write a failing test', prompt: 'x' }, cwd, 'toolu_agent');
    await hook(session, 'SubagentStart')({ agent_id: 'sa1', agent_type: 'haiku-5.5-low' });
    session.emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: [{ type: 'text', text: 'Writing the test in test/webhook/auth.spec.ts.' }] }, uuid: 'u2', session_id: 's' } as never);
    await tick(20);
    expect(payloads('run.thought')).toEqual([
      { runId, text: 'The config value already carries "Basic ", and auth.ts adds it again.\n\nThat is a bug, not intended.' },
      { runId, subagentId: 'sa1', text: 'Writing the test in test/webhook/auth.spec.ts.' },
    ]);
    // The first line still makes the run's note.
    expect(payloads('run.note').at(-1)).toEqual({ runId, text: 'The config value already carries "Basic ", and auth.ts adds it again.' });
  });

  it('pushes the run branch at once on git push (tier 1): recorded, and Elfoqsy says so in one line', async () => {
    const { session, runRoot, runId } = await spawn();
    const clone = join(runRoot, 'shop-api');
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    writeFileSync(join(clone, 'fix.ts'), 'export const fixed = true;\n');
    execFileSync('git', ['add', '.'], { cwd: clone, env });
    execFileSync('git', ['commit', '--quiet', '-m', 'SHOP-3546: lift error_code'], { cwd: clone, env });
    await canPush(session);

    await decision(session, 'Bash', { command: 'git push origin feature/SHOP-3546' }, clone, 'push1');
    const canUseTool = session.options.canUseTool as CanUseTool;
    const result = await canUseTool('Bash', { command: 'git push origin feature/SHOP-3546' }, { signal: new AbortController().signal, toolUseID: 'push1', requestId: 'r' });
    expect(result).toEqual({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546 to acme/shop-api at once') });
    expect(payloads('approval.requested')).toEqual([]); // nobody was asked
    expect(payloads('action.classified')).toEqual([
      { actionId: expect.any(String), runId, toolUseId: 'push1', proxy: 'git', kind: 'git.push', tier: 1, summary: `git push origin feature/SHOP-3546 (${SHOP_API}, 1 commit)`, decision: 'run', reason: "Pushing the run's own branch is done at once and reported." },
    ]);
    expect(payloads('change.recorded')).toEqual([
      { recordId: expect.any(String), actionId: payloads('action.classified')[0]!.actionId, runId, target: 'feature/SHOP-3546 on GitHub', before: `${SHOP_API}: not on GitHub`, noUndo: 'Taking a push back would need a force-push, which only alex may do.' },
    ]);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ role: 'elfoqsy', text: 'Agent 1 pushed feature/SHOP-3546 to shop-api (1 commit).', refs: { tickets: ['SHOP-3546'], runId } });
    expect(world.git(world.remote, 'log', '-1', '--format=%s', 'feature/SHOP-3546')).toBe('SHOP-3546: lift error_code');
    expect(world.git(world.remote, 'branch', '--list', 'master', 'main')).toContain('master'); // untouched
    expect(payloads('run.state_changed').map((p) => p.state)).not.toContain('waiting_for_you');
    // The SDK never runs the agent's own push, so its end is the orchestrator's push.
    expect(payloads('tool.finished').at(-1)).toMatchObject({ toolUseId: 'push1', ok: true, outputSummary: expect.stringContaining('The orchestrator pushed') });
  });

  it('refuses a push whose commits carry other co-author lines, fixes them in the clone, and pushes the next one', async () => {
    const { session, runRoot } = await spawn();
    const clone = join(runRoot, 'shop-api');
    const now = `@${Math.floor(clock.now / 1000)} +0000`; // during the run: the agent's
    const env = { ...process.env, ...agentGitEnv(world.clone.identity), GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now };
    writeFileSync(join(clone, 'fix.ts'), 'export const fixed = true;\n');
    execFileSync('git', ['add', '.'], { cwd: clone, env });
    // The hook skipped, as an agent could: Claude Code's line and the old one.
    execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', 'SHOP-3546: lift error_code\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Claude <noreply@anthropic.com>'], { cwd: clone, env });
    await canPush(session);
    const canUseTool = session.options.canUseTool as CanUseTool;
    const push = async (id: string) => {
      await decision(session, 'Bash', { command: 'git push' }, clone, id);
      return canUseTool('Bash', { command: 'git push' }, { signal: new AbortController().signal, toolUseID: id, requestId: 'r' });
    };

    expect(await push('p1')).toEqual({ behavior: 'deny', message: expect.stringMatching(/^The push was refused: every commit you make must carry exactly one co-author line, Co-Authored-By: Elfoqsy's Claude <noreply@anthropic.com>, and these did not: [0-9a-f]{7} "SHOP-3546: lift error_code" \(2 co-author lines\)\. The orchestrator rewrote their messages in your clone/) });
    expect(payloads('action.classified')).toEqual([]); // commits that were about to change were never pushed
    expect(world.git(clone, 'log', '-1', '--format=%B')).toBe(`SHOP-3546: lift error_code\n\n${TRAILER}`);

    expect(await push('p2')).toEqual({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    expect(world.git(world.remote, 'log', '-1', '--format=%B', 'feature/SHOP-3546')).toBe(`SHOP-3546: lift error_code\n\n${TRAILER}`);
  });

  it('refuses tier-3 pushes from the agent’s own shell however they are written, and pushes nothing', async () => {
    const { session, runRoot } = await spawn();
    const clone = join(runRoot, 'shop-api');
    for (const command of ['git push --force', 'git push -f origin feature/SHOP-3546', 'git push origin +feature/SHOP-3546', 'git push origin HEAD:master', 'git push origin :feature/SHOP-3546', 'git push origin feature/SHOP-3546:feature/other', 'git push --delete origin feature/SHOP-3546', 'git push --mirror']) {
      expect(await decision(session, 'Bash', { command }, clone, command)).toBe('deny');
    }
    expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toBe('');
    expect(payloads('approval.requested')).toEqual([]);
  });

  it('notes a dismissed run’s kept work in its ticket’s conversation and remembers it, moving nothing', async () => {
    const { session, runRoot, runId } = await spawn();
    const clone = join(runRoot, 'shop-api');
    const env = { ...process.env, ...agentGitEnv(null), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
    writeFileSync(join(clone, 'x.ts'), 'x');
    execFileSync('git', ['add', '.'], { cwd: clone, env });
    execFileSync('git', ['commit', '--quiet', '-m', 'SHOP-3546: carry provider errors'], { cwd: clone, env });
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: clone, env }).toString().trim();
    session.emit(cutShort()); // its session ends with an error, not interrupted: the run fails and its folder is kept
    await tick(300);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'failed', reason: expect.stringContaining('The run folder was kept') });

    log.append('orchestrator', 'run.dismissed', { runId, by: 'tester', reason: 'It failed because of a workspace bug.' });
    await tick(300);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({
      role: 'elfoqsy',
      text: `Agent 1 is dismissed, and its work is kept for the next run on SHOP-3546: ${sha} "SHOP-3546: carry provider errors" on feature/SHOP-3546, not on GitHub, in ${runRoot}. A new run can start from it; its push will list these commits for you.`,
      refs: { tickets: ['SHOP-3546'], runId },
    });
    expect(payloads('memory.saved').at(-1)).toMatchObject({
      origin: 'run',
      kind: 'fact',
      sources: [{ kind: 'ticket', ref: 'SHOP-3546', label: "Agent 1's kept run folder" }],
      statement: expect.stringContaining('Offer it as the starting point of the next run on SHOP-3546'),
    });
    expect(existsSync(join(clone, 'x.ts'))).toBe(true);
    expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toBe('');
    // A run whose folder is gone has nothing to note.
    log.append('orchestrator', 'run.created', { runId: 'gone', ticket: 'SHOP-3546', worktree: join(runRoot, 'nope'), branch: 'feature/SHOP-3546', agentNumber: 9, repos: [SHOP_API] });
    expect(await orchestrator.noteKeptWork('gone')).toBe(false);
  });

  it('tells the agent when a tester, not Alex, answered', async () => {
    const { session } = await spawn();
    const pending = runTool(session.options, 'gh', { args: ['pr', 'ready', '9', '--repo', SHOP_API] });
    await until(() => payloads('approval.requested').length > 0);
    log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested')[0]!.approvalId, decision: 'denied', test: true });
    expect(await pending).toMatch(/^The tester \(not alex\) declined: gh pr ready 9/);
    expect(backends.calls.gh).toEqual([]);
  });

  it('runs every test in the run folder without asking (tier 0)', async () => {
    const { session, runRoot } = await spawn();
    const cwd = join(runRoot, 'shop-api');
    for (const command of ['npm run test:integration', 'npm test', 'JEST_TIERS=soak npx jest']) expect(await decision(session, 'Bash', { command }, cwd, command)).toBe('allow');
    expect(payloads('approval.requested')).toEqual([]);
  });

  describe('the agent’s own plan', () => {
    const plan = {
      goal: 'Payment provider errors reach checkout with their error_code.',
      checks: [
        { id: 'unit', description: 'Unit tests pass', proof: 'command', command: 'npm run test:unit' },
        { id: 'ci', description: 'CI passes', proof: 'ci', repo: SHOP_API },
      ],
    };
    const bash = (session: Parameters<typeof hook>[0], command: string, outcome: 'pass' | 'fail' | 'background', id = `b${Math.random()}`) =>
      outcome === 'fail'
        ? hook(session, 'PostToolUseFailure')({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, error: 'Exit code 1\n2 failed', cwd: '' })
        : hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, cwd: '', tool_response: { stdout: 'ok', stderr: '', interrupted: false, ...(outcome === 'background' ? { backgroundTaskId: 't1' } : {}) } });

    it('has the agent declare its goal and checks, and form its steps as it goes', async () => {
      const { session, runId } = await spawn();
      expect(payloads('run.step_begun')).toEqual([]); // the system forms no step of its own
      expect(await runTool(session.options, 'declare_goal', plan)).toBe('Goal and checks recorded (revision 1).');
      expect(payloads('run.goal_declared')).toEqual([{ runId, revision: 1, ...plan }]);
      expect(await runTool(session.options, 'begin_step', { name: 'Read the handler', why: 'Find where the 429 is dropped.' })).toBe('Step 1: Read the handler.');
      expect(await runTool(session.options, 'begin_step', { name: 'Lift error_code', why: 'It is nested in details.' })).toBe('Step 2: Lift error_code.');
      await runTool(session.options, 'begin_step', { name: 'Unit tests', why: 'Prove it.', previous: { outcome: 'abandoned', note: 'A fallback is not needed' } });
      expect(events().filter((e) => e.type === 'run.step_begun' || e.type === 'run.step_ended').map((e) => [e.type, e.payload])).toEqual([
        ['run.step_begun', { runId, stepIndex: 0, name: 'Read the handler', why: 'Find where the 429 is dropped.' }],
        ['run.step_ended', { runId, stepIndex: 0, outcome: 'done' }],
        ['run.step_begun', { runId, stepIndex: 1, name: 'Lift error_code', why: 'It is nested in details.' }],
        ['run.step_ended', { runId, stepIndex: 1, outcome: 'abandoned', note: 'A fallback is not needed' }],
        ['run.step_begun', { runId, stepIndex: 2, name: 'Unit tests', why: 'Prove it.' }],
      ]);
      // No line in the conversation: the brief and the progress block say what the agent does.
      expect(payloads('elfoqsy.message')).toEqual([]);
    });

    it('reports a heartbeat with its step, tokens and working time', async () => {
      const { session, runId } = await spawn();
      await runTool(session.options, 'begin_step', { name: 'Unit tests', why: 'Prove it.' });
      session.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 400_000, output_tokens: 10_000, cache_creation_input_tokens: 2_000 } }, uuid: 'u', session_id: 's' } as never);
      await tick(20);
      clock.advance(5 * 60_000);
      await runTool(session.options, 'heartbeat', { sinceLast: 'Fixed two specs.', next: 'Run the whole suite.', progress: 'most', risks: ['Redis is missing'] });
      expect(payloads('run.heartbeat')).toEqual([
        { runId, step: 'Unit tests', sinceLast: 'Fixed two specs.', next: 'Run the whole suite.', progress: 'most', risks: ['Redis is missing'], tokens: 412_000, workingSeconds: 300 },
      ]);
      expect(payloads('run.usage').at(-1)).toEqual({ runId, tokens: 412_000, workingSeconds: 300 });
    });

    it('ends its open step with the run', async () => {
      const { session, runId } = await spawn();
      await runTool(session.options, 'begin_step', { name: 'Investigate', why: 'Start from the ticket.' });
      await orchestrator.cancel(runId, 'Not needed');
      expect(payloads('run.step_ended')).toEqual([{ runId, stepIndex: 0, outcome: 'abandoned' }]);
    });

    it('refuses a plan it could not check', async () => {
      const { session } = await spawn();
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [plan.checks[0], plan.checks[0]] })).toBe('Each check needs a different id.');
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'unit', description: 'Unit', proof: 'command' }] })).toBe('Check unit is proven by a command: give the command.');
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI', proof: 'ci', repo: SHOP_API, command: 'npm test' }] })).toMatch(/leave out command/);
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI', proof: 'ci' }] })).toBe(`Check ci is proven by CI: name its repo, one of ${SHOP_API}.`);
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI', proof: 'ci', repo: 'acme/shop-infra' }] })).toMatch(/name its repo, one of/);
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'u', description: 'U', proof: 'command', command: 'x', repo: SHOP_API }] })).toMatch(/leave out repo/);
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [] })).toMatch(/too_small|at least|>=1|Too small/i);
      expect(payloads('run.goal_declared')).toEqual([]);
    });

    it('takes a command check’s evidence from the command itself, exactly, and makes it stale when the code changes, however', async () => {
      const { session, runRoot } = await spawn();
      await runTool(session.options, 'declare_goal', plan);
      await bash(session, 'npm run test:unit 2>&1 | tail -5', 'pass'); // a pipe hides the exit status
      await bash(session, 'cd shop-api && npm run test:unit', 'background');
      expect(checks()).toEqual([]);
      await bash(session, 'cd shop-api && npm run test:unit', 'fail');
      await bash(session, 'cd shop-api && npm run test:unit', 'pass');
      expect(checks()).toEqual([['unit', 'failed'], ['unit', 'passed']]);
      expect(payloads('run.check_changed').at(-1)!.evidence).toMatch(/^`npm run test:unit` passed at \d\d:\d\d\.$/);
      // Changed behind the agent's file tools (as sed -i would): the fingerprint still sees it.
      writeFileSync(join(runRoot, 'shop-api', 'README.md'), '# shop-api, changed\n');
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: unit, ci.');
      expect(payloads('run.check_changed').at(-1)).toEqual({ runId: expect.any(String), checkId: 'unit', status: 'pending', evidence: 'Stale: the code changed after it passed, so it has to pass again.' });
      await bash(session, 'npm run test:unit', 'pass');
      writeFileSync(join(runRoot, 'shop-api', 'new.ts'), 'export {};\n'); // a new untracked file counts too
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: unit, ci.');
      await bash(session, 'npm run test:unit', 'pass');
      writeFileSync(join(runRoot, '.tmp', 'scratch.log'), 'x'); // outside the repositories: not the run's code
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: ci.');
    });

    it('succeeds only with evidence for every check, and keeps a folder whose work is not on GitHub', async () => {
      const { session, runRoot } = await spawn();
      await runTool(session.options, 'declare_goal', plan);
      writeFileSync(join(runRoot, 'shop-api', 'draft.ts'), 'draft');
      await bash(session, 'npm run test:unit', 'pass');
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'Lifted error_code', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: ci.');
      session.emit(text('Done.'), result());
      await tick(100);
      expect(payloads('run.state_changed').at(-1)).toEqual({
        runId: expect.any(String),
        state: 'stopped',
        reason: `Lifted error_code. Not counted as succeeded: "CI passes" (no evidence yet). feature/SHOP-3546 is not on GitHub, only in the run folder; uncommitted changes. The run folder was kept at ${runRoot}.`,
      });
      expect(existsSync(runRoot)).toBe(true);
    });

    it('succeeds when every check is proven, whatever kinds they are, and keeps a clean folder until the run is closed', async () => {
      const { session, runRoot } = await spawn();
      await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [plan.checks[0], { id: 'page', description: 'Confluence page updated', proof: 'approval' }] });
      await bash(session, 'npm run test:unit', 'pass');
      const asking = runTool(session.options, 'request_check_approval', { check: 'page', evidence: 'Updated the provider errors page.' });
      await tick(50);
      const asked = payloads('approval.requested').at(-1)!;
      expect(asked).toMatchObject({ kind: 'check', question: 'Agent 1 on SHOP-3546 says "Confluence page updated" is done: Updated the provider errors page.' });
      log.append('orchestrator', 'approval.resolved', { approvalId: asked.approvalId, decision: 'approved' });
      expect(await asking).toBe('Approved; the check has passing evidence.');
      session.emit(text('Fixed the handler and updated the page.'), result());
      await tick(100);
      expect(payloads('run.state_changed').at(-1)).toMatchObject({
        state: 'succeeded',
        reason: `Fixed the handler and updated the page. All 2 checks have passing evidence. feature/SHOP-3546 is not on GitHub, only in the run folder; no unpushed commits or uncommitted changes. The run folder was kept at ${runRoot} until the run is closed.`,
      });
      expect(existsSync(runRoot)).toBe(true);
      expect(payloads('run.folder_removed')).toEqual([]);
    });

    it('counts only alex’s approval of a check, not the tester’s, and a denial fails it', async () => {
      const { session } = await spawn();
      await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'page', description: 'Confluence page updated', proof: 'approval' }] });
      const first = runTool(session.options, 'request_check_approval', { check: 'page', evidence: 'Done.' });
      await tick(50);
      log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested').at(-1)!.approvalId, decision: 'approved', test: true });
      expect(await first).toMatch(/does not count/);
      const second = runTool(session.options, 'request_check_approval', { check: 'page', evidence: 'Done.' });
      await tick(50);
      log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested').at(-1)!.approvalId, decision: 'denied' });
      await second;
      expect(checks()).toEqual([['page', 'pending'], ['page', 'failed']]);
      expect(await runTool(session.options, 'request_check_approval', { check: 'nope', evidence: 'x' })).toBe('No check nope in your plan.');
    });

    it('lets a code approval go stale when the code changes, but not an external one', async () => {
      const { session, runRoot } = await spawn();
      expect(
        await runTool(session.options, 'declare_goal', {
          goal: 'Reproduce it on dev and document it.',
          checks: [
            { id: 'repro', description: 'The 429 reproduction passes on dev', proof: 'approval' },
            { id: 'page', description: 'Confluence page updated', proof: 'approval', scope: 'external' },
          ],
        }),
      ).toBe('Goal and checks recorded (revision 1).');
      expect(payloads('run.goal_declared')[0]!.checks.map((c) => c.scope)).toEqual(['code', 'external']); // code when left out
      for (const check of ['repro', 'page']) {
        const asking = runTool(session.options, 'request_check_approval', { check, evidence: 'Done.' });
        await tick(50);
        log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested').at(-1)!.approvalId, decision: 'approved' });
        await asking;
      }
      writeFileSync(join(runRoot, 'shop-api', 'README.md'), '# shop-api, changed after the approvals\n');
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: repro.');
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'u', description: 'U', proof: 'command', command: 'x', scope: 'external' }] })).toBe(
        'Check u is proven by command, not by approval: leave out scope.',
      );
    });

    it('keeps evidence across a plan change for checks that did not change, and logs the change', async () => {
      const { session } = await spawn();
      await runTool(session.options, 'declare_goal', plan);
      await bash(session, 'npm run test:unit', 'pass');
      expect(await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [plan.checks[0], { id: 'repro', description: 'The 429 reproduction passes', proof: 'command', command: 'node repro.js' }] })).toBe(
        'Goal and checks recorded (revision 2).',
      );
      expect(payloads('run.goal_declared').map((p) => p.revision)).toEqual([1, 2]);
      expect(payloads('run.note').at(-1)!.text).toMatch(/^Changed its checks \(revision 2\): Unit tests pass \(`npm run test:unit`\); The 429 reproduction passes/);
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: repro.');
    });

    it('ends as the agent says when it fails or is blocked', async () => {
      const first = await spawn();
      await runTool(first.session.options, 'report_result', { result: 'blocked', summary: 'protoc is not installed, so setup cannot run', notVerified: [], waitingOnYou: [] });
      first.session.emit(text('Blocked.'), result());
      await tick(100);
      expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'stopped', reason: expect.stringMatching(/^protoc is not installed, so setup cannot run\. feature/) });
      log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3547') });
      const r = await orchestrator.spawn({ ticketKey: 'SHOP-3547', repos: [SHOP_API] });
      await tick();
      const second = sdk.sessions.at(-1)!;
      await runTool(second.options, 'report_result', { result: 'failed', summary: 'Could not reproduce the 429.', notVerified: [], waitingOnYou: [] });
      second.emit(text('Gave up.'), result());
      await tick(100);
      expect(payloads('run.state_changed').filter((p) => p.runId === (r as { runId: string }).runId).at(-1)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/^Could not reproduce the 429\. feature\/SHOP-3547/) });
    });

    it('passes alex’s objection to the agent, labelled by who wrote it', async () => {
      const { session, runId } = await spawn();
      expect(orchestrator.tell(runId, 'Do not change the v3 handler.', 'alex')).toEqual({ ok: true });
      await tick();
      expect(session.sent.at(-1)).toBe('[alex, through Elfoqsy] Do not change the v3 handler.');
      orchestrator.tell(runId, 'Skip the PR.', 'tester');
      await tick();
      expect(session.sent.at(-1)).toBe('[The tester (not alex), through Elfoqsy] Skip the PR.');
      expect(orchestrator.tell('nope', 'x', 'alex')).toMatchObject({ error: 'unknown_run' });
    });
  });

  it('stops a run over its token budget', async () => {
    const { session } = await spawn();
    session.emit(result({ 'claude-opus-5-5': { inputTokens: 2_000_000, outputTokens: 900_000, cacheCreationInputTokens: 200_000 } }));
    await tick(100);
    expect(payloads('budget.exceeded')).toEqual([{ runId: expect.any(String), limit: 'tokens', value: 3_100_000 }]);
    expect(payloads('run.state_changed').at(-1)!.state).toBe('failed');
  });

  it('counts each API response once, takes its output from message_delta, and stops a long turn at the next 15 s check', async () => {
    const { session } = await spawn();
    const assistant = (id: string, usage: Record<string, number>) =>
      ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [], usage }, uuid: 'u', session_id: 's' }) as never;
    const stream = (parent: string | null, event: Record<string, unknown>) => ({ type: 'stream_event', parent_tool_use_id: parent, event, uuid: 'u', session_id: 's' }) as never;
    // Parallel tool uses: three assistant messages of one response, with its id and its usage each time.
    for (let i = 0; i < 3; i++) session.emit(assistant('msg_1', { input_tokens: 1_000_000, output_tokens: 1, cache_creation_input_tokens: 500_000 }));
    // A response streams while a sub-agent's does: each delta belongs to its own stream's response.
    session.emit(stream(null, { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 600_000, output_tokens: 1, cache_creation_input_tokens: 0 } } }));
    session.emit(stream('toolu_agent', { type: 'message_start', message: { id: 'sub_1', usage: { input_tokens: 100_000, output_tokens: 1 } } }));
    session.emit(stream(null, { type: 'message_delta', delta: {}, usage: { input_tokens: null, output_tokens: 300_000, cache_creation_input_tokens: null } }));
    session.emit(stream('toolu_agent', { type: 'message_delta', delta: {}, usage: { output_tokens: 50_000 } }));
    session.emit(assistant('msg_2', { input_tokens: 600_000, output_tokens: 1, cache_creation_input_tokens: 0 })); // its placeholder adds nothing
    await tick(20);
    clock.advance(15_000);
    await tick(20);
    expect(payloads('run.usage').at(-1)!.tokens).toBe(1_500_001 + 900_000 + 150_000);
    expect(payloads('budget.exceeded')).toEqual([]);
    // No result yet: the turn goes on, and the next check stops it.
    session.emit(assistant('msg_3', { input_tokens: 500_000, output_tokens: 1 }));
    await tick(20);
    clock.advance(15_000);
    await tick(100);
    expect(payloads('budget.exceeded')).toEqual([{ runId: expect.any(String), limit: 'tokens', value: 3_050_002 }]);
    expect(payloads('run.state_changed').at(-1)!.state).toBe('failed');
  });

  it('streams partial messages, for the output tokens of a response while it streams', async () => {
    const { session } = await spawn();
    expect(session.options.includePartialMessages).toBe(true);
  });

  it('stops a run after AGENT_MAX_MINUTES of working time, not counting time waiting for Alex', async () => {
    await spawn();
    clock.advance(46 * 60_000);
    await tick(100);
    expect(payloads('budget.exceeded')[0]).toMatchObject({ limit: 'time', value: 46 });
  });

  it('pauses with everything else at a usage limit, and continues once it resets', async () => {
    const { session } = await spawn();
    session.emit(rateLimit('rejected', (T0 + 3_600_000) / 1000));
    await tick();
    expect(sdk.interrupt).toHaveBeenCalled();
    expect(payloads('usage.limit')[0]).toMatchObject({ state: 'limited' });
    session.emit(result()); // the interrupted turn ends; it is not a finished run
    await tick(50);
    expect(payloads('run.state_changed').at(-1)!.state).toBe('running');
    // Shown paused by the workspace until the reset, never failed.
    expect(payloads('run.paused')).toEqual([{ runId: expect.any(String), by: 'orchestrator', reason: expect.stringMatching(/^Claude's usage limit until \d\d:\d\d: it goes on by itself once the limit resets\.$/) }]);
    expect(live.get().runs[payloads('run.created')[0]!.runId]!.paused).toMatchObject({ by: 'orchestrator' });
    clock.advance(3_600_000 + 30_000);
    await tick();
    expect(session.sent.at(-1)).toBe('The Claude usage limit has reset. Continue where you left off.');
    expect(payloads('run.resumed')).toEqual([{ runId: expect.any(String), by: 'orchestrator', reason: "Claude's usage limit has reset." }]);
    expect(payloads('run.state_changed').map((p) => p.state)).not.toContain('failed');
  });

  it('waits at CI while its PR is open, takes CI failures back, and ends when the PR is merged', async () => {
    const asked: string[][] = [];
    const ci: Record<string, CommitCi> = {};
    build({
      ciLog: async (repo, sha) => (asked.push([repo, sha]), { workflow: 'ci', url: 'https://github.com/x/actions/runs/42', log: '[3 earlier lines cut]\nFAIL src/payments/provider.test.ts\n  expected 429001' }),
      commitCi: async (_repo, sha) => ci[sha] ?? { state: 'none', summary: 'no CI has reported on it yet' },
    });
    const { session, runRoot } = await spawn();
    const clone = join(runRoot, 'shop-api');
    await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI passes', proof: 'ci', repo: SHOP_API }] });
    await tick(50);
    expect(payloads('run.check_changed').at(-1)).toMatchObject({ checkId: 'ci', status: 'pending', evidence: expect.stringContaining(`to be on GitHub in ${SHOP_API}`) });
    const head = commitAndPush(clone, 'fix.ts');
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'pending' } });
    session.emit(text('Opened #9.'), result());
    await tick(50);
    expect(payloads('run.step_begun')).toEqual([]); // waiting at CI is a phase, not a step the system forms
    ci[head] = { state: 'failure', summary: 'failed: unit' };
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: head, status: 'failure', url: 'https://github.com/x/checks' });
    await until(() => asked.length > 0 && lastCheck()?.status === 'failed' && session.sent.at(-1)!.startsWith('CI failed'));
    expect(asked).toEqual([[SHOP_API, head]]);
    expect(session.sent.at(-1)).toBe(
      `CI failed on acme/shop-api #9 at ${head.slice(0, 7)} (ci: https://github.com/x/actions/runs/42). The failed steps' log, redacted, last lines:\n\n\`\`\`\n[3 earlier lines cut]\nFAIL src/payments/provider.test.ts\n  expected 429001\n\`\`\`\n\nFind the cause, fix it, and push again; your plan decides how you prove it.`,
    );
    expect(payloads('run.check_changed').at(-1)).toMatchObject({ checkId: 'ci', status: 'failed', evidence: `CI on ${SHOP_API} at ${head.slice(0, 7)}: failed: unit.` });
    ci[head] = { state: 'success', summary: '3 CI checks passed' };
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: head, status: 'success', url: 'https://github.com/x/checks' });
    await until(() => lastCheck()?.status === 'passed');
    expect(payloads('run.check_changed').at(-1)).toMatchObject({ checkId: 'ci', status: 'passed', evidence: `CI on ${SHOP_API} at ${head.slice(0, 7)}: 3 CI checks passed.` });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'merged', ticket: 'SHOP-3546', url: '', checks: 'success' } });
    await tick(150);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'succeeded', reason: expect.stringMatching(/^acme\/shop-api #9 was merged\. All 1 check have passing evidence\./) });
    expect(payloads('run.folder_removed')).toEqual([{ runId: expect.any(String), folder: runRoot, reason: `${SHOP_API} #9 was merged, with nothing uncommitted and nothing missing from GitHub.` }]);
  });

  describe('CI evidence, read per commit', () => {
    let ci: Record<string, CommitCi>;
    let reads: string[][];
    beforeEach(async () => {
      ci = {};
      reads = [];
      await orchestrator.close();
      build({ commitCi: async (repo, sha) => (reads.push([repo, sha]), ci[sha] ?? { state: 'none', summary: 'no CI has reported on it yet' }) });
    });
    const declare = async (session: { options: Parameters<typeof runTool>[0] }) => {
      await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI passes', proof: 'ci', repo: SHOP_API }] });
      await until(() => lastCheck()?.status === 'pending'); // the first read, started by the plan, finishes and schedules the next one
    };

    it('proves a pushed branch with no pull request, reading only the named repo at its head, every minute until it has evidence', async () => {
      const { session, runRoot } = await spawn();
      await declare(session);
      const head = commitAndPush(join(runRoot, 'shop-api'), 'fix.ts');
      clock.advance(60_000);
      await until(() => lastCheck()?.evidence.startsWith('CI on') ?? false);
      expect(payloads('run.check_changed').at(-1)).toMatchObject({ status: 'pending', evidence: `CI on ${SHOP_API} at ${head.slice(0, 7)}: no CI has reported on it yet.` });
      ci[head] = { state: 'success', summary: '2 CI checks passed' };
      clock.advance(60_000);
      await until(() => lastCheck()?.status === 'passed');
      expect(payloads('run.check_changed').at(-1)).toMatchObject({ status: 'passed' });
      expect(new Set(reads.map((r) => r.join('@')))).toEqual(new Set([`${SHOP_API}@${head}`]));
      const count = reads.length;
      clock.advance(5 * 60_000);
      await tick(100);
      expect(reads).toHaveLength(count); // nothing left to wait for
    });

    it('reads CI again straight after when it changes during a read, instead of a minute later', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await orchestrator.close();
      build({ commitCi: async (repo, sha) => (reads.push([repo, sha]), await held, ci[sha] ?? { state: 'none', summary: 'no CI has reported on it yet' }) });
      const { session, runRoot } = await spawn();
      const head = commitAndPush(join(runRoot, 'shop-api'), 'fix.ts');
      log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'pending' } });
      await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'ci', description: 'CI passes', proof: 'ci', repo: SHOP_API }] });
      await until(() => reads.length === 1); // the first read is held at GitHub
      ci[head] = { state: 'success', summary: '2 CI checks passed' };
      log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: head, status: 'success', url: 'https://github.com/x/checks' });
      release();
      await until(() => lastCheck()?.status === 'passed'); // no clock advance: the second read came straight after
      expect(reads).toHaveLength(2);
    });

    it('counts CI only while the files are exactly the commit CI ran on', async () => {
      const { session, runRoot } = await spawn();
      const clone = join(runRoot, 'shop-api');
      await declare(session);
      const head = commitAndPush(clone, 'fix.ts');
      ci[head] = { state: 'success', summary: '2 CI checks passed' };
      writeFileSync(join(clone, 'wip.ts'), 'wip'); // not committed
      clock.advance(60_000);
      await until(() => lastCheck()?.evidence.startsWith('CI passed') ?? false);
      expect(payloads('run.check_changed').at(-1)).toMatchObject({ status: 'pending', evidence: `CI passed on ${SHOP_API} at ${head.slice(0, 7)}, but the files there have changed since that commit.` });
      rmSync(join(clone, 'wip.ts'));
      clock.advance(60_000);
      await until(() => lastCheck()?.status === 'passed');
      expect(payloads('run.check_changed').at(-1)).toMatchObject({ status: 'passed' });
      writeFileSync(join(clone, 'README.md'), 'changed after CI\n');
      expect(await runTool(session.options, 'report_result', { result: 'succeeded', summary: 'x', notVerified: [], waitingOnYou: [] })).toBe('Recorded. Checks without passing evidence: ci.');
    });
  });

  it('does not count a merge as success without evidence for every check', async () => {
    const { session } = await spawn();
    await runTool(session.options, 'declare_goal', { goal: 'Fix the ticket.', checks: [{ id: 'unit', description: 'Unit tests pass', proof: 'command', command: 'npm run test:unit' }] });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'pending' } });
    session.emit(text('Opened #9.'), result());
    await tick(50);
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'merged', ticket: 'SHOP-3546', url: '', checks: 'success' } });
    await tick(100);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'stopped', reason: expect.stringMatching(/^acme\/shop-api #9 was merged\. Not counted as succeeded: "Unit tests pass" \(no evidence yet\)\./) });
  });

  it('says when there is no Actions log, or when it could not be fetched', async () => {
    const answers: Array<() => Promise<null>> = [async () => null, async () => Promise.reject(new Error('HTTP 502'))];
    build({ ciLog: () => answers.shift()!() });
    const { session } = await spawn();
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'pending' } });
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: 'abcdef0123', status: 'failure', url: 'https://github.com/x/checks' });
    await tick();
    expect(session.sent.at(-1)).toContain('No GitHub Actions run failed at that commit');
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: 'abcdef0123', status: 'running', url: '' });
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 9, sha: 'abcdef0123', status: 'failure', url: 'https://github.com/x/checks' });
    await tick();
    expect(session.sent.at(-1)).toContain('could not fetch the log (HTTP 502)');
  });

  it('cancels a run and closes its open questions', async () => {
    const { runId, session, runRoot } = await spawn();
    void runTool(session.options, 'gh', { args: ['pr', 'ready', '9', '--repo', SHOP_API] });
    await until(() => payloads('approval.requested').length > 0);
    void runRoot;
    expect(await orchestrator.cancel(runId, 'Not needed')).toMatchObject({ ok: true, state: 'cancelled', folderRemoved: true });
    expect(payloads('approval.resolved').at(-1)).toMatchObject({ decision: 'denied', answer: 'The run ended.' });
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'cancelled', reason: expect.stringMatching(/^Not needed\. feature\/SHOP-3546 was never pushed/) });
    expect(await orchestrator.cancel(runId, 'again')).toMatchObject({ error: 'unknown_run' });
  });

  describe('cancel_run says exactly what is left', () => {
    const commit = (clone: string, file: string) => {
      const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
      writeFileSync(join(clone, file), `${file}\n`);
      execFileSync('git', ['add', '.'], { cwd: clone, env });
      execFileSync('git', ['commit', '--quiet', '-m', file], { cwd: clone, env });
    };

    it('nothing done: the branch was never pushed and the folder is gone', async () => {
      const { runId, runRoot } = await spawn();
      const result = await orchestrator.cancel(runId, 'Test request.');
      expect(result).toEqual({
        ok: true,
        state: 'cancelled',
        folder: runRoot,
        folderRemoved: true,
        repos: [{ repo: SHOP_API, branch: 'feature/SHOP-3546', branchOnGitHub: false, unpushedCommits: 0, uncommittedChanges: false }],
        summary: 'feature/SHOP-3546 was never pushed, so it is gone with the run folder; no unpushed commits or uncommitted changes. The run folder was removed.',
      });
      expect(existsSync(runRoot)).toBe(false);
      expect(payloads('run.folder_removed')).toEqual([{ runId, folder: runRoot, reason: 'Cancelled, with nothing uncommitted and nothing missing from GitHub.' }]);
    });

    it('a commit and an edit not on GitHub: both counted, and the folder kept where it is', async () => {
      const { runId, runRoot } = await spawn();
      const clone = join(runRoot, 'shop-api');
      commit(clone, 'fix.ts');
      writeFileSync(join(clone, 'wip.ts'), 'wip');
      const result = await orchestrator.cancel(runId, 'Test request.');
      expect(result).toMatchObject({
        folderRemoved: false,
        repos: [{ branchOnGitHub: false, unpushedCommits: 1, uncommittedChanges: true }],
        summary: `feature/SHOP-3546 is not on GitHub, only in the run folder; 1 commit not on GitHub and uncommitted changes. The run folder was kept at ${runRoot}.`,
      });
      expect(existsSync(join(clone, 'wip.ts'))).toBe(true);
    });

    it('pushed already: the branch is on GitHub, nothing is left behind, and the folder is gone', async () => {
      const { runId, runRoot } = await spawn();
      const clone = join(runRoot, 'shop-api');
      commit(clone, 'fix.ts');
      execFileSync('git', ['push', '--quiet', 'origin', 'feature/SHOP-3546'], { cwd: clone, env: gitEnv }); // as the orchestrator would, after approval
      execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: clone, env: gitEnv });
      expect(await orchestrator.cancel(runId, 'Test request.')).toMatchObject({
        folderRemoved: true,
        repos: [{ branchOnGitHub: true, unpushedCommits: 0, uncommittedChanges: false }],
        summary: 'feature/SHOP-3546 is on GitHub; no unpushed commits or uncommitted changes. The run folder was removed.',
      });
    });
  });

  it('closes runs left over from a previous daemon', () => {
    log.append('orchestrator', 'run.created', { runId: 'old', ticket: 'SHOP-3546', worktree: '/w/old', branch: 'feature/SHOP-3546', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'old', state: 'running' });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a-old', runId: 'old', kind: 'push', question: 'push?' });
    orchestrator.recoverStaleRuns();
    expect(payloads('approval.resolved')).toEqual([{ approvalId: 'a-old', decision: 'denied', answer: 'The daemon restarted.' }]);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ runId: 'old', state: 'failed', reason: expect.stringContaining('/w/old') });
    // Another restart leaves a run that already failed as it is.
    const before = payloads('run.state_changed').length;
    orchestrator.recoverStaleRuns();
    expect(payloads('run.state_changed')).toHaveLength(before);
  });
});

describe('a real run’s folder, once the run is closed', () => {
  const removed = () => payloads('run.folder_removed');

  it('keeps a failed run’s clean folder until it is dismissed, then removes it and says why', async () => {
    const { session, runRoot, runId } = await spawn();
    session.emit(cutShort());
    await until(() => payloads('run.state_changed').at(-1)?.state === 'failed');
    expect(payloads('run.state_changed').at(-1)!.reason).toContain(`The run folder was kept at ${runRoot} until the run is closed.`);
    expect(existsSync(runRoot)).toBe(true);
    log.append('orchestrator', 'run.dismissed', { runId, by: 'you' });
    await until(() => removed().length > 0);
    expect(existsSync(runRoot)).toBe(false);
    expect(removed()).toEqual([{ runId, folder: runRoot, reason: 'Dismissed, with nothing uncommitted and nothing missing from GitHub.' }]);
    expect(live.get().runs[runId]!.folderRemoved).toMatchObject({ reason: 'Dismissed, with nothing uncommitted and nothing missing from GitHub.' });
    expect(payloads('elfoqsy.message')).toEqual([]);
  });

  it('closes a run that ended without a PR once its ticket’s PR is merged: a clean folder goes, once', async () => {
    const { session, runRoot, runId } = await spawn();
    session.emit(text('I could not finish.'), result());
    await until(() => payloads('run.state_changed').at(-1)?.state === 'stopped');
    const pr = { repo: SHOP_API, number: 9, ticket: 'SHOP-3546', url: '', checks: 'success' as const };
    log.append('github', 'pr.synced', { pr: { ...pr, state: 'open' } });
    await tick(50);
    expect(existsSync(runRoot)).toBe(true);
    log.append('github', 'pr.synced', { pr: { ...pr, state: 'merged' } });
    await until(() => removed().length > 0);
    expect(existsSync(runRoot)).toBe(false);
    expect(removed()).toEqual([{ runId, folder: runRoot, reason: `${SHOP_API} #9 was merged, with nothing uncommitted and nothing missing from GitHub.` }]);
    log.append('github', 'pr.synced', { pr: { ...pr, state: 'merged' } }); // synced again
    await tick(50);
    expect(removed()).toHaveLength(1);
  });

  it('keeps a closed run’s folder with work GitHub lacks, a stash included, and notes it once in its ticket’s conversation', async () => {
    const { runRoot, runId } = await spawn();
    const clone = join(runRoot, 'shop-api');
    writeFileSync(join(clone, 'wip.ts'), 'wip');
    execFileSync('git', ['stash', '--quiet', '--include-untracked'], { cwd: clone, env: gitEnv });
    expect(world.git(clone, 'status', '--porcelain')).toBe('');
    expect(await orchestrator.cancel(runId, 'Stop.')).toMatchObject({ folderRemoved: false, repos: [{ unpushedCommits: 0, uncommittedChanges: true }] });
    await until(() => payloads('memory.saved').length > 0);
    expect(existsSync(runRoot)).toBe(true);
    expect(payloads('elfoqsy.message')).toEqual([
      expect.objectContaining({
        role: 'elfoqsy',
        text: `Agent 1 was cancelled, and its folder is kept for its uncommitted changes, in ${runRoot}. It holds no commits GitHub lacks, so a new run on SHOP-3546 starts from GitHub.`,
        refs: { tickets: ['SHOP-3546'], runId },
      }),
    ]);
    expect(payloads('memory.saved').at(-1)).toMatchObject({ factId: `kept-${runId}`, statement: expect.stringContaining('no starting point for a new run') });
    expect(await orchestrator.closeEndedFolders()).toEqual({ removed: 0, noted: 0 }); // said once
    expect(payloads('elfoqsy.message')).toHaveLength(1);
    expect(removed()).toEqual([]);
  });

  it('at start, closes what runs closed while it was off left behind, from before milestone 11 too, and leaves the rest', async () => {
    await orchestrator.close(); // the daemon is off
    const made = (agentNumber: number) => {
      const runId = `old${agentNumber}`;
      const folder = join(world.worktrees, `SHOP-3546-${runId}`);
      const path = join(folder, 'shop-api');
      mkdirSync(folder);
      execFileSync('git', ['clone', '--quiet', world.remote, path], { env: gitEnv });
      execFileSync('git', ['switch', '--quiet', '-c', 'feature/SHOP-3546'], { cwd: path, env: gitEnv });
      log.append('orchestrator', 'run.created', { runId, ticket: 'SHOP-3546', worktree: folder, branch: 'feature/SHOP-3546', agentNumber }); // no repos: before milestone 11
      return { runId, folder, path };
    };
    const dismissed = made(1);
    log.append('orchestrator', 'run.state_changed', { runId: dismissed.runId, state: 'failed', reason: 'The daemon restarted and the agent stopped.' });
    log.append('orchestrator', 'run.dismissed', { runId: dismissed.runId, by: 'you' });
    const cancelled = made(2);
    writeFileSync(join(cancelled.path, 'wip.ts'), 'wip');
    log.append('orchestrator', 'run.state_changed', { runId: cancelled.runId, state: 'cancelled' });
    const stopped = made(3);
    log.append('orchestrator', 'run.state_changed', { runId: stopped.runId, state: 'stopped' });
    build();
    expect(await orchestrator.closeEndedFolders()).toEqual({ removed: 1, noted: 1 });
    expect([dismissed, cancelled, stopped].map((r) => existsSync(r.folder))).toEqual([false, true, true]);
    expect(removed()).toEqual([{ runId: 'old1', folder: dismissed.folder, reason: 'Dismissed, with nothing uncommitted and nothing missing from GitHub.' }]);
    expect(payloads('elfoqsy.message').map((m) => m.text)).toEqual([
      `Agent 2 was cancelled, and its folder is kept for its uncommitted changes, in ${cancelled.folder}. It holds no commits GitHub lacks, so a new run on SHOP-3546 starts from GitHub.`,
    ]);
    expect(await orchestrator.closeEndedFolders()).toEqual({ removed: 0, noted: 0 });
  });
});

describe('reporting: heartbeats, loops and budgets watched (milestone 11)', () => {
  /** Working time passes in the 15 s ticks the run checks its budget on. */
  const work = (minutes: number) => {
    for (let i = 0; i < minutes * 4; i++) clock.advance(15_000);
  };
  const flags = () => payloads('run.flag').map((f) => [f.kind, f.detail]);

  it('reminds an agent of its heartbeat after 5 working minutes, flags it after 10, and starts over at each heartbeat', async () => {
    const { session } = await spawn();
    work(4.75);
    await tick();
    expect(session.sent.some((t) => t.includes('Call heartbeat now'))).toBe(false);
    work(0.5);
    await tick();
    expect(session.sent.filter((t) => t.includes('Call heartbeat now'))).toHaveLength(1);
    work(5);
    expect(flags()).toEqual([['missed_heartbeats', 'No heartbeat for 10 working minutes; two are missed.']]);
    await runTool(session.options, 'heartbeat', { sinceLast: 'Read the handler.', next: 'Fix it.', progress: 'some', risks: [] });
    work(4);
    await tick();
    expect(session.sent.filter((t) => t.includes('Call heartbeat now'))).toHaveLength(1); // the clock started over
  });

  it('takes its interval from AGENT_HEARTBEAT_MINUTES: at 1, the prompt says every minute, a reminder at 1 and a flag at 2', async () => {
    await orchestrator.close();
    build({ config: { ...deps.config, AGENT_HEARTBEAT_MINUTES: 1 } });
    const { session } = await spawn();
    expect(session.sent[0]).toContain('Every minute of working time, call heartbeat');
    work(1);
    await tick();
    expect(session.sent.at(-1)).toBe('It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.');
    expect(payloads('run.reminded')).toEqual([{ runId: expect.any(String), about: 'heartbeat', text: 'It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.' }]);
    work(1);
    expect(flags()).toEqual([['missed_heartbeats', 'No heartbeat for 2 working minutes; two are missed.']]);
  });

  it('owes no heartbeat while paused', async () => {
    const { session, runId } = await spawn();
    expect(orchestrator.pause(runId, 'tester')).toEqual({ ok: true });
    work(12);
    await tick();
    expect(session.sent.some((t) => t.includes('Call heartbeat now'))).toBe(false);
    expect(flags()).toEqual([]);
  });

  it('flags the same command three times with no code change in between, once; an edit starts the count over', async () => {
    const { session, runRoot } = await spawn();
    const clone = join(runRoot, 'shop-api');
    await canChangeCode(session);
    await decision(session, 'Bash', { command: 'npm run test:unit' }, clone, 'b1');
    await decision(session, 'Edit', { file_path: join(clone, 'a.ts'), old_string: 'a', new_string: 'b' }, clone, 'e1');
    await decision(session, 'Bash', { command: 'npm  run test:unit' }, clone, 'b2');
    await decision(session, 'Bash', { command: 'npm run test:unit' }, clone, 'b3');
    expect(flags()).toEqual([]);
    await decision(session, 'Bash', { command: 'npm run test:unit' }, clone, 'b4');
    await decision(session, 'Bash', { command: 'npm run test:unit' }, clone, 'b5');
    expect(flags()).toEqual([['loop', 'It ran `npm run test:unit` 3 times with no change to the code in between.']]);
  });

  it('flags tokens rising across two heartbeats with no new step and no new evidence', async () => {
    const { session } = await spawn();
    const spend = (n: number) =>
      session.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: n, output_tokens: 0 } }, uuid: 'u', session_id: 's' } as never);
    const beat = () => runTool(session.options, 'heartbeat', { sinceLast: 'Still on it.', next: 'More.', progress: 'some', risks: [] });
    await beat();
    spend(50_000);
    await tick();
    await beat();
    expect(flags()).toEqual([]);
    spend(60_000);
    await tick();
    await beat();
    expect(flags()).toEqual([['loop', 'Tokens rose from 0k to 110k over two heartbeats with no new step and no new evidence.']]);
  });

  it('flags a budget nearly spent, once', async () => {
    await spawn();
    work(36.5); // 80% of 45 minutes
    expect(flags().filter(([k]) => k === 'budget')).toHaveLength(1);
    expect(flags().find(([k]) => k === 'budget')![1]).toMatch(/^Its budget is nearly spent: 36 of 45 working minutes/);
    work(2);
    expect(flags().filter(([k]) => k === 'budget')).toHaveLength(1);
  });
});

describe('intervention: pause, guidance and resume (milestone 12)', () => {
  it('pauses an agent: its turn is interrupted and its working clock stops; resume continues it', async () => {
    const { session, runId } = await spawn();
    expect(orchestrator.pause(runId, 'you')).toEqual({ ok: true });
    expect(sdk.interrupt).toHaveBeenCalled();
    expect(payloads('run.paused').at(-1)).toEqual({ runId, by: 'you' });
    expect(orchestrator.pause(runId, 'you')).toMatchObject({ error: 'already_paused' });
    clock.advance(10 * 60_000);
    expect(orchestrator.resume(runId, 'you')).toEqual({ ok: true });
    expect(payloads('run.resumed').at(-1)).toEqual({ runId, by: 'you' });
    await tick();
    expect(session.sent.at(-1)).toBe('alex paused you and has resumed you. Continue where you left off.');
    expect(orchestrator.resume(runId, 'you')).toMatchObject({ error: 'not_paused' });
    expect(orchestrator.pause('nope', 'you')).toMatchObject({ error: 'unknown_run' });
    session.emit(cutShort()); // the interrupted turn ends only now
    await tick(50);
    expect(payloads('run.state_changed').at(-1)!.state).toBe('running');
  });

  it('goes on after guidance when the turn it cut short ends after the resume, as it did live', async () => {
    const { session, runId } = await spawn();
    orchestrator.guide(runId, 'Never edit the build folder.', 'tester');
    expect(sdk.interrupt).toHaveBeenCalledTimes(1);
    session.emit(cutShort());
    await tick(50);
    expect(payloads('run.state_changed').map((p) => p.state)).not.toContain('failed');
    // The turn the guidance started is the run's own: its end counts.
    session.emit(cutShort());
    await tick(50);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'failed', reason: expect.stringContaining('ede_diagnostic') });
  });

  it('interrupts once when a usage limit and a pause come together', async () => {
    const { session, runId } = await spawn();
    session.emit(rateLimit('rejected', (T0 + 3_600_000) / 1000));
    await tick();
    orchestrator.pause(runId, 'you');
    expect(sdk.interrupt).toHaveBeenCalledTimes(1);
    session.emit(cutShort());
    clock.advance(3_600_000 + 30_000);
    await tick(50);
    expect(session.sent.at(-1)).not.toMatch(/usage limit has reset/); // still paused by alex
    orchestrator.resume(runId, 'you');
    await tick();
    expect(session.sent.at(-1)).toBe('alex paused you and has resumed you. Continue where you left off.');
    expect(payloads('run.state_changed').at(-1)!.state).toBe('running');
  });

  it('gives guidance as one action, labelled with who gave it, and holds the agent to re-plan: a reminder, then a flag', async () => {
    const { session, runId, runRoot } = await spawn();
    expect(orchestrator.guide(runId, 'Skip the integration suite; it needs Redis.', 'tester')).toEqual({ ok: true });
    const order = events()
      .filter((e) => ['run.paused', 'run.guidance', 'run.resumed'].includes(e.type))
      .map((e) => e.type);
    expect(order).toEqual(['run.paused', 'run.guidance', 'run.resumed']);
    expect(payloads('run.paused').at(-1)).toEqual({ runId, by: 'tester', reason: 'To give guidance' });
    await tick();
    expect(session.sent.at(-1)).toBe(
      '[Guidance, given while you were paused]\n- The tester (not alex): Skip the integration suite; it needs Redis.\n\nContinue from here: first call begin_step with your next step, and declare_goal again if your checks change.',
    );
    const clone = join(runRoot, 'shop-api');
    for (let i = 0; i < 3; i++) await decision(session, 'Read', { file_path: join(clone, 'a.ts') }, clone, `r${i}`);
    await tick();
    expect(session.sent.at(-1)).toMatch(/^Before anything else, call begin_step with your next step after the guidance/);
    expect(payloads('run.reminded').map((r) => r.about)).toEqual(['replan']);
    for (let i = 3; i < 8; i++) await decision(session, 'Read', { file_path: join(clone, 'a.ts') }, clone, `r${i}`);
    expect(payloads('run.flag').at(-1)).toEqual({ runId, kind: 'replan', detail: 'It has not declared its next step after the guidance (8 tool calls).' });
  });

  it('stops counting once the agent re-plans', async () => {
    const { session, runId, runRoot } = await spawn();
    orchestrator.guide(runId, 'Only the unit tier.', 'you');
    await runTool(session.options, 'begin_step', { name: 'Unit tests only', why: 'As told.' });
    const clone = join(runRoot, 'shop-api');
    for (let i = 0; i < 9; i++) await decision(session, 'Read', { file_path: join(clone, 'a.ts') }, clone, `q${i}`);
    expect(payloads('run.flag')).toEqual([]);
  });

  it('gives a new run the rules alex confirmed for its repository, never the tester’s', async () => {
    const rule = (factId: string, statement: string, origin: 'you' | 'tester', repos?: string[]) =>
      log.append('elfoqsy', 'memory.saved', { factId, statement, sources: [], freshUntil: '2036-01-01T00:00:00.000Z', origin, kind: 'rule', ...(repos ? { repos } : {}) });
    rule('r1', 'Never touch src/generated.', 'you', [SHOP_API]);
    rule('r2', 'Keep commits small.', 'you');
    rule('r3', 'Only for the orchestrator repo.', 'you', ['acme/shop-infra']);
    rule('r4', 'A tester rule.', 'tester', [SHOP_API]);
    log.append('elfoqsy', 'memory.saved', { factId: 'r5', statement: 'Forgotten.', sources: [], freshUntil: '2036-01-01T00:00:00.000Z', origin: 'you', kind: 'rule' });
    log.append('elfoqsy', 'memory.forgotten', { factId: 'r5', by: 'you' });
    const { session } = await spawn();
    const prompt = session.sent[0]!;
    expect(prompt).toContain("- Never touch src/generated. (alex's rule from earlier guidance)\n- Keep commits small. (alex's rule from earlier guidance)\n- Work only inside this folder.");
    expect(prompt).not.toMatch(/orchestrator repo|A tester rule|Forgotten/);
    expect(payloads('run.created').at(-1)).toMatchObject({ repos: [SHOP_API] });
  });
});
