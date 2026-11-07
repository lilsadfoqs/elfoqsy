// v1.3 for agents: sub-agent tools by role, enforced on every call (item 11); the web for agents, checked before a
// request leaves (item 12); questions only as a card (item 3) that withdraws itself after 72 hours and pauses the run
// (item 13); a file ask inside the run folder decided by Elfoqsy (item 7); task agents (item 9); the agents-at-once
// setting (item 8). Real git, a fake SDK; nothing leaves the test.
import { Mirrors } from '../src/agents/mirrors';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseTool, HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, EventType, PayloadOf, Ticket } from '@elfoqsy/contracts';
import { Git } from '../src/agents/git';
import { Orchestrator, type OrchestratorDeps } from '../src/agents/orchestrator';
import type { RepoPolicy } from '../src/agents/repoPolicy';
import { ASK_DEADLINE_MS, RUN_TOOL_TIMEOUT_MS } from '../src/agents/run';
import { UsageState } from '../src/claude/usage';
import { AWAY_MS } from '../src/decisions/digest';
import { LiveState } from '../src/elfoqsy/liveState';
import { language } from '../src/elfoqsy/voice';
import { Conversations } from '../src/elfoqsy/routing';
import { orchestratorHandlers, type SessionContext } from '../src/elfoqsy/tools';
import { EventLog } from '../src/eventLog';
import type { OutboundContext } from '../src/redact';
import { ManualClock, fakeSdk, result, runTool, text, tick } from './helpers/fakeSdk';
import { gitEnv, gitWorld, type GitWorld } from './helpers/realGit';
import { environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const KEY = 'SHOP-3546';
const T0 = Date.parse('2026-10-13T08:00:00Z');

const ticket = (key: string): Ticket => ({
  key,
  board: 'SHOP',
  summary: 'Payment provider errors are dropped',
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 2,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 1,
  epic: null,
  reporter: 'r',
  created: '8 Oct 2026',
  updated: '8 Oct 2026',
  labels: [],
  linked: [],
  description: 'Checkout gets payment provider errors without error_code: it stays nested in details.',
});

const apiPolicy: RepoPolicy = { needs: [], setup: [], unitTests: ['npm run test:unit'], allowedTestCommands: ['npm run test:unit'], testsIn: 'local', notes: '' };

let world: GitWorld;
let log: EventLog;
let live: LiveState;
let usage: UsageState;
let clock: ManualClock;
let sdk: ReturnType<typeof fakeSdk>;
let backends: FakeBackends;
let orchestrator: Orchestrator;

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);

const outbound = (): OutboundContext => ({
  internalHosts: ['acme.atlassian.net', 'api.us1.coralogix.com'],
  repos: [SHOP_API],
  localRoots: [world.root],
  inClones: (path) => path === 'src/map.ts',
});

function build(overrides: Partial<OrchestratorDeps> = {}): void {
  orchestrator = new Orchestrator({
    log,
    live,
    usage,
    git: new Git(undefined, gitEnv),
    environments,
    backends,
    queryFn: sdk.queryFn,
    config: {
      GITHUB_REPOS: [SHOP_API],
      MAX_PARALLEL_AGENTS: 6,
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
    home: world.root,
    outbound: outbound(),
    clock,
    now: () => clock.now,
    ...overrides,
  });
}

beforeEach(() => {
  world = gitWorld();
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  log.append('jira', 'ticket.synced', { ticket: ticket(KEY) });
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3600') });
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

type Session = ReturnType<typeof fakeSdk>['sessions'][number];

async function spawn(args: { ticketKey?: string; test?: boolean } = {}) {
  const r = await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], ...args });
  if (!('runId' in r)) throw new Error(JSON.stringify(r));
  await tick();
  const runRoot = payloads('run.created').at(-1)!.worktree;
  return { ...r, session: sdk.sessions.at(-1)!, runRoot, clone: join(runRoot, 'shop-api') };
}

const hook = (session: Session, name: string) => (input: Record<string, unknown>) =>
  (session.options.hooks as Record<string, Array<{ hooks: HookCallback[] }>>)[name]![0]!.hooks[0]!({ hook_event_name: name, session_id: 's', transcript_path: '', ...input } as unknown as HookInput, undefined, { signal: new AbortController().signal });

