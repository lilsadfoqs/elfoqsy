// Milestone 15 with v1.2.1 (brief-v1.2/docs/ticket-workflow.md, alex's answers of 11 October): Elfoqsy hands a
// ticket over and the ticket agent owns it, held by the orchestrator to the verdict gate, the run's mode, his team's
// conventions and the rules his team-dev retrospective showed get skipped. Real git, a fake SDK; nothing leaves the test.
import { Mirrors } from '../src/agents/mirrors';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanUseTool, HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, EventType, PayloadOf, Ticket } from '@elfoqsy/contracts';
import { buildNarrative } from '@elfoqsy/state';
import { Git, TRAILER, agentGitEnv } from '../src/agents/git';
import { Orchestrator, RUN_MARKER, type OrchestratorDeps } from '../src/agents/orchestrator';
import type { RepoPolicy } from '../src/agents/repoPolicy';
import { UsageState } from '../src/claude/usage';
import { ElfoqsySession } from '../src/elfoqsy/session';
import { language } from '../src/elfoqsy/voice';
import { orchestratorServer } from '../src/elfoqsy/tools';
import { LiveState } from '../src/elfoqsy/liveState';
import { EventLog } from '../src/eventLog';
import { sectionHashes, skillHash } from '../src/skill/teamSkill';
import { ManualClock, fakeSdk, result, runTool, text, tick } from './helpers/fakeSdk';
import { gitEnv, gitWorld, type GitWorld } from './helpers/realGit';
import { environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const KEY = 'SHOP-3546';
const T0 = Date.parse('2026-10-11T08:00:00Z');

const ticket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  board: key.split('-')[0]!,
  summary: 'Payment provider errors are dropped',
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
  description: 'Checkout gets payment provider errors without error_code: it stays nested in details.',
  ...overrides,
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
let ticketsRoot: string;
let skillDir: string;
/** Bot-review rounds on the run's PR, as its reviews would say. */
let rounds = 0;

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const said = () => payloads('elfoqsy.message').filter((m) => m.role === 'elfoqsy').map((m) => m.text);

/** alex's team-dev skill, small: SKILL.md, its writing rules and environment facts, the case template. */
function writeSkill(dir: string): void {
  mkdirSync(join(dir, 'references'), { recursive: true });
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: team-dev\ndisable-model-invocation: true\n---\n\n# Acme Shop Dev\n\nInvocation: `$ARGUMENTS`\n\n## Entry and scope\n\nRead the ticket first.\n');
  writeFileSync(join(dir, 'references', 'writing.md'), '# Writing rules\n\n- Lead with the result, then the evidence.\n');
  writeFileSync(join(dir, 'references', 'environments.md'), '# Lower environments\n\n| Environment | Use |\n|---|---|\n| Dev | Developer builds. |\n\n## Access\n\n- Pass `--context <arn>` on every kubectl call.\n');
  writeFileSync(join(dir, 'templates', 'case.md'), '# SHOP-XXXX\n');
}

function build(overrides: Partial<OrchestratorDeps> = {}): void {
  const deps: OrchestratorDeps = {
    log,
    live,
    usage,
    git: new Git(undefined, gitEnv),
    environments,
    backends,
    queryFn: sdk.queryFn,
    config: {
      GITHUB_REPOS: [SHOP_API],
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
    home: world.root,
    tickets: { root: ticketsRoot, codeRoot: world.reposRoot, testRoot: join(world.root, 'test-tickets') },
    prReviewRounds: async () => rounds,
    skill: { dir: skillDir, adapterFile: join(world.root, 'skill-adapter.md'), manifestFile: join(world.root, 'skill-adapter.json') },
    clock,
    now: () => clock.now,
    ...overrides,
  };
  orchestrator = new Orchestrator(deps);
}

beforeEach(() => {
  world = gitWorld();
  ticketsRoot = join(world.root, 'tickets');
  skillDir = join(world.root, 'skills', 'team-dev');
  writeSkill(skillDir);
  rounds = 0;
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  log.append('jira', 'ticket.synced', { ticket: ticket(KEY) });
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3600', { type: 'Story', summary: 'Show the shipping options' }) });
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

async function spawn(args: { ticketKey?: string; test?: boolean; handoffId?: string; confirmManual?: boolean } = {}) {
  const r = await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], ...args });
  if (!('runId' in r)) throw new Error(JSON.stringify(r));
  await tick();
  const runRoot = payloads('run.created').at(-1)!.worktree;
  return { ...r, session: sdk.sessions.at(-1)!, runRoot, clone: join(runRoot, 'shop-api') };
}

const hook = (session: Session, name: string) => (input: Record<string, unknown>) =>
  (session.options.hooks as Record<string, Array<{ hooks: HookCallback[] }>>)[name]![0]!.hooks[0]!({ hook_event_name: name, session_id: 's', transcript_path: '', ...input } as unknown as HookInput, undefined, { signal: new AbortController().signal });

/** The gate's answer to a tool call, and why. */
async function gate(session: Session, tool_name: string, tool_input: Record<string, unknown>, cwd: string, id = `t-${Math.random()}`) {
  const out = (await hook(session, 'PreToolUse')({ tool_name, tool_input, tool_use_id: id, cwd })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } };
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason ?? '' };
}

const edit = (session: Session, path: string, cwd: string) => gate(session, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, cwd);
/** Sessions whose agent has reported its understanding of the ticket, which a verdict comes after (N1). */
const understood = new WeakSet<Session>();
const UNDERSTANDING = { claim: 'without error_code: it stays nested in details', input: 'a provider error with error_code in details', actual: 'error_code stays nested in details', expected: 'error_code at the top of the result', sources: [{ kind: 'ticket', ref: KEY }] };
async function tool(session: Session, name: string, args: Record<string, unknown>) {
  if (name === 'report_verdict' && !understood.has(session)) {
    understood.add(session);
    await runTool(session.options as Options, 'report_understanding', UNDERSTANDING);
  }
  return runTool(session.options as Options, name, args);
}

const BUG = {
  verdict: 'VALID',
  summary: 'error_code stays nested in details.',
  symptom: 'without error_code: it stays nested in details',
  sibling: 'The warning path in the same mapper lifts error_code; the error path does not.',
  siblingAt: { kind: 'code', ref: 'shop-api/src/map.ts:31' },
  chain: [
    { ref: 'shop-api/src/map.ts:12', role: 'entry' },
    { ref: 'shop-api/src/map.ts:44', role: 'fault', note: 'the error path keeps error_code nested' },
  ],
  findings: [{ text: 'A new test fails: error_code is missing at the top.', sources: [{ kind: 'code', ref: 'shop-api/test/map.test.ts:12' }] }],
};

/** A commit in a run's clone at the run's own time, so it counts as the agent's. */
function commit(clone: string, file: string, message: string): void {
  const date = `@${Math.floor(clock.now / 1000)} +0000`;
  const env = { ...process.env, ...agentGitEnv(world.clone.identity), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  writeFileSync(join(clone, file), `${file} ${Math.random()}\n`);
  execFileSync('git', ['add', '.'], { cwd: clone, env });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: clone, env });
}

async function push(session: Session, clone: string, id: string) {
  await gate(session, 'Bash', { command: 'git push' }, clone, id);
  return (session.options.canUseTool as CanUseTool)('Bash', { command: 'git push' }, { signal: new AbortController().signal, toolUseID: id, requestId: 'r' });
}

async function reviewed(session: Session, found: { contract: string; cacheBypass: string; criteria?: string[] } = { contract: 'none', cacheBypass: 'none' }): Promise<void> {
  await hook(session, 'SubagentStart')({ agent_id: 'review-1', agent_type: 'reviewer' });
  await hook(session, 'SubagentStop')({
    agent_id: 'review-1',
    agent_type: 'reviewer',
    last_assistant_message: `No Blocker or Major.\nCONTRACT: ${found.contract}\nCACHE_BYPASS: ${found.cacheBypass}\n${found.criteria ? found.criteria.join('\n') : 'CRITERIA: none stated'}\nRESULT: success`,
    stop_hook_active: false,
  });
}

/** Answers the latest open question of a kind, as alex (or the tester). */
async function answer(kind: string, decision: 'approved' | 'denied', extra: { test?: true; answer?: string } = {}): Promise<void> {
  for (let i = 0; i < 100 && !payloads('approval.requested').some((a) => a.kind === kind && !payloads('approval.resolved').some((r) => r.approvalId === a.approvalId)); i++) await tick(10);
  const open = payloads('approval.requested').filter((a) => a.kind === kind && !payloads('approval.resolved').some((r) => r.approvalId === a.approvalId)).at(-1)!;
  log.append('orchestrator', 'approval.resolved', { approvalId: open.approvalId, decision, ...extra });
  await tick(10);
}

