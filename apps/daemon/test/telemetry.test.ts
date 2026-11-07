// Every session's OpenTelemetry, kept locally (alex, 2026-10-21): the environment that turns it on and tags it, the
// receiver on 127.0.0.1, the store (redacted, with phase and ability), outcomes beside the spans, what the abilities take
// from the spans, and, on the real Claude Code binary against a fake API (no model call), that a session's spans arrive
// tagged, redacted and joinable. Made-up tokens are built at run time; nothing real.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '@elfoqsy/contracts';
import { foldAll, type WorkspaceState } from '@elfoqsy/state';
import { CONTENT_MAX, resourceAttributes, setTelemetryEndpoint, telemetryEndpoint, telemetryEnv } from '../src/telemetry/env';
import { outcomeOf, watchOutcomes } from '../src/telemetry/outcomes';
import { startReceiver } from '../src/telemetry/receiver';
import { TelemetryStore, type OtlpTraces } from '../src/telemetry/store';
import { sessionOptions } from '../src/elfoqsy/session';
import { AbilityEngine, type QueryFn } from '../src/abilities/engine';
import { AbilityStore } from '../src/abilities/store';
import type { Ability } from '../src/abilities/ability';
import { EventLog } from '../src/eventLog';
import { LiveState } from '../src/elfoqsy/liveState';
import { fakeAnthropic, toolResults, type ApiRequest, type Reply } from './helpers/fakeAnthropic';
import { result, tick } from './helpers/fakeSdk';
import { SHOP_API, orchestratorWorld } from './helpers/orchestratorWorld';
import { sandboxAvailable } from './helpers/sandboxProof';

const base = mkdtempSync(join(tmpdir(), 'elfoqsy-telemetry-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (what: string) => join(base, `${what}-${++n}`);
const FAKE_TOKEN = `ghp_${'a'.repeat(36)}`;

afterEach(() => setTelemetryEndpoint(undefined));

describe('the environment of a session', () => {
  it('is empty until the daemon’s receiver listens, so nothing exports in a test or the CLI', () => {
    expect(telemetryEndpoint()).toBeUndefined();
    expect(telemetryEnv({ kind: 'ticket', runId: 'run-1' })).toEqual({});
  });

  it('turns on traces and log events over OTLP http/json to the receiver, content capped, and tags the session', () => {
    setTelemetryEndpoint('http://127.0.0.1:4999');
    const env = telemetryEnv({ kind: 'ticket', runId: 'run-1', ticket: 'SHOP-3546', agentNumber: 4 });
    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4999',
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
      CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: String(CONTENT_MAX),
      OTEL_SERVICE_NAME: 'elfoqsy-ticket',
      OTEL_RESOURCE_ATTRIBUTES: 'elfoqsy.agent_kind=ticket,elfoqsy.run_id=run-1,elfoqsy.ticket=SHOP-3546,elfoqsy.agent_number=4',
    });
    expect(env).not.toHaveProperty('OTEL_LOG_RAW_API_BODIES');
  });

  it('percent-encodes what the attribute list reserves (spaces, commas, equals signs)', () => {
    expect(resourceAttributes({ kind: 'conversation', conversationId: 'today 2026,10=21' })).toBe('elfoqsy.agent_kind=conversation,elfoqsy.conversation_id=today%202026%2C10%3D21');
  });
});

/** OTLP spans as the binary sends them over http/json. */
const kv = (o: Record<string, string | number | boolean>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : { intValue: String(v) } }));
const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);
function traces(resource: Record<string, string>, spans: Array<{ id: string; parent?: string; trace?: string; name: string; start: number; end: number; attrs?: Record<string, string | number | boolean>; error?: string; events?: Array<{ name: string; attrs: Record<string, string> }> }>): OtlpTraces {
  return {
    resourceSpans: [
      {
        resource: { attributes: kv({ 'service.name': 'elfoqsy-ticket', ...resource }) },
        scopeSpans: [
          {
            spans: spans.map((s) => ({
              traceId: s.trace ?? 'trace-1',
              spanId: s.id,
              ...(s.parent ? { parentSpanId: s.parent } : {}),
              name: s.name,
              startTimeUnixNano: nano(s.start),
              endTimeUnixNano: nano(s.end),
              attributes: kv({ 'session.id': 'sess-1', ...(s.attrs ?? {}) }),
              ...(s.events ? { events: s.events.map((e) => ({ name: e.name, timeUnixNano: nano(s.end), attributes: kv(e.attrs) })) } : {}),
              status: s.error ? { code: 2, message: s.error } : { code: 0 },
            })),
          },
        ],
      },
    ],
  };
}

/** user_prompt log events, one per turn, as the binary sends them (each turn's prompt.id). */
const prompts = (resource: Record<string, string>, session: string, turns: Array<[string, number]>) => ({
  resourceLogs: [
    {
      resource: { attributes: kv(resource) },
      scopeLogs: [{ logRecords: turns.map(([id, at]) => ({ timeUnixNano: nano(at), body: { stringValue: 'claude_code.user_prompt' }, attributes: kv({ 'event.name': 'user_prompt', 'event.timestamp': new Date(at).toISOString(), 'session.id': session, 'prompt.id': id }) })) }],
    },
  ],
});

