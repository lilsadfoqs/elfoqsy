// Watching alex's AWS sessions, one per environment's profile. They are SSO role sessions he pastes into
// ~/.aws/credentials: they last about 4 to 8 hours and say nothing about when they end. So once an hour the daemon makes
// a harmless call with each profile (sts get-caller-identity), and an AWS error that says a session ran out marks it
// expired at once. While one is expired, calls that need it wait (their runs pause) instead of failing, Elfoqsy asks him
// once to paste a fresh one, and the daemon checks every minute until it works again.
import type { PayloadOf } from '@elfoqsy/contracts';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import { tr } from '../elfoqsy/voice';

/** How often each profile is checked while it works. */
export const AWS_CHECK_MS = 60 * 60_000;
/** How often an expired profile is checked, to see his refresh. */
export const AWS_RECHECK_MS = 60_000;

type State = PayloadOf<'aws.session'>['state'];

/** What sts get-caller-identity said: the session works, it ran out, or something else failed (network, no profile). */
export type ProbeResult = 'ok' | 'expired' | 'error';

export interface AwsSessionOptions {
  log: EventLog;
  /** The profiles to watch, by environment. */
  profiles: Array<{ environment: string; profile: string }>;
  /** A harmless AWS call with one profile. */
  probe: (profile: string) => Promise<ProbeResult>;
  /** Elfoqsy's one message asking for a refresh. */
  ask: (text: string) => void;
  clock?: Clock;
}

interface Session {
  environment: string;
  profile: string;
  state: State;
  /** Asked about this expiry already. */
  asked: boolean;
  waiters: Array<() => void>;
  timer?: unknown;
}

export class AwsSession {
  private readonly sessions = new Map<string, Session>();
  private readonly clock: Clock;
  private stopped = false;

  constructor(private readonly o: AwsSessionOptions) {
    this.clock = o.clock ?? realClock;
    for (const p of o.profiles) this.sessions.set(p.environment, { ...p, state: 'unknown', asked: false, waiters: [] });
  }

  /** Checks every profile once, then hourly. */
  async start(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.check(s)));
  }

  /** Usable: not known to have run out. An environment without a watched profile is always usable. */
  fresh(environment?: string): boolean {
    const s = environment ? this.sessions.get(environment) : undefined;
    return !s || s.state !== 'expired';
  }

  /** Each watched environment's state. */
  get current(): Record<string, State> {
    return Object.fromEntries([...this.sessions.values()].map((s) => [s.environment, s.state]));
  }

  /** Resolves once the environment's session works: at once if it does. The first wait for an expiry asks him. */
  whenFresh(environment?: string): Promise<void> {
    const s = environment ? this.sessions.get(environment) : undefined;
    if (!s || s.state !== 'expired') return Promise.resolve();
    this.askOnce(s);
    return new Promise((resolve) => s.waiters.push(resolve));
  }

  /** An AWS call with this environment's profile said the session ran out. */
  markExpired(environment?: string): void {
    const s = environment ? this.sessions.get(environment) : undefined;
    if (!s) return;
    this.set(s, 'expired');
    this.schedule(s);
  }

  /** Checks one environment now. */
  async recheck(environment: string): Promise<void> {
    const s = this.sessions.get(environment);
    if (s) await this.check(s);
  }

  private async check(s: Session): Promise<void> {
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer);
    s.timer = undefined;
    try {
      const r = await this.o.probe(s.profile).catch((): ProbeResult => 'error');
      // Another failure (network, a missing profile) says nothing about the session: keep what is known.
      if (r === 'ok') this.set(s, 'ok');
      else if (r === 'expired') this.set(s, 'expired');
    } finally {
      this.schedule(s);
    }
  }

  private schedule(s: Session): void {
    if (this.stopped) return;
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer);
    s.timer = this.clock.setTimeout(() => void this.check(s), s.state === 'expired' ? AWS_RECHECK_MS : AWS_CHECK_MS);
  }

  private set(s: Session, state: State): void {
    if (state !== s.state) this.o.log.append('orchestrator', 'aws.session', { state, environment: s.environment, profile: s.profile });
    s.state = state;
    if (state === 'expired') return;
    s.asked = false;
    s.waiters.splice(0).forEach((w) => w());
  }

  private askOnce(s: Session): void {
    if (s.asked) return;
    s.asked = true;
    this.o.ask(
      tr(
        `Your AWS session for ${s.environment} (profile ${s.profile}) has run out. Please paste a fresh one into ~/.aws/credentials; agents that need ${s.environment} are waiting for it and go on by themselves once it works.`,
        `Phiên AWS của cậu cho ${s.environment} (profile ${s.profile}) đã hết hạn. Cậu dán một phiên mới vào ~/.aws/credentials giúp tôi; các agent cần ${s.environment} đang chờ và sẽ tự làm tiếp khi nó dùng được.`,
      ),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.sessions.values()) if (s.timer !== undefined) this.clock.clearTimeout(s.timer);
  }
}
