import net from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyEnvelope, EventType } from '@elfoqsy/contracts';
import { parseEnvelope } from '@elfoqsy/contracts';
import { foldAll, handoffMarkdown, narrativeRead } from '@elfoqsy/state';
import { REPO_ROOT } from '../src/config';
import { EventLog } from '../src/eventLog';
import { Intake } from '../src/intake';
import { redact } from '../src/redact';
import { loadMock } from '../src/sim/mock';
import { SimControl } from '../src/sim/control';
import { Simulator, simApprovalId, simRunId } from '../src/sim/simulator';
import { LiveState } from '../src/elfoqsy/liveState';
import { ulid } from '../src/ulid';

const NOW = new Date('2026-10-08T14:06:00Z').getTime();
const HOUR = 3_600_000;

let log: EventLog;
let sim: Simulator;
let events: AnyEnvelope[];
let pinned: number | null;

const all = (): AnyEnvelope[] => log.readFrom(0, 1_000_000);
const ofType = <T extends AnyEnvelope['type']>(type: T) =>
  all().filter((e): e is Extract<AnyEnvelope, { type: T }> => e.type === type);
const forRun = <T extends AnyEnvelope['type']>(type: T, agent: number) =>
  ofType(type).filter((e) => (e.payload as { runId?: string }).runId === simRunId(agent));
const state = () => foldAll(all());

function makeSim(agents?: number): Simulator {
  return new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), {
    worktreesRoot: '/sim/worktrees',
    setTime: (ms) => {
      pinned = ms;
    },
    ...(agents ? { agents } : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  pinned = null;
  log = new EventLog(':memory:', () => new Date(pinned ?? Date.now()));
  events = [];
  log.subscribe((e) => events.push(e));
  sim = makeSim();
});

