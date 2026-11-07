// Finding a ticket (C in): by its key, exactly, or by words of its title. The sprint's tickets are
// matched here at once; Jira is searched as well (a tier-0 read by the daemon), so tickets outside the sprint are found
// too. Each result carries its type, key, title, workflow status, and "Sprint 52" or "not in sprint".
import type { Ticket, WorkflowStatus } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';

export interface Found {
  key: string;
  summary: string;
  type: Ticket['type'];
  status: WorkflowStatus;
  /** "Sprint 52", or "not in sprint". */
  where: string;
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** "SHOP Sprint 52" as "Sprint 52". */
export const shortSprint = (name: string): string => /\bSprint \d+\b/i.exec(name)?.[0] ?? name;

/** A Jira issue type's name as the left screen's types. */
export const typeOfName = (name: string): Ticket['type'] => {
  const n = name.toLowerCase();
  return n === 'bug' ? 'Bug' : n === 'story' ? 'Story' : n === 'epic' ? 'Epic' : n.includes('sub') ? 'Sub-task' : 'Task';
};

const fromTicket = (t: Ticket): Found => ({
  key: t.key,
  summary: t.summary,
  type: t.type,
  status: t.workflowStatus ?? { name: t.status, category: t.status === 'To do' ? 'new' : ['Done', 'Released', 'Cancelled'].includes(t.status) ? 'done' : 'indeterminate' },
  where: t.sprint ? shortSprint(t.sprint) : 'not in sprint',
});

/** The sprint's tickets that match: the key exactly ("SHOP-3538", or "3538" for its digits), or every word in the title. */
export function findInSprint(tickets: Ticket[], query: string): Found[] {
  const q = query.trim();
  if (!q) return [];
  const key = q.toUpperCase();
  if (KEY.test(key)) return tickets.filter((t) => t.key === key).map(fromTicket);
  if (/^\d+$/.test(q)) return tickets.filter((t) => t.key.split('-')[1] === q).map(fromTicket);
  const words = q.toLowerCase().split(/\s+/);
  return tickets.filter((t) => words.every((w) => t.summary.toLowerCase().includes(w))).map(fromTicket);
}

/** The sprint's matches first, then Jira's answer to the same query, each ticket once. */
export function findResults(state: WorkspaceState, order: Ticket[], query: string): Found[] {
  const local = findInSprint(order, query);
  const search = state.ticketSearch;
  const remote = search && search.query === query.trim() ? search.results : [];
  const seen = new Set(local.map((f) => f.key));
  const more = remote
    .filter((r) => !seen.has(r.key))
    .map((r): Found => ({ key: r.key, summary: r.summary, type: typeOfName(r.type), status: r.status, where: r.inSprint ? shortSprint(r.sprint ?? 'Sprint') : 'not in sprint' }));
  return [...local, ...more];
}

/** Whether Jira's answer for this query is still to come. */
export const searching = (state: WorkspaceState, query: string): boolean => query.trim().length >= 2 && state.ticketSearch?.query !== query.trim();
