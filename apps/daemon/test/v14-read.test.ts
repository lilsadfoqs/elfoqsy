// v1.4, milestone 17: the full ticket from Jira. The field map checked at start-up, the layout of SHOP-3538 (as in
// screenshots 20 to 22), any other non-empty field under Other fields, a snapshot then only what changed in the log,
// others' changes marked with who made them, unreadable tickets, fields the redactor changed kept read-only, Elfoqsy and
// the agents reading the same full ticket, and attachments served only for tickets read. Everything runs against the
// fake Jira over the captured fixtures; nothing writes to Jira.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { applyDetail, blockedBy, currentSprint, detailLayout, detailText, fieldIdsOf, jiraDate, linkGroups, valueText, type TicketDetailView } from '@elfoqsy/state';
import { EventLog } from '../src/eventLog';
import { Intake } from '../src/intake';
import { AtlassianJira } from '../src/jira/atlassian';
import { JiraError } from '../src/jira/client';
import { toDetail } from '../src/jira/detail';
import { FakeJira, issueFromTicket } from '../src/jira/fake';
import { checkFieldMap, loadFieldMap } from '../src/jira/fieldMap';
import { IssueStore } from '../src/jira/issues';
import { mapIssue } from '../src/jira/map';
import { startTickets, type Tickets } from '../src/jira/tickets';
import { REPO_ROOT } from '../src/config';
import { Lookups } from '../src/elfoqsy/lookups';
import { startServer, type RunningServer } from '../src/server';
import { TicketDetails, POLL_OPEN_MS } from '../src/sync/details';
import { ManualClock } from './helpers/fakeSdk';

const FIXTURES = join(__dirname, 'fixtures', 'jira');
const FIELDS_FILE = join(REPO_ROOT, 'config', 'jira-fields.json');
const SITE = 'https://acme.atlassian.net';
const ids = fieldIdsOf();
const QUINN = { accountId: 'acc-1', displayName: 'Quinn Bauer' };

let jira: FakeJira;
let log: EventLog;
let clock: ManualClock;
const events = <T extends EventType>(type: T) => log.readFrom(0, 100_000, [type]) as Array<Extract<AnyEnvelope, { type: T }>>;
const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
const view = async (key: string): Promise<TicketDetailView> => {
  const store = new IssueStore(jira);
  const b = await store.get(key);
  return applyDetail(undefined, toDetail(b, ids), b.fetchedAt);
};
/** The log's current view of a ticket, as the screens fold it. */
const folded = (key: string): TicketDetailView | undefined =>
  events('ticket.detail')
    .filter((e) => e.payload.key === key)
    .reduce<TicketDetailView | undefined>((v, e) => applyDetail(v, e.payload, Date.parse(e.ts)), undefined);

beforeEach(() => {
  jira = FakeJira.fromFixtures(FIXTURES);
  clock = new ManualClock(Date.parse('2026-10-14T07:00:00Z'));
  log = new EventLog(':memory:', () => new Date(clock.now));
});
afterEach(() => log.close());

describe('the field map, checked at start-up', () => {
  it('keeps every configured id that still carries its name, though names are not unique on this site', () => {
    const r = checkFieldMap(loadFieldMap(FIELDS_FILE), jira.siteFields);
    expect(r.moved).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(jira.siteFields.filter((f) => f.name === 'Reviewer').length).toBeGreaterThan(1);
  });

  it('moves a field only to the one field with its name, and logs the rest as missing', () => {
    const map = loadFieldMap(FIELDS_FILE);
    const fields = jira.siteFields.map((f) => (f.id === 'customfield_16595' ? { ...f, id: 'customfield_99999' } : f)).filter((f) => f.id !== 'customfield_17564');
    const r = checkFieldMap(map, fields);
    expect(r.moved).toEqual([{ role: 'rootCause', name: 'Root cause description', from: 'customfield_16595', to: 'customfield_99999' }]);
    expect(r.missing).toEqual([{ role: 'reviewer', name: 'Reviewer', id: 'customfield_17564' }]);
    expect(r.map.rootCause.id).toBe('customfield_99999');
  });

  it('logs the check once at start, and again only when it changes', async () => {
    const t = await startTickets({ log, reader: jira, site: SITE, fieldsFile: FIELDS_FILE });
    t.stop();
    const again = await startTickets({ log, reader: jira, site: SITE, fieldsFile: FIELDS_FILE });
    again.stop();
    expect(payloads('jira.fields')).toHaveLength(1);
    expect(payloads('jira.fields')[0]!.fields.storyPoints).toEqual({ name: 'Story point estimate', id: 'customfield_16486' });
  });
});