afterEach(() => {
  sim.stop();
  log.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Simulator', () => {
  it('emits the sprint snapshot', () => {
    sim.start();
    const tickets = ofType('ticket.synced').map((e) => e.payload.ticket);
    expect(tickets).toHaveLength(13); // 7 open, 6 closed
    expect(tickets.find((t) => t.key === 'SHOP-3546')?.description).toMatch(/^When shop-api cannot get an answer from the payment provider/);
    expect(tickets.find((t) => t.key === 'SHOP-2753')).toMatchObject({ status: 'Released', board: 'SHOP', sprint: 'SHOP Sprint 52' });
    expect(ofType('pr.synced').map((e) => `${e.payload.pr.repo}#${e.payload.pr.number}`)).toEqual([
      'shop-shared#159',
      'shop-worker#212',
      'shop-api#214', // agent 4's draft, opened yesterday (tier 1)
    ]);
    expect(ofType('ci.status')).toHaveLength(2);
  });

  it('writes the agreed world as history, each event at the time it happened', () => {
    sim.start();
    const created = ofType('run.created');
    expect(created.map((e) => [e.payload.agentNumber, e.payload.ticket])).toEqual([
      [1, 'SHOP-3490'],
      [2, 'SHOP-2753'],
      [4, 'SHOP-3546'],
      [3, 'SHOP-2091'],
      [5, 'SHOP-1164'],
    ]);
    expect(created.every((e) => e.payload.model === 'claude-opus-5-5' && e.payload.effort === 'xhigh')).toBe(true);
    // Agent 4 handed back yesterday and asked to mark its PR ready; agent 3 started 18 minutes ago.
    const [ready] = ofType('approval.requested');
    expect(ready?.payload).toMatchObject({ approvalId: simApprovalId(4), runId: simRunId(4), kind: 'action', tier: 2, grantable: { kind: 'gh.pr.ready' } });
    expect((NOW - Date.parse(ready!.ts)) / HOUR).toBeCloseTo(20.9, 1);
    expect(NOW - Date.parse(created.find((e) => e.payload.agentNumber === 3)!.ts)).toBe(18 * 60_000);
    // History is written in the order it happened.
    const history = all().filter((e) => !['ticket.synced', 'pr.synced', 'ci.status'].includes(e.type));
    for (let i = 1; i < history.length; i++) expect(Date.parse(history[i]!.ts)).toBeGreaterThanOrEqual(Date.parse(history[i - 1]!.ts));
  });

  it('emits every v1 event type', () => {
    sim.start();
    const types = new Set(all().map((e) => e.type));
    const v1: EventType[] = [
      'run.goal_declared',
      'run.step_begun',
      'run.step_ended',
      'run.heartbeat',
      'run.ack',
      'run.paused',
      'run.resumed',
      'run.guidance',
      'run.usage',
      'subagent.started',
      'subagent.tool_called',
      'subagent.finished',
      'tool.called',
      'tool.finished',
      'usage.status',
      'conversation.created',
      'conversation.renamed',
      'investigation.started',
      'investigation.finished',
      'memory.saved',
      'handoff.created',
      'handoff.handed_off',
      'review.weekly',
    ];
    for (const type of v1) expect(types, type).toContain(type);
    const blocks = new Set(ofType('elfoqsy.message').flatMap((e) => (e.payload.blocks ?? []).map((b) => b.type)));
    expect([...blocks].sort()).toEqual(['approval', 'code', 'findings', 'handoff', 'progress', 'review', 'sprint', 'ticket']);
  });

  it('folds into the agreed screens: three working agents, their steps and sub-agents', () => {
    sim.start();
    const s = state();
    const a3 = s.runs[simRunId(3)]!;
    expect(a3.state).toBe('running');
    expect(a3.steps.map((x) => [x.name, x.outcome ?? 'open'])).toEqual([
      ['Reproduce', 'done'],
      ['Fix the discount', 'done'],
      ['Unit tests', 'open'],
    ]);
    expect(a3.subagents.map((x) => x.outcome ?? 'running')).toEqual(['done', 'done', 'done', 'cancelled', 'running', 'running']);
    expect(a3.usage).toMatchObject({ tokens: 412_000, workingSeconds: 18 * 60 });
    expect(a3.heartbeats).toHaveLength(3);
    expect(a3.guidance).toHaveLength(1);
    expect(a3.paused).toBeUndefined();
    expect(s.runs[simRunId(4)]!.state).toBe('waiting_for_you');
    expect(s.runs[simRunId(5)]).toMatchObject({ handoffId: 'sim-handoff-1164', mode: 'normal' });
    expect(s.handoffs['sim-handoff-1164']!.runIds).toEqual([simRunId(5)]);
    expect(s.conversations['sim-conv-plan']!.title).toBe('Plan the SHOP-1164 stall fix');
    expect(s.usage).toMatchObject({ fiveHourPct: 42, sevenDayPct: 61 });
  });

  it('keeps working agents moving: sub-agents hand over, usage and heartbeats tick', () => {
    sim.start();
    const head = log.headSeq();
    vi.advanceTimersByTime(65_000);
    const started = ofType('subagent.started').filter((e) => e.seq > head);
    expect(new Set(started.map((e) => e.payload.runId))).toEqual(new Set([simRunId(3), simRunId(5)]));
    for (const f of ofType('subagent.finished')) {
      const s = ofType('subagent.started').find((e) => e.payload.subagentId === f.payload.subagentId);
      expect(s, f.payload.subagentId).toBeDefined();
      expect(f.seq).toBeGreaterThan(s!.seq);
    }
    expect(forRun('run.usage', 3).at(-1)!.payload.tokens).toBeGreaterThan(412_000);
    const beats = forRun('run.heartbeat', 3).length;
    vi.advanceTimersByTime(300_000);
    expect(forRun('run.heartbeat', 3).length).toBe(beats + 1);
    // The waiting agent does nothing until it is answered.
    expect(ofType('subagent.started').filter((e) => e.seq > head && e.payload.runId === simRunId(4))).toEqual([]);
  });

  it('shows agent 4’s hand-back as v1.2 does it: push, draft PR and Jira link at once, each in one line; marking it ready asked', () => {
    sim.start();
    const lines = ofType('elfoqsy.message').filter((m) => m.payload.conversationId === 'sim-conv-429' && !m.payload.blocks).map((m) => m.payload.text);
    expect(lines.slice(-3)).toEqual(['Agent 4 pushed feature/SHOP-3546 to shop-api (1 commit).', 'Agent 4 opened shop-api #214 as a draft.', 'Agent 4 linked shop-api #214 in SHOP-3546.']);
    expect(forRun('action.classified', 4).map((a) => [a.payload.kind, a.payload.tier, a.payload.decision])).toEqual([
      ['git.push', 1, 'run'],
      ['gh.pr.create', 1, 'run'],
      ['jira.link_pr', 1, 'run'],
      ['gh.pr.ready', 2, 'ask'],
    ]);
    expect(state().prs['shop-api#214']).toMatchObject({ state: 'draft', ticket: 'SHOP-3546' });
  });

  it('marks agent 4’s PR ready once approved for the ticket, with a grant, then CI passes and the run succeeds', () => {
    const grants: Array<Record<string, unknown>> = [];
    sim = new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), { worktreesRoot: '/sim/worktrees', setTime: (ms) => void (pinned = ms), grants: { create: (g: Record<string, unknown>) => void grants.push(g) } as never });
    sim.start();
    const intake = new Intake(log);
    intake.handle({ t: 'answer', approvalId: simApprovalId(4), decision: 'approved', scope: 'ticket' });
    vi.advanceTimersByTime(1_000);
    expect(grants).toEqual([{ ticket: 'SHOP-3546', runId: simRunId(4), kind: 'gh.pr.ready', by: 'you', approvalId: simApprovalId(4) }]);
    expect(forRun('tool.finished', 4).at(-1)!.payload.outputSummary).toContain('alex approved it.');
    expect(state().prs['shop-api#214']).toMatchObject({ state: 'open' });
    expect(forRun('run.step_begun', 4).at(-1)!.payload.name).toBe('Wait for CI');
    expect(forRun('run.state_changed', 4).at(-1)!.payload.state).toBe('running');
    vi.advanceTimersByTime(45_000);
    expect(forRun('run.check_changed', 4).at(-1)!.payload).toMatchObject({ checkId: 'ci', status: 'passed' });
    expect(forRun('run.state_changed', 4).at(-1)!.payload.state).toBe('succeeded');
    intake.close();
  });

  it('sends agent 4 to rework when marking its PR ready is declined', () => {
    sim.start();
    const intake = new Intake(log);
    intake.handle({ t: 'answer', approvalId: simApprovalId(4), decision: 'denied', test: true });
    vi.advanceTimersByTime(1_000);
    expect(forRun('run.step_ended', 4).at(-1)!.payload).toMatchObject({ outcome: 'abandoned' });
    expect(forRun('run.step_begun', 4).at(-1)!.payload.name).toBe('Rework');
    vi.advanceTimersByTime(60_000);
    expect(forRun('run.state_changed', 4).at(-1)!.payload.state).toBe('running');
    intake.close();
  });

  it('acknowledges guidance and has the agent begin its next step', () => {
    sim.start();
    log.append('orchestrator', 'run.guidance', { runId: simRunId(3), text: 'Skip the integration suite.', by: 'tester' });
    vi.advanceTimersByTime(1_000);
    expect(forRun('run.ack', 3).at(-1)!.payload.note).toBe('Watching that it follows.');
    expect(forRun('run.step_ended', 3).at(-1)!.payload).toMatchObject({ stepIndex: 2, outcome: 'abandoned' });
    expect(forRun('run.step_begun', 3).at(-1)!.payload).toMatchObject({ stepIndex: 3, name: 'Re-plan', why: 'Guidance: Skip the integration suite.' });
  });

  it('answers a message in its conversation, saying it is simulate mode', () => {
    sim.start();
    log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'test', text: 'Stop agent 3', conversationId: 'sim-conv-plan' });
    vi.advanceTimersByTime(1_000);
    // Her thinking indicator has something to show while she works.
    expect(ofType('elfoqsy.activity').at(-1)!.payload).toMatchObject({ conversationId: 'sim-conv-plan', tool: 'workspace', text: 'Read the sprint', state: 'running' });
    vi.advanceTimersByTime(2_500);
    const reply = ofType('elfoqsy.message').at(-1)!.payload;
    expect(reply).toMatchObject({ role: 'elfoqsy', conversationId: 'sim-conv-plan' });
    expect(reply.text).toMatch(/simulate mode/);
  });

  it('answers a question with an investigator at work, then one that found nothing, as it is simulate mode', () => {
    sim.start();
    log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'test', text: 'Is agent 3 nearly done?', conversationId: 'sim-conv-plan' });
    vi.advanceTimersByTime(7_000);
    const started = ofType('investigation.started').at(-1)!.payload;
    expect(started).toMatchObject({ conversationId: 'sim-conv-plan', question: 'Is agent 3 nearly done?', model: 'claude-sonnet-5-5', effort: 'high' });
    const reply = ofType('elfoqsy.message').at(-1)!.payload;
    expect(reply.text).toMatch(/simulate mode/);
    expect(reply.blocks).toEqual([{ type: 'findings', ref: started.investigationId }]);
    expect(state().investigations[started.investigationId]!.finishedAt).toBeUndefined();
    vi.advanceTimersByTime(30_000);
    const finished = ofType('investigation.finished').at(-1)!.payload;
    expect(finished).toMatchObject({ investigationId: started.investigationId, title: 'Simulate mode', filesRead: 0 });
    expect(finished.findings[0]!.sources).toEqual([]);
  });

  it('hands SHOP-1164 over with his words and his constraint, the findings as sourced facts, and her hypothesis left out', () => {
    sim.start();
    const s = state();
    const h = s.handoffs['sim-handoff-1164']!;
    const said = s.messages.filter((m) => m.conversationId === 'sim-conv-plan');
    expect(h.context.map((m) => m.text)).toEqual(said.filter((m) => m.role === 'you').map((m) => m.text));
    expect(h.constraints).toEqual([{ text: 'keep export-step-timeout as it is', messageId: 'sim-msg-plan-3' }]);
    expect(h.facts.every((f) => f.sources.length > 0)).toBe(true);
    // Her hypothesis is labelled as one in chat, and nothing of it reaches the agent.
    expect(said.find((m) => m.role === 'elfoqsy' && m.text.startsWith('Hypothesis:'))).toBeDefined();
    expect(handoffMarkdown(h)).not.toMatch(/per step|per-step|Hypothesis/i);
  });

  it('stops a paused agent until it is resumed, and re-plans after guidance given from the pane as one action', () => {
    sim.start();
    const live = new LiveState(log);
    const control = new SimControl(log, () => live.get());
    const runId = simRunId(3);
    expect(control.pause(runId, 'tester')).toEqual({ ok: true });
    expect(control.pause(runId, 'tester')).toMatchObject({ error: 'already_paused' });
    const usageBefore = forRun('run.usage', 3).length;
    vi.advanceTimersByTime(120_000);
    expect(forRun('run.usage', 3)).toHaveLength(usageBefore); // nothing moves while paused
    expect(control.resume(runId, 'tester')).toEqual({ ok: true });
    vi.advanceTimersByTime(31_000);
    expect(forRun('run.usage', 3).length).toBeGreaterThan(usageBefore);

    // Guidance pauses, gives it and resumes as one action; the agent re-plans.
    expect(control.guide(runId, 'Skip the integration suite.', 'tester')).toEqual({ ok: true });
    const tail = all().slice(-3).map((e) => e.type);
    expect(tail).toEqual(['run.paused', 'run.guidance', 'run.resumed']);
    vi.advanceTimersByTime(1_000);
    expect(forRun('run.step_begun', 3).at(-1)!.payload).toMatchObject({ name: 'Re-plan', why: 'Guidance: Skip the integration suite.' });
    // A waiting agent cannot be paused: its question comes first.
    expect(control.pause(simRunId(4), 'tester')).toMatchObject({ error: 'waiting' });
    live.close();
  });

  it('starts an agent when told "do KEY" in a conversation, once per ticket', () => {
    sim.start();
    const intake = new Intake(log);
    intake.handle({ t: 'say', text: 'do SHOP-3049', test: true });
    vi.advanceTimersByTime(5_000); // her actions first: Read SHOP-3049, Look at the agents
    const created = ofType('run.created').at(-1)!;
    expect(created.payload).toMatchObject({ agentNumber: 6, ticket: 'SHOP-3049', branch: 'feature/SHOP-3049' });
    const on = ofType('elfoqsy.message').at(-1)!.payload;
    expect(on.text).toBe("Agent 6 is on SHOP-3049. Say stop and I'll stop it.");
    // The handoff: the tester's message as typed, the ticket as the one fact; started from it.
    const handoff = state().handoffs[(on.blocks![0] as { ref: string }).ref]!;
    expect(handoff).toMatchObject({ ticket: 'SHOP-3049', mode: 'normal', context: [{ role: 'test', text: 'do SHOP-3049' }], runIds: [created.payload.runId] });
    expect(state().runs[created.payload.runId]).toMatchObject({ state: 'running', step: 'Investigate' });
    vi.advanceTimersByTime(65_000);
    expect(forRun('subagent.finished', 6).length).toBeGreaterThan(0);
    intake.handle({ t: 'say', text: 'do SHOP-3049', test: true });
    intake.handle({ t: 'say', text: 'do SHOP-9999', test: true });
    vi.advanceTimersByTime(5_000);
    expect(ofType('elfoqsy.message').slice(-2).map((e) => e.payload.text)).toEqual(
      expect.arrayContaining(['Agent 6 is already on SHOP-3049.', 'SHOP-9999 is not an open ticket in this sprint.']),
    );
    intake.close();
  });

  it('adds generated agents to reach the asked number, some failing, silent or over budget', () => {
    sim = makeSim(30);
    sim.start();
    const active = ofType('run.created').filter((e) => e.payload.agentNumber >= 3);
    expect(active).toHaveLength(30);
    expect(new Set(ofType('run.flag').map((e) => e.payload.kind))).toEqual(new Set(['loop', 'missed_heartbeats', 'budget']));
    const s = state();
    expect(Object.values(s.runs).filter((r) => r.state === 'failed').length).toBeGreaterThan(0);
  });

  it('stops emitting after stop()', () => {
    sim.start();
    vi.advanceTimersByTime(5_000);
    sim.stop();
    const head = log.headSeq();
    vi.advanceTimersByTime(600_000);
    expect(log.headSeq()).toBe(head);
  });

  it('writes only valid events, with nothing left for the redactor to find', () => {
    sim = makeSim(30);
    sim.start();
    vi.advanceTimersByTime(305_000);
    for (const e of all()) {
      expect(parseEnvelope(e)).toEqual(e);
      const json = JSON.stringify(e.payload);
      expect(redact(json)).toBe(json);
    }
  });

  it('never opens a network connection', () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const fetch = vi.spyOn(globalThis, 'fetch');
    sim.start();
    vi.advanceTimersByTime(65_000);
    expect(connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(events.every((e) => e.source === 'simulator')).toBe(true);
  });
});

