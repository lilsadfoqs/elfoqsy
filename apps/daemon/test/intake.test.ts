import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { EventLog } from '../src/eventLog';
import type { RunControl } from '../src/agents/control';
import { Intake, IntakeError, firstTitle } from '../src/intake';

let log: EventLog;
const all = (): AnyEnvelope[] => log.readFrom(0, 10_000);
const ofType = <T extends AnyEnvelope['type']>(type: T) => all().filter((e): e is Extract<AnyEnvelope, { type: T }> => e.type === type);

beforeEach(() => {
  log = new EventLog(':memory:', () => new Date('2026-10-08T14:15:00Z'));
});
afterEach(() => log.close());

describe('Intake: messages and conversations', () => {
  it('starts a new conversation for a message without one, titled by its first line, with its ticket', () => {
    const intake = new Intake(log);
    intake.handle({ t: 'say', text: 'do SHOP-3049', test: true });
    const [created] = ofType('conversation.created');
    expect(created?.payload).toMatchObject({ title: 'do SHOP-3049', ticket: 'SHOP-3049' });
    expect(ofType('elfoqsy.message')[0]?.payload).toMatchObject({ role: 'test', text: 'do SHOP-3049', conversationId: created!.payload.conversationId });
    intake.close();
  });

  it('adds to a known conversation, and refuses an unknown one', () => {
    log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'Plan' });
    const intake = new Intake(log);
    intake.handle({ t: 'say', text: 'makes sense', conversationId: 'c1', test: true });
    expect(ofType('conversation.created')).toHaveLength(1);
    expect(ofType('elfoqsy.message')[0]?.payload.conversationId).toBe('c1');
    expect(() => intake.handle({ t: 'say', text: 'hi', conversationId: 'nope', test: true })).toThrow(IntakeError);
    intake.close();
  });

  it('keeps a typed answer in the conversation its question was asked in', () => {
    const intake = new Intake(log);
    log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'Benchmark' });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'question', question: 'Which space?' });
    log.append('elfoqsy', 'elfoqsy.message', { messageId: 'm1', role: 'elfoqsy', text: 'Which space?', conversationId: 'c1', refs: { approvalId: 'a1' } });
    intake.handle({ t: 'answer', approvalId: 'a1', decision: 'answered', answer: 'SHOP', test: true });
    expect(ofType('elfoqsy.message').at(-1)?.payload).toMatchObject({ role: 'test', text: 'SHOP', conversationId: 'c1' });
    intake.close();
  });

  it('shortens a long first line at a word', () => {
    const title = firstTitle('Why does checkout drop every 429 error it gets from the payment provider when the rate limit is hit?');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
    expect(firstTitle('one\ntwo')).toBe('one');
  });
});

describe('Intake: guidance from a pane', () => {
  const run = () => log.append('orchestrator', 'run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: 'feature/SHOP-2091', agentNumber: 3 });

  /** A stand-in for the orchestrator: records what the pane asked, by whom. */
  function control(refuse?: string): RunControl & { calls: unknown[] } {
    const calls: unknown[] = [];
    const answer = (call: unknown[]) => (calls.push(call), refuse ? { error: 'x', message: refuse } : { ok: true as const });
    return {
      calls,
      pause: (runId, by) => answer(['pause', runId, by]),
      resume: (runId, by) => answer(['resume', runId, by]),
      guide: (runId, text, by) => answer(['guide', runId, text, by]),
    };
  }

  it('hands pause, resume and guidance to the run control, as the tester’s or his', () => {
    run();
    const runs = control();
    const intake = new Intake(log, { runs });
    intake.handle({ t: 'guide', runId: 'r3', text: 'Leave src/generated alone.', test: true });
    intake.handle({ t: 'pause', runId: 'r3' });
    intake.handle({ t: 'resume', runId: 'r3', test: true });
    expect(runs.calls).toEqual([
      ['guide', 'r3', 'Leave src/generated alone.', 'tester'],
      ['pause', 'r3', 'you'],
      ['resume', 'r3', 'tester'],
    ]);
    intake.close();
  });

  it('refuses an agent that is not running, says why the control refused, and needs a control', () => {
    run();
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-3490', worktree: '', branch: '', agentNumber: 1 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r1', state: 'succeeded' });
    const intake = new Intake(log, { runs: control('Agent 3 is waiting for an answer to its question; answer it first.') });
    expect(() => intake.handle({ t: 'guide', runId: 'r1', text: 'x', test: true })).toThrow('That agent is not running.');
    expect(() => intake.handle({ t: 'pause', runId: 'r3', test: true })).toThrow('Agent 3 is waiting for an answer to its question; answer it first.');
    const without = new Intake(log);
    expect(() => without.handle({ t: 'pause', runId: 'r3', test: true })).toThrow('Agents cannot be paused or guided here.');
    intake.close();
    without.close();
  });
});

