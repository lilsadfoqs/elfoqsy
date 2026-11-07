// A stand-in for the Agent SDK's query(): records what it is given and yields what the test emits.
import { vi } from 'vitest';
import type { McpSdkServerConfigWithInstance, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Clock } from '../../src/clock';
import type { QueryFn } from '../../src/elfoqsy/session';

export interface FakeSession {
  options: Options;
  sent: string[];
  emit: (...m: SDKMessage[]) => void;
  end: () => void;
  /** Closed by its owner, or ended by the test. */
  ended: boolean;
}

export function fakeSdk() {
  const sessions: FakeSession[] = [];
  const interrupt = vi.fn(async () => undefined);
  const queryFn = vi.fn((params: Parameters<QueryFn>[0]) => {
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const session: FakeSession = {
      options: params.options ?? {},
      sent: [],
      ended: false,
      emit: (...m) => {
        queue.push(...m);
        wake?.();
      },
      end: () => {
        done = true;
        session.ended = true;
        wake?.();
      },
    };
    sessions.push(session);
    // A string prompt is one turn; a stream of user messages may carry text and image or document blocks.
    if (typeof params.prompt === 'string') session.sent.push(params.prompt);
    else
      void (async () => {
        for await (const m of params.prompt as AsyncIterable<{ message: { content: string | Array<{ type: string; text?: string }> } }>) {
          const c = m.message.content;
          session.sent.push(typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'));
        }
      })();
    const gen = (async function* () {
      while (true) {
        if (queue.length) yield queue.shift()!;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    })();
    return Object.assign(gen, { interrupt, close: session.end }) as unknown as Query;
  }) as unknown as QueryFn & ReturnType<typeof vi.fn>;
  return { queryFn, sessions, interrupt };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export class ManualClock implements Clock {
  timers: Array<{ fn: () => void; at: number; id: number }> = [];
  private id = 0;
  constructor(public now: number) {}
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.push({ fn, at: this.now + ms, id: ++this.id });
    return this.id;
  }
  clearTimeout(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((t) => t.at <= this.now);
    this.timers = this.timers.filter((t) => t.at > this.now);
    due.forEach((t) => t.fn());
  }
}

export const text = (t: string): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;

/** An assistant message with its id and usage, and tool calls when given (2026-10-20: the exam measures what a session spent). */
export const said = (id: string, t: string, usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }, tools: Array<{ name: string; input: unknown }> = []): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { id, usage, content: [{ type: 'text', text: t }, ...tools.map((x, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: x.name, input: x.input }))] }, uuid: id, session_id: 's' }) as unknown as SDKMessage;

export const result = (
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens?: number }> = {},
  extra: { num_turns?: number; total_cost_usd?: number } = {},
): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, result: '', modelUsage, errors: [], ...extra }) as unknown as SDKMessage;

/** How a turn ends when it is interrupted, as the live SDK ended one in probe 3 of milestone 12. */
export const cutShort = (): SDKMessage =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, modelUsage: {}, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'] }) as unknown as SDKMessage;

export const rateLimit = (status: 'rejected' | 'allowed_warning', resetsAt?: number): SDKMessage =>
  ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour' }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;

/** Calls one of a session's own MCP tools (report_result, report_findings, ...) through a real MCP client. */
const clients = new WeakMap<object, Promise<Client>>();
function clientOf(options: Options, serverName: string): Promise<Client> {
  const server = (options.mcpServers![serverName] as McpSdkServerConfigWithInstance).instance;
  let client = clients.get(server);
  if (!client) {
    client = (async () => {
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(clientSide);
      return c;
    })();
    clients.set(server, client);
  }
  return client;
}

/** A session's own MCP tools as the model is given them: names, descriptions and input schemas. */
export async function listTools(options: Options, serverName = 'run') {
  return (await (await clientOf(options, serverName)).listTools()).tools;
}

export async function runTool(options: Options, name: string, args: Record<string, unknown>, serverName = 'run'): Promise<string> {
  const client = clientOf(options, serverName);
  const result = (await (await client).callTool({ name, arguments: args })) as { content: Array<{ text?: string }> };
  return result.content.map((c) => c.text ?? '').join('');
}
