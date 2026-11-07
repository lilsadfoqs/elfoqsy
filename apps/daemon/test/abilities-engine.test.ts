// The abilities engine (brief-abilities part A): the format and its checks, data/skills as a git repository, the
// friction reading, and the engine over a real event log and its fold, with a fake proxy read and a fake model: learning
// (from disk and from a run's review), the notice, verification (reads only, effects never run), tracking against the
// baseline, levels, "needs re-check" and the repair. No model is called and nothing leaves the test.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayloadOf, ProxyName, Ticket } from '@elfoqsy/contracts';
import { ABILITY_LEVELS, abilityLevel } from '@elfoqsy/state';
import { baselineOf, longSteps, problemsOf, renderSkill, stepViews, toolOfTrack, tracks, type Ability } from '../src/abilities/ability';
import { AbilityEngine, type AbilityAnnouncement, type AbilityRevision, callsOfRun, jsonIn, summaryInput, type QueryFn } from '../src/abilities/engine';
import { errorClass, frictionOf, signature, worthASkill, type Call } from '../src/abilities/friction';
import { asRunTool } from '../src/abilities/history';
import { AbilityStore } from '../src/abilities/store';
import { language } from '../src/elfoqsy/voice';
import { LiveState } from '../src/elfoqsy/liveState';
import { EventLog } from '../src/eventLog';
import { cleanFrontmatter, copyAbilities } from '../src/skill/abilities';
import { text, result, tick } from './helpers/fakeSdk';
import { SHOP_API, orchestratorWorld } from './helpers/orchestratorWorld';

