// v1.4, milestone 19 on screen: the B+ dial (every dot named and titled, the arrows naming where they go), finding a
// ticket by key or words in the sprint and outside it, his create form's Jira shape and what it still needs, a drafted
// ticket's card (it waits for him; the tester is not offered Create), Jira news, and inline code as agreed in v1.2.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JiraCreateField, PayloadOf, Ticket } from '@elfoqsy/contracts';
import { fieldIdsOf, foldAll } from '@elfoqsy/state';
import { eventFactory, mockSprint } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { Dial } = await import('../src/left/sprint/OrbitMap');
const { TicketView } = await import('../src/left/sprint/TicketView');
const { findInSprint, findResults, shortSprint } = await import('../src/left/sprint/find');
const { createFields, emptyForm, extraRequired, formFromDraft, linkWords, missing } = await import('../src/left/sprint/createForm');
const { DraftBlock, JiraNewsBlock } = await import('../src/left/chat/JiraBlocks');

const ids = fieldIdsOf();
const actions = { openTicket: () => {}, openBrief: () => {}, openHandoff: () => {}, editDraft: () => {}, openNarrative: () => {} };
const sprint = mockSprint();
const e = eventFactory();
const base = () => sprint.open.map((t) => e('ticket.synced', { ticket: t }));
const ticket = (key: string): Ticket => sprint.open.find((t) => t.key === key)!;
/** SHOP's create screen, captured from Jira with reads only. */
const screens = JSON.parse(readFileSync(join(__dirname, '..', '..', 'daemon', 'test', 'fixtures', 'jira', 'createmeta-SHOP.json'), 'utf8')) as {
  types: Array<{ id: string; name: string; subtask: boolean }>;
  fields: Record<string, Array<{ fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: JiraCreateField['schema']; allowedValues?: JiraCreateField['allowedValues'] }>>;
};
const BUG = '14534';
const STORY = '14532';
const screen = (typeId: string): JiraCreateField[] => screens.fields[typeId]!.map((f) => ({ id: f.fieldId, name: f.name, required: f.required && !f.hasDefaultValue, ...(f.schema ? { schema: f.schema } : {}), ...(f.allowedValues ? { allowedValues: f.allowedValues } : {}) }));

describe('the dial, B+ (screenshot 23)', () => {
  it('names every dot by its digits and labels each with its title and workflow status; only the open one is named at rest', () => {
    const s = foldAll(base());
    const open = sprint.open[0]!;
    const html = renderToStaticMarkup(<Dial state={s} selected={open.key} onSelect={() => {}} />);
    const shown = sprint.open.filter((t) => html.includes(`aria-label="${t.key},`));
    expect(shown.length).toBeGreaterThan(3);
    for (const t of shown) {
      expect(html).toContain(`>${t.key.split('-')[1]}</span>`);
      expect(html).toContain(`aria-label="${t.key}, ${t.summary.replace(/&/g, '&amp;')}, ${t.workflowStatus?.name ?? t.status}"`);
    }
    expect(html.match(/dial-num dial-num--on/g)).toHaveLength(1);
    // Its title shows in a tooltip layer on hover (v1.4.1), never a native title.
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toMatch(/class="dial-dot[^"]*"[^>]*title=/);
  });

  it('grows 1.7× as a floating layer without animating for reduced motion, and the labels still show', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.tv-dial-box--grown \{[^}]*z-index: var\(--z-dial\);[^}]*transform: scale\(1\.7\)/);
    expect(css).toMatch(/\.tv-dial-box--grown \.dial-num/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.tv-dial-box,\s*\.dial-num \{\s*transition: none;/.exec(css);
    expect(reduced).not.toBeNull();
  });

  it('names where each arrow goes, in the arrow keys’ order, and offers the search under the expand button', () => {
    const s = foldAll(base());
    const order = Object.values(s.tickets);
    const key = order[0]!.key;
    const html = renderToStaticMarkup(<TicketView state={s} ticketKey={key} jiraSite="https://acme.atlassian.net" onView={() => {}} onFind={() => {}} />);
    const prev = /aria-label="Previous ticket, ([A-Z]+-\d+)"/.exec(html)![1]!;
    const next = /aria-label="Next ticket, ([A-Z]+-\d+)"/.exec(html)![1]!;
    expect(html).toContain(`<span class="tv-nav-key tv-nav-key--prev" aria-hidden="true">${prev.split('-')[1]}</span>`);
    expect(html).toContain(`<span class="tv-nav-key" aria-hidden="true">${next.split('-')[1]}</span>`);
    expect(html).toContain('aria-label="Find a ticket (Ctrl K)"');
    // The shortcut is in a tooltip, shown on hover only.
    expect(html).not.toContain('Ctrl K</kbd>');
  });
});