describe('Intake: dismissing a failed run', () => {
  it('acknowledges a failed run from its pane, once, and nothing else', async () => {
    const { foldAll, statusItems, isRunActive } = await import('@elfoqsy/state');
    const intake = new Intake(log);
    log.append('orchestrator', 'run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r3', state: 'running' });
    expect(() => intake.handle({ t: 'dismiss', runId: 'r3', test: true })).toThrow('Only a failed run can be dismissed.');
    log.append('orchestrator', 'run.state_changed', { runId: 'r3', state: 'failed', reason: 'The daemon restarted and the agent stopped.' });
    expect(statusItems(foldAll(all()))).toEqual([{ kind: 'broken', count: 1, sentence: '1 agent failed' }]);

    intake.handle({ t: 'dismiss', runId: 'r3', reason: 'Old run.', test: true });
    expect(ofType('run.dismissed').map((e) => e.payload)).toEqual([{ runId: 'r3', by: 'tester', reason: 'Old run.' }]);
    expect(() => intake.handle({ t: 'dismiss', runId: 'r3' })).toThrow('That run is already dismissed.');
    expect(() => intake.handle({ t: 'dismiss', runId: 'nope' })).toThrow('Only a failed run can be dismissed.');

    // No longer broken or active, still failed in history.
    const s = foldAll(all());
    expect(statusItems(s)).toEqual([]);
    expect(s.runs.r3).toMatchObject({ state: 'failed', dismissed: { by: 'tester', reason: 'Old run.' } });
    expect(isRunActive(s.runs.r3!)).toBe(false);
    intake.close();
  });
});

describe('Intake: dismissing a CI failure from the ticket view', () => {
  it('acknowledges a failing PR until its next CI result, and nothing else', async () => {
    const { foldAll, statusItems } = await import('@elfoqsy/state');
    const intake = new Intake(log);
    log.append('github', 'pr.synced', { pr: { repo: 'o/r', number: 7, state: 'open', ticket: 'SHOP-1', url: '', checks: 'none' } });
    expect(() => intake.handle({ t: 'dismiss_ci', repo: 'o/r', pr: 7, test: true })).toThrow('CI is not failing on that pull request.');
    log.append('github', 'ci.status', { repo: 'o/r', pr: 7, sha: 'abc', status: 'failure', url: '' });
    expect(statusItems(foldAll(all()))[0]).toMatchObject({ kind: 'broken', count: 1 });
    intake.handle({ t: 'dismiss_ci', repo: 'o/r', pr: 7, test: true });
    expect(ofType('ci.dismissed').map((e) => e.payload)).toEqual([{ repo: 'o/r', pr: 7, sha: 'abc', by: 'tester' }]);
    expect(statusItems(foldAll(all()))).toEqual([]);
    expect(() => intake.handle({ t: 'dismiss_ci', repo: 'o/r', pr: 7 })).toThrow('That CI failure is already dismissed.');
    // The next CI result: failing again counts again, and can be dismissed again.
    log.append('github', 'ci.status', { repo: 'o/r', pr: 7, sha: 'def', status: 'failure', url: '' });
    expect(statusItems(foldAll(all()))[0]).toMatchObject({ kind: 'broken', count: 1 });
    intake.handle({ t: 'dismiss_ci', repo: 'o/r', pr: 7 });
    expect(ofType('ci.dismissed').at(-1)!.payload).toMatchObject({ sha: 'def', by: 'you' });
    intake.close();
  });
});

