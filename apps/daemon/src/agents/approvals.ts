// Waiting for Alex. A request writes approval.requested and posts the question in Elfoqsy's voice
// (from the orchestrator, so it reaches him even while her session is paused), then waits for the
// approval.resolved his Approve, Deny or typed answer produces.
//
// Tier-2 requests are batched: those made in the same conversation within BATCH_MS share a batchId and one
// message that lists them all, so he can approve them together or one by one. Each can be approved once or, where it
// offers it, for the whole ticket.
import type { PayloadOf, Tier } from '@elfoqsy/contracts';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import { tr } from '../elfoqsy/voice';
import { ulid } from '../ulid';

export type ApprovalKind = PayloadOf<'approval.requested'>['kind'];
export interface Resolution {
  decision: PayloadOf<'approval.resolved'>['decision'];
  answer?: string;
  /** Answered by someone testing the workspace, not by Alex. */
  test?: true;
  /** "Allow for this ticket". */
  scope?: 'once' | 'ticket';
  /** Nobody answered in 72 hours: the question was withdrawn. */
  withdrawn?: true;
  /** He ticked "Let Elfoqsy decide this kind next time". */
  precedent?: true;
}

/** The answers the workspace writes when it closes a question nobody answered. */
export const CLOSED_ANSWERS = {
  runEnded: 'The run ended.',
  restarted: 'The daemon restarted.',
  withdrawn: 'Withdrawn after 72 hours without an answer.',
  /** A wait shorter than 72 hours ran out. */
  notInTime: 'Not answered in time.',
} as const;

/** Who answered, for what the agent is told. */
export const answeredBy = (r: Resolution): string => (r.test ? 'The tester (not alex)' : 'alex');

/** Closed by the workspace, not answered: the run ended or the daemon restarted while it waited. */
export const unanswered = (r: Resolution): boolean => r.answer !== undefined && (Object.values(CLOSED_ANSWERS) as string[]).includes(r.answer);

/** Tier-2 requests this close together become one approval. */
export const BATCH_MS = 3000;

export interface ApprovalRequest {
  runId: string;
  ticket: string;
  kind: ApprovalKind;
  question: string;
  action?: string;
  /** Chosen by the caller when it must name the approval before it is answered. */
  approvalId?: string;
  tier?: Tier;
  /** Offers "Allow for this ticket" for this kind of action in this environment. */
  grantable?: { kind: string; environment?: string };
  /** an agent's structured question, its delegation category, Elfoqsy's suggestion or why she has none. */
  card?: PayloadOf<'approval.requested'>['card'];
  category?: PayloadOf<'approval.requested'>['category'];
  suggestion?: PayloadOf<'approval.requested'>['suggestion'];
  noSuggestion?: string;
  precedentable?: true;
  requestId?: string;
  /** Marking ready for review (N1): not approved until he has read the run's narrative. */
  gate?: 'narrative';
  /** The conversation to ask in, instead of the run's (Elfoqsy's own requests: the one she is answering). */
  conversationId?: string;
  /** Her line above the card, instead of "Agent N needs your approval". */
  line?: string;
}

interface Batch {
  batchId: string;
  conversationId: string | undefined;
  items: Array<{ approvalId: string; runId: string; ticket: string }>;
  timer: unknown;
}

export class Approvals {
  private readonly pending = new Map<string, { runId: string; resolve: (r: Resolution) => void }>();
  /** Each request's answer, by its promise: a wait that runs out withdraws its own question only. */
  private readonly ids = new WeakMap<Promise<unknown>, string>();
  private readonly batches = new Map<string, Batch>();
  private readonly unsubscribe: () => void;
  private readonly clock: Clock;

  /** `route` names the conversation a run's question goes to (its own, its ticket's, or Today's). */
  constructor(
    private readonly log: EventLog,
    private readonly route?: (runId: string, ticket: string) => string,
    clock?: Clock,
  ) {
    this.clock = clock ?? realClock;
    this.unsubscribe = log.subscribe((event) => {
      if (event.type !== 'approval.resolved') return;
      const waiting = this.pending.get(event.payload.approvalId);
      if (!waiting) return;
      this.pending.delete(event.payload.approvalId);
      const { decision, answer, test, scope, withdrawn, precedent } = event.payload;
      waiting.resolve({ decision, ...(answer ? { answer } : {}), ...(test ? { test } : {}), ...(scope ? { scope } : {}), ...(withdrawn ? { withdrawn } : {}), ...(precedent ? { precedent } : {}) });
    });
  }