const T = Date.parse('2026-10-21T08:00:00Z');
const RUN = { 'elfoqsy.agent_kind': 'ticket', 'elfoqsy.run_id': 'run-1', 'elfoqsy.ticket': 'SHOP-3546', 'elfoqsy.agent_number': '4' };
/** A run: a model call, the ability loaded, then a command that fails and one that works (with a made-up token in it). */
const RUN_SPANS = traces(RUN, [
  { id: 'i', name: 'claude_code.interaction', start: T, end: T + 9000, attrs: { user_prompt: `Fix it; token ${FAKE_TOKEN}` } },
  { id: 'm1', parent: 'i', name: 'claude_code.llm_request', start: T + 100, end: T + 900, attrs: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50000, cache_creation_tokens: 3000 } },
  { id: 's', parent: 'i', name: 'claude_code.tool', start: T + 1000, end: T + 1100, attrs: { tool_name: 'Skill', tool_use_id: 'tu-skill', skill_name: 'abilities:find-request-logs' } },
  { id: 'm2', parent: 'i', name: 'claude_code.llm_request', start: T + 1200, end: T + 2000, attrs: { model: 'claude-opus-5-5', input_tokens: 400, output_tokens: 100, cache_read_tokens: 60000, cache_creation_tokens: 0 } },
  { id: 'b1', parent: 'i', name: 'claude_code.tool', start: T + 2100, end: T + 2500, attrs: { tool_name: 'Bash', tool_use_id: 'tu-1', full_command: 'kubectl get pods -n x' } },
  { id: 'b1x', parent: 'b1', name: 'claude_code.tool.execution', start: T + 2150, end: T + 2450, attrs: { tool_use_id: 'tu-1', success: false, error_class: 'ShellError' }, error: 'Shell command failed' },
  { id: 'b2', parent: 'i', name: 'claude_code.tool', start: T + 3000, end: T + 3300, attrs: { tool_name: 'Bash', tool_use_id: 'tu-2', full_command: `curl -H "Authorization: token ${FAKE_TOKEN}" x` }, events: [{ name: 'tool.output', attrs: { output: `ok ${FAKE_TOKEN}` } }] },
  { id: 'b2x', parent: 'b2', name: 'claude_code.tool.execution', start: T + 3050, end: T + 3250, attrs: { tool_use_id: 'tu-2', success: true } },
]);

/** A state with run-1 in its steps: Reproduce from T, Fix from T + 2000. */
function stateWithSteps(): WorkspaceState {
  const s = foldAll([]);
  return { ...s, runs: { 'run-1': { runId: 'run-1', ticket: 'SHOP-3546', agentNumber: 4, state: 'running', steps: [{ index: 0, name: 'Reproduce', why: '', beganAt: T }, { index: 1, name: 'Fix', why: '', beganAt: T + 2000 }] } } } as unknown as WorkspaceState;
}

