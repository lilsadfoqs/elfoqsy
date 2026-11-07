// The weekly review. At the first daemon start on or after Monday 09:00, if that Monday
// has no review yet, the week's numbers are computed from the log and Elfoqsy writes the review in its own
// conversation in one turn: what worked, what wasted time or tokens, at most three suggestions. It covers
// the time since the last review (the last seven days the first time), so nothing is counted twice.
//
// At each start, recorded reviews are also computed again from the log as it stood at their period's end.
// When the numbers differ (the analytics were fixed since), the orchestrator posts the corrected review
// under it, in her voice and without a Claude turn, and withdraws the suggestions that rested on them.
import { currentReviews, SHOP_DEV_BASELINE, periodStats, reviewRef, type PeriodStats, type Rate, type ReviewView, type WorkspaceState } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';
import { tr } from './voice';
import { ulid } from '../ulid';

const DAY = 24 * 3600_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isoDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayMonth = (ms: number): string => `${new Date(ms).getDate()} ${MONTHS[new Date(ms).getMonth()]}`;

/** The latest Monday 09:00, local time, at or before `now`: the review it is due for, as YYYY-MM-DD. */
export function reviewDue(now: number): { weekOf: string; dueAt: number } {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7; // Monday 0 ... Sunday 6
  d.setDate(d.getDate() - sinceMonday);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return { weekOf: isoDay(d), dueAt: d.getTime() };
}

const pct = (r: Rate) => `${Math.round(r.successRate * 100)}%`;
const rateLine = (rates: Rate[]) => rates.map((r) => `${r.key}: ${r.done} done, ${r.failed} failed, ${r.cancelled} cancelled (${pct(r)})`).join('; ') || 'none';

/** The turn that asks her to write it: the numbers, then what to write. */
export function reviewPrompt(weekOf: string, p: PeriodStats): string {
  const m = p.metrics;
  const tokens = m.tokens! >= 1_000_000 ? `${(m.tokens! / 1_000_000).toFixed(1)}M` : `${Math.round(m.tokens! / 1000)}k`;
  return [
    `[Weekly review] Due Monday ${dayMonth(reviewDue(p.to).dueAt)}; it covers ${dayMonth(p.from)} to ${dayMonth(p.to)}.`,
    `Runs: ${m.runs} (${m.succeeded} succeeded, ${m.stopped} stopped, ${m.failed} failed, ${m.cancelled} cancelled, ${m.stillActive} still active; ${m.dismissed} failures dismissed).`,
    `Tokens ${tokens}; working ${m.workingMinutes} min, waiting for alex ${m.waitingMinutes} min, paused ${m.pausedMinutes} min.`,
    `Sub-agents: ${m.subagents} (${m.subagentsFailed} failed, ${m.subagentsCancelled} cancelled). By model and effort: ${rateLine(p.subagentsByModel)}. By kind of task: ${rateLine(p.subagentsByKind)}.`,
    `CI failures ${m.ciFailures}, retries ${m.retries}, plan changes ${m.planChanges}, check changes ${m.checkChanges}, interventions ${m.interventions}, checks without evidence at the end ${m.evidenceMissing}.`,
    `Slowest steps: ${p.slowestSteps.map((s) => `${s.ticket} "${s.name}" ${s.minutes} min`).join('; ') || 'none'}.`,
    `Interventions by ticket: ${Object.entries(p.interventionsByTicket).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`,
    `Per ticket, measured as alex's team-dev retrospective measured it (active hours: gaps of 30 minutes or less; interventions: his guidance, pauses, answers and messages): ${p.tickets.map((t) => `${t.ticket} ${t.activeHours} h, ${t.interventions}`).join('; ') || 'none'}. Average ${m.activeHoursPerTicket} h and ${m.interventionsPerTicket} interventions per ticket; the baseline, ${SHOP_DEV_BASELINE.tickets.length} tickets with the skill alone (${SHOP_DEV_BASELINE.source}), is ${m.baselineHoursPerTicket} h and ${m.baselineInterventionsPerTicket}.`,
    '',
    `Write the weekly review here: what worked, what wasted time or tokens, and at most three concrete suggestions, each with the number behind it. Call record_review with weekOf ${weekOf} and the suggestions, then show the review block (ref ${weekOf}) under at most two sentences. With little to go on, say so plainly and suggest nothing you cannot back with a number.`,
  ].join('\n');
}

