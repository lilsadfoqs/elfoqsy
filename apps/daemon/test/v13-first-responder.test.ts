// v1.3, items 6 and 7: Elfoqsy is the first responder. Tier-2 requests in a category alex delegated are decided in
// her name with no model call; the rest reach him as a card with her suggestion. An agent's question goes to her
// responder session (the fake SDK here), which answers only from sources it read, else escalates. Precedents, changes,
// undos and the digest of what she decided while he was away. Every backend is a fake; nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, EventType, PayloadOf, QuestionCard, Ticket } from '@elfoqsy/contracts';
import { Approvals } from '../src/agents/approvals';
import { UsageState } from '../src/claude/usage';
import { actionCategory, effectiveSetting } from '../src/decisions/categories';
import { AWAY_MS, Digests } from '../src/decisions/digest';
import { FirstResponder } from '../src/decisions/firstResponder';
import { citeProblem, Reads, Responder } from '../src/decisions/responder';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveState } from '../src/elfoqsy/liveState';
import type { Lookups } from '../src/elfoqsy/lookups';
import { EventLog } from '../src/eventLog';
import { createProxies } from '../src/permissions';
import { Grants } from '../src/permissions/grants';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import { ManualClock, fakeSdk, result, runTool, text, tick } from './helpers/fakeSdk';
import { deploymentJson, environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const INTEGRATION = '--context integration';
const STAGING = '--context staging';
const T0 = Date.parse('2026-10-12T17:00:00Z');

let clock: ManualClock;
let log: EventLog;
let live: LiveState;
let usage: UsageState;
let approvals: Approvals;
let grants: Grants;
let backends: FakeBackends;
let proxies: Proxies;
let first: FirstResponder;
let sdk: ReturnType<typeof fakeSdk>;
let told: Array<[string, string, string]>;

const run: ProxyRun = {
  runId: 'run-2',
  ticket: 'SHOP-2091',
  agentNumber: 2,
  branch: 'feature/SHOP-2091',
  targets: [{ repo: SHOP_API, base: 'master' }],
  kubeconfig: '/data/runs/run-2/kubeconfig',
};

const ticket = (key: string, type: Ticket['type'] = 'Bug'): Ticket => ({
  key,
  board: 'SHOP',
  summary: 'The bundle discount reduces the whole cart',
  type,
  status: 'In progress',
  priority: 'Major',
  storyPoints: 3,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 0,
  epic: null,
  reporter: 'r',
  created: '2026-10-01',
  updated: '2026-10-01',
  labels: [],
  linked: [],
  description: 'AC: a bundle discount applies to the bundle items only.',
});

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const kube = (args: string) => proxies.request(run, 'kube', { args: args.split(' ') });
const jira = (body: Record<string, unknown>) => proxies.request(run, 'jira', body);
const open = () => payloads('approval.requested').filter((a) => !payloads('approval.resolved').some((r) => r.approvalId === a.approvalId));
async function answerOpen(decision: 'approved' | 'denied' | 'answered', extra: { answer?: string; precedent?: true; test?: true } = {}): Promise<PayloadOf<'approval.requested'>> {
  for (let i = 0; i < 100 && !open().length; i++) await tick(5);
  const a = open().at(-1)!;
  log.append('orchestrator', 'approval.resolved', { approvalId: a.approvalId, decision, ...extra });
  await tick(5);
  return a;
}

/** Her lookups, as fakes: a Jira read of the run's AC, a page, a few lines of code. */
const lookups = {
  jira: async (a: { key?: string }) => ({ key: a.key ?? 'SHOP-1201', summary: 'QA suite', description: 'bundle discount -> bundle items only' }),
  confluence: async (a: { pageId?: string }) => ({ id: a.pageId, title: 'Release/2.22.0', text: '...' }),
  code: (a: { repo: string; path?: string; from?: number; lines?: number }) => ({ repo: a.repo, path: a.path, from: a.from ?? 1, to: (a.from ?? 1) + (a.lines ?? 40) - 1, totalLines: 200, text: '...' }),
  logs: async () => ({ logs: 'no rows' }),
  github: async () => ({}),
} as unknown as Lookups;

function build(o: { responder?: boolean } = {}): void {
  approvals = new Approvals(log, undefined, clock);
  grants = new Grants(log, { clock, now: () => clock.now });
  const responder = o.responder
    ? new Responder({ state: () => live.get(), usage, queryFn: sdk.queryFn, lookups, systemPrompt: 'You are Elfoqsy.', model: 'claude-opus-5-5', cwd: '/tmp', env: {}, clock })
    : undefined;
  first = new FirstResponder({
    log,
    state: () => live.get(),
    approvals,
    ...(responder ? { responder } : {}),
    say: (runId, t, blocks) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text: t, conversationId: 'c1', refs: { runId }, ...(blocks ? { blocks } : {}) }),
    tell: (runId, t, from) => told.push([runId, t, from]),
  });
  proxies = createProxies({
    log,
    approvals,
    grants,
    environments,
    backends,
    repos: [SHOP_API],
    say: (_run, t) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text: t, refs: { runId: _run.runId } }),
    endedRun: async () => ({ run, dispose: () => undefined }),
    firstResponder: () => first,
    now: () => clock.now,
  });
  proxies.register(run);
}

