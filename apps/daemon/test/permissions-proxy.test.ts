// The tier policy end to end (brief-v1.2/docs/permissions.md): tiers 0 to 3, per-ticket grants, batching, record before
// change and Undo, and the AWS session watch. Every backend is a fake; nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { Approvals, BATCH_MS } from '../src/agents/approvals';
import { EventLog } from '../src/eventLog';
import { createProxies } from '../src/permissions';
import { AWS_CHECK_MS, AWS_RECHECK_MS, AwsSession, type ProbeResult } from '../src/permissions/awsSession';
import { GRANT_HOURS, Grants } from '../src/permissions/grants';
import { language } from '../src/elfoqsy/voice';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import type { RunRef } from '../src/permissions/types';
import { ManualClock, tick } from './helpers/fakeSdk';
import { ME, deploymentJson, environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const DEV = '--context dev-shop';
const DEV_ARN = 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop';
const T0 = Date.parse('2026-10-11T08:00:00Z');

let clock: ManualClock;
let log: EventLog;
let approvals: Approvals;
let grants: Grants;
let backends: FakeBackends;
let proxies: Proxies;
let aws: AwsSession | undefined;
let probe: Record<string, ProbeResult>;
let probed: string[];
let held: string[];

const run: ProxyRun = {
  runId: 'run-7',
  ticket: 'SHOP-3492',
  agentNumber: 7,
  branch: 'feature/SHOP-3492',
  targets: [{ repo: SHOP_API, base: 'master' }],
  kubeconfig: '/data/runs/run-7/kubeconfig',
  hold: async (reason, until) => {
    held.push(reason);
    return until;
  },
};

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const said = () => payloads('elfoqsy.message').filter((m) => !m.blocks).map((m) => m.text);
const kube = (args: string) => proxies.request(run, 'kube', { args: args.split(' ') });
const gh = (...args: string[]) => proxies.request(run, 'gh', { args });
const answerLast = (decision: 'approved' | 'denied', extra: { scope?: 'once' | 'ticket'; test?: true } = {}) =>
  log.append('orchestrator', 'approval.resolved', { approvalId: payloads('approval.requested').at(-1)!.approvalId, decision, ...extra });

function build(withAws = false): void {
  approvals = new Approvals(log, undefined, clock);
  grants = new Grants(log, { clock, now: () => clock.now });
  if (withAws) {
    aws = new AwsSession({
      log,
      profiles: environments.list.flatMap((e) => (e.awsProfile ? [{ environment: e.name, profile: e.awsProfile }] : [])),
      probe: async (profile) => {
        probed.push(profile);
        return probe[profile] ?? 'ok';
      },
      ask: (text) => log.append('orchestrator', 'elfoqsy.message', { messageId: `aws-${clock.now}`, role: 'elfoqsy', text }),
      clock,
    });
  }
  proxies = createProxies({
    log,
    approvals,
    grants,
    environments,
    backends,
    repos: [SHOP_API],
    ...(aws ? { aws } : {}),
    say: (_run, text) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text, refs: { runId: _run.runId } }),
    endedRun: async (runId) => (runId === run.runId ? { run, dispose: () => held.push('disposed') } : null),
    now: () => clock.now,
  });
  proxies.register(run);
}

beforeEach(() => {
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  log.append('orchestrator', 'run.created', { runId: run.runId, ticket: run.ticket, worktree: '/runs/x', branch: run.branch, agentNumber: 7 });
  backends = fakeBackends();
  backends.kubeAnswers.set('get deployment/shop-integration-test -o json', deploymentJson('shop-integration-test', 'it:2.21.3', { replicas: 2 }));
  held = [];
  probe = {};
  probed = [];
  aws = undefined;
  build();
});

afterEach(() => {
  aws?.stop();
  proxies.close();
  grants.close();
  approvals.close();
  log.close();
});