async function gate(session: Session, tool_name: string, tool_input: Record<string, unknown>, cwd: string, extra: Record<string, unknown> = {}, id = `t-${Math.random()}`) {
  const out = (await hook(session, 'PreToolUse')({ tool_name, tool_input, tool_use_id: id, cwd, ...extra })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } };
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason ?? '' };
}
const tool = (session: Session, name: string, args: Record<string, unknown>) => runTool(session.options as Options, name, args);
const start = (session: Session, agent_id: string, agent_type: string) => hook(session, 'SubagentStart')({ agent_id, agent_type });

describe('sub-agent tools by role, enforced on every call (item 11)', () => {
  it('refuses the reviewer a PR through gh, edits and any shell at all; lets it read files', async () => {
    const { session, clone } = await spawn();
    await start(session, 'rev-1', 'reviewer');
    const as = { agent_id: 'rev-1', agent_type: 'reviewer' };
    expect(await gate(session, 'mcp__run__gh', { args: ['pr', 'create', '--repo', SHOP_API, '--title', 'x', '--body', 'y'] }, clone, as)).toEqual({
      decision: 'deny',
      reason: "The reviewer has no run tools and no proxies (gh, jira, kube and the rest are the ticket agent's): report what is needed in your result instead.",
    });
    expect(await gate(session, 'Edit', { file_path: join(clone, 'src/map.ts'), old_string: 'a', new_string: 'b' }, clone, as)).toEqual({ decision: 'deny', reason: 'The reviewer reads only: no edits.' });
    // No shell, not even a read: it is not offered one (subagents.ts), and this is the second check.
    const noShell = 'The reviewer has no shell and nothing that writes: it may use Read, Grep, Glob, LS only.';
    for (const command of ['sed -i s/a/b/ src/map.ts', 'git diff master...HEAD --stat', 'cat README.md', 'ls', 'git diff master > /tmp/review.diff']) {
      expect(await gate(session, 'Bash', { command }, clone, as), command).toEqual({ decision: 'deny', reason: noShell });
    }
    for (const tool of ['BashOutput', 'KillShell', 'KillBash', 'TodoWrite']) expect(await gate(session, tool, {}, clone, as), tool).toEqual({ decision: 'deny', reason: noShell });
    expect(await gate(session, 'WebFetch', { url: 'https://docs.github.com', prompt: 'x' }, clone, as)).toEqual({ decision: 'deny', reason: 'The reviewer has no web.' });
    expect(await gate(session, 'Read', { file_path: join(clone, 'README.md') }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Grep', { pattern: 'x', path: clone }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Glob', { pattern: 'src/**/*.ts' }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'LS', { path: clone }, clone, as)).toMatchObject({ decision: 'allow' });
  });

  it("lets the reviewer read the ticket's handoff and acceptance criteria, and nothing in that folder can be written by it", async () => {
    const { session, clone, runRoot } = await spawn();
    await start(session, 'rev-2', 'reviewer');
    const as = { agent_id: 'rev-2', agent_type: 'reviewer' };
    const pack = join(runRoot, '.elfoqsy', 'review');
    for (const name of ['handoff.md', 'acceptance-criteria.md']) expect(await gate(session, 'Read', { file_path: join(pack, name) }, clone, as), name).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'LS', { path: pack }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Grep', { pattern: 'error_code', path: pack }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Edit', { file_path: join(pack, 'acceptance-criteria.md'), old_string: 'a', new_string: 'b' }, clone, as)).toEqual({ decision: 'deny', reason: 'The reviewer reads only: no edits.' });
    expect(await gate(session, 'Write', { file_path: join(pack, 'handoff.md'), content: 'x' }, clone, as)).toEqual({ decision: 'deny', reason: 'The reviewer reads only: no edits.' });
    // A worker is no more able to change it than the ticket agent is.
    await start(session, 'w-9', 'sonnet-5.5-high');
    expect(await gate(session, 'Write', { file_path: join(pack, 'handoff.md'), content: 'x' }, clone, { agent_id: 'w-9', agent_type: 'sonnet-5.5-high' })).toMatchObject({ decision: 'deny' });
  });

  it("refuses a worker ask_user and the proxies, and lets it read, edit and run commands in the run folder", async () => {
    const { session, clone } = await spawn();
    await tool(session, 'report_understanding', { claim: 'without error_code: it stays nested in details', input: 'i', actual: 'a', expected: 'e', sources: [{ kind: 'ticket', ref: KEY }] });
    await tool(session, 'report_verdict', { verdict: 'VALID', reproduced: true, summary: 's', symptom: 'without error_code: it stays nested in details', sibling: 'The warning path lifts it.', siblingAt: { kind: 'code', ref: 'shop-api/src/map.ts:31' }, chain: [{ ref: 'shop-api/src/map.ts:44', role: 'fault' }], findings: [{ text: 't', sources: [{ kind: 'code', ref: 'shop-api/test/map.test.ts:12' }] }] });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    await start(session, 'w-1', 'sonnet-5.5-high');
    const as = { agent_id: 'w-1', agent_type: 'sonnet-5.5-high' };
    expect(await gate(session, 'mcp__run__ask_user', { question: 'x?' }, clone, as)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('A worker has no run tools and no proxies') });
    expect(await gate(session, 'mcp__run__kube', { args: ['get', 'pods'] }, clone, as)).toMatchObject({ decision: 'deny' });
    expect(await gate(session, 'Agent', { subagent_type: 'haiku-5.5-low', prompt: 'x' }, clone, as)).toEqual({ decision: 'deny', reason: 'A worker cannot start sub-agents.' });
    expect(await gate(session, 'WebSearch', { query: 'jest config' }, clone, as)).toEqual({ decision: 'deny', reason: 'A worker has no web.' });
    expect(await gate(session, 'Edit', { file_path: join(clone, 'src/map.ts'), old_string: 'a', new_string: 'b' }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Bash', { command: 'npm run test:unit' }, clone, as)).toMatchObject({ decision: 'allow' });
    // The ticket agent itself keeps its tools.
    expect(await gate(session, 'mcp__run__kube', { args: ['get', 'pods'] }, clone)).toMatchObject({ decision: 'allow' });
  });

  it("refuses a worker a push and anything outside the run folder, where the ticket agent would be asked", async () => {
    const { session, clone } = await spawn();
    await start(session, 'w-2', 'sonnet-5.5-high');
    const as = { agent_id: 'w-2', agent_type: 'sonnet-5.5-high' };
    expect(await gate(session, 'Bash', { command: 'git push origin HEAD' }, clone, as)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('A sub-agent works inside the run folder only') });
    writeFileSync(join(world.root, 'notes.txt'), 'his');
    expect(await gate(session, 'Read', { file_path: join(world.root, 'notes.txt') }, clone, as)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('A sub-agent works inside the run folder only') });
    // A shell command outside the run folder is not asked of anyone any more (v1.5): it runs in the sandbox, the same one for the
    // ticket agent and its sub-agents, which decides what it may reach. The file tools are not in it, and stay refused.
    expect(await gate(session, 'Bash', { command: `cat ${join(world.root, 'notes.txt')}` }, clone, as)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Write', { file_path: join(world.root, 'out.txt'), content: 'x' }, clone, as)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('A sub-agent works inside the run folder only') });
    // Through canUseTool too, which the SDK may call without the hook's decision.
    const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: 'r', agentID: 'w-2' });
    expect(await (session.options.canUseTool as CanUseTool)('Read', { file_path: join(world.root, 'notes.txt') }, opts('w-read'))).toMatchObject({ behavior: 'deny' });
    expect(payloads('approval.requested')).toEqual([]);
  });

  it('gives a sub-agent it does not know the strictest role', async () => {
    const { session, clone } = await spawn();
    expect(await gate(session, 'Edit', { file_path: join(clone, 'src/map.ts'), old_string: 'a', new_string: 'b' }, clone, { agent_id: 'who-1', agent_type: 'general-purpose' })).toEqual({ decision: 'deny', reason: 'The reviewer reads only: no edits.' });
  });
});

