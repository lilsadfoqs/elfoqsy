// v1.4, milestone 17 on screen: Jira's rich text (every node the brief lists, panels as an icon with no fill or stripe,
// links sorted into Elfoqsy, Confluence chips and new tabs, nothing executed), the full ticket view of the captured
// fixtures (a story, a bug with comments and attachments, sub-tasks, a panel and a table), and the fold of a snapshot
// and its patches.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayloadOf } from '@elfoqsy/contracts';
import { applyDetail, foldAll, statusToken } from '@elfoqsy/state';
import { eventFactory } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { Adf, classifyUrl, nodeTypes, RENDERED_NODES } = await import('../src/ui/Adf');
const { TicketView } = await import('../src/left/sprint/TicketView');

const detail = (key: string): PayloadOf<'ticket.detail'> => JSON.parse(readFileSync(new URL(`../e2e/fixtures/${key}.detail.json`, import.meta.url), 'utf8'));
const SITE = 'https://acme.atlassian.net';
const ctx = { site: SITE, openTicket: () => undefined, confluence: { '42': 'Release/2.22.0' }, attachments: [{ id: '7', filename: 'shot.png', mimeType: 'image/png' }, { id: '8', filename: 'report.html', mimeType: 'text/html' }], projects: new Set(['SHOP']) };
const html = (doc: unknown) => renderToStaticMarkup(<Adf doc={doc} ctx={ctx} />);
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