describe('tier 0: done at once and logged', () => {
  it('runs a read with the run’s own kubeconfig, in the environment’s namespace, and logs it with run and tier', async () => {
    backends.kubeAnswers.set('get pods', { ok: true, stdout: 'shop-api-0   1/1   Running', stderr: '' });
    const r = await kube(`${DEV} get pods`);
    expect(r).toMatchObject({ ok: true, text: 'shop-api-0   1/1   Running' });
    expect(backends.calls.kubectl).toEqual([{ args: ['--context', DEV_ARN, 'get', 'pods', '-n', 'shop-dev'], kubeconfig: '/data/runs/run-7/kubeconfig' }]);
    expect(payloads('action.classified')).toEqual([
      { actionId: r.actionId, runId: 'run-7', proxy: 'kube', kind: 'kube.get', tier: 0, environment: 'dev', summary: `kubectl ${DEV} get pods`, decision: 'run', reason: 'A read.' },
    ]);
    expect(payloads('action.finished')).toEqual([{ actionId: r.actionId, runId: 'run-7', ok: true, outputSummary: 'shop-api-0   1/1   Running', durationMs: 0 }]);
    expect(payloads('change.recorded')).toEqual([]);
    expect(said()).toEqual([]);
  });
});

describe('tier 1: done at once, recorded first, reported in one line, undoable', () => {
  it('changes an image on dev: the earlier image is recorded before, Elfoqsy says so, and Undo puts it back', async () => {
    const r = await kube(`${DEV} set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining('Done at once; Elfoqsy told alex.') });
    expect(payloads('approval.requested')).toEqual([]);
    const [record] = payloads('change.recorded');
    expect(record).toEqual({
      recordId: expect.any(String),
      actionId: r.actionId,
      runId: 'run-7',
      environment: 'dev',
      target: 'deployment/shop-integration-test in shop-dev on dev',
      before: 'container shop-integration-test: image it:2.21.3',
      undo: { proxy: 'kube', summary: 'Set shop-integration-test back to it:2.21.3', request: { args: ['--context', DEV_ARN, '-n', 'shop-dev', 'set', 'image', 'deployment/shop-integration-test', 'shop-integration-test=it:2.21.3'] } },
    });
    // Recorded before it ran: the reads come first (is a digest pinned? what is there now?), then the change.
    expect(backends.calls.kubectl.map((c) => c.args.slice(2, 5).join(' '))).toEqual(['-n shop-dev get', '-n shop-dev get', 'set image deployment/shop-integration-test']);
    expect(events().findIndex((e) => e.type === 'change.recorded')).toBeLessThan(events().findIndex((e) => e.type === 'action.finished'));
    expect(said()).toEqual(["Agent 7 changed deployment/shop-integration-test's image on dev to it:2.22.0; the earlier image is recorded."]);

    expect(await proxies.undo(record!.recordId, 'you')).toEqual({ ok: true });
    expect(backends.calls.kubectl.at(-1)!.args).toEqual(['--context', DEV_ARN, '-n', 'shop-dev', 'set', 'image', 'deployment/shop-integration-test', 'shop-integration-test=it:2.21.3']);
    expect(payloads('change.undone')).toEqual([{ recordId: record!.recordId, actionId: expect.any(String), by: 'you' }]);
    expect(said().at(-1)).toBe('Undone, as you asked: set shop-integration-test back to it:2.21.3.');
    expect(await proxies.undo(record!.recordId, 'you')).toMatchObject({ error: 'already_undone' });
  });

  it('records a scale and a restart with what puts them back', async () => {
    await kube(`${DEV} scale deployment/shop-integration-test --replicas=0`);
    await kube(`${DEV} rollout restart deployment/shop-integration-test`);
    expect(payloads('change.recorded').map((r) => [r.before, r.undo?.request])).toEqual([
      ['2 replicas', { args: ['--context', DEV_ARN, '-n', 'shop-dev', 'scale', 'deployment/shop-integration-test', '--replicas=2'] }],
      ['rollout revision 7', { args: ['--context', DEV_ARN, '-n', 'shop-dev', 'rollout', 'undo', 'deployment/shop-integration-test', '--to-revision=7'] }],
    ]);
    expect(said()).toEqual(['Agent 7 scaled deployment/shop-integration-test on dev to 0.', 'Agent 7 restarted deployment/shop-integration-test on dev.']);
  });

  it('changes nothing when the earlier state cannot be read first', async () => {
    backends.kubeAnswers.set('get deployment/shop-integration-test -o json', { ok: false, stdout: '', stderr: 'NotFound' });
    const r = await kube(`${DEV} set image deployment/shop-integration-test shop-integration-test=it:1`);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('Nothing was changed: the earlier state could not be recorded first') });
    expect(backends.calls.kubectl.some((c) => c.args.includes('set'))).toBe(false);
    expect(said()).toEqual([]);
  });

  it('asks instead when a pinned digest would be replaced, and the question says so', async () => {
    backends.kubeAnswers.set('get deployment/shop-integration-test -o json', deploymentJson('shop-integration-test', `it@sha256:${'a'.repeat(64)}`));
    void kube(`${DEV} set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    await tick(10);
    clock.advance(BATCH_MS);
    expect(payloads('approval.requested').at(-1)).toMatchObject({
      kind: 'action',
      tier: 2,
      question: expect.stringContaining(`A pinned digest will be replaced: shop-integration-test at it@sha256:${'a'.repeat(64)}.`),
    });
  });
});

describe('tier 2: asked first, once per batch, or covered by a grant for the ticket', () => {
  it('asks before marking a PR ready, and runs it only once approved', async () => {
    const pending = gh('pr', 'ready', '812', '--repo', SHOP_API);
    await tick(10);
    const asked = payloads('approval.requested').at(-1)!;
    expect(asked).toMatchObject({
      kind: 'action',
      tier: 2,
      gate: 'narrative', // he reads the ticket's narrative before it can be approved (N1)
      question: 'Agent 7 on SHOP-3492 wants to run the command below. Marking a PR ready for review notifies its reviewers: asked first.',
      action: `gh pr ready 812 --repo ${SHOP_API}`,
    });
    // Never for the whole ticket: each one waits for him to have read what we know.
    expect(asked.grantable).toBeUndefined();
    expect(asked.precedentable).toBeUndefined();
    expect(payloads('action.classified').at(-1)).toMatchObject({ decision: 'ask', approvalId: asked.approvalId, tier: 2 });
    expect(backends.calls.gh).toEqual([]);
    answerLast('approved');
    expect(await pending).toMatchObject({ ok: true, text: expect.stringContaining('(alex approved it.)') });
    expect(backends.calls.gh).toEqual([['pr', 'ready', '812', '--repo', SHOP_API]]);
    // Once: the next one asks again.
    void gh('pr', 'ready', '813', '--repo', SHOP_API);
    await tick(10);
    expect(payloads('approval.requested')).toHaveLength(2);
  });

  it('runs a ready-for-review that he approved with his own click without asking, logged as his (N1: from the narrative)', async () => {
    const answer = await proxies.approvedRequest(run, 'gh', { args: ['pr', 'ready', '812', '--repo', SHOP_API] }, 'Marked ready for review from the narrative, asked by alex.');
    expect(answer).toMatchObject({ ok: true });
    expect(payloads('approval.requested')).toEqual([]);
    expect(payloads('action.classified').at(-1)).toMatchObject({ kind: 'gh.pr.ready', tier: 2, decision: 'run', reason: 'Marked ready for review from the narrative, asked by alex.' });
    expect(backends.calls.gh).toEqual([['pr', 'ready', '812', '--repo', SHOP_API]]);
    // A request that is never done stays refused, whoever clicked.
    expect(await proxies.approvedRequest(run, 'gh', { args: ['pr', 'merge', '812', '--repo', SHOP_API] }, 'x')).toMatchObject({ ok: false });
    expect(backends.calls.gh).toHaveLength(1);
  });

  it('"Allow for this ticket": the same kind on the same ticket and environment runs without asking until 8 hours or the run’s end', async () => {
    const first = gh('pr', 'comment', '812', '--body', 'x', '--repo', SHOP_API);
    await tick(10);
    answerLast('approved', { scope: 'ticket' });
    await first;
    const [grant] = payloads('grant.created');
    expect(grant).toEqual({ grantId: expect.any(String), ticket: 'SHOP-3492', runId: 'run-7', kind: 'gh.pr.comment', expiresAt: new Date(T0 + GRANT_HOURS * 3_600_000).toISOString(), by: 'you', approvalId: payloads('approval.requested')[0]!.approvalId });

    clock.advance(3_600_000);
    expect(await gh('pr', 'comment', '813', '--body', 'y', '--repo', SHOP_API)).toMatchObject({ ok: true, text: expect.stringContaining("Allowed by alex's grant") });
    expect(payloads('approval.requested')).toHaveLength(1);
    expect(payloads('action.classified').at(-1)).toMatchObject({ decision: 'grant', grantId: grant!.grantId });

    // Another kind still asks: marking ready is never covered by a grant (N1).
    void gh('pr', 'ready', '813', '--repo', SHOP_API);
    await tick(10);
    expect(payloads('approval.requested')).toHaveLength(2);

    // After 8 hours it asks again, and the grant is ended.
    clock.advance(GRANT_HOURS * 3_600_000);
    void gh('pr', 'comment', '814', '--body', 'z', '--repo', SHOP_API);
    await tick(10);
    expect(payloads('approval.requested')).toHaveLength(3);
    expect(payloads('grant.ended')).toEqual([{ grantId: grant!.grantId, reason: 'expired' }]);
  });

  it('keeps a grant to its environment, and ends it with the run', async () => {
    const first = kube('--context staging-shop set image deployment/shop-integration-test shop-integration-test=it:2');
    await tick(10);
    answerLast('approved', { scope: 'ticket' });
    await first;
    expect(payloads('grant.created')[0]).toMatchObject({ kind: 'kube.set_image', environment: 'staging' });
    await kube('--context staging-shop set image deployment/shop-integration-test shop-integration-test=it:3');
    expect(payloads('approval.requested')).toHaveLength(1);
    void kube('--context integration-shop set image deployment/shop-integration-test shop-integration-test=it:3');
    await tick(10);
    expect(payloads('approval.requested')).toHaveLength(2); // integration is another environment
    proxies.unregister(run.runId);
    expect(payloads('grant.ended')).toEqual([{ grantId: payloads('grant.created')[0]!.grantId, reason: 'run_ended' }]);
  });

  it('gives no grant for the tester’s "Allow for this ticket"', async () => {
    const first = gh('pr', 'ready', '812', '--repo', SHOP_API);
    await tick(10);
    answerLast('approved', { scope: 'ticket', test: true });
    expect(await first).toMatchObject({ ok: true, text: expect.stringContaining('The tester (not alex) approved it.') });
    expect(payloads('grant.created')).toEqual([]);
  });

  it('runs nothing when declined, and says who declined', async () => {
    const pending = gh('pr', 'comment', '812', '--body', 'Ready.', '--repo', SHOP_API);
    await tick(10);
    answerLast('denied');
    expect(await pending).toEqual({ ok: false, text: `alex declined: gh pr comment 812 --body Ready. --repo ${SHOP_API}.`, actionId: expect.any(String) });
    expect(backends.calls.gh).toEqual([]);
    expect(payloads('action.finished').at(-1)).toMatchObject({ ok: false, outputSummary: expect.stringContaining('alex declined') });
  });

  it('says nobody answered, not that he declined, when the run ends while it waits (probe P1)', async () => {
    const pending = gh('pr', 'comment', '812', '--body', 'Ready.', '--repo', SHOP_API);
    await tick(10);
    approvals.cancelRun(run.runId, 'The run ended.');
    expect(await pending).toMatchObject({ ok: false, text: `Not run, and nobody answered: gh pr comment 812 --body Ready. --repo ${SHOP_API}. The run ended.` });
    expect(payloads('action.finished').at(-1)!.outputSummary).not.toContain('declined');
  });

  it('batches requests made within a few seconds into one approval listing them all', async () => {
    void gh('pr', 'ready', '812', '--repo', SHOP_API);
    void gh('pr', 'comment', '812', '--body', 'Ready.', '--repo', SHOP_API);
    void kube('--context staging-shop rollout restart deployment/shop-integration-test');
    await tick(20);
    expect(payloads('elfoqsy.message')).toEqual([]); // not yet: the window is open
    clock.advance(BATCH_MS);
    const asked = payloads('approval.requested');
    expect(new Set(asked.map((a) => a.batchId)).size).toBe(1);
    expect(payloads('elfoqsy.message')).toEqual([
      { messageId: expect.any(String), role: 'elfoqsy', text: 'Agent 7 needs your approval for 3 actions.', blocks: asked.map((a) => ({ type: 'approval', ref: a.approvalId })), refs: { tickets: ['SHOP-3492'], runId: 'run-7', approvalId: asked[0]!.approvalId } },
    ]);
    // A request after the window opens the next batch.
    void gh('pr', 'ready', '813', '--repo', SHOP_API);
    await tick(10);
    clock.advance(BATCH_MS);
    expect(payloads('approval.requested').at(-1)!.batchId).not.toBe(asked[0]!.batchId);
    expect(payloads('elfoqsy.message').at(-1)!.text).toBe('Agent 7 needs your approval.');
  });

  it('lets alex’s own Undo of a tier-2 change run without asking again; the tester’s Undo is asked', async () => {
    const first = kube('--context staging-shop set image deployment/shop-integration-test shop-integration-test=it:2');
    await tick(10);
    answerLast('approved');
    await first;
    const [record] = payloads('change.recorded');
    const asked = payloads('approval.requested').length;
    expect(await proxies.undo(record!.recordId, 'you')).toEqual({ ok: true });
    expect(payloads('approval.requested')).toHaveLength(asked);
    expect(payloads('action.classified').at(-1)).toMatchObject({ decision: 'run', tier: 2, reason: 'Undo of deployment/shop-integration-test in shop-staging on staging, asked by alex from the pane.' });

    const second = kube('--context staging-shop set image deployment/shop-integration-test shop-integration-test=it:4');
    await tick(10);
    answerLast('approved');
    await second;
    const tester = proxies.undo(payloads('change.recorded').at(-1)!.recordId, 'tester');
    await tick(10);
    expect(payloads('approval.requested').length).toBeGreaterThan(asked + 1);
    answerLast('denied');
    expect(await tester).toMatchObject({ error: 'refused' });
  });
});

describe('tier 3: refused however it is asked, and handed to alex', () => {
  it.each([
    [['pr', 'merge', '812', '--repo', SHOP_API], 'Merging is yours to do.'],
    [['api', '-X', 'PUT', 'repos/acme/shop-api/pulls/812/merge'], 'Merging is yours to do.'],
  ])('refuses gh %j and Elfoqsy tells him', async (args, reason) => {
    const r = await gh(...args);
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/^Refused: Merging is alex's to do\. It is alex's to do, and Elfoqsy has told him/) });
    expect(backends.calls.gh).toEqual([]);
    expect(said()).toEqual([`Agent 7 tried \`gh ${args.join(' ')}\`. I refused it: ${reason}`]);
    expect(payloads('action.classified')[0]).toMatchObject({ tier: 3, decision: 'refuse' });
  });

  it('refuses prod, kubectl apply and deleting pods, never reaching the cluster', async () => {
    for (const args of [`${DEV} apply -f x.yaml`, `${DEV} delete pod shop-api-0`, '--context arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod get pods']) {
      expect((await kube(args)).ok).toBe(false);
    }
    expect(backends.calls.kubectl).toEqual([]);
    expect(said()).toHaveLength(3);
  });

  it('refuses to deploy a product service, never reaching the cluster: that is alex\'s, and the agent hands over', async () => {
    const r = await kube(`${DEV} set image deployment/order-worker order-worker=ow:SHOP-3049`);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining("order-worker is a product service: deploying it is alex's.") });
    expect(r.text).toContain('Hand over with ask_user');
    expect(backends.calls.kubectl).toEqual([]);
    expect(payloads('action.classified')[0]).toMatchObject({ tier: 3, decision: 'refuse', environment: 'dev' });
  });

  it('refuses a request it cannot classify without troubling alex', async () => {
    expect(await kube('get pods')).toMatchObject({ ok: false, text: expect.stringContaining('add --context') });
    expect(await proxies.request(run, 'aws', { args: ['s3', 'ls'] })).toMatchObject({ ok: false, text: expect.stringContaining('add --profile') });
    expect(await proxies.request(run, 'kube', { args: 'not an array' })).toMatchObject({ ok: false, text: expect.stringContaining('does not fit the kube tool') });
    expect(said()).toEqual([]);
  });
});

