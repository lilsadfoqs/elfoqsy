import { describe, expect, it } from 'vitest';
import { periodStats, runStats } from '@elfoqsy/state';
import { eventFactory, time } from './helpers';

/** A week of two runs: one guided, paused and failed (then dismissed), one that waited for approval and succeeded. */
function week() {
  const e = eventFactory();
  return [
    e('pr.synced', { pr: { repo: 'o/r', number: 7, state: 'open', ticket: 'SHOP-1', url: '', checks: 'none' } }, 0),
    e('run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 }, 0),
    e('run.goal_declared', { runId: 'r1', revision: 1, goal: 'Fix it', checks: [{ id: 'unit', description: 'Unit', proof: 'command', command: 'npm test' }] }, 10),
    e('run.step_begun', { runId: 'r1', stepIndex: 0, name: 'Reproduce', why: '' }, 10),
    e('run.usage', { runId: 'r1', tokens: 100_000, workingSeconds: 600 }, 610),
    e('run.paused', { runId: 'r1', by: 'you', reason: 'To give guidance' }, 620),
    e('run.guidance', { runId: 'r1', text: 'Skip it.', by: 'you' }, 620),
    e('run.resumed', { runId: 'r1', by: 'you' }, 620),
    e('run.step_begun', { runId: 'r1', stepIndex: 1, name: 'Fix', why: '' }, 630),
    e('run.paused', { runId: 'r1', by: 'you' }, 700),
    e('run.resumed', { runId: 'r1', by: 'you' }, 1000),
    e('subagent.started', { runId: 'r1', subagentId: 's1', model: 'claude-haiku-5-5', effort: 'low', task: 'Run the unit tests' }, 1000),
    e('subagent.finished', { runId: 'r1', subagentId: 's1', outcome: 'failed', result: 'x', tokens: 5000, toolCalls: 2, durationMs: 60_000 }, 1060),
    e('subagent.started', { runId: 'r1', subagentId: 's2', model: 'claude-sonnet-5-5', effort: 'medium', task: 'Run the unit tests' }, 1060),
    e('subagent.finished', { runId: 'r1', subagentId: 's2', outcome: 'done', result: 'ok', tokens: 9000, toolCalls: 3, durationMs: 60_000 }, 1120),
    e('ci.status', { repo: 'o/r', pr: 7, sha: 'a', status: 'failure', url: '' }, 1200),
    e('run.goal_declared', { runId: 'r1', revision: 2, goal: 'Fix it', checks: [{ id: 'unit', description: 'Unit', proof: 'command', command: 'npm test' }] }, 1210),
    e('run.usage', { runId: 'r1', tokens: 250_000, workingSeconds: 1200 }, 1300),
    e('run.state_changed', { runId: 'r1', state: 'failed', reason: 'tests kept failing' }, 1300),
    e('run.dismissed', { runId: 'r1', by: 'you' }, 1400),
    e('run.created', { runId: 'r2', ticket: 'SHOP-2', worktree: '', branch: '', agentNumber: 2 }, 0),
    e('run.state_changed', { runId: 'r2', state: 'waiting_for_you' }, 100),
    e('run.state_changed', { runId: 'r2', state: 'running' }, 400),
    e('run.usage', { runId: 'r2', tokens: 50_000, workingSeconds: 300 }, 500),
    e('run.state_changed', { runId: 'r2', state: 'succeeded' }, 500),
  ];
}

describe('analytics, from the log alone', () => {
  it('counts each run: steps, waiting, pauses, tokens, sub-agents, CI, plan changes, interventions, evidence', () => {
    const [r1, r2] = runStats(week(), time(2000));
    expect(r1).toMatchObject({
      state: 'failed',
      dismissed: true,
      pausedMs: 300_000,
      tokens: 250_000,
      ciFailures: 1,
      planChanges: 1,
      interventions: 2, // the guidance, and a pause to stop and think
      evidenceMissing: 1,
    });
    expect(r1!.steps).toEqual([
      { name: 'Reproduce', ms: 620_000, tokens: 100_000 },
      { name: 'Fix', ms: 670_000, tokens: 150_000 },
    ]);
    expect(r1!.subagents.map((s) => [s.model, s.kind, s.outcome])).toEqual([
      ['claude-haiku-5-5', 'run', 'failed'],
      ['claude-sonnet-5-5', 'run', 'done'],
    ]);
    expect(r2).toMatchObject({ state: 'succeeded', waitingMs: 300_000, interventions: 0 });
  });

  it('adds a period up, a dismissed failure still a failure, with sub-agent success by model and by kind', () => {
    const p = periodStats(week(), time(0), time(2000));
    expect(p.metrics).toMatchObject({ runs: 2, succeeded: 1, failed: 1, dismissed: 1, tokens: 300_000, pausedMinutes: 5, waitingMinutes: 5, interventions: 2, ciFailures: 1, subagents: 2, subagentsFailed: 1 });
    expect(p.subagentsByModel.map((r) => [r.key, r.successRate])).toEqual([
      ['claude-haiku-5-5 low', 0],
      ['claude-sonnet-5-5 medium', 1],
    ]);
    expect(p.subagentsByKind).toEqual([{ key: 'run', done: 1, failed: 1, cancelled: 0, successRate: 0.5 }]);
    expect(p.interventionsByTicket).toEqual({ 'SHOP-1': 2 });
    // A run that ended before the period is not in it.
    expect(periodStats(week(), time(1500), time(3000)).metrics.runs).toBe(0);
  });

  it('leaves out the time the daemon was off: a run waiting when it stopped did not wait overnight', () => {
    const e = eventFactory();
    const events = [
      e('run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }, 0),
      e('run.state_changed', { runId: 'r3', state: 'running' }, 0),
      e('run.state_changed', { runId: 'r3', state: 'waiting_for_you' }, 600),
      e('tool.called', { tool: 'list_sprint', inputSummary: '{}', allowed: true }, 900), // the last event before it stopped
      e('daemon.started', { mode: 'live' }, 80_000),
      e('run.state_changed', { runId: 'r3', state: 'failed', reason: 'The daemon restarted and the agent stopped.' }, 80_000),
    ];
    const [r3] = runStats(events, time(90_000));
    expect(r3!.waitingMs).toBe(300_000); // 600 s to 900 s, not to 80 000 s
    expect(r3!.workingSeconds).toBe(600); // no run.usage: its time running
    // Before daemon.started existed, the restart failure marks the restart just as well.
    const old = events.filter((x) => x.type !== 'daemon.started');
    expect(runStats(old, time(90_000))[0]!.waitingMs).toBe(300_000);
  });
});