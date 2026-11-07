// A Jira Cloud issue, as /rest/api/3/search/jql returns it, mapped to the contract's Ticket.
import type { Priority, Ticket, TicketStatus, TicketType } from '@elfoqsy/contracts';
import { adfToText } from './adf';

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface MapOptions {
  storyPointsField: string;
  sprintField: string;
}

/** Fields the search asks for; nothing else is fetched. */
export const jiraFields = (o: MapOptions): string[] => [
  'summary',
  'issuetype',
  'status',
  'priority',
  'project',
  'reporter',
  'created',
  'updated',
  'labels',
  'issuelinks',
  'description',
  'parent',
  'assignee',
  o.storyPointsField,
  o.sprintField,
];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Status names first, case-insensitive, then Jira's status category. SHOP has OPEN, IN PROGRESS,
 * BLOCKED, WORK-DONE, RELEASED and CLOSE - CANCELLED; Jira files the last one under Done, so the
 * name has to win.
 */
export function mapStatus(name: string, categoryKey: string | undefined): TicketStatus {
  const n = name.toLowerCase();
  if (n.includes('cancel') || n.includes("won't do") || n.includes('wont do') || n.includes('rejected')) return 'Cancelled';
  if (n.includes('blocked')) return 'Blocked';
  if (n.includes('released')) return 'Released';
  if (categoryKey === 'done') return 'Done';
  if (categoryKey === 'indeterminate') return 'In progress';
  return 'To do';
}

export function mapPriority(name: string | undefined): Priority {
  switch ((name ?? '').toLowerCase()) {
    case 'blocker':
    case 'highest':
      return 'Blocker';
    case 'critical':
    case 'high':
      return 'Critical';
    case 'major':
    case 'medium':
      return 'Major';
    default:
      return 'Minor';
  }
}

export function mapType(name: string | undefined, subtask: boolean): TicketType {
  if (subtask) return 'Sub-task';
  switch ((name ?? '').toLowerCase()) {
    case 'bug':
      return 'Bug';
    case 'story':
      return 'Story';
    case 'epic':
      return 'Epic';
    default:
      return 'Task';
  }
}

interface Sprint {
  name: string;
  state: string;
}

/** Sprint field values: objects in REST v3, the old serialized strings just in case. */
export function sprintsOf(value: unknown): Sprint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s): Sprint[] => {
    if (typeof s === 'string') {
      const name = /name=([^,\]]*)/.exec(s)?.[1];
      const state = /state=([^,\]]*)/.exec(s)?.[1];
      return name ? [{ name, state: (state ?? '').toLowerCase() }] : [];
    }
    const o = obj(s);
    const name = str(o.name);
    return name ? [{ name, state: (str(o.state) ?? '').toLowerCase() }] : [];
  });
}

// Jira's own short months ("12 Sep 2025"); en-GB in Node would print "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const formatDate = (iso: string | undefined): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

export function mapIssue(issue: JiraIssue, o: MapOptions): Ticket {
  const f = issue.fields;
  const status = obj(f.status);
  const issuetype = obj(f.issuetype);
  const sprints = sprintsOf(f[o.sprintField]);
  const current = sprints.find((s) => s.state === 'active') ?? sprints.find((s) => s.state === 'future') ?? sprints.at(-1);
  const parent = obj(f.parent);
  const parentFields = obj(parent.fields);
  const parentType = obj(parentFields.issuetype);
  const isEpicParent = str(parentType.name)?.toLowerCase() === 'epic' || parentType.hierarchyLevel === 1;
  const points = f[o.storyPointsField];
  const links = Array.isArray(f.issuelinks) ? f.issuelinks.map(obj) : [];

  return {
    key: issue.key,
    board: str(obj(f.project).key) ?? issue.key.split('-')[0] ?? '',
    summary: str(f.summary) ?? '',
    type: mapType(str(issuetype.name), issuetype.subtask === true),
    status: mapStatus(str(status.name) ?? '', str(obj(status.statusCategory).key)),
    priority: mapPriority(str(obj(f.priority).name)),
    storyPoints: typeof points === 'number' && Number.isFinite(points) ? points : null,
    sprint: current?.name ?? '',
    // Sprints the ticket has been in: the closed ones plus the current one.
    sprintsCarried: Math.max(1, sprints.filter((s) => s.state === 'closed' || s.state === 'active').length),
    epic: isEpicParent && str(parent.key) ? `${str(parentFields.summary) ?? ''} (${str(parent.key)})`.trim() : null,
    reporter: str(obj(f.reporter).displayName) ?? '',
    created: formatDate(str(f.created)),
    updated: formatDate(str(f.updated)),
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [],
    linked: [
      ...new Set(
        links.flatMap((l) => [str(obj(l.outwardIssue).key), str(obj(l.inwardIssue).key)]).filter((k): k is string => !!k),
      ),
    ],
    description: adfToText(f.description),
    ...(str(status.name) ? { workflowStatus: { name: str(status.name)!, category: categoryKey(str(obj(status.statusCategory).key)) } } : {}),
    ...(str(obj(f.assignee).displayName) ? { assignee: str(obj(f.assignee).displayName)! } : {}),
    ...(str(f.updated) ? { updatedAt: str(f.updated)! } : {}),
  };
}

const categoryKey = (key: string | undefined): 'new' | 'indeterminate' | 'done' => (key === 'done' || key === 'indeterminate' ? key : 'new');
