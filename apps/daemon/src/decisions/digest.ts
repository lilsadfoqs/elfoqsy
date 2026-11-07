// "I decided N things while you were away". When alex comes back after AWAY_MS with nothing from him (no
// message, answer, pane action or setting), and Elfoqsy decided things for agents meanwhile, the orchestrator lists them
// for him in her voice, in the conversation he came back to (else Today's), before her reply. No Claude turn.
// He can also open it any time: what she decided since his last digest, at once. A digest the tester opens is
// marked as the tester's, and his own digests still list those decisions. With his own digest comes what happened in
// Jira since his last digest or Jira news; Jira news never goes back more than 72 hours.
// In the language of his latest message (18 October): English, or Vietnamese with tôi and cậu. When it is his message that brings him
// back, that message's language is the one, whichever subscriber of the log saw it first.
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { activeRuns, type WorkspaceState } from '@elfoqsy/state';
import { unanswered } from '../agents/approvals';
import type { EventLog } from '../eventLog';
import { inLanguage, langField, language, languageOf, tr } from '../elfoqsy/voice';
import { ulid } from '../ulid';

/** Away means this long with nothing from him (plan v1.3, question 5). */
export const AWAY_MS = 30 * 60_000;
/** The furthest back Jira news goes, when he comes back or opens the digest: a Monday digest still includes Friday. */
export const NEWS_MAX_MS = 72 * 3600_000;

const NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const count = (n: number, one: string, many: string): string => `${NUMBERS[n] ?? n} ${n === 1 ? one : many}`;
/** Vietnamese has no plural: "2 run", "1 câu hỏi". */
const dem = (n: number, noun: string): string => `${n} ${noun}`;

/** Something he did himself; the tester's actions never count. */
export function hisActivity(e: AnyEnvelope): string | undefined {
  switch (e.type) {
    case 'elfoqsy.message':
      return e.payload.role === 'you' ? e.payload.conversationId ?? '' : undefined;
    case 'approval.resolved':
      return !e.payload.test && !e.payload.withdrawn && !unanswered({ decision: e.payload.decision, ...(e.payload.answer ? { answer: e.payload.answer } : {}) }) ? '' : undefined;
    case 'run.guidance':
    case 'run.paused':
    case 'run.resumed':
    case 'run.dismissed':
    case 'change.undone':
    case 'decision.changed':
    case 'delegation.set':
    case 'precedent.removed':
    case 'workspace.setting':
    case 'ci.dismissed':
      return 'by' in e.payload && e.payload.by === 'you' ? '' : undefined;
    default:
      return undefined;
  }
}

export interface DigestDeps {
  log: EventLog;
  state: () => WorkspaceState;
  /** Today's conversation, made if needed. */
  today: () => string;
  awayMs?: number;
  /** He came back after being away: Jira news since then, in the conversation he came back to. */
  onBack?: (since: number, conversationId: string) => void;
  /** He opened the digest himself: Jira news since then, after the digest, in the same conversation. */
  onAsked?: (since: number, conversationId: string) => void;
}