describe('the verdict gate: no code before the verdict, and then only what the verdict allows', () => {
  it('refuses every edit and commit in the repositories before the verdict; scratch files and the ticket folder are free; the skill copy never', async () => {
    const { session, runRoot, clone } = await spawn();
    expect(await edit(session, join(clone, 'src/map.ts'), clone)).toEqual({ decision: 'deny', reason: expect.stringContaining('Report your verdict first (report_verdict), before any code change.') });
    expect(await edit(session, join(clone, 'test/map.test.ts'), clone)).toMatchObject({ decision: 'deny' });
    expect(await gate(session, 'Bash', { command: 'git commit -m "SHOP-3546: x"' }, clone)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Report your verdict first') });
    expect(await gate(session, 'Write', { file_path: join(runRoot, '.tmp', 'notes.md'), content: 'x' }, clone)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Write', { file_path: join(ticketsRoot, KEY, 'case.md'), content: 'x' }, clone)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Read', { file_path: join(ticketsRoot, KEY, 'case.md') }, clone)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Write', { file_path: join(runRoot, '.elfoqsy', 'team-dev', 'SKILL.md'), content: 'x' }, clone)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('read-only copy') });
    // Its sandbox may write the ticket folder too.
    expect((session.options as Options).sandbox!.filesystem!.allowWrite).toContain(join(ticketsRoot, KEY));
  });

  it('a bug: test files only until the reported symptom is reproduced, then code once the input classes are declared, with the ruleset in front of it', async () => {
    const { session, clone } = await spawn();
    mkdirSync(join(clone, '.agents', 'skills', 'pr-review'), { recursive: true });
    writeFileSync(join(clone, '.agents', 'skills', 'pr-review', 'RULESET.md'), '# CI review ruleset\n- Never swallow an error code.\n');
    const first = await tool(session, 'report_verdict', { ...BUG, reproduced: false });
    expect(first).toContain('Verdict recorded: VALID, not reproduced yet.');
    expect(first).toContain('### acme/shop-api/.agents/skills/pr-review/RULESET.md\n# CI review ruleset\n- Never swallow an error code.');
    expect(await edit(session, join(clone, 'test/map.test.ts'), clone)).toMatchObject({ decision: 'allow' });
    expect(await edit(session, join(clone, 'src/map.ts'), clone)).toEqual({ decision: 'deny', reason: expect.stringContaining('VALID, not reproduced yet: only test files until it is') });
    expect(await tool(session, 'report_verdict', { ...BUG, reproduced: true })).toContain('Verdict recorded: VALID, reproduced.');
    expect(await edit(session, join(clone, 'src/map.ts'), clone)).toEqual({ decision: 'deny', reason: expect.stringContaining('declare every input class the change will see (declare_inputs)') });
    expect(await tool(session, 'declare_inputs', { classes: ['an error with error_code in details', 'a success', 'a timeout result'] })).toBe('Recorded 3 input classes. You may change code now.');
    expect(await edit(session, join(clone, 'src/map.ts'), clone)).toMatchObject({ decision: 'allow' });
    expect(payloads('run.verdict').map((v) => [v.verdict, v.reproduced])).toEqual([
      ['VALID', false],
      ['VALID', true],
    ]);
    expect(payloads('run.inputs_declared')).toEqual([{ runId: expect.any(String), classes: ['an error with error_code in details', 'a success', 'a timeout result'] }]);
    // Elfoqsy posted each in chat; the first with the block, which shows the latest.
    const lines = payloads('elfoqsy.message').filter((m) => m.text.includes('verdict on SHOP-3546'));
    // The first is one line with a link into the ticket's narrative, at its verdict (N1); a later report of it is a plain line.
    expect(lines.map((m) => [m.text, m.blocks ?? []])).toEqual([
      ['Agent 1 reached its verdict on SHOP-3546: VALID, not reproduced yet. error_code stays nested in details. Nothing waits for you.', [{ type: 'narrative', ref: expect.any(String), section: 2 }]],
      ["Agent 1's verdict on SHOP-3546: VALID, reproduced.", []],
    ]);
  });

  it('says the verdict in Vietnamese, with tôi and cậu, when his latest message was in Vietnamese', async () => {
    language.current = 'vi';
    const { session } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: false });
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    const lines = payloads('elfoqsy.message').filter((m) => m.text.includes('SHOP-3546') && /[Kk]ết luận/.test(m.text));
    expect(lines.map((m) => [m.text, m.blocks ?? []])).toEqual([
      ['Agent 1 đã có kết luận về SHOP-3546: VALID, chưa tái hiện được. error_code stays nested in details. Không có gì đang chờ cậu.', [{ type: 'narrative', ref: expect.any(String), section: 2 }]],
      ['Kết luận của Agent 1 về SHOP-3546: VALID, đã tái hiện được.', []],
    ]);
  });

  it("refuses a verdict whose symptom is not the ticket's own words, without a working case to compare, or without evidence", async () => {
    const { session } = await spawn();
    expect(await tool(session, 'report_verdict', { ...BUG, reproduced: true, symptom: 'the cache drops the error' })).toContain('symptom must be quoted from the ticket, word for word');
    expect(await tool(session, 'report_verdict', { ...BUG, reproduced: true, sibling: 'none' })).toContain('Compare with a similar case that works (sibling)');
    expect(await tool(session, 'report_verdict', { ...BUG, reproduced: true, findings: [{ text: 'It fails.', sources: [{ kind: 'ticket', ref: KEY }] }] })).toContain('Reproduced needs what shows it');
    expect(payloads('run.verdict')).toEqual([]);
  });

  it('EXPECTED_BEHAVIOR/INVALID stops the run when its turn ends; Elfoqsy says so with the default, a Jira comment asked of alex', async () => {
    const { session, runId } = await spawn();
    expect(await tool(session, 'report_verdict', { verdict: 'EXPECTED_BEHAVIOR/INVALID', reproduced: false, summary: 'Errors stay in details by design.', findings: BUG.findings })).toContain(
      'Say what you propose to post on the ticket (ticketComment',
    );
    const comment = 'This is by design: errors stay in details (shop-api/src/map.ts:40).';
    expect(await tool(session, 'report_verdict', { verdict: 'EXPECTED_BEHAVIOR/INVALID', reproduced: false, summary: 'Errors stay in details by design.', ticketComment: comment, findings: BUG.findings })).toContain(
      'No code changes: the run stops when this turn ends.',
    );
    session.emit(text('Errors stay in details by design.\nNothing to change.'), result());
    // The run's end runs git on its folder: wait for it rather than a fixed time, as the suite runs under load.
    for (let i = 0; i < 200 && payloads('run.state_changed').at(-1)?.state !== 'stopped'; i++) await tick(10);
    expect(payloads('run.state_changed').at(-1)).toEqual({ runId, state: 'stopped', reason: expect.stringMatching(/^Its verdict: EXPECTED_BEHAVIOR\/INVALID\. Errors stay in details by design\. /) });
    expect(said()).toContain('Agent 1 stopped after its verdict on SHOP-3546: EXPECTED_BEHAVIOR/INVALID. I propose to update SHOP-3546 to say it is the expected behaviour, with the comment it wrote; approve it to post it, or not.');
    // Through Elfoqsy first (v1.3), so wait for the card rather than a fixed time: the suite runs under load.
    for (let i = 0; i < 100 && !payloads('approval.requested').length; i++) await tick(10);
    const asked = payloads('approval.requested').at(-1)!;
    expect(asked).toMatchObject({ runId, kind: 'action', tier: 2, grantable: { kind: 'jira.comment' } });
    expect(asked.question).toContain(comment.slice(0, 40));
    expect(backends.calls.jira.filter(([op]) => op === 'comment')).toEqual([]); // not before he says so
  });

  it('a verdict that stops the run: her line and the default in Vietnamese', async () => {
    language.current = 'vi';
    const { session, runId } = await spawn();
    const comment = 'This is by design: errors stay in details (shop-api/src/map.ts:40).';
    await tool(session, 'report_verdict', { verdict: 'EXPECTED_BEHAVIOR/INVALID', reproduced: false, summary: 'Errors stay in details by design.', ticketComment: comment, findings: BUG.findings });
    session.emit(text('Errors stay in details by design.\nNothing to change.'), result());
    for (let i = 0; i < 200 && payloads('run.state_changed').at(-1)?.state !== 'stopped'; i++) await tick(10);
    expect(payloads('run.state_changed').at(-1)).toMatchObject({ runId, state: 'stopped' });
    expect(said()).toContain('Agent 1 đã dừng sau khi có kết luận về SHOP-3546: EXPECTED_BEHAVIOR/INVALID. Tôi đề nghị cập nhật SHOP-3546 để ghi rằng đây là hành vi mong đợi, kèm comment nó đã viết; cậu duyệt để đăng, hoặc không.');
  });

  it('a story goes on with its example as a flagged decision: nobody is asked to confirm it first (v1.3)', async () => {
    const { session, clone, runId } = await spawn({ ticketKey: 'SHOP-3600' });
    const story = { verdict: 'NEW_BEHAVIOR', reproduced: false, summary: 'The list is not shown yet.', example: { input: 'GET /shipping-options', output: '200 with the shipping options' }, findings: BUG.findings };
    expect(await tool(session, 'report_verdict', story)).toContain('Your example is recorded under "Decisions I made", flagged for alex to decide at review; go on with it.');
    expect(await edit(session, join(clone, 'test/shipping-options.test.ts'), clone)).toMatchObject({ decision: 'allow' });
    expect(payloads('approval.requested').filter((a) => a.kind === 'example')).toEqual([]);
    expect(payloads('run.assumption')).toEqual([
      { runId, assumptionId: expect.any(String), text: 'Expected behaviour: GET /shipping-options -> 200 with the shipping options', evidence: BUG.findings[0]!.sources, flag: 'expected_behaviour', by: 'agent' },
    ]);
    expect(said().at(-1)).toBe('Agent 1 reached its verdict on SHOP-3600: NEW_BEHAVIOR. The list is not shown yet. Its expected behaviour goes on as a flagged decision, for you to decide at review.');
  });

  it('read-only: no edits, commits, pushes or writes anywhere, the ticket folder included', async () => {
    log.append('elfoqsy', 'handoff.created', { handoffId: 'h-ro', conversationId: 'c1', ticket: KEY, mode: 'read_only', context: [], constraints: [], facts: [] });
    const { session, clone, runId } = await spawn({ handoffId: 'h-ro' });
    expect(live.get().runs[runId]).toMatchObject({ mode: 'read_only', handoffId: 'h-ro' });
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    for (const path of [join(clone, 'src/map.ts'), join(clone, 'test/map.test.ts'), join(ticketsRoot, KEY, 'case.md')]) {
      expect(await edit(session, path, clone)).toEqual({ decision: 'deny', reason: expect.stringContaining('Read-only mode: no edits at all') });
    }
    expect(await gate(session, 'Bash', { command: 'git commit -am x' }, clone)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Read-only mode') });
    expect(await tool(session, 'gh', { args: ['pr', 'create', '--repo', SHOP_API, '--title', 'feature/SHOP-3546: x', '--body', 'see map.ts:3'] })).toBe(
      'Read-only mode: nothing is written to GitHub, Jira or Confluence. Put it in your summary.',
    );
    expect((session.options as Options).sandbox!.filesystem!.allowWrite).not.toContain(join(ticketsRoot, KEY));
    expect(session.sent[0]).toContain('Mode: read-only.');
  });
});

