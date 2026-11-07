// Elfoqsy's column and the conversation as panes (P1): each fills its slot. Which conversation is open is the little state
// they share (panes/session.ts); what a block in the conversation wants of the sprint goes out as an intent, so it works
// when the sprint is on the other screen.
import { useEffect } from 'react';
import type { WorkspaceState } from '@elfoqsy/state';
import { Conversation } from '../left/chat/Conversation';
import type { BlockActions } from '../left/chat/Blocks';
import { ElfoqsyColumn } from '../left/ElfoqsyColumn';
import { latestConversation } from '../left/model';
import { stream } from '../state/workspace';
import type { Look } from '../ui/elfoqsy';
import { bus } from './bus';
import { session, useSession } from './session';

/** The conversation open now: his choice, else the latest, else a new one. */
export function useConversationId(state: WorkspaceState): string | null {
  const { chosen } = useSession();
  return chosen === undefined ? (latestConversation(state)?.conversationId ?? null) : chosen;
}

export type ColumnChrome = { kind: 'classic'; open: boolean; lastOpen: boolean; onToggle: () => void; ensureOpen?: () => void } | { kind: 'free'; open: boolean; onToggle: () => void };

export function ElfoqsyPane({ state, look, chrome, alone = false }: { state: WorkspaceState; look: Look; chrome: ColumnChrome; alone?: boolean }) {
  const conversationId = useConversationId(state);
  return (
    <ElfoqsyColumn
      state={state}
      look={look}
      selected={conversationId}
      onSelect={(id) => session.choose(id)}
      open={chrome.open}
      lastOpen={chrome.kind === 'classic' ? chrome.lastOpen : false}
      alone={alone}
      onToggle={chrome.onToggle}
    />
  );
}

/** What the conversation's blocks ask of the sprint: a ticket, a brief, a handoff, a draft's form, a section of a narrative. */
export const conversationActions: BlockActions = {
  openTicket: (key) => bus.emit({ t: 'open_ticket', key }),
  openBrief: (briefId) => bus.emit({ t: 'open_brief', briefId }),
  openHandoff: (handoffId) => bus.emit({ t: 'open_handoff', handoffId }),
  editDraft: (draftId) => bus.emit({ t: 'edit_draft', draftId }),
  openNarrative: (runId, section) => {
    const run = stream.getSnapshot().state.runs[runId];
    if (run) bus.emit({ t: 'open_ticket', key: run.ticket, section });
  },
};

export function ConversationPane({ state, chrome }: { state: WorkspaceState; chrome: ColumnChrome }) {
  const { chosen, sentAt } = useSession();
  const conversationId = useConversationId(state);

  // A first message in a new conversation creates it in the daemon; open it when it appears.
  useEffect(() => {
    if (chosen !== null || sentAt === null) return;
    const created = Object.values(state.conversations).find((c) => c.createdAt >= sentAt - 5000);
    if (created) {
      session.choose(created.conversationId);
      session.sent(null);
    }
  }, [state.conversations, chosen, sentAt]);

  return (
    <Conversation
      state={state}
      conversationId={conversationId}
      actions={conversationActions}
      onSent={() => {
        if (conversationId === null) session.sent(stream.now());
      }}
      open={chrome.open}
      lastOpen={chrome.kind === 'classic' ? chrome.lastOpen : false}
      onToggle={chrome.onToggle}
    />
  );
}
