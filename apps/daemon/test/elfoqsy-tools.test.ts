import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Clock } from '../src/clock';
import { REPO_ROOT } from '../src/config';
import { subagentDefinitions } from '../src/agents/subagents';
import { LiveState } from '../src/elfoqsy/liveState';
import { PROTOCOL } from '../src/elfoqsy/session';
import { readHerPrompt } from '../src/elfoqsy/prompts';
import { statusItems } from '@elfoqsy/state';
import { handoffMarkdown } from '@elfoqsy/state';
import type { MessageBlock } from '@elfoqsy/contracts';
import { ALLOWED_TOOLS, DESCRIPTIONS, SHAPES, callTool, orchestratorHandlers, orchestratorServer, type SessionContext, type ToolDeps } from '../src/elfoqsy/tools';
import { EventLog } from '../src/eventLog';
import { loadMock } from '../src/sim/mock';
import { Simulator } from '../src/sim/simulator';

// A clock whose timers never fire: the simulator's snapshot and runs, without its loops.
const stillClock: Clock = { setTimeout: () => 0, clearTimeout: () => {} };

let log: EventLog;
let live: LiveState;
let deps: ToolDeps;

beforeEach(() => {
  log = new EventLog(':memory:');
  new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), { worktreesRoot: '/w', clock: stillClock }).start();
  live = new LiveState(log);
  deps = { log, state: () => live.get() };
});