describe("the reviewer's pack: the ticket's handoff and acceptance criteria, read-only, beside the diff", () => {
  const handoff = (mode: 'normal' | 'read_only' = 'normal') =>
    log.append('elfoqsy', 'handoff.created', {
      handoffId: 'h-pack',
      conversationId: 'c1',
      ticket: KEY,
      mode,
      bases: { [SHOP_API]: 'master' },
      context: [{ messageId: 'm1', role: 'you', text: 'keep the v1 path, and do not touch the cache' }],
      constraints: [{ text: 'keep the v1 path', messageId: 'm1' }],
      facts: [],
    });
  const AC = '- A provider error result has error_code at the top.\n- A success result is unchanged.';

  it('writes both into the run folder as they are when the run starts, mode 0444, redacted', async () => {
    handoff();
    build({ acceptanceOf: async (key) => (key === KEY ? AC : undefined) });
    const { runRoot } = await spawn({ handoffId: 'h-pack' });
    const dir = join(runRoot, '.elfoqsy', 'review');
    const handoffMd = readFileSync(join(dir, 'handoff.md'), 'utf8');
    expect(handoffMd).toContain('# The handoff for SHOP-3546');
    expect(handoffMd).toContain('His constraints bind the change');
    expect(handoffMd).toContain('keep the v1 path, and do not touch the cache');
    const criteria = readFileSync(join(dir, 'acceptance-criteria.md'), 'utf8');
    expect(criteria).toContain("## The ticket's Acceptance criteria field\n\n- A provider error result has error_code at the top.\n- A success result is unchanged.");
    expect(criteria).toContain("## The ticket's description\n\nCheckout gets payment provider errors without error_code: it stays nested in details.");
    for (const name of ['handoff.md', 'acceptance-criteria.md']) expect(statSync(join(dir, name)).mode & 0o222, name).toBe(0);
  });

  it('says so when there is no handoff, and when the field is empty or could not be read: the description is then all there is', async () => {
    build({ acceptanceOf: async () => Promise.reject(new Error('Jira is down')) });
    const { runRoot } = await spawn();
    const dir = join(runRoot, '.elfoqsy', 'review');
    expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain('# No handoff for SHOP-3546');
    const criteria = readFileSync(join(dir, 'acceptance-criteria.md'), 'utf8');
    expect(criteria).toContain('(empty, or not read: the description below is then the only statement of what the ticket asks for)');
    expect(criteria).toContain('it stays nested in details');
  });

  it('does not hold the run up for Jira: after a few seconds without the field it starts, and the file says it was not read', async () => {
    build({ acceptanceOf: () => new Promise<string | undefined>(() => undefined) });
    let started = false;
    const spawning = orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API] }).then((r) => ((started = true), r));
    for (let i = 0; i < 500 && !started; i++) {
      await tick(10);
      clock.advance(8000);
    }
    expect(await spawning).toHaveProperty('runId');
    const runRoot = payloads('run.created').at(-1)!.worktree;
    expect(readFileSync(join(runRoot, '.elfoqsy', 'review', 'acceptance-criteria.md'), 'utf8')).toContain('(empty, or not read:');
  });

  it('keeps a key in the ticket’s description out of the files, as it is out of the prompt', async () => {
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3700', { description: 'The key AKIAIOSFODNN7EXAMPLE is in the logs.' }) });
    const r = await orchestrator.spawn({ ticketKey: 'SHOP-3700', repos: [SHOP_API] });
    if (!('runId' in r)) throw new Error(JSON.stringify(r));
    const runRoot = payloads('run.created').at(-1)!.worktree;
    expect(readFileSync(join(runRoot, '.elfoqsy', 'review', 'acceptance-criteria.md'), 'utf8')).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('is not made for a read-only run, which pushes nothing and has no review', async () => {
    handoff('read_only');
    const { runRoot, session } = await spawn({ handoffId: 'h-pack' });
    expect(existsSync(join(runRoot, '.elfoqsy', 'review'))).toBe(false);
    expect(session.sent[0]).not.toContain('acceptance criteria are already in');
  });

  it('is named to the ticket agent: in its instructions and in the push gate’s refusal', async () => {
    const { session, clone, runRoot } = await spawn();
    const dir = join(runRoot, '.elfoqsy', 'review');
    expect(session.sent[0]).toContain(`The ticket's handoff and acceptance criteria are already in ${dir}, written by Elfoqsy and read-only: name that folder too.`);
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    expect(await push(session, clone, 'p1')).toEqual({ behavior: 'deny', message: expect.stringContaining(`The ticket's handoff and acceptance criteria are already in ${dir} (read-only, not yours to change): name that folder too`) });
  });

  it('cannot be changed by the run: the file tools are refused, and a shell’s sandbox makes the folder read-only', async () => {
    const { session, clone, runRoot } = await spawn();
    const dir = join(runRoot, '.elfoqsy', 'review');
    const refused = { decision: 'deny', reason: "The reviewer's pack (the ticket's handoff and acceptance criteria) is read-only; nothing in it may change." };
    expect(await edit(session, join(dir, 'acceptance-criteria.md'), clone)).toEqual(refused);
    expect(await gate(session, 'Write', { file_path: join(dir, 'handoff.md'), content: 'x' }, clone)).toEqual(refused);
    expect(await gate(session, 'Write', { file_path: join(dir, 'new.md'), content: 'x' }, clone)).toEqual(refused);
    // Reading it is free, and the rest of the run folder is as it was.
    expect(await gate(session, 'Read', { file_path: join(dir, 'acceptance-criteria.md') }, clone)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Write', { file_path: join(runRoot, '.tmp', 'notes.md'), content: 'x' }, clone)).toMatchObject({ decision: 'allow' });
    expect((session.options as Options).sandbox!.filesystem!.denyWrite).toContain(dir);
  });

  it('a task agent has none: it has no review', async () => {
    const r = await orchestrator.spawnTask({ name: 'Read shop-api', goal: 'look', deliverable: 'table', model: 'haiku', effort: 'low', repos: [SHOP_API] });
    expect(r).not.toHaveProperty('error');
    await tick();
    const root = payloads('run.created').at(-1)!.worktree;
    expect(existsSync(join(root, '.elfoqsy', 'review'))).toBe(false);
  });
});

describe('an acceptance criterion the review called NOT MET holds the hand-back, not the push (19 October)', () => {
  const CRITERIA = [
    'CRITERION 1: MET | error_code is at the top of an error result | map.ts:44',
    'CRITERION 2: NOT MET | a 429 keeps its details | map.ts:51 drops them',
    'CRITERION 3: CANNOT TELL | a real provider answers | only a run on dev settles it',
  ];
  const WHY = 'The provider rate limit lives in a service this run cannot reach from here.';

  /** A run with a verdict, a draft PR open, and a review that found criterion 2 NOT MET. */
  async function reviewedRun(criteria = CRITERIA) {
    const run = await spawn();
    await tool(run.session, 'report_verdict', { ...BUG, reproduced: true });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 140, state: 'draft', ticket: KEY, url: 'https://github.com/acme/shop-api/pull/140', checks: 'success' } });
    await reviewed(run.session, { contract: 'none', cacheBypass: 'none', criteria });
    return run;
  }
  const endTurn = async (session: Session, said = 'The fix is on the PR.') => {
    session.emit(text(said), result());
    await tick(30);
  };
  const report = (session: Session, args: Record<string, unknown>) => tool(session, 'report_result', { result: 'succeeded', summary: 'Lifted error_code.', notVerified: [], waitingOnYou: ['Mark the PR ready'], ...args });
  const verification = (runId: string) => buildNarrative(live.get(), runId)!.sections.find((x) => x.key === 'verification')!;

  it('records what the review said of each criterion, and does not hold the push for a NOT MET', async () => {
    const { session, clone, runId } = await reviewedRun();
    expect(payloads('run.criteria_reviewed')).toEqual([
      {
        runId,
        criteria: [
          { n: 1, status: 'met', text: 'error_code is at the top of an error result', why: 'map.ts:44' },
          { n: 2, status: 'not_met', text: 'a 429 keeps its details', why: 'map.ts:51 drops them' },
          { n: 3, status: 'cannot_tell', text: 'a real provider answers', why: 'only a run on dev settles it' },
        ],
      },
    ]);
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    expect(await push(session, clone, 'p1')).toEqual({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
  });

  it('does not accept a report that the run succeeded while one is NOT MET and unexplained; a reason by its number does', async () => {
    const { session, runId } = await reviewedRun();
    const refused = await report(session, {});
    expect(refused).toContain('Not recorded: the review found an acceptance criterion NOT MET: 2 (a 429 keeps its details: map.ts:51 drops them).');
    expect(refused).toContain('Meet it and run the review again, or say in unmet why it cannot be met here (its number and why).');
    expect(payloads('run.reported')).toEqual([]);
    // A reason for one the review did not call NOT MET, and one too short to be a reason, are not taken.
    expect(await report(session, { unmet: [{ n: 1, why: WHY }] })).toContain('unmet names 1, which the review did not call NOT MET');
    expect(await report(session, { unmet: [{ n: 2, why: 'no' }] })).toContain('Input validation error');
    expect(payloads('run.reported')).toEqual([]);
    expect(await report(session, { unmet: [{ n: 2, why: WHY }] })).toContain('Recorded.');
    expect(payloads('run.reported')).toEqual([{ runId, result: 'succeeded', summary: 'Lifted error_code.', notVerified: [], waitingOnYou: ['Mark the PR ready'], unmet: [{ n: 2, why: WHY }] }]);
  });

  it('takes a failure or a block as it stands: a run that cannot go on says so whatever is NOT MET', async () => {
    const { session } = await reviewedRun();
    expect(await report(session, { result: 'blocked', summary: 'I cannot go on without the provider sandbox.' })).toContain('Recorded.');
    expect(payloads('run.reported').at(-1)).toMatchObject({ result: 'blocked' });
    await endTurn(session);
    expect(payloads('run.handed_back')).toHaveLength(1); // not held: it said it was blocked
  });

  it('holds the hand-back twice with what is NOT MET, then hands it back saying what is unexplained, and the narrative shows it for him to decide', async () => {
    const { session, runId } = await reviewedRun();
    await endTurn(session, 'Handing back.');
    expect(payloads('run.handed_back')).toEqual([]);
    expect(session.sent.at(-1)).toContain('[From the workspace] Your turn cannot end as a hand-back yet: the review found 1 acceptance criterion NOT MET and you have not said why it cannot be met here.');
    expect(session.sent.at(-1)).toContain('- 2. a 429 keeps its details: map.ts:51 drops them');
    expect(session.sent.at(-1)).toContain('call report_result with unmet: one entry for each, its number and why it cannot be met here.');
    await endTurn(session, 'Handing back.');
    expect(payloads('run.handed_back')).toEqual([]);
    expect(session.sent.filter((m) => m.includes('cannot end as a hand-back yet'))).toHaveLength(2);
    await endTurn(session, 'Handing back.');
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(payloads('run.handed_back')).toEqual([{ runId, message: 'Handing back.\n\nHanded back with 1 acceptance criterion NOT MET and no reason from the agent: 2 (a 429 keeps its details).' }]);
    // Elfoqsy says it in her line, and where to look.
    expect(said().find((t) => t.includes('handed back'))).toContain('One acceptance criterion is NOT MET (2): they are in Verification, for you to decide.');
    // The narrative's Verification has every NOT MET, with no reason from the agent, the one it could not tell, and what was met.
    const section = verification(runId);
    const md = section.markdown;
    expect(md).toContain('Acceptance criteria, as the review judged them (1 met, 1 NOT MET, 1 it could not tell):');
    expect(md).toContain('**NOT MET** 2. a 429 keeps its details: map.ts:51 drops them. The agent gave no reason: for you to decide.');
    expect(md).toContain('Could not tell 3. a real provider answers: only a run on dev settles it');
    expect(md).toContain('Met: 1.');
  });

  it('is not held when the agent says why, and the narrative shows its reason beside the NOT MET', async () => {
    const { session, runId } = await reviewedRun();
    expect(await report(session, { unmet: [{ n: 2, why: WHY }] })).toContain('Recorded.');
    await endTurn(session);
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(session.sent.filter((m) => m.includes('cannot end as a hand-back yet'))).toEqual([]);
    expect(payloads('run.handed_back')[0]!.message).toBe('The fix is on the PR.'); // nothing unexplained to say
    expect(verification(runId).markdown).toContain(`**NOT MET** 2. a 429 keeps its details: map.ts:51 drops them. The agent says it cannot be met here: ${WHY}`);
    // It still goes in her line to him: it is his to decide.
    expect(said().find((t) => t.includes('handed back'))).toContain('NOT MET (2)');
  });

  it('is cleared by a review that finds every criterion met: nothing is held and nothing is NOT MET in Verification', async () => {
    const { session, runId } = await reviewedRun();
    await endTurn(session, 'Handing back.');
    expect(session.sent.filter((m) => m.includes('cannot end as a hand-back yet'))).toHaveLength(1);
    await reviewed(session, { contract: 'none', cacheBypass: 'none', criteria: ['CRITERION 1: MET | error_code is at the top | map.ts:44', 'CRITERION 2: MET | a 429 keeps its details | map.ts:51', 'CRITERION 3: MET | a real provider answers | the dev run in CI'] });
    expect(payloads('run.criteria_reviewed')).toHaveLength(2);
    await endTurn(session, 'Handing back.');
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(payloads('run.handed_back')[0]!.message).toBe('Handing back.');
    expect(verification(runId).markdown).toContain('(3 met, 0 NOT MET, 0 it could not tell)');
    expect(verification(runId).markdown).not.toContain('**NOT MET**');
  });

  it('is not in the plain text the PR description is made from, and only a reason the agent gave puts it there, under "Not verified here"', async () => {
    const { session, runId } = await reviewedRun();
    const narrative = buildNarrative(live.get(), runId)!;
    expect(verification(runId).markdown).toContain('**NOT MET** 2.');
    expect(verification(runId).text).not.toMatch(/NOT MET|criteri/i);
    expect(narrative.sections.map((x) => x.text).join('\n')).not.toMatch(/NOT MET/);
    expect(narrative.explainedUnmet).toEqual([]);
    // Its reason, said with the PR open: the narrative has it for the PR description, and the agent is told to edit the PR so it says so.
    const answer = await report(session, { unmet: [{ n: 2, why: WHY }] });
    expect(answer).toContain('Your reasons for criterion 2 go into the PR description under "Not verified here": edit the PR (gh pr edit with any body; it is written from your reports) so it says so.');
    expect(buildNarrative(live.get(), runId)!.explainedUnmet).toEqual([{ n: 2, text: 'a 429 keeps its details', why: WHY }]);
    expect(buildNarrative(live.get(), runId)!.sections.map((x) => x.text).join('\n')).not.toMatch(/NOT MET/);
  });

  it('says there is none when the ticket states none, and holds nothing', async () => {
    const { session, runId } = await reviewedRun(['CRITERIA: none stated']);
    expect(payloads('run.criteria_reviewed')).toEqual([{ runId, criteria: [] }]);
    await endTurn(session);
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(payloads('run.handed_back')).toHaveLength(1);
    expect(verification(runId).markdown).toContain('Acceptance criteria: the review found none stated in the ticket.');
  });

  it('is said in Vietnamese in her line when his latest message was', async () => {
    language.current = 'vi';
    const { session } = await reviewedRun();
    expect(await report(session, { unmet: [{ n: 2, why: WHY }] })).toContain('Recorded.');
    await endTurn(session);
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(said().find((t) => t.includes('bàn giao'))).toContain('1 tiêu chí nghiệm thu chưa đạt, NOT MET (2): cậu xem ở phần Verification rồi quyết định.');
  });
});