export class Digests {
  private lastSeen: number | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly d: DigestDeps) {
    for (const e of d.log.readFrom(0, 10_000_000)) if (hisActivity(e) !== undefined) this.lastSeen = Date.parse(e.ts);
    this.unsubscribe = d.log.subscribe((e) => this.onEvent(e));
  }

  close(): void {
    this.unsubscribe();
  }

  private onEvent(e: AnyEnvelope): void {
    const where = hisActivity(e);
    if (where === undefined) return;
    const at = Date.parse(e.ts);
    const since = this.lastSeen;
    this.lastSeen = at;
    if (since === undefined || at - since < (this.d.awayMs ?? AWAY_MS)) return;
    const conversationId = where || this.d.today();
    // His message brings him back: its own language, when it says one, else the one before it.
    const spoken = e.type === 'elfoqsy.message' ? languageOf(e.payload.text) : undefined;
    inLanguage(spoken ?? language.current, () => {
      this.post(since, conversationId);
      this.d.onBack?.(Math.max(since, at - NEWS_MAX_MS), conversationId);
    });
  }

  /** Her decisions not yet in one of his digests, oldest first; made since `since`, when given. */
  private unlisted(since?: number) {
    const s = this.d.state();
    const listed = new Set(Object.values(s.digests).filter((g) => !g.test).flatMap((g) => g.decisionIds));
    return Object.values(s.decisions)
      .filter((x) => (since === undefined || x.at >= since) && !listed.has(x.decisionId))
      .sort((a, b) => a.at - b.at);
  }

  /** The decisions made since he was last here and not listed yet, in one message. */
  private post(since: number, conversationId: string): void {
    const decisions = this.unlisted(since);
    if (!decisions.length) return;
    const { runs, open } = this.moved(since);
    const runsText = runs
      ? tr(`${count(runs, 'run', 'runs')} moved on while you were away`, `${dem(runs, 'run')} đã chạy tiếp trong lúc cậu vắng mặt`)
      : tr('Nothing moved on while you were away', 'Không run nào chạy tiếp trong lúc cậu vắng mặt');
    this.list(conversationId, decisions, since, `${runsText}; ${this.openText(open)}.`);
  }

  /**
   * He (or the tester) opened the digest: what she decided since his last digest, listed now in this
   * conversation, or one line saying there is nothing new. Opening it counts as his being here.
   */
  open(conversationId: string | undefined, by: 'you' | 'tester'): void {
    const where = conversationId ?? this.d.today();
    const s = this.d.state();
    const last = Object.values(s.digests)
      .filter((g) => !g.test)
      .reduce<number | undefined>((t, g) => (t === undefined || g.at > t ? g.at : t), undefined);
    const decisions = this.unlisted();
    const test = by === 'tester' ? { test: true as const } : {};
    // Jira news goes back to his last digest or news, whichever is later; the tester's digests have none.
    const news = (now: number) => {
      if (by !== 'you' || !this.d.onAsked) return;
      const seen = Math.max(last ?? 0, ...Object.values(s.jiraNews).map((n) => n.at));
      this.d.onAsked(Math.max(seen, now - NEWS_MAX_MS), where);
    };
    if (!decisions.length) {
      const e = this.d.log.append('orchestrator', 'elfoqsy.message', {
        messageId: ulid(),
        role: 'elfoqsy',
        text:
          last === undefined
            ? tr('I have not decided anything for you yet.', 'Tôi chưa quyết gì thay cậu cả.')
            : tr(`I have decided nothing since your last digest, at ${hhmm(last)}.`, `Từ digest lần trước của cậu, lúc ${hhmm(last)}, tôi chưa quyết gì.`),
        conversationId: where,
      });
      if (by === 'you') this.lastSeen = Date.parse(e.ts);
      news(Date.parse(e.ts));
      return;
    }
    const since = last ?? decisions[0]!.at;
    const { runs, open } = this.moved(since);
    const sinceWords = last === undefined ? tr('then', 'lúc đó') : tr('your last digest', 'digest lần trước của cậu');
    const runsText = runs
      ? tr(`${count(runs, 'run', 'runs')} moved on since ${sinceWords}`, `${dem(runs, 'run')} đã chạy tiếp từ ${sinceWords}`)
      : tr(`Nothing moved on since ${sinceWords}`, `Không run nào chạy tiếp từ ${sinceWords}`);
    const at = this.list(where, decisions, since, `${runsText}; ${this.openText(open)}.`, { asked: true, ...test });
    if (by === 'you') this.lastSeen = at;
    news(at);
  }

  private openText(open: number): string {
    return open
      ? tr(`${count(open, 'question is', 'questions are').toLowerCase()} yours`, `${dem(open, 'câu hỏi')} đang chờ cậu`)
      : tr('nothing is waiting for you', 'không có gì đang chờ cậu');
  }

  /** Runs that moved since then, and questions of active runs still waiting for him. */
  private moved(since: number): { runs: number; open: number } {
    const s = this.d.state();
    const moved = new Set(
      this.d.log
        .readFrom(0, 10_000_000, ['run.step_begun', 'run.state_changed', 'run.verdict', 'tool.finished'])
        .filter((e) => Date.parse(e.ts) >= since)
        .map((e) => (e.payload as { runId: string }).runId),
    );
    const runs = Object.values(s.runs).filter((r) => moved.has(r.runId)).length;
    const open = Object.values(s.approvals).filter((a) => !a.resolution && activeRuns(s).some((r) => r.runId === a.runId)).length;
    return { runs, open };
  }

  /** The digest and her line with it. Returns when it was written. */
  private list(conversationId: string, decisions: Array<{ decisionId: string }>, since: number, text: string, marks: { asked?: true; test?: true } = {}): number {
    const digestId = `dig-${ulid().toLowerCase()}`;
    this.d.log.append('orchestrator', 'decisions.digested', { digestId, conversationId, decisionIds: decisions.map((x) => x.decisionId), awaySince: new Date(since).toISOString(), ...marks, ...langField() });
    const e = this.d.log.append('orchestrator', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      text,
      conversationId,
      blocks: [{ type: 'digest', ref: digestId }],
    });
    return Date.parse(e.ts);
  }
}

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