describe("commands reach only the sandbox's hosts, for every kind of agent (v1.3.1)", () => {
  const ask = (session: Session, host: string, agentID?: string) =>
    (session.options.canUseTool as CanUseTool)('SandboxNetworkAccess', { host }, { signal: new AbortController().signal, toolUseID: `net-${Math.random()}`, requestId: 'r', ...(agentID ? { agentID } : {}) });
  const refused = (host: string) => ({ behavior: 'deny', message: expect.stringContaining(`${host} is not one of the hosts commands may reach (registry.npmjs.org,`) });
  const SANDBOX = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: ['registry.npmjs.org', 'registry.yarnpkg.com', 'nodejs.org', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'],
      strictAllowlist: true,
    },
  };

  it('refuses a host off the list for the ticket agent and its sub-agents, and the sandbox refuses it itself', async () => {
    const { session } = await spawn();
    expect(session.options.sandbox).toMatchObject(SANDBOX);
    expect(await ask(session, 'collector.example')).toMatchObject(refused('collector.example'));
    await start(session, 'w-9', 'sonnet-5.5-high');
    expect(await ask(session, '10.0.0.5', 'w-9')).toMatchObject(refused('10.0.0.5'));
    await start(session, 'rev-9', 'reviewer');
    expect(await ask(session, 'evil.example', 'rev-9')).toMatchObject(refused('evil.example'));
    expect(payloads('approval.requested')).toEqual([]);
  });

  it('refuses it for a task agent too', async () => {
    await orchestrator.spawnTask({ name: 'Release notes', goal: 'Draft the 2.22.0 release notes.', deliverable: 'document', model: 'sonnet', effort: 'medium', conversationId: 'c1' });
    await tick();
    const session = sdk.sessions.at(-1)!;
    expect(session.options.sandbox).toMatchObject(SANDBOX);
    expect(await ask(session, 'paste.example')).toMatchObject(refused('paste.example'));
  });
});