  request(o: ApprovalRequest): Promise<Resolution> {
    const approvalId = o.approvalId ?? ulid();
    const created = this.created(o.runId);
    const conversationId = o.conversationId ?? (this.route ? this.route(o.runId, o.ticket) : created?.conversationId);
    const batch = o.tier === 2 ? this.batchFor(conversationId) : undefined;
    const answer = new Promise<Resolution>((resolve) => {
      this.pending.set(approvalId, { runId: o.runId, resolve });
      this.log.append('orchestrator', 'approval.requested', {
        approvalId,
        runId: o.runId,
        kind: o.kind,
        question: o.question,
        ...(o.action ? { action: o.action.slice(0, 500) } : {}),
        ...(o.tier !== undefined ? { tier: o.tier } : {}),
        ...(o.grantable ? { grantable: o.grantable } : {}),
        ...(batch ? { batchId: batch.batchId } : {}),
        ...(o.card ? { card: o.card } : {}),
        ...(o.category ? { category: o.category } : {}),
        ...(o.suggestion ? { suggestion: o.suggestion } : {}),
        ...(o.noSuggestion ? { noSuggestion: o.noSuggestion } : {}),
        ...(o.precedentable ? { precedentable: o.precedentable } : {}),
        ...(o.requestId ? { requestId: o.requestId } : {}),
        ...(o.gate ? { gate: o.gate } : {}),
      });
      if (batch) {
        batch.items.push({ approvalId, runId: o.runId, ticket: o.ticket });
        return;
      }
      // The block carries the question and the action; her line only says who is waiting.
      const agent = created ? `Agent ${created.agentNumber}` : o.ticket;
      this.log.append('orchestrator', 'elfoqsy.message', {
        messageId: ulid(),
        role: 'elfoqsy',
        text:
          o.line ??
          (o.kind === 'question'
            ? tr(`${agent} has a question for you.`, `${agent} có một câu hỏi cho cậu.`)
            : tr(`${agent} needs your approval.`, `${agent} cần cậu duyệt.`)),
        ...(conversationId ? { conversationId } : {}),
        blocks: [{ type: 'approval', ref: approvalId }],
        refs: { ...(o.ticket ? { tickets: [o.ticket] } : {}), runId: o.runId, approvalId },
      });
    });
    this.ids.set(answer, approvalId);
    return answer;
  }

  /** The open batch of this conversation, or a new one whose message goes out BATCH_MS from now. */
  private batchFor(conversationId: string | undefined): Batch {
    const key = conversationId ?? '';
    const open = this.batches.get(key);
    if (open) return open;
    const batch: Batch = { batchId: ulid(), conversationId, items: [], timer: undefined };
    batch.timer = this.clock.setTimeout(() => this.post(key), BATCH_MS);
    this.batches.set(key, batch);
    return batch;
  }

  /** One message for the batch: every approval in it that is still open. */
  private post(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    const open = batch.items.filter((i) => this.pending.has(i.approvalId));
    if (!open.length) return;
    const agents = [...new Set(open.map((i) => this.created(i.runId)?.agentNumber).filter((n): n is number => n !== undefined))];
    const who =
      agents.length === 0
        ? open[0]!.ticket
        : agents.length === 1
          ? `Agent ${agents[0]}`
          : tr(`Agents ${agents.slice(0, -1).join(', ')} and ${agents.at(-1)}`, `Agent ${agents.slice(0, -1).join(', ')} và ${agents.at(-1)}`);
    const verb = agents.length > 1 ? 'need' : 'needs';
    const tickets = [...new Set(open.map((i) => i.ticket))];
    const runs = [...new Set(open.map((i) => i.runId))];
    this.log.append('orchestrator', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      text:
        open.length === 1
          ? tr(`${who} ${verb} your approval.`, `${who} cần cậu duyệt.`)
          : tr(`${who} ${verb} your approval for ${open.length} actions.`, `${who} cần cậu duyệt ${open.length} việc.`),
      ...(batch.conversationId ? { conversationId: batch.conversationId } : {}),
      blocks: open.map((i) => ({ type: 'approval' as const, ref: i.approvalId })),
      refs: { tickets, ...(runs.length === 1 ? { runId: runs[0]! } : {}), approvalId: open[0]!.approvalId },
    });
  }

  private created(runId: string): { agentNumber: number; conversationId?: string } | undefined {
    const created = this.log.readFrom(0, 1_000_000, ['run.created']).find((e) => e.type === 'run.created' && e.payload.runId === runId);
    if (created?.type !== 'run.created') return undefined;
    return { agentNumber: created.payload.agentNumber, ...(created.payload.conversationId ? { conversationId: created.payload.conversationId } : {}) };
  }

  /**
   * Nobody answered for 72 hours, or for a shorter wait given with its own words (`closed`): the question this answer was awaited
   * for leaves the screen, marked withdrawn.
   * The run's other open questions, asked later, stay. The run pauses itself first, so the agent never goes on without
   * his answer. False when the answer is not one of this workspace's open requests.
   */
  withdraw(answer: Promise<unknown>, closed: string = CLOSED_ANSWERS.withdrawn): boolean {
    const approvalId = this.ids.get(answer);
    const waiting = approvalId ? this.pending.get(approvalId) : undefined;
    if (!approvalId || !waiting) return false;
    this.pending.delete(approvalId);
    this.log.append('orchestrator', 'approval.resolved', { approvalId, decision: 'denied', answer: closed, withdrawn: true });
    waiting.resolve({ decision: 'denied', answer: closed, withdrawn: true });
    return true;
  }

  /** The run ended while waiting: close its questions so no buttons are left on screen. */
  cancelRun(runId: string, reason: string): void {
    for (const [approvalId, waiting] of [...this.pending]) {
      if (waiting.runId !== runId) continue;
      this.pending.delete(approvalId);
      this.log.append('orchestrator', 'approval.resolved', { approvalId, decision: 'denied', answer: reason });
      waiting.resolve({ decision: 'denied', answer: reason });
    }
  }

  close(): void {
    for (const key of [...this.batches.keys()]) {
      this.clock.clearTimeout(this.batches.get(key)!.timer);
      this.post(key);
    }
    this.unsubscribe();
  }
}