describe('the store', () => {
  let store: TelemetryStore;
  beforeEach(() => {
    store = new TelemetryStore(fresh('telemetry.sqlite'), stateWithSteps);
  });
  afterEach(() => store.close());

  it('keeps every span redacted, tagged with its run, its phase and the ability in use', () => {
    expect(store.ingestTraces(RUN_SPANS)).toBe(8);
    const rows = store.query('SELECT span_id, name, run_id, ticket, agent_kind, agent_number, phase, ability, command, attrs, events FROM spans ORDER BY start_ms') as Array<Record<string, string | number | null>>;
    expect(rows.map((r) => [r.span_id, r.phase, r.ability])).toEqual([
      ['i', 'Reproduce', null],
      ['m1', 'Reproduce', null],
      ['s', 'Reproduce', 'find-request-logs'],
      ['m2', 'Reproduce', 'find-request-logs'],
      ['b1', 'Fix', 'find-request-logs'],
      ['b1x', 'Fix', 'find-request-logs'],
      ['b2', 'Fix', 'find-request-logs'],
      ['b2x', 'Fix', 'find-request-logs'],
    ]);
    expect(rows[0]).toMatchObject({ run_id: 'run-1', ticket: 'SHOP-3546', agent_kind: 'ticket', agent_number: 4 });
    // The made-up token is nowhere: not in the prompt, the command, the attributes, nor the tool's output.
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
    expect(rows[6]!.command).toMatch(/^curl -H "Authorization: token \[redacted [a-z ]+\]" x$/);
    expect(String(rows[6]!.events)).toMatch(/ok \[redacted [a-z ]+\]/);
  });

  it('says how each call went from its execution span, and sums a run with its outcome', () => {
    store.ingestTraces(RUN_SPANS);
    expect(store.query("SELECT tool_use_id, failed, error_class FROM tool_calls WHERE tool_name = 'Bash' ORDER BY start_ms")).toEqual([
      { tool_use_id: 'tu-1', failed: 1, error_class: 'ShellError' },
      { tool_use_id: 'tu-2', failed: 0, error_class: null },
    ]);
    expect([...store.toolCalls(['tu-1', 'tu-2', 'nope'])]).toEqual([
      ['tu-1', { command: 'kubectl get pods -n x', failed: true, errorClass: 'ShellError', ms: 400 }],
      ['tu-2', { command: expect.stringMatching(/^curl -H "Authorization: token \[redacted [a-z ]+\]" x$/), failed: false, errorClass: null, ms: 300 }],
    ]);
    store.upsertOutcome({ runId: 'run-1', endState: 'succeeded', verdict: 'VALID', prState: 'merged', reviewRounds: 2 }, T);
    expect(store.runSummary('run-1')).toMatchObject({
      model_calls: 2,
      input_tokens: 1400,
      output_tokens: 300,
      cache_creation_tokens: 3000,
      cache_read_tokens: 110000,
      tool_calls: 3,
      failed_calls: 1,
      wall_ms: 9000,
      end_state: 'succeeded',
      verdict: 'VALID',
      pr_state: 'merged',
      review_rounds: 2,
      reopened: 0,
    });
  });

  it('measures a use from its Skill call: tokens with cache writes, cache reads apart, time, calls and failures', () => {
    store.ingestTraces(RUN_SPANS);
    expect(store.useCost('tu-skill')).toEqual({ tokens: 500, cacheRead: 60000, ms: 8000, calls: 2, failed: 1 });
    expect(store.useCost('tu-skill', 'tu-2')).toEqual({ tokens: 500, cacheRead: 60000, ms: 2000, calls: 1, failed: 1 });
    expect(store.useCost('nope')).toBeUndefined();
  });

  it('in her conversation, an ability is in use only in the turn that loaded it', () => {
    store.ingestTraces(
      traces({ 'elfoqsy.agent_kind': 'conversation', 'elfoqsy.conversation_id': 'c1' }, [
        { id: 'i1', trace: 'turn-1', name: 'claude_code.interaction', start: T - 5, end: T + 40 },
        { id: 'k', trace: 'turn-1', parent: 'i1', name: 'claude_code.tool', start: T, end: T + 10, attrs: { tool_name: 'Skill', tool_use_id: 'k1', skill_name: 'find-service-pod' } },
        { id: 'r1', trace: 'turn-1', parent: 'i1', name: 'claude_code.tool', start: T + 20, end: T + 30, attrs: { tool_name: 'mcp__orchestrator__kube', tool_use_id: 'k2' } },
        { id: 'i2', trace: 'turn-2', name: 'claude_code.interaction', start: T + 4995, end: T + 5020 },
        { id: 'r2', trace: 'turn-2', parent: 'i2', name: 'claude_code.tool', start: T + 5000, end: T + 5010, attrs: { tool_name: 'mcp__orchestrator__kube', tool_use_id: 'k3' } },
      ]),
    );
    expect(store.query("SELECT span_id, ability, conversation_id FROM spans WHERE name = 'claude_code.tool' ORDER BY start_ms")).toEqual([
      { span_id: 'k', ability: 'find-service-pod', conversation_id: 'c1' },
      { span_id: 'r1', ability: 'find-service-pod', conversation_id: 'c1' },
      { span_id: 'r2', ability: null, conversation_id: 'c1' },
    ]);
  });

  it('a first turn the binary did not trace (his login, 2026-10-21) is still a turn: by its prompt, its ability, its cost', () => {
    // Turn 1 as it came: no interaction span, each call the root of its own trace. Turn 2 traced as usual.
    const her = { 'elfoqsy.agent_kind': 'conversation', 'elfoqsy.conversation_id': 'c1' };
    store.ingestLogs(prompts(her, 'sess-1', [['p1', T], ['p2', T + 10_000]]));
    store.ingestTraces(
      traces(her, [
        { id: 'm1', trace: 'o1', name: 'claude_code.llm_request', start: T + 100, end: T + 900, attrs: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 1000, cache_creation_tokens: 50 } },
        { id: 'k', trace: 'o2', name: 'claude_code.tool', start: T + 1000, end: T + 1010, attrs: { tool_name: 'Skill', tool_use_id: 'k1', skill_name: 'find-service-pod' } },
        { id: 'm2', trace: 'o3', name: 'claude_code.llm_request', start: T + 1100, end: T + 1900, attrs: { input_tokens: 200, output_tokens: 20, cache_read_tokens: 2000, cache_creation_tokens: 0 } },
        { id: 'r1', trace: 'o4', name: 'claude_code.tool', start: T + 2000, end: T + 2500, attrs: { tool_name: 'Bash', tool_use_id: 'k2', full_command: 'kubectl get pods' } },
        { id: 'r1x', trace: 'o4', parent: 'r1', name: 'claude_code.tool.execution', start: T + 2010, end: T + 2490, attrs: { tool_use_id: 'k2' }, error: 'Shell command failed' },
        { id: 'i2', trace: 'turn-2', name: 'claude_code.interaction', start: T + 9990, end: T + 12_000, attrs: { 'interaction.sequence': 2 } },
        { id: 'm3', trace: 'turn-2', parent: 'i2', name: 'claude_code.llm_request', start: T + 10_100, end: T + 11_000, attrs: { input_tokens: 300, output_tokens: 30, cache_read_tokens: 3000, cache_creation_tokens: 0 } },
        { id: 'r2', trace: 'turn-2', parent: 'i2', name: 'claude_code.tool', start: T + 11_100, end: T + 11_200, attrs: { tool_name: 'Bash', tool_use_id: 'k3', full_command: 'ls' } },
      ]),
    );
    expect(store.query("SELECT span_id, ability FROM spans WHERE name = 'claude_code.tool' ORDER BY start_ms")).toEqual([
      { span_id: 'k', ability: 'find-service-pod' },
      { span_id: 'r1', ability: 'find-service-pod' },
      { span_id: 'r2', ability: null },
    ]);
    // The use ends with its turn: m2 and r1 (failed), not turn 2's m3 and r2.
    expect(store.useCost('k1')).toEqual({ tokens: 220, cacheRead: 2000, ms: 1500, calls: 1, failed: 1 });
    expect(store.query('SELECT turns, traced_turns, model_calls, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, tool_calls, failed_calls, wall_ms FROM session_summary')).toEqual([
      { turns: 2, traced_turns: 1, model_calls: 3, input_tokens: 600, output_tokens: 60, cache_creation_tokens: 50, cache_read_tokens: 6000, tool_calls: 3, failed_calls: 1, wall_ms: 11_900 },
    ]);
  });

  it('sums every session, of every kind, not only runs', () => {
    store.ingestTraces(RUN_SPANS);
    const one = (kind: string, session: string, extra: Record<string, string>, at: number) =>
      traces({ 'elfoqsy.agent_kind': kind, ...extra }, [
        { id: `${session}-i`, trace: session, name: 'claude_code.interaction', start: at, end: at + 3000, attrs: { 'session.id': session } },
        { id: `${session}-m`, trace: session, parent: `${session}-i`, name: 'claude_code.llm_request', start: at + 10, end: at + 2000, attrs: { 'session.id': session, input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 1 } },
      ]);
    store.ingestTraces(one('conversation', 'sess-c', { 'elfoqsy.conversation_id': 'c1' }, T + 20_000));
    store.ingestTraces(one('investigator', 'sess-v', { 'elfoqsy.run_id': 'inv-1', 'elfoqsy.conversation_id': 'c1' }, T + 30_000));
    store.ingestTraces(one('task', 'sess-t', { 'elfoqsy.run_id': 'run-t', 'elfoqsy.agent_number': '2' }, T + 40_000));
    store.ingestTraces(one('responder', 'sess-r', { 'elfoqsy.run_id': 'run-1' }, T + 50_000));
    expect(store.query('SELECT agent_kind, session_id, run_id, conversation_id, turns, model_calls, tool_calls, failed_calls, wall_ms FROM session_summary ORDER BY started_ms')).toEqual([
      { agent_kind: 'ticket', session_id: 'sess-1', run_id: 'run-1', conversation_id: null, turns: 1, model_calls: 2, tool_calls: 3, failed_calls: 1, wall_ms: 9000 },
      { agent_kind: 'conversation', session_id: 'sess-c', run_id: null, conversation_id: 'c1', turns: 1, model_calls: 1, tool_calls: 0, failed_calls: 0, wall_ms: 3000 },
      { agent_kind: 'investigator', session_id: 'sess-v', run_id: 'inv-1', conversation_id: 'c1', turns: 1, model_calls: 1, tool_calls: 0, failed_calls: 0, wall_ms: 3000 },
      { agent_kind: 'task', session_id: 'sess-t', run_id: 'run-t', conversation_id: null, turns: 1, model_calls: 1, tool_calls: 0, failed_calls: 0, wall_ms: 3000 },
      { agent_kind: 'responder', session_id: 'sess-r', run_id: 'run-1', conversation_id: null, turns: 1, model_calls: 1, tool_calls: 0, failed_calls: 0, wall_ms: 3000 },
    ]);
  });

  it('finds failures that keep coming back: three or more, in two sessions or more', () => {
    const failing = (session: string, id: string, at: number) =>
      traces({ 'elfoqsy.agent_kind': 'ticket', 'elfoqsy.run_id': `run-${session}` }, [
        { id: `${id}t`, trace: session, name: 'claude_code.tool', start: at, end: at + 10, attrs: { 'session.id': session, tool_name: 'Bash', tool_use_id: id, full_command: `kubectl --context dev get deploy request-handler-${id}` } },
        { id: `${id}x`, trace: session, parent: `${id}t`, name: 'claude_code.tool.execution', start: at, end: at + 10, attrs: { 'session.id': session, tool_use_id: id }, error: 'NotFound' },
      ]);
    for (const [s, id, at] of [['a', 'f1', T], ['a', 'f2', T + 100], ['b', 'f3', T + 200]] as const) store.ingestTraces(failing(s, id, at));
    const r = store.recurringFailures(T - 1);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ tool: 'Bash', signature: 'kubectl get deploy', count: 3, sessions: 2, runs: ['run-a', 'run-b'] });
    expect(store.recurringFailures(T - 1, 4)).toEqual([]);
  });

  it('keeps log events redacted, answers only reading queries, and drops what is older than it keeps', () => {
    expect(
      store.ingestLogs({
        resourceLogs: [
          {
            resource: { attributes: kv(RUN) },
            scopeLogs: [{ logRecords: [{ timeUnixNano: nano(T), body: { stringValue: 'claude_code.api_request' }, attributes: kv({ 'event.name': 'api_request', 'event.timestamp': new Date(T).toISOString(), cost_usd: 0.0123, model: 'claude-opus-5-5' }) }, { timeUnixNano: nano(T + 1), body: { stringValue: 'claude_code.tool_result' }, attributes: kv({ 'event.name': 'tool_result', 'event.timestamp': new Date(T + 1).toISOString(), tool_name: 'Bash', tool_use_id: 'tu-1', success: 'false', tool_input: `echo ${FAKE_TOKEN}` }) }] }],
          },
        ],
      }),
    ).toBe(2);
    const events = store.query('SELECT name, run_id, tool_use_id, success, cost_usd, attrs FROM events ORDER BY time_ms') as Array<Record<string, unknown>>;
    expect(events.map((e) => [e.name, e.run_id, e.tool_use_id, e.success, e.cost_usd])).toEqual([
      ['api_request', 'run-1', null, null, 0.0123],
      ['tool_result', 'run-1', 'tu-1', 0, null],
    ]);
    expect(JSON.stringify(events)).not.toContain(FAKE_TOKEN);
    expect(() => store.query('DELETE FROM events')).toThrow(/Only queries that read/);
    store.ingestTraces(RUN_SPANS);
    store.prune(T + 1);
    expect(store.query('SELECT count(*) AS n FROM events')).toEqual([{ n: 1 }]);
  });
});