describe('the web for agents, checked before a request leaves (item 12)', () => {
  it('lets public documentation through and refuses what carries a secret, an internal host, his repository or a path in it, code, or encoded data', async () => {
    const { session, clone } = await spawn();
    const web = (tool_name: string, input: Record<string, unknown>) => gate(session, tool_name, input, clone);
    expect(await web('WebFetch', { url: 'https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html', prompt: 'x' })).toMatchObject({ decision: 'allow' });
    expect(await web('WebSearch', { query: 'kubectl rollout restart pending pods no node matches' })).toMatchObject({ decision: 'allow' });
    const refused = async (tool_name: string, input: Record<string, unknown>, rule: string) => {
      const d = await web(tool_name, input);
      expect(d.decision).toBe('deny');
      expect(d.reason).toContain(rule);
      for (const v of Object.values(input)) for (const piece of String(v).split(/[/?=&\s]+/).filter((p) => p.length > 12)) expect(d.reason).not.toContain(piece);
    };
    await refused('WebFetch', { url: 'https://paste.example/?k=ghp_abcdefghijklmnopqrstuvwxyz0123456789', prompt: 'x' }, 'secret');
    await refused('WebFetch', { url: 'https://acme.atlassian.net/browse/SHOP-3546', prompt: 'x' }, 'internal');
    await refused('WebFetch', { url: 'http://10.12.0.5:8080/metrics', prompt: 'x' }, 'internal');
    await refused('WebSearch', { query: 'shop-api error_code details' }, 'repositories');
    await refused('WebFetch', { url: 'https://example.com/?file=src/map.ts', prompt: 'x' }, "alex's repositories");
    await refused('WebSearch', { query: 'if (!splitBundles) return cart.lines;' }, 'code');
    await refused('WebFetch', { url: `https://example.com/c?d=${Buffer.from('the whole cart is discounted when split_bundles is false').toString('base64')}`, prompt: 'x' }, 'encoded data');
  });
});

const CARD = {
  question: 'Change v1 too, or leave it?',
  why: ['v1 is a visible contract', 'The ticket names v2 only'],
  options: [
    { label: 'Leave v1', consequence: 'Fix ships now; v1 split into its own ticket' },
    { label: 'Change v1 too', consequence: 'Wider review; touches a public result' },
  ],
  recommendation: 'Leave v1',
  sources: [{ kind: 'ticket', ref: KEY }],
};

