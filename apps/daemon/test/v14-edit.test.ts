// v1.4, milestone 18: editing tickets. His edits go straight to Jira (the fake one here) and are read back; a save over
// someone else's newer value is refused with theirs (criterion 7); only the transitions Jira offers, with the fields their
// screens require (criterion 5); his comments; links in Jira's own direction; search and his pickers' options; the tester
// never writes. Elfoqsy's edits go through the Jira proxy and his delegation: an empty field of his ticket is filled and
// told, a comment or a transition is asked (criterion 8), and her edit can be undone.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { applyDetail, fieldIdsOf, markdownToAdf, valueText, type TicketDetailView } from '@elfoqsy/state';
import { Approvals } from '../src/agents/approvals';
import { FirstResponder, ELFOQSY_RUN } from '../src/decisions/firstResponder';
import { EventLog } from '../src/eventLog';
import { Intake, IntakeError } from '../src/intake';
import { AtlassianJira } from '../src/jira/atlassian';
import { FakeJira } from '../src/jira/fake';
import { startTickets, type Tickets } from '../src/jira/tickets';
import { REPO_ROOT } from '../src/config';
import { LiveState } from '../src/elfoqsy/liveState';
import { createProxies } from '../src/permissions';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import { Grants } from '../src/permissions/grants';
import { environments, fakeBackends } from './helpers/proxyFakes';
import { tick } from './helpers/fakeSdk';

const FIXTURES = join(__dirname, 'fixtures', 'jira');
const SITE = 'https://acme.atlassian.net';
const ids = fieldIdsOf();
const QUINN = { accountId: 'acc-1', displayName: 'Quinn Bauer' };
const doc = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

let jira: FakeJira;
let log: EventLog;
let tickets: Tickets;
const events = <T extends EventType>(type: T) => log.readFrom(0, 100_000, [type]) as Array<Extract<AnyEnvelope, { type: T }>>;
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const folded = (key: string): TicketDetailView | undefined =>
  events('ticket.detail')
    .filter((e) => e.payload.key === key)
    .reduce<TicketDetailView | undefined>((v, e) => applyDetail(v, e.payload, Date.parse(e.ts)), undefined);
const edit = (editId: string, key: string, change: PayloadOf<'jira.edited'> extends never ? never : Parameters<NonNullable<Tickets['edits']>['edit']>[2]) => tickets.edits!.edit(editId, key, change);

beforeEach(async () => {
  jira = FakeJira.fromFixtures(FIXTURES);
  log = new EventLog(':memory:');
  tickets = await startTickets({ log, reader: jira, writer: jira, site: SITE, fieldsFile: join(REPO_ROOT, 'config', 'jira-fields.json') });
  await tickets.details.refresh('SHOP-3538');
});
afterEach(() => {
  tickets.stop();
  log.close();
});