describe('v1.2 acceptance in simulate mode: a bug, through the real tier policy', () => {
  async function started() {
    const { Approvals } = await import('../src/agents/approvals');
    const { Grants } = await import('../src/permissions/grants');
    const { createProxies } = await import('../src/permissions');
    const { simBackends } = await import('../src/sim/backends');
    const { parseEnvironments } = await import('../src/permissions/environments');
    const { readFileSync } = await import('node:fs');
    const live = new LiveState(log);
    const approvals = new Approvals(log);
    const grants = new Grants(log);
    const proxies = createProxies({
      log,
      approvals,
      grants,
      environments: parseEnvironments(readFileSync(resolve(REPO_ROOT, 'config', 'environments.yaml'), 'utf8')),
      backends: simBackends(log),
      repos: ['acme/shop-api', 'acme/shop-shared'],
      say: (run, text) => log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, conversationId: live.get().runs[run.runId]?.conversationId ?? '', refs: { tickets: [run.ticket], runId: run.runId } }),
    });
    sim = new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), { worktreesRoot: '/sim/worktrees', setTime: (ms) => void (pinned = ms), proxies, grants });
    sim.start();
    // As main.ts wires it: his tick on the narrative is read from the folded state (the tester's counts in the tester's own run).
    const intake = new Intake(log, {
      narrativeRead: (id) => {
        const r = live.get().runs[id];
        if (!r) return false;
        const read = narrativeRead(r);
        return read.read || (!!r.test && read.testerRead);
      },
    });
    const head = log.headSeq();
    intake.handle({ t: 'say', text: 'do SHOP-3049', test: true });
    const conversationId = ofType('conversation.created').at(-1)!.payload.conversationId;
    await vi.advanceTimersByTimeAsync(6_000);
    const runId = ofType('run.created').at(-1)!.payload.runId;
    const after = () => all().filter((e) => e.seq > head);
    const lines = () => after().filter((e): e is Extract<AnyEnvelope, { type: 'elfoqsy.message' }> => e.type === 'elfoqsy.message' && e.payload.role === 'elfoqsy' && e.payload.conversationId === conversationId && !e.payload.blocks).map((e) => e.payload.text);
    const asked = () => after().filter((e): e is Extract<AnyEnvelope, { type: 'approval.requested' }> => e.type === 'approval.requested');
    // Fix, test, push, two draft PRs and two links: well within a minute.
    await vi.advanceTimersByTimeAsync(45_000);
    const before = { lines: lines(), asked: asked().length };
    // Marking the first PR ready asks; it cannot be approved before the narrative is read (N1).
    await vi.advanceTimersByTimeAsync(BATCH);
    const first = asked().at(-1)!;
    expect(() => intake.handle({ t: 'answer', approvalId: first.payload.approvalId, decision: 'approved' })).toThrow('Read the narrative first');
    intake.handle({ t: 'narrative_read', runId });
    intake.handle({ t: 'answer', approvalId: first.payload.approvalId, decision: 'approved' });
    await vi.advanceTimersByTimeAsync(10_000);
    return { runId, before, lines, asked, after, intake, live, proxies, grants, approvals };
  }
  const BATCH = 4_000;

  it('goes from start to draft PRs, branch pushed and the PRs linked in Jira, with no approval, each step one line from Elfoqsy', async () => {
    const { runId, before, asked, intake, live, proxies, grants, approvals } = await started();
    // Nothing was asked on the way, only the ready-for-review step after it.
    expect(asked().map((a) => [a.payload.gate, a.payload.grantable])).toEqual([['narrative', undefined], ['narrative', undefined]]); // one for each PR
    void before.asked;
    expect(before.lines).toEqual([
      "Agent 6's verdict on SHOP-3049: VALID, reproduced.",
      'Agent 6 pushed feature/SHOP-3049 to shop-api and shop-shared (2 commits).',
      'Agent 6 opened shop-api #901 as a draft.',
      'Agent 6 opened shop-shared #902 as a draft.',
      'Agent 6 linked shop-api #901 in SHOP-3049.',
      'Agent 6 linked shop-shared #902 in SHOP-3049.',
    ]);
    const s = state();
    expect(s.prs['shop-api#901']).toMatchObject({ ticket: 'SHOP-3049' });
    expect(Object.values(s.actions).filter((a) => a.runId === runId && a.tier > 0).map((a) => [a.kind, a.tier, a.decision]).slice(0, 5)).toEqual([
      ['git.push', 1, 'run'],
      ['gh.pr.create', 1, 'run'],
      ['gh.pr.create', 1, 'run'],
      ['jira.link_pr', 1, 'run'],
      ['jira.link_pr', 1, 'run'],
    ]);
    // Each tier-1 change was recorded first; a PR can be closed again, a push cannot be taken back.
    expect(Object.values(s.changes).filter((c) => c.runId === runId).map((c) => c.undo ?? c.noUndo).slice(0, 5)).toEqual([
      'Taking a push back would need a force-push, which only alex may do.',
      'Close the PR from feature/SHOP-3049 on acme/shop-api',
      'Close the PR from feature/SHOP-3049 on acme/shop-shared',
      'Remove the link to https://github.com/acme/shop-api/pull/901 from SHOP-3049',
      'Remove the link to https://github.com/acme/shop-shared/pull/902 from SHOP-3049',
    ]);
    intake.close();
    live.close();
    proxies.close();
    grants.close();
    approvals.close();
  });

  it('asks for each PR to be marked ready, each after the narrative was read; no grant covers it (N1)', async () => {
    const { runId, asked, intake, live, proxies, grants, approvals } = await started();
    await vi.advanceTimersByTimeAsync(10_000);
    // The first was answered; the second asks again.
    expect(asked()).toHaveLength(2);
    expect(asked().map((a) => [a.payload.gate, a.payload.grantable])).toEqual([['narrative', undefined], ['narrative', undefined]]);
    expect(state().grants).toEqual({});
    intake.handle({ t: 'answer', approvalId: asked()[1]!.payload.approvalId, decision: 'approved' });
    await vi.advanceTimersByTimeAsync(10_000);
    const s = state();
    expect(Object.values(s.actions).filter((a) => a.kind === 'gh.pr.ready' && a.runId === runId).map((a) => a.decision)).toEqual(['ask', 'ask']);
    expect(s.prs['shop-shared#902']).toMatchObject({ state: 'open' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state().runs[runId]!.state).toBe('succeeded');
    intake.close();
    live.close();
    proxies.close();
    grants.close();
    approvals.close();
  });

  it('works the ticket the v1.2 way: the checkpoints in order, a verdict before any code, the failing test, then the review before the push', async () => {
    const { runId, intake, live, proxies, grants, approvals } = await started();
    const run = state().runs[runId]!;
    expect(run.steps.map((x) => x.name)).toEqual(['Investigate', 'Understand', 'Locate', 'Verdict', 'Reproduce', 'Fix', 'Prove', 'Hand back']);
    const mine = all().filter((e) => (e.payload as { runId?: string }).runId === runId);
    const at = (pred: (e: AnyEnvelope) => boolean) => mine.findIndex(pred);
    const verdicts = mine.filter((e): e is Extract<AnyEnvelope, { type: 'run.verdict' }> => e.type === 'run.verdict').map((e) => [e.payload.verdict, e.payload.reproduced]);
    expect(verdicts).toEqual([
      ['VALID', false],
      ['VALID', true],
    ]);
    const firstVerdict = at((e) => e.type === 'run.verdict');
    const edits = mine.filter((e) => e.type === 'tool.called' && e.payload.tool === 'Edit').map((e) => mine.indexOf(e));
    expect(edits.every((i) => i > firstVerdict)).toBe(true);
    // Before reproduced, only the test changed; the code after, with the input classes declared.
    const reproduced = at((e) => e.type === 'run.verdict' && e.payload.reproduced);
    expect(mine.filter((e) => e.type === 'tool.called' && e.payload.tool === 'Edit' && mine.indexOf(e) < reproduced).map((e) => (e.payload as { title?: string }).title)).toEqual(['test/webhook/auth.test.ts']);
    expect(at((e) => e.type === 'run.inputs_declared')).toBeGreaterThan(reproduced);
    expect(at((e) => e.type === 'run.inputs_declared')).toBeLessThan(at((e) => e.type === 'tool.called' && e.payload.title === 'src/webhook/auth.ts'));
    // The reported symptom is the ticket's own words; the reviewer finished before the push.
    expect(run.verdict).toMatchObject({ verdict: 'VALID', reproduced: true, symptom: state().tickets['SHOP-3049']!.summary });
    expect(at((e) => e.type === 'subagent.finished')).toBeLessThan(at((e) => e.type === 'action.classified' && e.payload.kind === 'git.push'));
    // Elfoqsy posted each verdict in chat; the first as one line with a link into the narrative (N1).
    const verdictLines = state().messages.filter((m) => m.text.includes('verdict on SHOP-3049')).map((m) => [m.text, m.blocks.map((b) => b.type)]);
    expect(verdictLines).toEqual([
      ['Agent 6 reached its verdict on SHOP-3049: VALID, not reproduced yet. auth.ts adds the scheme to a setting that may already have it. Nothing waits for you.', ['narrative']],
      ["Agent 6's verdict on SHOP-3049: VALID, reproduced.", []],
    ]);
    intake.close();
    live.close();
    proxies.close();
    grants.close();
    approvals.close();
  });

  it('a read-only check stops at its verdict, EXPECTED_BEHAVIOR/INVALID, with no edits or writes; Elfoqsy proposes the comment, which is asked', async () => {
    const { Approvals } = await import('../src/agents/approvals');
    const { Grants } = await import('../src/permissions/grants');
    const { createProxies } = await import('../src/permissions');
    const { simBackends } = await import('../src/sim/backends');
    const { parseEnvironments } = await import('../src/permissions/environments');
    const { readFileSync } = await import('node:fs');
    const live = new LiveState(log);
    const approvals = new Approvals(log);
    const grants = new Grants(log);
    const proxies = createProxies({
      log,
      approvals,
      grants,
      environments: parseEnvironments(readFileSync(resolve(REPO_ROOT, 'config', 'environments.yaml'), 'utf8')),
      backends: simBackends(log),
      repos: ['acme/shop-api', 'acme/shop-shared'],
      say: (run, text) => log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, conversationId: live.get().runs[run.runId]?.conversationId ?? '', refs: { tickets: [run.ticket], runId: run.runId } }),
    });
    sim = new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), { worktreesRoot: '/sim/worktrees', setTime: (ms) => void (pinned = ms), proxies, grants });
    sim.start();
    const intake = new Intake(log);
    intake.handle({ t: 'say', text: 'check CORE-18891', test: true });
    await vi.advanceTimersByTimeAsync(6_000);
    const runId = ofType('run.created').at(-1)!.payload.runId;
    expect(state().runs[runId]).toMatchObject({ ticket: 'CORE-18891', mode: 'read_only' });
    await vi.advanceTimersByTimeAsync(30_000);
    const run = state().runs[runId]!;
    expect(run.state).toBe('stopped');
    expect(run.verdict).toMatchObject({ verdict: 'EXPECTED_BEHAVIOR/INVALID', ticketComment: expect.stringContaining('documented behaviour') });
    expect(run.steps.map((x) => x.name)).toEqual(['Investigate', 'Understand', 'Locate', 'Verdict']);
    expect(run.transcript.filter((l) => l.tool === 'Edit')).toEqual([]);
    const line = state().messages.filter((m) => m.blocks.some((b) => b.type === 'verdict' && b.ref === runId)).at(-1)!;
    expect(line.text).toBe('Agent 6 stopped after its verdict on CORE-18891: EXPECTED_BEHAVIOR/INVALID. I propose to update CORE-18891 to say it is the expected behaviour, with the comment it wrote; approve it to post it, or not.');
    // The default is a Jira comment, asked (tier 2); nothing was written.
    const asked = Object.values(state().approvals).filter((a) => a.runId === runId);
    expect(asked.map((a) => [a.kind, a.tier, a.grantable?.kind])).toEqual([['action', 2, 'jira.comment']]);
    expect(Object.values(state().actions).filter((a) => a.runId === runId && a.tier > 0).map((a) => a.kind)).toEqual(['jira.comment']);
    intake.close();
    live.close();
    proxies.close();
    grants.close();
    approvals.close();
  });
});