describe('the hand-back: one review before the first push, the key in every subject, three bot-review rounds', () => {
  it('holds the first push for the review, refuses a subject without the key, and asks alex before a fourth round', async () => {
    const { session, clone } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    commit(clone, 'map.ts', 'lift error_code');
    expect(await push(session, clone, 'p1')).toEqual({ behavior: 'deny', message: expect.stringContaining('Before the first push, run one fresh-context review: the Agent tool with subagent_type reviewer') });
    await reviewed(session);
    expect(await push(session, clone, 'p2')).toEqual({ behavior: 'deny', message: expect.stringMatching(/^The push was refused: each of your commits starts with "SHOP-3546: "/) });
    execFileSync('git', ['commit', '--quiet', '--amend', '-m', 'SHOP-3546: lift error_code'], { cwd: clone, env: { ...process.env, ...agentGitEnv(world.clone.identity) } });
    expect(await push(session, clone, 'p3')).toEqual({ behavior: 'deny', message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    expect(world.git(world.remote, 'log', '-1', '--format=%B', 'feature/SHOP-3546')).toBe(`SHOP-3546: lift error_code\n\n${TRAILER}`);
    // Its PR is open: bot-review rounds are read from its reviews, not counted from pushes.
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'draft', ticket: KEY, url: 'https://github.com/acme/shop-api/pull/9', checks: 'pending' } });
    for (const n of [1, 2, 3]) {
      clock.advance(60_000);
      commit(clone, `round${n}.ts`, `SHOP-3546: address review round ${n}`);
      expect(await push(session, clone, `r${n}`)).toMatchObject({ message: expect.stringContaining('The orchestrator pushed') });
    }
    rounds = 3; // the bots have reviewed three of its commits
    clock.advance(60_000);
    commit(clone, 'round4.ts', 'SHOP-3546: address review round 4');
    const fourth = push(session, clone, 'r4');
    await answer('round', 'denied');
    expect(await fourth).toEqual({ behavior: 'deny', message: expect.stringContaining('alex stopped the bot-review rounds here') });
    expect(payloads('approval.requested').filter((a) => a.kind === 'round').map((a) => a.question)).toEqual([
      'Agent 1 on SHOP-3546 has had 3 bot-review rounds on its PR and wants to push for another. Another round, or stop the rounds here?',
    ]);
  });

  it('pushes when the review found a contract change, recorded as a flagged decision that the PR description must list (v1.3)', async () => {
    const { session, clone, runId } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    // A review without its two lines does not count.
    await hook(session, 'SubagentStart')({ agent_id: 'review-0', agent_type: 'reviewer' });
    await hook(session, 'SubagentStop')({ agent_id: 'review-0', agent_type: 'reviewer', last_assistant_message: 'Looks fine. RESULT: success', stop_hook_active: false });
    expect(await push(session, clone, 'p0')).toMatchObject({ message: expect.stringContaining('Before the first push') });
    await reviewed(session, { contract: 'returns 422 instead of 400 for a bad error_code (shop-api/src/map.ts:40)', cacheBypass: 'none' });
    expect(await push(session, clone, 'p1')).toMatchObject({ message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    expect(payloads('approval.requested').filter((a) => a.kind === 'decision')).toEqual([]);
    expect(payloads('run.assumption')).toEqual([
      { runId, assumptionId: expect.any(String), text: 'The review found a visible contract change: returns 422 instead of 400 for a bad error_code (shop-api/src/map.ts:40)', evidence: [], flag: 'contract', by: 'review' },
    ]);
    // Its PR description is written from its reports (N1), so the decisions are listed under "Decisions I made", one point each.
    const pr = { args: ['pr', 'create', '--repo', SHOP_API, '--title', 'feature/SHOP-3546: lift error_code', '--body', 'my own text, which is not used'] };
    expect(await tool(session, 'gh', pr)).toBe(
      'Not sent: the PR description is written from your reports, and one is missing: report_root_cause: the PR description gives the root cause, from your report. Report it, then send the request again.',
    );
    await tool(session, 'report_root_cause', { text: 'The error path keeps error_code nested in details.', lines: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] });
    expect(await tool(session, 'gh', pr)).toBe(
      'Not sent: the PR description is written from your reports, and one is missing: report_approach: the PR description gives your approach, from your report. Report it, then send the request again.',
    );
    await tool(session, 'report_approach', { approach: 'Lift error_code on the error path too, as the warning path does.', alternatives: [{ option: 'Strip it from details on load', rejectedBecause: 'Other readers expect it there.' }] });
    const held = await tool(session, 'gh', pr);
    expect(held).toContain('Not sent yet. Every PR write follows');
    expect(held).toContain('The PR description is the ticket narrative\'s, from your reports; yours was not used:');
    expect(held).toContain('## Root cause\n\nThe error path keeps error_code nested in details.');
    expect(held).toContain('- Strip it from details on load: Other readers expect it there.');
    expect(held).toContain('## Decisions I made\n\n- [contract] The review found a visible contract change: returns 422 instead of 400 for a bad error_code (shop-api/src/map.ts:40)');
    expect(held).not.toContain('my own text');
  });

  it('records the decisions an agent makes itself instead of asking, flagged ones for review (v1.3)', async () => {
    const { session, runId } = await spawn();
    expect(await tool(session, 'record_assumption', { text: 'Return 422 instead of 400 for a bad error_code.', evidence: [{ kind: 'ticket', ref: KEY }], flag: 'contract' })).toMatch(
      /^Recorded \(as-[0-9a-z]+\)\. List it under "Decisions I made" in your hand-back and your PR description\. Flagged: alex decides it at review\.$/,
    );
    expect(await tool(session, 'record_assumption', { text: 'Use the warning path\'s mapper for errors too.', evidence: [{ kind: 'code', ref: 'shop-api/src/map.ts:40' }] })).toMatch(/^Recorded/);
    expect(payloads('run.assumption').map((a) => [a.runId, a.flag ?? null, a.by])).toEqual([
      [runId, 'contract', 'agent'],
      [runId, null, 'agent'],
    ]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(session.options.mcpServers).toBeDefined();
  });

  it("a tester's run logs its writes and sends none: the push is shown as it would be, and GitHub has nothing", async () => {
    const { session, clone } = await spawn({ test: true });
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    await reviewed(session);
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    expect(await push(session, clone, 'p1')).toEqual({ behavior: 'deny', message: expect.stringContaining("Not pushed: this is a tester's run") });
    expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toBe('');
    expect(payloads('action.finished').at(-1)).toMatchObject({ ok: true, notSent: true });
    expect(said().at(-1)).toMatch(/^Agent 1 would have run `git push origin feature\/SHOP-3546 .*` \(a tester's run: logged, not sent\)\.$/);
    // So is its draft PR, once the writing rules have been put in front of it.
    const pr = { args: ['pr', 'create', '--repo', SHOP_API, '--title', 'feature/SHOP-3546: lift error_code', '--body', 'One test: test/map.test.ts:12.'] };
    await tool(session, 'report_root_cause', { text: 'The error path keeps error_code nested in details.', lines: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] });
    await tool(session, 'report_approach', { approach: 'Lift error_code on the error path too.', alternatives: [] });
    expect(await tool(session, 'gh', pr)).toContain('Not sent yet. Every PR write follows');
    expect(await tool(session, 'gh', pr)).toContain("Not sent: this is a tester's run");
    expect(backends.calls.gh).toEqual([]);
  });
});

describe('writes other people read, findings, hypotheses and product decisions', () => {
  it('hands the writing rules over with every PR, Jira or Confluence write before it is sent, and every such write points to its evidence', async () => {
    const { session } = await spawn();
    const first = await tool(session, 'jira', { action: 'comment', key: KEY, text: 'It is fixed now.' });
    expect(first).toMatch(/^Not sent yet\. Every Jira write follows alex's writing rules \(team-dev references\/writing\.md, version [0-9a-f]{12}\)/);
    expect(first).toContain('- Lead with the result, then the evidence.');
    expect(await tool(session, 'jira', { action: 'comment', key: KEY, text: 'It is fixed now.' })).toBe(
      'Not sent: every claim in a Jira write points to its evidence, in the text: a link, a file and line, a ticket or PR, a commit, a log query or an id. Add it, then send the request again.',
    );
    // The corrected text comes back with the rules too, and goes the second time.
    const corrected = { action: 'comment', key: KEY, text: 'error_code is lifted to the top (shop-api/src/map.ts:40).' };
    expect(await tool(session, 'jira', corrected)).toContain('Not sent yet. Every Jira write follows');
    const sent = tool(session, 'jira', corrected);
    await answer('action', 'denied');
    expect(await sent).toContain('declined');
    // And every later write as well, not only the first.
    expect(await tool(session, 'confluence', { action: 'create', space: 'SHOP', title: 't', body: 'See SHOP-3546.' })).toContain('Not sent yet. Every Confluence write follows');
    expect(payloads('action.classified').map((a) => a.kind)).toEqual(['jira.comment']);
  });

  it('drafts a different defect as its own ticket for alex and flags three disproved hypotheses once, without asking him', async () => {
    const drafts: unknown[] = [];
    build({ draftTicket: (o) => (drafts.push(o), 'draft-1') });
    const { session, runId } = await spawn();
    expect(await tool(session, 'report_finding', { summary: 'Retries resend a stale header.', evidence: [{ kind: 'log', ref: 'source logs | filter $d.msg ~ "retry"' }], proposedTicket: { summary: 'Webhook retries resend a stale header', description: 'Description: …' } })).toBe(
      'Recorded, and drafted for alex as its own ticket; he decides whether to create it. Do not fix it in this run.',
    );
    expect(payloads('run.finding')[0]).toMatchObject({ runId, summary: 'Retries resend a stale header.', proposedTicket: { summary: 'Webhook retries resend a stale header' } });
    // A draft card in its run's conversation, related to the run's ticket; nothing is created.
    expect(drafts).toEqual([
      {
        by: 'agent',
        runId,
        draft: { project: 'SHOP', type: 'Bug', summary: 'Webhook retries resend a stale header', description: 'Description: …\n\nFound by Agent 1 while working SHOP-3546: Retries resend a stale header.', links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3546' }] },
      },
    ]);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Agent 1 found a second defect while working SHOP-3546. I drafted the ticket; it waits for you.', blocks: [{ type: 'draft', ref: 'draft-1' }] });
    const hypothesis = (id: string, status: 'open' | 'disproved') => tool(session, 'report_hypothesis', { id, text: `Hypothesis ${id}`, status });
    for (const id of ['h1', 'h2']) {
      await hypothesis(id, 'open');
      expect(await hypothesis(id, 'disproved')).toBe('Recorded.');
    }
    expect(await hypothesis('h3', 'disproved')).toBe('Recorded. That is 3 disproved: before the next hypothesis, find a similar case that works and diff the two paths. Elfoqsy told alex.');
    expect(await hypothesis('h4', 'disproved')).toBe('Recorded.');
    expect(said().filter((t) => t.includes('disproved'))).toEqual([
      'Agent 1 on SHOP-3546 has disproved 3 hypotheses. I have suggested it diff the failing path against a similar case that works before trying another.',
    ]);
    expect(live.get().runs[runId]!.hypotheses!.map((h) => [h.hypothesisId, h.status])).toEqual([
      ['h1', 'disproved'],
      ['h2', 'disproved'],
      ['h3', 'disproved'],
      ['h4', 'disproved'],
    ]);
    expect(payloads('approval.requested')).toEqual([]); // nothing in this was his to answer
  });
});

describe('a handoff written before his later messages (probe P1)', () => {
  const said = (messageId: string, role: 'you' | 'test', text: string) =>
    log.append('orchestrator', 'elfoqsy.message', { messageId, role, text, conversationId: 'c-stale' });
  const handoff = (handoffId: string, copied: string[]) =>
    log.append('elfoqsy', 'handoff.created', {
      handoffId,
      conversationId: 'c-stale',
      ticket: KEY,
      mode: 'normal',
      context: copied.map((messageId) => ({ messageId, role: 'you' as const, text: 'x' })),
      constraints: [],
      facts: [],
    });

  it('is refused, saying who wrote since; the fresh one she writes starts the agent', async () => {
    said('m-1', 'you', 'Look at it. Keep the v1 path as it is.');
    handoff('h-1', ['m-1']);
    said('m-2', 'you', 'Go, and leave the cache alone too.');
    expect(await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], handoffId: 'h-1' })).toEqual({
      error: 'stale_handoff',
      message: 'alex has written a message in this conversation since handoff h-1 was written. Write a fresh handoff with write_handoff, from the whole conversation, and start the agent with that one.',
    });
    expect(payloads('run.created')).toEqual([]);
    handoff('h-2', ['m-1', 'm-2']);
    const { runId } = await spawn({ handoffId: 'h-2' });
    expect(payloads('handoff.handed_off')).toEqual([{ handoffId: 'h-2', runId }]);
  });

  it("names the tester when only the tester wrote since, and refuses one that copied none of the messages before it", async () => {
    said('m-1', 'test', 'Look at it.');
    handoff('h-1', ['m-1']);
    said('m-2', 'test', 'Go.');
    said('m-3', 'test', 'Now.');
    expect(await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], handoffId: 'h-1' })).toMatchObject({ error: 'stale_handoff', message: expect.stringMatching(/^the tester has written 2 messages in this conversation since handoff h-1/) });
    handoff('h-empty', []); // what P1's first handoff was: nothing of the conversation in it
    expect(await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], handoffId: 'h-empty' })).toMatchObject({ error: 'stale_handoff' });
  });
});