describe('finding a ticket, C (screenshot 24)', () => {
  const tickets = sprint.open;
  it('matches keys exactly (or their digits) and titles by every word', () => {
    const t = tickets[2]!;
    expect(findInSprint(tickets, t.key.toLowerCase()).map((f) => f.key)).toEqual([t.key]);
    expect(findInSprint(tickets, t.key.split('-')[1]!).map((f) => f.key)).toEqual([t.key]);
    expect(findInSprint(tickets, t.key.slice(0, -1))).toEqual([]);
    const words = t.summary.split(/\s+/).filter((w) => w.length > 3).slice(0, 2);
    expect(findInSprint(tickets, words.join(' ').toUpperCase()).map((f) => f.key)).toContain(t.key);
    expect(findInSprint(tickets, `${words[0]} zzzz`)).toEqual([]);
    expect(findInSprint(tickets, '  ')).toEqual([]);
  });

  it("adds Jira's answer for the same words, outside the sprint too, each ticket once, with type, status and where", () => {
    const t = tickets[0]!;
    const s = foldAll([
      ...base(),
      e('ticket.search', {
        query: 'temporary store',
        results: [
          { key: 'CORE-18632', summary: 'Stream uploads into the Acme Shop temporary store', type: 'Story', status: { name: 'IN PROGRESS', category: 'indeterminate' }, inSprint: false },
          { key: t.key, summary: t.summary, type: t.type, status: { name: 'OPEN', category: 'new' }, inSprint: true, sprint: 'SHOP Sprint 52' },
        ],
      }),
    ]);
    const found = findResults(s, tickets, 'temporary store');
    expect(found.map((f) => [f.key, f.where])).toEqual(expect.arrayContaining([['CORE-18632', 'not in sprint']]));
    expect(found.filter((f) => f.key === t.key).length).toBeLessThanOrEqual(1);
    expect(found.find((f) => f.key === 'CORE-18632')).toMatchObject({ type: 'Story', status: { name: 'IN PROGRESS' } });
    // Another query's answer is not shown.
    expect(findResults(s, tickets, 'other words').some((f) => f.key === 'CORE-18632')).toBe(false);
    expect(shortSprint('SHOP Sprint 52')).toBe('Sprint 52');
  });
});

describe('his create form (screenshot 26)', () => {
  it('sends fields in Jira’s shape, only those on the type’s create screen', () => {
    const form = { ...emptyForm('SHOP'), typeId: BUG, summary: ' Inventory sync: reconcile job misses holds ', priority: 'Major', storyPoints: '3', sprintId: 33774, labels: ['checkout-v2'], assignee: 'acc-me', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Why' }] }] } };
    const fields = createFields(form, ids, screen(BUG));
    expect(fields).toEqual({
      summary: 'Inventory sync: reconcile job misses holds',
      description: form.description,
      priority: { id: screen(BUG).find((f) => f.id === 'priority')!.allowedValues!.find((v) => v.name === 'Major')!.id },
      [ids.storyPoints]: 3,
      [ids.sprint]: 33774,
      labels: ['checkout-v2'],
      assignee: { accountId: 'acc-me' },
    });
    // An empty editor is no Description; a field the screen lacks is left out.
    expect(createFields({ ...form, description: { type: 'doc', version: 1, content: [{ type: 'paragraph' }] }, parent: 'SHOP-3464' }, ids, [{ id: 'summary', name: 'Summary', required: true }])).toEqual({ summary: 'Inventory sync: reconcile job misses holds' });
  });

  it("asks for what Jira's screen requires: a story's Acceptance criteria, a bug's summary", () => {
    expect(extraRequired(screen(STORY), ids).map((f) => f.name)).toEqual(['Acceptance criteria']);
    expect(extraRequired(screen(BUG), ids)).toEqual([]);
    expect(missing({ ...emptyForm('SHOP'), typeId: STORY, summary: 'x' }, screen(STORY), ids)).toEqual(['Acceptance criteria']);
    expect(missing({ ...emptyForm('SHOP'), typeId: BUG }, screen(BUG), ids)).toEqual(['Summary']);
    expect(missing({ ...emptyForm('shop'), summary: 'x' }, undefined, ids)).toEqual(['Project', 'Type']);
  });

  it('starts from a draft: its Markdown Description as Jira’s rich text, its links in Jira’s wording', () => {
    const f = formFromDraft({ project: 'SHOP', type: 'Bug', summary: 's', description: 'Why: `ledger` is late.', priority: 'Major', storyPoints: 3, sprint: { id: 33774, name: 'SHOP Sprint 52' }, links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }] });
    expect(f).toMatchObject({ typeName: 'Bug', priority: 'Major', storyPoints: '3', sprintId: 33774 });
    expect(JSON.stringify(f.description)).toContain('"marks":[{"type":"code"}]');
    expect(linkWords([], f.links[0]!)).toBe('relates to');
    expect(linkWords([{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }], { linkType: 'Blocks', direction: 'inward' })).toBe('is blocked by');
  });
});