describe('his edits, straight to Jira', () => {
  it('sets an empty field, logs it as his, and reads the ticket back', async () => {
    const value = doc('Inventory Sync Worker consumes InventorySyncCommand.');
    await edit('e1', 'SHOP-3538', { op: 'field', fieldId: ids.solution, value, base: null });
    expect(jira.writes()).toEqual([{ method: 'PUT', path: '/rest/api/3/issue/SHOP-3538', body: { fields: { [ids.solution]: value } } }]);
    expect(payloads('jira.edited')).toEqual([{ by: 'you', editId: 'e1', key: 'SHOP-3538', what: 'field', fieldId: ids.solution, ok: true }]);
    expect(folded('SHOP-3538')!.fields[ids.solution]).toEqual(value);
    // His own change is not marked as someone else's.
    expect(payloads('ticket.detail').at(-1)!.changes).toBeUndefined();
  });

  it("refuses to save over someone else's newer value, sends theirs back, and saves once he has seen it (criterion 7)", async () => {
    const base = folded('SHOP-3538')!.fields[ids.storyPoints];
    jira.change('SHOP-3538', QUINN, { [ids.storyPoints]: 5 }, [{ field: 'Story point estimate', fieldId: ids.storyPoints, fromString: '8', toString: '5' }], '2026-10-14T14:20:00.000+0700');
    await edit('e2', 'SHOP-3538', { op: 'field', fieldId: ids.storyPoints, value: 13, base });
    expect(jira.writes()).toEqual([]);
    expect(payloads('jira.edit_conflict')).toEqual([{ editId: 'e2', key: 'SHOP-3538', fieldId: ids.storyPoints, theirs: 5, by: 'Quinn Bauer', at: '2026-10-14T14:20:00.000+0700' }]);
    expect(payloads('jira.edited')).toEqual([]);
    // He has seen theirs: saving over it is his choice now.
    await edit('e3', 'SHOP-3538', { op: 'field', fieldId: ids.storyPoints, value: 13, base: 5 });
    expect(jira.writes()).toHaveLength(1);
  });

  it('only sets what the edit screen allows, and never a field holding text the workspace masks', async () => {
    await edit('e4', 'SHOP-3538', { op: 'field', fieldId: 'duedate', value: '2026-11-26', base: null });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: false, error: 'Jira does not let this field be set on this ticket.' });
    jira.issues.get('SHOP-3538')!.issue.fields[ids.impact] = doc('token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    await edit('e5', 'SHOP-3538', { op: 'field', fieldId: ids.impact, value: doc('x'), base: null });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: false, error: 'This field holds text the workspace masks; edit it in Jira.' });
    expect(jira.writes()).toEqual([]);
  });

  it('offers only the transitions Jira allows, and asks for the fields a transition screen requires (criterion 5)', async () => {
    await tickets.edits!.transitions('SHOP-2430');
    const [t] = payloads('ticket.transitions');
    expect(t!.key).toBe('SHOP-2430');
    expect(t!.transitions.length).toBeGreaterThan(0);
    for (const x of t!.transitions) expect(x.to.name).toMatch(/^[A-Z][A-Z -]+$/);
    // A transition whose screen requires a field is refused by Jira without it.
    const fixture = jira.issues.get('SHOP-2430')!;
    const raw = fixture.transitions!.transitions as Array<{ id: string; fields?: Record<string, { required?: boolean }> }>;
    raw[0]!.fields = { customfield_77777: { required: true } };
    await tickets.details.refresh('SHOP-2430');
    await edit('e6', 'SHOP-2430', { op: 'transition', transitionId: raw[0]!.id });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('customfield_77777 is required') });
    await edit('e7', 'SHOP-2430', { op: 'transition', transitionId: raw[0]!.id, fields: { customfield_77777: 'Fixed in 2.22.0' } });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: true, what: 'transition' });
  });

  it('adds his comments, edits and deletes only his own, and never over a newer version', async () => {
    await edit('e8', 'SHOP-3538', { op: 'comment_add', body: doc('Reproduced on dev.') });
    const mine = folded('SHOP-3538')!.comments.at(-1)!;
    expect(mine.author?.accountId).toBe('acc-me');
    await edit('e9', 'SHOP-3538', { op: 'comment_edit', commentId: mine.id, body: doc('Reproduced on dev and integration.'), base: mine.body });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: true, what: 'comment_edit' });
    await edit('e10', 'SHOP-3538', { op: 'comment_edit', commentId: mine.id, body: doc('x'), base: mine.body });
    expect(payloads('jira.edit_conflict').at(-1)).toMatchObject({ editId: 'e10', fieldId: `comment:${mine.id}` });
    // SHOP-2430's first comment is his; OPS-14739's is not.
    await tickets.details.refresh('OPS-14739');
    const theirs = folded('OPS-14739')!.comments[0]!;
    await edit('e11', 'OPS-14739', { op: 'comment_delete', commentId: theirs.id });
    expect(payloads('jira.edited').at(-1)).toMatchObject({ ok: false, error: 'Only your own comments can be changed here.' });
    await edit('e12', 'SHOP-3538', { op: 'comment_delete', commentId: mine.id });
    expect(folded('SHOP-3538')!.comments.some((c) => c.id === mine.id)).toBe(false);
  });

  it('links in Jira’s own direction: "is blocked by" makes the other ticket the inward one', async () => {
    await edit('e13', 'SHOP-3538', { op: 'link_add', linkType: 'Blocks', direction: 'inward', other: 'SHOP-3464' });
    expect(jira.writes().at(-1)).toMatchObject({ method: 'POST', path: '/rest/api/3/issueLink', body: { type: { name: 'Blocks' }, inwardIssue: { key: 'SHOP-3464' }, outwardIssue: { key: 'SHOP-3538' } } });
    await edit('e14', 'SHOP-3538', { op: 'link_add', linkType: 'Blocks', direction: 'outward', other: 'SHOP-3464' });
    expect(jira.writes().at(-1)).toMatchObject({ body: { inwardIssue: { key: 'SHOP-3538' }, outwardIssue: { key: 'SHOP-3464' } } });
    const link = (folded('SHOP-3538')!.fields.issuelinks as Array<{ id: string; inwardIssue?: { key: string } }>).find((l) => l.inwardIssue?.key === 'SHOP-3464')!;
    await edit('e15', 'SHOP-3538', { op: 'link_remove', linkId: link.id });
    expect(jira.writes().at(-1)).toEqual({ method: 'DELETE', path: `/rest/api/3/issueLink/${link.id}` });
  });

  it('finds tickets by key or summary words, in the sprint or not, and reads his pickers’ options once an hour', async () => {
    log.append('jira', 'ticket.synced', { ticket: { key: 'SHOP-3538', board: 'SHOP', summary: 's', type: 'Story', status: 'To do', priority: 'Blocker', storyPoints: 8, sprint: 'SHOP Sprint 52', sprintsCarried: 1, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: '' } });
    await tickets.edits!.search('shop-3538');
    await tickets.edits!.search('Sync Worker');
    const [byKey, byWords] = payloads('ticket.search');
    expect(byKey!.results).toEqual([expect.objectContaining({ key: 'SHOP-3538', inSprint: true, sprint: 'SHOP Sprint 52', status: { name: 'OPEN', category: 'new' } })]);
    expect(byWords!.results.map((r) => r.key)).toEqual(['SHOP-3538']);
    tickets.watch('SHOP-3538');
    for (let i = 0; i < 40 && !payloads('jira.options').length; i++) await tick(5);
    const [o] = payloads('jira.options');
    expect(o).toMatchObject({ project: 'SHOP', me: { accountId: 'acc-me' }, sprints: [{ id: 33774, name: 'SHOP Sprint 52', state: 'active' }] });
    expect(o!.users.map((u) => u.displayName)).toContain('Quinn Bauer');
    expect(o!.linkTypes.map((t) => t.name)).toEqual(expect.arrayContaining(['Blocks', 'Relates']));
    tickets.watch('SHOP-3464');
    await tick(20);
    expect(payloads('jira.options')).toHaveLength(1);
  });

  it("refuses the tester's edits; reads are allowed", () => {
    const intake = new Intake(log, { jiraEdit: () => undefined, jiraTransitions: () => undefined });
    expect(() => intake.handle({ t: 'jira_edit', editId: 'e', key: 'SHOP-3538', change: { op: 'comment_add', body: doc('x') }, test: true })).toThrow(IntakeError);
    expect(() => intake.handle({ t: 'jira_transitions', key: 'SHOP-3538' })).not.toThrow();
    intake.close();
  });
});