afterEach(() => {
  live.close();
  log.close();
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

/** A conversation's context, as her session gives it to the tools. */
function session(speaker: 'alex' | 'tester' = 'alex'): SessionContext & { blocks: MessageBlock[] } {
  const blocks: MessageBlock[] = [];
  return {
    conversationId: 'c1',
    speaker: () => speaker,
    addBlocks: (b) => blocks.push(...b),
    blocks,
  };
}
const ofType = (type: string) => log.readFrom(0, 100_000, [type]).map((e) => e.payload as Record<string, unknown>);

describe('orchestrator tools', () => {
  const h = () => orchestratorHandlers(deps);

  it('lists the sprint: tickets, the sprints they are in, and PRs', () => {
    const r = h().list_sprint();
    expect(r.tickets).toHaveLength(13);
    expect(r.tickets[0]!.key).toBe('CORE-18891');
    expect(r.sprints).toEqual([
      { board: 'CORE', name: 'Platform 2026-10' },
      { board: 'SHOP', name: 'SHOP Sprint 52' },
    ]);
    expect(r.prs).toHaveLength(3); // the two of the snapshot, and agent 4's draft
  });

  it('gets one ticket with its PRs and runs, case-insensitively', () => {
    const r = h().get_ticket({ key: 'shop-3472' });
    expect(r).toMatchObject({ ticket: { key: 'SHOP-3472' } });
    const found = r as { prs: unknown[]; runs: Array<{ agentNumber: number }> };
    expect(found.prs).toHaveLength(2);
    expect(found.runs).toEqual([]);
    const withRun = h().get_ticket({ key: 'shop-2091' }) as { runs: Array<{ agentNumber: number }> };
    expect(withRun.runs.map((run) => run.agentNumber)).toEqual([3]);
    expect(h().get_ticket({ key: 'SHOP-9' })).toEqual({ error: 'unknown_ticket' });
  });

  it('says runs are not available without an orchestrator (simulate mode)', () => {
    expect(h().spawn_agent({ ticketKey: 'SHOP-3546' })).toMatchObject({ error: 'not_available' });
    expect(h().cancel_run({ runId: 'sim-run-2', reason: 'x' })).toMatchObject({ error: 'not_available' });
  });

  it('hands spawn_agent and cancel_run to the orchestrator, with no way to pick a model', async () => {
    const calls: unknown[] = [];
    const orchestrator = {
      spawn: async (args: unknown) => (calls.push(['spawn', args]), { runId: 'r1', agentNumber: 5 }),
      cancel: async (runId: string, reason: string) => (calls.push(['cancel', runId, reason]), { ok: true }),
      tell: (runId: string, text: string, from: string) => (calls.push(['tell', runId, text, from]), { ok: true }),
    };
    const withRuns = orchestratorHandlers({ ...deps, orchestrator });
    expect(await withRuns.spawn_agent({ ticketKey: 'SHOP-3546', repos: ['acme/shop-api'] })).toEqual({ runId: 'r1', agentNumber: 5 });
    expect(await withRuns.cancel_run({ runId: 'r1', reason: 'not needed' })).toEqual({ ok: true });
    expect(calls).toEqual([
      ['spawn', { ticketKey: 'SHOP-3546', repos: ['acme/shop-api'] }],
      ['cancel', 'r1', 'not needed'],
    ]);
    // In a conversation, the agent is started from it, with the handoff she wrote.
    const inConversation = orchestratorHandlers({ ...deps, orchestrator, session: session() });
    await inConversation.spawn_agent({ ticketKey: 'SHOP-1164', handoffId: 'h1' });
    expect(calls.at(-1)).toEqual(['spawn', { ticketKey: 'SHOP-1164', handoffId: 'h1', conversationId: 'c1' }]);
    // Asked for by the tester, it is the tester's run; from kept work, it says which run.
    const forTester = orchestratorHandlers({ ...deps, orchestrator, session: session('tester') });
    await forTester.spawn_agent({ ticketKey: 'SHOP-3546', fromRun: 'run-5' });
    expect(calls.at(-1)).toEqual(['spawn', { ticketKey: 'SHOP-3546', fromRun: 'run-5', conversationId: 'c1', test: true }]);
  });

  it('drafts a ticket as a card in her reply, which creates nothing (v1.4: only he creates)', () => {
    const drafts: unknown[] = [];
    const orchestrator = { spawn: async () => ({}), cancel: async () => ({}), tell: () => ({ ok: true }), draftTicket: (o: unknown) => (drafts.push(o), { draftId: 'draft-1' }) };
    const s = session();
    const tools = orchestratorHandlers({ ...deps, orchestrator, session: s });
    expect(tools.draft_ticket({ project: 'shop', type: 'Bug', summary: 'Retries resend a stale header' })).toEqual({ ok: true, draftId: 'draft-1', note: 'The card is in your reply; it waits for him. Nothing was created in Jira.' });
    expect(drafts).toEqual([{ by: 'elfoqsy', conversationId: 'c1', draft: { project: 'SHOP', type: 'Bug', summary: 'Retries resend a stale header' } }]);
    expect(s.blocks).toEqual([{ type: 'draft', ref: 'draft-1' }]);
    expect(orchestratorHandlers({ ...deps, orchestrator }).draft_ticket({ project: 'SHOP', type: 'Bug', summary: 'x' })).toMatchObject({ error: 'no_conversation' });
  });

  it('passes an objection to the agent as from whoever wrote the message she is answering', () => {
    const told: unknown[] = [];
    const orchestrator = { spawn: async () => ({}), cancel: async () => ({}), tell: (...a: unknown[]) => (told.push(a), { ok: true }) };
    const handlers = orchestratorHandlers({ ...deps, orchestrator });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm1', role: 'you', text: 'Do not touch v3.' });
    handlers.tell_agent({ runId: 'r1', text: 'Do not touch v3.' });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm2', role: 'elfoqsy', text: 'Passed on.' });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'm3', role: 'test', text: 'Skip the PR.' });
    handlers.tell_agent({ runId: 'r1', text: 'Skip the PR.' });
    expect(told).toEqual([
      ['r1', 'Do not touch v3.', 'alex'],
      ['r1', 'Skip the PR.', 'tester'],
    ]);
    expect(h().tell_agent({ runId: 'r1', text: 'x' })).toMatchObject({ error: 'not_available' });
  });

  it('gives Elfoqsy exactly what cancel_run found, to report and nothing more', async () => {
    const outcome = {
      ok: true,
      state: 'cancelled',
      folder: '/data/worktrees/SHOP-3546-run-1',
      folderRemoved: false,
      repos: [{ repo: 'acme/shop-api', branch: 'feature/SHOP-3546', branchOnGitHub: false, unpushedCommits: 2, uncommittedChanges: false }],
      summary: 'feature/SHOP-3546 is not on GitHub, only in the run folder; 2 commits not on GitHub. The run folder was kept at /data/worktrees/SHOP-3546-run-1.',
    };
    const orchestrator = { spawn: async () => ({}), cancel: async () => outcome, tell: () => ({ ok: true }) };
    const reply = await callTool({ ...deps, orchestrator }, 'cancel_run', { runId: 'r1', reason: 'Test request.' });
    expect(JSON.parse(reply.content[0]!.text)).toEqual(outcome);
    expect(DESCRIPTIONS.cancel_run).toContain('Tell him its summary and nothing beyond it.');
  });

  it('names him as her identity says in everything it sends a model: his real name stays in Jira and git data', () => {
    const sent = [
      readHerPrompt(REPO_ROOT, 'elfoqsy-system-prompt.md'),
      readHerPrompt(REPO_ROOT, 'elfoqsy-responder.md'),
      PROTOCOL,
      ...Object.values(DESCRIPTIONS),
      ...Object.values(subagentDefinitions(['claude-haiku-5-5'], ['low'])).map((d) => d.prompt),
    ];
    for (const text of sent) expect(text).not.toMatch(/Alex|Tran Trong/);
    expect(sent[0]).toContain('Address him the way your identity says (foqs in English; cậu, foqs or alex in Vietnamese).');
  });

  it('lists runs, optionally by state, and reads one run with its recent events', () => {
    expect(h().list_runs({}).runs).toHaveLength(5);
    expect(h().list_runs({ state: 'waiting_for_you' }).runs.map((r) => r.ticket)).toEqual(['SHOP-3546']);
    const { recentEvents } = h().get_run({ runId: 'sim-run-3' }) as { recentEvents: Array<{ payload: { runId?: string } }> };
    expect(recentEvents.length).toBeGreaterThan(0);
    expect(recentEvents.every((e) => e.payload.runId === 'sim-run-3')).toBe(true);
    expect(h().get_run({ runId: 'nope' })).toEqual({ error: 'unknown_run' });
  });

  it('reads events by type, and never more than 500 at once', () => {
    const r = h().read_events({ types: ['run.created'] });
    expect(r.events.map((e) => e.type)).toEqual(Array(5).fill('run.created'));
    expect(h().read_events({ limit: 10_000 }).events.length).toBeLessThanOrEqual(500);
  });
});

describe('callTool', () => {
  it('records the call as Elfoqsy’s, with no run, then answers with JSON', async () => {
    const r = await callTool(deps, 'get_ticket', { key: 'SHOP-3049' });
    expect(parse(r)).toMatchObject({ ticket: { key: 'SHOP-3049', status: 'Blocked' } });
    const recorded = log.readFrom(0, 10_000, ['tool.called']).at(-1)!;
    expect(recorded).toMatchObject({ source: 'elfoqsy', payload: { tool: 'get_ticket', inputSummary: '{"key":"SHOP-3049"}', allowed: true } });
    expect(recorded.payload).not.toHaveProperty('runId');
  });

  it('marks errors and redacts everything it returns', async () => {
    expect(await callTool(deps, 'spawn_agent', { ticketKey: 'SHOP-3546' })).toMatchObject({ isError: true });
    const key = Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(i * 3 + 2) % 16]).join('');
    const ticket = { ...live.get().tickets['CORE-18891']!, description: `apikey=${key}` };
    log.append('jira', 'ticket.synced', { ticket });
    expect(JSON.stringify(await callTool(deps, 'get_ticket', { key: 'CORE-18891' }))).not.toContain(key);
  });

  it('serves exactly the orchestrator tools, from an in-process server', () => {
    expect(ALLOWED_TOOLS).toEqual(
      [
        'list_sprint',
        'get_ticket',
        'spawn_agent',
        'list_runs',
        'get_run',
        'cancel_run',
        'dismiss_run',
        'tell_agent',
        'read_events',
        'show',
        'name_conversation',
        'remember',
        'recall',
        'lookup_jira',
        'lookup_github',
        'lookup_confluence',
        'lookup_code',
        'kube',
        'aws',
        'gh',
        'logs',
        'investigate',
        'write_handoff',
        'pause_run',
        'resume_run',
        'save_rule',
        'forget',
        'dismiss_ci',
        'record_review',
        'close_out',
        'start_task',
        'delegation',
        'set_delegation',
        'remove_precedent',
        'set_max_agents',
        'decisions',
        'jira_write',
        'draft_ticket',
        'write_ability',
      ].map((t) => `mcp__orchestrator__${t}`),
    );
    expect(orchestratorServer(deps)).toMatchObject({ type: 'sdk', name: 'orchestrator' });
  });
});

