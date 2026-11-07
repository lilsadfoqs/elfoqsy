// Her blocks name data by id and the screens fill them from the state, so a block can never show a
// wrong number. Before one is shown, every id it names must exist; otherwise she is told what to fix.
import type { MessageBlock } from '@elfoqsy/contracts';
import { reviewByRef, type WorkspaceState } from '@elfoqsy/state';

const MAX_CODE = 4000;

/** What is wrong with these blocks, one line each; empty when they can be shown. */
export function blockProblems(s: WorkspaceState, blocks: MessageBlock[]): string[] {
  const sprints = new Set(Object.values(s.tickets).flatMap((t) => (t.sprint ? [t.sprint] : [])));
  return blocks.flatMap((b, i): string[] => {
    const at = `Block ${i + 1} (${b.type})`;
    switch (b.type) {
      case 'ticket':
        return s.tickets[b.ref] ? [] : [`${at}: ${b.ref} is not a ticket in the sprint.`];
      case 'findings':
        return s.investigations[b.ref] ? [] : [`${at}: there is no investigation ${b.ref}.`];
      case 'progress':
        return s.runs[b.ref] ? [] : [`${at}: there is no run ${b.ref}.`];
      case 'sprint':
        return sprints.has(b.ref) ? [] : [`${at}: there is no sprint named ${b.ref}; the sprints are ${[...sprints].join(', ') || 'none'}.`];
      case 'approval':
        return s.approvals[b.ref] ? [] : [`${at}: there is no approval ${b.ref}.`];
      case 'brief':
        return s.briefs[b.ref] ? [] : [`${at}: there is no brief ${b.ref}.`];
      case 'handoff':
        return s.handoffs[b.ref] ? [] : [`${at}: there is no handoff ${b.ref}.`];
      case 'verdict':
        return s.runs[b.ref]?.verdict ? [] : [`${at}: ${s.runs[b.ref] ? `run ${b.ref} has no verdict yet` : `there is no run ${b.ref}`}.`];
      case 'review':
        return reviewByRef(s, b.ref) ? [] : [`${at}: there is no weekly review for ${b.ref}; record it first.`];
      case 'decision':
        return s.decisions[b.ref] ? [] : [`${at}: there is no decision ${b.ref}.`];
      case 'digest':
        return s.digests[b.ref] ? [] : [`${at}: there is no digest ${b.ref}.`];
      case 'deliverable':
        return s.deliverables[b.ref] ? [] : [`${at}: there is no deliverable ${b.ref}.`];
      case 'draft':
        return s.drafts[b.ref] ? [] : [`${at}: there is no draft ${b.ref}; make one with draft_ticket.`];
      case 'jira_news':
        return s.jiraNews[b.ref] ? [] : [`${at}: there is no Jira news ${b.ref}.`];
      case 'narrative':
        return s.runs[b.ref] ? [] : [`${at}: there is no run ${b.ref}.`];
      case 'ability':
        return s.abilities[b.ref] ? [] : [`${at}: there is no ability ${b.ref}.`];
      case 'code':
        if (!b.content.trim()) return [`${at}: it is empty.`];
        return b.content.length > MAX_CODE ? [`${at}: it is longer than ${MAX_CODE} characters; show the part that matters.`] : [];
    }
  });
}
