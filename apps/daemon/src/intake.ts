// What alex sends up the socket, turned into events. Frames marked test come from someone testing the
// workspace: they are logged as test, never as his. Answers are checked against the approvals
// actually pending in the log, so an approval can be resolved once and only with a fitting decision.
// A message without a conversation starts a new one, titled by its first line until Elfoqsy renames it.
import type { Actor, AnyEnvelope, ClientFrame, JiraChange, PayloadOf } from '@elfoqsy/contracts';
import { fits, savedLayout } from '@elfoqsy/state';
import type { RunControl } from './agents/control';
import type { AttachmentStore } from './attachments';
import type { EventLog } from './eventLog';
import { ulid } from './ulid';

type ApprovalKind = PayloadOf<'approval.requested'>['kind'];

interface PendingApproval {
  runId: string;
  kind: ApprovalKind;
  resolved: boolean;
  /** "Let Elfoqsy decide this kind next time" is offered. */
  precedentable?: boolean;
  /** "Allow for this ticket" is offered. */
  grantable: boolean;
  /** The conversation it was asked in, where a typed answer belongs too. */
  conversationId?: string;
  /** Marking ready for review (N1): not approved until the run's narrative was read. */
  gate?: 'narrative';
}

export class IntakeError extends Error {}

export interface IntakeOptions {
  /** Pause, resume and guidance from a pane: the orchestrator live, the simulator in simulate mode. */
  runs?: RunControl;
  attachments?: AttachmentStore;
  /** Undo from a pane: the orchestrator's proxies put a recorded change back. */
  undo?: (recordId: string, by: Actor) => Promise<unknown>;
  /** He changes one of Elfoqsy's answers: the orchestrator records it and tells the agent. */
  changeDecision?: (decisionId: string, to: string, by: 'you' | 'tester') => { ok: true } | { error: string; message: string };
  /** He opens the digest of what Elfoqsy decided: in this conversation, or Today's without one. */
  openDigest?: (conversationId: string | undefined, by: 'you' | 'tester') => void;
  /** The ticket open on the left screen: read from Jira at once and while it stays open. */
  watchTicket?: (key: string) => void;
  /** His edit of a ticket: straight to Jira with his credentials. */
  jiraEdit?: (editId: string, key: string, change: JiraChange) => void;
  /** The transitions of a ticket, for its status menu; a ticket search. Reads. */
  jiraTransitions?: (key: string) => void;
  searchTickets?: (query: string) => void;
  /** Jira's create screen (a read), his Create (the only way a ticket is created), and a draft discarded. */
  createMeta?: (project: string, typeId?: string) => void;
  createTicket?: (f: { createId: string; project: string; typeId: string; fields: Record<string, unknown>; links?: Array<{ linkType: string; direction: 'inward' | 'outward'; other: string }>; draftId?: string }) => void;
  discardDraft?: (draftId: string, by: 'you' | 'tester') => void;
  /**
   * The narrative's gate (N1): whether he has read the run's narrative as it stands now (the tester's tick counts only in
   * the tester's own run); and marking the run's draft PR ready for review once, when its agent has not asked.
   */
  narrativeRead?: (runId: string) => boolean;
  markReady?: (runId: string, by: 'you' | 'tester') => Promise<{ ok: true } | { ok: false; message: string }>;
}

const TITLE_MAX = 60;
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
const ENDED = new Set(['succeeded', 'stopped', 'cancelled']);