const base = mkdtempSync(join(tmpdir(), 'elfoqsy-abilities-engine-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (what: string) => join(base, `${what}-${++n}`);

const logs = (over: Partial<Ability> = {}): Ability => ({
  name: 'find-request-logs',
  version: 1,
  title: "Find a request's logs",
  titleVi: 'tìm log của một request',
  tool: 'coralogix',
  whenToUse: 'A request id and the question of what happened to it.',
  steps: [
    { text: 'Search the environment for the id', code: "wildfind '<requestId>'", read: { proxy: 'logs', input: { environment: 'staging', query: "wildfind 'x' | limit 1", from: '1h' } } },
    { text: 'Read one service', code: "filter $l.subsystemname == '<service>'", read: { proxy: 'logs', input: { environment: 'staging', query: "filter $l.subsystemname == 'request-handler' | limit 5" } } },
    { text: 'Scale it up only once he agrees', code: 'scale deploy x --replicas=1', effect: true },
    { text: 'Note the first error and its service' },
  ],
  doneWhen: 'The first error and its service are noted.',
  finder: { by: 'elfoqsy', session: 'friction analysis' },
  source: 'friction analysis, 2026-10-20',
  createdAt: '2026-10-20T16:30:00.000Z',
  baseline: { steps: 5, failed: 1.5, questions: 0.5, cases: 24, from: 'past work' },
  track: { tools: ['logs'] },
  ...over,
});

describe('an ability as written', () => {
  it('is valid as above, and each rule is checked', () => {
    expect(problemsOf(logs())).toEqual([]);
    expect(problemsOf(logs({ name: 'Find Logs' }))[0]).toMatch(/lowercase words joined by hyphens/);
    expect(problemsOf(logs({ steps: [] }))[0]).toMatch(/0 steps; 1 to 8/);
    expect(problemsOf(logs({ steps: Array.from({ length: 9 }, () => ({ text: 'x' })) }))[0]).toMatch(/9 steps/);
    expect(problemsOf(logs({ steps: [{ text: 'two\nlines' }] }))[0]).toMatch(/not one short line/);
    expect(problemsOf(logs({ steps: [{ text: 'a', read: { proxy: 'jira' as ProxyName, input: {} } }] }))[0]).toMatch(/not one of kube, aws, gh, logs/);
    expect(problemsOf(logs({ steps: [{ text: 'a', effect: true, read: { proxy: 'kube', input: {} } }] }))[0]).toMatch(/both a read and an effect/);
    expect(problemsOf(logs({ track: { tools: ['logs'], match: '(' } }))[0]).toMatch(/not a regular expression/);
  });

  it('has references: the longer detail a short sample points to, in its own file, and one line in SKILL.md to say so', () => {
    const withRefs = logs({ references: 'Full form of step 1:\n\n```\nwildfind \'<requestId>\' --env staging --from 1h\n```' });
    expect(problemsOf(withRefs)).toEqual([]);
    expect(problemsOf(logs({ references: '  ' }))[0]).toMatch(/references is empty or longer than 4000/);
    expect(problemsOf(logs({ references: 'x'.repeat(4001) }))[0]).toMatch(/references is empty or longer than 4000/);
    expect(renderSkill(withRefs)).toContain('The full commands and the detail behind them are in `references/steps.md`, in this skill\'s folder');
    expect(renderSkill(logs())).not.toContain('references/steps.md');
    // A secret in it is refused like a secret anywhere else in the skill.
    expect(problemsOf(logs({ references: `Use gh auth login --with-token ghp_${'a'.repeat(36)}` })).at(-1)).toMatch(/redactor removes/);
  });

  it('says which steps do not fit one line of a card: 450 px for the text (6.5 px a character) and its sample (7.8)', () => {
    expect(longSteps(logs())).toEqual([]);
    const long = logs({
      steps: [
        { text: 'Search the environment for the id', code: "wildfind '<requestId>'" },
        { text: 'When it was issued: his last AssumeRoleWithSAML, us-west-2', code: "cloudtrail lookup-events Username=<his email> --region us-west-2 --query Events[?EventName=='AssumeRoleWithSAML'].EventTime" },
        { text: 'Expiry is at most issued time + max; say it is an upper bound' },
        { text: 'Pods: name, ready and restarts, oldest first', code: 'get pods -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready' },
      ],
    });
    // A step with no sample is a line of text only; the first fits (33 + 22), the second and the fourth do not.
    expect(longSteps(long)).toEqual(['step 2: 58 + 123 characters', 'step 4: 44 + 87 characters']);
    // The same, shortened, fits.
    expect(longSteps(logs({ steps: [{ text: 'When it was issued: his last sign-in', code: 'cloudtrail lookup-events' }, { text: 'Pods, oldest first', code: 'get pods -o custom-columns=…' }] }))).toEqual([]);
  });

  it('is refused with a secret in it, never cleaned and kept', () => {
    // A GitHub-shaped fake, built here so no token-looking string sits in the source.
    const fake = `ghp_${'a'.repeat(36)}`;
    expect(problemsOf(logs({ steps: [{ text: 'Log in', code: `gh auth login --with-token ${fake}` }] })).at(-1)).toMatch(/redactor removes/);
  });

  it('renders SKILL.md in the SDK format: name and description only, the steps one line each, and never a permission', () => {
    const md = renderSkill(logs());
    expect(md.split('---')[1]).toBe(`\nname: find-request-logs\ndescription: "Find a request's logs. A request id and the question of what happened to it."\n`);
    expect(md).toContain("1. Search the environment for the id: `wildfind '<requestId>'`");
    expect(md).toContain('3. Scale it up only once he agrees: `scale deploy x --replicas=1` (changes something: only when the task asks for it)');
    expect(md).toMatch(/## When to use[\s\S]*## Steps[\s\S]*## Done when/);
    expect(md).toContain('this skill grants nothing');
    expect(md).not.toMatch(/allowed-tools|hooks:|model:/);
    // The session loader keeps it whole: nothing in it for the copy to strip.
    expect(cleanFrontmatter(md).dropped).toEqual([]);
  });

  it('shows on a card as read, effect and note steps', () => {
    expect(stepViews(logs()).map((s) => s.kind)).toEqual(['read', 'read', 'effect', 'note']);
  });

  it('tracks the calls of its kind: its tools, and its pattern when it has one', () => {
    const pod = { track: { tools: ['kube'], match: '\\blogs\\b' } };
    expect(tracks(pod, { tool: 'mcp__run__kube', text: '--context dev logs deploy/x' })).toBe(true);
    expect(tracks(pod, { tool: 'kube', text: '--context dev get pods' })).toBe(false);
    expect(tracks(pod, { tool: 'aws', text: 'logs' })).toBe(false);
  });
});

describe('data/skills', () => {
  it('is a git repository: each write a commit by Elfoqsy, with ability.json and SKILL.md', async () => {
    const store = new AbilityStore(fresh('skills'));
    await store.write(logs(), "learned find-request-logs: Find a request's logs (Elfoqsy)");
    await store.write(logs({ version: 2 }), 'repaired find-request-logs v2: step 1');
    await store.write(logs({ version: 2 }), 'nothing changed');
    expect(store.list().map((a) => `${a.name} v${a.version}`)).toEqual(['find-request-logs v2']);
    expect((await store.history('find-request-logs')).map((h) => h.message)).toEqual(['repaired find-request-logs v2: step 1', "learned find-request-logs: Find a request's logs (Elfoqsy)"]);
    expect(execFileSync('git', ['-C', store.dir, 'log', '-1', '--format=%an <%ae>'], { env: { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim()).toBe('Elfoqsy <elfoqsy@localhost>');
    expect(readFileSync(join(store.dir, 'find-request-logs', 'SKILL.md'), 'utf8')).toBe(renderSkill(logs({ version: 2 })));
  });

  it('refuses an ability that is not valid, and writes nothing', async () => {
    const store = new AbilityStore(fresh('skills'));
    await expect(store.write(logs({ title: '' }), 'x')).rejects.toThrow(/title is empty/);
    expect(existsSync(join(store.dir, 'find-request-logs'))).toBe(false);
  });

  it('keeps its references beside SKILL.md, takes them away when a new version has none, and gives them to sessions', async () => {
    const store = new AbilityStore(fresh('skills'));
    const detail = "Step 1 in full:\n\nwildfind '<requestId>' --env staging --from 1h\n";
    await store.write(logs({ references: detail }), 'learned');
    expect(readFileSync(join(store.dir, 'find-request-logs', 'references', 'steps.md'), 'utf8')).toBe(detail);
    expect(store.get('find-request-logs')!.references).toBe(detail);
    const copy = copyAbilities(store.dir, fresh('copy'))!;
    expect(readFileSync(join(copy.dir, 'skills', 'find-request-logs', 'references', 'steps.md'), 'utf8')).toBe(detail);
    await store.write(logs({ version: 2 }), 'updated');
    expect(existsSync(join(store.dir, 'find-request-logs', 'references', 'steps.md'))).toBe(false);
    expect(store.get('find-request-logs')!.references).toBeUndefined();
  });

  it('reaches sessions as SKILL.md and its files only: not ability.json, not .git', async () => {
    const store = new AbilityStore(fresh('skills'));
    await store.write(logs(), 'learned');
    const copy = copyAbilities(store.dir, fresh('copy'))!;
    expect(copy.names).toEqual(['abilities:find-request-logs']);
    expect(existsSync(join(copy.dir, 'skills', 'find-request-logs', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(copy.dir, 'skills', 'find-request-logs', 'ability.json'))).toBe(false);
    expect(existsSync(join(copy.dir, 'skills', '.git'))).toBe(false);
  });
});

describe('friction', () => {
  const call = (tool: string, t: string, failed = false, res = ''): Call => ({ tool, text: t, failed, result: res });

  it('reads a retry chain until the call that worked, a lone failure, a long search and a question about an environment', () => {
    const calls = [
      call('logs', "source logs | filter $l.applicationname in ['a']", true, 'Error querying logs, error code: 400, error message: Compilation errors: expected keyword [ at [0:40-0:42]'),
      call('logs', "source logs | filter $d ~~ 'x' | filter a !~ 'b'", true, 'Compilation errors: expected one of keywords'),
      call('logs', "source logs | wildfind 'x'", false),
      call('Bash', 'git push', true, 'Exit code 1'),
      ...Array.from({ length: 6 }, (_, i) => call('Grep', `pattern ${i}`)),
      call('Edit', 'x'),
      call('ask_user', 'Which staging namespace runs the result handler?'),
      call('ask_user', 'Is this a good variable name?'),
    ];
    const f = frictionOf(calls);
    expect(f.map((x) => `${x.kind} ${x.calls}`)).toEqual(['retried 3', 'failed 1', 'search 6', 'question 1']);
    expect(f[0]).toMatchObject({ signature: 'logs source logs', fixedBy: "source logs | wildfind 'x'", error: "Error querying logs, error code: N, error message: Compilation errors: expected keyword [ at [N:N-N:N]" });
    expect(f.filter(worthASkill).map((x) => x.kind)).toEqual(['retried', 'search', 'question']);
  });

  it('names a run tool call by its words, whatever context or namespace it names', () => {
    expect(signature({ tool: 'mcp__run__kube', text: '--context dev -n shop-dev get deployments request-handler' })).toBe('kube get deployments');
    expect(signature({ tool: 'kube', text: '--context staging -n shop-staging get deployments x' })).toBe('kube get deployments');
    expect(signature({ tool: 'Bash', text: 'cd /x && kubectl --context dev get pods' })).toBe('kubectl get pods');
    expect(errorClass("Error from server (NotFound): pods 'request-handler-7c85' not found in namespace 'x'")).toBe("Error from server (NotFound): pods '…' not found in namespace '…'");
  });

  it('reads his own commands as the run tool that does the same today', () => {
    expect(asRunTool('Bash', { command: 'kubectl --context dev get pods' })).toEqual({ tool: 'kube', text: '--context dev get pods' });
    expect(asRunTool('mcp__coralogix__query_dataprime', { query: "source logs | wildfind 'x'" })).toEqual({ tool: 'logs', text: "source logs | wildfind 'x'" });
    expect(asRunTool('Bash', { command: 'gh pr view 3' })).toEqual({ tool: 'gh', text: 'pr view 3' });
    expect(asRunTool('Bash', { command: 'k(){ kubectl --context minikube "$@"; }; k get pods' }).tool).toBe('kube');
    expect(asRunTool('Bash', { command: 'ls' })).toEqual({ tool: 'Bash', text: 'ls' });
  });

  it('measures a baseline per episode: the median steps, the mean failed calls and questions asked while it went on', () => {
    const s = (calls: Call[]) => ({ calls });
    const other = Array.from({ length: 20 }, () => call('Read', 'f'));
    const sessions = [
      s([call('logs', 'a', true), call('logs', 'b', true), call('ask_user', 'Which staging app has the results?'), call('logs', 'c'), ...other, call('logs', 'd')]),
      s([call('ask_user', 'Which staging app?'), call('logs', 'a'), call('Read', 'f'), call('ask_user', 'Is this name good?'), call('logs', 'b')]),
    ];
    const b = baselineOf({ tools: ['logs'] }, sessions);
    // A question before the episode began, or not about environments or process, is not counted.
    expect(b.episodes).toEqual([{ steps: 3, failed: 2, questions: 1 }, { steps: 1, failed: 0, questions: 0 }, { steps: 2, failed: 0, questions: 0 }]);
    expect(b).toMatchObject({ steps: 2, failed: 0.67, questions: 0.33, cases: 3 });
  });

  it('reads a cut summary for its arguments, command, skill and action', () => {
    expect(summaryInput('{"args":["--context","integration","get","deployments","request-handler","order-events-wo')).toEqual({ args: ['--context', 'integration', 'get', 'deployments', 'request-handler'] });
    expect(summaryInput('{"skill":"abilities:find-request-logs"}')).toEqual({ skill: 'abilities:find-request-logs' });
    expect(summaryInput('{"action":"fill","key":"SHOP-1","rootCause":"The sch')).toMatchObject({ action: 'fill' });
    expect(jsonIn('Here:\n```json\n{"skill": null}\n```')).toEqual({ skill: null });
    expect(jsonIn('{"steps": [1]} and more')).toEqual({ steps: [1] });
  });
});

describe('the engine', () => {
  let log: EventLog;
  let live: LiveState;
  let store: AbilityStore;
  let reads: Array<{ proxy: ProxyName; input: Record<string, unknown> }>;
  let readAnswer: (proxy: ProxyName, input: Record<string, unknown>) => { ok: boolean; text: string };
  let replies: string[];
  let prompts: string[];
  let announced: AbilityAnnouncement[];
  let revised: AbilityRevision[];
  let reviseAnswer: boolean;
  let engine: AbilityEngine;
  const now = Date.parse('2026-10-20T17:00:00Z');

  beforeEach(() => {
    log = new EventLog(':memory:', () => new Date(now));
    live = new LiveState(log);
    store = new AbilityStore(fresh('skills'));
    reads = [];
    readAnswer = () => ({ ok: true, text: 'rows' });
    replies = [];
    prompts = [];
    const queryFn: QueryFn = ({ prompt }) => {
      prompts.push(prompt);
      const reply = replies.shift() ?? '{"skill": null}';
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } } as never;
        yield result();
      })();
    };
    announced = [];
    revised = [];
    reviseAnswer = true;
    engine = new AbilityEngine({ log, state: () => live.get(), store, announce: (a) => announced.push(a), revise: (r) => (revised.push(r), reviseAnswer), read: async (proxy, input) => (reads.push({ proxy, input }), readAnswer(proxy, input)), queryFn, model: 'claude-opus-5-5', cwd: base, env: {}, now: () => now });
  });
  afterEach(() => {
    language.current = 'en';
    live.close();
    log.close();
  });

  const events = <T extends Parameters<EventLog['readFrom']>[2] extends infer _ ? string : never>(type: T) => log.readFrom(0, 10_000, [type]).map((e) => e.payload);
  const said = () => log.readFrom(0, 10_000, ['elfoqsy.message']).map((e) => (e.payload as PayloadOf<'elfoqsy.message'>).text);

  /** A run's tool calls, as the run logs them: each called (allowed or refused) and finished. */
  function runCalls(runId: string, calls: Array<{ tool: string; input: Record<string, unknown>; ok?: boolean; allowed?: boolean; out?: string }>) {
    log.append('orchestrator', 'run.created', { runId, ticket: 'SHOP-1', worktree: '/w', branch: 'b', agentNumber: 4, model: 'm', effort: 'high', budget: { tokens: 1, minutes: 1 }, repos: [] } as never);
    calls.forEach((c, i) => {
      const toolUseId = `${runId}-t${i}`;
      log.append('agent', 'tool.called', { runId, toolUseId, tool: c.tool, title: '', inputSummary: JSON.stringify(c.input).slice(0, 200), allowed: c.allowed ?? true });
      if (c.allowed !== false) log.append('agent', 'tool.finished', { runId, toolUseId, ok: c.ok ?? true, outputSummary: c.out ?? '', durationMs: 5 });
    });
  }

  it('learns what is on disk the log does not know, hands it to her to say, and verifies its reads and only its reads', async () => {
    await store.write(logs(), 'learned');
    await store.write(logs({ name: 'find-service-pod', title: "Find a service's pod", titleVi: 'tìm pod của một service', tool: 'kubernetes', steps: [{ text: 'List the deployments', code: 'get deploy', read: { proxy: 'kube', input: { args: ['--context', 'staging', 'get', 'deploy'] } } }], track: { tools: ['kube'] } }), 'learned');
    language.current = 'vi';
    expect(await engine.reconcile()).toEqual(['find-request-logs', 'find-service-pod']);
    // The engine says nothing itself: she is handed what she learned, once, to say in her own words.
    expect(said()).toEqual([]);
    expect(announced).toEqual([expect.objectContaining({ updated: false, abilities: [expect.objectContaining({ name: 'find-request-logs', titleVi: 'tìm log của một request' }), expect.objectContaining({ name: 'find-service-pod', titleVi: 'tìm pod của một service' })] })]);
    const s = live.get().abilities;
    expect(Object.keys(s)).toEqual(['find-request-logs', 'find-service-pod']);
    expect(s['find-request-logs']).toMatchObject({ version: 1, tool: 'coralogix', finder: { by: 'elfoqsy' }, baselineSteps: 5, uses: 0, level: 1, needsRecheck: null });
    // Two reads for the first, one for the second; the step with an effect and the note were never run.
    expect(reads.map((r) => r.proxy)).toEqual(['logs', 'logs', 'kube']);
    expect(s['find-request-logs']!.verification!.steps.map((x) => x.status)).toEqual(['ok', 'ok', 'unverified', 'unverified']);
    expect(s['find-request-logs']!.verification!.steps[2]!.note).toBe('It changes something, so it is never run to verify it.');
    // Once known and verified, a second start does nothing.
    expect(await engine.reconcile()).toEqual([]);
    expect(reads).toHaveLength(3);
  });

  it('hands her one skill to say, in Today’s conversation (made if there is none), and writes no line of its own', async () => {
    await engine.learn(logs());
    // No template glued to a title: nothing is said here, and she is told which ability and where.
    expect(said()).toEqual([]);
    const today = 'today-' + new Date(now).toLocaleDateString('en-CA');
    expect(live.get().conversations[today]).toBeDefined();
    expect(announced).toEqual([{ conversationId: today, updated: false, abilities: [{ name: 'find-request-logs', title: "Find a request's logs", titleVi: expect.any(String), tool: 'coralogix', whenToUse: expect.any(String), finder: { by: 'elfoqsy', session: 'friction analysis' }, source: 'friction analysis, 2026-10-20' }] }]);
  });

  it('says nothing when nothing is there to hand it to her (a test, simulate mode)', async () => {
    const quiet = new AbilityEngine({ log, state: () => live.get(), store, read: async () => ({ ok: true, text: 'rows' }), queryFn: (() => (async function* () {})()) as never, model: 'm', cwd: base, env: {} });
    await quiet.learn(logs({ name: 'quiet-one' }));
    expect(said()).toEqual([]);
    expect(live.get().abilities['quiet-one']).toBeDefined();
  });

  it('logs where each came from beside it, as its ability.json keeps it, once; one learned before that was kept is given it at a start', async () => {
    await engine.learn(logs());
    expect(events('ability.origin')).toEqual([{ name: 'find-request-logs', version: 1, foundAt: '2026-10-20T16:30:00.000Z', cases: 24, from: 'past work' }]);
    expect(live.get().abilities['find-request-logs']!.origin).toEqual({ foundAt: Date.parse('2026-10-20T16:30:00.000Z'), cases: 24, from: 'past work' });
    // A new version keeps its origin and does not log it again.
    await store.write(logs({ version: 2 }), 'updated');
    expect(await engine.reconcile()).toEqual([]);
    expect(events('ability.origin')).toHaveLength(1);
    // One logged before the origin existed (no ability.origin in the log): the start adds it, from the same file, and only once.
    await store.write(logs({ name: 'old-one', title: 'An old one', titleVi: 'một cái cũ', baseline: { steps: 3, failed: 0, questions: 0, cases: 6, from: 'runs in the log before the skill' }, createdAt: '2026-10-19T09:00:00.000Z' }), 'learned');
    const old = store.get('old-one')!;
    log.append('orchestrator', 'ability.learned', { name: old.name, version: 1, title: old.title, titleVi: old.titleVi, tool: old.tool, steps: [{ text: 'x', kind: 'note' }], finder: old.finder, baselineSteps: 3, baselineFailed: 0, baselineQuestions: 0, source: old.source });
    expect(live.get().abilities['old-one']!.origin).toBeNull();
    await engine.reconcile();
    expect(events('ability.origin').at(-1)).toEqual({ name: 'old-one', version: 1, foundAt: '2026-10-19T09:00:00.000Z', cases: 6, from: 'runs in the log before the skill' });
    expect(live.get().abilities['old-one']!.origin).toMatchObject({ cases: 6 });
    await engine.reconcile();
    expect(events('ability.origin')).toHaveLength(2);
  });

  it('tells a skill about no tool (`other`, from before every skill had one) which it is about, from the run tools it tracks, once, at a start: its card has a logo', async () => {
    // Hers: it tracks her own workspace tools (runs, events), so it is about her workspace, and its card shows her fox.
    await store.write(logs({ name: 'why-a-run-failed', title: 'Find why agent runs failed', titleVi: 'tìm lý do run của agent lỗi', tool: 'other', steps: [{ text: 'List failed runs', code: 'list_runs state=failed' }], track: { tools: ['list_runs', 'get_run', 'read_events'] } }), 'learned');
    await engine.reconcile();
    expect(live.get().abilities['why-a-run-failed']!.tool).toBe('elfoqsy');
    expect(store.get('why-a-run-failed')).toMatchObject({ tool: 'elfoqsy', version: 1 });
    expect(await store.history('why-a-run-failed')).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'retooled why-a-run-failed: elfoqsy' })]));
    // Not learned again as new, no notice for it, and a second start does nothing more.
    expect(announced).toEqual([expect.objectContaining({ abilities: [expect.objectContaining({ name: 'why-a-run-failed' })] })]);
    const learnedEvents = events('ability.learned').length;
    await engine.reconcile();
    expect(events('ability.learned')).toHaveLength(learnedEvents);
    // A track that names a service's tool is about that service; one nobody can place stays `other`.
    expect(toolOfTrack(['kube'])).toBe('kubernetes');
    expect(toolOfTrack(['logs', 'get_run'])).toBe('coralogix');
    expect(toolOfTrack(['gh'])).toBe('github');
    expect(toolOfTrack(['lookup_jira'])).toBe('jira');
    expect(toolOfTrack(['list_runs'])).toBe('elfoqsy');
    expect(toolOfTrack(['something-else'])).toBe('other');
    // Already with a tool: left as it is.
    await store.write(logs({ name: 'has-one', tool: 'aws', track: { tools: ['list_runs'] } }), 'learned');
    await engine.reconcile();
    expect(store.get('has-one')!.tool).toBe('aws');
  });

  describe('samples too long for a card’s line', () => {
    const longOne = (over: Partial<Ability> = {}): Ability =>
      logs({
        name: 'short-kube-output',
        title: 'Read kube lists short',
        titleVi: 'đọc danh sách kube ngắn',
        tool: 'kubernetes',
        steps: [
          { text: 'Pods: name, ready and restarts, oldest first', code: 'get pods -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount', read: { proxy: 'kube', input: { args: ['get', 'pods'] } } },
          { text: 'Only what is not running', code: 'get pods --field-selector status.phase!=Running' },
        ],
        track: { tools: ['kube'] },
        ...over,
      });

    it('hands her each ability with a step that does not fit, once: whole as stored, with which steps, in Today’s conversation', async () => {
      await store.write(logs(), 'learned');
      await store.write(longOne(), 'learned');
      await engine.reconcile();
      expect(await engine.askShorter()).toEqual(['short-kube-output']);
      expect(revised).toHaveLength(1);
      expect(revised[0]!.conversationId).toBe('today-' + new Date(now).toLocaleDateString('en-CA'));
      expect(revised[0]!.abilities).toEqual([{ ability: expect.objectContaining({ name: 'short-kube-output', steps: expect.any(Array) }), long: ['step 1: 44 + 138 characters', 'step 2: 24 + 47 characters'] }]);
      expect(live.get().conversations[revised[0]!.conversationId]).toBeDefined();
      expect(events('ability.shorten_asked')).toEqual([{ names: ['short-kube-output'] }]);
      // Not again, at a later start or when asked again.
      expect(await engine.askShorter()).toEqual([]);
      expect(revised).toHaveLength(1);
    });

    it('does not count it as asked when she cannot be handed anything yet, and asks at the next start', async () => {
      await store.write(longOne(), 'learned');
      await engine.reconcile();
      reviseAnswer = false;
      expect(await engine.askShorter()).toEqual([]);
      expect(events('ability.shorten_asked')).toEqual([]);
      reviseAnswer = true;
      expect(await engine.askShorter()).toEqual(['short-kube-output']);
    });

    it('asks nothing when every step fits, or where there is no one to hand it to (a test, simulate mode)', async () => {
      await store.write(logs(), 'learned');
      await engine.reconcile();
      expect(await engine.askShorter()).toEqual([]);
      await store.write(longOne(), 'learned');
      const quiet = new AbilityEngine({ log, state: () => live.get(), store, read: async () => ({ ok: true, text: 'rows' }), queryFn: (() => (async function* () {})()) as never, model: 'm', cwd: base, env: {} });
      expect(await quiet.askShorter()).toEqual([]);
      expect(events('ability.shorten_asked')).toEqual([]);
    });

    it('is updated quietly: the same ability, shorter samples and its references, no message and no line needed, credit and baseline kept', async () => {
      await store.write(longOne(), 'learned');
      await engine.reconcile();
      const before = said().length;
      const shorter = longOne({ steps: [{ text: 'Pods, oldest first', code: 'get pods -o custom-columns=…', read: { proxy: 'kube', input: { args: ['get', 'pods'] } } }, { text: 'Only what is not running', code: 'get pods --field-selector …' }] });
      const { name, title, titleVi, tool, whenToUse, steps, doneWhen, track } = shorter;
      const r = await engine.write({ name, title, titleVi, tool, whenToUse, steps, doneWhen, track, references: 'Pods in full: get pods -o custom-columns=NAME:.metadata.name,…' }, { update: true, quiet: true });
      expect(r).toMatchObject({ ok: true, version: 2 });
      expect(r).not.toHaveProperty('long');
      expect(said()).toHaveLength(before);
      expect(announced.filter((a) => a.updated)).toEqual([]);
      expect(store.get('short-kube-output')).toMatchObject({ version: 2, references: expect.stringContaining('Pods in full'), finder: { by: 'elfoqsy' }, baseline: longOne().baseline });
      expect(live.get().abilities['short-kube-output']!.steps[0]!.code).toBe('get pods -o custom-columns=…');
      expect(live.get().abilities['short-kube-output']!.verification).not.toBeNull();
    });

    it('is never quiet for a new ability, or without update: her line is still required', async () => {
      const d = { name: 'new-one', title: 'A new one', titleVi: 'một cái mới', tool: 'kubernetes' as const, whenToUse: 'x', steps: [{ text: 'x' }], doneWhen: 'y', track: { tools: ['kube'] } };
      expect(await engine.write(d, { quiet: true, friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'no_line' });
      await store.write(longOne(), 'learned');
      expect(await engine.write({ ...d, name: 'short-kube-output' }, { quiet: true, friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'no_line' });
      expect(store.get('new-one')).toBeUndefined();
    });

    it('tells her, when she writes one, which steps are still too long for a line (long), so she writes them again', async () => {
      const d = { name: 'long-one', title: 'Long one', titleVi: 'dài', tool: 'kubernetes' as const, whenToUse: 'x', steps: longOne().steps.map(({ read: _read, ...s }) => s), doneWhen: 'y', track: { tools: ['kube'] } };
      const r = await engine.write(d, { say: 'Tôi ghi lại cách đọc danh sách kube cho gọn.', friction: { what: 'four reads', calls: 4, failed: 0, questions: 0 } });
      expect(r).toMatchObject({ ok: true, long: ['step 1: 44 + 138 characters', 'step 2: 24 + 47 characters'] });
    });
  });

  it('marks a step that fails "needs re-check"; one that cannot run now stays unverified', async () => {
    readAnswer = (_p, input) => (String(input.query).startsWith('wildfind') ? { ok: false, text: 'Error querying logs, error code: 400, error message: Compilation errors: x at [0:1-0:2]' } : { ok: false, text: "Refused: alex's AWS session for staging has run out, so staging cannot be read now." });
    await engine.learn(logs());
    const v = live.get().abilities['find-request-logs']!;
    expect(v.verification!.steps.map((x) => x.status)).toEqual(['failed', 'unverified', 'unverified', 'unverified']);
    expect(v.needsRecheck).toMatchObject({ step: 0, reason: 'Error querying logs, error code: N, error message: Compilation errors: x at [N:N-N:N]' });
  });

  it('records a use against the baseline, and its level grows with the uses that worked', async () => {
    await engine.learn(logs());
    runCalls('run-a', [
      { tool: 'Read', input: { file_path: 'x' } },
      { tool: 'Skill', input: { skill: 'abilities:find-request-logs' } },
      { tool: 'mcp__run__logs', input: { query: "wildfind 'r1'" } },
      { tool: 'mcp__run__logs', input: { query: "filter $l.subsystemname == 'request-handler'" } },
      { tool: 'mcp__run__kube', input: { args: ['get', 'pods'] } },
    ]);
    await engine.runEnded({ runId: 'run-a', agentNumber: 4, ticket: 'SHOP-1', state: 'succeeded' });
    expect(events('ability.used')).toEqual([{ name: 'find-request-logs', runId: 'run-a', worked: true, steps: 2, baselineSteps: 5, failedCalls: 0, baselineFailed: 1.5, questions: 0, baselineQuestions: 0.5 }]);
    const v = live.get().abilities['find-request-logs']!;
    // 3 steps under the median and 1.5 failed calls under the mean; half a question avoided, apart.
    expect(v).toMatchObject({ uses: 1, worked: 1, stepsSaved: 4.5, savedByMonth: { '2026-10': 4.5 }, questionsAvoided: 0.5, level: 1 });
  });

  it('does not count a skill loaded and never acted on, nor a tester’s run', async () => {
    await engine.learn(logs());
    runCalls('run-b', [{ tool: 'Skill', input: { skill: 'find-request-logs' } }, { tool: 'Read', input: {} }]);
    await engine.runEnded({ runId: 'run-b', agentNumber: 4, state: 'succeeded' });
    runCalls('run-t', [{ tool: 'Skill', input: { skill: 'find-request-logs' } }, { tool: 'mcp__run__logs', input: { query: 'x' } }]);
    await engine.runEnded({ runId: 'run-t', agentNumber: 5, state: 'succeeded', test: true });
    expect(events('ability.used')).toEqual([]);
  });

  it('after a use that failed: needs re-check, verified again, and a step that really fails is repaired and verified', async () => {
    await engine.learn(logs());
    // Its first read now fails on the platform; the rewritten step works.
    readAnswer = (_p, input) => (String(input.query).startsWith('wildfind') ? { ok: false, text: 'Compilation errors: wildfind is gone' } : { ok: true, text: 'rows' });
    replies.push(JSON.stringify({ steps: [{ text: 'Search the environment for the id', code: "filter $d ~~ '<requestId>'", read: { proxy: 'logs', input: { environment: 'staging', query: "filter $d ~~ 'x' | limit 1" } } }, ...logs().steps.slice(1)] }));
    runCalls('run-c', [{ tool: 'Skill', input: { skill: 'abilities:find-request-logs' } }, { tool: 'mcp__run__logs', input: { query: "wildfind 'r1'" }, ok: false, out: 'Compilation errors: wildfind is gone' }]);
    await engine.runEnded({ runId: 'run-c', agentNumber: 4, state: 'failed' });
    expect(events('ability.used')).toEqual([{ name: 'find-request-logs', runId: 'run-c', worked: false, steps: 1, baselineSteps: 5, failedCalls: 1, baselineFailed: 1.5, questions: 0, baselineQuestions: 0.5 }]);
    expect(events('ability.needs_recheck')[0]).toMatchObject({ name: 'find-request-logs', version: 1, step: 0 });
    expect(prompts[0]).toContain('1. failed: Compilation errors: wildfind is gone');
    expect(events('ability.repaired')).toEqual([{ name: 'find-request-logs', version: 2, steps: expect.arrayContaining([{ text: 'Search the environment for the id', code: "filter $d ~~ '<requestId>'", kind: 'read' }]), reason: 'step 1: Compilation errors: wildfind is gone' }]);
    const v = live.get().abilities['find-request-logs']!;
    expect(v).toMatchObject({ version: 2, needsRecheck: null, uses: 1, worked: 0, level: 1 });
    expect(v.verification!.steps.map((x) => x.status)).toEqual(['ok', 'ok', 'unverified', 'unverified']);
    expect(store.get('find-request-logs')!.version).toBe(2);
    expect((await store.history('find-request-logs'))[0]!.message).toBe('repaired find-request-logs v2: step 1: Compilation errors: wildfind is gone');
  });

  it('a use that failed for the run, not the skill: verified again, cleared, nothing rewritten', async () => {
    await engine.learn(logs());
    runCalls('run-d', [{ tool: 'Skill', input: { skill: 'find-request-logs' } }, { tool: 'mcp__run__logs', input: { query: "wildfind 'r1'" }, ok: false, out: 'The request id has no logs.' }]);
    await engine.runEnded({ runId: 'run-d', agentNumber: 4, state: 'failed' });
    expect(events('ability.repaired')).toEqual([]);
    expect(prompts).toEqual([]);
    expect(live.get().abilities['find-request-logs']!.needsRecheck).toBeNull();
  });

  it('reviews a run’s friction at its end and learns the skill that would have removed it, credited to the agent', async () => {
    runCalls('run-e', [
      { tool: 'mcp__run__kube', input: { args: ['--context', 'integration', 'get', 'deployments', 'order-worker'] }, ok: false, out: "Error from server (NotFound): deployments.apps 'order-worker' not found" },
      { tool: 'mcp__run__kube', input: { args: ['--context', 'integration', 'get', 'deployments', 'normal-order-worker'] }, ok: false, out: 'NotFound' },
      { tool: 'mcp__run__kube', input: { args: ['--context', 'integration', 'get', 'deployments', '-o', 'name'] } },
    ]);
    // An earlier run did the same kind of task in 5 calls: the baseline is the median of this run and that one.
    runCalls('run-old', Array.from({ length: 5 }, () => ({ tool: 'mcp__run__kube', input: { args: ['get', 'deploy'] } })));
    replies.push(
      JSON.stringify({
        skill: {
          name: 'find-service-pod',
          title: "Find a service's pod",
          titleVi: 'tìm pod của một service',
          tool: 'kubernetes',
          whenToUse: 'Deployment names differ by environment.',
          steps: [{ text: 'List the deployments first', code: 'get deploy -o name', read: { proxy: 'kube', input: { args: ['--context', 'integration', 'get', 'deploy', '-o', 'name'] } } }],
          doneWhen: 'The name comes from a fresh listing.',
          track: { tools: ['kube'], match: 'get (deploy|deployments)' },
        },
      }),
    );
    await engine.runEnded({ runId: 'run-e', agentNumber: 7, ticket: 'SHOP-3488', state: 'succeeded' });
    expect(prompts[0]).toContain('A run just ended: Agent 7 on SHOP-3488, succeeded.');
    expect(prompts[0]).toContain('retried, 3 calls: kube get deployments');
    expect(prompts[0]).toContain('it worked with: --context integration get deployments -o name');
    const v = live.get().abilities['find-service-pod']!;
    expect(v).toMatchObject({ finder: { by: 'agent', agentNumber: 7, runId: 'run-e', ticket: 'SHOP-3488' }, source: 'SHOP-3488, Agent 7', baselineSteps: 4, baselineFailed: 1, baselineQuestions: 0 });
    expect(store.get('find-service-pod')!.baseline).toEqual({ steps: 4, failed: 1, questions: 0, cases: 2, from: 'runs in the log before the skill' });
    expect(said()).toEqual([]);
    expect(announced).toEqual([expect.objectContaining({ updated: false, abilities: [expect.objectContaining({ name: 'find-service-pod', finder: { by: 'agent', agentNumber: 7, runId: 'run-e', ticket: 'SHOP-3488' } })] })]);
    expect(v.verification!.steps.map((s) => s.status)).toEqual(['ok']);
  });

  it('a reviewed skill with no tool of its own is about the tool it tracks, never `other` (a card with a sparkle)', async () => {
    runCalls('run-f', [
      { tool: 'mcp__run__kube', input: { args: ['get', 'pods', 'x'] }, ok: false, out: 'NotFound' },
      { tool: 'mcp__run__kube', input: { args: ['get', 'pods', 'y'] }, ok: false, out: 'NotFound' },
      { tool: 'mcp__run__kube', input: { args: ['get', 'pods', '-o', 'name'] } },
    ]);
    replies.push(JSON.stringify({ skill: { name: 'list-pods-first', title: 'List the pods first', titleVi: 'liệt kê pod trước', tool: 'other', whenToUse: 'A pod name is wrong.', steps: [{ text: 'List them', code: 'get pods -o name', read: { proxy: 'kube', input: { args: ['get', 'pods', '-o', 'name'] } } }], doneWhen: 'The name comes from the list.', track: { tools: ['kube'] } } }));
    await engine.runEnded({ runId: 'run-f', agentNumber: 3, ticket: 'SHOP-9', state: 'succeeded' });
    expect(live.get().abilities['list-pods-first']!.tool).toBe('kubernetes');
  });

  it('counts the questions to him a run’s use still asked, and what it took over the baselines saves nothing', async () => {
    await engine.learn(logs());
    runCalls('run-q', [
      { tool: 'Skill', input: { skill: 'find-request-logs' } },
      { tool: 'mcp__run__logs', input: { query: 'a' }, ok: false },
      { tool: 'mcp__run__ask_user', input: { question: 'Which staging app holds the results?' } },
      { tool: 'mcp__run__logs', input: { query: 'b' }, ok: false },
      ...Array.from({ length: 5 }, () => ({ tool: 'mcp__run__logs', input: { query: 'c' } })),
    ]);
    await engine.runEnded({ runId: 'run-q', agentNumber: 4, state: 'succeeded' });
    expect(events('ability.used')).toEqual([{ name: 'find-request-logs', runId: 'run-q', worked: true, steps: 7, baselineSteps: 5, failedCalls: 2, baselineFailed: 1.5, questions: 1, baselineQuestions: 0.5 }]);
    expect(live.get().abilities['find-request-logs']).toMatchObject({ uses: 1, worked: 1, stepsSaved: 0, questionsAvoided: 0 });
  });

  it('in her conversation: a Skill call is a use; it worked when the calls after it succeeded and she asked him nothing', async () => {
    await engine.learn(logs());
    const skill = { tool: 'Skill', text: '{"skill":"abilities:find-request-logs"}', failed: false, skill: 'find-request-logs' };
    const read = (failed = false) => ({ tool: 'mcp__orchestrator__logs', text: "wildfind 'x'", failed });
    await engine.sessionUses({ in: 'conversation', id: 'c1', calls: [skill, read(), read()] });
    await engine.sessionUses({ in: 'conversation', id: 'c1', calls: [skill], askedHim: false });
    await engine.sessionUses({ in: 'conversation', id: 'c2', calls: [skill, read()], askedHim: true });
    const used = events('ability.used') as Array<PayloadOf<'ability.used'>>;
    expect(used.map((u) => [u.in, u.runId, u.worked, u.steps, u.questions])).toEqual([
      ['conversation', 'c1', true, 2, 0],
      ['conversation', 'c1', true, 0, 0],
      ['conversation', 'c2', false, 1, 1],
    ]);
    // A question is not a failing step: nothing to check again.
    expect(events('ability.needs_recheck')).toEqual([]);
    await engine.sessionUses({ in: 'conversation', id: 'c3', calls: [skill, read(true), read()] });
    expect((events('ability.used').at(-1) as PayloadOf<'ability.used'>).worked).toBe(false);
    expect(events('ability.needs_recheck')).toHaveLength(1);
    expect(live.get().abilities['find-request-logs']).toMatchObject({ uses: 4, worked: 2 });
  });

  it('in an investigation: a use is measured like a run’s, up to its report; a turn with no skill is nothing', async () => {
    await engine.learn(logs());
    const skill = { tool: 'Skill', text: '', failed: false, skill: 'find-request-logs' };
    await engine.sessionUses({ in: 'investigation', id: 'inv-1', calls: [skill, { tool: 'Grep', text: 'x', failed: false }] });
    await engine.sessionUses({ in: 'investigation', id: 'inv-2', calls: [skill, { tool: 'logs', text: 'a', failed: true }, { tool: 'logs', text: 'b', failed: false }] });
    await engine.sessionUses({ in: 'conversation', id: 'c9', calls: [{ tool: 'mcp__orchestrator__logs', text: 'a', failed: false }] });
    expect(events('ability.used')).toEqual([{ name: 'find-request-logs', runId: 'inv-2', in: 'investigation', worked: true, steps: 2, baselineSteps: 5, failedCalls: 1, baselineFailed: 1.5, questions: 0, baselineQuestions: 0.5 }]);
  });

  it('asks nothing when a run had no friction, or only friction a known skill covers', async () => {
    await engine.learn(logs());
    runCalls('run-f', [{ tool: 'mcp__run__kube', input: { args: ['get', 'pods'] } }]);
    runCalls('run-g', [{ tool: 'mcp__run__logs', input: { query: 'a' }, ok: false, out: 'Compilation errors' }, { tool: 'mcp__run__logs', input: { query: 'b' } }]);
    await engine.runEnded({ runId: 'run-f', agentNumber: 1, state: 'succeeded' });
    await engine.runEnded({ runId: 'run-g', agentNumber: 2, state: 'succeeded' });
    expect(prompts).toEqual([]);
  });

  it('never writes what the model proposes when it is not valid', async () => {
    runCalls('run-h', Array.from({ length: 6 }, (_, i) => ({ tool: 'Grep', input: { pattern: `p${i}` } })));
    replies.push(JSON.stringify({ skill: { name: 'Bad Name', title: 't', titleVi: 't', tool: 'other', whenToUse: 'w', steps: [{ text: 's' }], doneWhen: 'd', track: { tools: ['Grep'] } } }));
    await engine.runEnded({ runId: 'run-h', agentNumber: 1, state: 'succeeded' });
    expect(prompts).toHaveLength(1);
    expect(store.list()).toEqual([]);
    expect(events('ability.learned')).toEqual([]);
  });

  const draft = (over: Partial<Ability> = {}) => {
    const { name, title, titleVi, tool, whenToUse, steps, doneWhen, track } = logs(over);
    return { name, title, titleVi, tool, whenToUse, steps, doneWhen, track };
  };
  const herConversation = () => log.append('orchestrator', 'conversation.created', { conversationId: 'c-her', title: 'Why is staging quiet?' });

  it('writes her own ability: credited to her and her conversation, its friction as its baseline, its line and card there, verified', async () => {
    herConversation();
    const r = await engine.write(draft({ name: 'count-logs-per-hour', title: 'Count logs per hour before searching an id', titleVi: 'đếm log theo giờ trước khi tìm một id' }), { conversationId: 'c-her', say: 'Từ giờ tôi đếm log theo giờ trước khi tìm một id.', friction: { what: 'four empty id searches', calls: 9, failed: 1, questions: 0 } });
    expect(r).toMatchObject({ ok: true, name: 'count-logs-per-hour', version: 1 });
    const a = store.get('count-logs-per-hour')!;
    expect(a.finder).toEqual({ by: 'elfoqsy', session: 'c-her' });
    expect(a.source).toBe('Why is staging quiet?, Elfoqsy');
    expect(a.baseline).toEqual({ steps: 9, failed: 1, questions: 0, cases: 1, from: 'her own work: four empty id searches' });
    // Her own words, as she wrote them, with the ability's card; the engine adds nothing to them.
    expect(live.get().messages.at(-1)).toMatchObject({ conversationId: 'c-her', text: 'Từ giờ tôi đếm log theo giờ trước khi tìm một id.', blocks: [{ type: 'ability', ref: 'count-logs-per-hour' }] });
    expect(announced).toEqual([]);
    expect(live.get().abilities['count-logs-per-hour']!.verification!.steps.map((x) => x.status)).toEqual(['ok', 'ok', 'unverified', 'unverified']);
    expect((await store.history('count-logs-per-hour'))[0]!.message).toBe('learned count-logs-per-hour: Count logs per hour before searching an id (Elfoqsy)');
  });

  it('updates one as its next version, keeping who found it and its baseline; she says it in her own words', async () => {
    herConversation();
    await engine.learn(logs());
    const r = await engine.write(draft({ whenToUse: "'trace request X', 'tìm requestId này': what happened to it.", steps: logs().steps.slice(0, 2) }), { update: true, conversationId: 'c-her', say: 'I changed how I trace a request: two steps now.' });
    expect(r).toMatchObject({ ok: true, version: 2 });
    const a = store.get('find-request-logs')!;
    expect(a).toMatchObject({ version: 2, finder: { by: 'elfoqsy', session: 'friction analysis' }, baseline: logs().baseline, whenToUse: "'trace request X', 'tìm requestId này': what happened to it." });
    expect(said().at(-1)).toBe('I changed how I trace a request: two steps now.');
    expect(live.get().abilities['find-request-logs']).toMatchObject({ version: 2, steps: [expect.anything(), expect.anything()] });
  });

  it('refuses a name that exists without update, an update of none, a new one with no friction, and one that is not valid', async () => {
    await engine.learn(logs());
    const say = 'A line of hers.';
    expect(await engine.write(draft(), { say, friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'exists' });
    expect(await engine.write(draft({ name: 'nope' }), { say, update: true })).toMatchObject({ error: 'unknown' });
    expect(await engine.write(draft({ name: 'new-one' }), { say })).toMatchObject({ error: 'no_friction' });
    // Without her line it is not written at all: no one else makes it up.
    expect(await engine.write(draft({ name: 'new-one' }), { friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'no_line' });
    expect(await engine.write(draft({ name: 'new-one' }), { say: '   ', friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'no_line' });
    expect(await engine.write(draft({ name: 'new-one', title: 'x'.repeat(61) }), { say, friction: { what: 'x', calls: 1, failed: 0, questions: 0 } })).toMatchObject({ error: 'not_valid', message: expect.stringMatching(/title is empty or longer than 60/) });
    expect(store.list().map((a) => a.name)).toEqual(['find-request-logs']);
  });

  it('records a missed use: a task an ability covers, done without it, in a run or her conversation; a loaded one is not missed', async () => {
    await engine.learn(logs());
    runCalls('run-m', [{ tool: 'mcp__run__logs', input: { query: 'a' } }, { tool: 'mcp__run__logs', input: { query: 'b' } }]);
    await engine.runEnded({ runId: 'run-m', agentNumber: 3, state: 'succeeded' });
    await engine.sessionUses({ in: 'conversation', id: 'c1', calls: [{ tool: 'mcp__orchestrator__logs', text: 'a', failed: false }, { tool: 'mcp__orchestrator__logs', text: 'b', failed: false }, { tool: 'mcp__orchestrator__logs', text: 'c', failed: false }] });
    // One of its kind is not a task; with the skill loaded it is a use, not a miss.
    await engine.sessionUses({ in: 'conversation', id: 'c2', calls: [{ tool: 'mcp__orchestrator__logs', text: 'a', failed: false }] });
    await engine.sessionUses({ in: 'conversation', id: 'c3', calls: [{ tool: 'Skill', text: '', failed: false, skill: 'find-request-logs' }, { tool: 'mcp__orchestrator__logs', text: 'a', failed: false }, { tool: 'mcp__orchestrator__logs', text: 'b', failed: false }] });
    expect(events('ability.missed')).toEqual([
      { name: 'find-request-logs', runId: 'run-m', steps: 2 },
      { name: 'find-request-logs', runId: 'c1', in: 'conversation', steps: 3 },
    ]);
    expect(live.get().abilities['find-request-logs']).toMatchObject({ missed: 2, uses: 1 });
  });

  it('at a start, learns a newer version on disk again (its new description), and hands her own new ones to her in her conversation', async () => {
    herConversation();
    await engine.learn(logs());
    await store.write(logs({ version: 2, whenToUse: "'trace request X': what happened to it." }), 'updated');
    await store.write(logs({ name: 'teams-chat-direct', title: 'Read a Teams group chat directly', titleVi: 'đọc thẳng một group chat Teams', tool: 'teams', steps: [{ text: 'Find the chat', code: 'teams_list_chats' }], finder: { by: 'elfoqsy', session: 'c-her' }, track: { tools: ['teams_list_chats'] } }), 'learned');
    const before = said().length;
    const handed = announced.length;
    expect(await engine.reconcile()).toEqual(['teams-chat-direct']);
    expect(live.get().abilities['find-request-logs']).toMatchObject({ version: 2 });
    // Hers, found in her conversation: she is handed it to say there.
    expect(said().slice(before)).toEqual([]);
    expect(announced.slice(handed)).toEqual([expect.objectContaining({ conversationId: 'c-her', abilities: [expect.objectContaining({ name: 'teams-chat-direct', tool: 'teams' })] })]);
  });

  it('reads a run’s calls from the log: refused ones fail, and a skill call names its skill', () => {
    runCalls('run-i', [{ tool: 'Skill', input: { skill: 'abilities:x' } }, { tool: 'Bash', input: { command: 'gh pr checks 3' }, allowed: false }]);
    expect(callsOfRun(log, 'run-i')).toEqual([
      { tool: 'Skill', text: '{"skill":"abilities:x"}', failed: false, result: '', toolUseId: 'run-i-t0', skill: 'x' },
      { tool: 'Bash', text: 'gh pr checks 3', failed: true, result: 'refused by the gate\n', toolUseId: 'run-i-t1' },
    ]);
  });
});

describe('her ability block', () => {
  it('shows an ability she has, and is refused for one she does not', async () => {
    const { blockProblems } = await import('../src/elfoqsy/blocks');
    const log = new EventLog(':memory:');
    const live = new LiveState(log);
    const store = new AbilityStore(fresh('skills'));
    const engine = new AbilityEngine({ log, state: () => live.get(), store, read: async () => ({ ok: true, text: '' }), queryFn: (() => (async function* () {})()) as never, model: 'm', cwd: base, env: {} });
    await engine.learn(logs());
    expect(blockProblems(live.get(), [{ type: 'ability', ref: 'find-request-logs' }])).toEqual([]);
    expect(blockProblems(live.get(), [{ type: 'ability', ref: 'nope' }])[0]).toMatch(/there is no ability nope/);
    live.close();
    log.close();
  });
});

describe('levels', () => {
  it('are 1, 3, 8, 15 and 30 verified successful uses', () => {
    expect(ABILITY_LEVELS).toEqual([1, 3, 8, 15, 30]);
    // A new ability is level 1 (written and verified); it reaches 2, 3, 4 and 5 at 3, 8, 15 and 30 uses that worked.
    expect([0, 1, 2, 3, 7, 8, 14, 15, 29, 30, 100].map(abilityLevel)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('the orchestrator', () => {
  it('tells the engine when a ticket run ends, with its agent, ticket and end', async () => {
    const runEnded = vi.fn(async () => undefined);
    const w = orchestratorWorld({ tickets: true, overrides: { abilities: { runEnded } } });
    const ticket = { key: 'SHOP-3546', board: 'SHOP', summary: 'x', type: 'Bug', status: 'To do', priority: 'Major', storyPoints: 1, sprint: 's', sprintsCarried: 1, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: 'd' } as Ticket;
    w.log.append('jira', 'ticket.synced', { ticket });
    const r = await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
    await tick();
    w.sdk.sessions.at(-1)!.emit(text('working'));
    await w.orchestrator.cancel((r as { runId: string }).runId, 'Test over.');
    await tick(20);
    expect(runEnded).toHaveBeenCalledWith({ runId: (r as { runId: string }).runId, agentNumber: 1, ticket: 'SHOP-3546', state: 'cancelled' });
    await w.close();
  });
});