describe('Jira and Confluence', () => {
  const jira = (input: Record<string, unknown>) => proxies.request(run, 'jira', input);

  it('links the run’s own PR in its ticket at once, and Undo removes the link', async () => {
    backends.ghAnswers.set('pr view 9 --repo', { ok: true, stdout: '{"headRefName":"feature/SHOP-3492"}', stderr: '' });
    const r = await jira({ action: 'link_pr', key: 'SHOP-3492', url: 'https://github.com/acme/shop-api/pull/9' });
    expect(r).toMatchObject({ ok: true });
    expect(said()).toEqual(['Agent 7 linked shop-api #9 in SHOP-3492.']);
    expect(payloads('change.recorded')[0]).toMatchObject({ before: 'No links.', undo: { request: { action: 'unlink_pr', key: 'SHOP-3492', url: 'https://github.com/acme/shop-api/pull/9' } } });
    expect(await proxies.undo(payloads('change.recorded')[0]!.recordId, 'you')).toEqual({ ok: true });
    expect(backends.issues.get('SHOP-3492')!.links).toEqual([]);
  });

  it('asks before linking a PR that is not the run’s own', async () => {
    backends.ghAnswers.set('pr view 10 --repo', { ok: true, stdout: '{"headRefName":"feature/OTHER-1"}', stderr: '' });
    void jira({ action: 'link_pr', key: 'SHOP-3492', url: 'https://github.com/acme/shop-api/pull/10' });
    await tick(10);
    expect(payloads('approval.requested')).toHaveLength(1);
  });

  it('fills empty bug fields on his own ticket under his delegation (v1.4), records them, and asks before writing over text or on someone else’s ticket', async () => {
    // Without Elfoqsy as first responder it is asked; with her it is decided by his delegation (decide and tell).
    const filled = jira({ action: 'fill', key: 'SHOP-3492', rootCause: 'auth.ts adds "Basic " to a value that has it.', solution: 'Strip an existing scheme.', ac: 'One Basic prefix.' });
    await tick(10);
    expect(payloads('action.classified').at(-1)).toMatchObject({ kind: 'jira.fill', tier: 2 });
    for (let i = 0; i < 50 && !payloads('approval.requested').length; i++) await tick(10);
    answerLast('approved');
    expect(await filled).toMatchObject({ ok: true });
    expect(payloads('change.recorded')[0]).toMatchObject({ before: 'Root cause: empty; Solution: empty; AC: empty', undo: { request: { action: 'fill', key: 'SHOP-3492', rootCause: '', solution: '', ac: '' } } });

    void jira({ action: 'fill', key: 'SHOP-3492', solution: 'Something else.' });
    await tick(10);
    expect(payloads('action.classified').at(-1)).toMatchObject({ kind: 'jira.fill_over', tier: 2 });
    backends.issues.set('SHOP-1', { assignee: 'someone-else', status: 'To do', fields: { rootCause: null, solution: null, ac: null }, links: [], description: '' });
    void jira({ action: 'fill', key: 'SHOP-1', ac: 'x' });
    await tick(10);
    expect(payloads('action.classified').at(-1)).toMatchObject({ kind: 'jira.fill_other', tier: 2 });
    expect(ME).toBe('acct-alex');
  });

  it('asks before comments, transitions and Description edits, has no create (only alex creates, v1.4); reads are free', async () => {
    expect(await jira({ action: 'get', key: 'SHOP-3492' })).toMatchObject({ ok: true, text: 'SHOP-3492  Bug  To do' });
    for (const input of [
      { action: 'comment', key: 'SHOP-3492', text: 'Reproduced on dev.' },
      { action: 'transition', key: 'SHOP-3492', to: 'In Review' },
      { action: 'edit_description', key: 'SHOP-3492', description: 'Short.' },
    ]) void jira(input);
    expect(await jira({ action: 'create', project: 'SHOP', type: 'Bug', summary: 'x', description: 'y' })).toMatchObject({ ok: false });
    await tick(20);
    expect(payloads('action.classified').filter((a) => a.tier === 2).map((a) => a.kind)).toEqual(['jira.comment', 'jira.transition', 'jira.edit_description']);
    expect(backends.calls.jira.filter(([op]) => ['comment', 'transition', 'create', 'setDescription'].includes(op))).toEqual([]);
  });

  it('reads Confluence freely, asks before editing a page, and records the version to go back to', async () => {
    expect(await proxies.request(run, 'confluence', { action: 'search', cql: 'title ~ "payments"' })).toMatchObject({ ok: true });
    const editing = proxies.request(run, 'confluence', { action: 'edit', pageId: '100', body: 'v4' });
    await tick(10);
    answerLast('approved');
    expect(await editing).toMatchObject({ ok: true });
    expect(payloads('change.recorded').at(-1)).toMatchObject({ before: 'version 3', undo: { request: { action: 'restore', pageId: '100', version: 3 } } });
  });
});