describe('SHOP-3538 laid out as Jira shows it (screenshots 20 to 22)', () => {
  it('has its parent, workflow status, priority, points, Blocked by 2, title, created and updated', async () => {
    const d = await view('SHOP-3538');
    const f = d.fields as Record<string, Record<string, unknown> & { fields?: Record<string, unknown> }>;
    expect(f.parent!.key).toBe('SHOP-3534');
    expect(valueText(f.status)).toBe('OPEN');
    expect(valueText(f.priority)).toBe('Blocker');
    expect(d.fields[ids.storyPoints]).toBe(8);
    expect(blockedBy(d)).toBe(2);
    expect(valueText(d.fields.summary)).toBe('[Checkout V2] Inventory Sync Worker: commit the stock reservation after payment capture, then release the hold (P04)');
    expect(valueText(d.fields.creator)).toBe('Quinn Bauer');
    expect(jiraDate(d.fields.updated as string)).toMatch(/^1[12] Oct 2026$/);
  });

  it('puts the filled fields in two columns, folds the empty ones of its edit screen, and lists the rich text in order', async () => {
    const d = await view('SHOP-3538');
    const l = detailLayout(d, ids);
    expect(l.facts.map((x) => x.name)).toEqual(['Assignee', 'Reporter', 'Sprint', 'Labels']);
    expect(currentSprint(d.fields[ids.sprint])).toEqual({ name: 'SHOP Sprint 52', goal: 'Release Manager: Morgan Diaz' });
    // Components and Due date are not on this story's edit screen, so they are not offered (plan, question 3).
    expect(l.emptyFacts.map((x) => x.name)).toEqual(['Fix versions', 'QA Assignee', 'Reviewer', 'QA Story point estimate']);
    expect(l.rich.map((x) => x.name)).toEqual(['Description', 'Solution', 'Impact', 'Acceptance criteria', 'Design']);
    expect(l.rich.filter((r) => d.fields[r.id] === undefined).map((r) => r.name)).toEqual(['Solution', 'Impact', 'Design']);
    expect(l.other).toEqual([]);
  });

  it('groups linked work items by Jira wording, with status, priority and summary for aligned columns', async () => {
    const groups = linkGroups(await view('SHOP-3538'));
    expect(groups.map((g) => [g.relation, g.items.map((i) => `${i.key} ${i.status} ${i.priority}`)])).toEqual([
      ['is blocked by', ['SHOP-3543 OPEN Blocker', 'SHOP-3537 OPEN Blocker']],
      ['Relates', ['CORE-18632 Open Minor', 'SHOP-3559 OPEN Blocker']],
    ]);
  });

  it('keeps the Confluence page that mentions it, and the bug fields on a bug', async () => {
    expect((await view('SHOP-3538')).remoteLinks).toEqual([expect.objectContaining({ title: 'Checkout V2 :: Planning', application: 'com.atlassian.confluence', relationship: 'mentioned in' })]);
    const bug = detailLayout(await view('SHOP-2430'), ids);
    expect(bug.rich.map((x) => x.name)).toContain('Root cause description');
  });

  it('hides automation fields and shows any other non-empty field, an unknown one included, by its Jira name (criterion 2)', async () => {
    const fixture = jira.issues.get('SHOP-3538')!.issue;
    fixture.fields.customfield_55555 = { value: 'Platform team' };
    fixture.names!.customfield_55555 = 'Owning team';
    fixture.fields.customfield_55556 = '2026-10-08T10:00:00.000+0700';
    fixture.names!.customfield_55556 = 'Time taken at OPEN';
    const d = await view('SHOP-3538');
    expect(detailLayout(d, ids).other).toEqual([{ id: 'customfield_55555', name: 'Owning team' }]);
    expect(valueText(d.fields.customfield_55555)).toBe('Platform team');
    // Rank, the timestamps and the Development field never even reach the log.
    expect(Object.keys(d.fields)).not.toContain('customfield_11220');
    expect(Object.keys(d.fields)).not.toContain('customfield_55556');
    expect(Object.keys(d.fields)).not.toContain(ids.development);
  });
});

