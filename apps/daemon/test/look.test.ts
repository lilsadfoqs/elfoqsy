import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLog } from '../src/eventLog';
import { LookWatcher } from '../src/elfoqsy/look';

const NOW = new Date('2026-10-08T14:24:00Z').getTime();
let log: EventLog;
let watcher: LookWatcher;

const looks = () => log.readFrom(0, 10_000).flatMap((e) => (e.type === 'elfoqsy.look' ? [e.payload] : []));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  log = new EventLog(':memory:');
});

afterEach(() => {
  watcher.close();
  log.close();
  vi.useRealTimers();
});

describe("Elfoqsy's look", () => {
  it('is recorded when her state changes, once, and not again while it holds', () => {
    watcher = new LookWatcher(log, { random: () => 0 });
    vi.advanceTimersByTime(1);
    expect(looks()).toEqual([{ mood: 'quiet', variant: 0 }]);
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'running' });
    vi.advanceTimersByTime(1);
    expect(looks().at(-1)).toEqual({ mood: 'working', variant: 0 });
    log.append('orchestrator', 'run.note', { runId: 'r1', text: 'still at it' });
    vi.advanceTimersByTime(20_000);
    expect(looks()).toHaveLength(2);
  });

  it('never picks the portrait she had the last time she was in that state', () => {
    watcher = new LookWatcher(log, { random: () => 0 });
    vi.advanceTimersByTime(1);
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'push', question: 'Push?' });
    vi.advanceTimersByTime(1);
    log.append('orchestrator', 'approval.resolved', { approvalId: 'a1', decision: 'denied', test: true });
    vi.advanceTimersByTime(1);
    log.append('orchestrator', 'approval.requested', { approvalId: 'a2', runId: 'r1', kind: 'push', question: 'Push now?' });
    vi.advanceTimersByTime(1);
    const needs = looks().filter((l) => l.mood === 'needs');
    expect(needs.map((l) => l.variant)).toEqual([0, 1]);
  });

  it('is done for 2 minutes after a run succeeds, then moves on with time alone', () => {
    watcher = new LookWatcher(log, { random: () => 0 });
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'succeeded' });
    vi.advanceTimersByTime(1);
    expect(looks().at(-1)!.mood).toBe('done');
    vi.advanceTimersByTime(130_000);
    expect(looks().at(-1)!.mood).toBe('quiet');
  });

  it('remembers its last picks across a restart', () => {
    watcher = new LookWatcher(log, { random: () => 0 });
    vi.advanceTimersByTime(1);
    watcher.close();
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'running' });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'stopped' });
    watcher = new LookWatcher(log, { random: () => 0 });
    vi.advanceTimersByTime(1);
    // Still quiet, as recorded before the restart: nothing new.
    expect(looks()).toEqual([{ mood: 'quiet', variant: 0 }]);
  });
});
