// Elfoqsy's brain: one session per conversation, started when needed and closed after 20 idle minutes,
// at most three open (the least recently used idle one closes first). It routes what reaches her:
// alex's and the tester's messages to their conversation, with what they attached; workspace
// updates to the conversation of the ticket they are about, else the day's "Today" conversation; and
// an investigator's findings back to the conversation that asked.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, Attachment, Effort } from '@elfoqsy/contracts';
import type { AbilityAnnouncement, AbilityRevision } from '../abilities/engine';
import { conversationForTicket, todayConversation, type WorkspaceState } from '@elfoqsy/state';
import { answeredBy, CLOSED_ANSWERS } from '../agents/approvals';
import type { FinishedInvestigation } from '../agents/investigator';
import type { AttachmentStore } from '../attachments';
import { realClock, type Clock } from '../clock';
import type { UsageSnapshot, UsageState } from '../claude/usage';
import type { EventLog } from '../eventLog';
import { redact, type OutboundContext } from '../redact';
import type { Notice } from './notifier';
import type { Conversations } from './routing';
import { ElfoqsySession, REPORTS_HEADER, type QueryFn, type SessionOptions } from './session';
import { language } from './voice';
import type { SessionContext } from './tools';
import { join } from 'node:path';
import { copyAbilities } from '../skill/abilities';