describe('the receiver', () => {
  it('listens on 127.0.0.1 only, stores traces and events, refuses anything else', async () => {
    const store = new TelemetryStore(fresh('telemetry.sqlite'), stateWithSteps);
    const rx = await startReceiver(store);
    try {
      expect(rx.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const post = (path: string, body: string, type = 'application/json') => fetch(`${rx.url}${path}`, { method: 'POST', headers: { 'content-type': type }, body });
      expect((await post('/v1/traces', JSON.stringify(RUN_SPANS))).status).toBe(200);
      expect((await post('/v1/logs', JSON.stringify({ resourceLogs: [] }))).status).toBe(200);
      expect((await post('/v1/metrics', '{}')).status).toBe(200);
      expect((await post('/v1/traces', 'not json')).status).toBe(400);
      expect((await post('/v1/traces', 'x', 'application/x-protobuf')).status).toBe(415);
      expect((await fetch(`${rx.url}/v1/traces`)).status).toBe(405);
      expect((await post('/elsewhere', '{}')).status).toBe(404);
      expect(store.query('SELECT count(*) AS n FROM spans')).toEqual([{ n: 8 }]);
    } finally {
      await rx.close();
      store.close();
    }
  });
  it('waits for the last exports of sessions that are ending before it closes', async () => {
    const store = new TelemetryStore(fresh('telemetry.sqlite'), stateWithSteps);
    const rx = await startReceiver(store);
    try {
      const t0 = Date.now();
      // A session that just ended sends its last batch a moment after the daemon began to stop.
      setTimeout(() => void fetch(`${rx.url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(RUN_SPANS) }), 400);
      await rx.drain(800, 5000);
      expect(store.query('SELECT count(*) AS n FROM spans')).toEqual([{ n: 8 }]);
      expect(Date.now() - t0).toBeLessThan(3000);
      const quiet = Date.now();
      await rx.drain(300, 5000); // nothing coming: it returns soon
      expect(Date.now() - quiet).toBeLessThan(1000);
    } finally {
      await rx.close();
      store.close();
    }
  });
});

describe('outcomes beside the spans', () => {
  const ticket = (key: string, status: Ticket['status']): Ticket => ({ key, board: 'SHOP', summary: 'x', type: 'Bug', status, priority: 'Major', storyPoints: 1, sprint: 's', sprintsCarried: 0, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: 'd' });

  it('follow each run: its end, its verdict, its PRs, the review rounds once merged, and a reopened ticket', async () => {
    const log = new EventLog(':memory:');
    const live = new LiveState(log);
    const store = new TelemetryStore(fresh('telemetry.sqlite'));
    const rounds: string[] = [];
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546', 'In progress') });
    log.append('orchestrator', 'run.created', { runId: 'run-1', ticket: 'SHOP-3546', worktree: '/w', branch: 'b', agentNumber: 4, model: 'm', effort: 'high', budget: { tokens: 1, minutes: 1 }, repos: [] } as never);
    const stop = watchOutcomes({ store, state: () => live.get(), onEvent: (l) => live.onEvent(l), reviewRounds: async (repo, number) => (rounds.push(`${repo}#${number}`), 3) });
    expect(store.outcome('run-1')).toMatchObject({ ticket: 'SHOP-3546', agent_kind: 'ticket', agent_number: 4, end_state: null });
    log.append('agent', 'run.verdict', { runId: 'run-1', verdict: 'VALID', reproduced: true, summary: 's' } as never);
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 7, state: 'open', ticket: 'SHOP-3546', url: 'u', checks: 'none' } });
    log.append('orchestrator', 'run.state_changed', { runId: 'run-1', state: 'succeeded' } as never);
    expect(store.outcome('run-1')).toMatchObject({ verdict: 'VALID', pr_state: 'open', end_state: 'succeeded', review_rounds: null });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 7, state: 'merged', ticket: 'SHOP-3546', url: 'u', checks: 'success' } });
    log.append('github', 'pr.synced', { pr: { repo: SHOP_API, number: 7, state: 'merged', ticket: 'SHOP-3546', url: 'u', checks: 'success' } });
    await tick(10);
    expect(rounds).toEqual([`${SHOP_API}#7`]);
    expect(store.outcome('run-1')).toMatchObject({ pr_state: 'merged', review_rounds: 3, reopened: 0 });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546', 'Done') });
    log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546', 'In progress') });
    expect(store.outcome('run-1')).toMatchObject({ reopened: 1, verdict: 'VALID' });
    expect(outcomeOf(live.get(), 'nope')).toBeUndefined();
    stop();
    store.close();
    live.close();
    log.close();
  });
});