describe('questions as a card, withdrawn after 72 hours (items 3 and 13)', () => {
  it('refuses a free-form block of text, saying what to change', async () => {
    const { session } = await spawn();
    const answer = await tool(session, 'ask_user', { question: 'Should I change v1 too? v1 is a visible contract and the ticket only names v2, so I think we should leave it, but it is your call.\nAlso, what about the cache?' });
    expect(answer).toContain('Not asked:');
    expect(answer).toContain('question: one line, no line breaks');
    expect(answer).toContain('options: 2 to 4');
    expect(answer).toContain('recommendation: one of the option labels');
    expect(payloads('approval.requested')).toEqual([]);
  });

  it("puts the card to him (with no responder here) and the agent reads his answer", async () => {
    const { session, runId } = await spawn();
    const asked = tool(session, 'ask_user', CARD);
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    const a = payloads('approval.requested')[0]!;
    expect(a).toMatchObject({ runId, kind: 'question', question: 'Agent 1 on SHOP-3546 asks: Change v1 too, or leave it?', card: CARD, category: 'unsourced', precedentable: true });
    expect(live.get().runs[runId]!.state).toBe('waiting_for_you');
    log.append('orchestrator', 'approval.resolved', { approvalId: a.approvalId, decision: 'answered', answer: 'Leave v1' });
    expect(await asked).toBe('Leave v1');
  });

  it('withdraws a question nobody answered in 72 hours and pauses the run, so the agent never goes on without his answer', async () => {
    const { session, runId } = await spawn();
    // The SDK's own limit on the run's tools is set past the orchestrator's, so the orchestrator's comes first.
    expect(session.options.mcpServers!.run).toMatchObject({ type: 'sdk', name: 'run', timeout: RUN_TOOL_TIMEOUT_MS });
    expect(RUN_TOOL_TIMEOUT_MS).toBe(72 * 3600_000 + 10 * 60_000);
    const asked = tool(session, 'ask_user', CARD);
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    clock.advance(ASK_DEADLINE_MS - 60_000);
    expect(payloads('approval.resolved')).toEqual([]);
    clock.advance(60_000);
    await tick(10);
    expect(payloads('run.paused').at(-1)).toEqual({ runId, by: 'orchestrator', reason: 'Its question went unanswered for 72 hours: withdrawn, and the run paused until you resume it.' });
    expect(payloads('approval.resolved')).toEqual([{ approvalId: payloads('approval.requested')[0]!.approvalId, decision: 'denied', answer: 'Withdrawn after 72 hours without an answer.', withdrawn: true }]);
    expect(await asked).toBe('Withdrawn after 72 hours without an answer; the run is paused until alex resumes it.');
    expect(sdk.interrupt).toHaveBeenCalled();
    session.emit(result()); // the turn the pause cut short
    await tick(10);
    expect(orchestrator.resume(runId, 'you')).toEqual({ ok: true });
    await tick(10);
    expect(session.sent.at(-1)).toBe('Your question to alex went unanswered for 72 hours, so it was withdrawn and you were paused. alex has resumed you. If you still need the answer, ask again; otherwise continue where you left off.');
  });
});

describe('a file ask whose paths resolve inside the run folder (item 7)', () => {
  it('is decided by Elfoqsy: a link in his home that points into the run folder', async () => {
    const { session, runRoot } = await spawn();
    mkdirSync(join(runRoot, '.tmp', 'out'), { recursive: true });
    writeFileSync(join(runRoot, '.tmp', 'out', 'report.txt'), 'ok');
    symlinkSync(join(runRoot, '.tmp', 'out'), join(world.root, 'latest-report'));
    const input = { file_path: join(world.root, 'latest-report', 'report.txt') };
    const d = await gate(session, 'Read', input, runRoot, {}, 'read-1');
    expect(d.decision).toBe('ask');
    const allowed = await (session.options.canUseTool as CanUseTool)('Read', input, { signal: new AbortController().signal, toolUseID: 'read-1', requestId: 'r' });
    expect(allowed).toMatchObject({ behavior: 'allow' });
    expect(payloads('decision.made')).toEqual([expect.objectContaining({ category: 'run_folder', basis: 'delegation', told: false })]);
    expect(payloads('approval.requested')).toEqual([]);
  });

  it("is his when a Glob's pattern climbs out of the folder, whatever its path says", async () => {
    const { session, runRoot } = await spawn();
    const input = { path: runRoot, pattern: '../../**/*.env' };
    expect((await gate(session, 'Glob', input, runRoot, {}, 'glob-1')).decision).toBe('ask');
    const answer = (session.options.canUseTool as CanUseTool)('Glob', input, { signal: new AbortController().signal, toolUseID: 'glob-1', requestId: 'r' });
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    expect(payloads('approval.requested')[0]).toMatchObject({ kind: 'outside_worktree', category: 'other' });
    expect(payloads('decision.made')).toEqual([]);
    log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested')[0]!.approvalId, decision: 'denied' });
    expect(await answer).toMatchObject({ behavior: 'deny' });
  });

  it('still goes to him when a path is outside it', async () => {
    const { session, runRoot } = await spawn();
    writeFileSync(join(world.root, 'notes.txt'), 'his');
    const input = { file_path: join(world.root, 'notes.txt') };
    expect((await gate(session, 'Read', input, runRoot, {}, 'read-2')).decision).toBe('ask');
    const answer = (session.options.canUseTool as CanUseTool)('Read', input, { signal: new AbortController().signal, toolUseID: 'read-2', requestId: 'r' });
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    expect(payloads('approval.requested')[0]).toMatchObject({ kind: 'outside_worktree', category: 'other' });
    log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested')[0]!.approvalId, decision: 'denied' });
    expect(await answer).toMatchObject({ behavior: 'deny' });
  });
});

