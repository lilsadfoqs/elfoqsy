import type { Ticket, TicketStatus } from '@elfoqsy/contracts';

/** Status colours follow Jira and GitHub, filled. Values are tokens from design/tokens.css. */
export const STATUS_TOKEN: Record<TicketStatus, string> = {
  'To do': '--status-todo',
  'In progress': '--status-in-progress',
  Blocked: '--status-blocked',
  Done: '--status-done',
  Released: '--status-done',
  Cancelled: '--status-cancelled',
};

export const statusVar = (status: TicketStatus): string => `var(${STATUS_TOKEN[status]})`;

export function pointsText(points: number | null): string {
  if (points === null) return 'not estimated';
  return points === 1 ? '1 point' : `${points} points`;
}

/** Hover text: the summary first, then type, status and points. */
export function ticketTooltip(t: Ticket): string {
  return `${t.summary}\n${t.key}, ${t.type}, ${t.workflowStatus?.name ?? t.status}, ${pointsText(t.storyPoints)}`;
}

export const jiraUrl = (site: string, key: string): string => `${site.replace(/\/$/, '')}/browse/${key}`;