/** A new conversation's title until Elfoqsy proposes one: the message's first line, shortened at a word. */
export function firstTitle(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : cut.length)}…`;
}

export class Intake {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly conversations = new Set<string>();
  /** Runs that have not ended, by id. */
  private readonly runs = new Set<string>();
  /** Failed runs, and whether each was dismissed. */
  private readonly failed = new Map<string, boolean>();
  /** Open PRs by `${repo}#${number}`: whether CI fails on it, at which commit, and whether that was dismissed. */
  private readonly prs = new Map<string, { open: boolean; checksFailing: boolean; ci?: { sha: string; status: string }; dismissed?: string }>();
  /** Recorded changes: whether each can be undone, and whether it was. */
  private readonly changes = new Map<string, { undoable: boolean; noUndo?: string; undone: boolean }>();
  /** His precedents still in force. */
  private readonly precedents = new Set<string>();
  /** Every run's ticket, for his tick on its narrative. */
  private readonly runTickets = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly log: EventLog,
    private readonly options: IntakeOptions = {},
  ) {
    for (let after = 0; ; ) {
      const batch = log.readFrom(after, 5000);
      if (!batch.length) break;
      batch.forEach((e) => this.track(e));
      after = batch[batch.length - 1]!.seq;
    }
    this.unsubscribe = log.subscribe((e) => this.track(e));
  }

  handle(frame: Exclude<ClientFrame, { t: 'hello' }>): void {
    if (frame.t === 'say') {
      let conversationId = frame.conversationId;
      if (conversationId && !this.conversations.has(conversationId)) throw new IntakeError('Unknown conversation.');
      const attachments = (frame.attachmentIds ?? []).map((id) => {
        const found = this.options.attachments?.get(id);
        if (!found) throw new IntakeError('An attachment was not uploaded; attach it again.');
        return found.attachment;
      });
      if (!conversationId) {
        conversationId = ulid();
        const ticket = TICKET_KEY.exec(frame.text)?.[0];
        this.log.append('orchestrator', 'conversation.created', { conversationId, title: firstTitle(frame.text), ...(ticket ? { ticket } : {}) });
      }
      this.log.append('orchestrator', 'elfoqsy.message', {
        messageId: ulid(),
        role: frame.test ? 'test' : 'you',
        text: frame.text,
        conversationId,
        ...(attachments.length ? { attachments } : {}),
      });
      return;
    }
    if (frame.t === 'dismiss') {
      const dismissed = this.failed.get(frame.runId);
      if (dismissed === undefined) throw new IntakeError('Only a failed run can be dismissed.');
      if (dismissed) throw new IntakeError('That run is already dismissed.');
      this.log.append('orchestrator', 'run.dismissed', { runId: frame.runId, by: frame.test ? 'tester' : 'you', ...(frame.reason ? { reason: frame.reason } : {}) });
      return;
    }
    if (frame.t === 'guide' || frame.t === 'pause' || frame.t === 'resume') {
      if (!this.runs.has(frame.runId)) throw new IntakeError('That agent is not running.');
      const control = this.options.runs;
      if (!control) throw new IntakeError('Agents cannot be paused or guided here.');
      const by = frame.test ? 'tester' : 'you';
      const result =
        frame.t === 'guide' ? control.guide(frame.runId, frame.text, by) : frame.t === 'pause' ? control.pause(frame.runId, by) : control.resume(frame.runId, by);
      if ('error' in result) throw new IntakeError(result.message);
      return;
    }
    if (frame.t === 'dismiss_ci') {
      const key = `${frame.repo}#${frame.pr}`;
      const pr = this.prs.get(key);
      const failing = pr?.open && (pr.checksFailing || pr.ci?.status === 'failure');
      if (!pr || !failing) throw new IntakeError('CI is not failing on that pull request.');
      const sha = pr.ci?.sha ?? 'checks';
      if (pr.dismissed === sha) throw new IntakeError('That CI failure is already dismissed.');
      this.log.append('orchestrator', 'ci.dismissed', { repo: frame.repo, pr: frame.pr, sha, by: frame.test ? 'tester' : 'you' });
      return;
    }
    if (frame.t === 'change_decision') {
      const change = this.options.changeDecision;
      if (!change) throw new IntakeError("Elfoqsy's decisions cannot be changed here.");
      const result = change(frame.decisionId, frame.to, frame.test ? 'tester' : 'you');
      if ('error' in result) throw new IntakeError(result.message);
      return;
    }
    if (frame.t === 'watch_ticket') {
      // A view action, the tester's too: it reads, and changes nothing.
      this.options.watchTicket?.(frame.key);
      return;
    }
    if (frame.t === 'jira_transitions' || frame.t === 'search_tickets') {
      if (frame.t === 'jira_transitions') this.options.jiraTransitions?.(frame.key);
      else this.options.searchTickets?.(frame.query);
      return;
    }
    if (frame.t === 'jira_createmeta') {
      this.options.createMeta?.(frame.project, frame.typeId);
      return;
    }
    if (frame.t === 'jira_create') {
      // Only he creates tickets: never the tester, and nothing else sends this.
      if (frame.test) throw new IntakeError('Only alex creates Jira tickets.');
      const create = this.options.createTicket;
      if (!create) throw new IntakeError('Tickets cannot be created here.');
      const { t: _t, test: _test, ...f } = frame;
      create(f);
      return;
    }
    if (frame.t === 'discard_draft') {
      if (!this.options.discardDraft) throw new IntakeError('There are no drafts here.');
      this.options.discardDraft(frame.draftId, frame.test ? 'tester' : 'you');
      return;
    }
    if (frame.t === 'jira_edit') {
      // His tickets are his: the tester can look, never write to Jira.
      if (frame.test) throw new IntakeError('Only alex changes his Jira tickets.');
      const edit = this.options.jiraEdit;
      if (!edit) throw new IntakeError('Jira cannot be edited here.');
      edit(frame.editId, frame.key, frame.change);
      return;
    }
    if (frame.t === 'digest') {
      const open = this.options.openDigest;
      if (!open) throw new IntakeError("Elfoqsy's decisions are not kept here.");
      if (frame.conversationId && !this.conversations.has(frame.conversationId)) throw new IntakeError('Unknown conversation.');
      open(frame.conversationId, frame.test ? 'tester' : 'you');
      return;
    }
    if (frame.t === 'layout_set') {
      // His screens are his: the tester looks, and never rearranges them.
      if (frame.test) throw new IntakeError('Only alex arranges his screens.');
      if (frame.layout && !fits(frame.layout)) throw new IntakeError('That arrangement does not fit: a pane would be smaller than its minimum.');
      // Today's arrangement is no layout: what is kept is only ever his own.
      this.log.append('orchestrator', 'layout.changed', { layout: savedLayout(frame.layout), by: 'you' });
      return;
    }
    if (frame.t === 'relay') return; // carried to the other windows by the socket server; nothing to record
    if (frame.t === 'narrative_read') {
      const ticket = this.runTickets.get(frame.runId);
      if (!ticket) throw new IntakeError('There is no such run.');
      // Recorded as his, or as the tester's, which opens nothing in a real run.
      this.log.append('orchestrator', 'narrative.read', { runId: frame.runId, ticket, by: frame.test ? 'tester' : 'you' });
      return;
    }
    if (frame.t === 'mark_ready') {
      if (!this.runTickets.has(frame.runId)) throw new IntakeError('There is no such run.');
      if (!this.options.narrativeRead?.(frame.runId)) throw new IntakeError("Read the narrative first: tick \"I've read the narrative\" in the ticket, then mark it ready.");
      const ask = [...this.approvals.entries()].find(([, a]) => a.runId === frame.runId && a.gate === 'narrative' && !a.resolved);
      if (ask) {
        // The agent asked: this is the answer to its question.
        this.log.append('orchestrator', 'approval.resolved', { approvalId: ask[0], decision: 'approved', ...(frame.test ? { test: true as const } : {}) });
        return;
      }
      const mark = this.options.markReady;
      if (!mark) throw new IntakeError('A pull request cannot be marked ready here.');
      void mark(frame.runId, frame.test ? 'tester' : 'you').then(
        (r) => {
          if (!r.ok) this.log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: r.message });
        },
        () => undefined,
      );
      return;
    }
    // His settings are his: the tester can look, not change them.
    if (frame.t === 'delegation' || frame.t === 'remove_precedent' || frame.t === 'setting') {
      if (frame.test) throw new IntakeError('Only alex changes delegation, precedents and settings.');
      if (frame.t === 'delegation') this.log.append('orchestrator', 'delegation.set', { category: frame.category, setting: frame.setting, by: 'you' });
      else if (frame.t === 'setting') this.log.append('orchestrator', 'workspace.setting', { key: frame.key, value: frame.value, by: 'you' });
      else {
        if (!this.precedents.has(frame.precedentId)) throw new IntakeError('There is no such precedent.');
        this.log.append('orchestrator', 'precedent.removed', { precedentId: frame.precedentId, by: 'you' });
      }
      return;
    }
    if (frame.t === 'undo') {
      const change = this.changes.get(frame.recordId);
      if (!change) throw new IntakeError('There is no such change to undo.');
      if (change.undone) throw new IntakeError('That change is already undone.');
      if (!change.undoable) throw new IntakeError(change.noUndo ?? 'That change cannot be undone here.');
      const undo = this.options.undo;
      if (!undo) throw new IntakeError('Changes cannot be undone here.');
      void undo(frame.recordId, frame.test ? 'tester' : 'you').catch(() => undefined);
      return;
    }
    const approval = this.approvals.get(frame.approvalId);
    if (!approval) throw new IntakeError('Unknown approval.');
    if (approval.resolved) throw new IntakeError('That approval is already answered.');
    if (approval.gate === 'narrative' && frame.decision === 'approved' && !this.options.narrativeRead?.(approval.runId)) {
      throw new IntakeError("Read the narrative first: tick \"I've read the narrative\" in the ticket, then mark it ready.");
    }
    if (frame.scope === 'ticket' && (!approval.grantable || frame.decision !== 'approved')) {
      throw new IntakeError(approval.grantable ? 'Only an approval can be given for the whole ticket.' : 'This approval cannot be given for the whole ticket.');
    }
    if (approval.kind === 'question') {
      if (frame.decision !== 'answered' || !frame.answer) throw new IntakeError('A question needs a written answer.');
      this.log.append('orchestrator', 'elfoqsy.message', {
        messageId: ulid(),
        role: frame.test ? 'test' : 'you',
        text: frame.answer,
        ...(approval.conversationId ? { conversationId: approval.conversationId } : {}),
        refs: { approvalId: frame.approvalId, runId: approval.runId },
      });
    } else if (frame.decision === 'answered') {
      throw new IntakeError('This approval needs approve or deny.');
    }
    this.log.append('orchestrator', 'approval.resolved', {
      approvalId: frame.approvalId,
      decision: frame.decision,
      ...(frame.answer ? { answer: frame.answer } : {}),
      ...(frame.test ? { test: true as const } : {}),
      ...(frame.scope ? { scope: frame.scope } : {}),
      ...(frame.precedent && !frame.test && approval.precedentable ? { precedent: true as const } : {}),
    });
  }

  close(): void {
    this.unsubscribe();
  }

  private track(event: AnyEnvelope): void {
    if (event.type === 'conversation.created') this.conversations.add(event.payload.conversationId);
    else if (event.type === 'run.created') {
      this.runs.add(event.payload.runId);
      this.runTickets.set(event.payload.runId, event.payload.ticket);
    }
    else if (event.type === 'run.state_changed') {
      if (ENDED.has(event.payload.state)) this.runs.delete(event.payload.runId);
      if (event.payload.state === 'failed') this.failed.set(event.payload.runId, this.failed.get(event.payload.runId) ?? false);
      else this.failed.delete(event.payload.runId);
    } else if (event.type === 'run.dismissed') {
      if (this.failed.has(event.payload.runId)) this.failed.set(event.payload.runId, true);
    } else if (event.type === 'pr.synced') {
      const pr = event.payload.pr;
      const key = `${pr.repo}#${pr.number}`;
      this.prs.set(key, { ...this.prs.get(key), open: pr.state === 'open' || pr.state === 'draft', checksFailing: pr.checks === 'failure' });
    } else if (event.type === 'ci.status') {
      const key = `${event.payload.repo}#${event.payload.pr}`;
      const pr = this.prs.get(key) ?? { open: true, checksFailing: false };
      // The next CI result ends an acknowledgement of the last one.
      this.prs.set(key, { open: pr.open, checksFailing: pr.checksFailing, ci: { sha: event.payload.sha, status: event.payload.status } });
    } else if (event.type === 'ci.dismissed') {
      const pr = this.prs.get(`${event.payload.repo}#${event.payload.pr}`);
      if (pr) pr.dismissed = event.payload.sha;
    }
    else if (event.type === 'precedent.saved') this.precedents.add(event.payload.precedentId);
    else if (event.type === 'precedent.removed') this.precedents.delete(event.payload.precedentId);
    else if (event.type === 'change.recorded') {
      const p = event.payload;
      this.changes.set(p.recordId, { undoable: p.undo !== undefined, ...(p.noUndo ? { noUndo: p.noUndo } : {}), undone: false });
    } else if (event.type === 'change.undone') {
      const change = this.changes.get(event.payload.recordId);
      if (change) change.undone = true;
    } else if (event.type === 'approval.requested') {
      const { approvalId, runId, kind, grantable, precedentable, gate } = event.payload;
      this.approvals.set(approvalId, { runId, kind, resolved: false, grantable: grantable !== undefined, ...(precedentable ? { precedentable: true } : {}), ...(gate ? { gate } : {}) });
    } else if (event.type === 'approval.resolved') {
      const approval = this.approvals.get(event.payload.approvalId);
      if (approval) approval.resolved = true;
    } else if (event.type === 'elfoqsy.message' && event.payload.refs?.approvalId && event.payload.conversationId) {
      const approval = this.approvals.get(event.payload.refs.approvalId);
      if (approval && !approval.conversationId) approval.conversationId = event.payload.conversationId;
    }
  }
}