export class WeeklyReview {
  /** Reviews asked for and not yet recorded: their numbers, by weekOf. */
  private readonly waiting = new Map<string, Record<string, number>>();

  constructor(
    private readonly d: {
      log: EventLog;
      state: () => WorkspaceState;
      /** Gives her the turn in the review's conversation. */
      ask: (conversationId: string, text: string) => void;
      now?: () => number;
    },
  ) {}

  /** For record_review. */
  pending(weekOf: string): Record<string, number> | undefined {
    return this.waiting.get(weekOf);
  }

  done(weekOf: string): void {
    this.waiting.delete(weekOf);
  }

  /** At start: asks for the review that is due, once. Returns its weekOf when it did. */
  /**
   * Checks every hour while the daemon runs, so Monday's review does not wait for a restart. Returns the stop.
   * clock: the timers to use; the real ones unless a test says.
   */
  watch(clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void }, everyMs = 3600_000): () => void {
    let timer: unknown;
    const tick = () => {
      this.runIfDue();
      timer = clock.setTimeout(tick, everyMs);
    };
    timer = clock.setTimeout(tick, everyMs);
    return () => clock.clearTimeout(timer);
  }

  runIfDue(): string | undefined {
    const now = this.d.now?.() ?? Date.now();
    const { weekOf } = reviewDue(now);
    const s = this.d.state();
    if (s.reviews.some((r) => r.weekOf === weekOf) || this.waiting.has(weekOf)) return undefined;
    const last = [...currentReviews(s)].sort((a, b) => b.at - a.at)[0];
    const from = Math.max(now - 14 * DAY, Math.min(now - DAY, last?.metrics.periodEnd ?? now - 7 * DAY));
    const stats = periodStats(this.d.log.readFrom(0, 10_000_000), from, now);
    const conversationId = `review-${weekOf}`;
    if (!s.conversations[conversationId]) {
      this.d.log.append('orchestrator', 'conversation.created', { conversationId, title: `Weekly review, ${dayMonth(from)} to ${dayMonth(now)}` });
    }
    this.waiting.set(weekOf, stats.metrics);
    this.d.ask(conversationId, reviewPrompt(weekOf, stats));
    return weekOf;
  }

  /** At start: corrects each recorded review whose numbers the log no longer gives. Returns the weeks corrected. */
  correctStale(): string[] {
    const events = this.d.log.readFrom(0, 10_000_000);
    const corrected: string[] = [];
    for (const review of currentReviews(this.d.state())) {
      const { periodStart: from, periodEnd: to } = review.metrics;
      if (from === undefined || to === undefined) continue;
      // The log as it stood when the period ended, so later runs and restarts change nothing.
      const fresh = periodStats(events.filter((e) => Date.parse(e.ts) <= to), from, to).metrics;
      const changed = Object.keys(review.metrics).filter((k) => fresh[k] !== undefined && fresh[k] !== review.metrics[k]);
      if (!changed.length) continue;
      const { kept, withdrawn } = recheck(review.suggestions, review.metrics, changed);
      const revision = review.revision + 1;
      this.d.log.append('orchestrator', 'review.corrected', { weekOf: review.weekOf, revision, metrics: fresh, suggestions: kept, withdrawn: withdrawn.map((i) => review.suggestions[i]!) });
      this.d.log.append('orchestrator', 'elfoqsy.message', {
        messageId: ulid(),
        role: 'elfoqsy',
        conversationId: review.conversationId,
        text: correctionText(review, fresh, changed, withdrawn),
        blocks: [{ type: 'review', ref: reviewRef(review.weekOf, revision) }],
      });
      corrected.push(review.weekOf);
    }
    return corrected;
  }
}

/**
 * Which suggestions still stand, by index. A suggestion rests on the numbers it cites; it is withdrawn when
 * one of them was a figure that changed and is no other figure of the review, so it can only mean that one.
 */
export function recheck(suggestions: string[], old: Record<string, number>, changed: string[]): { kept: string[]; withdrawn: number[] } {
  const was = new Set(changed.map((k) => old[k]));
  const stays = new Set(Object.keys(old).filter((k) => !changed.includes(k)).map((k) => old[k]));
  const rests = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).some((n) => was.has(n) && !stays.has(n));
  const withdrawn = suggestions.flatMap((text, i) => (rests(text) ? [i] : []));
  return { kept: suggestions.filter((_, i) => !withdrawn.includes(i)), withdrawn };
}

