// What the left screen shows, worked out from the state. Pure, so it can be tested.
import type { Priority, Ticket } from '@elfoqsy/contracts';
import { isOpen, isRunActive, type ActivityView, type ConversationView, type MessageView, type RunView, type WorkspaceState } from '@elfoqsy/state';

const PRIORITY_RANK: Record<Priority, number> = { Blocker: 0, Critical: 1, Major: 2, Minor: 3 };

/** Tickets in the order previous and next step through them: Critical to Minor, then the biggest first. */
export function ticketOrder(s: WorkspaceState): Ticket[] {
  return Object.values(s.tickets)
    .filter(isOpen)
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (b.storyPoints ?? 0) - (a.storyPoints ?? 0) || a.key.localeCompare(b.key, 'en', { numeric: true }),
    );
}

/** The agent working on a ticket now, if any. */
export const agentOn = (s: WorkspaceState, key: string): RunView | undefined =>
  Object.values(s.runs).find((r) => r.ticket === key && isRunActive(r));

export const activeAgents = (s: WorkspaceState): RunView[] => Object.values(s.runs).filter(isRunActive).sort((a, b) => a.agentNumber - b.agentNumber);

/** Her own line under her name. A failed run waits to be dismissed, but nothing runs in it. */
export function elfoqsyLine(s: WorkspaceState): string {
  const n = activeAgents(s).filter((r) => r.state !== 'failed').length;
  return n ? `Running ${n} agent${n === 1 ? '' : 's'} for you` : 'No agents running';
}

const hhmm = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** 14:16 today or yesterday, Mon within the week, Oct 1 before that. */
export function conversationTime(at: number, now: number): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (at >= day.getTime() - 86_400_000) return hhmm(at);
  if (at >= day.getTime() - 6 * 86_400_000) return new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A message's time: 14:15 today, "Yesterday 16:07", then "Oct 3, 12:31". */
export function messageTime(at: number, now: number): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (at >= day.getTime()) return hhmm(at);
  if (at >= day.getTime() - 86_400_000) return `Yesterday ${hhmm(at)}`;
  return `${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${hhmm(at)}`;
}

/** Messages written before conversations existed, or outside any, are kept together in one thread. */
export const EARLIER = 'earlier';

export function threadOf(s: WorkspaceState, conversationId: string): MessageView[] {
  return s.messages.filter((m) => (conversationId === EARLIER ? !m.conversationId || !s.conversations[m.conversationId] : m.conversationId === conversationId));
}

export function hasEarlierMessages(s: WorkspaceState): boolean {
  return s.messages.some((m) => !m.conversationId || !s.conversations[m.conversationId]);
}

/** The conversation shown first: the one most recently written in. */
export function latestConversation(s: WorkspaceState): ConversationView | undefined {
  return Object.values(s.conversations).sort((a, b) => b.lastAt - a.lastAt)[0];
}

/** Whether any question or approval waits for him in this thread. */
export function waitsInThread(s: WorkspaceState, messages: MessageView[]): boolean {
  return messages.some((m) => {
    const block = m.blocks.find((b) => b.type === 'approval') as { ref: string } | undefined;
    const id = m.refs?.approvalId ?? block?.ref;
    return !!id && !!s.approvals[id] && !s.approvals[id]!.resolution;
  });
}

export function pointsLeft(s: WorkspaceState): number {
  return Object.values(s.tickets)
    .filter(isOpen)
    .reduce((n, t) => n + (t.storyPoints ?? 0), 0);
}

/** A brief as Markdown, for Copy as Markdown. */
export { briefMarkdown } from '@elfoqsy/state';

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { hhmm };

/** She stops showing as thinking this long after the last sign of it, if no answer came. */
export const THINKING_GIVES_UP_MS = 15 * 60_000;

/**
 * Her thinking indicator: shown while the latest message of the conversation is alex's (or the tester's), not an
 * answer to an agent's question, and she has not answered yet. It lists her actions since that message. Folded from
 * the log, so it appears as soon as his message comes back.
 */
export function thinkingOf(s: WorkspaceState, conversationId: string, messages: MessageView[], now: number): { since: number; activities: ActivityView[] } | null {
  const last = messages.at(-1);
  if (!last || last.role === 'elfoqsy' || last.refs?.approvalId) return null;
  if (s.claude.state === 'limited') return null; // paused: the top line says so
  const activities = (s.activities[conversationId] ?? []).filter((a) => a.at >= last.at);
  const latest = Math.max(last.at, ...activities.map((a) => a.finishedAt ?? a.at));
  if (now - latest > THINKING_GIVES_UP_MS) return null;
  return { since: last.at, activities };
}
