// The spans and log events Elfoqsy's sessions export (env.ts), kept where they can be queried: data/telemetry.sqlite.
// Everything a span or event carries goes through the redactor before it is written. Each span gets what the daemon
// knows and the binary does not: the run's phase (its step at the span's start) and the ability in use (the last skill
// its session loaded; in her conversation, in the same turn). Outcomes are a table of their own, by run id, so spans
// and outcomes join (outcomes.ts). Nothing is shown yet: the data is kept for a few weeks of real runs (alex,
// 2026-10-21), then a dashboard is designed from it.
import Database from 'better-sqlite3';
import type { WorkspaceState } from '@elfoqsy/state';
import { redact, redactDeep } from '../redact';
import { signature } from '../abilities/friction';

/** One OTLP attribute value, as http/json sends it. */
type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] } };
type KeyValue = { key: string; value?: AnyValue };
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: KeyValue[];
  events?: Array<{ name: string; timeUnixNano?: string | number; attributes?: KeyValue[] }>;
  status?: { code?: number; message?: string };
}
export interface OtlpTraces {
  resourceSpans?: Array<{ resource?: { attributes?: KeyValue[] }; scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
}
export interface OtlpLogs {
  resourceLogs?: Array<{ resource?: { attributes?: KeyValue[] }; scopeLogs?: Array<{ logRecords?: Array<{ timeUnixNano?: string | number; body?: AnyValue; attributes?: KeyValue[]; traceId?: string; spanId?: string }> }> }>;
}

function plain(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(plain);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  return undefined;
}
const attrs = (kv: KeyValue[] | undefined): Record<string, unknown> => Object.fromEntries((kv ?? []).map((a) => [a.key, plain(a.value)]));
const ms = (nano: string | number | undefined): number => (nano === undefined ? 0 : Math.round(Number(BigInt(String(nano)) / 1000n) / 1000));
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const bool = (v: unknown): number | null => (v === true || v === 'true' || v === 'True' ? 1 : v === false || v === 'false' || v === 'False' ? 0 : null);
/** A skill's name as the abilities know it. */
const skillName = (v: unknown): string | null => (typeof v === 'string' && v ? v.replace(/^\//, '').replace(/^abilities:/, '') : null);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL, error TEXT,
  session_id TEXT, agent_kind TEXT, run_id TEXT, ticket TEXT, agent_number INTEGER, conversation_id TEXT,
  phase TEXT, ability TEXT,
  tool_name TEXT, tool_use_id TEXT, command TEXT, skill TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  success INTEGER, error_class TEXT,
  attrs TEXT NOT NULL, events TEXT
);
CREATE INDEX IF NOT EXISTS spans_run ON spans (run_id, start_ms);
CREATE INDEX IF NOT EXISTS spans_session ON spans (session_id, start_ms);
CREATE INDEX IF NOT EXISTS spans_tool_use ON spans (tool_use_id);
CREATE INDEX IF NOT EXISTS spans_parent ON spans (parent_span_id);
CREATE INDEX IF NOT EXISTS spans_name ON spans (name, start_ms);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time_ms INTEGER NOT NULL, name TEXT NOT NULL,
  trace_id TEXT, span_id TEXT, session_id TEXT, agent_kind TEXT, run_id TEXT, ticket TEXT, agent_number INTEGER, conversation_id TEXT,
  tool_name TEXT, tool_use_id TEXT, success INTEGER, cost_usd REAL, attrs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, time_ms);
CREATE INDEX IF NOT EXISTS events_name ON events (name, time_ms);
CREATE INDEX IF NOT EXISTS events_tool_use ON events (tool_use_id);
CREATE TABLE IF NOT EXISTS run_outcomes (
  run_id TEXT PRIMARY KEY, ticket TEXT, agent_kind TEXT, agent_number INTEGER, end_state TEXT, verdict TEXT,
  pr_state TEXT, review_rounds INTEGER, reopened INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER NOT NULL
);
-- Each tool call with how its execution went: the tool span, and its execution child's status.
CREATE VIEW IF NOT EXISTS tool_calls AS
  SELECT t.span_id, t.trace_id, t.session_id, t.agent_kind, t.run_id, t.ticket, t.agent_number, t.conversation_id, t.phase, t.ability,
         t.tool_name, t.tool_use_id, t.command, t.start_ms, t.duration_ms,
         CASE WHEN x.status = 'error' THEN 1 ELSE 0 END AS failed, x.error_class, x.error
  FROM spans t LEFT JOIN spans x ON x.parent_span_id = t.span_id AND x.name = 'claude_code.tool.execution'
  WHERE t.name = 'claude_code.tool';
-- A run as its spans tell it, with its outcome.
CREATE VIEW IF NOT EXISTS run_summary AS
  SELECT s.run_id, max(s.ticket) AS ticket, max(s.agent_kind) AS agent_kind, max(s.agent_number) AS agent_number,
         min(s.start_ms) AS started_ms, max(s.end_ms) AS ended_ms, max(s.end_ms) - min(s.start_ms) AS wall_ms,
         sum(CASE WHEN s.name = 'claude_code.llm_request' THEN 1 ELSE 0 END) AS model_calls,
         coalesce(sum(s.input_tokens), 0) AS input_tokens, coalesce(sum(s.output_tokens), 0) AS output_tokens,
         coalesce(sum(s.cache_read_tokens), 0) AS cache_read_tokens, coalesce(sum(s.cache_creation_tokens), 0) AS cache_creation_tokens,
         sum(CASE WHEN s.name = 'claude_code.tool' THEN 1 ELSE 0 END) AS tool_calls,
         sum(CASE WHEN s.name = 'claude_code.tool.execution' AND s.status = 'error' THEN 1 ELSE 0 END) AS failed_calls,
         o.end_state, o.verdict, o.pr_state, o.review_rounds, o.reopened
  FROM spans s LEFT JOIN run_outcomes o ON o.run_id = s.run_id
  WHERE s.run_id IS NOT NULL GROUP BY s.run_id;
-- Every session, of every kind (her conversations, investigators, ticket runs, task agents, the responder, study, exams,
-- the probe, the abilities' own): what its spans say, and its turns from its user_prompt events, since a turn whose
-- interaction span the binary did not export still has its prompt (traced_turns says how many it did export).
CREATE VIEW IF NOT EXISTS session_summary AS
  WITH sp AS (
    SELECT session_id, max(agent_kind) AS agent_kind, max(run_id) AS run_id, max(ticket) AS ticket, max(agent_number) AS agent_number,
           max(conversation_id) AS conversation_id, min(start_ms) AS started_ms, max(end_ms) AS ended_ms,
           sum(CASE WHEN name = 'claude_code.interaction' THEN 1 ELSE 0 END) AS traced_turns,
           sum(CASE WHEN name = 'claude_code.llm_request' THEN 1 ELSE 0 END) AS model_calls,
           coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
           coalesce(sum(cache_creation_tokens), 0) AS cache_creation_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
           sum(CASE WHEN name = 'claude_code.tool' THEN 1 ELSE 0 END) AS tool_calls,
           sum(CASE WHEN name = 'claude_code.tool.execution' AND status = 'error' THEN 1 ELSE 0 END) AS failed_calls
    FROM spans WHERE session_id IS NOT NULL GROUP BY session_id),
  ev AS (
    SELECT session_id, count(DISTINCT CASE WHEN name = 'user_prompt' THEN coalesce(json_extract(attrs, '$."prompt.id"'), id) END) AS turns,
           sum(cost_usd) AS cost_usd
    FROM events WHERE session_id IS NOT NULL GROUP BY session_id)
  SELECT sp.session_id, sp.agent_kind, sp.run_id, sp.ticket, sp.agent_number, sp.conversation_id, sp.started_ms, sp.ended_ms,
         sp.ended_ms - sp.started_ms AS wall_ms, max(coalesce(ev.turns, 0), sp.traced_turns) AS turns, sp.traced_turns,
         sp.model_calls, sp.input_tokens, sp.output_tokens, sp.cache_creation_tokens, sp.cache_read_tokens, sp.tool_calls, sp.failed_calls,
         ev.cost_usd
  FROM sp LEFT JOIN ev ON ev.session_id = sp.session_id;
`;

export interface ToolCallFacts {
  command: string | null;
  failed: boolean;
  errorClass: string | null;
  ms: number;
}

export interface UseCost {
  tokens: number;
  cacheRead: number;
  ms: number;
  calls: number;
  failed: number;
}

export interface Outcome {
  runId: string;
  ticket?: string;
  agentKind?: string;
  agentNumber?: number;
  endState?: string;
  verdict?: string;
  prState?: string;
  reviewRounds?: number;
  reopened?: boolean;
}

export interface RecurringFailure {
  tool: string;
  signature: string;
  errorClass: string | null;
  count: number;
  sessions: number;
  runs: string[];
  examples: string[];
}

export class TelemetryStore {
  private readonly db: Database.Database;

  constructor(
    file: string,
    /** The workspace, for each span's phase (its run's step at its start). */
    private readonly state: () => WorkspaceState = () => ({ runs: {} }) as unknown as WorkspaceState,
  ) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** The step a run was in at a moment. */
  private phaseOf(runId: string | null, at: number): string | null {
    if (!runId) return null;
    const steps = this.state().runs[runId]?.steps ?? [];
    const step = [...steps].reverse().find((s) => s.beganAt <= at);
    return step ? step.name : null;
  }

  /**
   * The turn of her conversation a moment falls in: from its prompt to the next one. A turn is its trace when the binary
   * exported the turn's interaction span, but under his login the first turn of each session runs outside it:
   * its calls come as roots of their own traces. So a turn is told by its user_prompt event (or its interaction span).
   */
  private turnAt(session: string, at: number): { from: number; to: number } {
    const starts = `SELECT time_ms AS t FROM events WHERE session_id = @s AND name = 'user_prompt'
                    UNION ALL SELECT start_ms AS t FROM spans WHERE session_id = @s AND name = 'claude_code.interaction'`;
    const from = (this.db.prepare(`SELECT max(t) AS t FROM (${starts}) WHERE t <= @at`).get({ s: session, at }) as { t: number | null }).t;
    const to = (this.db.prepare(`SELECT min(t) AS t FROM (${starts}) WHERE t > @at`).get({ s: session, at }) as { t: number | null }).t;
    return { from: from ?? 0, to: to ?? Number.MAX_SAFE_INTEGER };
  }

  /** The ability its session had loaded last before a moment; in her conversation, only in the same turn. */
  private abilityAt(session: string | null, trace: string, kind: string | null, at: number, orphan: boolean): string | null {
    if (!session) return null;
    const last = `SELECT skill FROM spans WHERE session_id = @s AND name = 'claude_code.tool' AND skill IS NOT NULL AND start_ms <= @at`;
    if (kind !== 'conversation') return (this.db.prepare(`${last} ORDER BY start_ms DESC LIMIT 1`).get({ s: session, at }) as { skill: string } | undefined)?.skill ?? null;
    // A turn the binary traced is its trace; one it did not (its calls are roots) is the time since its prompt.
    if (!orphan) return (this.db.prepare(`${last} AND trace_id = @trace ORDER BY start_ms DESC LIMIT 1`).get({ s: session, at, trace }) as { skill: string } | undefined)?.skill ?? null;
    const turn = this.turnAt(session, at);
    return (this.db.prepare(`${last} AND start_ms >= @from ORDER BY start_ms DESC LIMIT 1`).get({ s: session, at, from: turn.from }) as { skill: string } | undefined)?.skill ?? null;
  }

  /** OTLP traces (http/json): stored, redacted, each span with its phase and ability. Returns how many spans. */
  ingestTraces(body: OtlpTraces): number {
    const insert = this.db.prepare(`INSERT OR REPLACE INTO spans VALUES (@span_id, @trace_id, @parent_span_id, @name, @start_ms, @end_ms, @duration_ms, @status, @error,
      @session_id, @agent_kind, @run_id, @ticket, @agent_number, @conversation_id, @phase, @ability, @tool_name, @tool_use_id, @command, @skill, @model,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @success, @error_class, @attrs, @events)`);
    const rows: Array<{ span: OtlpSpan; a: Record<string, unknown> }> = [];
    for (const rs of body.resourceSpans ?? []) {
      const resource = attrs(rs.resource?.attributes);
      for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) rows.push({ span, a: { ...resource, ...attrs(span.attributes) } });
    }
    // In the order they started: a skill loaded earlier in the batch is in place for the spans after it.
    rows.sort((x, y) => ms(x.span.startTimeUnixNano) - ms(y.span.startTimeUnixNano));
    const tx = this.db.transaction(() => {
      for (const { span, a } of rows) {
        const start = ms(span.startTimeUnixNano);
        const end = ms(span.endTimeUnixNano);
        const runId = str(a['elfoqsy.run_id']);
        const kind = str(a['elfoqsy.agent_kind']);
        const session = str(a['session.id']);
        const skill = span.name === 'claude_code.tool' && a.tool_name === 'Skill' ? skillName(a.skill_name) : null;
        const command = str(a.full_command) ?? str(a.file_path) ?? str(a.skill_name) ?? str(a.subagent_type);
        const clean = redactDeep(a) as Record<string, unknown>;
        insert.run({
          span_id: span.spanId,
          trace_id: span.traceId,
          parent_span_id: span.parentSpanId || null,
          name: span.name,
          start_ms: start,
          end_ms: end,
          duration_ms: Math.max(0, end - start),
          status: span.status?.code === 2 ? 'error' : span.status?.code === 1 ? 'ok' : 'unset',
          error: span.status?.message ? redact(span.status.message).slice(0, 500) : null,
          session_id: session,
          agent_kind: kind,
          run_id: runId,
          ticket: str(a['elfoqsy.ticket']),
          agent_number: num(a['elfoqsy.agent_number']),
          conversation_id: str(a['elfoqsy.conversation_id']),
          phase: this.phaseOf(runId, start),
          ability: skill ?? this.abilityAt(session, span.traceId, kind, start, !span.parentSpanId && span.name !== 'claude_code.interaction'),
          tool_name: str(a.tool_name),
          tool_use_id: str(a.tool_use_id),
          command: command ? redact(command).slice(0, 2000) : null,
          skill,
          model: str(a.model),
          input_tokens: num(a.input_tokens),
          output_tokens: num(a.output_tokens),
          cache_read_tokens: num(a.cache_read_tokens),
          cache_creation_tokens: num(a.cache_creation_tokens),
          success: bool(a.success),
          error_class: str(a.error_class),
          attrs: JSON.stringify(clean),
          events: span.events?.length ? JSON.stringify(redactDeep(span.events.map((e) => ({ name: e.name, at: ms(e.timeUnixNano), attrs: attrs(e.attributes) })))) : null,
        });
      }
    });
    tx();
    return rows.length;
  }

  /** OTLP log events (http/json): stored, redacted. Returns how many. */
  ingestLogs(body: OtlpLogs): number {
    const insert = this.db.prepare(`INSERT INTO events (time_ms, name, trace_id, span_id, session_id, agent_kind, run_id, ticket, agent_number, conversation_id, tool_name, tool_use_id, success, cost_usd, attrs)
      VALUES (@time_ms, @name, @trace_id, @span_id, @session_id, @agent_kind, @run_id, @ticket, @agent_number, @conversation_id, @tool_name, @tool_use_id, @success, @cost_usd, @attrs)`);
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const rl of body.resourceLogs ?? []) {
        const resource = attrs(rl.resource?.attributes);
        for (const sl of rl.scopeLogs ?? []) {
          for (const r of sl.logRecords ?? []) {
            const a = { ...resource, ...attrs(r.attributes) };
            const name = str(a['event.name']) ?? String(plain(r.body) ?? 'event').replace(/^claude_code\./, '');
            const at = typeof a['event.timestamp'] === 'string' ? Date.parse(a['event.timestamp']) : ms(r.timeUnixNano);
            insert.run({
              time_ms: Number.isNaN(at) ? 0 : at,
              name,
              trace_id: r.traceId || null,
              span_id: r.spanId || null,
              session_id: str(a['session.id']),
              agent_kind: str(a['elfoqsy.agent_kind']),
              run_id: str(a['elfoqsy.run_id']),
              ticket: str(a['elfoqsy.ticket']),
              agent_number: num(a['elfoqsy.agent_number']),
              conversation_id: str(a['elfoqsy.conversation_id']),
              tool_name: str(a.tool_name),
              tool_use_id: str(a.tool_use_id),
              success: bool(a.success),
              cost_usd: num(a.cost_usd),
              attrs: JSON.stringify(redactDeep(a)),
            });
            n++;
          }
        }
      }
    });
    tx();
    return n;
  }

  upsertOutcome(o: Outcome, now: number): void {
    const was = this.db.prepare('SELECT * FROM run_outcomes WHERE run_id = ?').get(o.runId) as Record<string, unknown> | undefined;
    const pick = <T>(v: T | undefined, key: string): T | null => (v !== undefined ? v : ((was?.[key] as T) ?? null));
    this.db
      .prepare('INSERT OR REPLACE INTO run_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.runId, pick(o.ticket, 'ticket'), pick(o.agentKind, 'agent_kind'), pick(o.agentNumber, 'agent_number'), pick(o.endState, 'end_state'), pick(o.verdict, 'verdict'), pick(o.prState, 'pr_state'), pick(o.reviewRounds, 'review_rounds'), o.reopened !== undefined ? Number(o.reopened) : Number(was?.reopened ?? 0), now);
  }

  outcome(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM run_outcomes WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  }

  /** What the spans say of these tool calls (by tool_use_id): the full command, whether it failed, its class, how long. */
  toolCalls(toolUseIds: string[]): Map<string, ToolCallFacts> {
    const out = new Map<string, ToolCallFacts>();
    if (!toolUseIds.length) return out;
    const stmt = this.db.prepare('SELECT command, failed, error_class, duration_ms FROM tool_calls WHERE tool_use_id = ? LIMIT 1');
    for (const id of toolUseIds) {
      const r = stmt.get(id) as { command: string | null; failed: number; error_class: string | null; duration_ms: number } | undefined;
      if (r) out.set(id, { command: r.command, failed: !!r.failed, errorClass: r.error_class, ms: r.duration_ms });
    }
    return out;
  }

  /**
   * What a use cost, from its Skill call (by tool_use_id) to the call that ended it (or the end of its session; in her
   * conversation, of its turn): model tokens (input, output, cache writes) and cache reads, time, tool calls and failed ones.
   */
  useCost(fromToolUseId: string, untilToolUseId?: string): UseCost | undefined {
    const from = this.db.prepare("SELECT session_id, agent_kind, start_ms FROM spans WHERE tool_use_id = ? AND name = 'claude_code.tool'").get(fromToolUseId) as
      | { session_id: string; agent_kind: string; start_ms: number }
      | undefined;
    if (!from) return undefined;
    const until = untilToolUseId ? (this.db.prepare("SELECT start_ms FROM spans WHERE tool_use_id = ? AND name = 'claude_code.tool'").get(untilToolUseId) as { start_ms: number } | undefined) : undefined;
    // In her conversation, a use ends with its turn at the latest (turnAt: the trace is not always the turn).
    const turn = from.agent_kind === 'conversation' ? this.turnAt(from.session_id, from.start_ms) : { from: 0, to: Number.MAX_SAFE_INTEGER };
    const scope = 'session_id = @session AND start_ms < @turnEnd';
    const bound = { session: from.session_id, turnEnd: turn.to };
    const end = until?.start_ms ?? ((this.db.prepare(`SELECT max(end_ms) AS e FROM spans WHERE ${scope}`).get(bound) as { e: number | null }).e ?? from.start_ms);
    const r = this.db
      .prepare(
        `SELECT coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0) + coalesce(sum(cache_creation_tokens), 0) AS tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read,
                sum(CASE WHEN name = 'claude_code.tool' THEN 1 ELSE 0 END) AS calls,
                sum(CASE WHEN name = 'claude_code.tool.execution' AND status = 'error' THEN 1 ELSE 0 END) AS failed
         FROM spans WHERE ${scope} AND start_ms >= @from AND start_ms < @end`,
      )
      // Up to the call that ended it, not that call; to the end of the session (or turn), everything.
      .get({ ...bound, from: from.start_ms, end: until ? end : end + 1 }) as { tokens: number; cache_read: number; calls: number; failed: number };
    return { tokens: r.tokens, cacheRead: r.cache_read, ms: Math.max(0, end - from.start_ms), calls: Math.max(0, (r.calls ?? 0) - 1), failed: r.failed ?? 0 };
  }

  runSummary(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM run_summary WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  }

  /**
   * Failures that keep coming back, from the spans: failed tool executions since a moment, grouped by tool, the kind of
   * call and the class of error; those seen at least `minCount` times in at least `minSessions` sessions, most first.
   */
  recurringFailures(sinceMs: number, minCount = 3, minSessions = 2): RecurringFailure[] {
    const rows = this.db.prepare('SELECT session_id, run_id, tool_name, command, error_class FROM tool_calls WHERE failed = 1 AND start_ms >= ?').all(sinceMs) as Array<{
      session_id: string | null;
      run_id: string | null;
      tool_name: string | null;
      command: string | null;
      error_class: string | null;
    }>;
    const groups = new Map<string, RecurringFailure & { sessionSet: Set<string>; runSet: Set<string> }>();
    for (const r of rows) {
      const tool = r.tool_name ?? 'tool';
      const sig = signature({ tool: tool === 'Bash' ? 'Bash' : tool, text: r.command ?? '' });
      const key = `${sig}|${r.error_class ?? ''}`;
      const g = groups.get(key) ?? { tool, signature: sig, errorClass: r.error_class, count: 0, sessions: 0, runs: [], examples: [], sessionSet: new Set(), runSet: new Set() };
      g.count++;
      if (r.session_id) g.sessionSet.add(r.session_id);
      if (r.run_id) g.runSet.add(r.run_id);
      if (r.command && g.examples.length < 4 && !g.examples.includes(r.command)) g.examples.push(r.command.slice(0, 300));
      groups.set(key, g);
    }
    return [...groups.values()]
      .map(({ sessionSet, runSet, ...g }) => ({ ...g, sessions: sessionSet.size, runs: [...runSet] }))
      .filter((g) => g.count >= minCount && g.sessions >= minSessions)
      .sort((a, b) => b.count - a.count);
  }

  /** Read-only SQL, for the CLI: what a few weeks of runs say, before a dashboard is designed. */
  query(sql: string, params: unknown[] = []): unknown[] {
    const stmt = this.db.prepare(sql);
    if (!stmt.reader) throw new Error('Only queries that read.');
    return stmt.all(...params);
  }

  /** Spans and events older than this are dropped. */
  prune(beforeMs: number): void {
    this.db.prepare('DELETE FROM spans WHERE end_ms < ?').run(beforeMs);
    this.db.prepare('DELETE FROM events WHERE time_ms < ?').run(beforeMs);
  }

  close(): void {
    this.db.close();
  }
}