describe("a tester's answer to an agent's question in a tester's run", () => {
  it('is labelled as the tester\'s, not alex\'s', async () => {
    const { session } = await spawn({ test: true });
    const card = { question: 'Change v1 too, or leave it?', why: ['v1 is a visible contract'], options: [{ label: 'Leave v1', consequence: 'v1 split into its own ticket' }, { label: 'Change v1 too', consequence: 'Wider review' }], recommendation: 'Leave v1', sources: [] };
    const asked = tool(session, 'ask_user', card);
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested')[0]!.approvalId, decision: 'answered', answer: 'Leave v1', test: true });
    expect(await asked).toBe('[Answered by the tester, not alex] Leave v1');
  });
});

describe('the ticket folder, his own sessions, and the team-dev skill', () => {
  it("keeps a tester's ticket folder out of his: its marker and notes go to the test root", async () => {
    const { runId, session, clone } = await spawn({ test: true });
    expect(readFileSync(join(world.root, 'test-tickets', KEY, RUN_MARKER), 'utf8')).toBe(`${runId}\n`);
    expect(existsSync(join(ticketsRoot, KEY))).toBe(false);
    expect(await gate(session, 'Write', { file_path: join(world.root, 'test-tickets', KEY, 'case.md'), content: 'x' }, clone)).toMatchObject({ decision: 'allow' });
    expect(await gate(session, 'Write', { file_path: join(ticketsRoot, KEY, 'case.md'), content: 'x' }, clone)).toMatchObject({ decision: 'ask' });
  });

  it('holds the ticket folder while it works, with its run id, and lets go when it ends', async () => {
    const { runId } = await spawn();
    const marker = join(ticketsRoot, KEY, RUN_MARKER);
    expect(readFileSync(marker, 'utf8')).toBe(`${runId}\n`);
    expect(sdk.sessions.at(-1)!.options.env).toMatchObject({ ELFOQSY_RUN_ID: runId, COAUTHOR_TRAILER: TRAILER });
    await orchestrator.cancel(runId, 'Stop.');
    expect(existsSync(marker)).toBe(false);
  });

  it('asks before starting when alex seems to be on the ticket himself: a fresh case.md, or uncommitted work in his worktree', async () => {
    mkdirSync(join(ticketsRoot, KEY), { recursive: true });
    writeFileSync(join(ticketsRoot, KEY, 'case.md'), '# SHOP-3546\n');
    utimesSync(join(ticketsRoot, KEY, 'case.md'), new Date(clock.now - 2 * 3_600_000), new Date(clock.now - 2 * 3_600_000));
    expect(await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API] })).toEqual({
      warning: 'manual_session',
      message: 'alex may be working on SHOP-3546 himself: ~/tickets/SHOP-3546/case.md changed 2 hours ago. Ask him before starting an agent on it, and call spawn_agent again with confirmManual: true only when he says go.',
    });
    // An old case.md is not a session.
    utimesSync(join(ticketsRoot, KEY, 'case.md'), new Date(clock.now - 3 * 24 * 3_600_000), new Date(clock.now - 3 * 24 * 3_600_000));
    world.git(world.clone.path, 'worktree', 'add', '--quiet', join(world.reposRoot, 'shop-api-3546'), '-b', 'feature/SHOP-3546-local');
    writeFileSync(join(world.reposRoot, 'shop-api-3546', 'wip.ts'), 'wip');
    const r = await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API] });
    expect(r).toMatchObject({ warning: 'manual_session', message: expect.stringContaining(`${join(world.reposRoot, 'shop-api-3546')} (feature/SHOP-3546-local) has uncommitted changes`) });
    expect(await orchestrator.spawn({ ticketKey: KEY, repos: [SHOP_API], confirmManual: true })).toMatchObject({ agentNumber: 1 });
  });

  it('takes a read-only copy of the skill and logs its version; the skill and the adapter go into the first instruction only once the adapter exists', async () => {
    const plain = await spawn();
    const copy = join(plain.runRoot, '.elfoqsy', 'team-dev');
    expect(payloads('run.skill_snapshot')).toEqual([{ runId: plain.runId, hash: skillHash(skillDir), files: 4 }]);
    expect(statSync(join(copy, 'SKILL.md')).mode & 0o222).toBe(0);
    expect(plain.session.sent[0]).not.toContain('## team-dev');
    await orchestrator.cancel(plain.runId, 'Next.');

    writeFileSync(join(world.root, 'skill-adapter.md'), '| Area | Inside Elfoqsy |\n|---|---|\n| Language | English for everything. |\n');
    const adapted = await spawn();
    const prompt = adapted.session.sent[0]!;
    expect(prompt).toContain("## team-dev, alex's own method");
    expect(prompt).toContain('Invocation: `SHOP-3546`');
    expect(prompt).not.toContain('disable-model-invocation');
    expect(prompt).toContain('## The adapter: team-dev inside Elfoqsy\n| Area | Inside Elfoqsy |');
    expect(prompt.indexOf('## The adapter')).toBeGreaterThan(prompt.indexOf('Invocation: `SHOP-3546`'));
  });

  it('tells alex once when the skill changed since the adapter, naming the sections, and seeds its environment facts with the skill as their source', () => {
    writeFileSync(join(world.root, 'skill-adapter.json'), JSON.stringify({ skill: 'team-dev', hash: skillHash(skillDir), sections: sectionHashes(skillDir) }));
    expect(orchestrator.checkSkill()).toBe(false);
    writeFileSync(join(skillDir, 'references', 'writing.md'), '# Writing rules\n\n- Shorter.\n\n## Drafts\n\n- Draft means chat.\n');
    expect(orchestrator.checkSkill()).toBe(true);
    expect(payloads('skill.changed')).toEqual([{ skill: 'team-dev', hash: skillHash(skillDir), previous: expect.any(String), sections: ['references/writing.md', 'references/writing.md › Drafts (new)'] }]);
    expect(said().at(-1)).toMatch(/^Your team-dev skill changed \([0-9a-f]{12} → [0-9a-f]{12}\): references\/writing\.md; references\/writing\.md › Drafts \(new\)\. The adapter \(docs\/skill-adapter\.md\)/);
    expect(orchestrator.checkSkill()).toBe(false); // once

    expect(orchestrator.seedSkillFacts()).toBe(2);
    expect(Object.values(live.get().memory).map((f) => [f.statement, f.sources[0]!.label])).toEqual([
      ['Lower environments: Dev: Developer builds.', `team-dev skill, version ${skillHash(skillDir)}`],
      ['Access: Pass `--context <arn>` on every kubectl call.', `team-dev skill, version ${skillHash(skillDir)}`],
    ]);
    expect(orchestrator.seedSkillFacts()).toBe(0);
  });
});