describe('every session is tagged', () => {
  beforeEach(() => setTelemetryEndpoint('http://127.0.0.1:4999'));

  it('a ticket run: its run id, ticket, kind and agent number', async () => {
    const w = orchestratorWorld({ tickets: true });
    try {
      w.log.append('jira', 'ticket.synced', { ticket: { key: 'SHOP-3546', board: 'SHOP', summary: 'x', type: 'Bug', status: 'To do', priority: 'Major', storyPoints: 1, sprint: 's', sprintsCarried: 1, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: 'd' } });
      const r = (await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })) as { runId: string };
      await tick();
      const env = w.sdk.sessions.at(-1)!.options.env!;
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4999');
      expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(`elfoqsy.agent_kind=ticket,elfoqsy.run_id=${r.runId},elfoqsy.ticket=SHOP-3546,elfoqsy.agent_number=1`);
      // The run's own environment is kept: its temp folder and no credentials.
      expect(env.TMPDIR).toBeDefined();
    } finally {
      await w.close();
    }
  });

  it('a task agent', async () => {
    const w = orchestratorWorld({ tickets: true });
    try {
      await w.orchestrator.spawnTask({ name: 'Notes', goal: 'Draft them.', deliverable: 'document', model: 'haiku', effort: 'low' });
      await tick();
      expect(w.sdk.sessions.at(-1)!.options.env!.OTEL_RESOURCE_ATTRIBUTES).toMatch(/^elfoqsy\.agent_kind=task,elfoqsy\.run_id=run-[^,]+,elfoqsy\.ticket=task%3A[^,]+,elfoqsy\.agent_number=1$/);
    } finally {
      await w.close();
    }
  });

  it('her conversation, with its id', () => {
    const o = sessionOptions({ systemPrompt: 'P', mcpServer: { type: 'sdk', name: 'orchestrator', instance: {} } as never, cwd: '/c', env: { PATH: '/usr/bin' }, conversationId: 'today-2026-10-21' });
    expect(o.env).toMatchObject({ PATH: '/usr/bin', OTEL_SERVICE_NAME: 'elfoqsy-conversation', OTEL_RESOURCE_ATTRIBUTES: 'elfoqsy.agent_kind=conversation,elfoqsy.conversation_id=today-2026-10-21' });
  });

  it('investigators, the responder and the abilities’ own sessions say what they are', async () => {
    const { readFileSync } = await import('node:fs');
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');
    expect(src('agents/investigator.ts')).toContain("telemetryEnv({ kind: 'investigator', runId: inv.id, conversationId: inv.args.conversationId })");
    expect(src('decisions/responder.ts')).toContain("telemetryEnv({ kind: 'responder', runId: r.runId })");
    expect(src('abilities/engine.ts')).toContain("telemetryEnv({ kind: 'abilities' })");
  });
});

