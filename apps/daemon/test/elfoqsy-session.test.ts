import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Clock } from '../src/clock';
import { UsageState } from '../src/claude/usage';
import { ElfoqsySession, PROTOCOL, QUIET, sessionOptions, stateDigest, type QueryFn } from '../src/elfoqsy/session';
import { ALLOWED_TOOLS, type SessionContext } from '../src/elfoqsy/tools';
import { LiveState } from '../src/elfoqsy/liveState';
import { EventLog } from '../src/eventLog';

/** A stand-in for the SDK's query(): records what it is given and yields what the test emits. */
function fakeSdk() {
  const sessions: Array<{ options: unknown; sent: string[]; emit: (...m: SDKMessage[]) => void; end: () => void }> = [];
  const interrupt = vi.fn(async () => undefined);
  const queryFn = vi.fn((params: Parameters<QueryFn>[0]) => {
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const session = {
      options: params.options,
      sent: [] as string[],
      emit: (...m: SDKMessage[]) => {
        queue.push(...m);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
    };
    sessions.push(session);
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

const tick = () => new Promise((r) => setTimeout(r, 0));

class ManualClock implements Clock {
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

const text = (t: string): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
const toolUse = (): SDKMessage =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__orchestrator__list_sprint', input: {} }] },
    uuid: 'u',
    session_id: 's',
  }) as unknown as SDKMessage;
const result = (): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, result: '' }) as unknown as SDKMessage;
const rateLimit = (status: 'rejected' | 'allowed_warning', resetsAt?: number): SDKMessage =>
  ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour' }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
const apiRetry = (): SDKMessage =>
  ({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit', uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
const authFailed = (): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;

const T0 = Date.parse('2026-10-09T14:00:00Z');
let log: EventLog;
let live: LiveState;
let sdk: ReturnType<typeof fakeSdk>;
let clock: ManualClock;
let session: ElfoqsySession;
let usage: UsageState;
let context: SessionContext | undefined;

const messages = () => log.readFrom(0, 10_000, ['elfoqsy.message']).map((e) => (e.type === 'elfoqsy.message' ? e : null)!);
const limits = () => log.readFrom(0, 10_000, ['usage.limit']).map((e) => e.payload);
const streamEvent = (event: unknown): SDKMessage => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;

function makeSession(conversationId = 'c1') {
  return new ElfoqsySession({
    conversationId,
    log,
    usage,
    state: () => live.get(),
    systemPrompt: 'You are Elfoqsy.',
    mcpServer: (ctx) => {
      context = ctx;
      return { type: 'sdk', name: 'orchestrator', instance: {} } as never;
    },
    cwd: '/data/elfoqsy',
    env: { HOME: '/home/x', PATH: '/usr/bin' },
    model: 'claude-opus-5-5',
    effort: 'medium',
    ticketKey: /\b(?:SHOP|CORE)-\d+\b/i,
    queryFn: sdk.queryFn,
    clock,
    now: () => clock.now,
  });
}

beforeEach(() => {
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  live = new LiveState(log);
  sdk = fakeSdk();
  usage = new UsageState(log, clock, () => clock.now);
  log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164' });
  session = makeSession();
});

afterEach(() => {
  session.close();
  usage.close();
  live.close();
  log.close();
});

/** What the daemon does when he types: the message is logged in its conversation, then handed to her. */
function heSays(t: string, conversationId = 'c1', s = session) {
  log.append('orchestrator', 'elfoqsy.message', { messageId: `m${Math.random()}`, role: 'you', text: t, conversationId });
  s.say(t);
}
/** The text after the session's opening context: what was typed. */
const typed = (sent: string) => sent.slice(sent.lastIndexOf('\n\n') + 2);

describe('session options', () => {
  it('isolate the session from his own Claude Code, allow only the orchestrator tools, and watch the stream', () => {
    const o = sessionOptions({ systemPrompt: 'P', mcpServer: {} as never, cwd: '/c', env: { HOME: '/h' } });
    expect(o).toEqual({
      systemPrompt: `P${PROTOCOL}`,
      tools: [],
      mcpServers: { orchestrator: {} },
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'dontAsk',
      settingSources: [],
      skills: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { autoMemoryEnabled: false },
      cwd: '/c',
      env: { HOME: '/h' },
    });
    const pinned = sessionOptions({ systemPrompt: 'P', mcpServer: {} as never, cwd: '/c', env: {}, model: 'claude-opus-5-5', effort: 'medium' });
    expect(pinned).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
  });
});

describe('her skill uses', () => {
  const said = (content: unknown[]): SDKMessage => ({ type: 'assistant', parent_tool_use_id: null, message: { content }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
  const answered = (id: string, isError: boolean): SDKMessage => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] }, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;

  it('hand each turn with tool calls to the engine: its calls in order, which failed, and whether her reply asked him', async () => {
    const uses: unknown[] = [];
    const s = new ElfoqsySession({
      conversationId: 'c1',
      log,
      usage,
      state: () => live.get(),
      systemPrompt: 'You are Elfoqsy.',
      mcpServer: () => ({ type: 'sdk', name: 'orchestrator', instance: {} }) as never,
      cwd: '/data/elfoqsy',
      env: {},
      ticketKey: /\bSHOP-\d+\b/i,
      queryFn: sdk.queryFn,
      clock,
      now: () => clock.now,
      abilityUses: (u) => uses.push(u),
    });
    heSays('Why does request-handler restart on staging?', 'c1', s);
    await tick();
    sdk.sessions[0]!.emit(
      said([
        { type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'abilities:find-service-pod' } },
        { type: 'tool_use', id: 'b', name: 'mcp__orchestrator__kube', input: { args: ['--context', 'staging', 'get', 'pods'] } },
      ]),
      answered('a', false),
      answered('b', true),
      said([{ type: 'text', text: 'Its pod restarted 3 times.\n\nShould I read the logs of the one before?' }]),
      result(),
    );
    await tick();
    expect(uses).toEqual([
      {
        in: 'conversation',
        id: 'c1',
        calls: [
          { tool: 'Skill', text: '{"skill":"abilities:find-service-pod"}', failed: false, toolUseId: 'a', skill: 'find-service-pod' },
          { tool: 'mcp__orchestrator__kube', text: '--context staging get pods', failed: true, toolUseId: 'b' },
        ],
        askedHim: true,
      },
    ]);
    // A turn with no tool call hands nothing over.
    heSays('Thanks.', 'c1', s);
    await tick();
    sdk.sessions[0]!.emit(said([{ type: 'text', text: 'You are welcome.' }]), result());
    await tick();
    expect(uses).toHaveLength(1);
    // A turn of reads that loaded no skill is handed over too: the engine sees the missed uses in it.
    heSays('And on dev?', 'c1', s);
    await tick();
    sdk.sessions[0]!.emit(said([{ type: 'tool_use', id: 'c', name: 'mcp__orchestrator__kube', input: { args: ['--context', 'dev', 'get', 'pods'] } }]), answered('c', false), said([{ type: 'text', text: 'All running.' }]), result());
    await tick();
    expect(uses.at(-1)).toEqual({ in: 'conversation', id: 'c1', calls: [{ tool: 'mcp__orchestrator__kube', text: '--context dev get pods', failed: false, toolUseId: 'c' }], askedHim: false });
  });
});

describe('a conversation’s session', () => {
  it('starts only when needed, opens with the workspace’s context, and sends what he typed, redacted', async () => {
    expect(sdk.queryFn).not.toHaveBeenCalled();
    const key = Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(i * 7 + 1) % 16]).join('');
    heSays(`what is blocked? apikey: ${key}`);
    await tick();
    expect(sdk.queryFn).toHaveBeenCalledTimes(1);
    const first = sdk.sessions[0]!.sent[0]!;
    expect(first).toMatch(/^\[Context for this conversation, from the workspace\]\nThis conversation: "Plan the SHOP-1164 stall fix", about SHOP-1164\./);
    expect(first).toContain('Sprint: 0 open tickets.');
    expect(first).toContain('What you remember: nothing yet.');
    expect(typed(first)).toBe('what is blocked? apikey: [redacted secret]');
    expect(sdk.sessions[0]!.options).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
  });

  it('turns what she says after her last tool call into one message in its conversation, with the tickets it names', async () => {
    heSays('what is blocked?');
    await tick();
    sdk.sessions[0]!.emit(text('Let me check.'), toolUse(), text('SHOP-3049 is blocked.'), text("It's Critical; shop-3546 is next."), result());
    await tick();
    const replies = messages().filter((m) => m.payload.role === 'elfoqsy');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      source: 'elfoqsy',
      payload: { conversationId: 'c1', text: "SHOP-3049 is blocked.\n\nIt's Critical; shop-3546 is next.", refs: { tickets: ['SHOP-3049', 'SHOP-3546'] } },
    });
  });

  it('puts the blocks she chose with show under her reply', async () => {
    heSays('show me the ticket');
    await tick();
    context!.addBlocks([{ type: 'ticket', ref: 'SHOP-1164' }]);
    sdk.sessions[0]!.emit(text('Here it is.'), result());
    await tick();
    expect(messages().at(-1)!.payload).toMatchObject({ text: 'Here it is.', blocks: [{ type: 'ticket', ref: 'SHOP-1164' }] });
  });

  it('stays silent when she answers a workspace update with (quiet)', async () => {
    session.notify(['SHOP-1 is now Blocked. It is Minor.']);
    await tick();
    expect(typed(sdk.sessions[0]!.sent[0]!)).toBe('[Workspace update]\n- SHOP-1 is now Blocked. It is Minor.'.split('\n\n').at(-1));
    expect(sdk.sessions[0]!.sent[0]).toContain('[Workspace update]\n- SHOP-1 is now Blocked. It is Minor.');
    sdk.sessions[0]!.emit(text(QUIET), result());
    await tick();
    expect(messages()).toEqual([]);
  });

  it('starts again with this conversation so far, and not the others', async () => {
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'other', role: 'you', text: 'about something else', conversationId: 'c2' });
    heSays('hello');
    await tick();
    sdk.sessions[0]!.emit(text('Hello.'), result());
    await tick();
    sdk.sessions[0]!.end();
    await tick();
    heSays('what next?');
    await tick();
    expect(sdk.queryFn).toHaveBeenCalledTimes(2);
    const first = sdk.sessions[1]!.sent[0]!;
    expect(first).toContain('Earlier in this conversation:\nalex: hello\nElfoqsy: Hello.');
    expect(first).not.toContain('about something else');
    expect(typed(first)).toBe('what next?');
  });

  it('starts with what she remembers, the ticket’s facts first, stale ones marked', async () => {
    log.append('orchestrator', 'memory.saved', { factId: 'f1', statement: 'Releases are cut on Thursdays.', sources: [{ kind: 'doc', ref: 'Release process' }], freshUntil: new Date(T0 + 86_400_000).toISOString(), origin: 'lookup' });
    log.append('orchestrator', 'memory.saved', { factId: 'f2', statement: 'SHOP-1164: cached steps never start the Redis timeout.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }], freshUntil: new Date(T0 - 1).toISOString(), origin: 'investigator' });
    heSays('remind me');
    await tick();
    const first = sdk.sessions[0]!.sent[0]!;
    const facts = first.slice(first.indexOf('What you remember:'));
    expect(facts.indexOf('SHOP-1164: cached steps')).toBeLessThan(facts.indexOf('Releases are cut'));
    expect(first).toContain('(shop-worker/src/export/cache.ts:58; from investigator, 2026-10-09; stale, re-check)');
  });

  it('marks the tester’s messages as not his, and tells her tools who wrote last', async () => {
    log.append('orchestrator', 'elfoqsy.message', { messageId: 'old', role: 'you', text: 'Cancel the run on SHOP-3546.', conversationId: 'c1' });
    log.append('orchestrator', 'elfoqsy.message_marked', { messageId: 'old', role: 'test', note: 'Typed by Claude Code.' });
    log.append('orchestrator', 'elfoqsy.message', { messageId: 't1', role: 'test', text: 'start an agent on SHOP-3546', conversationId: 'c1' });
    session.say('start an agent on SHOP-3546', 'tester');
    await tick();
    const first = sdk.sessions[0]!.sent[0]!;
    expect(first).toContain('Earlier in this conversation:\nThe tester: Cancel the run on SHOP-3546.');
    expect(typed(first)).toBe('[From the tester] start an agent on SHOP-3546');
    expect(context!.speaker()).toBe('tester');
    expect((sdk.sessions[0]!.options as { systemPrompt: string }).systemPrompt).toContain('call their sender "the tester", never "you" and never alex');
  });

  it('sends attachments after the text, as content blocks', async () => {
    session.say('here is the freeze', 'owner', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    await tick();
    expect(sdk.sessions[0]!.sent[0]).toMatch(/here is the freeze\n\[image\]$/);
  });

  it('digests the live state in a few lines', () => {
    expect(stateDigest(live.get())).toBe('Sprint: 0 open tickets.\nAgents: none running.');
  });

  it('does not end a pause on his behalf when a test message arrives', async () => {
    heSays('hi');
    await tick();
    sdk.sessions[0]!.emit(apiRetry());
    await tick();
    session.say('are you there?', 'tester');
    await tick();
    expect(limits().at(-1)).toMatchObject({ state: 'limited' });
    heSays('try again');
    await tick();
    expect(sdk.sessions[0]!.sent.slice(1)).toEqual(['[From the tester] are you there?', 'try again']);
  });

  it('pauses at a usage limit: interrupts, says so once, holds new work, and resumes once at the reset time', async () => {
    heSays('what is blocked?');
    await tick();
    const resetsAt = Math.floor((T0 + 3 * 3600_000) / 1000); // seconds, as the API sends it
    sdk.sessions[0]!.emit(rateLimit('allowed_warning', resetsAt), rateLimit('rejected', resetsAt), rateLimit('rejected', resetsAt));
    await tick();
    expect(sdk.interrupt).toHaveBeenCalledTimes(1);
    expect(limits()).toEqual([
      { state: 'limited', since: new Date(T0).toISOString(), until: new Date(resetsAt * 1000).toISOString(), reason: 'five_hour' },
    ]);
    const said = messages().filter((m) => m.payload.role === 'elfoqsy');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ source: 'orchestrator', payload: { text: expect.stringMatching(/^I've hit the Claude usage limit\. I'll pick up again at \d\d:\d\d\.$/) } });

    heSays('are you there?');
    session.notify(['CI failed on o/r #7 (SHOP-3546).']);
    await tick();
    expect(sdk.sessions[0]!.sent).toHaveLength(1); // held, not sent

    clock.advance(3 * 3600_000 + 30_000);
    await tick();
    expect(limits().at(-1)).toMatchObject({ state: 'ok' });
    expect(sdk.sessions[0]!.sent.slice(1)).toEqual(['are you there?', '[Workspace update]\n- CI failed on o/r #7 (SHOP-3546).']);
  });

  it('stops the CLI’s own retry loop at the first rate-limit retry, and waits for him when the reset time is unknown', async () => {
    heSays('hi');
    await tick();
    sdk.sessions[0]!.emit(apiRetry(), apiRetry());
    await tick();
    expect(sdk.interrupt).toHaveBeenCalledTimes(1);
    expect(limits()).toEqual([{ state: 'limited', since: new Date(T0).toISOString(), reason: 'rate_limit' }]);
    expect(messages().at(-1)!.payload.text).toBe("I've hit the Claude usage limit. I'll stay paused until you write to me.");
    expect(clock.timers).toEqual([]); // nothing retries by itself

    heSays('try again');
    await tick();
    expect(limits().at(-1)).toMatchObject({ state: 'ok' });
    expect(sdk.sessions[0]!.sent.at(-1)).toBe('try again');
  });

  it('asks him to log in again when the login fails', async () => {
    heSays('hi');
    await tick();
    sdk.sessions[0]!.emit(authFailed());
    await tick();
    expect(limits()[0]).toMatchObject({ state: 'limited', reason: 'login' });
    expect(messages().at(-1)!.payload.text).toBe('My Claude login stopped working. Run `claude auth login`, then write to me.');
  });

  it('keeps a pause from before a restart', async () => {
    usage.restore({ state: 'limited', until: T0 + 60_000, reason: 'five_hour' });
    session.notify(['x']);
    await tick();
    expect(sdk.queryFn).not.toHaveBeenCalled();
    clock.advance(90_000);
    await tick();
    expect(sdk.queryFn).toHaveBeenCalledTimes(1);
  });
});