describe("Elfoqsy's wrong theory never reaches the agent (a fake-SDK case)", () => {
  it('keeps her theory and her conclusions out of the handoff, and the agent reads only his words, his constraint and sourced facts', async () => {
    const conversationId = 'c-3546';
    const his = (text: string) => {
      log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'you', text, conversationId });
      return `m-${log.headSeq() - 1}`;
    };
    const her = new ElfoqsySession({
      conversationId,
      log,
      usage,
      state: () => live.get(),
      systemPrompt: 'You are Elfoqsy.',
      mcpServer: (session) => orchestratorServer({ log, state: () => live.get(), orchestrator, session }),
      cwd: world.root,
      env: {},
      ticketKey: /SHOP-\d+/i,
      queryFn: sdk.queryFn,
      clock,
      now: () => clock.now,
    });
    const first = his('What is going on with SHOP-3546?');
    her.say('What is going on with SHOP-3546?');
    await tick(20);
    const herSession = sdk.sessions.at(-1)!;
    // Her wrong theory, said in the conversation through the SDK.
    herSession.emit(text('I think the root cause is the Redis TTL being too short.'), result());
    await tick(20);
    const theory = live.get().messages.find((m) => m.role === 'elfoqsy' && m.text.includes('Redis TTL'))!;
    expect(theory.conversationId).toBe(conversationId);
    const go = his('ok, start it. keep the v1 path as it is.');
    // She writes the handoff, theory and all; the orchestrator keeps only what is his and sourced.
    const wrote = JSON.parse(
      await runTool(herSession.options as Options, 'write_handoff', {
        ticket: KEY,
        mode: 'normal',
        constraints: [{ text: 'keep the v1 path as it is' }, { text: 'the Redis TTL being too short' }],
        facts: [
          { text: 'The ticket says error_code stays nested in details.', sources: [{ kind: 'ticket', ref: KEY }] },
          { text: 'The root cause is the Redis TTL.', sources: [{ kind: 'ticket', ref: KEY }] },
          { text: 'Redis keys expire after 30 s.', sources: [] },
        ],
      }, 'orchestrator'),
    ) as { handoffId: string; dropped: unknown[] };
    expect(wrote.dropped).toHaveLength(3);
    await runTool(herSession.options as Options, 'spawn_agent', { ticketKey: KEY, repos: [SHOP_API], handoffId: wrote.handoffId }, 'orchestrator');
    await tick(20);
    const agent = sdk.sessions.at(-1)!;
    expect(agent).not.toBe(herSession);
    const prompt = agent.sent[0]!;
    expect(prompt).toContain('## The handoff');
    expect(prompt).toContain('The facts are leads to verify, not conclusions');
    expect(prompt).toContain('> What is going on with SHOP-3546?');
    expect(prompt).toContain('> ok, start it. keep the v1 path as it is.');
    expect(prompt).toContain('- keep the v1 path as it is');
    expect(prompt).toContain('- The ticket says error_code stays nested in details. (SHOP-3546)');
    expect(prompt).not.toMatch(/Redis|TTL|root cause is/);
    expect(live.get().runs[payloads('run.created').at(-1)!.runId]).toMatchObject({ handoffId: wrote.handoffId });
    her.close();
  });
});

