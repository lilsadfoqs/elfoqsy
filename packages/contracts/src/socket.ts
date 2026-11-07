// WebSocket frames between the daemon and the workspace. These are transport, not events:
// everything that changes state still travels as an EventEnvelope inside an `events` frame.
import { z } from 'zod';
import { delegationCategorySchema, delegationSettingSchema, jiraChangeSchema, layoutSchema, type AnyEnvelope } from './schemas';

export type DaemonMode = 'simulate' | 'live';

/**
 * What one pane asks of another (P1, P2): "open this ticket", "show this conversation", "focus this agent". Not an event:
 * nothing in the workspace changes. The window it comes from hears it itself; the daemon passes it on to the other window,
 * so it works when the two panes are on different screens.
 */
export const intentSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('open_ticket'), key: z.string().min(1).max(40), section: z.number().int().min(1).max(7).optional() }),
  z.object({ t: z.literal('open_brief'), briefId: z.string().min(1).max(64) }),
  z.object({ t: z.literal('open_handoff'), handoffId: z.string().min(1).max(64) }),
  z.object({ t: z.literal('edit_draft'), draftId: z.string().min(1).max(64) }),
  z.object({ t: z.literal('new_ticket') }),
  z.object({ t: z.literal('find_ticket') }),
  z.object({ t: z.literal('select_conversation'), id: z.string().min(1).max(64).nullable() }),
  z.object({ t: z.literal('focus_run'), runId: z.string().min(1).max(64) }),
  // What the Sprint pane shows (the map, a ticket, a brief, a handoff, the create form), so that it is still there when the
  // pane is moved to the other screen. Sent as it changes and when the pane leaves a window.
  z.object({
    t: z.literal('sprint_view'),
    view: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('map') }),
      z.object({ kind: z.literal('ticket'), key: z.string().min(1).max(40) }),
      z.object({ kind: z.literal('brief'), briefId: z.string().min(1).max(64) }),
      z.object({ kind: z.literal('handoff'), handoffId: z.string().min(1).max(64) }),
      z.object({ kind: z.literal('create'), draftId: z.string().min(1).max(64).optional() }),
    ]),
  }),
]);
export type Intent = z.infer<typeof intentSchema>;

export type ServerFrame =
  // Sent first on every connection. logId changes when the log is recreated (simulate mode wipes it
  // at start), so a client holding events from another log must start again from seq 0.
  | { t: 'welcome'; mode: DaemonMode; logId: string; headSeq: number; serverTime: string; jiraSite: string }
  | { t: 'events'; events: AnyEnvelope[] }
  | { t: 'live' } // replay is done; everything after this is live
  // An intent another window sent (P2), passed on as it came; never logged.
  | { t: 'relay'; intent: Intent }
  | { t: 'error'; message: string };

