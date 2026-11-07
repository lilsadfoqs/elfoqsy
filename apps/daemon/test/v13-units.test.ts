// v1.3, the pieces on their own: the redactor's check before a web request leaves (item 12), the question card's rules (item 3), logs for Elfoqsy and investigators (item 10), the hourly weekly
// review (item 14), the frame handler for settings and decisions (item 7), and a run's own decisions in its hand-back.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { questionCard } from '../src/agents/questionCard';
import { decisionsMissing } from '../src/agents/externalWrites';
import { LiveState } from '../src/elfoqsy/liveState';
import { Lookups } from '../src/elfoqsy/lookups';
import { decisionsMade, noticesFor } from '../src/elfoqsy/notifier';
import { WeeklyReview } from '../src/elfoqsy/review';
import { EventLog } from '../src/eventLog';
import { Intake, IntakeError } from '../src/intake';
import { sameOption } from '@elfoqsy/state';
import { Approvals } from '../src/agents/approvals';
import { checkOutbound, checkOutboundResolved, looksEncoded, type OutboundContext } from '../src/redact';
import { ManualClock } from './helpers/fakeSdk';
import { environments } from './helpers/proxyFakes';

const ctx: OutboundContext = {
  internalHosts: ['acme.atlassian.net', 'api.us1.coralogix.com', 'corp.example.com'],
  repos: ['acme/shop-worker', 'acme/shop-api'],
  localRoots: ['/home/alex', '/code'],
  inClones: (p) => ['src/pricing/v2/modules/bundle_rules_v2.ts', 'src/map.ts'].includes(p),
};