describe('the close-out after merge and QA', () => {
  /** A finished hotfix run on the ticket: its verdict, input classes and a passed check, and its PR merged. */
  async function finishedRun() {
    log.append('elfoqsy', 'handoff.created', {
      handoffId: 'h-fix',
      conversationId: 'c1',
      ticket: KEY,
      mode: 'hotfix',
      bases: { [SHOP_API]: 'master' },
      context: [{ messageId: 'm1', role: 'you', text: 'start it, keep the v1 path' }],
      constraints: [{ text: 'keep the v1 path', messageId: 'm1' }],
      facts: [],
    });
    const { session, runId } = await spawn({ handoffId: 'h-fix' });
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error with error_code', 'a success'] });
    log.append('agent', 'run.goal_declared', { runId, revision: 1, goal: 'Lift error_code', checks: [{ id: 'unit', description: 'The unit tests pass', proof: 'command', command: 'npm run test:unit' }] });
    log.append('agent', 'run.check_changed', { runId, checkId: 'unit', status: 'passed', evidence: '`npm run test:unit` passed at 08:30.' });
    log.append('orchestrator', 'action.classified', { actionId: 'a-pr', runId, proxy: 'gh', kind: 'gh.pr.create', tier: 1, summary: `gh pr create --repo ${SHOP_API} --title "feature/SHOP-3546: lift error_code to the top of provider errors" --body x`, decision: 'run', reason: 'r' });
    await orchestrator.cancel(runId, 'Done here.');
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 9, state: 'merged', ticket: KEY, url: 'https://github.com/acme/shop-api/pull/9', checks: 'success' } });
    return runId;
  }

  it('regenerates case.md from the log, keeps the run’s own, and drafts the QA notes and the solution page', async () => {
    await finishedRun();
    mkdirSync(join(ticketsRoot, KEY), { recursive: true });
    writeFileSync(join(ticketsRoot, KEY, 'case.md'), '# the run’s own case.md\n');
    expect(await orchestrator.closeOut(KEY, 'QA passed on Integration.')).toEqual({ ok: true, files: ['case.md', 'qa-notes.md', 'solution-page.md'], pageRequested: false });
    const dir = join(ticketsRoot, KEY);
    const regenerated = readFileSync(join(dir, 'case.md'), 'utf8');
    expect(regenerated).toContain('- Phase: DONE');
    expect(regenerated).toContain('- QA: QA passed on Integration.');
    expect(regenerated).toContain('- Ticket validity: VALID, reproduced. error_code stays nested in details.');
    expect(regenerated).toContain('- Reported symptom: "without error_code: it stays nested in details"');
    expect(regenerated).toContain('- Input classes: an error with error_code; a success');
    expect(regenerated).toContain('- The unit tests pass: passed. `npm run test:unit` passed at 08:30.');
    expect(regenerated).toContain('- acme/shop-api #9: merged, CI success. https://github.com/acme/shop-api/pull/9');
    expect(readFileSync(join(dir, 'evidence', 'case-before-close-out-2026-10-11.md'), 'utf8')).toBe('# the run’s own case.md\n');
    expect(readFileSync(join(dir, 'qa-notes.md'), 'utf8')).toContain('After the fix: lift error_code to the top of provider errors.');
    const page = readFileSync(join(dir, 'solution-page.md'), 'utf8');
    expect(page.split('\n')[0]).toBe('# Acme Shop :: SHOP-3546 :: lift error_code to the top of provider errors');
    expect(page).toContain('Unchanged: keep the v1 path.');
    expect(page).toContain('| Jira | SHOP-3546, 2 SP |');
    expect(said().at(-1)).toBe('SHOP-3546 is merged and QA passed. I regenerated case.md from the log and drafted the QA notes and the solution page in ~/tickets/SHOP-3546/. Tell me the release page and I will ask to publish the page under it.');
    expect(payloads('ticket.closed_out')).toEqual([{ ticket: KEY, qa: 'QA passed on Integration.', files: ['case.md', 'qa-notes.md', 'solution-page.md'] }]);
  });

  it('says the close-out in Vietnamese when his latest message was', async () => {
    await finishedRun();
    language.current = 'vi';
    await orchestrator.closeOut(KEY, 'QA passed on Integration.');
    expect(said().at(-1)).toBe(
      'SHOP-3546 đã được merge và QA đã qua. Tôi đã dựng lại case.md từ log, và soạn ghi chú QA cùng trang giải pháp trong ~/tickets/SHOP-3546/. Cậu cho tôi biết trang release, tôi sẽ xin phép đăng trang giải pháp dưới đó.',
    );
  });

  it('asks to publish the page under the release page a hotfix names, and closes out on its own when Jira moves the ticket to Done', async () => {
    const runId = await finishedRun();
    log.append('orchestrator', 'run.created', { runId: 'run-hotfix', ticket: KEY, worktree: '/x', branch: 'feature/SHOP-3546', agentNumber: 9, mode: 'hotfix', bases: { [SHOP_API]: 'release/2.22.0' }, repos: [SHOP_API] });
    log.append('orchestrator', 'run.state_changed', { runId: 'run-hotfix', state: 'cancelled' });
    backends.confluence!.search = async () => '7340041  SHOP  Release/2.22.0';
    log.append('jira', 'ticket.synced', { ticket: ticket(KEY, { status: 'Done' }) });
    await tick(50);
    for (let i = 0; i < 100 && !payloads('approval.requested').length; i++) await tick(10);
    expect(payloads('ticket.closed_out')).toEqual([{ ticket: KEY, qa: 'Jira moved it to Done.', files: ['case.md', 'qa-notes.md', 'solution-page.md'], pageRequested: true }]);
    const asked = payloads('approval.requested').at(-1)!;
    expect(asked).toMatchObject({ kind: 'action', tier: 2, grantable: { kind: 'confluence.create' } });
    expect(asked.question).toContain('Acme Shop :: SHOP-3546 :: lift error_code to the top of provider errors');
    // Once: Jira saying Done again closes out nothing more.
    log.append('jira', 'ticket.synced', { ticket: ticket(KEY, { status: 'In progress' }) });
    log.append('jira', 'ticket.synced', { ticket: ticket(KEY, { status: 'Done' }) });
    await tick(50);
    expect(payloads('ticket.closed_out')).toHaveLength(1);
    void runId;
  });

  it('closes out nothing before a merge, while an agent works, or for a ticket no agent touched', async () => {
    expect(await orchestrator.closeOut(KEY, 'QA passed.')).toMatchObject({ error: 'no_runs' });
    const { runId } = await spawn();
    expect(await orchestrator.closeOut(KEY, 'QA passed.')).toMatchObject({ error: 'still_working' });
    await orchestrator.cancel(runId, 'Stop.');
    expect(await orchestrator.closeOut(KEY, 'QA passed.')).toMatchObject({ error: 'not_merged' });
  });
});