describe('Intake: grants and Undo (v1.2)', () => {
  it('takes "Allow for this ticket" only on an approval that offers it, and only as an approval', () => {
    const intake = new Intake(log);
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'action', tier: 2, question: 'Mark #812 ready?', grantable: { kind: 'gh.pr.ready' } });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a2', runId: 'r1', kind: 'check', question: 'Is the page done?' });
    expect(() => intake.handle({ t: 'answer', approvalId: 'a2', decision: 'approved', scope: 'ticket', test: true })).toThrow('This approval cannot be given for the whole ticket.');
    expect(() => intake.handle({ t: 'answer', approvalId: 'a1', decision: 'denied', scope: 'ticket', test: true })).toThrow('Only an approval can be given for the whole ticket.');
    intake.handle({ t: 'answer', approvalId: 'a1', decision: 'approved', scope: 'ticket', test: true });
    expect(ofType('approval.resolved').map((e) => e.payload)).toEqual([{ approvalId: 'a1', decision: 'approved', test: true, scope: 'ticket' }]);
    intake.close();
  });

  it('hands Undo of a recorded change to the orchestrator, as the tester’s or his, once, and only when it can be undone', async () => {
    const asked: Array<[string, string]> = [];
    const intake = new Intake(log, { undo: async (recordId, by) => void asked.push([recordId, by]) });
    log.append('orchestrator', 'change.recorded', { recordId: 'rec1', actionId: 'act1', runId: 'r1', target: 'deployment/shop-api on dev', before: 'image b:1', undo: { proxy: 'kube', summary: 'Set it back', request: { args: [] } } });
    log.append('orchestrator', 'change.recorded', { recordId: 'rec2', actionId: 'act2', runId: 'r1', target: 'feature/X on GitHub', before: 'not on GitHub', noUndo: 'Taking a push back would need a force-push.' });
    intake.handle({ t: 'undo', recordId: 'rec1', test: true });
    expect(asked).toEqual([['rec1', 'tester']]);
    expect(() => intake.handle({ t: 'undo', recordId: 'rec2' })).toThrow('Taking a push back would need a force-push.');
    expect(() => intake.handle({ t: 'undo', recordId: 'nope' })).toThrow('There is no such change to undo.');
    log.append('orchestrator', 'change.undone', { recordId: 'rec1', actionId: 'act3', by: 'tester' });
    expect(() => intake.handle({ t: 'undo', recordId: 'rec1' })).toThrow('That change is already undone.');
    intake.close();
  });
});

describe('Intake: the narrative and the ready-for-review gate (N1)', () => {
  const setup = async () => {
    const { LiveState } = await import('../src/elfoqsy/liveState');
    const { narrativeRead } = await import('@elfoqsy/state');
    const live = new LiveState(log);
    const marked: Array<[string, string]> = [];
    const intake = new Intake(log, {
      narrativeRead: (id) => {
        const r = live.get().runs[id];
        if (!r) return false;
        const read = narrativeRead(r);
        return read.read || (!!r.test && read.testerRead);
      },
      markReady: async (runId, by) => {
        marked.push([runId, by]);
        return { ok: true };
      },
    });
    log.append('orchestrator', 'run.created', { runId: 'r1', ticket: 'SHOP-3151', worktree: '', branch: 'feature/SHOP-3151', agentNumber: 4 });
    log.append('agent', 'run.understanding', { runId: 'r1', claim: 'c', input: 'i', actual: 'a', expected: 'e', sources: [{ kind: 'ticket', ref: 'SHOP-3151' }] });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'action', tier: 2, question: 'Mark it ready?', action: 'gh pr ready 140', gate: 'narrative' });
    return { intake, live, marked };
  };

  it('records his tick as his and the tester’s as the tester’s, for a run that exists', async () => {
    const { intake, live } = await setup();
    expect(() => intake.handle({ t: 'narrative_read', runId: 'nope' })).toThrow('There is no such run.');
    intake.handle({ t: 'narrative_read', runId: 'r1', test: true });
    intake.handle({ t: 'narrative_read', runId: 'r1' });
    expect(ofType('narrative.read').map((e) => e.payload)).toEqual([
      { runId: 'r1', ticket: 'SHOP-3151', by: 'tester' },
      { runId: 'r1', ticket: 'SHOP-3151', by: 'you' },
    ]);
    intake.close();
    live.close();
  });

  it('does not let a ready-for-review ask be approved before he has read the narrative, nor after it changed', async () => {
    const { intake, live } = await setup();
    expect(() => intake.handle({ t: 'answer', approvalId: 'a1', decision: 'approved' })).toThrow('Read the narrative first');
    // Denying needs no reading.
    intake.handle({ t: 'narrative_read', runId: 'r1', test: true });
    expect(() => intake.handle({ t: 'answer', approvalId: 'a1', decision: 'approved', test: true })).toThrow('Read the narrative first'); // the tester's tick opens nothing in a real run
    intake.handle({ t: 'narrative_read', runId: 'r1' });
    // The agent says more: what he read is no longer what the narrative says.
    log.append('agent', 'run.root_cause', { runId: 'r1', text: 'A different cause.', lines: [{ kind: 'code', ref: 'a.ts:1' }] });
    expect(() => intake.handle({ t: 'answer', approvalId: 'a1', decision: 'approved' })).toThrow('Read the narrative first');
    intake.handle({ t: 'narrative_read', runId: 'r1' });
    intake.handle({ t: 'answer', approvalId: 'a1', decision: 'approved' });
    expect(ofType('approval.resolved').map((e) => e.payload)).toEqual([{ approvalId: 'a1', decision: 'approved' }]);
    intake.close();
    live.close();
  });

  it('"Mark ready for review" answers the agent’s own ask, or marks the draft once when it has not asked; both after the tick', async () => {
    const { intake, live, marked } = await setup();
    expect(() => intake.handle({ t: 'mark_ready', runId: 'r1' })).toThrow('Read the narrative first');
    intake.handle({ t: 'narrative_read', runId: 'r1' });
    intake.handle({ t: 'mark_ready', runId: 'r1' });
    expect(ofType('approval.resolved').map((e) => e.payload)).toEqual([{ approvalId: 'a1', decision: 'approved' }]);
    expect(marked).toEqual([]); // the agent had asked, so its question was answered
    intake.handle({ t: 'mark_ready', runId: 'r1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(marked).toEqual([['r1', 'you']]);
    intake.close();
    live.close();
  });
});

