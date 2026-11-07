// One view of Alex's Claude usage, shared by Elfoqsy's session and every agent run. When Claude
// refuses work (usage or rate limit, or the login), everything pauses together, the log records it
// once (usage.limit), Elfoqsy says so once, and work resumes once: at the reset time if known, else
// when Alex writes. Nothing retries in a loop.
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { realClock, type Clock } from '../clock';
import type { PayloadOf } from '@elfoqsy/contracts';
import type { EventLog } from '../eventLog';
import { tr } from '../elfoqsy/voice';
import { ulid } from '../ulid';

export interface UsageWindow {
  /** Percent of the window used, 0 to 100. */
  utilization: number | null;
  resetsAt?: number;
}

export interface UsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  status?: SDKRateLimitInfo['status'];
  at: number;
}

export type PauseKind = 'limit' | 'login';

const RESUME_MARGIN_MS = 30_000;
const toMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

export class UsageState {
  private paused: { kind: PauseKind; until?: number } | undefined;
  private timer: unknown;
  private readonly listeners = new Set<(paused: boolean) => void>();
  /** Where a pause is announced: the day's "Today" conversation once Elfoqsy runs per conversation. */
  conversation: (() => string) | undefined;
  /** The latest windows seen on rate-limit events from any session, or from the usage call. */
  latest: UsageSnapshot | undefined;
  private published: PayloadOf<'usage.status'> | undefined;

  constructor(
    private readonly log: EventLog,
    private readonly clock: Clock = realClock,
    private readonly now: () => number = Date.now,
  ) {}

  get isPaused(): boolean {
    return this.paused !== undefined;
  }

  /** When a pause for the limit ends, when Claude said. */
  get pausedUntil(): number | undefined {
    return this.paused?.until;
  }

  /** The reset time we are waiting for, when Claude told us one. */
  get lastResetsAt(): number | undefined {
    return this.latest?.fiveHour?.resetsAt ?? this.latest?.sevenDay?.resetsAt;
  }

  onChange(listener: (paused: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Picks up a pause recorded in the log before a restart. */
  restore(state: { state: 'limited' | 'ok'; until?: number; reason?: string }): void {
    if (state.state !== 'limited') return;
    this.paused = { kind: state.reason === 'login' ? 'login' : 'limit', ...(state.until !== undefined ? { until: state.until } : {}) };
    this.schedule();
  }

  /** Records what a rate_limit_event says, and pauses when Claude rejected the request. */
  observe(info: SDKRateLimitInfo): void {
    const window: UsageWindow = {
      utilization: info.utilization === undefined ? null : info.utilization <= 1 ? info.utilization * 100 : info.utilization,
      ...(info.resetsAt ? { resetsAt: toMs(info.resetsAt) } : {}),
    };
    const isWeekly = info.rateLimitType?.startsWith('seven_day') ?? false;
    this.latest = {
      ...this.latest,
      ...(isWeekly ? { sevenDay: window } : { fiveHour: window }),
      status: info.status,
      at: this.now(),
    };
    this.publish();
    if (info.status === 'rejected') this.limit('limit', info.rateLimitType ?? 'rate_limit', window.resetsAt);
  }

  /** Takes in a snapshot from the usage call (both windows at once). */
  record(snapshot: UsageSnapshot): void {
    this.latest = {
      ...this.latest,
      ...(snapshot.fiveHour ? { fiveHour: snapshot.fiveHour } : {}),
      ...(snapshot.sevenDay ? { sevenDay: snapshot.sevenDay } : {}),
      ...(snapshot.status ? { status: snapshot.status } : {}),
      at: snapshot.at,
    };
    this.publish();
  }

  /** usage.status for the left screen's meters, when a whole percent or a reset time changed. */
  private publish(): void {
    const five = this.latest?.fiveHour;
    const seven = this.latest?.sevenDay;
    if (five?.utilization == null && seven?.utilization == null) return;
    const pct = (u: number | null | undefined, before: number | undefined) => (u == null ? (before ?? 0) : Math.max(0, Math.min(100, Math.round(u))));
    const next = {
      fiveHourPct: pct(five?.utilization, this.published?.fiveHourPct),
      sevenDayPct: pct(seven?.utilization, this.published?.sevenDayPct),
      ...(five?.resetsAt ? { resetsAt: new Date(five.resetsAt).toISOString() } : {}),
      ...(seven?.resetsAt ? { sevenDayResetsAt: new Date(seven.resetsAt).toISOString() } : {}),
    };
    if (this.published && JSON.stringify(this.published) === JSON.stringify(next)) return;
    this.published = next;
    this.log.append('orchestrator', 'usage.status', next);
  }

  /** Pause all new work, once. */
  limit(kind: PauseKind, reason: string, until?: number): void {
    if (this.paused) return;
    this.paused = { kind, ...(until !== undefined ? { until } : {}) };
    this.log.append('orchestrator', 'usage.limit', {
      state: 'limited',
      since: new Date(this.now()).toISOString(),
      ...(until !== undefined ? { until: new Date(until).toISOString() } : {}),
      reason: kind === 'login' ? 'login' : reason,
    });
    const at = until !== undefined ? new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : undefined;
    const conversationId = this.conversation?.();
    this.log.append('orchestrator', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      ...(conversationId ? { conversationId } : {}),
      text:
        kind === 'login'
          ? tr('My Claude login stopped working. Run `claude auth login`, then write to me.', 'Đăng nhập Claude của tôi không còn hoạt động. Cậu chạy `claude auth login`, rồi nhắn cho tôi.')
          : at
            ? tr(`I've hit the Claude usage limit. I'll pick up again at ${at}.`, `Tôi đã chạm giới hạn dùng Claude. Tôi sẽ làm tiếp lúc ${at}.`)
            : tr(`I've hit the Claude usage limit. I'll stay paused until you write to me.`, 'Tôi đã chạm giới hạn dùng Claude. Tôi sẽ tạm dừng cho tới khi cậu nhắn cho tôi.'),
    });
    this.schedule();
    this.emit(true);
  }

  /** Alex wrote: a pause with no known end gets one new attempt. */
  ownerWrote(): void {
    if (this.paused && this.paused.until === undefined) this.resume();
  }

  close(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.paused?.until === undefined) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.resume(), Math.max(0, this.paused.until - this.now()) + RESUME_MARGIN_MS);
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = undefined;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.log.append('orchestrator', 'usage.limit', { state: 'ok', since: new Date(this.now()).toISOString() });
    this.emit(false);
  }

  private emit(paused: boolean): void {
    for (const listener of this.listeners) listener(paused);
  }
}
