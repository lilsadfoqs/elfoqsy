// v1.4, milestone 19: creating tickets and Jira news. A ticket is created only by his Create (criterion 9): the Jira
// proxy has no create, creating is no delegation category and cannot be granted, Elfoqsy and the agents only draft, and
// the tester is refused. His Create adds the links and reads the new ticket back. When he comes back, what happened in
// Jira meanwhile is listed in her voice. The fake Jira over the fixtures stands in for Jira.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { DEFAULT_DELEGATION, DELEGATION_CATEGORIES, fieldIdsOf } from '@elfoqsy/state';
import { Approvals } from '../src/agents/approvals';
import { AWAY_MS, Digests, NEWS_MAX_MS } from '../src/decisions/digest';
import { EventLog } from '../src/eventLog';
import { TOOL_NAMES } from '../src/elfoqsy/tools';
import { Intake, IntakeError } from '../src/intake';
import { JiraError } from '../src/jira/client';
import { FakeJira } from '../src/jira/fake';
import { startTickets, type Tickets } from '../src/jira/tickets';
import { REPO_ROOT } from '../src/config';
import { LiveState } from '../src/elfoqsy/liveState';
import { language } from '../src/elfoqsy/voice';
import { createProxies } from '../src/permissions';
import { Grants } from '../src/permissions/grants';
import { jiraSchema } from '../src/permissions/jira';
import type { ProxyRun } from '../src/permissions/proxy';
import { ManualClock, tick } from './helpers/fakeSdk';
import { environments, fakeBackends } from './helpers/proxyFakes';

const FIXTURES = join(__dirname, 'fixtures', 'jira');
const SITE = 'https://acme.atlassian.net';
const ids = fieldIdsOf();
const QUINN = { accountId: 'acc-1', displayName: 'Quinn Bauer' };
const BUG = '14534';
const STORY = '14532';

let jira: FakeJira;
let log: EventLog;
let tickets: Tickets;
const events = <T extends EventType>(type: T) => log.readFrom(0, 100_000, [type]) as Array<Extract<AnyEnvelope, { type: T }>>;
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);

beforeEach(async () => {
  jira = FakeJira.fromFixtures(FIXTURES);
  log = new EventLog(':memory:');
  tickets = await startTickets({ log, reader: jira, writer: jira, site: SITE, fieldsFile: join(REPO_ROOT, 'config', 'jira-fields.json') });
});
afterEach(() => {
  language.current = 'en';
  tickets.stop();
  log.close();
});

describe('only he creates tickets (criterion 9)', () => {
  it('has no create in the Jira proxy: an agent or Elfoqsy asking for one is refused before anything is classified', async () => {
    expect(jiraSchema.safeParse({ action: 'create', project: 'SHOP', type: 'Bug', summary: 'x', description: 'y' }).success).toBe(false);
    const approvals = new Approvals(log);
    const grants = new Grants(log);
    const proxies = createProxies({ log, approvals, grants, environments, backends: fakeBackends(), repos: [], say: () => undefined });
    const run: ProxyRun = { runId: 'r1', ticket: 'SHOP-3538', agentNumber: 6, branch: 'feature/SHOP-3538', targets: [], kubeconfig: '/x' };
    const asked = await proxies.request(run, 'jira', { action: 'create', project: 'SHOP', type: 'Bug', summary: 'x', description: 'y' });
    expect(asked).toMatchObject({ ok: false, text: expect.stringContaining('does not fit the jira tool') });
    expect(payloads('action.classified')).toEqual([]);
    proxies.close();
    grants.close();
    approvals.close();
  });

  it('is no delegation category, so it can be neither delegated nor granted', () => {
    expect(Object.keys(DEFAULT_DELEGATION).some((c) => /creat/i.test(c))).toBe(false);
    expect(DELEGATION_CATEGORIES.some((c) => /creat/i.test(c.label))).toBe(false);
    // A grant is for a classified kind; no proxy action classifies as creating an issue.
    expect(jiraSchema.options.map((o) => o.shape.action.value)).not.toContain('create');
  });

  it('gives Elfoqsy no tool that creates: she drafts, and the draft creates nothing in Jira', async () => {
    expect(TOOL_NAMES.filter((t) => /creat/.test(t))).toEqual([]);
    const draftId = tickets.creates!.draft({ by: 'elfoqsy', conversationId: 'c1', draft: { project: 'SHOP', type: 'Bug', summary: 'Inventory sync: reconcile job misses holds released mid-commit', links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }] } });
    expect(payloads('ticket.drafted')).toEqual([{ draftId, by: 'elfoqsy', conversationId: 'c1', draft: expect.objectContaining({ summary: 'Inventory sync: reconcile job misses holds released mid-commit' }) }]);
    expect(jira.writes()).toEqual([]);
    tickets.creates!.discard(draftId, 'you');
    expect(payloads('ticket.draft_closed')).toEqual([{ draftId, how: 'discarded', by: 'you' }]);
  });

  it("refuses the tester's create", () => {
    const intake = new Intake(log, { createTicket: () => undefined });
    expect(() => intake.handle({ t: 'jira_create', createId: 'c', project: 'SHOP', typeId: '10004', fields: { summary: 'x' }, test: true })).toThrow(IntakeError);
    intake.close();
  });
});

