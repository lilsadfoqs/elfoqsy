// Jira's rich text in the editor: a ProseMirror schema whose nodes are ADF's own, and the conversion both ways.
// Every node keeps the attributes it came with (localId and the like) in `adf`, so what the editor does not touch goes
// back to Jira unchanged. A document holding any node outside this schema is not edited here: the field opens
// read-only with "Edit in Jira", rather than risk losing what it holds.
import { Fragment, Mark, Node as PMNode, Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

const adfAttr = { adf: { default: null } };

/** An inline node the editor keeps as it is: shown as its text, moved and deleted whole. */
const atom = (type: string, show: (attrs: Record<string, unknown>) => string): NodeSpec => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { ...adfAttr },
  toDOM: (n) => ['span', { class: `pm-atom pm-${type}`, contenteditable: 'false' }, show((n.attrs.adf ?? {}) as Record<string, unknown>)],
});

const tables = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: { adf: { default: null, getFromDOM: () => null, setDOMAttr: () => undefined } } });

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'inline*', attrs: { ...adfAttr }, toDOM: () => ['p', 0] },
  heading: { group: 'block', content: 'inline*', defining: true, attrs: { level: { default: 2 }, ...adfAttr }, toDOM: (n) => [`h${Math.min(6, Number(n.attrs.level) + 1)}`, { class: `adf-h adf-h${n.attrs.level}` }, 0] },
  bulletList: { group: 'block', content: 'listItem+', attrs: { ...adfAttr }, toDOM: () => ['ul', 0] },
  orderedList: { group: 'block', content: 'listItem+', attrs: { order: { default: 1 }, ...adfAttr }, toDOM: (n) => ['ol', { start: n.attrs.order }, 0] },
  listItem: { content: 'block+', defining: true, attrs: { ...adfAttr }, toDOM: () => ['li', 0] },
  taskList: { group: 'block', content: '(taskItem | taskList)+', attrs: { ...adfAttr }, toDOM: () => ['ul', { class: 'adf-tasks' }, 0] },
  taskItem: { content: 'inline*', attrs: { state: { default: 'TODO' }, ...adfAttr }, toDOM: (n) => ['li', { class: `adf-task${n.attrs.state === 'DONE' ? ' adf-task--done' : ''}` }, 0] },
  decisionList: { group: 'block', content: 'decisionItem+', attrs: { ...adfAttr }, toDOM: () => ['ul', { class: 'adf-tasks' }, 0] },
  decisionItem: { content: 'inline*', attrs: { ...adfAttr }, toDOM: () => ['li', 0] },
  blockquote: { group: 'block', content: 'block+', defining: true, attrs: { ...adfAttr }, toDOM: () => ['blockquote', { class: 'adf-quote' }, 0] },
  codeBlock: { group: 'block', content: 'text*', marks: '', code: true, defining: true, attrs: { language: { default: null }, ...adfAttr }, toDOM: () => ['pre', { class: 'adf-code' }, ['code', 0]] },
  rule: { group: 'block', attrs: { ...adfAttr }, toDOM: () => ['hr'] },
  panel: { group: 'block', content: 'block+', defining: true, attrs: { panelType: { default: 'info' }, ...adfAttr }, toDOM: (n) => ['div', { class: `pm-panel pm-panel--${n.attrs.panelType}` }, 0] },
  expand: { group: 'block', content: 'block+', attrs: { title: { default: '' }, ...adfAttr }, toDOM: () => ['div', { class: 'pm-expand' }, 0] },
  nestedExpand: { group: 'block', content: 'block+', attrs: { title: { default: '' }, ...adfAttr }, toDOM: () => ['div', { class: 'pm-expand' }, 0] },
  mediaSingle: { group: 'block', content: 'media', attrs: { ...adfAttr }, toDOM: () => ['div', { class: 'pm-media' }, 0] },
  mediaGroup: { group: 'block', content: 'media+', attrs: { ...adfAttr }, toDOM: () => ['div', { class: 'pm-media' }, 0] },
  media: { atom: true, attrs: { ...adfAttr }, toDOM: (n) => ['span', { class: 'pm-atom', contenteditable: 'false' }, `[${String((n.attrs.adf as { alt?: string } | null)?.alt ?? 'file')}]`] },
  blockCard: { group: 'block', atom: true, attrs: { ...adfAttr }, toDOM: (n) => ['p', { class: 'pm-atom', contenteditable: 'false' }, String((n.attrs.adf as { url?: string } | null)?.url ?? '')] },
  embedCard: { group: 'block', atom: true, attrs: { ...adfAttr }, toDOM: (n) => ['p', { class: 'pm-atom', contenteditable: 'false' }, String((n.attrs.adf as { url?: string } | null)?.url ?? '')] },
  table: { ...tables.table, attrs: { ...(tables.table.attrs ?? {}), ...adfAttr } },
  table_row: { ...tables.table_row, attrs: { ...(tables.table_row.attrs ?? {}), ...adfAttr } },
  table_cell: tables.table_cell,
  table_header: tables.table_header,
  text: { group: 'inline' },
  hardBreak: { group: 'inline', inline: true, selectable: false, attrs: { ...adfAttr }, toDOM: () => ['br'] },
  mention: atom('mention', (a) => String(a.text ?? '@someone')),
  emoji: atom('emoji', (a) => String(a.text ?? a.shortName ?? '')),
  inlineCard: atom('card', (a) => String(a.url ?? '')),
  date: atom('date', (a) => (Number.isFinite(Number(a.timestamp)) ? new Date(Number(a.timestamp)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')),
  status: atom('status', (a) => String(a.text ?? '')),
  mediaInline: atom('file', () => '[file]'),
};

const marks: Record<string, MarkSpec> = {
  link: { attrs: { href: { default: '' }, ...adfAttr }, inclusive: false, toDOM: (m) => ['a', { href: m.attrs.href, rel: 'noreferrer noopener', target: '_blank' }, 0] },
  strong: { attrs: { ...adfAttr }, toDOM: () => ['strong', 0] },
  em: { attrs: { ...adfAttr }, toDOM: () => ['em', 0] },
  strike: { attrs: { ...adfAttr }, toDOM: () => ['s', 0] },
  underline: { attrs: { ...adfAttr }, toDOM: () => ['u', 0] },
  code: { attrs: { ...adfAttr }, toDOM: () => ['code', 0] },
  subsup: { attrs: { ...adfAttr }, toDOM: (m) => [(m.attrs.adf as { type?: string } | null)?.type === 'sup' ? 'sup' : 'sub', 0] },
  textColor: { attrs: { ...adfAttr }, toDOM: () => ['span', 0] },
  backgroundColor: { attrs: { ...adfAttr }, toDOM: () => ['span', 0] },
};

export const schema = new Schema({ nodes, marks });

/** ADF types that are ProseMirror types under another name. */
const TO_PM: Record<string, string> = { tableRow: 'table_row', tableCell: 'table_cell', tableHeader: 'table_header' };
const TO_ADF: Record<string, string> = { table_row: 'tableRow', table_cell: 'tableCell', table_header: 'tableHeader' };

/** The attributes the editor itself changes, by node: the rest stays in adf. */
const EDITED: Record<string, string[]> = { heading: ['level'], orderedList: ['order'], codeBlock: ['language'], taskItem: ['state'], panel: ['panelType'], expand: ['title'], nestedExpand: ['title'] };
const CELL = ['colspan', 'rowspan', 'colwidth'];
/** Attributes ADF requires on a node the editor makes. */
const REQUIRED = new Set(['heading.level', 'taskItem.state', 'panel.panelType']);

/** Every node type a document holds. */
export function typesOf(doc: AdfNode, found = new Set<string>()): Set<string> {
  found.add(doc.type);
  for (const m of doc.marks ?? []) found.add(`mark:${m.type}`);
  for (const c of doc.content ?? []) typesOf(c, found);
  return found;
}

/** Whether the editor can hold this document without losing anything. */
export function editable(doc: unknown): boolean {
  if (doc === null || doc === undefined) return true;
  if (!doc || typeof doc !== 'object' || (doc as AdfNode).type !== 'doc') return false;
  for (const t of typesOf(doc as AdfNode)) {
    if (t.startsWith('mark:')) {
      if (!schema.marks[t.slice(5)]) return false;
    } else if (!schema.nodes[TO_PM[t] ?? t]) return false;
  }
  try {
    adfToPm(doc as AdfNode).check();
    return true;
  } catch {
    return false;
  }
}

function pmMarks(m: AdfNode['marks']): Mark[] {
  return (m ?? []).map((x) => {
    const type = schema.marks[x.type]!;
    return x.type === 'link' ? type.create({ href: String(x.attrs?.href ?? ''), adf: x.attrs ?? null }) : type.create({ adf: x.attrs ?? null });
  });
}

function pmNode(n: AdfNode): PMNode | null {
  if (n.type === 'text') return n.text ? schema.text(n.text, pmMarks(n.marks)) : null;
  const typeName = TO_PM[n.type] ?? n.type;
  const type = schema.nodes[typeName];
  if (!type) throw new Error(`Not editable here: ${n.type}`);
  const a = n.attrs ?? {};
  const attrs: Record<string, unknown> = { adf: n.attrs ?? null };
  for (const k of EDITED[n.type] ?? []) if (a[k] !== undefined) attrs[k] = a[k];
  if (typeName === 'table_cell' || typeName === 'table_header') {
    attrs.colspan = Number(a.colspan) || 1;
    attrs.rowspan = Number(a.rowspan) || 1;
    attrs.colwidth = Array.isArray(a.colwidth) ? a.colwidth : null;
  }
  const kids = (n.content ?? []).map(pmNode).filter((x): x is PMNode => x !== null);
  return type.create(attrs, kids.length ? Fragment.from(kids) : null);
}

/** ADF to the editor's document; throws on a node it cannot hold. An empty field is one empty paragraph. */
export function adfToPm(doc: AdfNode | null | undefined): PMNode {
  if (!doc || !doc.content?.length) return schema.nodes.doc!.create(null, schema.nodes.paragraph!.create());
  return pmNode(doc)!;
}

function adfMarks(marks: readonly Mark[]): AdfNode['marks'] {
  return marks.map((m) => {
    const base = (m.attrs.adf as Record<string, unknown> | null) ?? undefined;
    const attrs = m.type.name === 'link' ? { ...(base ?? {}), href: m.attrs.href } : base;
    return { type: m.type.name, ...(attrs ? { attrs } : {}) };
  });
}

function adfNode(n: PMNode): AdfNode {
  if (n.isText) {
    const marks = adfMarks(n.marks);
    return { type: 'text', text: n.text ?? '', ...(marks?.length ? { marks } : {}) };
  }
  const type = TO_ADF[n.type.name] ?? n.type.name;
  const original = (n.attrs.adf as Record<string, unknown> | null) ?? null;
  let attrs: Record<string, unknown> | null = original ? { ...original } : null;
  for (const k of EDITED[type] ?? []) {
    const v = n.attrs[k];
    // What it came with is written back as the editor left it; a new node gets what ADF requires or what differs.
    const fallback = (n.type.spec.attrs?.[k] as { default?: unknown } | undefined)?.default;
    if ((original && k in original) || REQUIRED.has(`${type}.${k}`) || (v !== fallback && v !== null && v !== undefined)) attrs = { ...(attrs ?? {}), [k]: v };
  }
  if (type === 'tableCell' || type === 'tableHeader') {
    for (const k of CELL) {
      const v = n.attrs[k];
      const isDefault = (k === 'colspan' || k === 'rowspan') ? v === 1 : v === null;
      if (!isDefault) attrs = { ...(attrs ?? {}), [k]: v };
      else if (attrs && k in attrs && !(original && k in original)) delete attrs[k];
    }
  }
  const out: AdfNode = { type };
  if (attrs && Object.keys(attrs).length) out.attrs = attrs;
  if (!n.isLeaf) out.content = n.content.content.map(adfNode);
  return out;
}

/** The editor's document as ADF for Jira. */
export function pmToAdf(doc: PMNode): AdfNode {
  return { type: 'doc', version: 1, content: doc.content.content.map(adfNode) };
}

/**
 * The same document written two ways compares equal: marks in one order, neighbouring text with the same marks joined,
 * empty content and empty attrs left out. Used to check that a round trip loses nothing.
 */
export function normalizeAdf(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(normalizeAdf);
  if (!doc || typeof doc !== 'object') return doc;
  const n = doc as AdfNode & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'content' || k === 'marks') continue;
    if (k === 'attrs' && (!v || !Object.keys(v as object).length)) continue;
    out[k] = normalizeAdf(v);
  }
  if (n.marks?.length) out.marks = [...n.marks].map((m) => normalizeAdf(m)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (n.content?.length) {
    const kids: Array<Record<string, unknown>> = [];
    for (const c of n.content.map((x) => normalizeAdf(x) as Record<string, unknown>)) {
      const prev = kids.at(-1);
      if (prev && prev.type === 'text' && c.type === 'text' && JSON.stringify(prev.marks ?? null) === JSON.stringify(c.marks ?? null)) prev.text = `${String(prev.text)}${String(c.text)}`;
      else if (!(c.type === 'text' && !c.text)) kids.push(c);
    }
    if (kids.length) out.content = kids;
  }
  return out;
}
