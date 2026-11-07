// A ticket as Jira holds it, shared by the screens and the daemon so that what alex sees and what Elfoqsy
// reads are the same: the layout's fields by role, which fields are facts, rich text, other fields or hidden, a
// detail patch applied to what the log already has, and any field's value as text (rich text as Markdown).
import type {
  JiraComment,
  JiraEditMeta,
  JiraFieldChange,
  JiraFieldRole,
  JiraFieldSchema,
  JiraHistory,
  JiraRemoteLink,
  JiraStatusCategory,
  PayloadOf,
} from '@elfoqsy/contracts';

/** The layout's fields on acme.atlassian.net (found on SHOP-3538 and SHOP-2430); config/jira-fields.json overrides. */
export const DEFAULT_JIRA_FIELDS: Record<JiraFieldRole, { name: string; id: string }> = {
  storyPoints: { name: 'Story point estimate', id: 'customfield_16486' },
  acceptanceCriteria: { name: 'Acceptance criteria', id: 'customfield_16728' },
  solution: { name: 'Solution', id: 'customfield_16727' },
  impact: { name: 'Impact', id: 'customfield_17581' },
  design: { name: 'Design', id: 'customfield_17460' },
  rootCause: { name: 'Root cause description', id: 'customfield_16595' },
  failedAc: { name: 'Failed Acceptance Criteria', id: 'customfield_17566' },
  sprint: { name: 'Sprint', id: 'customfield_10521' },
  qaAssignee: { name: 'QA Assignee', id: 'customfield_17282' },
  reviewer: { name: 'Reviewer', id: 'customfield_17564' },
  qaPoints: { name: 'QA Story point estimate', id: 'customfield_29369' },
  flagged: { name: 'Flagged', id: 'customfield_10000' },
  development: { name: 'Development', id: 'customfield_13320' },
};

export type JiraFieldIds = Record<JiraFieldRole, string>;
export const fieldIdsOf = (fields?: Partial<Record<JiraFieldRole, { id: string }>>): JiraFieldIds =>
  Object.fromEntries(Object.entries(DEFAULT_JIRA_FIELDS).map(([role, f]) => [role, fields?.[role as JiraFieldRole]?.id ?? f.id])) as JiraFieldIds;

/** A layout slot: a system field by id, or a role from the field map. */
type Slot = { id: string } | { role: JiraFieldRole };

/** The two columns of facts, in order; empty ones fold into "N empty fields" when the ticket's edit screen has them. */
export const FACT_SLOTS: Slot[] = [
  { id: 'assignee' },
  { id: 'reporter' },
  { role: 'sprint' },
  { id: 'labels' },
  { id: 'fixVersions' },
  { id: 'components' },
  { role: 'qaAssignee' },
  { role: 'reviewer' },
  { id: 'duedate' },
  { role: 'qaPoints' },
  { role: 'failedAc' },
];

/** Rich-text sections, in order; the bug ones only on bugs. Design is shown here but is not text on this site. */
export const RICH_SLOTS: JiraFieldRole[] = ['solution', 'impact', 'acceptanceCriteria', 'design'];
export const BUG_RICH_SLOTS: JiraFieldRole[] = ['rootCause'];

/** Fields shown in the header or their own section, never under Other fields. */
const SHOWN_ELSEWHERE = new Set([
  'summary',
  'status',
  'priority',
  'issuetype',
  'project',
  'parent',
  'created',
  'updated',
  'creator',
  'description',
  'issuelinks',
  'subtasks',
  'attachment',
  'comment',
  'worklog',
  'watches',
  'votes',
  'timetracking',
  'resolutiondate',
]);

/** Automation and internal fields: never shown. Development is replaced by the workspace's own GitHub data. */
const HIDDEN_IDS = new Set(['statuscategorychangedate', 'lastViewed', 'workratio', 'issuerestriction', 'statusCategory', 'progress', 'aggregateprogress']);
const HIDDEN_NAMES = [/^Rank$/i, /^Time taken at /i, /^Entered /i, /^(Start|End) Ticket Timestamp$/i, /^Circle Time Recorded$/i, /checklist/i, /^aggregate/i, /^Σ /];