describe('tickets on the screens: a snapshot, then only what changed', () => {
  let details: TicketDetails;
  beforeEach(() => {
    // Polled by hand here; start() only runs poll() on a timer.
    details = new TicketDetails({ log, store: new IssueStore(jira, () => clock.now), site: SITE, clock, now: () => clock.now });
  });
  afterEach(() => details.close());

  it('reads an open ticket at once, also outside the sprint, and not again until the next poll', async () => {
    details.watch('SHOP-3538');
    await details.refresh('SHOP-3538'); // the watch's read, awaited
    const [snapshot] = payloads('ticket.detail');
    expect(snapshot).toMatchObject({ key: 'SHOP-3538', full: true, updated: '2026-10-11T19:01:25.426-0700' });
    expect(JSON.stringify(snapshot).length).toBeLessThan(40_000);
    const reads = jira.requests.filter((r) => r.path === '/rest/api/3/issue/SHOP-3538').length;
    details.watch('SHOP-3538');
    expect(jira.requests.filter((r) => r.path === '/rest/api/3/issue/SHOP-3538').length).toBe(reads);
    // Nothing changed in Jira: nothing more in the log.
    await details.refresh('SHOP-3538');
    expect(payloads('ticket.detail')).toHaveLength(1);
  });

  it("writes only the changed field after someone else's change, marked with who and when (criterion 6)", async () => {
    await details.refresh('SHOP-3538');
    jira.change('SHOP-3538', QUINN, { priority: { name: 'Critical', id: '2' } }, [{ field: 'priority', fieldId: 'priority', fromString: 'Blocker', toString: 'Critical' }], '2026-10-14T14:20:00.000+0700');
    details.watch('SHOP-3538');
    clock.advance(POLL_OPEN_MS);
    await details.poll();
    const patch = payloads('ticket.detail').at(-1)!;
    expect(patch.full).toBeUndefined();
    expect(Object.keys(patch.fields ?? {})).toEqual(['priority', 'updated']);
    expect(patch.changes).toEqual([{ fieldId: 'priority', name: 'Priority', by: 'Quinn Bauer', at: '2026-10-14T14:20:00.000+0700' }]);
    expect(JSON.stringify(patch).length).toBeLessThan(2_000);
    expect(valueText(folded('SHOP-3538')!.fields.priority)).toBe('Critical');
    // His own changes are not marked.
    jira.change('SHOP-3538', jira.me, { labels: ['checkout-v2', 'p04'] }, [{ field: 'labels', fieldId: 'labels', fromString: 'checkout-v2', toString: 'checkout-v2 p04' }], '2026-10-14T14:21:00.000+0700');
    await details.refresh('SHOP-3538');
    expect(payloads('ticket.detail').at(-1)!.changes).toBeUndefined();
  });

  it('reads a sprint ticket again when the sprint poll says it changed, so the sprint learns who changed it', async () => {
    await details.refresh('SHOP-3538');
    log.append('jira', 'ticket.synced', { ticket: mapIssue(jira.issues.get('SHOP-3538')!.issue, { storyPointsField: ids.storyPoints, sprintField: ids.sprint }) });
    jira.change('SHOP-3538', QUINN, { [ids.storyPoints]: 5 }, [{ field: 'Story point estimate', fieldId: ids.storyPoints, fromString: '8', toString: '5' }], '2026-10-14T14:30:00.000+0700');
    const ticket = mapIssue(jira.issues.get('SHOP-3538')!.issue, { storyPointsField: ids.storyPoints, sprintField: ids.sprint });
    expect(ticket).toMatchObject({ workflowStatus: { name: 'OPEN', category: 'new' }, assignee: 'Alex Rivera', updatedAt: '2026-10-14T14:30:00.000+0700' });
    log.append('jira', 'ticket.synced', { ticket });
    for (let i = 0; i < 20 && payloads('ticket.detail').length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(payloads('ticket.detail').at(-1)!.changes).toEqual([{ fieldId: ids.storyPoints, name: 'Story point estimate', by: 'Quinn Bauer', at: '2026-10-14T14:30:00.000+0700' }]);
  });

  it('learns who changed a sprint ticket that was never opened, from its changelog since the sprint last saw it', async () => {
    const opts = { storyPointsField: ids.storyPoints, sprintField: ids.sprint };
    log.append('jira', 'ticket.synced', { ticket: mapIssue(jira.issues.get('SHOP-3464')!.issue, opts) });
    jira.change('SHOP-3464', QUINN, { priority: { name: 'Critical', id: '2' } }, [{ field: 'priority', fieldId: 'priority', fromString: 'Major', toString: 'Critical' }], '2026-10-14T16:00:00.000+0700');
    log.append('jira', 'ticket.synced', { ticket: mapIssue(jira.issues.get('SHOP-3464')!.issue, opts) });
    for (let i = 0; i < 40 && !payloads('ticket.detail').length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(payloads('ticket.detail')[0]).toMatchObject({ key: 'SHOP-3464', full: true, changes: [{ fieldId: 'priority', name: 'Priority', by: 'Quinn Bauer', at: '2026-10-14T16:00:00.000+0700' }] });
  });

  it('says once that a ticket cannot be read, and backs off while Jira asks it to', async () => {
    await details.refresh('SHOP-9999');
    await details.refresh('SHOP-9999');
    expect(payloads('ticket.unreadable')).toEqual([{ key: 'SHOP-9999', reason: 'Jira says SHOP-9999 does not exist, or you cannot see it.' }]);
    await details.refresh('SHOP-3538');
    jira.failing = new JiraError('HTTP 429', 429, 60);
    details.watch('SHOP-3538');
    clock.advance(POLL_OPEN_MS);
    await details.poll();
    const asked = jira.requests.length;
    clock.advance(POLL_OPEN_MS);
    await details.poll();
    expect(jira.requests.length).toBe(asked); // still waiting the minute Jira asked for
    // A ticket already shown keeps showing while Jira slows callers down.
    expect(payloads('ticket.unreadable').map((u) => u.key)).toEqual(['SHOP-9999']);
  });

  it('keeps a field the redactor changed read-only, so a masked secret is never written back', async () => {
    const fixture = jira.issues.get('SHOP-3538')!.issue;
    fixture.fields[ids.solution] = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 for now.' }] }] };
    await details.refresh('SHOP-3538');
    const d = folded('SHOP-3538')!;
    expect(d.locked).toEqual([ids.solution]);
    expect(JSON.stringify(d.fields[ids.solution])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('looks up the titles of Confluence pages its text links to, once', async () => {
    jira.pages.set('7340021', 'Checkout V2 :: Requirements');
    await details.refresh('SHOP-3538');
    expect(folded('SHOP-3538')!.confluence).toMatchObject({ '7340021': 'Checkout V2 :: Requirements' });
    const lookups = jira.requests.filter((r) => r.path.startsWith('/wiki/')).length;
    jira.change('SHOP-3538', QUINN, { labels: ['x'] }, [{ field: 'labels', fromString: '', toString: 'x' }], '2026-10-14T15:00:00.000+0700');
    await details.refresh('SHOP-3538');
    expect(jira.requests.filter((r) => r.path.startsWith('/wiki/')).length).toBe(lookups);
  });

  it('never writes to Jira', async () => {
    for (const key of jira.issues.keys()) await details.refresh(key);
    expect(jira.writes()).toEqual([]);
  });
});

describe('Elfoqsy and the agents read the same full ticket', () => {
  it('gives lookup_jira every named field, the rich text as Markdown, links, Confluence and comments', async () => {
    const store = new IssueStore(jira);
    const out = (await new Lookups({ tickets: { store, ids: () => ids }, site: SITE }).jira({ key: 'shop-2430' })) as { key: string; url: string; status: string; text: string };
    expect(out).toMatchObject({ key: 'SHOP-2430', url: `${SITE}/browse/SHOP-2430`, status: 'WORK-DONE' });
    for (const part of ['## Root cause description', '## Solution', '## Acceptance criteria', 'QA Assignee:', 'Sprint:', '## Linked work items', '## Comments (7)', '## Attachments', 'integration-test-2430.png']) expect(out.text).toContain(part);
    // The same store: a second read within 30 seconds is not another request.
    const reads = jira.requests.length;
    await new Lookups({ tickets: { store, ids: () => ids }, site: SITE }).jira({ key: 'SHOP-2430' });
    expect(jira.requests.length).toBe(reads);
  });

  it("gives an agent's jira get the same text", async () => {
    const store = new IssueStore(jira);
    const backend = new AtlassianJira({ site: SITE, email: 'x', token: 'y', bugFields: {}, tickets: { store, ids: () => ids }, fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch });
    const facts = await backend.get('SHOP-3538');
    expect(facts).toMatchObject({ key: 'SHOP-3538', status: 'OPEN', assigneeAccountId: 'acc-me' });
    expect(facts.text).toBe(detailText(await view('SHOP-3538'), ids, SITE));
    expect(facts.text).toContain('Sprint: SHOP Sprint 52 (goal: Release Manager: Morgan Diaz)');
  });
});

describe('the open ticket, and its attachments', () => {
  let tickets: Tickets;
  let server: RunningServer;
  beforeEach(async () => {
    tickets = await startTickets({ log, reader: jira, site: SITE, fieldsFile: FIELDS_FILE });
    const intake = new Intake(log, { watchTicket: (key) => tickets.details.watch(key) });
    server = await startServer({ log, intake, mode: 'simulate', jiraSite: SITE, port: 0, jiraAttachment: tickets.attachment });
  });
  afterEach(async () => {
    tickets.stop();
    await server.close();
  });

  it('reads the ticket named by watch_ticket, and serves only the attachments of tickets read', async () => {
    new Intake(log, { watchTicket: (key) => tickets.details.watch(key) }).handle({ t: 'watch_ticket', key: 'SHOP-2430' });
    for (let i = 0; i < 40 && !payloads('ticket.detail').length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(payloads('ticket.detail')[0]).toMatchObject({ key: 'SHOP-2430', full: true });
    const image = await fetch(`${server.url}/jira/attachments/1144667`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toMatch(/^inline/);
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    // An HTML report downloads; it never renders in the app's origin.
    const html = await fetch(`${server.url}/jira/attachments/1142773`);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await fetch(`${server.url}/jira/attachments/1`)).status).toBe(404);
    expect((await fetch(`${server.url}/jira/attachments/1144667`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('simulated tickets', () => {
  it('are built as Jira would give them, so simulate mode shows the full view', async () => {
    const fake = new FakeJira();
    fake.fallback = (key) =>
      key === 'SHOP-3049'
        ? issueFromTicket({ key, board: 'SHOP', summary: 'Force-block proposal', type: 'Bug', status: 'Blocked', priority: 'Blocker', storyPoints: 3, sprint: 'S52', sprintsCarried: 1, epic: null, reporter: 'Quinn Bauer', created: '1 Oct 2026', updated: '2 Oct 2026', labels: [], linked: [], description: 'First.\n\nSecond.' })
        : undefined;
    const store = new IssueStore(fake);
    const d = toDetail(await store.get('SHOP-3049'), ids);
    expect(d.fields).toMatchObject({ summary: 'Force-block proposal', status: { name: 'BLOCKED' } });
    expect((d.fields!.description as { content: unknown[] }).content).toHaveLength(2);
  });
});
