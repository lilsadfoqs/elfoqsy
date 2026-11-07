import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveState } from '../src/elfoqsy/liveState';
import { periodStats, currentReviews } from '@elfoqsy/state';
import { blockProblems } from '../src/elfoqsy/blocks';
import { WeeklyReview, recheck, reviewDue } from '../src/elfoqsy/review';
import { EventLog } from '../src/eventLog';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
let now: number;
let log: EventLog;
let live: LiveState;
let asked: Array<[string, string]>;
let review: WeeklyReview;

beforeEach(() => {
  now = at(2026, 10, 10, 21, 40);
  log = new EventLog(':memory:', () => new Date(now));
  live = new LiveState(log);
  asked = [];
  review = new WeeklyReview({ log, state: () => live.get(), ask: (c, t) => asked.push([c, t]), now: () => now });
});
afterEach(() => {
  live.close();
  log.close();
});

describe('the weekly review', () => {
  it('is due for the latest Monday 09:00', () => {
    expect(reviewDue(at(2026, 10, 10, 21, 40)).weekOf).toBe('2026-10-05');
    expect(reviewDue(at(2026, 10, 12, 8, 59)).weekOf).toBe('2026-10-05');
    expect(reviewDue(at(2026, 10, 12, 9, 0)).weekOf).toBe('2026-10-12');
    expect(reviewDue(at(2026, 10, 18, 23, 0)).weekOf).toBe('2026-10-12');
  });

  it('asks her once, in its own conversation, with the numbers of the last seven days', () => {
    const base = now - 7 * 24 * 3600_000;
    const t = (min: number) => base + min * 60_000;
    now = t(60);
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    now = t(90);
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'failed' });
    now = at(2026, 10, 10, 21, 40);
    expect(review.runIfDue()).toBe('2026-10-05');
    expect(review.runIfDue()).toBeUndefined();
    expect(live.get().conversations['review-2026-10-05']).toMatchObject({ title: 'Weekly review, 3 October to 10 October' });
    const [conversationId, text] = asked[0]!;
    expect(conversationId).toBe('review-2026-10-05');
    expect(text).toMatch(/^\[Weekly review\] Due Monday 5 October; it covers 3 October to 10 October\./);
    expect(text).toContain('Runs: 1 (0 succeeded, 0 stopped, 1 failed, 0 cancelled, 0 still active; 0 failures dismissed).');
    expect(text).toContain('Call record_review with weekOf 2026-10-05');
    expect(review.pending('2026-10-05')).toMatchObject({ runs: 1, failed: 1 });
  });

  it('is not asked again once recorded, and the next one starts where the last ended', () => {
    log.append('elfoqsy', 'review.weekly', { weekOf: '2026-10-05', conversationId: 'review-2026-10-05', metrics: { periodEnd: at(2026, 10, 10, 21, 40) }, suggestions: [] });
    expect(review.runIfDue()).toBeUndefined();
    now = at(2026, 10, 12, 9, 30);
    expect(review.runIfDue()).toBe('2026-10-12');
    expect(asked[0]![1]).toMatch(/it covers 10 October to 12 October\./);
  });
});

describe('correcting a recorded review', () => {
  const DAY = 24 * 3600_000;
  const ofType = (type: string) => log.readFrom(0, 10_000).filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

  it('posts the numbers the log gives now under it, in her voice, withdraws what rested on a changed one, and supersedes it', () => {
    const end = now;
    const base = end - 7 * DAY;
    const t = (min: number) => base + min * 60_000;
    const step = (min: number, type: string, payload: Record<string, unknown>) => {
      now = t(min);
      log.append('orchestrator', type as never, payload as never);
    };
    step(0, 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    step(1, 'run.state_changed', { runId: 'r1', state: 'running' });
    step(30, 'run.state_changed', { runId: 'r1', state: 'waiting_for_you' });
    step(60, 'run.state_changed', { runId: 'r1', state: 'running' });
    step(100, 'run.state_changed', { runId: 'r1', state: 'failed' });
    now = end;
    const right = periodStats(log.readFrom(0, 10_000), base, end).metrics;
    expect(right).toMatchObject({ workingMinutes: 69, waitingMinutes: 30 });
    // Recorded with the wrong time, as the 5 October review was.
    log.append('elfoqsy', 'review.weekly', {
      weekOf: '2026-10-05',
      conversationId: 'review-2026-10-05',
      metrics: { ...right, workingMinutes: 0, waitingMinutes: 1335 },
      suggestions: ['Answer approvals sooner: runs waited 1335 min against 0 min of work.', 'Keep runs small: 1 of 1 runs failed.'],
    });
    // Later events do not reach back into the period.
    now = end + 3600_000;
    log.append('orchestrator', 'run.created', { runId: 'r2', ticket: 'SHOP-2', worktree: '', branch: '', agentNumber: 2 });

    expect(review.correctStale()).toEqual(['2026-10-05']);
    expect(ofType('review.corrected')).toEqual([
      {
        weekOf: '2026-10-05',
        revision: 2,
        metrics: right,
        suggestions: ['Keep runs small: 1 of 1 runs failed.'],
        withdrawn: ['Answer approvals sooner: runs waited 1335 min against 0 min of work.'],
      },
    ]);
    expect(ofType('elfoqsy.message').at(-1)).toMatchObject({
      role: 'elfoqsy',
      conversationId: 'review-2026-10-05',
      text: "A correction to this review: the right figures are 69 min working (not 0) and 30 min waiting for you (not 1335). I've withdrawn my first suggestion, which rested on the old numbers; the corrected review is below.",
      blocks: [{ type: 'review', ref: '2026-10-05/r2' }],
    });
    expect(log.readFrom(0, 10_000).filter((e) => e.type === 'elfoqsy.message').at(-1)!.source).toBe('orchestrator');
    const s = live.get();
    expect(s.reviews[0]!.supersededAt).toBeDefined();
    expect(currentReviews(s).map((r) => r.ref)).toEqual(['2026-10-05/r2']);
    // Both revisions can be shown, by their own refs.
    expect(blockProblems(s, [{ type: 'review', ref: '2026-10-05' }, { type: 'review', ref: '2026-10-05/r2' }])).toEqual([]);
    expect(blockProblems(s, [{ type: 'review', ref: '2026-10-05/r3' }])).toHaveLength(1);
    // Once right, nothing more; and the week stays reviewed.
    expect(review.correctStale()).toEqual([]);
    expect(review.runIfDue()).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('withdraws a suggestion only for a number that can mean nothing but a changed figure', () => {
    const old = { runs: 4, succeeded: 1, cancelled: 2, workingMinutes: 0, waitingMinutes: 1335, pausedMinutes: 0, checkChanges: 8, evidenceMissing: 2 };
    const suggestions = [
      'Answer agent approvals sooner or batch them: runs waited 1335 min for alex against 0 min of agent work.',
      'Write done-when checks that a run can prove: 2 checks had no evidence at the end, and checks changed 8 times across 4 runs.',
      'Agree scope before starting an agent: 2 of 4 runs were cancelled and only 1 succeeded.',
      'Pause less: 0 min paused.',
    ];
    expect(recheck(suggestions, old, ['workingMinutes', 'waitingMinutes'])).toEqual({ kept: suggestions.slice(1), withdrawn: [0] });
  });
});