beforeEach(() => {
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-2091') });
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3600', 'Story') });
  log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'SHOP-2091', ticket: 'SHOP-2091' });
  log.append('orchestrator', 'run.created', { runId: run.runId, ticket: run.ticket, worktree: '/runs/x', branch: run.branch, agentNumber: 2, conversationId: 'c1' });
  live = new LiveState(log);
  usage = new UsageState(log, clock, () => clock.now);
  backends = fakeBackends();
  backends.kubeAnswers.set('get deployment/shop-integration-test -o json', deploymentJson('shop-integration-test', 'it:2.21.3', { replicas: 1, namespace: 'shop-integration' }));
  sdk = fakeSdk();
  told = [];
  build();
});

afterEach(() => {
  first.close();
  proxies.close();
  grants.close();
  approvals.close();
  usage.close();
  live.close();
  log.close();
});

describe('the categories, from how a request was classified', () => {
  it('maps tier-2 kinds to his categories, with no model involved', () => {
    expect(actionCategory('kube', { kind: 'kube.set_image', environment: 'integration', harness: true })).toBe('harness_kube');
    expect(actionCategory('shop', { kind: 'shop.build_integration_test', environment: 'integration', harness: true })).toBe('harness_image');
    expect(actionCategory('docker', { kind: 'docker.push', environment: 'dev', harness: true })).toBe('harness_image');
    expect(actionCategory('kube', { kind: 'kube.set_image', environment: 'staging', harness: true })).toBe('staging_write');
    expect(actionCategory('gh', { kind: 'gh.run.rerun_other' })).toBe('ci_rerun');
    expect(actionCategory('gh', { kind: 'gh.pr.ready' })).toBe('notify_people');
    expect(actionCategory('jira', { kind: 'jira.transition' })).toBe('notify_people');
    expect(actionCategory('confluence', { kind: 'confluence.create' })).toBe('notify_people');
    expect(actionCategory('kube', { kind: 'kube.read_secret', environment: 'dev' })).toBe('read_secret');
    expect(actionCategory('logs', { kind: 'logs.prod', environment: 'prod' })).toBe('prod_logs');
    expect(actionCategory('kube', { kind: 'kube.traffic', environment: 'dev' })).toBe('irreversible');
    expect(actionCategory('gh', { kind: 'gh.workflow.run' })).toBe('irreversible');
    expect(actionCategory('jira', { kind: 'jira.fill_over' })).toBe('irreversible');
    expect(actionCategory('file', { kind: 'file.outside' })).toBe('other');
    // What deletes stays irreversible wherever it lands: the harness's own image, or staging.
    expect(actionCategory('aws', { kind: 'aws.ecr_delete_image', environment: 'integration', harness: true })).toBe('irreversible');
    expect(actionCategory('docker', { kind: 'docker.rmi', environment: 'dev', harness: true })).toBe('irreversible');
    expect(actionCategory('kube', { kind: 'kube.delete', environment: 'staging' })).toBe('irreversible');
    expect(actionCategory('gh', { kind: 'gh.cache.delete' })).toBe('irreversible');
  });

  it('starts from his defaults: decide, decide and tell, or ask', () => {
    const s = live.get();
    expect(['run_folder', 'sourced_answer', 'ci_rerun'].map((c) => effectiveSetting(s, c as never, run.runId).setting)).toEqual(['decide', 'decide', 'decide']);
    expect(['harness_kube', 'harness_image'].map((c) => effectiveSetting(s, c as never, run.runId).setting)).toEqual(['decide_and_tell', 'decide_and_tell']);
    expect(['unsourced', 'notify_people', 'staging_write', 'read_secret', 'prod_logs', 'irreversible', 'other'].map((c) => effectiveSetting(s, c as never, run.runId).setting)).toEqual(Array(7).fill('ask'));
  });
});