export const slotId = (slot: Slot, ids: JiraFieldIds): string => ('id' in slot ? slot.id : ids[slot.role]);

export function isHiddenField(id: string, name: string | undefined, ids: JiraFieldIds): boolean {
  if (HIDDEN_IDS.has(id) || id.startsWith('aggregate') || id === ids.development) return true;
  return HIDDEN_NAMES.some((re) => re.test(name ?? ''));
}

/** Jira's empty: null, "", [], {}, and the Development field's "{}". */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '' || v === '{}') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'doc') return !Array.isArray(o.content) || o.content.length === 0;
    return Object.keys(o).length === 0;
  }
  return false;
}

/** The ticket as the screens hold it, folded from ticket.detail. */
export interface TicketDetailView {
  key: string;
  id: string;
  fields: Record<string, unknown>;
  names: Record<string, string>;
  schema: Record<string, JiraFieldSchema>;
  editmeta: Record<string, JiraEditMeta>;
  comments: JiraComment[];
  history: JiraHistory[];
  remoteLinks: JiraRemoteLink[];
  confluence: Record<string, string>;
  locked: string[];
  /** The latest read's changes by others, with when they were seen (for the few seconds' mark). */
  changes: Array<JiraFieldChange & { seenAt: number }>;
  updated: string;
  fetchedAt: number;
}

export const HISTORY_KEPT = 100;

/** How long a change by someone else stays marked on the screens. */
export const CHANGE_MARK_MS = 8000;

/** What others changed on a ticket in the last few seconds, for its mark: "Quinn Bauer: Priority". */
export function recentChange(d: TicketDetailView | undefined, now: number): { by: string; names: string[] } | null {
  const recent = (d?.changes ?? []).filter((c) => now - c.seenAt < CHANGE_MARK_MS);
  if (!recent.length) return null;
  return { by: recent[0]!.by, names: [...new Set(recent.map((c) => c.name))] };
}

/** A detail event applied to what was there: a snapshot replaces it, a patch changes only what it names. */
export function applyDetail(prev: TicketDetailView | undefined, p: PayloadOf<'ticket.detail'>, seenAt: number): TicketDetailView {
  const base: TicketDetailView =
    p.full || !prev
      ? { key: p.key, id: p.id, fields: {}, names: {}, schema: {}, editmeta: {}, comments: [], history: [], remoteLinks: [], confluence: {}, locked: [], changes: [], updated: p.updated, fetchedAt: seenAt }
      : prev;
  const fields = { ...base.fields, ...(p.fields ?? {}) };
  for (const id of p.removed ?? []) delete fields[id];
  const known = new Set(base.history.map((h) => h.id));
  return {
    ...base,
    id: p.id,
    fields,
    names: p.names ?? base.names,
    schema: p.schema ?? base.schema,
    editmeta: p.editmeta ?? base.editmeta,
    comments: p.comments ?? base.comments,
    history: [...base.history, ...(p.history ?? []).filter((h) => !known.has(h.id))].slice(-HISTORY_KEPT),
    remoteLinks: p.remoteLinks ?? base.remoteLinks,
    confluence: { ...base.confluence, ...(p.confluence ?? {}) },
    locked: p.locked ?? base.locked,
    changes: p.changes ? p.changes.map((c) => ({ ...c, seenAt })) : base.changes,
    updated: p.updated,
    fetchedAt: Date.parse(p.fetchedAt) || seenAt,
  };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Jira's own short months ("8 Oct 2026"), in local time. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function jiraDate(iso: string | undefined, withTime = false): string {
  if (!iso) return '';
  // A date alone ("2026-10-20") is that day wherever you are.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (plain) return `${Number(plain[3])} ${MONTHS[Number(plain[2]) - 1]} ${plain[1]}`;
  const t = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${day}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day;
}