describe('the abilities, from the spans', () => {
  let log: EventLog;
  let live: LiveState;
  let store: AbilityStore;
  let telemetry: TelemetryStore;
  let replies: string[];
  let engine: AbilityEngine;
  const logs = (over: Partial<Ability> = {}): Ability => ({
    name: 'find-request-logs',
    version: 1,
    title: "Find a request's logs",
    titleVi: 'tìm log của một request',
    tool: 'coralogix',
    whenToUse: 'A request id.',
    steps: [{ text: 'Search it', code: "wildfind 'x'" }],
    doneWhen: 'Found.',
    finder: { by: 'elfoqsy', session: 'friction analysis' },
    source: 'friction analysis',
    createdAt: '2026-10-20T00:00:00.000Z',
    baseline: { steps: 5, failed: 1, questions: 0, cases: 3, from: 'past work' },
    track: { tools: ['Bash'], match: 'kubectl|curl' },
    ...over,
  });
  beforeEach(() => {
    log = new EventLog(':memory:');
    live = new LiveState(log);
    store = new AbilityStore(fresh('skills'));
    telemetry = new TelemetryStore(fresh('telemetry.sqlite'), stateWithSteps);
    replies = [];
    const queryFn: QueryFn = () =>
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: replies.shift() ?? '{"skill": null}' }] } } as never;
        yield result();
      })();
    engine = new AbilityEngine({ log, state: () => live.get(), store, read: async () => ({ ok: true, text: '' }), queryFn, model: 'm', cwd: base, env: {}, telemetry });
  });
  afterEach(() => {
    telemetry.close();
    live.close();
    log.close();
  });

  /** The run as its log has it: the Skill call, the failing command the tool reported as fine, and the one that worked. */
  function runLog() {
    log.append('orchestrator', 'run.created', { runId: 'run-1', ticket: 'SHOP-3546', worktree: '/w', branch: 'b', agentNumber: 4, model: 'm', effort: 'high', budget: { tokens: 1, minutes: 1 }, repos: [] } as never);
    const call = (toolUseId: string, tool: string, input: Record<string, unknown>) => {
      log.append('agent', 'tool.called', { runId: 'run-1', toolUseId, tool, title: '', inputSummary: JSON.stringify(input).slice(0, 200), allowed: true });
      log.append('agent', 'tool.finished', { runId: 'run-1', toolUseId, ok: true, outputSummary: '', durationMs: 5 });
    };
    call('tu-skill', 'Skill', { skill: 'abilities:find-request-logs' });
    call('tu-1', 'Bash', { command: 'kubectl get pods -n x' });
    call('tu-2', 'Bash', { command: 'curl x' });
  }

  it('a run’s use: its failures from the execution spans, and what it cost in tokens, cache reads and time', async () => {
    await engine.learn(logs());
    telemetry.ingestTraces(RUN_SPANS);
    runLog();
    await engine.runEnded({ runId: 'run-1', agentNumber: 4, ticket: 'SHOP-3546', state: 'succeeded' });
    const used = log.readFrom(0, 1000, ['ability.used']).map((e) => e.payload);
    // The log said both commands went fine; the spans say the first failed.
    expect(used).toEqual([expect.objectContaining({ name: 'find-request-logs', runId: 'run-1', worked: true, steps: 2, failedCalls: 1, tokens: 500, cacheRead: 60000, ms: 8000 })]);
  });

  it('without spans, a use is measured from the log as before', async () => {
    await engine.learn(logs());
    runLog();
    await engine.runEnded({ runId: 'run-1', agentNumber: 4, state: 'succeeded' });
    const used = log.readFrom(0, 1000, ['ability.used']).map((e) => e.payload);
    expect(used[0]).toMatchObject({ failedCalls: 0 });
    expect(used[0]).not.toHaveProperty('tokens');
  });

  it('turns a failure that keeps coming back in the traces into an ability of hers, once', async () => {
    const failing = (session: string, id: string, at: number) =>
      traces({ 'elfoqsy.agent_kind': 'ticket', 'elfoqsy.run_id': `run-${session}` }, [
        { id: `${id}t`, trace: session, name: 'claude_code.tool', start: at, end: at + 10, attrs: { 'session.id': session, tool_name: 'Bash', tool_use_id: id, full_command: 'aws s3 ls s3://bucket --profile staging-shop' } },
        { id: `${id}x`, trace: session, parent: `${id}t`, name: 'claude_code.tool.execution', start: at, end: at + 10, attrs: { 'session.id': session, tool_use_id: id, error_class: 'ShellError' }, error: 'AccessDenied' },
      ]);
    for (const [s, id, at] of [['a', 'f1', T], ['b', 'f2', T + 1], ['b', 'f3', T + 2]] as const) telemetry.ingestTraces(failing(s, id, at));
    replies.push(JSON.stringify({ skill: { name: 'aws-profile-for-s3', title: 'Use the profile that can read the bucket', titleVi: 'dùng đúng profile đọc được bucket', tool: 'aws', whenToUse: "Listing a bucket ('s3 ls').", steps: [{ text: 'List with the dev profile', code: 'aws s3 ls --profile dev-shop' }], doneWhen: 'Listed.', track: { tools: ['Bash'], match: '\\baws s3\\b' } } }));
    expect(await engine.discoverRecurring(T - 1)).toBe('aws-profile-for-s3');
    expect(store.get('aws-profile-for-s3')).toMatchObject({ finder: { by: 'elfoqsy', session: 'traces' }, baseline: { steps: 1.5, failed: 1.5, questions: 0, cases: 2 } });
    // Asked once: the same failure is not put to the review again, and one an ability covers is never asked about.
    expect(await engine.discoverRecurring(T - 1)).toBeUndefined();
  });
});