export const clientFrameSchema = z.discriminatedUnion('t', [
  // Replay every event with seq > fromSeq, then stream live.
  z.object({ t: z.literal('hello'), fromSeq: z.number().int().nonnegative() }),
  // alex says something to Elfoqsy, in a conversation or, without one, starting a new one.
  // test: sent by a developer or coding agent testing the system, not by him.
  // Attachments are uploaded first (POST /attachments) and named here by id.
  z.object({
    t: z.literal('say'),
    text: z.string().trim().min(1).max(4000),
    conversationId: z.string().min(1).max(64).optional(),
    attachmentIds: z.array(z.string().min(1).max(64)).max(8).optional(),
    test: z.literal(true).optional(),
  }),
  // Guidance typed into an agent's terminal pane; it goes to the orchestrator, not through Elfoqsy.
  z.object({ t: z.literal('guide'), runId: z.string().min(1), text: z.string().trim().min(1).max(4000), test: z.literal(true).optional() }),
  // Pause and resume from a pane. Guidance (above) pauses, delivers and resumes as one action.
  z.object({ t: z.literal('pause'), runId: z.string().min(1), test: z.literal(true).optional() }),
  z.object({ t: z.literal('resume'), runId: z.string().min(1), test: z.literal(true).optional() }),
  // A CI failure on an open PR acknowledged from the ticket view, until the next CI result on it.
  z.object({ t: z.literal('dismiss_ci'), repo: z.string().min(1), pr: z.number().int().positive(), test: z.literal(true).optional() }),
  // A failed run acknowledged from its pane: it stops counting as broken but stays in history.
  z.object({ t: z.literal('dismiss'), runId: z.string().min(1), reason: z.string().trim().min(1).max(300).optional(), test: z.literal(true).optional() }),
  // Alex answers a pending approval. scope ticket: "Allow for this ticket" on a tier-2 request that offers it.
  z.object({
    t: z.literal('answer'),
    approvalId: z.string().min(1),
    decision: z.enum(['approved', 'denied', 'answered']),
    answer: z.string().trim().min(1).max(4000).optional(),
    scope: z.enum(['once', 'ticket']).optional(),
    // "Let Elfoqsy decide this kind next time": his answer becomes a precedent for its category and ticket type.
    precedent: z.literal(true).optional(),
    test: z.literal(true).optional(),
  }),
  // Undo from a pane: the recorded change is put back through the same proxy and tier rules.
  z.object({ t: z.literal('undo'), recordId: z.string().min(1), test: z.literal(true).optional() }),
  // He changes one of Elfoqsy's answers to an agent: the agent is told, and the change is counted.
  z.object({ t: z.literal('change_decision'), decisionId: z.string().min(1), to: z.string().trim().min(1).max(200), test: z.literal(true).optional() }),
  // Delegation settings, precedents and the agents-at-once limit, from the settings sheet. Only his count.
  z.object({ t: z.literal('delegation'), category: delegationCategorySchema, setting: delegationSettingSchema, test: z.literal(true).optional() }),
  z.object({ t: z.literal('remove_precedent'), precedentId: z.string().min(1), test: z.literal(true).optional() }),
  z.object({ t: z.literal('setting'), key: z.literal('maxAgents'), value: z.number().int().min(1).max(20), test: z.literal(true).optional() }),
  // He opens the digest of what Elfoqsy decided since his last one, in this conversation or, without one, Today's.
  z.object({ t: z.literal('digest'), conversationId: z.string().min(1).max(64).optional(), test: z.literal(true).optional() }),
  // The ticket open on the left screen, renewed while it stays open: the daemon reads it from Jira at once, also
  // outside the sprint, and again about every 10 seconds. A view action: it changes nothing.
  z.object({ t: z.literal('watch_ticket'), key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) }),
  // His edit of a ticket: straight to Jira with his credentials, logged as his. editId: the screen's own id.
  z.object({ t: z.literal('jira_edit'), editId: z.string().min(1).max(64), key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/), change: jiraChangeSchema, test: z.literal(true).optional() }),
  // The transitions Jira offers on a ticket now, for its status menu (a read).
  z.object({ t: z.literal('jira_transitions'), key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) }),
  // Tickets by key or summary words, in the sprint or not (a tier-0 search).
  z.object({ t: z.literal('search_tickets'), query: z.string().trim().min(2).max(200) }),
  // Jira's create screen for a project, and for one issue type (a read).
  z.object({ t: z.literal('jira_createmeta'), project: z.string().regex(/^[A-Z][A-Z0-9_]+$/), typeId: z.string().regex(/^\d+$/).optional() }),
  // He creates a ticket: only this frame creates one, and only from him. fields in Jira's own shape; links from
  // the new ticket; draftId when it came from a draft card.
  z.object({
    t: z.literal('jira_create'),
    createId: z.string().min(1).max(64),
    project: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    typeId: z.string().regex(/^\d+$/),
    fields: z.record(z.string(), z.unknown()),
    links: z.array(z.object({ linkType: z.string().min(1).max(80), direction: z.enum(['inward', 'outward']), other: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) })).max(10).optional(),
    draftId: z.string().max(64).optional(),
    test: z.literal(true).optional(),
  }),
  // A draft card he discards.
  z.object({ t: z.literal('discard_draft'), draftId: z.string().min(1).max(64), test: z.literal(true).optional() }),
  // He ticked "I've read the narrative" for a run (N1). Only his tick opens the ready-for-review gate; the tester's is logged as the tester's.
  z.object({ t: z.literal('narrative_read'), runId: z.string().min(1).max(64), test: z.literal(true).optional() }),
  // "Mark ready for review" from the narrative's hand-back card (N1): answers the run's pending ready-for-review ask, or,
  // when its agent has not asked, marks its draft PR ready once. Refused until he has ticked the narrative.
  z.object({ t: z.literal('mark_ready'), runId: z.string().min(1).max(64), test: z.literal(true).optional() }),
  // How the two screens are arranged (P2): saved in the log, so both windows and a reload agree. null: no layout saved,
  // today's arrangement. Only his arrangement counts; the tester's is refused.
  z.object({ t: z.literal('layout_set'), layout: layoutSchema.nullable(), test: z.literal(true).optional() }),
  // An intent for the other window (P2): the daemon passes it to every other window and keeps nothing.
  z.object({ t: z.literal('relay'), intent: intentSchema }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
