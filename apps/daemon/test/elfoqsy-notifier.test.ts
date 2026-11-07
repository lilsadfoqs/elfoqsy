import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '@elfoqsy/contracts';
import type { Clock } from '../src/clock';
import { LiveState } from '../src/elfoqsy/liveState';
import { Notifier } from '../src/elfoqsy/notifier';
import { EventLog } from '../src/eventLog';

const ticket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  board: 'SHOP',
  summary: key,
  type: 'Bug',
  status: 'To do',
  priority: 'Critical',
  storyPoints: 2,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 1,
  epic: null,
  reporter: '',
  created: '',
  updated: '',
  labels: [],
  linked: [],
  description: '',
  ...overrides,
});

class ManualClock implements Clock {
  timers: Array<{ fn: () => void; id: number }> = [];
  private next = 1;
  setTimeout(fn: () => void): unknown {
    const id = this.next++;
    this.timers.push({ fn, id });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  fire(): void {
    const due = this.timers.splice(0);
    due.forEach((t) => t.fn());
  }
}

let log: EventLog;
let live: LiveState;
let clock: ManualClock;
let delivered: string[][];
let notifier: Notifier;

beforeEach(() => {
  // Every event in the same millisecond, as a fast pane action and the agent's next call can be: order is the log's.
  const instant = new Date('2026-10-10T16:02:42.363Z');
  log = new EventLog(':memory:', () => instant);
  // History: already blocked and already carried over before the daemon started.
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3049', { status: 'Blocked' }) });
  log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-2091', { sprintsCarried: 12 }) });
  live = new LiveState(log);
  clock = new ManualClock();
  delivered = [];
  notifier = new Notifier(live, (notices) => delivered.push(notices.map((n) => n.text)), clock);
});

afterEach(() => {
  notifier.close();
  live.close();
  log.close();
});

describe('Elfoqsy speaks first only about live changes', () => {
  it('ignores history and changes that are not news', () => {
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3049', { status: 'Blocked', summary: 'edited' }) });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-2091', { sprintsCarried: 13 }) });
    clock.fire();
    expect(delivered).toEqual([]);
  });

  it('raises a ticket that becomes blocked, and one that reaches 6 sprints carried over with nobody on it', () => {
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546', { status: 'Blocked', priority: 'Major' }) });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-1164', { sprintsCarried: 7 }) });
    expect(delivered).toEqual([]); // held for the coalescing window
    clock.fire();
    expect(delivered).toEqual([
      ['SHOP-3546 is now Blocked. It is Major.', 'SHOP-1164 has been carried over 6 sprints and nobody is on it.'],
    ]);
  });

  it('does not raise a carried-over ticket an agent is on', () => {
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-1164', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'running' });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-1164', { sprintsCarried: 7 }) });
    clock.fire();
    expect(delivered).toEqual([]);
  });

  it('raises CI failing on an open PR once, not on every poll', () => {
    log.append('github', 'pr.synced', { pr: { repo: 'o/r', number: 7, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'pending' } });
    const failed = { repo: 'o/r', pr: 7, sha: 'abc', status: 'failure' as const, url: '' };
    log.append('github', 'ci.status', failed);
    log.append('github', 'ci.status', { ...failed, status: 'running' });
    log.append('github', 'ci.status', failed);
    clock.fire();
    expect(delivered).toEqual([['CI failed on o/r #7 (SHOP-3546).']]);
  });

  it('tells him when an agent finishes or fails, once, but not when it waits for him', () => {
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-3546', worktree: '/w/r1', branch: 'feature/SHOP-3546', agentNumber: 2 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'running' });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'waiting_for_you' });
    log.append('orchestrator', 'budget.exceeded', { runId: 'r1', limit: 'time', value: 46 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'failed', reason: 'Stopped after 46 minutes of work, over its budget.' });
    log.append('orchestrator', 'run.created', { runId: 'r2', ticket: 'SHOP-3547', worktree: '/w/r2', branch: 'feature/SHOP-3547', agentNumber: 3 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r2', state: 'succeeded', reason: 'Lifted error_code.' });
    log.append('orchestrator', 'run.state_changed', { runId: 'r2', state: 'succeeded', reason: 'Lifted error_code.' });
    log.append('orchestrator', 'run.created', { runId: 'r3', ticket: 'SHOP-3548', worktree: '/w/r3', branch: 'feature/SHOP-3548', agentNumber: 4 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r3', state: 'cancelled', reason: 'Not needed' });
    log.append('orchestrator', 'run.created', { runId: 'r4', ticket: 'SHOP-3549', worktree: '/w/r4', branch: 'feature/SHOP-3549', agentNumber: 5 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r4', state: 'stopped', reason: 'Fixed it. Not counted as succeeded: its tests did not run.' });
    clock.fire();
    expect(delivered).toEqual([
      [
        'Agent 2 on SHOP-3546 failed: Stopped after 46 minutes of work, over its budget.',
        'Agent 3 on SHOP-3547 finished: Lifted error_code.',
        'Agent 5 on SHOP-3549 stopped without finishing: Fixed it. Not counted as succeeded: its tests did not run.',
      ],
    ]);
  });

  it('never raises the same thing twice', () => {
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-1', { status: 'Blocked' }) });
    clock.fire();
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-1', { status: 'To do' }) });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-1', { status: 'Blocked' }) });
    clock.fire();
    expect(delivered).toEqual([['SHOP-1 is now Blocked. It is Critical.']]);
  });
});

describe('Elfoqsy hears of flags and interventions she did not make', () => {
  const run = () => {
    log.append('orchestrator', 'run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r3', state: 'running' });
    log.append('agent', 'run.step_begun', { runId: 'r3', stepIndex: 0, name: 'Unit tests', why: 'Prove it.' });
  };
  const flush = () => {
    clock.fire();
    return delivered.splice(0).flat();
  };

  it('passes every flag on, and says when a run is still looping', () => {
    run();
    log.append('orchestrator', 'run.flag', { runId: 'r3', kind: 'missed_heartbeats', detail: 'No heartbeat for 10 working minutes; two are missed.' });
    log.append('orchestrator', 'run.flag', { runId: 'r3', kind: 'loop', detail: 'It ran `npm test` 3 times with no change to the code in between.' });
    expect(flush()).toEqual([
      'Agent 3 on SHOP-2091: No heartbeat for 10 working minutes; two are missed.',
      'Agent 3 on SHOP-2091: It ran `npm test` 3 times with no change to the code in between. This is its first loop flag.',
    ]);
    log.append('orchestrator', 'run.flag', { runId: 'r3', kind: 'loop', detail: 'Tokens rose from 100k to 300k over two heartbeats with no new step and no new evidence.' });
    expect(flush()).toEqual(['Agent 3 on SHOP-2091: Tokens rose from 100k to 300k over two heartbeats with no new step and no new evidence. It is still looping: loop flag 2 for this run.']);
  });

  it('notes guidance from a pane in one update, and the re-plan that follows it', () => {
    run();
    log.append('orchestrator', 'run.paused', { runId: 'r3', by: 'you', reason: 'To give guidance' });
    log.append('orchestrator', 'run.guidance', { runId: 'r3', text: 'Skip the integration suite.', by: 'you' });
    log.append('orchestrator', 'run.resumed', { runId: 'r3', by: 'you' });
    expect(flush()).toEqual(['alex gave Agent 3 on SHOP-2091 guidance from its pane (paused, given, resumed): "Skip the integration suite."']);
    log.append('agent', 'run.step_begun', { runId: 'r3', stepIndex: 1, name: 'Unit tier only', why: 'As told.' });
    expect(flush()).toEqual(['Agent 3 on SHOP-2091 re-planned after the guidance: it began "Unit tier only": As told.']);
    log.append('agent', 'run.step_begun', { runId: 'r3', stepIndex: 2, name: 'Push', why: 'Done.' });
    expect(flush()).toEqual([]);
  });

  it('notes a pause and a resume from the Pause button, as the tester’s, and none she made herself', () => {
    run();
    log.append('orchestrator', 'run.paused', { runId: 'r3', by: 'tester' });
    log.append('orchestrator', 'run.resumed', { runId: 'r3', by: 'tester' });
    expect(flush()).toEqual(['The tester paused Agent 3 on SHOP-2091.', 'The tester resumed Agent 3 on SHOP-2091.']);
    log.append('orchestrator', 'run.paused', { runId: 'r3', by: 'you', reason: 'Through Elfoqsy: he asked' });
    log.append('orchestrator', 'run.resumed', { runId: 'r3', by: 'you', reason: 'Through Elfoqsy' });
    expect(flush()).toEqual([]);
  });
});