describe("Elfoqsy's own Jira edits (v1.4), in his language", () => {
  it('tells what she filled, and what he approved, in Vietnamese when his latest message was', async () => {
    language.current = 'vi';
    await orchestrator.elfoqsyJira({ action: 'set_field', key: KEY, field: 'Solution', text: 'Strip an existing scheme.' });
    const made = payloads('decision.made').at(-1)!;
    expect(made).toMatchObject({ category: 'jira_fill', told: true, lang: 'vi' });
    const told = payloads('elfoqsy.message').find((m) => m.blocks?.[0]?.type === 'decision')!;
    expect(told.text).toMatch(/^Tôi đã làm: “.*”: cậu đã giao việc điền trường còn trống của ticket của cậu cho tôi\.$/);
    await orchestrator.elfoqsyJira({ action: 'comment', key: KEY, text: 'Reproduced on dev.' }, 50);
    for (let i = 0; i < 100 && !payloads('approval.requested').some((a) => a.question.startsWith('Elfoqsy wants to comment')); i++) await tick(10);
    const card = payloads('approval.requested').find((a) => a.question.startsWith('Elfoqsy wants to comment'))!;
    log.append('orchestrator', 'approval.resolved', { approvalId: card.approvalId, decision: 'approved' });
    for (let i = 0; i < 100 && !payloads('elfoqsy.message').some((m) => m.text.startsWith('Xong rồi')); i++) await tick(10);
    expect(payloads('elfoqsy.message').some((m) => m.text.startsWith('Xong rồi, như cậu đã duyệt: '))).toBe(true);
  });
});

describe("Elfoqsy's own Jira edits (v1.4)", () => {
  it('fills an empty field of his ticket at once, and asks for a comment without holding her turn', async () => {
    const filled = await orchestrator.elfoqsyJira({ action: 'set_field', key: KEY, field: 'Solution', text: 'Strip an existing scheme.' });
    expect(filled).toMatchObject({ ok: true });
    expect(payloads('decision.made').at(-1)).toMatchObject({ category: 'jira_fill', told: true });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ key: KEY, by: 'elfoqsy', fieldId: 'Solution', ok: true });
    const commented = await orchestrator.elfoqsyJira({ action: 'comment', key: KEY, text: 'Reproduced on dev.' }, 50);
    expect(commented).toEqual({ ok: true, asked: true, text: 'Asked alex: it runs when he approves. Do not ask again.' });
    expect(backends.calls.jira.filter(([op]) => op === 'comment')).toEqual([]);
    for (let i = 0; i < 100 && !payloads('approval.requested').some((a) => a.question.startsWith('Elfoqsy wants to comment')); i++) await tick(10);
    const card = payloads('approval.requested').find((a) => a.question.startsWith('Elfoqsy wants to comment'))!;
    log.append('orchestrator', 'approval.resolved', { approvalId: card.approvalId, decision: 'approved' });
    for (let i = 0; i < 100 && !backends.calls.jira.some(([op]) => op === 'comment'); i++) await tick(10);
    expect(backends.calls.jira.filter(([op]) => op === 'comment')).toEqual([['comment', KEY, 'Reproduced on dev.']]);
    for (let i = 0; i < 100 && !payloads('elfoqsy.message').some((m) => m.text.startsWith('Done, as you approved')); i++) await tick(10);
    expect(payloads('elfoqsy.message').some((m) => m.text.startsWith('Done, as you approved: Commented on'))).toBe(true);
  });
});

