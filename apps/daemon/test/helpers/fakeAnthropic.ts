// A stand-in for the Anthropic Messages API, for the real Claude Code binary the Agent SDK starts: it answers every
// request with what a script says (text, or tool calls such as a Bash command), streamed as the API streams it. No
// model is involved and nothing leaves the machine, so a test can run the real SDK sandbox, with the real settings,
// against commands of its own. The script sees each request (its model, system prompt and messages) and what the
// tools returned so far.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ApiBlock {
  type: string;
  [key: string]: unknown;
}

export interface ApiRequest {
  path: string;
  model: string;
  /** The system prompt as one string. */
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | ApiBlock[] }>;
  tools: string[];
}

export type Reply = Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }>;

/** What a script decides for one request: the reply to stream. */
export type Script = (request: ApiRequest) => Reply;

/** The text of every tool_result the request carries, by the id of the tool call it answers. */
export function toolResults(request: ApiRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of request.messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as ApiBlock[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join('\n') : '';
      out.set(String(b.tool_use_id), text);
    }
  }
  return out;
}

/** The ids of the tool calls the assistant made in this conversation, oldest first. */
export const toolCalls = (request: ApiRequest): Array<{ id: string; name: string; input: Record<string, unknown> }> =>
  request.messages.flatMap((m) =>
    m.role === 'assistant' && typeof m.content !== 'string'
      ? m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }))
      : [],
  );

export interface FakeAnthropic {
  url: string;
  requests: ApiRequest[];
  close(): Promise<void>;
}

const sse = (res: ServerResponse, event: string, data: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

let counter = 0;

function stream(res: ServerResponse, model: string, reply: Reply): void {
  const id = `msg_fake_${++counter}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_fake_${counter}` });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  let index = 0;
  for (const block of reply) {
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fake_${++counter}`, name: block.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  const calls = reply.some((b) => b.type === 'tool_use');
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

export async function fakeAnthropic(script: Script): Promise<FakeAnthropic> {
  const requests: ApiRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const body = await readBody(req);
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return json(res, 200, { input_tokens: 100 });
      if (req.method === 'POST' && path === '/v1/messages') {
        const b = JSON.parse(body || '{}') as { model?: string; system?: unknown; messages?: ApiRequest['messages']; tools?: Array<{ name: string }>; stream?: boolean };
        const system = typeof b.system === 'string' ? b.system : Array.isArray(b.system) ? (b.system as ApiBlock[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join('\n') : '';
        const request: ApiRequest = { path, model: b.model ?? '', system, messages: b.messages ?? [], tools: (b.tools ?? []).map((t) => t.name) };
        requests.push(request);
        const reply = script(request);
        if (b.stream) return stream(res, request.model, reply);
        const calls = reply.some((x) => x.type === 'tool_use');
        return json(res, 200, {
          id: `msg_fake_${++counter}`,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: reply.map((x) => (x.type === 'text' ? x : { type: 'tool_use', id: `toolu_fake_${++counter}`, name: x.name, input: x.input })),
          stop_reason: calls ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        });
      }
      json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no ${req.method} ${path}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
