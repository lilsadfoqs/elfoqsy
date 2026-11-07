// Where Elfoqsy's words about a ticket go: the conversation its run was started from, else the ticket's
// latest conversation, else the day's "Today" conversation (one per day, created when first needed).
import { conversationForTicket, todayConversation, type WorkspaceState } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';

export class Conversations {
  constructor(
    private readonly log: EventLog,
    private readonly state: () => WorkspaceState,
    private readonly now: () => number = Date.now,
  ) {}

  /** The conversation for an update about this ticket (or run); Today's when it has none. */
  for(ticket?: string, runId?: string): string {
    return conversationForTicket(this.state(), ticket, runId) ?? this.today();
  }

  /** Today's conversation, created the first time it is needed. */
  today(): string {
    const today = todayConversation(this.now());
    if (!this.state().conversations[today.conversationId]) this.log.append('orchestrator', 'conversation.created', today);
    return today.conversationId;
  }
}