describe("Jira's rich text (ADF)", () => {
  it('renders headings, lists, task lists, tables, code, marks, mentions, emoji, dates, status and expands', () => {
    const out = html(
      doc(
        { type: 'heading', attrs: { level: 3 }, content: [t('Why')] },
        p(t('bold', [{ type: 'strong' }]), t(' and '), t('code', [{ type: 'code' }]), t(' and '), t('gone', [{ type: 'strike' }]), t(' '), t('red', [{ type: 'textColor', attrs: { color: '#ff5630' } }])),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
        { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('shipped')] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Env'))] }, { type: 'tableCell', attrs: { colspan: 2 }, content: [p(t('dev'))] }] }] },
        { type: 'codeBlock', attrs: { language: 'json' }, content: [t('{"a":1}')] },
        p({ type: 'mention', attrs: { id: 'acc-4', text: '@Avery Stone' } }, t(' '), { type: 'emoji', attrs: { shortName: ':kiss:', text: '😘' } }, t(' '), { type: 'date', attrs: { timestamp: '1760400000000' } }, t(' '), { type: 'status', attrs: { text: 'In review', color: 'blue' } }),
        { type: 'expand', attrs: { title: 'Logs' }, content: [p(t('inside'))] },
      ),
    );
    expect(out).toContain('<h4 class="adf-h adf-h3">Why</h4>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<s>gone</s>');
    expect(out).toContain('red'); // its colour is dropped: monochrome for reading
    expect(out).not.toContain('#ff5630');
    expect(out).toContain('<ol start="3">');
    expect(out).toContain('adf-task adf-task--done');
    expect(out).toContain('<th>');
    expect(out).toContain('colSpan="2"');
    expect(out).toContain('data-language="json"');
    expect(out).toContain('Avery Stone');
    expect(out).toContain('😘');
    expect(out).toContain('adf-status adf-status--in-progress');
    expect(out).toContain('<summary>Logs</summary>');
  });

  it('shows a panel as its icon beside the text, with no fill and no stripe', () => {
    const out = html(doc({ type: 'panel', attrs: { panelType: 'warning' }, content: [p(t('Careful'))] }));
    expect(out).toMatch(/<div class="adf-panel"><svg class="adf-panel-icon adf-panel-icon--warning"[^>]*aria-label="Warning"/);
    expect(out).not.toMatch(/style="[^"]*(background|border)/);
  });

  it('opens tickets inside Elfoqsy, shows Confluence pages by title, and sends anything else to a new tab', () => {
    expect(classifyUrl(`${SITE}/browse/SHOP-3389#icft=SHOP-3389`, SITE)).toEqual({ kind: 'ticket', key: 'SHOP-3389' });
    expect(classifyUrl(`${SITE}/wiki/spaces/SHOP/pages/7340021/Checkout+V2`, SITE)).toEqual({ kind: 'confluence', pageId: '7340021' });
    expect(classifyUrl(`${SITE}/wiki/pages/viewpage.action?pageId=42`, SITE)).toEqual({ kind: 'confluence', pageId: '42' });
    expect(classifyUrl('https://github.com/acme/shop-api/pull/9', SITE)).toEqual({ kind: 'external' });
    const out = html(
      doc(
        p({ type: 'inlineCard', attrs: { url: `${SITE}/browse/SHOP-3389#icft=SHOP-3389` } }),
        p(t(`${SITE}/wiki/pages/viewpage.action?pageId=42`, [{ type: 'link', attrs: { href: `${SITE}/wiki/pages/viewpage.action?pageId=42` } }])),
        p(t('the PR', [{ type: 'link', attrs: { href: 'https://github.com/x/y/pull/1' } }])),
        p(t('SHOP-3537 (store), UTF-8 and ABC-12 stay text')),
      ),
    );
    expect(out).toContain(`<a href="${SITE}/browse/SHOP-3389" class="adf-key">SHOP-3389</a>`);
    expect(out).toContain('class="confluence-chip"');
    expect(out).toContain('Release/2.22.0</a>');
    // A link to GitHub carries GitHub's icon, and goes to a new tab.
    expect(out).toMatch(/<a href="https:\/\/github\.com\/x\/y\/pull\/1" target="_blank" rel="noreferrer noopener"><span class="link-icon"><span class="tile tile--16" data-tile="github"[^>]*>.*<\/span><\/span>the PR<\/a>/);
    // Plain keys of known projects are links; other look-alikes stay text.
    expect(out).toContain('class="adf-key">SHOP-3537</a>');
    expect(out).not.toContain('>UTF-8</a>');
    expect(out).not.toContain('>ABC-12</a>');
  });

  it('never executes what it renders: script-like text stays text, and unsafe links go nowhere', () => {
    const out = html(doc(p(t('<img src=x onerror=alert(1)>')), p(t('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))));
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<a href="#"');
  });

  it("shows a ticket's images and files from its attachments, and names what it cannot show", () => {
    const out = html(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'u-1', alt: 'shot.png', width: 400 } }] }, p({ type: 'mediaInline', attrs: { id: 'u-2' } }), { type: 'extension', attrs: { extensionKey: 'jira-chart' } }));
    expect(out).toContain('<img class="adf-image" src="/jira/attachments/7" alt="shot.png" loading="lazy" style="width:400px"/>');
    expect(out).toContain('adf-file adf-file--unknown');
    expect(out).toContain('[extension shown in Jira]');
  });

  it('renders every node type found in the captured tickets', () => {
    for (const key of ['SHOP-3538', 'SHOP-2430', 'SHOP-3464', 'SHOP-3561', 'OPS-14739']) {
      const d = detail(key);
      const found = new Set<string>();
      for (const v of Object.values(d.fields ?? {})) nodeTypes(v, found);
      for (const c of d.comments ?? []) nodeTypes(c.body, found);
      for (const type of found) expect(RENDERED_NODES.has(type), `${key}: ${type}`).toBe(true);
    }
  });
});