describe('a tier-2 request he delegated', () => {
  it('is decided at once in her name, run, recorded with Undo, and told: a harness restart on integration', async () => {
    const r = await kube(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    expect(r, r.text).toMatchObject({ ok: true });
    expect(r.text).toContain('(Elfoqsy decided it for alex, as he delegated this kind of request to her.)');
    const [made] = payloads('decision.made');
    expect(made).toMatchObject({ runId: 'run-2', requestKind: 'action', category: 'harness_kube', answer: 'approved', basis: 'delegation', told: true, actionId: r.actionId, sources: [{ kind: 'setting', ref: 'harness_kube' }] });
    expect(payloads('action.classified')).toEqual([expect.objectContaining({ actionId: r.actionId, tier: 2, decision: 'elfoqsy', decisionId: made!.decisionId })]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(payloads('change.recorded')[0]).toMatchObject({ actionId: r.actionId, undo: expect.anything() });
    expect(payloads('elfoqsy.message').find((m) => m.blocks?.[0]?.type === 'decision')).toMatchObject({
      text: expect.stringMatching(/^I let Agent 2 on SHOP-2091 kubectl .*set image deployment\/shop-integration-test.*: you delegated a test-harness change to me\.$/),
      blocks: [{ type: 'decision', ref: made!.decisionId }],
    });
    // His Undo of it counts as changing her decision.
    const recordId = payloads('change.recorded')[0]!.recordId;
    expect(await proxies.undo(recordId, 'you')).toEqual({ ok: true });
    expect(payloads('decision.changed')).toEqual([{ decisionId: made!.decisionId, by: 'you', how: 'undone' }]);
  });

  it('is decided silently when he set it to decide, and asked again when he sets it back to ask', async () => {
    log.append('orchestrator', 'delegation.set', { category: 'staging_write', setting: 'decide', by: 'you' });
    backends.kubeAnswers.set('rollout restart', { ok: true, stdout: 'restarted', stderr: '' });
    const r = await kube(`${STAGING} -n shop-staging rollout restart deployment/shop-integration-test`);
    expect(r.ok).toBe(true);
    expect(payloads('decision.made').at(-1)).toMatchObject({ category: 'staging_write', told: false });
    expect(payloads('elfoqsy.message').filter((m) => m.blocks?.some((b) => b.type === 'decision'))).toEqual([]);
    log.append('orchestrator', 'delegation.set', { category: 'staging_write', setting: 'ask', by: 'you' });
    const asked = kube(`${STAGING} -n shop-staging rollout restart deployment/shop-integration-test`);
    const a = await answerOpen('denied');
    expect(a).toMatchObject({ category: 'staging_write', precedentable: true, tier: 2 });
    expect((await asked).ok).toBe(false);
  });
});

describe('a tier-2 request that is his', () => {
  it('goes to him as a card; "Let Elfoqsy decide this kind next time" stores a precedent for the category and ticket type', async () => {
    const comment = { action: 'comment', key: 'SHOP-2091', text: 'Fixed in feature/SHOP-2091, see shop-api/src/map.ts:40.' };
    const firstTime = jira(comment);
    const a = await answerOpen('approved', { precedent: true });
    expect(a).toMatchObject({ kind: 'action', category: 'notify_people', precedentable: true, requestId: expect.stringMatching(/^req-/) });
    expect((await firstTime).ok).toBe(true);
    expect(payloads('precedent.saved')).toEqual([
      { precedentId: expect.stringMatching(/^prec-/), category: 'notify_people', ticketType: 'Bug', approvalId: a.approvalId, requestKind: 'action', question: 'Comment on SHOP-2091: "Fixed in feature/SHOP-2091, see shop-api/src/map.ts:40."', answer: 'approved', kind: 'jira.comment', by: 'you' },
    ]);
    // The same kind on a Bug again: hers now, and told, since he once had to be asked.
    const again = await jira({ ...comment, text: 'Merged; see SHOP-2091.' });
    expect(again.ok).toBe(true);
    expect(payloads('decision.made').at(-1)).toMatchObject({ category: 'notify_people', basis: 'precedent', told: true, sources: [{ kind: 'precedent', ref: payloads('precedent.saved')[0]!.precedentId }] });
    // A precedent counts for its own kind only: a transition on a Bug is still his.
    expect(effectiveSetting(live.get(), 'notify_people', run.runId, 'jira.transition')).toEqual({ setting: 'ask' });
    expect(effectiveSetting(live.get(), 'notify_people', run.runId, 'jira.comment')).toMatchObject({ setting: 'decide_and_tell' });
    // He removes it: his again.
    log.append('orchestrator', 'precedent.removed', { precedentId: payloads('precedent.saved')[0]!.precedentId, by: 'you' });
    expect(effectiveSetting(live.get(), 'notify_people', run.runId)).toEqual({ setting: 'ask' });
  });

  it("stores no precedent from the tester's tick, nor for reading a secret", async () => {
    const comment = jira({ action: 'comment', key: 'SHOP-2091', text: 'See SHOP-2091.' });
    await answerOpen('approved', { precedent: true, test: true });
    await comment;
    backends.kubeAnswers.set('get secret', { ok: true, stdout: 'x', stderr: '' });
    const secret = kube(`${INTEGRATION} -n shop-integration get secret db -o yaml`);
    const a = await answerOpen('approved', { precedent: true });
    await secret;
    expect(a).toMatchObject({ category: 'read_secret' });
    expect(a.precedentable).toBeUndefined();
    expect(payloads('precedent.saved')).toEqual([]);
  });
});

const CARD: QuestionCard = {
  question: 'Does a bundle discount apply to the bundle items only?',
  why: ['The ticket names v2 only'],
  options: [
    { label: 'Yes', consequence: 'Only the bundle items are discounted' },
    { label: 'No', consequence: 'The whole cart is discounted' },
  ],
  recommendation: 'Yes',
  sources: [{ kind: 'ticket', ref: 'SHOP-2091' }],
};

/** Her responder session, once it has started. */
async function responderSession() {
  for (let i = 0; i < 100 && !sdk.sessions.length; i++) await tick(5);
  return sdk.sessions.at(-1)!;
}
const call = (session: { options: Options }, name: string, args: Record<string, unknown>) => runTool(session.options, name, args, 'responder');

describe("an agent's question", () => {
  beforeEach(() => {
    first.close();
    build({ responder: true });
  });

  it('is answered by her from a source she read, recorded with it, and the agent is told where it came from', async () => {
    const asked = first.question(run.runId, CARD);
    const her = await responderSession();
    expect(her.sent[0]).toContain('Agent 2 on SHOP-2091 asks: Does a bundle discount apply to the bundle items only?');
    expect(her.options).toMatchObject({ tools: [], permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true, persistSession: false, effort: 'medium' });
    expect(payloads('decision.considering')).toEqual([{ requestId: expect.any(String), runId: 'run-2', requestKind: 'question', summary: CARD.question }]);
    await call(her, 'lookup_jira', { key: 'SHOP-1201' });
    expect(await call(her, 'answer', { option: 'yes', sources: [{ kind: 'ticket', ref: 'SHOP-1201', label: 'QA suite Acme Shop-1201' }] })).toContain('Answered');
    her.emit(text('Answered.'), result());
    const outcome = await asked;
    expect(outcome.resolution).toEqual({ decision: 'answered', answer: 'Yes' });
    expect(outcome.decision).toMatchObject({ option: 'Yes', sources: [{ kind: 'ticket', ref: 'SHOP-1201' }] });
    expect(payloads('decision.made')).toEqual([
      expect.objectContaining({ requestKind: 'question', category: 'sourced_answer', answer: 'Yes', basis: 'sources', told: false, question: CARD.question, options: ['Yes', 'No'] }),
    ]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(live.get().considering).toEqual({});
  });

  it('refuses a source she did not read, so she cannot answer from her own theory; escalated, the card carries her suggestion', async () => {
    const asked = first.question(run.runId, CARD);
    const her = await responderSession();
    expect(await call(her, 'answer', { option: 'Yes', sources: [{ kind: 'code', ref: 'shop-api/src/pricing/bundles.ts:86' }] })).toContain(
      'Not answered: shop-api/src/pricing/bundles.ts:86: you did not read those lines in this session.',
    );
    await call(her, 'lookup_code', { repo: SHOP_API, path: 'src/pricing/bundles.ts', from: 80, lines: 20 });
    expect(await call(her, 'escalate', { option: 'Yes', why: 'bundles.ts discounts every cart line when split_bundles is false; nothing says it is intended.', sources: [{ kind: 'code', ref: 'acme/shop-api/src/pricing/bundles.ts:86' }] })).toContain('Sent to alex');
    her.emit(result());
    const a = await answerOpen('answered', { answer: 'No' });
    expect(a).toMatchObject({ kind: 'question', card: CARD, category: 'unsourced', precedentable: true, suggestion: { option: 'Yes', sources: [{ kind: 'code', ref: 'acme/shop-api/src/pricing/bundles.ts:86' }] } });
    expect((await asked).resolution).toEqual({ decision: 'answered', answer: 'No' });
    expect(payloads('decision.made')).toEqual([]);
  });

  it('can only escalate when he keeps such questions for himself', async () => {
    log.append('orchestrator', 'delegation.set', { category: 'sourced_answer', setting: 'ask', by: 'you' });
    const asked = first.question(run.runId, CARD);
    const her = await responderSession();
    expect((her.options.allowedTools ?? []).some((t) => t.endsWith('__answer'))).toBe(false);
    expect(her.sent[0]).toContain('This one is his to decide');
    her.emit(result());
    const a = await answerOpen('answered', { answer: 'Yes' });
    expect(a.noSuggestion).toBe('Elfoqsy ended without answering or recommending.');
    await asked;
  });

  it("turns his ticked answer into a precedent she may cite for the same kind of question on that ticket type, and his change of her answer is told to the agent", async () => {
    let asked = first.question(run.runId, CARD);
    (await responderSession()).emit(result());
    await answerOpen('answered', { answer: 'Yes', precedent: true });
    await asked;
    const [p] = payloads('precedent.saved');
    expect(p).toMatchObject({ category: 'unsourced', ticketType: 'Bug', requestKind: 'question', question: CARD.question, answer: 'Yes', by: 'you' });
    // Next time she may cite it.
    asked = first.question(run.runId, CARD);
    const her = await responderSession();
    expect(her.sent[0]).toContain(`${p!.precedentId}: "${CARD.question}" -> Yes`);
    await call(her, 'answer', { option: 'Yes', sources: [{ kind: 'precedent', ref: p!.precedentId }] });
    her.emit(result());
    const outcome = await asked;
    const made = payloads('decision.made').at(-1)!;
    expect(made).toMatchObject({ basis: 'precedent', answer: 'Yes' });
    expect(outcome.decision?.decisionId).toBe(made.decisionId);
    // A precedent of a Bug is no source for a Story.
    expect(citeProblem({ kind: 'precedent', ref: p!.precedentId }, { s: { ...live.get(), runs: { ...live.get().runs, [run.runId]: { ...live.get().runs[run.runId]!, ticket: 'SHOP-3600' } } }, runId: run.runId, reads: undefined as never, question: true })).toContain('for Bug tickets');
    // He changes her answer: recorded, and the agent told.
    expect(first.change(made.decisionId, 'No', 'you')).toEqual({ ok: true });
    expect(payloads('decision.changed').at(-1)).toEqual({ decisionId: made.decisionId, by: 'you', how: 'changed', to: 'No' });
    expect(told).toEqual([['run-2', `alex changed Elfoqsy's answer to your question "${CARD.question}": it is now "No", not "Yes". If that changes your work, begin a new step and say so.`, 'alex']]);
    expect(first.change(made.decisionId, 'No', 'you')).toMatchObject({ error: 'unchanged' });
    expect(first.change(made.decisionId, 'Yes', 'you')).toEqual({ ok: true });
  });

  it('counts only what she read: a ticket a search merely listed is no source', async () => {
    const asked = first.question(run.runId, CARD);
    const her = await responderSession();
    await call(her, 'lookup_jira', { jql: 'project = SHOP AND text ~ "bundle discount"' });
    expect(await call(her, 'answer', { option: 'Yes', sources: [{ kind: 'ticket', ref: 'SHOP-1201' }] })).toContain('SHOP-1201: you did not read that ticket in this session');
    await call(her, 'lookup_jira', { key: 'shop-1201' });
    expect(await call(her, 'answer', { option: 'Yes', sources: [{ kind: 'ticket', ref: 'SHOP-1201' }] })).toContain('Answered');
    her.emit(result());
    expect((await asked).resolution).toEqual({ decision: 'answered', answer: 'Yes' });
  });

  it('posts no card when the run ended while she looked into it, and what she was looking into goes with it', async () => {
    const asked = first.question(run.runId, CARD);
    const her = await responderSession();
    expect(Object.values(live.get().considering)).toEqual([expect.objectContaining({ runId: run.runId, requestKind: 'question' })]);
    log.append('orchestrator', 'run.state_changed', { runId: run.runId, state: 'stopped', reason: 'Stopped by alex.' });
    expect(live.get().considering).toEqual({});
    await call(her, 'escalate', { option: 'Yes', why: 'The ticket says so.', sources: [{ kind: 'ticket', ref: 'SHOP-2091' }] });
    her.emit(result());
    expect((await asked).resolution).toEqual({ decision: 'denied', answer: 'The run ended.' });
    expect(payloads('approval.requested')).toEqual([]);
  });

  it('goes to him with why she has no suggestion when she cannot look into it', async () => {
    first.close();
    build();
    const asked = first.question(run.runId, CARD);
    const a = await answerOpen('answered', { answer: 'Yes' });
    expect(a).toMatchObject({ card: CARD, noSuggestion: 'Elfoqsy cannot look into questions here.' });
    expect((await asked).resolution.answer).toBe('Yes');
  });
});

describe('the digest of what she decided while he was away', () => {
  let digests: Digests;
  beforeEach(() => {
    digests = new Digests({ log, state: () => live.get(), today: () => 'c-today' });
  });
  afterEach(() => digests.close());

  const his = (t: string, role: 'you' | 'test' = 'you') => log.append('orchestrator', 'elfoqsy.message', { messageId: `y-${log.headSeq()}`, role, text: t, conversationId: 'c1' });

  it('lists her decisions for him when he comes back after half an hour away, in the conversation he wrote in', async () => {
    his('Leave them overnight.');
    clock.advance(40 * 60_000);
    await kube(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    const decided = payloads('decision.made').map((d) => d.decisionId);
    clock.advance(8 * 3600_000);
    his('Morning.');
    expect(payloads('decisions.digested')).toEqual([{ digestId: expect.any(String), conversationId: 'c1', decisionIds: decided, awaySince: new Date(T0).toISOString() }]);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ role: 'elfoqsy', conversationId: 'c1', text: 'Nothing moved on while you were away; nothing is waiting for you.', blocks: [{ type: 'digest', ref: payloads('decisions.digested')[0]!.digestId }] });
    // Listed once.
    clock.advance(AWAY_MS + 60_000);
    his('Again.');
    expect(payloads('decisions.digested')).toHaveLength(1);
  });

  it('opens any time (v1.3.1): what she decided since his last digest, at once; coming back later does not list it again', async () => {
    digests.open('c1', 'you');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ role: 'elfoqsy', conversationId: 'c1', text: 'I have not decided anything for you yet.' });
    expect(payloads('elfoqsy.message').at(-1)!.blocks).toBeUndefined();
    his('Go on.');
    await kube(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    const decided = payloads('decision.made').map((d) => d.decisionId);
    clock.advance(5 * 60_000);
    digests.open('c1', 'you');
    expect(payloads('decisions.digested')).toEqual([{ digestId: expect.any(String), conversationId: 'c1', decisionIds: decided, awaySince: new Date(T0).toISOString(), asked: true }]);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Nothing moved on since then; nothing is waiting for you.', blocks: [{ type: 'digest', ref: payloads('decisions.digested')[0]!.digestId }] });
    expect(live.get().digests[payloads('decisions.digested')[0]!.digestId]).toMatchObject({ asked: true, awaySince: T0 });
    // Again: nothing new since that one.
    clock.advance(60_000);
    digests.open('c1', 'you');
    const at = new Date(T0 + 5 * 60_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: `I have decided nothing since your last digest, at ${at}.` });
    // Away and back: already listed, so no digest; opening it counted as his being here.
    clock.advance(AWAY_MS * 2);
    his('Back.');
    expect(payloads('decisions.digested')).toHaveLength(1);
  });

  it("marks a digest the tester opens as the tester's, so his own still lists those decisions", async () => {
    his('Leaving.');
    await kube(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    const decided = payloads('decision.made').map((d) => d.decisionId);
    clock.advance(60_000);
    digests.open(undefined, 'tester');
    expect(payloads('decisions.digested')).toEqual([expect.objectContaining({ conversationId: 'c-today', decisionIds: decided, asked: true, test: true })]);
    clock.advance(AWAY_MS + 60_000);
    his('Back.');
    expect(payloads('decisions.digested').at(-1)).toEqual({ digestId: expect.any(String), conversationId: 'c1', decisionIds: decided, awaySince: new Date(T0).toISOString() });
  });

  it('says nothing when he was not away, and the tester coming back does not count', async () => {
    his('Go on.');
    await kube(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    clock.advance(10 * 60_000);
    his('Still here.');
    clock.advance(AWAY_MS * 2);
    his('Testing.', 'test');
    expect(payloads('decisions.digested')).toEqual([]);
  });
});
