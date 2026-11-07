import { describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { activeRuns, conversationGroups, fold, foldAll, initialState } from '@elfoqsy/state';
import { eventFactory, mockSprint, time } from './helpers';

const { open } = mockSprint();
const ticket = (key: string) => open.find((t) => t.key === key)!;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** A small but complete stream: sprint, PRs, four runs, sub-agents, an approval and its answer. */
function sampleStream(): AnyEnvelope[] {
  const e = eventFactory();
  const events: AnyEnvelope[] = [
    ...open.map((t) => e('ticket.synced', { ticket: t }, 0)),
    e('pr.synced', { pr: { repo: 'shop-shared', number: 159, state: 'open', ticket: 'SHOP-3472', url: '', checks: 'none' } }, 0),
  ];
  [
    ['r1', 'SHOP-3533', 1],
    ['r2', 'SHOP-3472', 2],
    ['r3', 'SHOP-2091', 3],
    ['r4', 'SHOP-3546', 4],
  ].forEach(([runId, key, n]) => {
    events.push(e('run.created', { runId: runId as string, ticket: key as string, worktree: '/w', branch: `feature/${key}`, agentNumber: n as number }, 1));
    events.push(e('run.state_changed', { runId: runId as string, state: 'running' }, 1));
  });
  events.push(
    e('run.step_begun', { runId: 'r2', stepIndex: 0, name: 'Rebase', why: '#212 depends on shared-modules #159.' }, 2),
    e('run.note', { runId: 'r2', text: 'Rebased #212 on shared-modules #159.' }, 2),
    e('subagent.started', { runId: 'r2', subagentId: 's1', parentToolUseId: 'tu1', model: 'claude-sonnet-5-5', effort: 'medium', task: 'Run CI on #212' }, 3),
    e('subagent.tool_called', { runId: 'r2', subagentId: 's1', tool: 'Bash', inputSummary: 'npm run test:unit', outputSummary: '1 failed', ok: false }, 5),
    e('subagent.finished', { runId: 'r2', subagentId: 's1', outcome: 'failed', result: 'protobufjs peer version mismatch', tokens: 41_000, toolCalls: 1, durationMs: 6_000 }, 9),
    e('approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'question', question: 'Which Confluence space?' }, 4),
    e('elfoqsy.message', { messageId: 'm1', role: 'elfoqsy', text: 'Which Confluence space?', refs: { approvalId: 'a1' } }, 4),
    e('elfoqsy.message', { messageId: 'm2', role: 'you', text: 'SHOP space', refs: { approvalId: 'a1' } }, 10),
    e('approval.resolved', { approvalId: 'a1', decision: 'answered', answer: 'SHOP space' }, 10),
  );
  return events;
}

describe('fold: tickets and pull requests (left screen)', () => {
  it('adds, replaces and removes tickets by key', () => {
    const e = eventFactory();
    const s1 = foldAll([e('ticket.synced', { ticket: ticket('SHOP-3546') })]);
    const s2 = fold(s1, e('ticket.synced', { ticket: { ...ticket('SHOP-3546'), status: 'In progress' } }));
    expect(s2.tickets['SHOP-3546']?.status).toBe('In progress');
    const s3 = fold(s2, e('ticket.removed', { key: 'SHOP-3546' }));
    expect(s3.tickets['SHOP-3546']).toBeUndefined();
  });

  it('keys pull requests by repo and number', () => {
    const state = foldAll(sampleStream());
    expect(Object.keys(state.prs)).toEqual(['shop-shared#159']);
  });
});

describe('fold: runs, sub-agents and approvals (right screen)', () => {
  it('builds each run with its step, state, notes and slot', () => {
    const state = foldAll(sampleStream());
    expect(state.runOrder).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(Object.values(state.runs).map((r) => r.slot)).toEqual([0, 1, 2, 3]);
    expect(state.runs.r2).toMatchObject({ agentNumber: 2, step: 'Rebase', state: 'running', notes: [{ text: 'Rebased #212 on shared-modules #159.' }] });
    expect(state.runs.r2).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' }); // the fixed ticket-agent model when the event has none
  });

  it('keeps a full record of each sub-agent: model, effort, its tool calls, outcome and cost', () => {
    const state = foldAll(sampleStream());
    expect(state.runs.r2!.subagents).toEqual([
      expect.objectContaining({
        subagentId: 's1',
        parentToolUseId: 'tu1',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        index: 0,
        startedAt: time(3),
        finishedAt: time(9),
        outcome: 'failed',
        result: 'protobufjs peer version mismatch',
        tokens: 41_000,
        toolCalls: 1,
        durationMs: 6_000,
        tools: [expect.objectContaining({ tool: 'Bash', title: 'npm run test:unit', ok: false, output: '1 failed' })],
      }),
    ]);
    expect(state.runs.r2!.lastFailureAt).toBe(time(9));
  });

  it('keeps every sub-agent, including cancelled ones and who cancelled them', () => {
    const e = eventFactory();
    const events: AnyEnvelope[] = [e('run.created', { runId: 'r', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 })];
    events.push(e('subagent.started', { runId: 'r', subagentId: 'live', model: 'claude-haiku-5-5', effort: 'low', task: 'still working' }));
    for (let i = 0; i < 30; i++) {
      events.push(e('subagent.started', { runId: 'r', subagentId: `s${i}`, model: 'claude-haiku-5-5', effort: 'low', task: 't' }));
      events.push(e('subagent.finished', { runId: 'r', subagentId: `s${i}`, outcome: i === 7 ? 'cancelled' : 'done', ...(i === 7 ? { by: 'you' as const, reason: 'Not needed' } : {}), result: '', tokens: 1, toolCalls: 0, durationMs: 1 }));
    }
    const subs = foldAll(events).runs.r!.subagents;
    expect(subs).toHaveLength(31);
    expect(subs[0]!.subagentId).toBe('live');
    expect(subs.find((s) => s.subagentId === 's7')).toMatchObject({ outcome: 'cancelled', by: 'you', reason: 'Not needed' });
  });

  it('reads sub-agent events written before v1', () => {
    const e = eventFactory();
    const legacy = (type: 'subagent.started' | 'subagent.finished', payload: object) => e(type, payload as never);
    const state = foldAll([
      e('run.created', { runId: 'r', ticket: 'SHOP-1', worktree: '', branch: '', agentNumber: 1 }),
      legacy('subagent.started', { runId: 'r', subagentId: 's', name: 'sonnet-5.5-high', task: 'Run CI' }),
      legacy('subagent.finished', { runId: 'r', subagentId: 's', outcome: 'failure', summary: 'CI failed' }),
    ]);
    expect(state.runs.r!.subagents[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', outcome: 'failed', result: 'CI failed' });
  });

  it('reuses the slot of a run that ended', () => {
    const e = eventFactory();
    const state = foldAll([
      e('run.created', { runId: 'a', ticket: 'K-1', worktree: '', branch: '', agentNumber: 1 }),
      e('run.created', { runId: 'b', ticket: 'K-2', worktree: '', branch: '', agentNumber: 2 }),
      e('run.state_changed', { runId: 'a', state: 'succeeded' }),
      e('run.created', { runId: 'c', ticket: 'K-3', worktree: '', branch: '', agentNumber: 3 }),
    ]);
    expect([state.runs.b!.slot, state.runs.c!.slot]).toEqual([1, 0]);
  });

  it('resolves an approval once and keeps the conversation in order', () => {
    const state = foldAll(sampleStream());
    expect(state.approvals.a1!.resolution).toMatchObject({ decision: 'answered', answer: 'SHOP space' });
    expect(state.messages.map((m) => [m.role, m.text])).toEqual([
      ['elfoqsy', 'Which Confluence space?'],
      ['you', 'SHOP space'],
    ]);
    const e = eventFactory();
    const again = fold(state, { ...e('approval.resolved', { approvalId: 'a1', decision: 'denied' }), seq: state.seq + 1 });
    expect(again.approvals.a1!.resolution?.decision).toBe('answered');
  });

  it('never shows a test message or a test answer as Alex’s, including ones marked after the fact', () => {
    const e = eventFactory();
    const state = foldAll([
      e('elfoqsy.message', { messageId: 'm1', role: 'you', text: 'Cancel the run on SHOP-3546.' }, 1),
      e('elfoqsy.message', { messageId: 'm2', role: 'test', text: 'start an agent on SHOP-3546' }, 2),
      e('elfoqsy.message_marked', { messageId: 'm1', role: 'test', note: 'Typed by Claude Code during a live check.' }, 3),
      e('elfoqsy.message_marked', { messageId: 'nope', role: 'test' }, 4),
      e('approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'push', question: 'Push?' }, 5),
      e('approval.resolved', { approvalId: 'a1', decision: 'denied', test: true }, 6),
    ]);
    expect(state.messages.map((m) => [m.messageId, m.role])).toEqual([
      ['m1', 'test'],
      ['m2', 'test'],
    ]);
    expect(state.approvals.a1!.resolution).toMatchObject({ decision: 'denied', test: true });
  });

  it('treats a stopped run as ended, like a finished or cancelled one, and a failed one as still on screen', () => {
    const e = eventFactory();
    const created = (runId: string, agentNumber: number) => e('run.created', { runId, ticket: 'SHOP-3546', worktree: `/w/${runId}`, branch: 'feature/SHOP-3546', agentNumber });
    const state = foldAll([
      created('s', 1),
      e('run.state_changed', { runId: 's', state: 'stopped', reason: 'Fixed it. Not counted as succeeded: its tests did not run.' }),
      created('f', 2),
      e('run.state_changed', { runId: 'f', state: 'failed', reason: 'Crashed.' }),
    ]);
    expect(activeRuns(state).map((r) => r.runId)).toEqual(['f']);
    expect(state.runs.s!.state).toBe('stopped');
  });

  it('keeps each run’s goal and checks, with their evidence, across a re-declaration', () => {
    const e = eventFactory();
    const unit = { id: 'unit', description: 'Unit tests pass', proof: 'command' as const, command: 'npm run test:unit' };
    const ci = { id: 'ci', description: 'CI passes', proof: 'ci' as const };
    const state = foldAll([
      e('run.created', { runId: 'r', ticket: 'SHOP-3546', worktree: '/w/r', branch: 'feature/SHOP-3546', agentNumber: 1 }),
      e('run.goal_declared', { runId: 'r', revision: 1, goal: 'Provider errors reach checkout.', checks: [unit, ci] }),
      e('run.check_changed', { runId: 'r', checkId: 'unit', status: 'passed', evidence: '`npm run test:unit` passed at 14:32.' }),
      e('run.goal_declared', { runId: 'r', revision: 2, goal: 'Provider errors reach checkout.', checks: [unit, { id: 'repro', description: 'Repro passes', proof: 'command' as const, command: 'node repro.js' }] }),
    ]);
    const run = state.runs.r!;
    expect(run).toMatchObject({ goal: 'Provider errors reach checkout.', goalRevision: 2 });
    expect(run.checks).toEqual([
      { ...unit, status: 'passed', evidence: '`npm run test:unit` passed at 14:32.' },
      { id: 'repro', description: 'Repro passes', proof: 'command', command: 'node repro.js', status: 'pending' },
    ]);
  });

  it('forms steps as the agent goes: one open at a time, each with its outcome', () => {
    const e = eventFactory();
    const state = foldAll([
      e('run.created', { runId: 'r', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }, 0),
      e('run.step_begun', { runId: 'r', stepIndex: 0, name: 'Reproduce', why: 'Why is the whole cart discounted?' }, 1),
      e('run.step_ended', { runId: 'r', stepIndex: 0, outcome: 'done', note: 'Reproduced' }, 4),
      e('run.step_begun', { runId: 'r', stepIndex: 1, name: 'Fix aggregation', why: 'Guidance' }, 5),
      e('run.step_begun', { runId: 'r', stepIndex: 2, name: 'Unit tests', why: 'Prove it' }, 9), // ends step 1 itself
    ]);
    const run = state.runs.r!;
    expect(run.steps.map((s) => [s.name, s.beganAt, s.endedAt, s.outcome, s.note])).toEqual([
      ['Reproduce', time(1), time(4), 'done', 'Reproduced'],
      ['Fix aggregation', time(5), time(9), 'done', undefined],
      ['Unit tests', time(9), undefined, undefined, undefined],
    ]);
    expect(run.step).toBe('Unit tests');
    const ended = fold(state, e('run.state_changed', { runId: 'r', state: 'cancelled' }, 12));
    expect(ended.runs.r!.steps.at(-1)).toMatchObject({ endedAt: time(12), outcome: 'abandoned' });
    expect(ended.runs.r!.step).toBeNull();
  });

  it('keeps heartbeats, Elfoqsy’s acknowledgements, flags, pauses, guidance and usage', () => {
    const e = eventFactory();
    const state = foldAll([
      e('run.created', { runId: 'r', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }),
      e('run.heartbeat', { runId: 'r', step: 'Reproduce', sinceLast: 'Reproduced it.', next: 'Fix it.', progress: 'some', risks: ['Needs Redis'], tokens: 120_000, workingSeconds: 300 }, 300),
      e('run.ack', { runId: 'r', refEventSeq: 2, note: 'Noted the risk.' }, 301),
      e('run.flag', { runId: 'r', kind: 'loop', detail: 'Same failure 3 times.' }, 400),
      e('run.paused', { runId: 'r', by: 'you', reason: 'About to edit generated code' }, 410),
      e('run.guidance', { runId: 'r', text: 'Leave src/generated alone.', by: 'you' }, 412),
      e('run.usage', { runId: 'r', tokens: 150_000, workingSeconds: 420 }, 420),
    ]);
    const run = state.runs.r!;
    expect(run.heartbeats).toEqual([expect.objectContaining({ seq: 2, at: time(300), progress: 'some', risks: ['Needs Redis'], tokens: 120_000 })]);
    expect(run.acked).toEqual([2]);
    expect(run.flags).toEqual([{ at: time(400), kind: 'loop', detail: 'Same failure 3 times.' }]);
    expect(run.paused).toEqual({ by: 'you', since: time(410), reason: 'About to edit generated code' });
    expect(run.guidance).toEqual([{ at: time(412), seq: 6, text: 'Leave src/generated alone.', by: 'you' }]);
    expect(run.usage).toEqual({ tokens: 150_000, workingSeconds: 420, at: time(420) });
    const resumed = fold(state, e('run.resumed', { runId: 'r', by: 'you' }, 430));
    expect(resumed.runs.r!.paused).toBeUndefined();
  });

  it('keeps the agent’s own transcript, finishing each call by its id; a denied call never runs', () => {
    const e = eventFactory();
    const state = foldAll([
      e('run.created', { runId: 'r', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }),
      e('tool.called', { runId: 'r', toolUseId: 't1', tool: 'Edit', title: 'src/pricing/bundles.ts', where: 'shop-api', inputSummary: '{}', allowed: true }, 1),
      e('tool.called', { runId: 'r', toolUseId: 't2', tool: 'Bash', title: 'git push origin main', inputSummary: '{}', allowed: false }, 2),
      e('tool.called', { runId: 'r', subagentId: 's', tool: 'Read', inputSummary: 'x', allowed: true }, 2),
      e('tool.finished', { runId: 'r', toolUseId: 't1', ok: true, outputSummary: '+ parent.av = mergeChildAv(children);', stats: '+2 −1' }, 3),
    ]);
    expect(state.runs.r!.transcript).toEqual([
      expect.objectContaining({ toolUseId: 't1', title: 'src/pricing/bundles.ts', where: 'shop-api', finishedAt: time(3), ok: true, stats: '+2 −1' }),
      expect.objectContaining({ toolUseId: 't2', allowed: false, finishedAt: time(2), ok: false }),
    ]);
  });

  it('ignores events for runs it has not seen, and event types from older logs', () => {
    const e = eventFactory();
    const legacy = e('run.step_begun', { runId: 'r', stepIndex: 0, name: 'x', why: 'y' });
    const state = foldAll([
      e('run.step_begun', { runId: 'ghost', stepIndex: 0, name: 'Fix', why: 'x' }),
      { ...legacy, seq: 2, type: 'run.step_changed', payload: { runId: 'ghost', step: 'code' } } as unknown as AnyEnvelope,
    ]);
    expect(state.runs).toEqual({});
    expect(state.seq).toBe(2);
  });
});

describe('fold: conversations, investigations, memory and briefs (left screen)', () => {
  function planning(): AnyEnvelope[] {
    const e = eventFactory();
    return [
      e('conversation.created', { conversationId: 'c1', title: 'SHOP-1164 has slipped 9 sprints', ticket: 'SHOP-1164' }, 0),
      e('elfoqsy.message', { messageId: 'm1', role: 'you', text: 'Plan a fix', conversationId: 'c1' }, 1),
      e('conversation.renamed', { conversationId: 'c1', title: 'Plan the SHOP-1164 stall fix' }, 2),
      e('investigation.started', { investigationId: 'i1', conversationId: 'c1', question: 'Why does it freeze?', model: 'claude-sonnet-5-5', effort: 'high' }, 3),
      e('investigation.finished', {
        investigationId: 'i1',
        conversationId: 'c1',
        title: "What's actually happening",
        findings: [{ text: 'The export step cache has no per-step timeout.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:88' }] }],
        filesRead: 14,
        durationMs: 220_000,
      }, 223),
      e('memory.saved', { factId: 'f1', statement: 'No per-step timeout', sources: [{ kind: 'code', ref: 'cache.ts:88' }], freshUntil: new Date(time(7 * 86400)).toISOString(), origin: 'investigator' }, 224),
      e('brief.created', { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-1164', title: 'Per-step timeout for SHOP-1164', sections: [{ heading: 'Goal', markdown: 'Always a result.' }] }, 230),
      e('elfoqsy.message', {
        messageId: 'm2',
        role: 'elfoqsy',
        text: 'Here is the brief.',
        conversationId: 'c1',
        blocks: [{ type: 'brief', ref: 'b1' }, { type: 'code', language: 'ts', content: 'const x = 1;' }],
        attachments: [{ attachmentId: 'a1', name: 'freeze.png', mediaType: 'image/png', bytes: 1200 }],
      }, 231),
      e('run.created', { runId: 'r5', ticket: 'SHOP-1164', worktree: '', branch: 'feature/SHOP-1164', agentNumber: 5, briefId: 'b1', conversationId: 'c1' }, 240),
      e('brief.handed_off', { briefId: 'b1', runId: 'r5' }, 240),
      e('usage.status', { fiveHourPct: 42, sevenDayPct: 61, resetsAt: new Date(time(3600)).toISOString() }, 241),
    ];
  }

  it('keeps conversations with their latest title, ticket and message count', () => {
    const state = foldAll(planning());
    expect(state.conversations.c1).toEqual({ conversationId: 'c1', title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164', createdAt: time(0), lastAt: time(231), messageCount: 2 });
    expect(state.messages.at(-1)).toMatchObject({ conversationId: 'c1', blocks: [{ type: 'brief', ref: 'b1' }, { type: 'code' }], attachments: [{ name: 'freeze.png' }] });
  });

  it('keeps investigations with their cited findings, saved facts, and briefs linked to the runs they started', () => {
    const state = foldAll(planning());
    expect(state.investigations.i1).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', startedAt: time(3), finishedAt: time(223), filesRead: 14, title: "What's actually happening" });
    expect(state.investigations.i1!.findings[0]!.sources).toEqual([{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:88' }]);
    expect(state.memory.f1).toMatchObject({ origin: 'investigator', freshUntil: time(7 * 86400) });
    expect(state.briefs.b1!.runIds).toEqual(['r5']);
    expect(state.runs.r5).toMatchObject({ briefId: 'b1', conversationId: 'c1' });
    expect(state.usage).toMatchObject({ fiveHourPct: 42, sevenDayPct: 61, resetsAt: time(3600) });
  });

  it('groups conversations by Today, Yesterday and Earlier, newest first', () => {
    const e = eventFactory();
    const day = 86_400;
    const state = foldAll([
      e('conversation.created', { conversationId: 'old', title: 'Weekly review' }, -10 * day),
      e('conversation.created', { conversationId: 'y', title: 'Push 3546' }, -day),
      e('conversation.created', { conversationId: 't1', title: 'Morning' }, -60),
      e('conversation.created', { conversationId: 't2', title: 'Now' }, -1),
    ]);
    const groups = conversationGroups(state, time(0));
    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.conversationId)])).toEqual([
      ['Today', ['t2', 't1']],
      ['Yesterday', ['y']],
      ['Earlier', ['old']],
    ]);
  });
});

describe('fold: replay', () => {
  it('never mutates the state it is given', () => {
    const events = sampleStream();
    const frozen = deepFreeze(foldAll(events.slice(0, 12)));
    expect(() => foldAll(events.slice(12), frozen)).not.toThrow();
  });

  it('skips events it has already applied', () => {
    const events = sampleStream();
    const state = foldAll(events);
    expect(foldAll(events, state)).toBe(state);
  });

  it('lands on the same state whether replayed at once, resumed from a seq, or sent as JSON', () => {
    const events = sampleStream();
    const atOnce = foldAll(events);
    const resumed = foldAll(events.slice(7), foldAll(events.slice(0, 7)));
    const viaJson = foldAll(JSON.parse(JSON.stringify(events)) as AnyEnvelope[]);
    expect(resumed).toEqual(atOnce);
    expect(viaJson).toEqual(atOnce);
    expect(initialState.seq).toBe(0);
  });
});