describe('the full ticket view', () => {
  const e = eventFactory();
  const state = (...keys: string[]) =>
    foldAll([
      e('jira.fields', { fields: {}, moved: [], missing: [] }),
      ...keys.map((k) => e('ticket.detail', detail(k))),
    ]);
  const view = (key: string, s = state(key)) => renderToStaticMarkup(<TicketView state={s} ticketKey={key} jiraSite={SITE} onView={() => undefined} onFind={() => undefined} />);

  it('shows SHOP-3538 outside the sprint by key, with its header, fields, sections and links (criterion 1)', () => {
    const out = view('SHOP-3538');
    expect(out).toContain('not in sprint');
    for (const part of ['SHOP-3534', 'OPEN', 'Blocker', '8 pt', 'Blocked by 2', 'Created 8 Oct 2026 by Quinn Bauer', '4 empty fields', 'Release Manager: Morgan Diaz', 'checkout-v2', 'Add text', 'No design linked', 'is blocked by', 'Checkout V2 :: Planning', 'mentions this ticket']) expect(out).toContain(part);
    expect(out.indexOf('>Description<')).toBeLessThan(out.indexOf('>Solution<'));
    expect(out.indexOf('>Acceptance criteria<')).toBeLessThan(out.indexOf('>Design<'));
  });

  it('shows a bug with its root cause, other fields, attachments as images and files, comments and history', () => {
    const out = view('SHOP-2430');
    for (const part of ['Root cause description', 'Other fields', 'Dev Self-Testing Quality', 'Attachments', 'class="tv-image"', 'Open</a>', 'Comments<span class="tv-count-muted">7</span>', 'History', 'WORK-DONE']) expect(out).toContain(part);
  });

  it('shows sub-tasks in the same columns as linked items, and a panel and a table', () => {
    expect(view('SHOP-3464')).toMatch(/Sub-tasks<span class="tv-count-muted">6<\/span>/);
    const panel = view('OPS-14739');
    expect(panel).toContain('class="adf-panel"');
    expect(panel).toContain('class="adf-table"');
  });

  it('colours a workflow status by its category, a dropped one grey', () => {
    expect(statusToken('IN ANALYZE', 'indeterminate')).toBe('--status-in-progress');
    expect(statusToken('WORK-DONE', 'done')).toBe('--status-done');
    expect(statusToken('DROPPED', 'done')).toBe('--status-todo');
    expect(statusToken('OPEN', 'new')).toBe('--status-todo');
  });

  it('says it is reading a ticket it does not have yet, and what Jira said when it cannot', () => {
    expect(view('SHOP-9', foldAll([]))).toContain('Reading SHOP-9 from Jira…');
    const s = foldAll([e('ticket.unreadable', { key: 'SHOP-9', reason: 'Jira says SHOP-9 does not exist, or you cannot see it.' })]);
    expect(view('SHOP-9', s)).toContain('Jira says SHOP-9 does not exist');
  });
});

describe('a ticket folded from a snapshot and its patches', () => {
  it('applies only what a patch names, keeps the history once, and marks what others changed', () => {
    const snap = detail('SHOP-3538');
    const v1 = applyDetail(undefined, snap, 0);
    const v2 = applyDetail(v1, { key: snap.key, id: snap.id, fields: { priority: { name: 'Critical' } }, removed: ['labels'], history: [{ id: '99', created: 'x', items: [{ field: 'priority', toString: 'Critical' }] }], changes: [{ fieldId: 'priority', name: 'Priority', by: 'Quinn Bauer', at: 'x' }], updated: 'u2', fetchedAt: new Date(5000).toISOString() }, 5000);
    expect(v2.fields.priority).toEqual({ name: 'Critical' });
    expect(v2.fields.labels).toBeUndefined();
    expect(v2.fields.summary).toBe(v1.fields.summary);
    expect(v2.comments).toBe(v1.comments);
    expect(v2.history.at(-1)!.id).toBe('99');
    expect(applyDetail(v2, { key: snap.key, id: snap.id, history: [{ id: '99', created: 'x', items: [] }], updated: 'u3', fetchedAt: new Date(6000).toISOString() }, 6000).history.filter((h) => h.id === '99')).toHaveLength(1);
    expect(v2.changes).toEqual([{ fieldId: 'priority', name: 'Priority', by: 'Quinn Bauer', at: 'x', seenAt: 5000 }]);
  });
});