describe("Elfoqsy's edits, through the Jira proxy and his delegation (criterion 8)", () => {
  let proxies: Proxies;
  let approvals: Approvals;
  let grants: Grants;
  let live: LiveState;
  let first: FirstResponder;
  const said: string[] = [];
  const her = (ticket: string): ProxyRun => ({ runId: ELFOQSY_RUN, ticket, agentNumber: 0, branch: '', targets: [], kubeconfig: '/x', actor: 'elfoqsy', label: ticket });
  beforeEach(() => {
    said.length = 0;
    live = new LiveState(log);
    approvals = new Approvals(log);
    grants = new Grants(log);
    first = new FirstResponder({ log, state: () => live.get(), approvals, say: (_r, text) => said.push(text) });
    const backends = fakeBackends();
    backends.jira = new AtlassianJira({ site: SITE, email: 'x', token: 'y', bugFields: {}, tickets: { store: tickets.store, ids: () => ids }, fetch: (async (url: string, init: RequestInit) => {
      // The writes reach the fake Jira as his PUTs would.
      const body = JSON.parse(String(init.body ?? '{}')) as { fields: Record<string, unknown> };
      await jira.setFields(String(url).split('/').pop()!, body.fields);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch });
    jira.me = { accountId: 'acc-me', displayName: 'Alex Rivera' };
    (backends.jira as AtlassianJira).myAccountId = async () => 'acc-me';
    proxies = createProxies({
      log,
      approvals,
      grants,
      environments,
      backends,
      repos: [],
      say: (_r, text) => said.push(text),
      firstResponder: () => first,
      afterWrite: (w) => log.append('orchestrator', 'jira.edited', { key: w.target.key, by: 'elfoqsy', what: w.target.what, ...(w.target.fieldId ? { fieldId: w.target.fieldId } : {}), ok: w.ok, actionId: w.actionId, ...(w.recordId ? { recordId: w.recordId } : {}), runId: w.run.runId }),
      endedRun: async (runId, ticket) => (runId === ELFOQSY_RUN && ticket ? { run: her(ticket), dispose: () => undefined } : null),
    });
  });
  afterEach(() => {
    first.close();
    proxies.close();
    grants.close();
    approvals.close();
    live.close();
  });

  it('fills an empty field of his ticket at once and says so in one line, with Undo', async () => {
    const r = await proxies.request(her('SHOP-3538'), 'jira', { action: 'set_field', key: 'SHOP-3538', field: 'Solution', text: '**Inventory Sync Worker** consumes `InventorySyncCommand`.' });
    expect(r, r.text).toMatchObject({ ok: true });
    expect(payloads('decision.made').at(-1)).toMatchObject({ category: 'jira_fill', told: true, summary: 'Set Solution on SHOP-3538' });
    expect(said).toContain('I set Solution on SHOP-3538: you delegated filling an empty field of your ticket to me.');
    expect(payloads('jira.edited').at(-1)).toMatchObject({ key: 'SHOP-3538', by: 'elfoqsy', fieldId: ids.solution, ok: true, recordId: expect.any(String) });
    expect(jira.issues.get('SHOP-3538')!.issue.fields[ids.solution]).toEqual(markdownToAdf('**Inventory Sync Worker** consumes `InventorySyncCommand`.'));
    // His Undo puts it back to empty.
    expect(await proxies.undo(payloads('jira.edited').at(-1)!.recordId!, 'you')).toEqual({ ok: true });
    expect(jira.issues.get('SHOP-3538')!.issue.fields[ids.solution]).toBeNull();
  });

  it('asks before writing over a value, and before comments and transitions', async () => {
    void proxies.request(her('SHOP-3538'), 'jira', { action: 'set_field', key: 'SHOP-3538', field: 'Acceptance criteria', text: 'New.' });
    void proxies.request(her('SHOP-3538'), 'jira', { action: 'comment', key: 'SHOP-3538', text: 'Reproduced.' });
    void proxies.request(her('SHOP-3538'), 'jira', { action: 'transition', key: 'SHOP-3538', to: 'IN ANALYZE' });
    for (let i = 0; i < 50 && payloads('approval.requested').length < 3; i++) await tick(10);
    expect(payloads('approval.requested')).toHaveLength(3);
    expect(payloads('approval.requested').map((a) => [a.category, a.question.split('.')[0]])).toEqual(expect.arrayContaining([
      ['irreversible', 'Elfoqsy wants to set Acceptance criteria on SHOP-3538'],
      ['notify_people', 'Elfoqsy wants to comment on SHOP-3538: "Reproduced'],
      ['notify_people', 'Elfoqsy wants to move SHOP-3538 to IN ANALYZE'],
    ]));
    expect(jira.writes()).toEqual([]);
  });
});

describe('Markdown as Jira rich text', () => {
  it('keeps headings, lists, code, marks and links', () => {
    expect(markdownToAdf('## Why\n\n- one `a`\n  - nested\n1. first\n\n```json\n{}\n```\n\nSee [the page](https://x.example/p) and **this**.')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'a', marks: [{ type: 'code' }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{}' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the page', marks: [{ type: 'link', attrs: { href: 'https://x.example/p' } }] }, { type: 'text', text: ' and ' }, { type: 'text', text: 'this', marks: [{ type: 'strong' }] }, { type: 'text', text: '.' }] },
      ],
    });
    expect(valueText(markdownToAdf('plain'))).toBe('plain');
  });
});