describe('what may leave through the web (the redactor, item 12)', () => {
  it.each([
    [{ url: 'https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html' }],
    [{ url: 'https://stackoverflow.com/questions/12345/how-to-x?answertab=votes#tab-top' }],
    [{ url: 'https://github.com/nodejs/node/blob/main/lib/fs.js' }],
    [{ url: 'https://www.npmjs.com/package/protobufjs?activeTab=versions' }],
    [{ query: 'kubectl rollout restart pending pods no node matches' }],
    [{ query: 'TypeError cannot read properties of undefined reading map' }],
    [{ query: 'jest how to mock a module default export' }],
    [{ url: 'https://github.com/nodejs/node/commit/1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' }],
    [{ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled' }],
    [{ url: 'https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#affinity-and-anti-affinity' }],
    [{ url: 'https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall?view=net-8.0' }],
    [{ url: 'https://example.com/a/123e4567-e89b-12d3-a456-426614174000' }],
    [{ url: 'https://my-company-artifacts-prod-us-east-1.s3.amazonaws.com/index.html' }],
  ])('lets ordinary documentation and questions through: %j', (target) => {
    expect(checkOutbound(target, ctx)).toEqual({ ok: true });
  });

  it.each([
    ['secret', { url: 'https://paste.example/x?k=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
    ['secret', { url: 'https://paste.example/x?auth=Bearer%20eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' }],
    ['secret', { url: 'https://deploy:hunter22@mirror.example/pkg' }],
    ['secret', { query: 'apikey 4f3a9c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 not working' }],
    ['internal_host', { url: 'https://acme.atlassian.net/wiki/spaces/SHOP/pages/7340041' }],
    ['internal_host', { url: 'http://10.12.0.5:8080/metrics' }],
    ['internal_host', { url: 'http://shop-api.shop-dev.svc.cluster.local/health' }],
    ['internal_host', { url: 'http://jenkins/job/x' }],
    ['internal_host', { url: 'https://ABC123.gr7.us-west-2.eks.amazonaws.com/api/v1/namespaces' }],
    ['internal_host', { query: 'curl http://192.168.1.20/admin returns 403' }],
    ['internal_host', { query: 'wiki.corp.example.com release checklist' }],
    ['repo_path', { query: 'shop-api split_bundles false bundle discount whole cart' }],
    ['repo_path', { url: 'https://github.com/acme/shop-api/blob/master/src/map.ts' }],
    ['repo_path', { url: 'https://example.com/search?q=src/pricing/v2/modules/bundle_rules_v2.ts' }],
    ['repo_path', { url: 'https://example.com/?p=/home/alex/.aws/credentials' }],
    ['repo_path', { query: 'why is /code/shop-shared slow' }],
    ['code', { query: 'if (!splitBundles) return cart.lines;' }],
    ['code', { url: 'https://example.com/?q=const x = await fetch(url); return x.json()' }],
    ['encoded_data', { url: `https://collector.example/c?d=${Buffer.from('the whole cart is discounted when split_bundles is false').toString('base64')}` }],
    ['encoded_data', { url: `https://collector.example/${createHash('sha256').update('the run folder').digest('hex')}` }],
    ['encoded_data', { query: `lookup ${Buffer.from('SHOP-2091 bundles.ts line 86 cart.lines').toString('base64url')}` }],
    ['not_web', { url: 'file:///etc/passwd' }],
    // An address as the host, however it is written, and names that point wherever their label says.
    ['internal_host', { url: 'http://[::ffff:127.0.0.1]:8080/' }],
    ['internal_host', { url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data' }],
    ['internal_host', { url: 'http://2130706433/' }],
    ['internal_host', { url: 'http://0x7f000001/' }],
    ['internal_host', { url: 'https://8.8.8.8/x' }],
    ['internal_host', { url: 'http://127.0.0.1.nip.io/admin' }],
    ['internal_host', { url: 'http://10-0-0-5.sslip.io/' }],
    // His repository, data or a key in the host's own labels: a lookup of the name alone sends them.
    ['repo_path', { url: 'https://shop-worker.collector.example/' }],
    ['encoded_data', { url: 'https://onxw2zlunbuw4zzaozuwk5dimvzca43poj2ca33gebxwk3dbmruxg3tb.collector.example/' }],
    // A key too short to be encoded data, and data cut into short pieces.
    ['secret', { url: 'https://paste.example/x?q=wJalrXUtnFEMI2K7MDENGbPxRfiCYEXAMPLEKEY12' }],
    ['encoded_data', { url: `https://collector.example/${Buffer.from('the whole cart is discounted when split_bundles is false, and this is a long sentence').toString('base64').match(/.{1,30}/g)!.join('/')}` }],
  ])('refuses what carries %s: %j', (rule, target) => {
    const verdict = checkOutbound(target, ctx);
    expect(verdict).toMatchObject({ ok: false, rule });
    // The refusal names the rule, never the text that matched.
    if (!verdict.ok) for (const piece of JSON.stringify(target).split(/[\s"/?=&:{},]+/).filter((p) => p.length > 10)) expect(verdict.reason).not.toContain(piece);
  });

  it('looks the host up before a fetch leaves: a public name for a private address is refused', async () => {
    const resolving = (addresses: Record<string, string[]>): OutboundContext => ({ ...ctx, resolve: async (host) => addresses[host] ?? [] });
    const names = resolving({ 'rebind.example': ['10.0.0.5'], 'mapped.example': ['::ffff:192.168.1.20'], 'docs.example': ['93.184.215.14'] });
    expect(await checkOutboundResolved({ url: 'https://rebind.example/x' }, names)).toMatchObject({ ok: false, rule: 'internal_host' });
    expect(await checkOutboundResolved({ url: 'https://mapped.example/x' }, names)).toMatchObject({ ok: false, rule: 'internal_host' });
    expect(await checkOutboundResolved({ url: 'https://docs.example/x' }, names)).toEqual({ ok: true });
    // A name that does not resolve fails the fetch anyway; a refusal before the lookup stands.
    expect(await checkOutboundResolved({ url: 'https://nowhere.example/x' }, names)).toEqual({ ok: true });
    expect(await checkOutboundResolved({ url: 'http://10.0.0.5/x' }, names)).toMatchObject({ ok: false, rule: 'internal_host' });
  });

  it('tells encoded data from ids and words', () => {
    expect(looksEncoded('0123456789abcdef0123456789abcdef01234567')).toBe(false); // a commit SHA is short of 48
    expect(looksEncoded('a'.repeat(60))).toBe(false); // long but not dense
    expect(looksEncoded(Buffer.from('x'.repeat(10) + 'some data that leaves the house').toString('base64'))).toBe(true);
  });
});

describe('the question card (item 3)', () => {
  const good = {
    question: 'Change v1 too, or leave it?',
    why: ['v1 is a visible contract'],
    options: [
      { label: 'Leave v1', consequence: 'Fix ships now' },
      { label: 'Change v1 too', consequence: 'Wider review' },
    ],
    recommendation: 'leave v1',
    sources: [{ kind: 'ticket', ref: 'SHOP-2091' }],
  };

  it('takes one line, short reasons, two to four options with consequences, and a recommendation among them', () => {
    expect(questionCard(good)).toEqual({ card: { ...good, recommendation: 'Leave v1' } });
  });

  it('refuses a free-form block, with every rule it broke', () => {
    const made = questionCard({ question: `I looked at the code.\nShould I change v1? ${'x'.repeat(220)}`, why: ['One. Two. Three.', 'a', 'b', 'c'], options: [{ label: 'Yes' }], recommendation: 'Maybe', sources: [{ kind: 'web', ref: '' }] });
    expect(made).toEqual({
      problems: [
        'question: one line, no line breaks; put the reasons in why and the choices in options.',
        'why: at most 3 points.',
        'why 1: one short point, at most 140 characters and one sentence.',
        'options: 2 to 4, each a label and its consequence.',
        'option 1: its consequence in at most 140 characters.',
        'recommendation: one of the option labels, as written.',
        'source 1: a kind (code, ticket, pr, log, doc or url) and a ref.',
      ],
    });
  });
});

describe('"Decisions I made" in the PR description (item 5)', () => {
  const pr = (body: string) => ({ args: ['pr', 'create', '--repo', 'acme/shop-api', '--title', 't', '--body', body] });
  it('asks for the section and every decision when the run made some, and nothing otherwise', () => {
    expect(decisionsMissing('gh', pr('x'), ['/r'], [])).toBeNull();
    expect(decisionsMissing('gh', pr('x'), ['/r'], ['[contract] 422 not 400'])).toContain('under a "Decisions I made" heading');
    expect(decisionsMissing('gh', pr('Body.\n\n## Decisions I made\n- one'), ['/r'], ['a', 'b'])).toContain('has 1 point; it lists all 2');
    expect(decisionsMissing('gh', pr('Body.\n\n**Decisions I made**\n1. a\n2. b'), ['/r'], ['a', 'b'])).toBeNull();
    expect(decisionsMissing('gh', { args: ['pr', 'edit', '9', '--add-label', 'x'] }, ['/r'], ['a'])).toBeNull();
    expect(decisionsMissing('jira', { action: 'comment' }, ['/r'], ['a'])).toBeNull();
    // Points under the next heading are not its own.
    expect(decisionsMissing('gh', pr('## Decisions I made\n- a\n\n## Testing\n- unit\n- e2e'), ['/r'], ['a', 'b'])).toContain('has 1 point; it lists all 2');
    expect(decisionsMissing('gh', pr('**Decisions I made**\n- a\n**Risks**\n- none\n- low'), ['/r'], ['a', 'b'])).toContain('has 1 point; it lists all 2');
  });
});

describe("changing one of Elfoqsy's answers (item 6)", () => {
  it('compares a whole option, with its note, never a shorter option that starts the same', () => {
    expect(sameOption('Leave v1', 'Leave v1')).toBe(true);
    expect(sameOption('leave v1: the fix ships now', 'Leave v1')).toBe(true);
    expect(sameOption('Leave v1 too', 'Leave v1')).toBe(false);
    expect(sameOption('Leave v1', 'Leave v1 too')).toBe(false);
  });
});

describe('the 72-hour withdrawal (item 13)', () => {
  it("withdraws the question that waited, and leaves the run's later ones open", async () => {
    const log = new EventLog(':memory:');
    const approvals = new Approvals(log);
    const first = approvals.request({ runId: 'run-1', ticket: 'SHOP-1', kind: 'question', question: 'Old?' });
    const later = approvals.request({ runId: 'run-1', ticket: 'SHOP-1', kind: 'check', question: 'Is the check green?' });
    expect(approvals.withdraw(first)).toBe(true);
    expect(await first).toEqual({ decision: 'denied', answer: 'Withdrawn after 72 hours without an answer.', withdrawn: true });
    const resolved = log.readFrom(0, 100).filter((e) => e.type === 'approval.resolved');
    expect(resolved).toHaveLength(1);
    expect(approvals.withdraw(first)).toBe(false);
    expect(approvals.withdraw(Promise.resolve())).toBe(false);
    void later;
    approvals.close();
    log.close();
  });
});

describe('logs for Elfoqsy and investigators (item 10)', () => {
  it('reads the non-prod logs with the application filter the workspace writes, and refuses prod', async () => {
    const asked: string[] = [];
    const l = new Lookups({ site: '', logs: { envs: environments, query: async (dataprime) => (asked.push(dataprime), '2 rows'), now: () => Date.parse('2026-10-13T08:00:00Z') } });
    expect(await l.logs({ query: 'filter $m.severity == ERROR | limit 5', environment: 'dev' })).toEqual({ environment: 'dev', query: 'filter $m.severity == ERROR | limit 5', logs: '2 rows' });
    expect(asked).toEqual(["source logs | filter $l.applicationname == 'shop-dev' | filter $m.severity == ERROR | limit 5"]);
    expect(await l.logs({ query: 'limit 5', environment: 'prod' })).toEqual({ error: 'prod_refused', message: "Prod logs are not read here. An agent's logs tool asks alex for them." });
    expect(await l.logs({ query: 'source logs | limit 5', environment: 'dev' })).toMatchObject({ error: 'refused' });
    expect(await new Lookups({ site: '', logs: { envs: environments } }).logs({ query: 'limit 5', environment: 'dev' })).toMatchObject({ error: 'refused', message: expect.stringContaining('CORALOGIX_API_KEY') });
  });
});

describe('the weekly review while the daemon runs (item 14)', () => {
  it('checks every hour, so Monday 09:00 does not wait for a restart', () => {
    const clock = new ManualClock(new Date(2026, 9, 12, 0, 30).getTime()); // Monday 00:30, local
    const log = new EventLog(':memory:', () => new Date(clock.now));
    const live = new LiveState(log);
    const asked: string[] = [];
    const review = new WeeklyReview({ log, state: () => live.get(), ask: (_c, t) => asked.push(t), now: () => clock.now });
    expect(review.runIfDue()).toBe('2026-10-05');
    const stop = review.watch(clock);
    for (let h = 0; h < 8; h++) clock.advance(3600_000); // 08:30
    expect(log.readFrom(0, 1000, ['review.weekly']).length + asked.length).toBe(asked.length);
    const before = asked.length;
    clock.advance(3600_000); // 09:30: the review for 12 October is due
    expect(asked.length).toBe(before + 1);
    clock.advance(3600_000);
    expect(asked.length).toBe(before + 1); // once
    stop();
    live.close();
    log.close();
  });
});

describe('the frame handler for settings, precedents and decisions (item 7)', () => {
  let log: EventLog;
  const payloads = <T extends EventType>(type: T) => log.readFrom(0, 1000, [type]).map((e: AnyEnvelope) => e.payload as PayloadOf<T>);
  beforeEach(() => {
    log = new EventLog(':memory:');
  });
  afterEach(() => log.close());

  it("takes his delegation, precedent and agents-at-once changes, and never the tester's", () => {
    const intake = new Intake(log);
    intake.handle({ t: 'delegation', category: 'staging_write', setting: 'decide_and_tell' });
    intake.handle({ t: 'setting', key: 'maxAgents', value: 4 });
    expect(() => intake.handle({ t: 'delegation', category: 'read_secret', setting: 'decide', test: true })).toThrow(IntakeError);
    expect(() => intake.handle({ t: 'remove_precedent', precedentId: 'nope' })).toThrow('There is no such precedent.');
    log.append('orchestrator', 'precedent.saved', { precedentId: 'p1', category: 'notify_people', ticketType: 'Bug', approvalId: 'a1', requestKind: 'action', question: 'q', answer: 'approved', by: 'you' });
    intake.handle({ t: 'remove_precedent', precedentId: 'p1' });
    expect(payloads('delegation.set')).toEqual([{ category: 'staging_write', setting: 'decide_and_tell', by: 'you' }]);
    expect(payloads('workspace.setting')).toEqual([{ key: 'maxAgents', value: 4, by: 'you' }]);
    expect(payloads('precedent.removed')).toEqual([{ precedentId: 'p1', by: 'you' }]);
    intake.close();
  });

  it('passes his precedent tick with his answer, where it is offered, and a change of her answer to the orchestrator', () => {
    const changes: unknown[] = [];
    const intake = new Intake(log, { changeDecision: (id, to, by) => (changes.push([id, to, by]), { ok: true }) });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'question', question: 'q', precedentable: true });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a2', runId: 'r1', kind: 'action', question: 'q', tier: 2 });
    intake.handle({ t: 'answer', approvalId: 'a1', decision: 'answered', answer: 'Leave v1', precedent: true });
    intake.handle({ t: 'answer', approvalId: 'a2', decision: 'approved', precedent: true });
    expect(payloads('approval.resolved')).toEqual([
      { approvalId: 'a1', decision: 'answered', answer: 'Leave v1', precedent: true },
      { approvalId: 'a2', decision: 'approved' },
    ]);
    intake.handle({ t: 'change_decision', decisionId: 'd1', to: 'No' });
    expect(changes).toEqual([['d1', 'No', 'you']]);
    intake.close();
  });

  it("opens the digest where he asks, or in Today's, for him or marked as the tester's (v1.3.1)", () => {
    const opened: unknown[] = [];
    expect(() => new Intake(log).handle({ t: 'digest' })).toThrow("Elfoqsy's decisions are not kept here.");
    const intake = new Intake(log, { openDigest: (conversationId, by) => opened.push([conversationId, by]) });
    log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'SHOP-2091' });
    intake.handle({ t: 'digest', conversationId: 'c1' });
    intake.handle({ t: 'digest', test: true });
    expect(() => intake.handle({ t: 'digest', conversationId: 'nope' })).toThrow('Unknown conversation.');
    expect(opened).toEqual([
      ['c1', 'you'],
      [undefined, 'tester'],
    ]);
    intake.close();
  });
});

describe("a run's own decisions in its hand-back (item 5)", () => {
  it('reach Elfoqsy with the end of the run, flagged ones first', () => {
    const log = new EventLog(':memory:');
    const live = new LiveState(log);
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-2091', worktree: '/w', branch: 'b', agentNumber: 2 });
    log.append('agent', 'run.assumption', { runId: 'r1', assumptionId: 'a1', text: 'Kept the retry count at 3.', evidence: [], by: 'agent' });
    log.append('agent', 'run.assumption', { runId: 'r1', assumptionId: 'a2', text: 'v1 stays as it is.', evidence: [], flag: 'contract', by: 'agent' });
    const prev = live.get();
    const e = log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'succeeded', reason: 'All 2 checks have passing evidence.' });
    expect(decisionsMade(live.get().runs.r1!)).toBe('\nDecisions it made (list them under "Decisions it made", as given; flagged ones are his at review):\n- [contract] v1 stays as it is.\n- Kept the retry count at 3.');
    expect(noticesFor(prev, e, live.get())[0]!.text).toContain('- [contract] v1 stays as it is.');
    live.close();
    log.close();
  });
});