describe('logs: the application filter is the proxy’s', () => {
  const logs = (input: Record<string, unknown>) => proxies.request(run, 'logs', input);

  it('adds the non-prod application filter itself', async () => {
    expect(await logs({ query: "filter $m.severity == ERROR | limit 20", environment: 'dev' })).toMatchObject({ ok: true });
    await logs({ query: '' });
    expect(backends.calls.logs).toEqual([
      "source logs | filter $l.applicationname == 'shop-dev' | filter $m.severity == ERROR | limit 20",
      "source logs | filter $l.applicationname in ['shop-dev', 'shop-staging', 'shop-integration']",
    ]);
  });

  it('refuses a query that writes its own filter, and asks before prod logs', async () => {
    expect(await logs({ query: "source logs | filter $l.applicationname == 'shop-prod'" })).toMatchObject({ ok: false, text: expect.stringContaining('the proxy adds the filter') });
    void logs({ query: 'limit 5', application: 'shop-prod' });
    await tick(10);
    expect(payloads('action.classified').at(-1)).toMatchObject({ kind: 'logs.prod', tier: 2, decision: 'ask' });
    expect(backends.calls.logs).toEqual([]);
  });
});

describe('the AWS session: runs pause instead of failing', () => {
  beforeEach(() => {
    proxies.close();
    grants.close();
    approvals.close();
    build(true);
  });

  it('checks each profile hourly with sts, holds calls to an expired environment, asks once, and runs them once it works', async () => {
    await aws!.start();
    expect(probed.sort()).toEqual(['dev-shop', 'integration-shop', 'staging-shop']);
    expect(payloads('aws.session').map((p) => `${p.environment} ${p.state}`).sort()).toEqual(['dev ok', 'integration ok', 'staging ok']);
    // An hour later, dev's session has run out: nothing is said until a call needs it.
    probe['dev-shop'] = 'expired';
    probed = [];
    clock.advance(AWS_CHECK_MS);
    await tick(10);
    expect(probed).toHaveLength(3);
    expect(payloads('aws.session').at(-1)).toEqual({ state: 'expired', environment: 'dev', profile: 'dev-shop' });
    expect(said()).toEqual([]);

    let done = false;
    const call = kube(`${DEV} get pods`).then((r) => ((done = true), r));
    await tick(20);
    expect(done).toBe(false);
    expect(held).toEqual(['Waiting for alex to refresh the AWS session for dev.']);
    expect(backends.calls.kubectl).toEqual([]);
    expect(said()).toEqual([
      'Your AWS session for dev (profile dev-shop) has run out. Please paste a fresh one into ~/.aws/credentials; agents that need dev are waiting for it and go on by themselves once it works.',
    ]);
    // Staging's session still works, and minikube needs no AWS.
    expect(await kube('--context staging get pods')).toMatchObject({ ok: true });
    expect(await kube('--context minikube get pods')).toMatchObject({ ok: true });

    // Checked every minute while expired; asked once.
    clock.advance(AWS_RECHECK_MS);
    await tick(10);
    expect(said()).toHaveLength(1);
    probe['dev-shop'] = 'ok'; // he pasted a fresh one
    clock.advance(AWS_RECHECK_MS);
    await call;
    expect(done).toBe(true);
    expect(payloads('aws.session').at(-1)).toEqual({ state: 'ok', environment: 'dev', profile: 'dev-shop' });
  });

  it('a network failure says nothing about the session: nothing is held', async () => {
    probe['dev-shop'] = 'error';
    await aws!.start();
    expect(payloads('aws.session').filter((p) => p.environment === 'dev')).toEqual([]);
    expect(await kube(`${DEV} get pods`)).toMatchObject({ ok: true });
    expect(held).toEqual([]);
  });

  it('marks the session expired only from AWS’s own words, never from text the call carried that an error repeats', async () => {
    // A name kubectl does not find, written "ExpiredToken", is repeated in its error: that says nothing about the session.
    backends.kubeAnswers.set('get deployment ExpiredToken', { ok: false, stdout: '', stderr: 'Error from server (NotFound): deployments.apps "ExpiredToken" not found' });
    expect(await kube(`${DEV} get deployment ExpiredToken`)).toMatchObject({ ok: false, text: expect.stringContaining('not found') });
    // So is an id AWS repeats.
    backends.awsAnswers.set('describe-instances', { ok: false, stdout: '', stderr: 'An error occurred (InvalidInstanceID.Malformed): Invalid id: "ExpiredToken"' });
    expect(await proxies.request(run, 'aws', { args: ['ec2', 'describe-instances', '--instance-ids', 'ExpiredToken', '--profile', 'dev-shop'] })).toMatchObject({ ok: false });
    // Not even AWS's real words are believed from a call that carried such words: nothing is held, and the hourly check finds out.
    backends.awsAnswers.set('describe-images', { ok: false, stdout: '', stderr: 'An error occurred (ExpiredToken) when calling the DescribeImages operation: the security token included in the request is expired' });
    expect(await proxies.request(run, 'aws', { args: ['ecr', 'describe-images', '--repository-name', 'ExpiredToken', '--profile', 'dev-shop'] })).toMatchObject({ ok: false });
    expect(held).toEqual([]);
    expect(aws!.fresh('dev')).toBe(true);
    expect(payloads('aws.session')).toEqual([]);
    expect(said()).toEqual([]);
  });

  it('waits and runs the call again when AWS says the session has expired, instead of failing it', async () => {
    let answers = 0;
    backends.awsAnswers.set('sts get-caller-identity', { ok: false, stdout: '', stderr: 'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation' });
    const original = backends.aws;
    backends.aws = async (args) => (++answers > 1 ? { ok: true, stdout: '{"Account":"111111111111"}', stderr: '' } : original(args));
    aws!.stop();
    proxies.close();
    grants.close();
    approvals.close();
    build(true); // the proxies take the backend as it is now
    await aws!.start();
    const call = proxies.request(run, 'aws', { args: ['sts', 'get-caller-identity', '--profile', 'dev-shop'] });
    await tick(20);
    expect(payloads('aws.session').at(-1)).toMatchObject({ state: 'expired', environment: 'dev' });
    expect(said().at(-1)).toContain('Your AWS session for dev (profile dev-shop) has run out.');
    clock.advance(AWS_RECHECK_MS); // the minute's sts check says it works again
    expect(await call).toMatchObject({ ok: true, text: '{"Account":"111111111111"}' });
    expect(answers).toBe(2);
  });
});