describe('the ticket narrative (N1): what the agent reports, what the orchestrator sees itself, and where it is used', () => {
  const REPRODUCTION = { how: 'A unit test sends an error result through the real mapper.', environment: 'local, jest, shop-api', test: { path: 'shop-api/test/map.test.ts', name: 'lifts error_code' }, command: 'npm run test:unit', requestIds: ['req-7f3a'] };
  const ROOT_CAUSE = { text: 'The error path keeps error_code nested in details.', lines: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] };
  const APPROACH = { approach: 'Lift error_code on the error path too, as the warning path does.', alternatives: [{ option: 'Strip it from details on load', rejectedBecause: 'Other readers expect it there.' }] };

  it('asks the understanding before the verdict, in the ticket’s own words, and records it', async () => {
    const { session, runId } = await spawn();
    const understanding = { ...UNDERSTANDING_FOR_TESTS, claim: 'the cache drops the error' };
    expect(await runTool(session.options as Options, 'report_understanding', understanding)).toContain('claim must be quoted from the ticket, word for word');
    expect(await runTool(session.options as Options, 'report_verdict', { ...BUG, reproduced: false })).toContain('Report your understanding of the ticket first (report_understanding)');
    expect(await runTool(session.options as Options, 'report_understanding', { ...UNDERSTANDING_FOR_TESTS, sources: [{ kind: 'code', ref: 'shop-api/src/map.ts' }] })).toContain('sources: a code source is a file and line');
    expect(await runTool(session.options as Options, 'report_understanding', UNDERSTANDING_FOR_TESTS)).toContain('Recorded.');
    expect(payloads('run.understanding')).toEqual([{ runId, ...UNDERSTANDING_FOR_TESTS }]);
    expect(await runTool(session.options as Options, 'report_verdict', { ...BUG, reproduced: false })).toContain('Verdict recorded: VALID, not reproduced yet.');
  });

  it('holds reproduction, root cause and approach until the verdict, and checks the lines it is given', async () => {
    const { session, runId } = await spawn();
    for (const [name, args] of [['report_reproduction', REPRODUCTION], ['report_root_cause', ROOT_CAUSE], ['report_approach', APPROACH]] as const) {
      expect(await runTool(session.options as Options, name, args)).toContain('Report your verdict first (report_verdict).');
    }
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    expect(await tool(session, 'report_root_cause', { text: 'x', lines: [{ kind: 'code', ref: 'shop-api/src/map.ts' }] })).toContain('lines: a code source is a file and line');
    expect(await tool(session, 'report_root_cause', { text: 'x', lines: [{ kind: 'ticket', ref: KEY }] })).toContain('needs at least one code source');
    for (const [name, args] of [['report_reproduction', REPRODUCTION], ['report_root_cause', ROOT_CAUSE], ['report_approach', APPROACH]] as const) {
      expect(await tool(session, name, args)).toBe('Recorded.');
    }
    expect(payloads('run.reproduction')).toEqual([{ runId, ...REPRODUCTION }]);
    expect(payloads('run.root_cause')).toEqual([{ runId, ...ROOT_CAUSE }]);
    expect(payloads('run.approach')).toEqual([{ runId, ...APPROACH }]);
    // The verdict carries its chain and the working case, as it was said.
    expect(payloads('run.verdict').at(-1)).toMatchObject({ chain: BUG.chain, siblingAt: BUG.siblingAt });
  });

  it('records, from the orchestrator itself, each test-shaped command and how it ended, with the counts a known runner prints', async () => {
    const { session, runId } = await spawn();
    const failed = { tool_name: 'Bash', tool_input: { command: 'cd shop-api && npx jest test/map.test.ts' }, tool_use_id: 'tu-f', cwd: '', duration_ms: 2300, error: 'Exit code 1\nFAIL test/map.test.ts\n  ✕ lifts error_code\n    Expected: 1\n    Received: undefined\nTests: 1 failed, 3 passed, 4 total' };
    await hook(session, 'PostToolUseFailure')(failed);
    await hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command: 'cd shop-api && npx jest test/map.test.ts' }, tool_use_id: 'tu-p', cwd: '', duration_ms: 1900, tool_response: { stdout: 'PASS test/map.test.ts\nTests: 4 passed, 4 total\n', stderr: '', interrupted: false } });
    // A pipe can hide a failing exit: the runner's own count says it failed.
    await hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command: 'npx vitest run | tail -3' }, tool_use_id: 'tu-v', cwd: '', tool_response: { stdout: ' Tests  2 failed | 5 passed (7)\n', stderr: '', interrupted: false } });
    // Not a test, and a command that did not finish here: nothing recorded.
    await hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command: 'ls src' }, tool_use_id: 'tu-l', cwd: '', tool_response: { stdout: 'map.ts', stderr: '', interrupted: false } });
    await hook(session, 'PostToolUse')({ tool_name: 'Bash', tool_input: { command: 'npm run test:unit' }, tool_use_id: 'tu-b', cwd: '', tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } });
    expect(payloads('run.test_run')).toEqual([
      { runId, toolUseId: 'tu-f', command: 'cd shop-api && npx jest test/map.test.ts', ok: false, durationMs: 2300, summary: expect.stringContaining('✕ lifts error_code'), passed: 3, failed: 1, failedNames: ['lifts error_code'] },
      { runId, toolUseId: 'tu-p', command: 'cd shop-api && npx jest test/map.test.ts', ok: true, durationMs: 1900, summary: expect.stringContaining('Tests: 4 passed'), passed: 4 },
      { runId, toolUseId: 'tu-v', command: 'npx vitest run | tail -3', ok: false, summary: expect.stringContaining('2 failed'), passed: 5, failed: 2 },
    ]);
  });

  it('records what a push carried, read from git: the commits GitHub lacked and the change per file against the base', async () => {
    const { session, clone, runId } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    commit(clone, 'src-b.ts', 'SHOP-3546: add the helper');
    await reviewed(session);
    expect(await push(session, clone, 'p1')).toMatchObject({ message: expect.stringContaining('The orchestrator pushed feature/SHOP-3546') });
    const [pushed] = payloads('run.pushed');
    expect(pushed).toMatchObject({ runId, repos: [{ repo: SHOP_API, branch: 'feature/SHOP-3546', head: expect.stringMatching(/^[0-9a-f]{7}$/) }] });
    expect(pushed!.repos[0]!.commits.map((c) => c.subject)).toEqual(['SHOP-3546: lift error_code', 'SHOP-3546: add the helper']);
    expect(pushed!.repos[0]!.files.map((f) => f.path).sort()).toEqual(['map.ts', 'src-b.ts']);
    expect(pushed!.repos[0]!.files.every((f) => f.added === 1 && f.removed === 0)).toBe(true);
  });

  it('report_result says what was not verified and what waits for him; a turn that ends with a PR open is the hand-back, said once in chat with a link to section 7', async () => {
    const { session, runId } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 140, state: 'draft', ticket: KEY, url: 'https://github.com/acme/shop-api/pull/140', checks: 'success' } });
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 140, sha: 'abcdef1234567', status: 'success', url: 'https://github.com/x/y/actions/runs/1' });
    expect(await tool(session, 'report_result', { result: 'succeeded', summary: 'Lifted error_code.' })).toContain('Input validation error'); // both lists are required: nothing is said by leaving them out
    expect(payloads('run.reported')).toEqual([]);
    await tool(session, 'report_result', { result: 'succeeded', summary: 'Lifted error_code.', notVerified: ['A real provider on dev'], waitingOnYou: ['Mark the PR ready'] });
    expect(payloads('run.reported')).toEqual([{ runId, result: 'succeeded', summary: 'Lifted error_code.', notVerified: ['A real provider on dev'], waitingOnYou: ['Mark the PR ready'] }]);
    session.emit(text('The fix is on the PR.\nWhat to do next: read it.\nDecisions I made: none.'), result());
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    expect(payloads('run.handed_back')).toEqual([{ runId, message: 'The fix is on the PR.\nWhat to do next: read it.\nDecisions I made: none.' }]);
    const line = payloads('elfoqsy.message').find((m) => m.text.includes('handed back'));
    expect(line).toMatchObject({ text: 'Agent 1 handed back SHOP-3546 with draft PR shop-api#140, CI green. Read what we know, then mark it ready.', blocks: [{ type: 'narrative', ref: runId, section: 7 }] });
  });

  it('the hand-back is said in Vietnamese when his latest message was', async () => {
    language.current = 'vi';
    const { session, runId } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 140, state: 'draft', ticket: KEY, url: 'https://github.com/acme/shop-api/pull/140', checks: 'success' } });
    log.append('github', 'ci.status', { repo: SHOP_API, pr: 140, sha: 'abcdef1234567', status: 'success', url: 'https://github.com/x/y/actions/runs/1' });
    await tool(session, 'report_result', { result: 'succeeded', summary: 'Lifted error_code.', notVerified: ['A real provider on dev'], waitingOnYou: ['Mark the PR ready'] });
    session.emit(text('The fix is on the PR.\nWhat to do next: read it.\nDecisions I made: none.'), result());
    for (let i = 0; i < 100 && !payloads('run.handed_back').length; i++) await tick(10);
    const line = payloads('elfoqsy.message').find((m) => m.text.includes('bàn giao'));
    expect(line).toMatchObject({ text: 'Agent 1 đã bàn giao lại SHOP-3546 kèm PR draft shop-api#140, CI xanh. Cậu đọc “What we know”, rồi đánh dấu sẵn sàng.', blocks: [{ type: 'narrative', ref: runId, section: 7 }] });
  });

  it('says in Vietnamese that a run that is gone cannot have its PR marked ready', async () => {
    language.current = 'vi';
    expect(await orchestrator.markReady('run-gone', 'you')).toEqual({ ok: false, message: 'Run đó không còn chạy nữa nên tôi không đánh dấu PR của nó là sẵn sàng từ đây được.' });
    language.current = 'en';
    expect(await orchestrator.markReady('run-gone', 'you')).toEqual({ ok: false, message: 'That run is not running any more, so I cannot mark its PR ready from here.' });
  });

  it('writes the PR description and Jira’s Root cause and Solution from the narrative, and refuses them while a report is missing', async () => {
    const { session, clone } = await spawn();
    await tool(session, 'report_verdict', { ...BUG, reproduced: true });
    await tool(session, 'declare_inputs', { classes: ['an error'] });
    const fill = { action: 'fill', key: KEY, rootCause: 'my own root cause', solution: 'my own solution' };
    expect(await tool(session, 'jira', fill)).toBe('Not sent: Root cause is written from your reports, and one is missing: report_root_cause: Root cause is written from your reported root cause (its text and the exact lines). Report it, then send the request again.');
    await tool(session, 'report_root_cause', ROOT_CAUSE);
    expect(await tool(session, 'jira', fill)).toContain('Solution is written from your reports, and one is missing: report_approach');
    await tool(session, 'report_approach', APPROACH);
    expect(await tool(session, 'jira', fill)).toContain('Solution is written from your reports, and one is missing: a push');
    commit(clone, 'map.ts', 'SHOP-3546: lift error_code');
    await reviewed(session);
    await push(session, clone, 'p1');
    const held = await tool(session, 'jira', fill);
    expect(held).toContain('Not sent yet. Every Jira write follows');
    expect(held).toContain("Root cause and Solution are the ticket narrative's, from your reports; the text you gave was not used.");
    // Sent: what the proxy got is the narrative's text, not the agent's.
    await tool(session, 'jira', fill);
    const filled = backends.calls.jira.find(([op]) => op === 'setBugFields');
    expect(JSON.stringify(filled)).toContain('The error path keeps error_code nested in details.');
    expect(JSON.stringify(filled)).toContain('Approach: Lift error_code on the error path too');
    expect(JSON.stringify(filled)).not.toContain('my own');
  });
});

const UNDERSTANDING_FOR_TESTS = { claim: 'without error_code: it stays nested in details', input: 'a provider error with error_code in details', actual: 'error_code stays nested in details', expected: 'error_code at the top of the result', sources: [{ kind: 'ticket' as const, ref: KEY }] };
