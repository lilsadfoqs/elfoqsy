// What every Claude session of Elfoqsy's exports, and where: the Claude Code binary's own
// OpenTelemetry (traces, beta, and its log events; Claude Code 2.1.295), over OTLP http/json to the daemon's receiver on
// 127.0.0.1 (receiver.ts), never anywhere else. Content (prompts, tool input, tool output) is turned on, capped, and goes
// through the redactor before it is stored (store.ts). Each session's resource attributes say whose spans they are: run
// id, ticket, agent kind and number, conversation. Off until the daemon's receiver is listening (tests, the CLI).
//
// From the docs (code.claude.com/docs/en/agent-sdk/observability, /monitoring-usage): the SDK passes env to the CLI, which
// exports; TypeScript's env replaces the environment, so these go into each session's env.

let endpoint: string | undefined;

/** The receiver's address, once it listens; undefined turns export off. */
export function setTelemetryEndpoint(url: string | undefined): void {
  endpoint = url;
}

export const telemetryEndpoint = (): string | undefined => endpoint;

export type AgentKind = 'ticket' | 'task' | 'subagent' | 'investigator' | 'conversation' | 'responder' | 'study' | 'exam' | 'probe' | 'abilities';

export interface SessionTags {
  kind: AgentKind;
  /** A run's id, an investigation's, an exam's or a study step's: the id the outcomes and the log use. */
  runId?: string;
  ticket?: string;
  agentNumber?: number;
  conversationId?: string;
}

/** Tool output and prompts are cut at this many characters before export (CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH). */
export const CONTENT_MAX = 4000;

/** A resource attribute value: no spaces, commas or equals signs (percent-encoded, as the docs say). */
const value = (v: string | number): string => encodeURIComponent(String(v));

/** The resource attributes for a session, as OTEL_RESOURCE_ATTRIBUTES. */
export function resourceAttributes(t: SessionTags): string {
  const pairs: Array<[string, string | number | undefined]> = [
    ['elfoqsy.agent_kind', t.kind],
    ['elfoqsy.run_id', t.runId],
    ['elfoqsy.ticket', t.ticket],
    ['elfoqsy.agent_number', t.agentNumber],
    ['elfoqsy.conversation_id', t.conversationId],
  ];
  return pairs
    .filter((p): p is [string, string | number] => p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => `${k}=${value(v)}`)
    .join(',');
}

/** The environment that turns a session's export on, tagged; empty while the receiver is not listening. */
export function telemetryEnv(t: SessionTags): Record<string, string> {
  if (!endpoint) return {};
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    // The token and cost counters are in the spans and the api_request events already.
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_TRACES_EXPORT_INTERVAL: '2000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: String(CONTENT_MAX),
    OTEL_SERVICE_NAME: `elfoqsy-${t.kind}`,
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes(t),
  };
}