describe('her v1 tools', () => {
  it('show only blocks whose ids exist, under the reply she is writing', () => {
    const ctx = session();
    const tools = orchestratorHandlers({ ...deps, session: ctx });
    expect(tools.show({ blocks: [{ type: 'ticket', ref: 'SHOP-3049' }, { type: 'sprint', ref: 'SHOP Sprint 52' }] })).toMatchObject({ ok: true });
    expect(ctx.blocks).toEqual([{ type: 'ticket', ref: 'SHOP-3049' }, { type: 'sprint', ref: 'SHOP Sprint 52' }]);
    const bad = tools.show({ blocks: [{ type: 'ticket', ref: 'SHOP-9999' }, { type: 'findings', ref: 'inv-x' }, { type: 'code', content: ' ' }] });
    expect(bad).toEqual({
      error: 'bad_blocks',
      message: 'Block 1 (ticket): SHOP-9999 is not a ticket in the sprint. Block 2 (findings): there is no investigation inv-x. Block 3 (code): it is empty.',
    });
    expect(ctx.blocks).toHaveLength(2);
    expect(orchestratorHandlers(deps).show({ blocks: [{ type: 'ticket', ref: 'SHOP-3049' }] })).toMatchObject({ error: 'no_conversation' });
  });

  it('name the conversation, with its ticket', () => {
    log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'hi' });
    const tools = orchestratorHandlers({ ...deps, session: session() });
    expect(tools.name_conversation({ title: 'Plan the SHOP-1164 stall fix', ticket: 'shop-1164' })).toEqual({ ok: true });
    expect(live.get().conversations.c1).toMatchObject({ title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164' });
    expect(tools.name_conversation({ title: 'x', ticket: 'SHOP-9999' })).toMatchObject({ error: 'unknown_ticket' });
  });

  it('remember facts with their sources and how long they hold, never the tester’s as his', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const fact = { statement: 'Releases are cut on Thursdays.', sources: [{ kind: 'doc' as const, ref: 'Release process' }], freshForDays: 30 };
    expect(orchestratorHandlers({ ...deps, session: session(), now: () => now }).remember({ ...fact, learnedFrom: 'alex' })).toMatchObject({ ok: true });
    expect(ofType('memory.saved').at(-1)).toMatchObject({ statement: fact.statement, origin: 'you', freshUntil: '2026-11-09T12:00:00.000Z' });
    const asTester = orchestratorHandlers({ ...deps, session: session('tester') });
    expect(asTester.remember({ ...fact, learnedFrom: 'alex' })).toMatchObject({ error: 'not_his' });
    expect(asTester.remember({ ...fact, learnedFrom: 'lookup' })).toMatchObject({ ok: true });
    expect(orchestratorHandlers(deps).recall({ text: 'releases thursdays' }).facts.map((f) => f.statement)).toEqual([fact.statement, fact.statement]);
  });

  it('closes a ticket out only on his word that QA passed, never the tester’s', async () => {
    const calls: unknown[] = [];
    const orchestrator = { spawn: async () => ({}), cancel: () => ({}), tell: () => ({}), closeOut: async (k: string, qa: string) => (calls.push([k, qa]), { ok: true }) };
    expect(await orchestratorHandlers({ ...deps, orchestrator, session: session('tester') }).close_out({ ticket: 'shop-1164', qa: 'QA ok' })).toMatchObject({ error: 'not_his' });
    expect(await orchestratorHandlers({ ...deps, orchestrator, session: session() }).close_out({ ticket: 'shop-1164', qa: 'QA passed on Integration' })).toEqual({ ok: true });
    expect(calls).toEqual([['SHOP-1164', 'QA passed on Integration']]);
  });

  describe('write_handoff: his words, his constraints, sourced facts; never a diagnosis or a plan', () => {
    const say = (messageId: string, role: 'you' | 'elfoqsy' | 'test', text: string, conversationId = 'c1') =>
      log.append(role === 'elfoqsy' ? 'elfoqsy' : 'orchestrator', 'elfoqsy.message', { messageId, role, text, conversationId });
    beforeEach(() => {
      say('m1', 'you', "SHOP-1164 has slipped 9 sprints. Let's look at it before an agent touches it.");
      // Elfoqsy's wrong theory, in the conversation: it must never reach the agent.
      say('m2', 'elfoqsy', 'I think the root cause is the Redis TTL being too short.');
      say('m3', 'you', 'ok, start it. keep export-step-timeout as it is.');
      say('m9', 'you', 'another conversation', 'c2');
      log.append('elfoqsy', 'investigation.started', { investigationId: 'inv-1', conversationId: 'c1', question: 'Why?', model: 'claude-sonnet-5-5', effort: 'high' });
      log.append('agent', 'investigation.finished', {
        investigationId: 'inv-1',
        conversationId: 'c1',
        title: 'What happens',
        findings: [{ text: 'Early steps are cached.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }] }],
        durationMs: 1000,
      });
    });

    it('copies his messages word for word and leaves hers out, keeps constraints quoted from his messages, and only facts with a source the agent can check', () => {
      const r = orchestratorHandlers({ ...deps, session: session() }).write_handoff({
        ticket: 'shop-1164',
        mode: 'normal',
        constraints: [{ text: 'keep export-step-timeout as it is' }, { text: 'use a per-step timeout' }, { text: 'the Redis TTL' }],
        facts: [
          { text: 'Early steps are cached and the per-export timeout does not start for them.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }] },
          { text: 'The reporter sees it with export-step-timeout deleted.', sources: [{ kind: 'ticket', ref: 'SHOP-1164' }] },
          { text: 'The Redis TTL is too short.', sources: [] },
          { text: 'The root cause is the Redis TTL.', sources: [{ kind: 'ticket', ref: 'SHOP-1164' }] },
          { text: 'The fix should start a timeout per export step.', sources: [{ kind: 'ticket', ref: 'SHOP-1164' }] },
          { text: 'wait.ts waits forever.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/wait.ts:112' }] },
        ],
      }) as { ok: true; handoffId: string; dropped: Array<{ text: string; reason: string }> };
      expect(r).toMatchObject({ ok: true, kept: { hisMessages: 2, constraints: 1, facts: 2 } });
      const h = live.get().handoffs[r.handoffId]!;
      expect(h.context).toEqual([
        { messageId: 'm1', role: 'you', text: "SHOP-1164 has slipped 9 sprints. Let's look at it before an agent touches it." },
        { messageId: 'm3', role: 'you', text: 'ok, start it. keep export-step-timeout as it is.' },
      ]);
      expect(h.constraints).toEqual([{ text: 'keep export-step-timeout as it is', messageId: 'm3' }]);
      expect(h.facts.map((f) => f.text)).toEqual(['Early steps are cached and the per-export timeout does not start for them.', 'The reporter sees it with export-step-timeout deleted.']);
      expect(r.dropped.map((d) => d.reason)).toEqual([
        'not his words: a constraint is quoted from one of his messages in this conversation, as he wrote it',
        'not his words: a constraint is quoted from one of his messages in this conversation, as he wrote it',
        'no source the agent can check',
        'it reads as a diagnosis or a plan; the handoff says what was observed, and the agent decides the rest',
        'it reads as a diagnosis or a plan; the handoff says what was observed, and the agent decides the rest',
        'no source the agent can check (shop-worker/src/export/wait.ts:112 was not read by an investigator in this conversation)',
      ]);
      // Nothing of her theory is in what the agent will read; what was left out is kept for alex to see.
      expect(handoffMarkdown(h)).not.toMatch(/Redis|root cause|per export step|wait\.ts/);
      expect(h.dropped).toHaveLength(6);
    });

    it('needs an open ticket, and for a hotfix the release branch in each repository', () => {
      const tools = orchestratorHandlers({ ...deps, session: session() });
      const base = { constraints: [], facts: [] };
      expect(tools.write_handoff({ ticket: 'SHOP-9999', mode: 'normal', ...base })).toMatchObject({ error: 'unknown_ticket' });
      expect(tools.write_handoff({ ticket: 'SHOP-1164', mode: 'hotfix', ...base })).toMatchObject({ error: 'base_needed', message: expect.stringContaining('Ask alex which one') });
      expect(tools.write_handoff({ ticket: 'SHOP-1164', mode: 'hotfix', bases: [{ repo: 'acme/shop-worker', branch: 'master' }], ...base })).toMatchObject({ error: 'base_needed' });
      const r = tools.write_handoff({ ticket: 'SHOP-1164', mode: 'hotfix', bases: [{ repo: 'acme/shop-worker', branch: 'release/2.22.0' }], ...base }) as { handoffId: string };
      expect(live.get().handoffs[r.handoffId]).toMatchObject({ mode: 'hotfix', bases: { 'acme/shop-worker': 'release/2.22.0' } });
      expect(orchestratorHandlers(deps).write_handoff({ ticket: 'SHOP-1164', mode: 'normal', ...base })).toMatchObject({ error: 'no_conversation' });
    });
  });

  it('start investigators in the conversation that asks', () => {
    const started: unknown[] = [];
    const tools = orchestratorHandlers({ ...deps, session: session(), investigators: { start: (a) => (started.push(a), { investigationId: 'inv-1' }) } });
    expect(tools.investigate({ question: 'Why?', model: 'sonnet', effort: 'high' })).toEqual({ investigationId: 'inv-1' });
    expect(started).toEqual([{ question: 'Why?', model: 'sonnet', effort: 'high', conversationId: 'c1' }]);
    expect(orchestratorHandlers(deps).investigate({ question: 'Why?', model: 'sonnet', effort: 'high' })).toMatchObject({ error: 'no_conversation' });
  });

  it('say lookups and reads are not available without them (simulate mode)', async () => {
    expect(orchestratorHandlers(deps).lookup_jira({ key: 'SHOP-1' })).toMatchObject({ error: 'not_available' });
    expect(await orchestratorHandlers(deps).logs({ query: 'limit 5' })).toMatchObject({ error: 'not_available' });
  });
});