describe('Intake: the screens\' layout (P2)', () => {
  const today = [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]] as never;

  it('saves his arrangement as an event, and null as no layout saved', () => {
    const intake = new Intake(log);
    intake.handle({ t: 'layout_set', layout: [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]] });
    intake.handle({ t: 'layout_set', layout: null });
    expect(ofType('layout.changed').map((e) => e.payload)).toEqual([{ layout: [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]], by: 'you' }, { layout: null, by: 'you' }]);
    expect(ofType('layout.changed')[0]?.source).toBe('orchestrator');
    intake.close();
  });

  it('saves today\'s arrangement as no layout, so the screens go back to their own geometry', () => {
    const intake = new Intake(log);
    intake.handle({ t: 'layout_set', layout: [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]] });
    expect(ofType('layout.changed').map((e) => e.payload)).toEqual([{ layout: null, by: 'you' }]);
    intake.close();
  });

  it('refuses an arrangement where a pane would be below its minimum, and changes nothing', () => {
    const intake = new Intake(log);
    // Four panes in one column leave each 228 px, under the 240 minimum height.
    expect(() => intake.handle({ t: 'layout_set', layout: [[['sprint', 'elfoqsy', 'conversation', 'map'], ['terminals']], []] })).toThrow(/does not fit/);
    // Five columns on one screen: their minimum widths (240 + 330 + 380 + 300 + 300) and four gaps fit the 1840 px.
    expect(() => intake.handle({ t: 'layout_set', layout: [[['sprint'], ['elfoqsy'], ['conversation'], ['map'], ['terminals']], []] })).not.toThrow();
    expect(ofType('layout.changed')).toHaveLength(1);
    intake.close();
  });

  it('keeps a layout with panes taken off the screens, and one with none on them', () => {
    const intake = new Intake(log);
    intake.handle({ t: 'layout_set', layout: [[['sprint'], ['elfoqsy']], [['map']]] });
    intake.handle({ t: 'layout_set', layout: [[], []] });
    expect(ofType('layout.changed').map((e) => e.payload.layout)).toEqual([[[['sprint'], ['elfoqsy']], [['map']]], [[], []]]);
    intake.close();
  });

  it('refuses the tester: his screens are his', () => {
    const intake = new Intake(log);
    expect(() => intake.handle({ t: 'layout_set', layout: today, test: true })).toThrow('Only alex arranges his screens.');
    expect(ofType('layout.changed')).toHaveLength(0);
    intake.close();
  });

  it('records nothing for an intent: the socket server passes it on', () => {
    const intake = new Intake(log);
    intake.handle({ t: 'relay', intent: { t: 'open_ticket', key: 'SHOP-1' } });
    expect(all()).toHaveLength(0);
    intake.close();
  });
});
