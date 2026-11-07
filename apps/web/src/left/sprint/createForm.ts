// His create form's values, and what Create sends (docs/create-ticket.md): fields in Jira's own shape, only those
// on the type's create screen once it is known, and the links to add after. Pure, so the shape is tested on its own.
import type { JiraCreateField, TicketDraft } from '@elfoqsy/contracts';
import { markdownToAdf, type JiraFieldIds } from '@elfoqsy/state';

export interface CreateForm {
  project: string;
  /** The issue type by id once the screen is read; by name until then (a draft's "Bug"). */
  typeId: string;
  typeName: string;
  summary: string;
  description: unknown;
  /** By name, as Jira's priorities are shown; Create sends its id when the screen gives one. */
  priority: string;
  storyPoints: string;
  sprintId: number | null;
  labels: string[];
  assignee: string;
  parent: string;
  links: NonNullable<TicketDraft['links']>;
  /** The screen's other required fields, already in Jira's shape. */
  extra: Record<string, unknown>;
}

const PROJECT = /^[A-Z][A-Z0-9_]+$/;

/** An empty editor is no description. */
export const isEmptyDoc = (doc: unknown): boolean => {
  const d = doc as { content?: Array<{ type: string; content?: unknown[] }> } | null;
  return !d?.content?.length || d.content.every((n) => n.type === 'paragraph' && !n.content?.length);
};

/** The fields this form has a control of its own for; any other required one is asked for below them. */
export const ownFields = (ids: JiraFieldIds): Set<string> => new Set(['project', 'issuetype', 'summary', 'description', 'priority', 'labels', 'assignee', 'reporter', 'issuelinks', 'parent', ids.sprint, ids.storyPoints]);

/** The required fields of the screen the form has no control of its own for. */
export const extraRequired = (screen: JiraCreateField[] | undefined, ids: JiraFieldIds): JiraCreateField[] => (screen ?? []).filter((f) => f.required && !ownFields(ids).has(f.id));

const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && 'type' in (v as object) && (v as { type: unknown }).type === 'doc' && isEmptyDoc(v));

/** What still keeps Create from being pressed, by name. */
export function missing(f: CreateForm, screen: JiraCreateField[] | undefined, ids: JiraFieldIds): string[] {
  return [
    ...(PROJECT.test(f.project) ? [] : ['Project']),
    ...(f.typeId ? [] : ['Type']),
    ...(f.summary.trim() ? [] : ['Summary']),
    ...(screen?.some((s) => s.id === 'description' && s.required) && isEmptyDoc(f.description) ? ['Description'] : []),
    ...extraRequired(screen, ids)
      .filter((x) => !filled(f.extra[x.id]))
      .map((x) => x.name),
  ];
}

/** Jira's own shape for Create; a field the type's screen does not have is left out, as Jira would refuse it. */
export function createFields(f: CreateForm, ids: JiraFieldIds, screen?: JiraCreateField[]): Record<string, unknown> {
  const priority = screen?.find((s) => s.id === 'priority')?.allowedValues?.find((v) => v.name === f.priority)?.id;
  const points = f.storyPoints.trim() === '' ? NaN : Number(f.storyPoints);
  const fields: Record<string, unknown> = {
    summary: f.summary.trim(),
    ...(isEmptyDoc(f.description) ? {} : { description: f.description }),
    ...(f.priority ? { priority: priority ? { id: priority } : { name: f.priority } } : {}),
    ...(Number.isFinite(points) ? { [ids.storyPoints]: points } : {}),
    ...(f.sprintId !== null ? { [ids.sprint]: f.sprintId } : {}),
    ...(f.labels.length ? { labels: f.labels } : {}),
    ...(f.assignee ? { assignee: { accountId: f.assignee } } : {}),
    ...(f.parent ? { parent: { key: f.parent } } : {}),
    ...Object.fromEntries(Object.entries(f.extra).filter(([, v]) => filled(v))),
  };
  if (!screen?.length) return fields;
  const on = new Set(screen.map((s) => s.id));
  return Object.fromEntries(Object.entries(fields).filter(([id]) => on.has(id)));
}

/** A draft by Elfoqsy or an agent as the form's starting values: its Description, written in Markdown, as Jira's. */
export function formFromDraft(d: TicketDraft): CreateForm {
  return {
    project: d.project,
    typeId: '',
    typeName: d.type,
    summary: d.summary,
    description: d.description ? markdownToAdf(d.description) : null,
    priority: d.priority ?? '',
    storyPoints: d.storyPoints !== undefined ? String(d.storyPoints) : '',
    sprintId: d.sprint?.id ?? null,
    labels: d.labels ?? [],
    assignee: '',
    parent: d.parent ?? '',
    links: d.links ?? [],
    extra: {},
  };
}

export const emptyForm = (project: string): CreateForm => ({ project, typeId: '', typeName: '', summary: '', description: null, priority: '', storyPoints: '', sprintId: null, labels: [], assignee: '', parent: '', links: [], extra: {} });

/** A link from the new ticket as Jira words it on this site: "relates to SHOP-3538", "is blocked by SHOP-3543". */
export function linkWords(types: Array<{ name: string; inward: string; outward: string }>, l: { linkType: string; direction: 'inward' | 'outward' }): string {
  const t = types.find((x) => x.name === l.linkType);
  if (t) return l.direction === 'inward' ? t.inward : t.outward;
  return l.linkType === 'Relates' ? 'relates to' : l.direction === 'inward' ? `is ${l.linkType.toLowerCase()} by` : l.linkType.toLowerCase();
}

/** The issue type of a draft by its name, once the project's types are read. */
export const typeIdOf = (types: Array<{ id: string; name: string; subtask: boolean }>, name: string): string => types.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? '';
