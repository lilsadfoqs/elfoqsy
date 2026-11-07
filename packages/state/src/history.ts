// A ticket's history as the ticket view shows it: the noise left out, Rank and the automation's own changes
// (Automation for Jira, timestamps and other hidden fields); consecutive changes by the same person on the same day
// as one entry; a long text field's change named ("changed Acceptance criteria") with its diff on request, not both
// full texts.
import type { JiraFieldSchema, JiraHistory, JiraUser } from '@elfoqsy/contracts';
import { isHiddenField, isRichText, jiraDate, jiraTime, type JiraFieldIds } from './jira';

export interface HistoryChange {
  field: string;
  from: string;
  to: string;
  /** A long text: shown as "changed <field>" with a diff to open. */
  long: boolean;
}
export interface HistoryGroup {
  /** The first change's id. */
  id: string;
  by: string;
  /** Its day, as the view writes dates. */
  day: string;
  /** The latest change in it. */
  at: string;
  changes: HistoryChange[];
}

/** Jira's own names for its system fields in the changelog. */
const SYSTEM_NAMES: Record<string, string> = {
  description: 'Description',
  summary: 'Title',
  assignee: 'Assignee',
  reporter: 'Reporter',
  priority: 'Priority',
  status: 'Status',
  labels: 'Labels',
  resolution: 'Resolution',
  duedate: 'Due date',
  environment: 'Environment',
  Link: 'Linked work item',
  RemoteWorkItemLink: 'Remote link',
  timeestimate: 'Remaining estimate',
  timespent: 'Time spent',
  timeoriginalestimate: 'Original estimate',
  WorklogId: 'Work log',
};
/** Longer than this, or on more than one line, a value is a long text. */
export const LONG_TEXT = 80;

/** Automation, not a person: Jira's apps ("Automation for Jira") and bots. */
export const isAutomation = (author?: JiraUser & { accountType?: string }): boolean =>
  author?.accountType === 'app' || /^automation for jira$/i.test(author?.displayName ?? '') || /\b(bot|automation)\b/i.test(author?.displayName ?? '');

export function historyGroups(history: JiraHistory[], d: { names: Record<string, string>; schema: Record<string, JiraFieldSchema> }, ids: JiraFieldIds): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const h of [...history].sort((a, b) => jiraTime(a.created) - jiraTime(b.created))) {
    if (isAutomation(h.author)) continue;
    const changes = h.items
      .filter((i) => !isHiddenField(i.fieldId ?? '', i.field, ids) && !isHiddenField(i.fieldId ?? '', d.names[i.fieldId ?? ''], ids))
      .map((i): HistoryChange => {
        const from = i.fromString ?? '';
        const to = i.toString ?? '';
        const schema = i.fieldId ? d.schema[i.fieldId] : undefined;
        const long = isRichText(schema) || i.fieldId === 'description' || [from, to].some((v) => v.length > LONG_TEXT || v.includes('\n'));
        return { field: (i.fieldId && d.names[i.fieldId]) || SYSTEM_NAMES[i.field] || i.field, from, to, long };
      });
    if (!changes.length) continue;
    const by = h.author?.displayName ?? 'Someone';
    const day = jiraDate(h.created);
    const last = groups.at(-1);
    if (last && last.by === by && last.day === day) {
      last.changes.push(...changes);
      last.at = h.created;
    } else groups.push({ id: h.id, by, day, at: h.created, changes });
  }
  return groups.reverse();
}

export interface DiffLine {
  sign: ' ' | '-' | '+' | '…';
  text: string;
}

/**
 * Line by line, what was removed and what was added, with a little unchanged context around each change; runs of
 * unchanged lines beyond it become one "…". Very long texts fall back to all of the old, then all of the new.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let rows: DiffLine[];
  if (a.length * b.length > 250_000) rows = [...a.map((text) => ({ sign: '-' as const, text })), ...b.map((text) => ({ sign: '+' as const, text }))];
  else {
    // Longest common subsequence, from the end.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    rows = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) rows.push({ sign: ' ', text: a[i++]! }), j++;
      // What went comes before what came.
      else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) rows.push({ sign: '-', text: a[i++]! });
      else rows.push({ sign: '+', text: b[j++]! });
    }
  }
  const changed = rows.map((r) => r.sign !== ' ');
  const near = (k: number) => changed.some((c, n) => c && Math.abs(n - k) <= context);
  const out: DiffLine[] = [];
  rows.forEach((r, k) => {
    if (r.sign !== ' ' || near(k)) out.push(r);
    else if (out.at(-1)?.sign !== '…') out.push({ sign: '…', text: '' });
  });
  return out;
}
