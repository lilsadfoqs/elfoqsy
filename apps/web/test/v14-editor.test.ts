// v1.4, milestone 18: the editor holds Jira's rich text without loss (criterion 4). Every rich field and comment of the
// captured tickets goes into the editor and back out unchanged, nodes it does not know keep a field read-only, and
// what the editor itself makes is ADF Jira takes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PayloadOf } from '@elfoqsy/contracts';
import { isRichText } from '@elfoqsy/state';
import { adfToPm, editable, normalizeAdf, pmToAdf, schema, typesOf, type AdfNode } from '../src/editor/adfSchema';

const detail = (key: string): PayloadOf<'ticket.detail'> => JSON.parse(readFileSync(new URL(`../e2e/fixtures/${key}.detail.json`, import.meta.url), 'utf8'));
const KEYS = ['SHOP-3538', 'SHOP-2430', 'SHOP-3464', 'SHOP-3561', 'OPS-14739'];

describe('the editor holds Jira rich text without loss (criterion 4)', () => {
  it('round-trips every rich field and comment of the captured tickets', () => {
    let docs = 0;
    const types = new Set<string>();
    for (const key of KEYS) {
      const d = detail(key);
      const bodies: Array<[string, unknown]> = [
        ...Object.entries(d.fields ?? {}).filter(([id, v]) => isRichText(d.schema?.[id], v)),
        ...(d.comments ?? []).map((c): [string, unknown] => [`comment ${c.id}`, c.body]),
      ];
      for (const [what, doc] of bodies) {
        if (!doc || (doc as AdfNode).type !== 'doc') continue;
        expect(editable(doc), `${key} ${what}`).toBe(true);
        const back = pmToAdf(adfToPm(doc as AdfNode));
        expect(normalizeAdf(back), `${key} ${what}`).toEqual(normalizeAdf(doc));
        typesOf(doc as AdfNode, types);
        docs++;
      }
    }
    expect(docs).toBeGreaterThan(20);
    // The nodes and marks of the five tickets, all held.
    for (const t of ['heading', 'bulletList', 'orderedList', 'table', 'tableHeader', 'codeBlock', 'panel', 'mention', 'emoji', 'inlineCard', 'mediaSingle', 'mediaInline', 'hardBreak', 'mark:code', 'mark:strong', 'mark:link', 'mark:textColor']) expect(types.has(t), t).toBe(true);
  });

  it('round-trips every node and mark it offers, with their attributes', () => {
    const doc: AdfNode = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why', marks: [{ type: 'strong' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'em' }, { type: 'link', attrs: { href: 'https://x.example' } }] }, { type: 'hardBreak' }, { type: 'text', text: 'b', marks: [{ type: 'strike' }, { type: 'underline' }, { type: 'subsup', attrs: { type: 'sup' } }] }, { type: 'mention', attrs: { id: 'acc-1', text: '@Quinn Bauer', localId: 'm1' } }, { type: 'date', attrs: { timestamp: '1760400000000' } }, { type: 'status', attrs: { text: 'DONE', color: 'green', localId: 's1' } }] },
        { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] }] }] },
        { type: 'taskList', attrs: { localId: 't0' }, content: [{ type: 'taskItem', attrs: { localId: 't1', state: 'DONE' }, content: [{ type: 'text', text: 'shipped' }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
        { type: 'panel', attrs: { panelType: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }] },
        { type: 'expand', attrs: { title: 'More' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }] },
        { type: 'rule' },
        { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h' }] }] }] }] },
        { type: 'mediaSingle', attrs: { layout: 'center', width: 400 }, content: [{ type: 'media', attrs: { id: 'u-1', type: 'file', collection: '', alt: 'shot.png' } }] },
      ],
    };
    expect(editable(doc)).toBe(true);
    expect(normalizeAdf(pmToAdf(adfToPm(doc)))).toEqual(normalizeAdf(doc));
  });

  it('keeps a field holding a node it does not know read-only', () => {
    expect(editable({ type: 'doc', version: 1, content: [{ type: 'extension', attrs: { extensionKey: 'jira-chart' } }] })).toBe(false);
    expect(editable({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'annotation', attrs: { id: 'a' } }] }] }] })).toBe(false);
    expect(editable('plain text from an old API')).toBe(false);
    expect(editable(null)).toBe(true);
  });

  it('writes what the editor makes as ADF Jira takes: a heading with its level, a new table without stray attributes', () => {
    const p = (t: string) => schema.nodes.paragraph!.create(null, schema.text(t));
    const cell = (type: 'table_cell' | 'table_header', t: string) => schema.nodes[type]!.create(null, p(t));
    const made = schema.nodes.doc!.create(null, [
      schema.nodes.heading!.create({ level: 3 }, schema.text('New')),
      schema.nodes.table!.create(null, [schema.nodes.table_row!.create(null, [cell('table_header', 'a'), cell('table_header', 'b')]), schema.nodes.table_row!.create(null, [cell('table_cell', '1'), cell('table_cell', '2')])]),
    ]);
    expect(pmToAdf(made)).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'New' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] }] },
          ],
        },
      ],
    });
    // An empty field becomes one empty paragraph to type in, and an empty editor an empty document.
    expect(adfToPm(null).toJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph', attrs: { adf: null } }] });
  });
});