describe('his Create', () => {
  it("reads Jira's create screen for a project and a type (captured from SHOP with reads only)", async () => {
    await tickets.creates!.meta('SHOP', STORY);
    const [meta] = payloads('ticket.createmeta');
    expect(meta!.types.map((t) => t.name)).toEqual(['Story', 'Task', 'Bug', 'Epic', 'Subtask', 'Test', 'Support', 'Spike']);
    // A story needs its Acceptance criteria on this site; a bug only its summary.
    expect(meta!.fields!.filter((f) => f.required).map((f) => f.name)).toEqual(['Acceptance criteria', 'Project', 'Summary']);
    await tickets.creates!.meta('SHOP', BUG);
    expect(payloads('ticket.createmeta')[1]!.fields!.filter((f) => f.required).map((f) => f.name)).toEqual(['Project', 'Summary']);
  });

  it('creates the ticket, adds its links, reads it back to confirm links and sprint, and closes its draft', async () => {
    const draftId = tickets.creates!.draft({ by: 'agent', runId: 'r6', draft: { project: 'SHOP', type: 'Bug', summary: 's' } });
    await tickets.creates!.create({
      createId: 'k1',
      project: 'SHOP',
      typeId: BUG,
      fields: { summary: 'Inventory sync: reconcile job misses holds released mid-commit', priority: { id: '3' }, labels: ['checkout-v2'], [ids.storyPoints]: 3, [ids.sprint]: 33774 },
      links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }],
      draftId,
    });
    const [created] = payloads('ticket.created');
    expect(created).toEqual({ createId: 'k1', key: 'SHOP-9001', draftId, checks: { links: true, sprint: true } });
    expect(jira.writes().map((w) => `${w.method} ${w.path}`)).toEqual(['POST /rest/api/3/issue', 'POST /rest/api/3/issueLink']);
    expect(jira.writes()[0]!.body).toMatchObject({ fields: { project: { key: 'SHOP' }, issuetype: { id: BUG }, summary: 'Inventory sync: reconcile job misses holds released mid-commit' } });
    expect(payloads('ticket.draft_closed')).toEqual([{ draftId, how: 'created', key: 'SHOP-9001', by: 'you' }]);
    expect(payloads('ticket.detail').at(-1)).toMatchObject({ key: 'SHOP-9001', full: true });
  });

  it('says why when Jira refuses it', async () => {
    await tickets.creates!.create({ createId: 'k2', project: 'SHOP', typeId: BUG, fields: {} });
    await tickets.creates!.create({ createId: 'k3', project: 'SHOP', typeId: STORY, fields: { summary: 'x' } });
    expect(payloads('ticket.create_failed')).toEqual([
      { createId: 'k2', error: 'HTTP 400: Summary is required.' },
      { createId: 'k3', error: 'HTTP 400: Acceptance criteria is required.' },
    ]);
    expect(payloads('ticket.created')).toEqual([]);
  });
});