const run = promisify(execFile);
/** Images up to this size go to her as they are (the API takes 5 MB once base64-encoded). */
const MAX_IMAGE = 3_750_000;
const MAX_TEXT = 30_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The usage meters are refreshed after a turn, at most this often (a read of the plan's usage, not a model call). */
const USAGE_EVERY_MS = 5 * 60_000;

export interface BrainOptions {
  log: EventLog;
  usage: UsageState;
  state: () => WorkspaceState;
  systemPrompt: string;
  /** Her tools for one conversation. */
  tools: (context: SessionContext) => McpSdkServerConfigWithInstance;
  conversations: Conversations;
  attachments?: AttachmentStore;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: Effort;
  /** The outgoing check that stands in front of her web (WebSearch, WebFetch); without it she has none. */
  outbound?: OutboundContext;
  /** The Abilities skills (data/skills), and where each conversation's read-only copy of them goes. Absent: no skills. */
  abilities?: { dir: string; copies: string };
  /** Her turns that loaded a skill, for the abilities engine. */
  abilityUses?: SessionOptions['abilityUses'];
  ticketKey: RegExp;
  queryFn: QueryFn;
  clock?: Clock;
  now?: () => number;
  maxOpen?: number;
  idleMinutes?: number;
  /** Which of the tester's images she may see: the repository's own pictures only. */
  testerImages?: { allows(file: string): boolean };
  /** Turns a PDF into text; pdftotext by default. */
  pdfText?: (file: string) => Promise<string>;
  /** Live events, for the agents' reports she is given in batches and acknowledges. */
  events?: { onEvent(listener: (previous: WorkspaceState, event: AnyEnvelope, next: WorkspaceState) => void): () => void };
}

/** What an agent reports to her through the orchestrator, besides what starts a turn of its own, and answers to its requests. */
const REPORTS = new Set(['run.goal_declared', 'run.step_begun', 'run.step_ended', 'run.heartbeat', 'run.check_changed', 'subagent.started', 'subagent.finished', 'approval.resolved', 'run.reminded']);
const CLOSED: readonly string[] = Object.values(CLOSED_ANSWERS);

/** The run a report is about; an answer is about the run that asked. */
const reportRun = (event: AnyEnvelope, s: WorkspaceState): string | undefined =>
  event.type === 'approval.resolved' ? s.approvals[event.payload.approvalId]?.runId : (event.payload as { runId?: string }).runId;
const MAX_REPORT_LINES = 40;

/** One report as a line for her. */
export function reportLine(event: AnyEnvelope, s: WorkspaceState): string | undefined {
  const runId = reportRun(event, s);
  const run = runId ? s.runs[runId] : undefined;
  if (!run) return undefined;
  const agent = `Agent ${run.agentNumber} (${run.ticket})`;
  switch (event.type) {
    case 'run.goal_declared':
      return `${agent} declared its goal${event.payload.revision > 1 ? ` again (revision ${event.payload.revision})` : ''}: ${event.payload.goal} [${event.payload.checks.length} checks]`;
    case 'run.step_begun':
      return `${agent} began step "${event.payload.name}": ${event.payload.why}`;
    case 'run.step_ended':
      return `${agent} ended step ${event.payload.stepIndex + 1} (${event.payload.outcome})${event.payload.note ? `: ${event.payload.note}` : ''}`;
    case 'run.heartbeat': {
      const p = event.payload;
      return `${agent} heartbeat on "${p.step}" (${p.progress} done): ${p.sinceLast} Next: ${p.next}${p.risks.length ? ` Risks: ${p.risks.join('; ')}` : ''}`;
    }
    case 'run.check_changed':
      return `${agent}: check ${event.payload.checkId} is ${event.payload.status}: ${event.payload.evidence}`;
    case 'subagent.started':
      return `${agent} started a sub-agent (${event.payload.model}, ${event.payload.effort}): ${event.payload.task}`;
    case 'subagent.finished':
      return `${agent}'s sub-agent ${event.payload.subagentId} ended ${event.payload.outcome}${event.payload.reason ? ` (${event.payload.reason})` : ''}: ${event.payload.result.slice(0, 200)}`;
    case 'run.reminded':
      return `The workspace reminded ${agent}: ${event.payload.text}`;
    case 'approval.resolved': {
      const p = event.payload;
      if (p.answer && CLOSED.includes(p.answer)) return undefined; // closed by the workspace; the run's end says why
      const did = p.decision === 'approved' ? 'approved' : p.decision === 'denied' ? 'declined' : 'answered';
      return `${answeredBy(p)} ${did} ${agent}'s request: ${s.approvals[p.approvalId]?.question ?? p.approvalId}${p.answer ? ` Their note: "${p.answer}"` : ''}`;
    }
    default:
      return undefined;
  }
}

export interface IncomingMessage {
  text: string;
  from: 'owner' | 'tester';
  conversationId?: string;
  attachments?: Attachment[];
}

async function pdftotext(file: string): Promise<string> {
  const { stdout } = await run('pdftotext', ['-q', '-enc', 'UTF-8', '-l', '50', file, '-'], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export class Elfoqsy {
  private readonly sessions = new Map<string, ElfoqsySession>();
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly maxOpen: number;
  private readonly idleMs: number;
  private timer: unknown;
  private usageReadAt = Number.NEGATIVE_INFINITY;
  /** Reports not yet given to her, by run. */
  private readonly reports = new Map<string, Array<{ seq: number; line: string }>>();
  private readonly stopEvents: (() => void) | undefined;

  constructor(private readonly o: BrainOptions) {
    this.clock = o.clock ?? realClock;
    this.now = o.now ?? (() => Date.now());
    this.maxOpen = o.maxOpen ?? 3;
    this.idleMs = (o.idleMinutes ?? 20) * 60_000;
    this.scheduleIdleCheck();
    this.stopEvents = o.events?.onEvent((_previous, event, next) => {
      if (!REPORTS.has(event.type)) return;
      const line = reportLine(event, next);
      const runId = reportRun(event, next);
      if (line && runId) this.reports.set(runId, [...(this.reports.get(runId) ?? []), { seq: event.seq, line }]);
    });
  }

  /**
   * The reports waiting for this conversation's runs, as the opening of her next turn there. Each one
   * given to her is acknowledged (run.ack); what she says about them is her reply.
   */
  private reportsFor(conversationId: string): string | undefined {
    const s = this.o.state();
    const today = todayConversation(this.now()).conversationId;
    const given: Array<{ runId: string; seq: number; line: string }> = [];
    for (const [runId, list] of this.reports) {
      const run = s.runs[runId];
      if ((conversationForTicket(s, run?.ticket, runId) ?? today) !== conversationId) continue;
      given.push(...list.map((r) => ({ runId, ...r })));
      this.reports.delete(runId);
    }
    if (!given.length) return undefined;
    given.sort((a, b) => a.seq - b.seq);
    for (const g of given) this.o.log.append('orchestrator', 'run.ack', { runId: g.runId, refEventSeq: g.seq });
    const shown = given.slice(-MAX_REPORT_LINES).map((g) => `- ${g.line}`);
    const earlier = given.length - shown.length;
    return `${REPORTS_HEADER}\n${earlier ? `- (${earlier} earlier reports)\n` : ''}${shown.join('\n')}`;
  }

  /** A message from alex or the tester, with what they attached. */
  async say(m: IncomingMessage): Promise<void> {
    const conversationId = m.conversationId ?? this.o.conversations.today();
    const attached = await this.attachmentContent(m.attachments ?? [], m.from);
    this.session(conversationId).say(m.text, m.from, attached, this.reportsFor(conversationId));
  }

  /** Workspace updates, each to the conversation of the ticket it is about, else Today's. */
  notify(notices: Notice[]): void {
    const byConversation = new Map<string, string[]>();
    for (const n of notices) {
      const id = this.o.conversations.for(n.ticket, n.runId);
      byConversation.set(id, [...(byConversation.get(id) ?? []), n.text]);
    }
    for (const [id, lines] of byConversation) this.session(id).notify(lines, this.reportsFor(id));
  }

  /** An investigator ended: its findings go back to the conversation that asked. */
  investigationFinished(f: FinishedInvestigation): void {
    const s = this.o.state();
    if (!s.conversations[f.conversationId]) return;
    const text = f.stopped
      ? `[Investigation stopped] ${f.investigationId}, on "${f.question}": ${f.stopped} Tell them in one line, and what you would do next.`
      : `[Investigation finished] ${f.investigationId}, on "${f.question}": ${f.title}\n${f.findings
          .map((x, i) => `${i + 1}. ${x.text} (${x.sources.map((src) => src.ref).join(', ')})`)
          .join('\n')}\nShow it with a findings block (ref ${f.investigationId}) and answer the question in one or two sentences.`;
    this.session(f.conversationId).inform(text, this.reportsFor(f.conversationId));
  }

  /** Something for her to do in a conversation, such as writing the weekly review. */
  inform(conversationId: string, text: string): void {
    this.session(conversationId).inform(text, this.reportsFor(conversationId));
  }

  /**
   * What the abilities engine learned (from a run's review, or from files it found), for her to say: a turn in the conversation it
   * belongs to, in which she writes the one line herself, in his language, and shows each ability's card. The workspace writes no
   * line of its own. Held while she is paused, like any turn.
   */
  announceAbilities(a: AbilityAnnouncement): void {
    const vi = language.current === 'vi';
    const found = (f: AbilityAnnouncement['abilities'][number]['finder']): string =>
      f.by === 'elfoqsy' ? 'you found it' : f.by === 'alex' ? 'alex asked for it' : `Agent ${f.agentNumber} found it${f.ticket ? ` on ${f.ticket}` : ''}`;
    const lines = a.abilities.map((x) => `- ${x.name}: "${x.title}" (Vietnamese: "${x.titleVi}"); about ${x.tool}; when to use it: ${x.whenToUse}; ${found(x.finder)}.`);
    const text = [
      a.updated ? '[Abilities updated] A new version of what you already had:' : `[Abilities learned] ${a.abilities.length === 1 ? 'You just learned an ability' : `You just learned ${a.abilities.length} abilities`}:`,
      ...lines,
      '',
      `Tell alex in one line, written by you in your own voice: what you can do now that you could not, as a sentence of your own, never an ability's title put after "I learned how to". He is writing to you in ${vi ? 'Vietnamese now: write in Vietnamese, tôi for yourself and cậu for him' : 'English now: write in English'}. Then show each ability as a card with show (a block of type ability, its name as ref). Say nothing else.`,
    ].join('\n');
    this.session(a.conversationId).inform(text, this.reportsFor(a.conversationId));
  }

  /**
   * The abilities with a sample too long for a card's line, handed to her to write shorter: the same abilities through write_ability
   * (update, quiet: no message of its own for each), the full commands in the skill's references, the reads of the steps as they are,
   * and one line from her at the end. Each is given whole, as stored, since an update is sent whole. True: it was handed to her.
   */
  reviseAbilities(r: AbilityRevision): boolean {
    const vi = language.current === 'vi';
    const stored = r.abilities.map(({ ability: a, long }) => {
      const { name, title, titleVi, tool, whenToUse, steps, doneWhen, track, references } = a;
      return [`- ${name} ("${title}"): ${long.join('; ')} (text + sample).`, JSON.stringify({ name, title, titleVi, tool, whenToUse, steps, ...(references ? { references } : {}), doneWhen, track })].join('\n');
    });
    const text = [
      `[Abilities to shorten] A card shows each step of an ability on one line: its text, then its sample beside it, in a column 520 px wide, so a step's text and sample together must come to about 450 px: about 6.5 px for each character of the text and 7.8 for each of the sample (a text of 40 characters leaves 24 characters for the sample). ${r.abilities.length === 1 ? 'This ability has' : `These ${r.abilities.length} abilities have`} a sample too long:`,
      '',
      ...stored,
      '',
      `For each one, send it again with write_ability, update: true and quiet: true: the same ability, with each sample that is too long written as short as it can be while it still runs (the program and its main argument), the full commands with their flags and what explains them in references (markdown), and every read step exactly as it is, so what verifies it does not change. Leave a step as it is when it cannot be shorter, and change nothing else. A quiet update has no message of its own: when you have done them all, tell alex in one line, written by you in your own voice, what you did and why it helps. He is writing to you in ${vi ? 'Vietnamese now: write in Vietnamese, tôi for yourself and cậu for him' : 'English now: write in English'}.`,
    ].join('\n');
    this.session(r.conversationId).inform(text, this.reportsFor(r.conversationId));
    return true;
  }

  /** His plan's usage, read through any open session. */
  async usageSnapshot(): Promise<UsageSnapshot | undefined> {
    for (const s of this.sessions.values()) if (s.isOpen) return s.usageSnapshot();
    return undefined;
  }

  close(): void {
    this.stopEvents?.();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /** The conversation's session, opened if needed; the least recently used idle one closes past the cap. */
  private session(conversationId: string): ElfoqsySession {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const open = [...this.sessions.values()];
    if (open.length >= this.maxOpen) {
      const idle = open.filter((s) => !s.busy).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (idle) this.drop(idle);
    }
    const abilities = this.o.abilities ? (copyAbilities(this.o.abilities.dir, join(this.o.abilities.copies, conversationId)) ?? undefined) : undefined;
    const s = new ElfoqsySession({
      conversationId,
      log: this.o.log,
      usage: this.o.usage,
      state: this.o.state,
      systemPrompt: this.o.systemPrompt,
      mcpServer: this.o.tools,
      cwd: this.o.cwd,
      env: this.o.env,
      ...(this.o.model ? { model: this.o.model } : {}),
      ...(this.o.effort ? { effort: this.o.effort } : {}),
      ...(this.o.outbound ? { outbound: this.o.outbound } : {}),
      ...(abilities ? { abilities } : {}),
      ...(this.o.abilityUses ? { abilityUses: this.o.abilityUses } : {}),
      ticketKey: this.o.ticketKey,
      queryFn: this.o.queryFn,
      clock: this.clock,
      now: this.now,
      onTurnEnd: (done) => this.refreshUsage(done),
    });
    this.sessions.set(conversationId, s);
    return s;
  }

  /** Keeps the left screen's usage meters current while she works. */
  private refreshUsage(s: ElfoqsySession): void {
    if (this.now() - this.usageReadAt < USAGE_EVERY_MS) return;
    this.usageReadAt = this.now();
    void s.usageSnapshot().then((snap) => {
      if (snap) this.o.usage.record(snap);
    });
  }

  private drop(s: ElfoqsySession): void {
    s.close();
    this.sessions.delete(s.conversationId);
  }

  private scheduleIdleCheck(): void {
    this.timer = this.clock.setTimeout(() => {
      for (const s of [...this.sessions.values()]) if (!s.busy && this.now() - s.lastActive >= this.idleMs) this.drop(s);
      this.scheduleIdleCheck();
    }, 60_000);
  }

  /**
   * What she is given of each attachment. Images alex attached go as they are (read from the
   * workspace's folder; the event log only names them). A tester's image goes only when it is one of the
   * repository's own pictures, otherwise it is named. PDFs and text
   * go as redacted text.
   */
  private async attachmentContent(attachments: Attachment[], from: 'owner' | 'tester'): Promise<ContentBlockParam[]> {
    const blocks: ContentBlockParam[] = [];
    const store = this.o.attachments;
    for (const a of attachments) {
      const found = store?.get(a.attachmentId);
      const label = `${a.name} (${a.mediaType})`;
      if (!found) {
        blocks.push({ type: 'text', text: `[Attached ${label}: it is no longer in the workspace]` });
      } else if (IMAGE_TYPES.has(a.mediaType)) {
        const fixture = from === 'tester' && !!this.o.testerImages?.allows(found.file);
        if (from !== 'owner' && !fixture) {
          blocks.push({ type: 'text', text: `[The tester attached the image ${label}; from the tester you are shown only the repository's own pictures (assets, prototypes)]` });
        } else if (a.bytes > MAX_IMAGE) blocks.push({ type: 'text', text: `[Attached image ${label} is too large for you to see]` });
        else {
          blocks.push({ type: 'text', text: fixture ? `[The tester attached image ${a.name}, one of the repository's own pictures]` : `[Attached image ${a.name}]` });
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: readFileSync(found.file).toString('base64') },
          });
        }
      } else if (a.mediaType === 'application/pdf') {
        try {
          const text = redact(await (this.o.pdfText ?? pdftotext)(found.file)).trim();
          blocks.push({ type: 'text', text: `[Attached PDF ${a.name}, as text]\n${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut]` : text || '(no text in it)'}` });
        } catch {
          blocks.push({ type: 'text', text: `[Attached PDF ${a.name}: its text could not be read here]` });
        }
      } else {
        const text = redact(readFileSync(found.file, 'utf8'));
        blocks.push({ type: 'text', text: `[Attached ${label}]\n${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut]` : text}` });
      }
    }
    return blocks;
  }
}