/** Each figure as the review block words it. */
const FIGURES: Record<string, string> = {
  runs: 'runs',
  succeeded: 'succeeded',
  stopped: 'stopped',
  failed: 'failed',
  cancelled: 'cancelled',
  stillActive: 'still active',
  dismissed: 'failures dismissed',
  workingMinutes: 'min working',
  waitingMinutes: 'min waiting for you',
  pausedMinutes: 'min paused',
  subagents: 'sub-agents',
  subagentsFailed: 'sub-agents failed',
  subagentsCancelled: 'sub-agents cancelled',
  ciFailures: 'CI failures',
  retries: 'retries',
  planChanges: 'plan changes',
  checkChanges: 'check changes',
  interventions: 'interventions',
  evidenceMissing: 'checks without evidence',
  ticketsWorked: 'tickets worked',
  activeHours: 'active hours',
  activeHoursPerTicket: 'active hours per ticket',
  interventionsPerTicket: 'interventions per ticket',
};
/** The same, in Vietnamese. */
const FIGURES_VI: Record<string, string> = {
  runs: 'run',
  succeeded: 'thành công',
  stopped: 'đã dừng',
  failed: 'thất bại',
  cancelled: 'đã hủy',
  stillActive: 'còn đang chạy',
  dismissed: 'lỗi đã bỏ qua',
  workingMinutes: 'phút làm việc',
  waitingMinutes: 'phút chờ cậu',
  pausedMinutes: 'phút tạm dừng',
  subagents: 'sub-agent',
  subagentsFailed: 'sub-agent thất bại',
  subagentsCancelled: 'sub-agent bị hủy',
  ciFailures: 'lần CI lỗi',
  retries: 'lần thử lại',
  planChanges: 'lần đổi kế hoạch',
  checkChanges: 'lần đổi check',
  interventions: 'lần can thiệp',
  evidenceMissing: 'check thiếu bằng chứng',
  ticketsWorked: 'ticket đã làm',
  activeHours: 'giờ làm việc',
  activeHoursPerTicket: 'giờ làm việc mỗi ticket',
  interventionsPerTicket: 'lần can thiệp mỗi ticket',
};
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const ORDINALS_VI = ['đầu tiên', 'thứ hai', 'thứ ba', 'thứ tư', 'thứ năm'];
const MAX_FIGURES = 4;

const tokensLabel = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const figure = (key: string, n: number): string => (key === 'tokens' ? `${tokensLabel(n)} tokens` : `${n} ${tr(FIGURES[key], FIGURES_VI[key]) ?? key}`);
const figureValue = (key: string, n: number): string => (key === 'tokens' ? tokensLabel(n) : String(n));
const andList = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${tr('and', 'và')} ${items.at(-1)}`);

/** Her words above the corrected review: the right figures, and what she withdrew. About 40 words. */
export function correctionText(review: ReviewView, fresh: Record<string, number>, changed: string[], withdrawn: number[]): string {
  const shown = changed.slice(0, MAX_FIGURES).map((k) => `${figure(k, fresh[k]!)} (${tr('not', 'không phải')} ${figureValue(k, review.metrics[k]!)})`);
  const more = changed.length - shown.length;
  const figures = andList(more > 0 ? [...shown, tr(`${more} other figure${more === 1 ? '' : 's'}`, `${more} con số khác`)] : shown);
  const which = andList(withdrawn.map((i) => tr(ORDINALS[i] ?? `number ${i + 1}`, ORDINALS_VI[i] ?? `số ${i + 1}`)));
  const after = withdrawn.length
    ? tr(
        `I've withdrawn my ${which} suggestion${withdrawn.length === 1 ? '' : 's'}, which rested on the old numbers; the corrected review is below.`,
        `Tôi đã rút gợi ý ${which} của mình, vì nó dựa trên các số cũ; bản review đã sửa nằm bên dưới.`,
      )
    : tr('The suggestions still stand; the corrected review is below.', 'Các gợi ý vẫn đúng; bản review đã sửa nằm bên dưới.');
  return tr(`A correction to this review: the right figures are ${figures}. ${after}`, `Một điều chỉnh cho bản review này: các con số đúng là ${figures}. ${after}`);
}