describe('Jira news when he comes back', () => {
  it('lists what others did on his tickets and where they mentioned him, newest first, in her voice', async () => {
    const since = Date.now() - 60 * 60_000;
    const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('Z', '+0000');
    jira.change('SHOP-3538', QUINN, { priority: { name: 'Blocker' } }, [{ field: 'priority', fieldId: 'priority', fromString: 'Major', toString: 'Blocker' }], recent(50));
    jira.change('SHOP-2430', { accountId: 'acc-2', displayName: 'Morgan Diaz' }, { status: { name: 'IN PROGRESS' } }, [{ field: 'status', fieldId: 'status', fromString: 'OPEN', toString: 'IN PROGRESS' }], recent(30));
    // A comment on someone else's ticket that mentions him, and his own change, which is not news.
    const other = jira.issues.get('OPS-14739')!.issue;
    (other.fields.comment as { comments: unknown[] }).comments.push({ id: '1', author: QUINN, created: recent(10), body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-me', text: '@Alex Rivera' } }, { type: 'text', text: ' can you check?' }] }] } });
    other.fields.updated = recent(10);
    jira.change('SHOP-3464', jira.me, { labels: ['x'] }, [{ field: 'labels', fromString: '', toString: 'x' }], recent(5));
    await tickets.news.onBack(since, 'c1');
    const [news] = payloads('jira.news');
    expect(news!.items.map((i) => `${i.who} ${i.what} ${i.key}`)).toEqual(['Quinn Bauer mentioned you in OPS-14739', 'Morgan Diaz moved to IN PROGRESS SHOP-2430', 'Quinn Bauer changed priority to Blocker on SHOP-3538']);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Welcome back. Three things happened in Jira; one mentions you.', conversationId: 'c1', blocks: [{ type: 'jira_news', ref: news!.newsId }] });
  });

  it('says it in Vietnamese, with cậu, when his latest message was in Vietnamese', async () => {
    language.current = 'vi';
    const since = Date.now() - 60 * 60_000;
    const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('Z', '+0000');
    jira.change('SHOP-3538', QUINN, { priority: { name: 'Blocker' } }, [{ field: 'priority', fieldId: 'priority', fromString: 'Major', toString: 'Blocker' }], recent(50));
    jira.change('SHOP-2430', { accountId: 'acc-2', displayName: 'Morgan Diaz' }, { status: { name: 'IN PROGRESS' } }, [{ field: 'status', fieldId: 'status', fromString: 'OPEN', toString: 'IN PROGRESS' }], recent(30));
    const other = jira.issues.get('OPS-14739')!.issue;
    (other.fields.comment as { comments: unknown[] }).comments.push({ id: '1', author: QUINN, created: recent(10), body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-me', text: '@Alex Rivera' } }, { type: 'text', text: ' can you check?' }] }] } });
    other.fields.updated = recent(10);
    await tickets.news.onBack(since, 'c1');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Chào mừng cậu quay lại. Có ba việc xảy ra ở Jira; một việc nhắc tới cậu.', conversationId: 'c1' });
  });

  it('says nothing when nothing happened, and runs when the digest sees him come back', async () => {
    const clock = new ManualClock(Date.parse('2026-10-14T02:00:00Z'));
    const timed = new EventLog(':memory:', () => new Date(clock.now));
    const live = new LiveState(timed);
    const backs: Array<[number, string]> = [];
    const digests = new Digests({ log: timed, state: () => live.get(), today: () => 'c-today', onBack: (since, c) => backs.push([since, c]) });
    timed.append('orchestrator', 'elfoqsy.message', { messageId: 'y1', role: 'you', text: 'Leaving.', conversationId: 'c1' });
    clock.advance(AWAY_MS + 60_000);
    timed.append('orchestrator', 'elfoqsy.message', { messageId: 'y2', role: 'you', text: 'Back.', conversationId: 'c1' });
    expect(backs).toEqual([[Date.parse('2026-10-14T02:00:00Z'), 'c1']]);
    // Back after a long week: the news goes back 72 hours, not to when he left.
    clock.advance(7 * 24 * 3600_000);
    timed.append('orchestrator', 'elfoqsy.message', { messageId: 'y3', role: 'you', text: 'Back again.', conversationId: 'c1' });
    expect(backs.at(-1)).toEqual([clock.now - 72 * 3600_000, 'c1']);
    digests.close();
    live.close();
    timed.close();
    await tickets.news.onBack(Date.now() - 60_000, 'c1');
    expect(payloads('jira.news')).toEqual([]);
    await tick(1);
  });
});

describe('Jira news when he opens the digest himself (his answer 13)', () => {
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  it('goes back to his last digest or Jira news, at most 72 hours, and comes with his digests only', () => {
    // His answer: a Monday digest still includes Friday.
    expect(NEWS_MAX_MS).toBe(72 * 3600_000);
    const T = Date.parse('2026-10-14T02:00:00Z');
    const clock = new ManualClock(T);
    const timed = new EventLog(':memory:', () => new Date(clock.now));
    const live = new LiveState(timed);
    const asked: Array<[number, string]> = [];
    const digests = new Digests({ log: timed, state: () => live.get(), today: () => 'c-today', onAsked: (since, c) => asked.push([since, c]) });
    // Never a digest or news before: the last 72 hours.
    digests.open('c1', 'you');
    expect(asked).toEqual([[T - NEWS_MAX_MS, 'c1']]);
    // News shown at 03:00, then a digest of his at 04:00: from the later.
    clock.advance(3600_000);
    timed.append('jira', 'jira.news', { newsId: 'news-1', since: new Date(T).toISOString(), conversationId: 'c1', items: [] });
    clock.advance(3600_000);
    timed.append('orchestrator', 'decisions.digested', { digestId: 'dig-1', conversationId: 'c1', decisionIds: ['dec-1'], awaySince: new Date(T).toISOString(), asked: true });
    clock.advance(600_000);
    digests.open(undefined, 'you');
    expect(asked.at(-1)).toEqual([T + 2 * 3600_000, 'c-today']);
    // The tester's digest has no Jira news; a digest the tester opened does not move his.
    timed.append('orchestrator', 'decisions.digested', { digestId: 'dig-2', conversationId: 'c1', decisionIds: ['dec-2'], awaySince: new Date(T).toISOString(), asked: true, test: true });
    digests.open('c1', 'tester');
    expect(asked).toHaveLength(2);
    digests.close();
    live.close();
    timed.close();
  });

  it('says it in Vietnamese: nothing happened, one thing did, and Jira could not be read', async () => {
    language.current = 'vi';
    const since = Date.now() - 60 * 60_000;
    await tickets.news.onAsked(since, 'c1');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: `Không có gì xảy ra ở Jira từ ${hhmm(since)}: không có thay đổi nào ở ticket của cậu, và không ai nhắc tới cậu.` });
    const at = new Date(Date.now() - 20 * 60_000).toISOString().replace('Z', '+0000');
    jira.change('SHOP-2430', { accountId: 'acc-2', displayName: 'Morgan Diaz' }, { status: { name: 'IN PROGRESS' } }, [{ field: 'status', fieldId: 'status', fromString: 'OPEN', toString: 'IN PROGRESS' }], at);
    await tickets.news.onAsked(since, 'c1');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: `Có một việc xảy ra ở Jira từ ${hhmm(since)}.` });
    jira.failing = new JiraError('HTTP 503: Jira is down for maintenance.', 503);
    await tickets.news.onAsked(since, 'c1');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'Tôi không đọc được Jira lúc này nên tin từ Jira bị thiếu ở đây: HTTP 503: Jira is down for maintenance.' });
  });

  it("lists what happened since then, says so in one line when nothing did, and when Jira can't be read", async () => {
    const since = Date.now() - 60 * 60_000;
    await tickets.news.onAsked(since, 'c1');
    expect(payloads('jira.news')).toEqual([]);
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ role: 'elfoqsy', text: `Nothing happened in Jira since ${hhmm(since)}: no changes on your tickets, and no mentions of you.`, conversationId: 'c1' });
    const at = new Date(Date.now() - 20 * 60_000).toISOString().replace('Z', '+0000');
    jira.change('SHOP-2430', { accountId: 'acc-2', displayName: 'Morgan Diaz' }, { status: { name: 'IN PROGRESS' } }, [{ field: 'status', fieldId: 'status', fromString: 'OPEN', toString: 'IN PROGRESS' }], at);
    await tickets.news.onAsked(since, 'c1');
    const [news] = payloads('jira.news');
    expect(news).toMatchObject({ since: new Date(since).toISOString(), conversationId: 'c1', items: [{ kind: 'transition', who: 'Morgan Diaz', what: 'moved to IN PROGRESS', key: 'SHOP-2430' }] });
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: `One thing happened in Jira since ${hhmm(since)}.`, blocks: [{ type: 'jira_news', ref: news!.newsId }] });
    jira.failing = new JiraError('HTTP 503: Jira is down for maintenance.', 503);
    await tickets.news.onAsked(since, 'c1');
    expect(payloads('elfoqsy.message').at(-1)).toMatchObject({ text: 'I could not read Jira just now, so its news is missing here: HTTP 503: Jira is down for maintenance.' });
  });
});