describe('dismissing a failed run through Elfoqsy', () => {
  it('records it as asked for by whoever she is answering, and only for a failed run', () => {
    log.append('orchestrator', 'run.created', { runId: 'r9', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 9 });
    log.append('orchestrator', 'run.state_changed', { runId: 'r9', state: 'running' });
    const tools = orchestratorHandlers({ ...deps, session: session('tester') });
    expect(tools.dismiss_run({ runId: 'r9' })).toMatchObject({ error: 'not_failed' });
    log.append('orchestrator', 'run.state_changed', { runId: 'r9', state: 'failed' });
    expect(tools.dismiss_run({ runId: 'r9', reason: 'The tester said to dismiss it.' })).toMatchObject({ ok: true });
    expect(ofType('run.dismissed').at(-1)).toEqual({ runId: 'r9', by: 'tester', reason: 'The tester said to dismiss it.' });
    expect(live.get().runs.r9).toMatchObject({ state: 'failed', dismissed: { by: 'tester' } });
    expect(tools.dismiss_run({ runId: 'r9' })).toMatchObject({ error: 'already_dismissed' });
    expect(tools.dismiss_run({ runId: 'nope' })).toMatchObject({ error: 'unknown_run' });
  });
});

describe('her milestone 11 and 12 tools', () => {
  it('pauses and resumes for whoever she is answering, marked as hers so it is not told back to her', () => {
    const calls: unknown[] = [];
    const control = {
      pause: (...a: unknown[]) => (calls.push(['pause', ...a]), { ok: true as const }),
      resume: (...a: unknown[]) => (calls.push(['resume', ...a]), { ok: true as const }),
      guide: () => ({ ok: true as const }),
    };
    const tools = orchestratorHandlers({ ...deps, control, session: session('tester') });
    tools.pause_run({ runId: 'r3', reason: 'The tester wants to look first.' });
    tools.resume_run({ runId: 'r3' });
    expect(calls).toEqual([
      ['pause', 'r3', 'tester', 'Through Elfoqsy: The tester wants to look first.'],
      ['resume', 'r3', 'tester', 'Through Elfoqsy'],
    ]);
    expect(orchestratorHandlers(deps).pause_run({ runId: 'r3' })).toMatchObject({ error: 'not_available' });
  });

  it('saves a confirmed rule for the run’s repository or all repos, the tester’s as the tester’s, and forgets it', () => {
    log.append('orchestrator', 'run.created', { runId: 'r7', ticket: 'SHOP-3546', worktree: '', branch: '', agentNumber: 7, repos: ['acme/shop-api'] });
    const mine = orchestratorHandlers({ ...deps, session: session('alex') });
    const saved = mine.save_rule({ statement: 'Never touch src/generated.', runId: 'r7' }) as { factId: string; scope: string };
    expect(saved.scope).toBe('acme/shop-api');
    expect(live.get().memory[saved.factId]).toMatchObject({ kind: 'rule', origin: 'you', repos: ['acme/shop-api'] });
    const everywhere = mine.save_rule({ statement: 'Keep commits small.', allRepos: true }) as { factId: string; scope: string };
    expect(everywhere.scope).toBe('all repos');
    expect(live.get().memory[everywhere.factId]!.repos).toBeUndefined();
    expect(mine.save_rule({ statement: 'x' })).toMatchObject({ error: 'no_repo' });
    const tester = orchestratorHandlers({ ...deps, session: session('tester') }).save_rule({ statement: 'A test rule.', runId: 'r7' }) as { factId: string; note: string };
    expect(live.get().memory[tester.factId]).toMatchObject({ origin: 'tester' });
    expect(tester.note).toMatch(/never given to a real run/);
    expect(mine.forget({ factId: saved.factId })).toEqual({ ok: true, forgotten: 'Never touch src/generated.' });
    expect(live.get().memory[saved.factId]).toBeUndefined();
    expect(ofType('memory.forgotten').at(-1)).toEqual({ factId: saved.factId, by: 'you' });
    expect(mine.forget({ factId: 'nope' })).toMatchObject({ error: 'unknown_fact' });
  });

  it('dismisses a CI failure until the next CI result, without touching GitHub, and only a failing one', () => {
    log.append('github', 'pr.synced', { pr: { repo: 'acme/shop-api', number: 9, state: 'open', ticket: 'SHOP-3546', url: '', checks: 'none' } });
    const tools = orchestratorHandlers({ ...deps, session: session('alex') });
    expect(tools.dismiss_ci({ repo: 'acme/shop-api', number: 9 })).toMatchObject({ error: 'not_failing' });
    log.append('github', 'ci.status', { repo: 'acme/shop-api', pr: 9, sha: 'abc', status: 'failure', url: '' });
    const brokenBefore = statusItems(live.get()).find((i) => i.kind === 'broken')!.count;
    expect(tools.dismiss_ci({ repo: 'acme/shop-api', number: 9 })).toMatchObject({ ok: true });
    expect(ofType('ci.dismissed').at(-1)).toEqual({ repo: 'acme/shop-api', pr: 9, sha: 'abc', by: 'you' });
    expect(statusItems(live.get()).find((i) => i.kind === 'broken')?.count ?? 0).toBe(brokenBefore - 1);
    expect(tools.dismiss_ci({ repo: 'acme/shop-api', number: 9 })).toMatchObject({ error: 'already_dismissed' });
    // The next CI result ends it.
    log.append('github', 'ci.status', { repo: 'acme/shop-api', pr: 9, sha: 'def', status: 'failure', url: '' });
    expect(live.get().ciDismissed).toEqual({});
  });

  it('records the weekly review she was asked for, once', () => {
    // On a fixed clock: the simulator's own review is dated from now, and on some days it fell on this test's week (22 October 2026).
    live.close();
    log.close();
    log = new EventLog(':memory:');
    new Simulator(log, loadMock(resolve(REPO_ROOT, 'mock')), { worktreesRoot: '/w', clock: stillClock, now: () => Date.parse('2026-10-21T09:00:00Z') }).start();
    live = new LiveState(log);
    deps = { log, state: () => live.get() };
    expect(live.get().reviews.some((r) => r.weekOf === '2026-10-05')).toBe(false);
    let pending: Record<string, number> | undefined = { runs: 4, periodEnd: 1 };
    const reviews = { pending: (w: string) => (w === '2026-10-05' ? pending : undefined), done: () => (pending = undefined) };
    const tools = orchestratorHandlers({ ...deps, reviews, session: session() });
    expect(tools.record_review({ weekOf: '2026-09-28', suggestions: [] })).toMatchObject({ error: 'no_review' });
    expect(tools.record_review({ weekOf: '2026-10-05', suggestions: ['Use Sonnet medium for test runs: Haiku failed 3 of 10.'] })).toMatchObject({ ok: true });
    expect(live.get().reviews.find((r) => r.weekOf === '2026-10-05')).toMatchObject({ conversationId: 'c1', metrics: { runs: 4 }, suggestions: ['Use Sonnet medium for test runs: Haiku failed 3 of 10.'] });
    expect(tools.record_review({ weekOf: '2026-10-05', suggestions: [] })).toMatchObject({ error: 'no_review' });
  });
});