describe.skipIf(!sandboxAvailable())('on the real Claude Code binary', () => {
  it('a session’s spans arrive at the receiver tagged, redacted, joinable by tool use id, a failed command failed', async () => {
    const telemetry = new TelemetryStore(fresh('telemetry.sqlite'));
    const rx = await startReceiver(telemetry);
    setTelemetryEndpoint(rx.url);
    const cwd = fresh('cwd');
    mkdirSync(cwd, { recursive: true });
    const reply = (req: ApiRequest): Reply => {
      const r = toolResults(req);
      if (r.size === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${FAKE_TOKEN}`, description: 'echo' } }];
      if (r.size === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: 'false', description: 'fail' } }];
      return [{ type: 'text', text: 'done' }];
    };
    const api = await fakeAnthropic(reply);
    try {
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fresh('home'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...telemetryEnv({ kind: 'ticket', runId: 'run-real', ticket: 'SHOP-1', agentNumber: 7 }) };
      for await (const m of query({ prompt: 'Run it.', options: { cwd, env, model: 'claude-haiku-5-5', tools: { type: 'preset', preset: 'claude_code' }, settingSources: [], skills: [], strictMcpConfig: true, persistSession: false, permissionMode: 'default', canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }) } })) {
        if (m.type === 'result') break;
      }
      // The binary flushes on exit; give the batch a moment to land.
      for (let i = 0; i < 40 && !(telemetry.query("SELECT count(*) AS n FROM spans WHERE name = 'claude_code.interaction'") as Array<{ n: number }>)[0]!.n; i++) await tick(250);
    } finally {
      await api.close();
    }
    try {
      const summary = telemetry.runSummary('run-real');
      expect(summary).toMatchObject({ ticket: 'SHOP-1', agent_kind: 'ticket', agent_number: 7, model_calls: 3, tool_calls: 2, failed_calls: 1 });
      const calls = telemetry.query("SELECT command, failed, error_class FROM tool_calls WHERE run_id = 'run-real' ORDER BY start_ms") as Array<{ command: string; failed: number; error_class: string | null }>;
      expect(calls.map((c) => [c.command, c.failed])).toEqual([
        ['echo [redacted github token]', 0],
        ['false', 1],
      ]);
      expect(calls[1]!.error_class).toBe('ShellError');
      expect(JSON.stringify(telemetry.query('SELECT attrs, events FROM spans'))).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(telemetry.query('SELECT attrs FROM events'))).not.toContain(FAKE_TOKEN);
      expect((telemetry.query("SELECT count(*) AS n FROM events WHERE run_id = 'run-real' AND name = 'tool_result'") as Array<{ n: number }>)[0]!.n).toBe(2);
    } finally {
      await rx.close();
      telemetry.close();
    }
  }, 120_000);

  for (const end of ['close', 'abort'] as const) {
    it(`her conversation ending right after one quick reply (${end}) keeps all its spans, the turn included`, async () => {
      const telemetry = new TelemetryStore(fresh('telemetry.sqlite'));
      const rx = await startReceiver(telemetry);
      setTelemetryEndpoint(rx.url);
      const cwd = fresh('cwd');
      mkdirSync(cwd, { recursive: true });
      const api = await fakeAnthropic(() => [{ type: 'text', text: 'Chào cậu.' }]);
      const abort = new AbortController();
      try {
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fresh('home'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...telemetryEnv({ kind: 'conversation', conversationId: `quick-${end}` }) };
        // Her session as the daemon opens it: streaming input that stays open, as a conversation does.
        let release: () => void = () => undefined;
        const input = (async function* () {
          yield { type: 'user', message: { role: 'user', content: 'hi elf' }, parent_tool_use_id: null } as SDKUserMessage;
          await new Promise<void>((r) => (release = r));
        })();
        const server = createSdkMcpServer({ name: 'orchestrator', version: '1', tools: [] });
        const options = { ...sessionOptions({ systemPrompt: 'You are Elfoqsy.', mcpServer: server, cwd, env, model: 'claude-haiku-5-5', effort: 'low', conversationId: `quick-${end}` }), abortController: abort };
        const q = query({ prompt: input, options });
        for await (const m of q) {
          if (m.type !== 'result') continue;
          // Ends at once, as the daemon stopping or the conversation closing would: no wait for an export.
          if (end === 'close') q.close();
          else abort.abort();
          break;
        }
        release();
        // What the daemon does on stop: drain the receiver, then close it.
        await rx.drain();
      } finally {
        await api.close();
      }
      try {
        const spans = telemetry.query("SELECT name, json_extract(attrs, '$.\"interaction.sequence\"') AS seq FROM spans WHERE conversation_id = ? ORDER BY start_ms", [`quick-${end}`]) as Array<{ name: string; seq: number | null }>;
        expect(spans.map((x) => x.name)).toEqual(['claude_code.interaction', 'claude_code.llm_request']);
        expect(spans[0]!.seq).toBe(1);
        expect(telemetry.query('SELECT agent_kind, turns, traced_turns, model_calls FROM session_summary')).toEqual([{ agent_kind: 'conversation', turns: 1, traced_turns: 1, model_calls: 1 }]);
      } finally {
        await rx.close();
        telemetry.close();
      }
    }, 60_000);
  }

  it('a session cut off mid-turn (the daemon stopping) still has its spans, because the daemon drains before it closes', async () => {
    const telemetry = new TelemetryStore(fresh('telemetry.sqlite'));
    const rx = await startReceiver(telemetry);
    setTelemetryEndpoint(rx.url);
    const cwd = fresh('cwd');
    mkdirSync(cwd, { recursive: true });
    const api = await fakeAnthropic((req) => (toolResults(req).size ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 20', description: 'wait' } }]));
    let atEnd: string[] = [];
    try {
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fresh('home'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...telemetryEnv({ kind: 'ticket', runId: 'run-cut', ticket: 'SHOP-2' }) };
      const q = query({ prompt: 'Wait.', options: { cwd, env, model: 'claude-haiku-5-5', tools: ['Bash'], settingSources: [], skills: [], strictMcpConfig: true, persistSession: false, permissionMode: 'default', canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }) } });
      for await (const m of q) {
        // The command is running: the daemon stops now.
        if (m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use')) {
          await tick(500);
          q.close();
          break;
        }
      }
      atEnd = (telemetry.query('SELECT name FROM spans') as Array<{ name: string }>).map((x) => x.name);
      await rx.drain();
    } finally {
      await api.close();
    }
    try {
      const names = (telemetry.query("SELECT name FROM spans WHERE run_id = 'run-cut' ORDER BY start_ms") as Array<{ name: string }>).map((x) => x.name);
      expect(names).toContain('claude_code.interaction');
      expect(names).toContain('claude_code.llm_request');
      expect(names.length).toBeGreaterThan(atEnd.length); // these came after the session was closed, while the receiver drained
    } finally {
      await rx.close();
      telemetry.close();
    }
  }, 60_000);
});
