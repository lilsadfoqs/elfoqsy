import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldAll, isRunActive, statusItems } from '@elfoqsy/state';
import { FailedLine } from '../src/right/terminals/FailedLine';
import { approvalPrompt, pendingApproval, stackOrder, statusLine, subagentCounts, subagentMeta, subagentResult, transcriptLines } from '../src/right/terminals/lines';
import { eventFactory, time } from './helpers';

function agent3() {
  const e = eventFactory();
  return foldAll([
    e('run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: 'feature/SHOP-2091', agentNumber: 3, budget: { tokens: 3_000_000, minutes: 45 } }, 0),
    e('run.state_changed', { runId: 'r3', state: 'running' }, 0),
    e('run.step_begun', { runId: 'r3', stepIndex: 0, name: 'Unit tests', why: 'Prove it' }, 1),
    e('tool.called', { runId: 'r3', toolUseId: 't1', tool: 'Edit', title: 'src/pricing/bundles.ts', inputSummary: '{}', allowed: true }, 2),
    e('tool.finished', { runId: 'r3', toolUseId: 't1', ok: true, stats: '+2 −1', outputSummary: '-   return parent;\n+   parent.av = merge(children);' }, 3),
    e('tool.called', { runId: 'r3', toolUseId: 't2', tool: 'Bash', title: 'npm run test:unit', inputSummary: '{}', allowed: true }, 4),
    e('tool.finished', { runId: 'r3', toolUseId: 't2', ok: false, outputSummary: 'PASS  a.spec.ts\nFAIL  b.spec.ts' }, 5),
    e('tool.called', { runId: 'r3', toolUseId: 'a1', tool: 'Agent', title: 'Run the unit tests', inputSummary: '{}', allowed: true }, 6),
    e('subagent.started', { runId: 'r3', subagentId: 's1', parentToolUseId: 'a1', model: 'claude-haiku-5-5', effort: 'low', task: 'Run the unit tests' }, 6),
    e('subagent.tool_called', { runId: 'r3', subagentId: 's1', tool: 'Bash', inputSummary: 'npm run test:unit', outputSummary: 'running', ok: true }, 7),
    e('subagent.started', { runId: 'r3', subagentId: 's0', model: 'claude-sonnet-5-5', effort: 'medium', task: 'Try the integration suite' }, 1),
    e('subagent.finished', { runId: 'r3', subagentId: 's0', outcome: 'cancelled', by: 'agent', reason: 'No Redis', result: 'Cancelled by Agent 3', tokens: 22_000, toolCalls: 1, durationMs: 54_000 }, 55),
    e('tool.called', { runId: 'r3', toolUseId: 't3', tool: 'Bash', title: 'npm run test:unit', inputSummary: '{}', allowed: true }, 60),
    e('run.usage', { runId: 'r3', tokens: 412_000, workingSeconds: 1080 }, 60),
  ]);
}

describe('terminal pane lines', () => {
  it('shows the agent’s own calls only: diffs as they are, output hanging off its call, a running call’s time', () => {
    const s = agent3();
    expect(transcriptLines(s.runs.r3!, time(132))).toEqual([
      { kind: 'call', tool: 'Edit', text: 'src/pricing/bundles.ts  +2 −1' },
      { kind: 'out', text: '-   return parent;' },
      { kind: 'out', text: '+   parent.av = merge(children);' },
      { kind: 'call', tool: 'Bash', text: 'npm run test:unit' },
      { kind: 'out', text: '└ PASS  a.spec.ts' },
      { kind: 'out', text: '  FAIL  b.spec.ts' },
      { kind: 'call', tool: 'Bash', text: 'npm run test:unit' },
      { kind: 'out', text: '└ running  1m 12s' },
    ]);
  });

  it('says a gated call is waiting for alex, and the footer asks the push question', () => {
    const e = eventFactory();
    const s = foldAll([
      e('run.created', { runId: 'r4', ticket: 'SHOP-3546', worktree: '', branch: 'feature/SHOP-3546', agentNumber: 4 }),
      e('tool.called', { runId: 'r4', toolUseId: 'p', tool: 'Bash', title: 'git push origin feature/SHOP-3546', inputSummary: '{}', allowed: true }),
      e('approval.requested', { approvalId: 'a4', runId: 'r4', kind: 'push', question: 'Push?' }),
      e('run.state_changed', { runId: 'r4', state: 'waiting_for_you' }),
    ]);
    expect(transcriptLines(s.runs.r4!, time(10)).at(-1)).toEqual({ kind: 'out', text: '└ waiting for alex' });
    expect(approvalPrompt(pendingApproval(s, 'r4')!, s.runs.r4!)).toBe('push feature/SHOP-3546?');
    expect(statusLine(s.runs.r4!)).toBe('starting, 0 tokens, waiting for you');
  });

  it('ends a call with its run: a declined push says so, a call that never reported back stops its clock', () => {
    const e = eventFactory();
    const s = foldAll([
      e('run.created', { runId: 'r5', ticket: 'SHOP-3546', worktree: '', branch: 'feature/SHOP-3546', agentNumber: 5 }, 0),
      e('tool.called', { runId: 'r5', toolUseId: 'p', tool: 'Bash', title: 'git push 2>&1 | tail -20', inputSummary: '{}', allowed: true }, 1),
      e('tool.finished', { runId: 'r5', toolUseId: 'p', ok: false, outputSummary: 'The tester (not alex) declined the push of feature/SHOP-3546.' }, 2),
      e('tool.called', { runId: 'r5', toolUseId: 'b', tool: 'Bash', title: 'npm run test:unit', inputSummary: '{}', allowed: true }, 3),
      e('run.state_changed', { runId: 'r5', state: 'failed', reason: 'The agent stopped with an error.' }, 4),
    ]);
    expect(transcriptLines(s.runs.r5!, time(600))).toEqual([
      { kind: 'call', tool: 'Bash', text: 'git push 2>&1 | tail -20' },
      { kind: 'out', text: '└ The tester (not alex) declined the push of feature/SHOP-3546.' },
      { kind: 'call', tool: 'Bash', text: 'npm run test:unit' },
      { kind: 'out', text: '└ no result: the run ended first' },
    ]);
  });

  it('shows the workspace’s reminders where they were sent, apart from guidance', () => {
    const e = eventFactory();
    const s = foldAll([
      e('run.created', { runId: 'r6', ticket: 'SHOP-3546', worktree: '', branch: 'feature/SHOP-3546', agentNumber: 6 }, 0),
      e('tool.called', { runId: 'r6', toolUseId: 'g', tool: 'Grep', title: 'error_code', inputSummary: '{}', allowed: true }, 1),
      e('tool.finished', { runId: 'r6', toolUseId: 'g', ok: true, outputSummary: '' }, 2),
      e('run.reminded', { runId: 'r6', about: 'heartbeat', text: 'It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.' }, 3),
    ]);
    expect(transcriptLines(s.runs.r6!, time(10)).at(-1)).toEqual({ kind: 'reminder', text: 'the workspace: It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.' });
  });

  it('says where the run is in one muted line', () => {
    expect(statusLine(agent3().runs.r3!)).toBe('step 1, 412k of 3M tokens');
  });

  it('stacks sub-agents running first, counts them by outcome, and says what a running one is doing', () => {
    const run = agent3().runs.r3!;
    expect(stackOrder(run).map((x) => x.subagentId)).toEqual(['s1', 's0']);
    expect(subagentCounts(run).map((c) => c.label)).toEqual(['1 running', '1 cancelled']);
    const [s1, s0] = stackOrder(run);
    expect(subagentMeta(s0!, time(100))).toBe('cancelled, 54s');
    expect(subagentMeta(s1!, time(78))).toBe('running 1.2m');
    expect(subagentResult(s1!, time(78))).toBe('Running npm run test:unit, 1m 12s');
    expect(subagentResult(s0!, time(100))).toBe('Cancelled by Agent 3');
  });
});

describe('a failed run’s pane', () => {
  it('offers to dismiss it; dismissed, it stops counting as broken and its status says so', () => {
    const e = eventFactory();
    const failed = foldAll([
      e('run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }, 0),
      e('run.state_changed', { runId: 'r3', state: 'failed', reason: 'The daemon restarted' }, 1),
    ]);
    const html = renderToStaticMarkup(<FailedLine run={failed.runs.r3!} onDismiss={() => {}} />);
    expect(html).toContain('Agent 3 failed: The daemon restarted');
    expect(html).toContain('data-tip="It stops counting as broken and leaves the map; it stays in history."');
    expect(html).toContain('>Dismiss</button>');
    expect(statusItems(failed)).toEqual([{ kind: 'broken', count: 1, sentence: '1 agent failed' }]);

    const dismissed = foldAll([e('run.dismissed', { runId: 'r3', by: 'you' }, 2)], failed);
    expect(statusItems(dismissed)).toEqual([]);
    expect(isRunActive(dismissed.runs.r3!)).toBe(false);
    expect(dismissed.runs.r3!.state).toBe('failed');
    expect(statusLine(dismissed.runs.r3!)).toBe('starting, 0 tokens, failed: The daemon restarted, dismissed by you');
    // Only a failed run can be dismissed.
    const running = foldAll([
      e('run.created', { runId: 'r5', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 5 }, 3),
      e('run.state_changed', { runId: 'r5', state: 'running' }, 4),
      e('run.dismissed', { runId: 'r5', by: 'you' }, 5),
    ]);
    expect(running.runs.r5!.dismissed).toBeUndefined();
  });
});