describe('Jira news with the digest (v1.4)', () => {
  it('is asked for when he comes back, and when he opens the digest himself, not when the tester does', () => {
    const news: Array<[number, string, boolean]> = [];
    build({ conversations: new Conversations(log, () => live.get(), () => clock.now), jiraNews: (since, c, asked) => news.push([since, c, !!asked]) });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'y1', role: 'you', text: 'Leaving.', conversationId: 'c1' });
    const left = clock.now;
    clock.advance(AWAY_MS + 60_000);
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'y2', role: 'you', text: 'Back.', conversationId: 'c1' });
    expect(news).toEqual([[left, 'c1', false]]);
    orchestrator.openDigest('c1', 'tester');
    expect(news).toHaveLength(1);
    orchestrator.openDigest('c1', 'you');
    expect(news.at(-1)).toEqual([expect.any(Number), 'c1', true]);
  });
});

describe('task agents (item 9)', () => {
  it('runs work he asked for in its own folder, with the model Elfoqsy picked, and ends once it delivers', async () => {
    const r = await orchestrator.spawnTask({ name: 'Integration vs staging', goal: 'Compare the images running on integration and staging; a table of service, integration image, staging image.', deliverable: 'table', model: 'haiku', effort: 'low', conversationId: 'c1' });
    expect(r).toMatchObject({ runId: expect.any(String), agentNumber: 1 });
    await tick();
    const created = payloads('run.created').at(-1)!;
    expect(created).toMatchObject({ ticket: expect.stringMatching(/^task:[0-9a-z]{6}$/), model: 'claude-haiku-5-5', effort: 'low', conversationId: 'c1', task: { name: 'Integration vs staging', deliverable: 'table' } });
    expect(created.worktree).toMatch(/task-integration-vs-staging-/);
    const session = sdk.sessions.at(-1)!;
    expect(session.options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(session.sent[0]).toContain('You are a task agent for alex. Elfoqsy, his assistant, started you for work he asked for: Integration vs staging.');
    expect(session.sent[0]).toContain('Deliver a table, as a Markdown table');
    // No verdict and no pushes for a task.
    expect(await tool(session, 'report_verdict', { verdict: 'VALID', reproduced: false, summary: 's', findings: [{ text: 't', sources: [{ kind: 'ticket', ref: KEY }] }] })).toContain('Tool report_verdict not found');
    expect(await tool(session, 'deliver', { kind: 'document', title: 'x', content: 'y' })).toBe("This task's deliverable is table, not document.");
    expect(await tool(session, 'deliver', { kind: 'table', title: 'Images on integration and staging', content: '| service | integration | staging |\n|---|---|---|\n| shop-api | 2.22.0 | 2.21.3 |' })).toContain('Delivered into the conversation');
    const delivered = payloads('task.delivered')[0]!;
    expect(delivered).toMatchObject({ kind: 'table', title: 'Images on integration and staging' });
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Agent 1 delivered Integration vs staging: Images on integration and staging.', conversationId: 'c1', blocks: [{ type: 'deliverable', ref: delivered.deliverableId }] });
    await tool(session, 'report_result', { result: 'succeeded', summary: 'Compared the two.', notVerified: [], waitingOnYou: [] });
    session.emit(text('Done.'), result());
    for (let i = 0; i < 100 && !payloads('run.state_changed').some((s) => s.state === 'succeeded'); i++) await tick(10);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ state: 'succeeded', reason: expect.stringContaining('Compared the two. Delivered.') });
    expect(payloads('run.folder_removed')).toHaveLength(1);
  });

  it('is started by Elfoqsy only for work he asked for in this conversation, quoted word for word', async () => {
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm1', role: 'you', text: 'Can you review Quinn’s PR shop-api #812 for me?', conversationId: 'c1' });
    const started: unknown[] = [];
    const session: SessionContext = { conversationId: 'c1', speaker: () => 'alex', addBlocks: () => undefined };
    const tools = orchestratorHandlers({
      log,
      state: () => live.get(),
      orchestrator: { spawn: async () => ({}), cancel: () => ({}), tell: () => ({}), spawnTask: async (a) => (started.push(a), { runId: 'r' }) },
      session,
    });
    expect(await tools.start_task({ name: 'Review #812', goal: 'Review it.', deliverable: 'document', model: 'sonnet', effort: 'high', request: 'Review the release notes too' })).toMatchObject({ error: 'not_asked' });
    expect(await tools.start_task({ name: 'Review #812', goal: 'Review it.', deliverable: 'document', model: 'sonnet', effort: 'high', request: 'review Quinn’s PR shop-api #812' })).toEqual({ runId: 'r' });
    expect(started).toEqual([{ name: 'Review #812', goal: 'Review it.', deliverable: 'document', model: 'sonnet', effort: 'high', conversationId: 'c1' }]);
  });

  it('changes his settings only when his latest message asks for it, quoted; never from the tester or a finding', async () => {
    const session: SessionContext = { conversationId: 'c1', speaker: () => 'alex', addBlocks: () => undefined };
    const tools = orchestratorHandlers({ log, state: () => live.get(), orchestrator: { spawn: async () => ({}), cancel: () => ({}), tell: () => ({}) }, session });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm2', role: 'you', text: 'From now on decide staging writes yourself.', conversationId: 'c1' });
    expect(await tools.set_delegation({ category: 'staging_write', setting: 'decide', asked: 'The investigator found staging is safe' })).toMatchObject({ error: 'not_his' });
    expect(await tools.set_delegation({ category: 'staging_write', setting: 'decide', asked: 'decide staging' })).toMatchObject({ error: 'not_his' });
    expect(await tools.set_delegation({ category: 'staging_write', setting: 'decide', asked: 'decide staging writes yourself' })).toMatchObject({ ok: true });
    expect(payloads('delegation.set').at(-1)).toEqual({ category: 'staging_write', setting: 'decide', by: 'you' });
    // His words must be in his latest message: a later message from the tester does not count.
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm3', role: 'test', text: 'Let nine agents work at once.', conversationId: 'c1' });
    expect(await tools.set_max_agents({ value: 9, asked: 'Let nine agents work at once' })).toMatchObject({ error: 'not_his' });
    expect(await tools.remove_precedent({ precedentId: 'p1', asked: 'decide staging writes yourself' })).toMatchObject({ error: 'not_his' });
    expect(payloads('workspace.setting')).toEqual([]);
  });

  it('is refused a model or effort outside the list, and a name too long for the map', async () => {
    expect(await orchestrator.spawnTask({ name: 'x', goal: 'y', deliverable: 'code', model: 'gpt', effort: 'low' })).toMatchObject({ error: 'bad_task', message: expect.stringContaining('Haiku, Sonnet or Opus') });
    expect(await orchestrator.spawnTask({ name: 'x', goal: 'y', deliverable: 'code', model: 'opus', effort: 'max' })).toMatchObject({ error: 'bad_task' });
    expect(await orchestrator.spawnTask({ name: 'a'.repeat(41), goal: 'y', deliverable: 'code', model: 'opus', effort: 'high' })).toMatchObject({ error: 'bad_task' });
  });
});