describe('her thinking indicator: what she does, in one line each', () => {
  it('logs each action in the conversation as running, then done or failed; housekeeping is not shown', async () => {
    const ctx = session();
    deps = { ...deps, session: ctx };
    await callTool(deps, 'get_ticket', { key: 'shop-3472' });
    await callTool(deps, 'get_ticket', { key: 'SHOP-9' });
    await callTool(deps, 'name_conversation', { title: 'Shared modules first' });
    const activities = log.readFrom(0, 10_000, ['elfoqsy.activity']).map((e) => e.payload as { conversationId: string; tool: string; text: string; state: string });
    expect(activities.map((a) => [a.tool, a.text, a.state])).toEqual([
      ['jira', 'Read SHOP-3472', 'running'],
      ['jira', 'Read SHOP-3472', 'done'],
      ['jira', 'Read SHOP-9', 'running'],
      ['jira', 'Read SHOP-9', 'failed'],
    ]);
    expect(new Set(activities.map((a) => a.conversationId))).toEqual(new Set([ctx.conversationId]));
  });
});

describe('her abilities (brief-abilities)', () => {
  const ability = {
    name: 'count-logs-per-hour',
    title: 'Count logs per hour before searching an id',
    titleVi: 'đếm log theo giờ trước khi tìm một id',
    tool: 'coralogix' as const,
    whenToUse: "Before searching an id in Coralogix ('trace request X').",
    steps: [
      { text: 'Count the lines per hour first', code: 'groupby … as hour', read: { proxy: 'logs' as const, input: { environment: 'staging', query: 'limit 1' } } },
      { text: 'Start a task agent', code: 'start_task', effect: true },
      { text: 'Note it', effect: false },
    ],
    doneWhen: 'It is known whether the logs exist.',
    track: { tools: ['logs'] },
    friction: { what: 'four empty id searches', calls: 9, failed: 1, questions: 0 },
    say: 'Tôi vừa học được cách đếm log theo giờ trước khi tìm một id.',
  };

  it('writes one through the engine: her conversation, the friction, an effect marked only when it has one', async () => {
    const calls: unknown[] = [];
    const abilities = { write: async (d: unknown, o: unknown) => (calls.push([d, o]), { ok: true as const, name: 'count-logs-per-hour', version: 1, verification: [] }) };
    const r = await orchestratorHandlers({ ...deps, abilities, session: session() }).write_ability(ability);
    expect(r).toMatchObject({ ok: true, version: 1 });
    const [d, o] = calls[0] as [{ steps: unknown[] }, unknown];
    expect(d.steps).toEqual([ability.steps[0], { text: 'Start a task agent', code: 'start_task', effect: true }, { text: 'Note it' }]);
    expect(d).not.toHaveProperty('friction');
    expect(o).toEqual({ friction: ability.friction, say: ability.say, conversationId: 'c1' });
    expect(d).not.toHaveProperty('say');
  });

  it('sends a quiet update through without a line, and her references with the ability', async () => {
    const calls: unknown[] = [];
    const abilities = { write: async (d: unknown, o: unknown) => (calls.push([d, o]), { ok: true as const, name: 'count-logs-per-hour', version: 2, verification: [] }) };
    const { say: _say, ...withoutLine } = ability;
    const quiet = { ...withoutLine, update: true, quiet: true, references: 'The full command: groupby $m.timestamp.formatTimestamp(…) as hour aggregate count() as n' };
    const shape = z.object(SHAPES.write_ability);
    expect(shape.safeParse(quiet).success).toBe(true);
    await orchestratorHandlers({ ...deps, abilities, session: session() }).write_ability(quiet);
    const [d, o] = calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(d.references).toBe(quiet.references);
    expect(d).not.toHaveProperty('quiet');
    expect(o).toEqual({ update: true, quiet: true, friction: ability.friction, conversationId: 'c1' });
    expect(shape.safeParse({ ...quiet, references: 'x'.repeat(4001) }).success).toBe(false);
    expect(DESCRIPTIONS.write_ability).toMatch(/the shortest form that still runs/);
    expect(DESCRIPTIONS.write_ability).toMatch(/the full commands with their flags and what explains them go in references/);
    expect(DESCRIPTIONS.write_ability).toMatch(/A quiet update \(quiet: true, with update: true\)/);
  });

  it('is about a tool whose logo its card shows: her own workspace is `elfoqsy`, and `other` (a card for no tool) is not offered any more', () => {
    const shape = z.object(SHAPES.write_ability);
    expect(shape.safeParse(ability).success).toBe(true);
    expect(shape.safeParse({ ...ability, tool: 'elfoqsy' }).success).toBe(true);
    expect(shape.safeParse({ ...ability, tool: 'other' }).success).toBe(false);
    expect(DESCRIPTIONS.write_ability).toMatch(/or elfoqsy when it is about your own workspace \(runs, events, the sprint, tickets\)/);
  });

  it('wants what happened in one short clause: the Abilities view says it on one line', () => {
    const shape = z.object(SHAPES.write_ability);
    expect(shape.safeParse({ ...ability, friction: { what: 'x'.repeat(80), calls: 1, failed: 0, questions: 0 } }).success).toBe(true);
    expect(shape.safeParse({ ...ability, friction: { what: 'x'.repeat(81), calls: 1, failed: 0, questions: 0 } }).success).toBe(false);
    expect(DESCRIPTIONS.write_ability).toMatch(/one short clause of 80 characters at most/);
  });

  it('is refused on the tester’s word, and says so where abilities are not set up', async () => {
    const abilities = { write: async () => ({ ok: true as const, name: 'x', version: 1, verification: [] }) };
    expect(await orchestratorHandlers({ ...deps, abilities, session: session('tester') }).write_ability(ability)).toMatchObject({ error: 'not_his' });
    expect(await orchestratorHandlers({ ...deps, session: session() }).write_ability(ability)).toMatchObject({ error: 'not_set_up' });
  });

  it('is told in her description when to write one, never to ask, and that procedures go there and facts to memory', () => {
    expect(DESCRIPTIONS.write_ability).toMatch(/without asking, as soon as friction/);
    expect(DESCRIPTIONS.write_ability).toMatch(/the same friction twice, or once at a high cost/);
    expect(DESCRIPTIONS.write_ability).toMatch(/Procedures go here; facts go to remember/);
    // The line that tells him is hers: in her voice, his language, never the title after "I learned how to".
    expect(DESCRIPTIONS.write_ability).toMatch(/say: the one line you tell him about it, written by you, in your voice and in the language he is writing to you now/);
    expect(DESCRIPTIONS.write_ability).toMatch(/never the ability's title put after 'I learned how to'/);
  });

  it('are explained in her prompt: how they are born, active at once, verified, measured, levelled, repaired and credited, and used before the work', () => {
    const prompt = readFileSync(resolve(REPO_ROOT, 'prompts/elfoqsy-system-prompt.md'), 'utf8');
    const section = prompt.slice(prompt.indexOf('## Abilities'), prompt.indexOf('## Blocks'));
    for (const words of [
      'failed or retried calls, long searches for the same thing, questions to alex',
      'write_ability, without asking',
      'the same friction twice, or once at a high cost',
      'Procedures go to abilities, facts to memory',
      '**Active at once.** No approval',
      'It grants nothing',
      'as your own tier-0 read',
      'never run, and stays unverified',
      '1, 3, 8, 15 and 30 uses that worked make levels 1 to 5',
      '"needs re-check"',
      'or Agent N on a ticket',
      'missed use',
      '**Use one before the work.**',
      'invoke the one that matches with Skill',
      'explain it from this section',
    ])
      expect(section, words).toContain(words);
    expect(prompt).toContain('write and update abilities');
  });

  it('shows in her thinking indicator', async () => {
    const { activityLine } = await import('../src/elfoqsy/activity');
    expect(activityLine('write_ability', { title: 'Count logs per hour' }, live.get())).toEqual({ tool: 'workspace', text: 'Write the ability "Count logs per hour"' });
    expect(activityLine('write_ability', { title: 'Count logs per hour', update: true }, live.get())).toEqual({ tool: 'workspace', text: 'Update the ability "Count logs per hour"' });
  });
});