export const jiraTime = (iso: string | undefined): number => (iso ? Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN);

/** Whether a field holds rich text (ADF): Description and the textarea custom fields. */
export const isRichText = (schema: JiraFieldSchema | undefined, value?: unknown): boolean =>
  (schema?.type === 'string' && (schema.system === 'description' || schema.system === 'environment' || !!schema.custom?.endsWith(':textarea'))) || obj(value).type === 'doc';

/** Seconds of logged or estimated time as Jira writes them: 1w 2d 3h 30m (a week of 5 days, days of 8 hours). */
export function durationText(seconds: number): string {
  const units: Array<[string, number]> = [['w', 5 * 8 * 3600], ['d', 8 * 3600], ['h', 3600], ['m', 60]];
  const parts: string[] = [];
  let left = Math.max(0, Math.round(seconds));
  for (const [u, n] of units) {
    if (left >= n) {
      parts.push(`${Math.floor(left / n)}${u}`);
      left %= n;
    }
  }
  return parts.join(' ') || '0m';
}

const TIME_FIELDS = new Set(['timespent', 'timeestimate', 'timeoriginalestimate']);

/** One value as a short line: users by name, options by value, sprints, versions, dates. */
export function valueText(value: unknown, schema?: JiraFieldSchema): string {
  if (isEmptyValue(value)) return '';
  if (typeof value === 'number' && schema?.system && TIME_FIELDS.has(schema.system)) return durationText(value);
  if (Array.isArray(value)) return value.map((v) => valueText(v, schema?.items ? { type: schema.items } : undefined)).filter(Boolean).join(', ');
  if (typeof value === 'string') {
    if (schema?.type === 'date') return jiraDate(value);
    if (schema?.type === 'datetime') return jiraDate(value, true);
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const o = obj(value);
  if (o.type === 'doc') return adfToMarkdown(o);
  const named = str(o.displayName) ?? str(o.name) ?? str(o.value) ?? str(o.key);
  if (named) {
    const child = obj(o.child);
    return str(child.value) ? `${named} / ${str(child.value)}` : named;
  }
  return JSON.stringify(value).slice(0, 200);
}

/** The sprint a ticket is in now (active, else the next), with its goal. */
export function currentSprint(value: unknown): { name: string; goal?: string } | null {
  const sprints = Array.isArray(value) ? value.map(obj) : [];
  const s = sprints.find((x) => x.state === 'active') ?? sprints.find((x) => x.state === 'future') ?? sprints.at(-1);
  if (!s || !str(s.name)) return null;
  return { name: str(s.name)!, ...(str(s.goal) ? { goal: str(s.goal)!.trim() } : {}) };
}

export interface LinkedItem {
  key: string;
  summary: string;
  status: string;
  category: JiraStatusCategory;
  priority: string;
  type: string;
  linkId?: string;
  assignee?: string;
}

/** Linked work items grouped by link type in Jira's wording ("is blocked by", "relates to"), in Jira's order. */
export function linkGroups(d: TicketDetailView): Array<{ relation: string; items: LinkedItem[] }> {
  const groups = new Map<string, LinkedItem[]>();
  for (const l of Array.isArray(d.fields.issuelinks) ? d.fields.issuelinks.map(obj) : []) {
    const type = obj(l.type);
    const outward = obj(l.outwardIssue);
    const other = Object.keys(outward).length ? outward : obj(l.inwardIssue);
    const relation = Object.keys(outward).length ? str(type.outward) : str(type.inward);
    if (!relation || !str(other.key)) continue;
    const f = obj(other.fields);
    const status = obj(f.status);
    const item: LinkedItem = {
      key: str(other.key)!,
      summary: str(f.summary) ?? '',
      status: str(status.name) ?? '',
      category: categoryOf(status),
      priority: str(obj(f.priority).name) ?? '',
      type: str(obj(f.issuetype).name) ?? '',
      ...(str(l.id) ? { linkId: str(l.id)! } : {}),
      ...(str(obj(f.assignee).displayName) ? { assignee: str(obj(f.assignee).displayName)! } : {}),
    };
    groups.set(relation, [...(groups.get(relation) ?? []), item]);
  }
  return [...groups].map(([relation, items]) => ({ relation, items }));
}

/**
 * A workflow status chip's colour, by Jira's category: grey for To Do, blue for In Progress, green for Done, except a
 * done status that means it was dropped (DROPPED, CLOSE - CANCELLED, Won't Do), which stays grey. A design token.
 */
export function statusToken(name: string, category: JiraStatusCategory): string {
  if (category === 'indeterminate') return '--status-in-progress';
  if (category === 'done') return /cancel|drop|won.?t do|reject|duplicate|invalid/i.test(name) ? '--status-todo' : '--status-done';
  return '--status-todo';
}

/** "Quinn Bauer" → "TH", for a person's round badge. */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('') || '?';

/** Jira's issue type as the workspace's five, for its icon (a Test is a Task, a Subtask a Sub-task). */
export function ticketTypeOf(issuetype: unknown): 'Story' | 'Task' | 'Bug' | 'Epic' | 'Sub-task' {
  const t = obj(issuetype);
  if (t.subtask === true) return 'Sub-task';
  const name = (str(t.name) ?? '').toLowerCase();
  return name === 'bug' ? 'Bug' : name === 'story' ? 'Story' : name === 'epic' ? 'Epic' : name.includes('sub') ? 'Sub-task' : 'Task';
}

export const categoryOf = (status: unknown): JiraStatusCategory => {
  const key = str(obj(obj(status).statusCategory).key);
  return key === 'done' || key === 'indeterminate' ? key : 'new';
};

/** "Blocked by N": links that say "is blocked by" and are not done. */
export const blockedBy = (d: TicketDetailView): number =>
  linkGroups(d)
    .filter((g) => /is blocked by/i.test(g.relation))
    .flatMap((g) => g.items)
    .filter((i) => i.category !== 'done').length;

export interface DetailLayout {
  facts: Array<{ id: string; name: string }>;
  emptyFacts: Array<{ id: string; name: string }>;
  rich: Array<{ id: string; name: string; role: JiraFieldRole | 'description' }>;
  other: Array<{ id: string; name: string }>;
}

/** Where each field goes in the ticket view, and what Elfoqsy reads in the same order. */
export function detailLayout(d: TicketDetailView, ids: JiraFieldIds): DetailLayout {
  const name = (id: string) => d.names[id] ?? id;
  const isBug = /bug/i.test(str(obj(d.fields.issuetype).name) ?? '');
  const factIds = FACT_SLOTS.map((s) => slotId(s, ids));
  const richRoles: Array<JiraFieldRole | 'description'> = ['description', ...RICH_SLOTS, ...(isBug ? BUG_RICH_SLOTS : [])];
  const richIds = richRoles.map((r) => (r === 'description' ? 'description' : ids[r]));
  const facts = factIds.filter((id) => !isEmptyValue(d.fields[id])).map((id) => ({ id, name: name(id) }));
  const emptyFacts = factIds.filter((id) => isEmptyValue(d.fields[id]) && d.editmeta[id]).map((id) => ({ id, name: name(id) }));
  // Rich sections show when they hold text or can be given some on this ticket.
  const rich = richRoles
    .map((role, i) => ({ id: richIds[i]!, name: role === 'description' ? 'Description' : name(richIds[i]!), role }))
    .filter((r) => r.role === 'description' || !isEmptyValue(d.fields[r.id]) || d.editmeta[r.id]);
  const placed = new Set([...factIds, ...richIds, ids.storyPoints, ids.flagged, ids.development]);
  const other = Object.keys(d.fields)
    .filter((id) => !placed.has(id) && !SHOWN_ELSEWHERE.has(id) && !isHiddenField(id, d.names[id], ids) && !isEmptyValue(d.fields[id]))
    .map((id) => ({ id, name: name(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { facts, emptyFacts, rich, other };
}

// ADF as Markdown, for Elfoqsy and the agents: headings, marks, lists, tables, code, panels, mentions and links kept.

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

const attrStr = (n: AdfNode, k: string): string | undefined => (typeof n.attrs?.[k] === 'string' ? (n.attrs[k] as string) : undefined);

function inlineMd(n: AdfNode): string {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strong') t = `**${t}**`;
        else if (m.type === 'em') t = `*${t}*`;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link' && typeof m.attrs?.href === 'string') t = t === m.attrs.href ? t : `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attrStr(n, 'text') ?? '@someone';
    case 'emoji':
      return attrStr(n, 'text') ?? attrStr(n, 'shortName') ?? '';
    case 'inlineCard':
      return attrStr(n, 'url') ?? '';
    case 'status':
      return `[${attrStr(n, 'text') ?? ''}]`;
    case 'date': {
      const ts = Number(attrStr(n, 'timestamp'));
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'media':
      return `[file: ${attrStr(n, 'alt') ?? 'attachment'}]`;
    default:
      return (n.content ?? []).map(inlineMd).join('');
  }
}

function blockMd(n: AdfNode, indent = ''): string {
  const inner = (sep = '\n\n') => (n.content ?? []).map((c) => blockMd(c, indent)).filter((t) => t.trim()).join(sep);
  switch (n.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(6, Number(n.attrs?.level) || 2))} ${inlineMd(n)}`;
    case 'paragraph':
      return `${indent}${inlineMd(n)}`;
    case 'bulletList':
    case 'orderedList':
      return (n.content ?? [])
        .map((item, i) => {
          const marker = n.type === 'orderedList' ? `${i + 1}. ` : '- ';
          const body = (item.content ?? []).map((c) => blockMd(c, `${indent}   `)).join('\n');
          return `${indent}${marker}${body.trimStart()}`;
        })
        .join('\n');
    case 'taskList':
      return (n.content ?? []).map((item) => `${indent}- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${inlineMd(item)}`).join('\n');
    case 'codeBlock':
      return `\`\`\`${attrStr(n, 'language') ?? ''}\n${(n.content ?? []).map(inlineMd).join('')}\n\`\`\``;
    case 'blockquote':
      return inner().split('\n').map((l) => `> ${l}`).join('\n');
    case 'panel':
      return `${(attrStr(n, 'panelType') ?? 'info').replace(/^./, (c) => c.toUpperCase())}: ${inner('\n')}`;
    case 'expand':
    case 'nestedExpand':
      return `${attrStr(n, 'title') ?? 'Details'}:\n${inner()}`;
    case 'rule':
      return '---';
    case 'table': {
      const rows = (n.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => (cell.content ?? []).map((c) => blockMd(c)).join(' ').replace(/\n/g, ' ').trim()).join(' | ')} |`);
      if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat((n.content?.[0]?.content ?? []).length)}`);
      return rows.join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map(inlineMd).join(' ');
    case 'blockCard':
    case 'embedCard':
      return attrStr(n, 'url') ?? '';
    default:
      return n.content?.length ? inner() : inlineMd(n);
  }
}

/** ADF as Markdown; a plain string passes through. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  const root = obj(doc) as unknown as AdfNode;
  return (root.content ?? [])
    .map((n) => blockMd(n))
    .filter((t) => t.trim())
    .join('\n\n')
    .trim();
}

/** The ticket's Acceptance criteria field as text (rich text as Markdown); undefined when it was not read or is empty. */
export function acceptanceCriteriaText(d: TicketDetailView | undefined, ids: JiraFieldIds): string | undefined {
  if (!d) return undefined;
  const text = valueText(d.fields[ids.acceptanceCriteria], d.schema[ids.acceptanceCriteria]).trim();
  return text || undefined;
}

/**
 * The whole ticket as text for Elfoqsy and the agents, in the view's order: every named field with a value, the rich
 * text as Markdown, links, sub-tasks, Confluence pages, attachments, comments and the latest history.
 */
export function detailText(d: TicketDetailView, ids: JiraFieldIds, site: string): string {
  const f = d.fields;
  const layout = detailLayout(d, ids);
  const status = obj(f.status);
  const parent = obj(f.parent);
  const lines: string[] = [
    `${d.key}  ${valueText(f.issuetype)}  ${str(status.name) ?? ''}  ${valueText(f.priority)}${isEmptyValue(f[ids.storyPoints]) ? '' : `  ${valueText(f[ids.storyPoints])} pt`}`,
    valueText(f.summary),
    `${site.replace(/\/$/, '')}/browse/${d.key}`,
    ...(str(parent.key) ? [`Parent: ${str(parent.key)} ${str(obj(parent.fields).summary) ?? ''}`.trim()] : []),
    ...(str(f.created) ? [`Created ${jiraDate(str(f.created))}${valueText(f.creator) ? ` by ${valueText(f.creator)}` : ''} · Updated ${jiraDate(str(f.updated))}`] : []),
    '',
  ];
  // A long section is cut on its own, so one huge Description never pushes out the links and comments.
  const part = (t: string, max = 8000) => (t.length > max ? `${t.slice(0, max)} [cut]` : t);
  for (const fact of layout.facts) {
    const sprint = fact.id === ids.sprint ? currentSprint(f[fact.id]) : null;
    lines.push(`${fact.name}: ${sprint ? `${sprint.name}${sprint.goal ? ` (goal: ${sprint.goal})` : ''}` : valueText(f[fact.id], d.schema[fact.id])}`);
  }
  if (layout.emptyFacts.length) lines.push(`Empty: ${layout.emptyFacts.map((x) => x.name).join(', ')}`);
  for (const r of layout.rich) {
    const v = f[r.id];
    lines.push('', `## ${r.name}`, isEmptyValue(v) ? '(empty)' : part(isRichText(d.schema[r.id], v) ? adfToMarkdown(v) : valueText(v, d.schema[r.id])));
  }
  if (layout.other.length) lines.push('', '## Other fields', ...layout.other.map((o) => `${o.name}: ${valueText(f[o.id], d.schema[o.id])}`));
  const subtasks = Array.isArray(f.subtasks) ? f.subtasks.map(obj) : [];
  if (subtasks.length) lines.push('', '## Sub-tasks', ...subtasks.map((s) => `- ${str(s.key)} ${str(obj(obj(s.fields).status).name) ?? ''}: ${str(obj(s.fields).summary) ?? ''}`));
  const groups = linkGroups(d);
  if (groups.length) lines.push('', '## Linked work items', ...groups.flatMap((g) => g.items.map((i) => `- ${g.relation} ${i.key} (${i.status}, ${i.priority}): ${i.summary}`)));
  const pages = d.remoteLinks.filter((l) => /confluence/i.test(l.application ?? ''));
  if (pages.length) lines.push('', '## Confluence', ...pages.map((p) => `- ${p.title} (${p.relationship ?? 'linked'}): ${p.url}`));
  const files = Array.isArray(f.attachment) ? f.attachment.map(obj) : [];
  if (files.length) lines.push('', '## Attachments', ...files.map((a) => `- ${str(a.filename)} (${valueText(a.size)} bytes, ${valueText(a.author)})`));
  if (d.comments.length) {
    lines.push('', `## Comments (${d.comments.length})`);
    for (const c of d.comments) lines.push(`- ${c.author?.displayName ?? 'someone'}, ${jiraDate(c.created, true)}: ${part(adfToMarkdown(c.body), 3000).replace(/\n/g, '\n  ')}`);
  }
  const recent = d.history.slice(-30);
  if (recent.length) {
    lines.push('', '## History (latest)');
    for (const h of recent) for (const i of h.items) lines.push(`- ${jiraDate(h.created, true)} ${h.author?.displayName ?? 'someone'}: ${i.field} ${i.fromString ?? ''} → ${i.toString ?? ''}`.replace(/\s+→/, ' →'));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
