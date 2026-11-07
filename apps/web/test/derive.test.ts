import { describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf, Ticket } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import { carriedOver, CARRIED_OVER_WARNING, mood, statusItems, statusLines } from '@elfoqsy/state';
import { foldAll } from '@elfoqsy/state';
import { eventFactory, mockSprint, time } from './helpers';

const { open, closed } = mockSprint();

/** The simulated world: the real sprint, agents 2-4 working, agent 1 waiting on a question. */
function world(options: { answered?: boolean; failed?: boolean; prFailure?: boolean; tickets?: Ticket[]; runs?: string[] } = {}) {
  const e = eventFactory();
  const events: AnyEnvelope[] = [...(options.tickets ?? [...open, ...closed]).map((t) => e('ticket.synced', { ticket: t }))];
  events.push(
    e('pr.synced', {
      pr: { repo: 'shop-worker', number: 212, state: 'open', ticket: 'SHOP-3472', url: '', checks: options.prFailure ? 'failure' : 'none' },
    }),
  );
  const runs = options.runs ?? ['SHOP-3533', 'SHOP-3472', 'SHOP-2091', 'SHOP-3546'];
  runs.forEach((key, i) => {
    events.push(e('run.created', { runId: `r${i + 1}`, ticket: key, worktree: '', branch: '', agentNumber: i + 1 }));
    events.push(e('run.step_begun', { runId: `r${i + 1}`, stepIndex: 0, name: 'Plan', why: 'Read the ticket first.' }));
    events.push(e('run.state_changed', { runId: `r${i + 1}`, state: i === 0 ? 'waiting_for_you' : 'running' }));
  });
  if (runs.length) events.push(e('approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'question', question: 'Which space?' }));
  if (options.answered) {
    events.push(e('approval.resolved', { approvalId: 'a1', decision: 'answered', answer: 'SHOP' }));
    events.push(e('run.state_changed', { runId: 'r1', state: 'running' }));
  }
  if (options.failed) events.push(e('run.state_changed', { runId: 'r3', state: 'failed', reason: 'tests kept failing' }));
  return foldAll(events);
}

describe('status cluster: what needs looking at, most urgent first, only what is not zero', () => {
  it('shows an agent waiting for you, then the blocked ticket, each with its full sentence', () => {
    expect(statusItems(world())).toEqual([
      { kind: 'waiting', count: 1, sentence: '1 agent needs you' },
      { kind: 'blocked', count: 1, sentence: '1 ticket is blocked' },
    ]);
  });

  it('drops a pair when its count is zero', () => {
    expect(statusItems(world({ answered: true }))).toEqual([{ kind: 'blocked', count: 1, sentence: '1 ticket is blocked' }]);
    const calm = open.filter((t) => t.status !== 'Blocked');
    expect(statusItems(world({ answered: true, tickets: calm }))).toEqual([]);
  });

  it('puts broken first, counting failed agents and CI failing on an open PR', () => {
    const items = statusItems(world({ failed: true, prFailure: true }));
    expect(items[0]).toEqual({ kind: 'broken', count: 2, sentence: '1 agent failed and CI failed on 1 pull request' });
    expect(items.map((i) => i.kind)).toEqual(['broken', 'waiting', 'blocked']);
  });

  it('does not count a ticket that only keeps carrying over: the map shows that', () => {
    const notBlocked = open.filter((t) => t.status !== 'Blocked');
    expect(notBlocked.some((t) => carriedOver(t) >= CARRIED_OVER_WARNING)).toBe(true);
    expect(statusItems(world({ answered: true, tickets: notBlocked }))).toEqual([]);
  });
});

describe("Elfoqsy's state: broken, needs you, done, thinking, working, quiet", () => {
  const e = eventFactory();
  const calm = open.filter((t) => t.status !== 'Blocked');
  /** One more event on top of a folded world, `at` seconds in. */
  const then = <T extends EventType>(s: WorkspaceState, type: T, payload: PayloadOf<T>, at: number) => foldAll([{ ...e(type, payload, at), seq: s.seq + 1 }], s);

  it('is broken before needs you, and needs you before anything else', () => {
    expect(mood(world({ failed: true }), time(60))).toBe('broken');
    expect(mood(world(), time(60))).toBe('needs');
  });

  it('is done for 2 minutes after a run succeeds, even with other agents at work', () => {
    const s = then(world({ answered: true, tickets: calm }), 'run.state_changed', { runId: 'r2', state: 'succeeded' }, 100);
    expect(mood(s, time(100 + 119))).toBe('done');
    expect(mood(s, time(100 + 121))).toBe('working');
  });

  it('is thinking while an investigation runs or she writes a brief, and only until it finishes', () => {
    const base = world({ answered: true, tickets: calm });
    const investigating = then(base, 'investigation.started', { investigationId: 'i1', conversationId: 'c1', question: 'Why?', model: 'claude-sonnet-5-5', effort: 'high' }, 100);
    expect(mood(investigating, time(130))).toBe('thinking');
    const found = then(investigating, 'investigation.finished', { investigationId: 'i1', conversationId: 'c1', title: 'Why', findings: [], durationMs: 40_000 }, 140);
    expect(mood(found, time(150))).toBe('working');

    const writing = then(base, 'brief.started', { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-1164' }, 100);
    expect(mood(writing, time(130))).toBe('thinking');
    const written = then(writing, 'brief.created', { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-1164', title: 'Per-step timeout', sections: [{ heading: 'Goal', markdown: 'x' }] }, 140);
    expect(written.briefsInProgress).toEqual({});
    expect(mood(written, time(150))).toBe('working');
    // A brief she never finished stops counting after 10 minutes.
    expect(mood(writing, time(100 + 601))).toBe('working');
  });

  it('is quiet with no agents', () => {
    expect(mood(world({ tickets: calm, runs: [] }), time(60))).toBe('quiet');
  });
});

describe('carried over', () => {
  it('is the number of sprints minus the current one, and warns from 6', () => {
    const t = (sprintsCarried: number) => ({ ...open[0]!, sprintsCarried });
    expect(carriedOver(t(1))).toBe(0);
    expect(carriedOver(t(2))).toBe(1);
    expect(carriedOver(t(6)) >= CARRIED_OVER_WARNING).toBe(false);
    expect(carriedOver(t(7)) >= CARRIED_OVER_WARNING).toBe(true);
  });
});

describe('status lines under the date', () => {
  it('says nothing while everything is reachable', () => {
    expect(statusLines(world(), null)).toEqual([]);
  });

  it('shows offline, then each unreachable source, and clears a source when it recovers', () => {
    const e = eventFactory();
    const since = Date.parse('2026-10-09T07:49:00Z');
    const down = foldAll([
      e('sync.status', { source: 'jira', state: 'unreachable', since: new Date(since).toISOString(), reason: 'HTTP 503' }),
      e('sync.status', { source: 'github', state: 'unreachable', since: new Date(since).toISOString() }),
    ]);
    const hhmm = new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(statusLines(down, since)).toEqual([`Offline since ${hhmm}`, `Jira unreachable since ${hhmm}`, `GitHub unreachable since ${hhmm}`]);
    const recovered = foldAll([e('sync.status', { source: 'jira', state: 'ok', since: new Date(since + 60_000).toISOString() })], down);
    expect(statusLines(recovered, null)).toEqual([`GitHub unreachable since ${hhmm}`]);
  });
});

describe('Claude paused line', () => {
  it('shows until when the reset time is known, since when it is not, and clears on ok', () => {
    const e = eventFactory();
    const since = Date.parse('2026-10-09T07:49:00Z');
    const until = since + 3 * 3600_000;
    const fmt = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const paused = foldAll([e('usage.limit', { state: 'limited', since: new Date(since).toISOString(), until: new Date(until).toISOString() })]);
    expect(statusLines(paused, null)).toEqual([`Claude paused until ${fmt(until)}`]);
    const open = foldAll([e('usage.limit', { state: 'limited', since: new Date(since).toISOString(), reason: 'login' })]);
    expect(statusLines(open, null)).toEqual([`Claude paused since ${fmt(since)}`]);
    const resumed = foldAll([e('usage.limit', { state: 'ok', since: new Date(until).toISOString() })], paused);
    expect(statusLines(resumed, null)).toEqual([]);
  });
});