describe('a drafted ticket in the conversation', () => {
  const drafted = (by: 'elfoqsy' | 'agent' = 'agent'): PayloadOf<'ticket.drafted'> => ({
    draftId: 'draft-1',
    by,
    draft: { project: 'SHOP', type: 'Bug', summary: 'Inventory sync: reconcile job misses holds released mid-commit', priority: 'Major', storyPoints: 3, sprint: { id: 33774, name: 'SHOP Sprint 52' }, links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }] },
  });

  it('waits for him with its type, project, title and main fields, and Create in Jira, Edit first and Discard', () => {
    const s = foldAll([e('ticket.drafted', drafted())]);
    const html = renderToStaticMarkup(<DraftBlock state={s} draftId="draft-1" actions={actions} />);
    expect(html).toContain('New Bug · SHOP');
    expect(html).toContain('waiting for you');
    expect(html).toContain('Inventory sync: reconcile job misses holds released mid-commit');
    for (const chip of ['Major', '3 pt', 'Sprint 52', 'relates to SHOP-3538']) expect(html).toContain(`<span class="tag-outline">${chip}</span>`);
    expect(html).toMatch(/<button type="button" class="button-solid" disabled="">Create in Jira<\/button>/); // until Jira's screen is read
    expect(html).toContain('Edit first');
    expect(html).toContain('Discard');
  });

  it("says when it was created or discarded, and stops waiting", () => {
    const created = foldAll([e('ticket.drafted', drafted()), e('ticket.draft_closed', { draftId: 'draft-1', how: 'created', key: 'SHOP-9001', by: 'you' })]);
    const html = renderToStaticMarkup(<DraftBlock state={created} draftId="draft-1" actions={actions} />);
    expect(html).toContain('Created as');
    expect(html).toContain('SHOP-9001');
    expect(html).not.toContain('waiting for you');
    expect(html).not.toContain('Create in Jira');
    const discarded = foldAll([e('ticket.drafted', drafted()), e('ticket.draft_closed', { draftId: 'draft-1', how: 'discarded', by: 'you' })]);
    expect(renderToStaticMarkup(<DraftBlock state={discarded} draftId="draft-1" actions={actions} />)).toContain('Discarded');
  });

  it('asks to edit it first when Jira requires more than the draft has', () => {
    const story = { ...drafted('elfoqsy'), draft: { ...drafted().draft, type: 'Story' } };
    const s = foldAll([
      e('ticket.drafted', story),
      e('ticket.createmeta', { project: 'SHOP', types: screens.types }),
      e('ticket.createmeta', { project: 'SHOP', types: screens.types, typeId: STORY, fields: screen(STORY) }),
    ]);
    const html = renderToStaticMarkup(<DraftBlock state={s} draftId="draft-1" actions={actions} />);
    expect(html).toContain('Jira also needs Acceptance criteria: edit it first.');
    expect(html).toMatch(/class="button-solid" disabled="">Create in Jira/);
  });
});

describe('Jira news in the digest (screenshot 27)', () => {
  it('lists who did what on which ticket and when, the keys opening in Elfoqsy', () => {
    const s = foldAll([
      e('jira.news', {
        newsId: 'news-1',
        since: '2026-10-14T02:12:00.000Z',
        conversationId: 'c1',
        items: [
          { kind: 'mention', who: 'Quinn Bauer', what: 'mentioned you in', key: 'SHOP-3559', at: '2026-10-14T03:41:00.000+0000' },
          { kind: 'change', who: 'Quinn Bauer', what: 'changed priority to Blocker on', key: 'SHOP-3538', at: '2026-10-14T02:30:00.000+0000' },
        ],
      }),
    ]);
    const html = renderToStaticMarkup(<JiraNewsBlock state={s} newsId="news-1" actions={actions} />);
    expect(html).toMatch(/<b>In Jira since \d\d:\d\d<\/b>/);
    expect(html).toContain('your tickets and mentions');
    expect(html).toContain('<b>Quinn Bauer</b> mentioned you in <button type="button" class="news-key">SHOP-3559</button>');
    expect(html).toContain('<b>Quinn Bauer</b> changed priority to Blocker on <button type="button" class="news-key">SHOP-3538</button>');
    expect(html).toContain('<span class="person-initials" aria-hidden="true">QB</span>');
  });
});

describe('inline code everywhere (criterion 11)', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim()), body: m[2]! }));

  it('is white mono on the selected surface, padded, as agreed in v1.2', () => {
    const code = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === 'code')!;
    expect(code.body).toContain('font-family: var(--font-mono)');
    expect(code.body).toContain('color: var(--code-ink-bright)');
    expect(code.body).toContain('background: var(--bg-selected)');
    expect(code.body).toMatch(/padding: 2px 7px/);
  });

  it('is changed by no other rule, but inside code blocks', () => {
    const others = rules.filter((r) => r.selectors.some((s) => /(^|[\s>])code$/.test(s) && s !== 'code') && /\b(color|background|padding|font-family):/.test(r.body));
    expect(others.flatMap((r) => r.selectors.filter((s) => /code$/.test(s)))).toEqual(['.adf-code code', 'pre code']);
  });
});