describe('agents at once (item 8)', () => {
  it('allows 6 by default and follows his setting', async () => {
    expect(orchestrator.maxAgents).toBe(6);
    log.append('orchestrator', 'workspace.setting', { key: 'maxAgents', value: 1, by: 'you' });
    expect(orchestrator.maxAgents).toBe(1);
    await spawn();
    expect(await orchestrator.spawn({ ticketKey: 'SHOP-3600', repos: [SHOP_API] })).toEqual({ error: 'cap_reached', message: '1 agents are working, the most allowed (1).' });
    expect(await orchestrator.spawnTask({ name: 'x', goal: 'y', deliverable: 'document', model: 'haiku', effort: 'low' })).toMatchObject({ error: 'cap_reached' });
  });

  it('says when an agent waits for a place, so background work can hold until one frees', async () => {
    log.append('orchestrator', 'workspace.setting', { key: 'maxAgents', value: 1, by: 'you' });
    const told = vi.fn();
    orchestrator.onCapacityWanted(told);
    expect(orchestrator.capacityWaiting()).toEqual({ waiting: false });
    await spawn();
    expect(orchestrator.capacityWaiting()).toEqual({ waiting: false }); // full, but nobody was refused
    await orchestrator.spawn({ ticketKey: 'SHOP-3600', repos: [SHOP_API] });
    expect(told).toHaveBeenCalledTimes(1);
    expect(orchestrator.capacityWaiting()).toEqual({ waiting: true, detail: 'An agent for SHOP-3600 is waiting: 1 agents are working, the most allowed (1).' });
    // A place frees (his setting here; a run ending does the same): nobody waits any more.
    log.append('orchestrator', 'workspace.setting', { key: 'maxAgents', value: 2, by: 'you' });
    expect(orchestrator.capacityWaiting()).toEqual({ waiting: false });
  });
});