describe('her one-line notices in Vietnamese, when his latest message was', () => {
  afterEach(() => {
    language.current = 'en';
  });

  it('says a change she let run and its undo, with tôi and cậu: the action quoted, never half translated', async () => {
    language.current = 'vi';
    await kube(`${DEV} set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
    expect(said()).toEqual(['Agent 7 đã đổi image của deployment/shop-integration-test trên dev thành it:2.22.0; image cũ đã được ghi lại.']);
    await proxies.undo(payloads('change.recorded')[0]!.recordId, 'you');
    expect(said().at(-1)).toBe('Đã hoàn tác theo yêu cầu của cậu: “set shop-integration-test back to it:2.21.3”.');
    await kube(`${DEV} scale deployment/shop-integration-test --replicas=0`);
    await kube(`${DEV} rollout restart deployment/shop-integration-test`);
    expect(said().slice(-2)).toEqual(['Agent 7 đã đặt số replica của deployment/shop-integration-test trên dev thành 0.', 'Agent 7 đã restart deployment/shop-integration-test trên dev.']);
  });

  it('says what she refused, with the rule’s own reason quoted as it reads to him', async () => {
    language.current = 'vi';
    await proxies.request(run, 'gh', { args: ['pr', 'merge', '812', '--repo', SHOP_API] });
    expect(said()).toEqual([`Agent 7 đã thử \`gh pr merge 812 --repo ${SHOP_API}\`. Tôi đã từ chối, lý do (của quy tắc, bằng tiếng Anh): “Merging is yours to do.”`]);
    expect(said()[0]).not.toMatch(/alex/);
  });

  it('says the same lines in English once he writes English again', async () => {
    language.current = 'vi';
    language.current = 'en';
    await kube(`${DEV} rollout restart deployment/shop-integration-test`);
    expect(said()).toEqual(['Agent 7 restarted deployment/shop-integration-test on dev.']);
  });
});
