// Elfoqsy's own web (alex, 19 October): WebSearch and WebFetch in her conversation session, read-only, behind the check the agents'
// web has (nothing of his may leave in the request: a secret, one of his hosts, a repository or local path, code, encoded data; for a fetch,
// the host's addresses too), and every call an action in the log. The hooks on their own, then the real Claude Code binary with her real
// options against a fake API: what she is offered, and what a refused request does (nothing leaves, and the model is told why). No model is called.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSdkMcpServer, query, type HookCallback, type HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { EventLog } from '../src/eventLog';
import { ElfoqsySession, sessionOptions } from '../src/elfoqsy/session';
import { WEB_TOOLS, herWebHooks } from '../src/elfoqsy/web';
import { ALLOWED_TOOLS } from '../src/elfoqsy/tools';
import { LiveState } from '../src/elfoqsy/liveState';
import { UsageState } from '../src/claude/usage';
import type { OutboundContext } from '../src/redact';
import { fakeAnthropic, toolResults, type ApiRequest, type Reply } from './helpers/fakeAnthropic';
import { ManualClock, fakeSdk, tick } from './helpers/fakeSdk';

const outbound: OutboundContext = {
  internalHosts: ['acme.atlassian.net', 'api.us1.coralogix.com'],
  repos: ['acme/shop-api'],
  localRoots: ['/home/alex', '/foqs/elfoqsy'],
  inClones: (path) => path === 'src/map.ts',
  resolve: async (host) => (host === 'sneaky.example.org' ? ['10.0.0.5'] : ['93.184.216.34']),
};

let log: EventLog;
beforeEach(() => {
  log = new EventLog(':memory:');
});
afterEach(() => log.close());

const payloads = <T extends EventType>(type: T) => log.readFrom(0, 100_000, [type]).map((e: AnyEnvelope) => e.payload as PayloadOf<T>);
const hooksOf = () => herWebHooks({ log, outbound });
const run = (hooks: ReturnType<typeof hooksOf>, event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', input: Record<string, unknown>) => {
  const callback = (hooks[event] as Array<{ hooks: HookCallback[] }>)[0]!.hooks[0]!;
  return callback({ hook_event_name: event, session_id: 's', transcript_path: '', cwd: '/', ...input } as unknown as HookInput, undefined, { signal: new AbortController().signal });
};
const before = (hooks: ReturnType<typeof hooksOf>, tool_name: string, tool_input: Record<string, unknown>, tool_use_id = 'tu-1') =>
  run(hooks, 'PreToolUse', { tool_name, tool_input, tool_use_id }) as Promise<{ hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }>;

describe('her web hooks', () => {
  it('let a clean search and fetch through, and log each as an action of hers: tier 0, a read of the public web', async () => {
    const hooks = hooksOf();
    expect((await before(hooks, 'WebSearch', { query: 'best violinists 2026' }, 'tu-1')).hookSpecificOutput.permissionDecision).toBe('allow');
    expect((await before(hooks, 'WebFetch', { url: 'https://www.lcfc.com/teams/first-team', prompt: 'list the players' }, 'tu-2')).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(payloads('action.classified')).toEqual([
      { actionId: expect.any(String), runId: 'elfoqsy', toolUseId: 'tu-1', proxy: 'web', kind: 'web.search', tier: 0, summary: 'search the web for "best violinists 2026"', decision: 'run', reason: 'A read of the public web, with nothing of his in the request.' },
      { actionId: expect.any(String), runId: 'elfoqsy', toolUseId: 'tu-2', proxy: 'web', kind: 'web.fetch', tier: 0, summary: 'fetch https://www.lcfc.com/teams/first-team', decision: 'run', reason: 'A read of the public web, with nothing of his in the request.' },
    ]);
  });

  it('log how each ended, redacted: what came back, or why it failed', async () => {
    const hooks = hooksOf();
    await before(hooks, 'WebSearch', { query: 'best violinists' }, 'tu-1');
    await before(hooks, 'WebFetch', { url: 'https://example.org/a', prompt: 'x' }, 'tu-2');
    await run(hooks, 'PostToolUse', { tool_name: 'WebSearch', tool_input: {}, tool_use_id: 'tu-1', tool_response: 'Hilary Hahn, Ray Chen. A key AKIAIOSFODNN7EXAMPLE was in the page.' });
    await run(hooks, 'PostToolUseFailure', { tool_name: 'WebFetch', tool_input: {}, tool_use_id: 'tu-2', error: 'HTTP 503' });
    const [search, fetch] = payloads('action.classified');
    const ended = payloads('action.finished');
    expect(ended).toEqual([
      { actionId: search!.actionId, runId: 'elfoqsy', ok: true, outputSummary: expect.stringContaining('Hilary Hahn, Ray Chen.'), durationMs: expect.any(Number) },
      { actionId: fetch!.actionId, runId: 'elfoqsy', ok: false, outputSummary: 'HTTP 503', durationMs: expect.any(Number) },
    ]);
    expect(ended[0]!.outputSummary).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it.each([
    ['a repository of his in a query', 'WebSearch', { query: 'shop-api deployment status' }, 'repo_path'],
    ['a secret in a query', 'WebSearch', { query: 'what is AKIAIOSFODNN7EXAMPLE' }, 'secret'],
    ['code in a query', 'WebSearch', { query: 'if (x) { return y; } const z = a.b(c);' }, 'code'],
    ['one of his hosts, fetched', 'WebFetch', { url: 'https://acme.atlassian.net/browse/SHOP-1', prompt: 'x' }, 'internal_host'],
    ['an address, fetched', 'WebFetch', { url: 'http://127.0.0.1:4317/', prompt: 'x' }, 'internal_host'],
    ['a name that points at a private address, fetched', 'WebFetch', { url: 'https://sneaky.example.org/a', prompt: 'x' }, 'internal_host'],
    ['a local file, fetched', 'WebFetch', { url: 'file:///home/alex/.ssh/id_ed25519', prompt: 'x' }, 'not_web'],
    ['a secret in a URL', 'WebFetch', { url: 'https://example.org/?token=AKIAIOSFODNN7EXAMPLE', prompt: 'x' }, 'secret'],
  ])('refuse %s: nothing is sent, the model is told the rule and not the text, and the refusal is logged', async (_label, tool, input, _rule) => {
    const out = await before(hooksOf(), tool, input);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/^Not sent: .* Nothing of alex's \(secrets, internal hosts, repository paths, code, encoded data\) may leave through the web\. Ask without it\.$/);
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain('shop-api');
    expect(payloads('action.classified')).toEqual([expect.objectContaining({ runId: 'elfoqsy', proxy: 'web', tier: 0, decision: 'refuse', reason: expect.any(String) })]);
    expect(payloads('action.finished')).toEqual([]);
    expect(JSON.stringify(payloads('action.classified'))).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('are about the web tools only', async () => {
    expect(await run(hooksOf(), 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'x' })).toEqual({});
    expect(payloads('action.classified')).toEqual([]);
  });
});

describe('her session options', () => {
  const server = { type: 'sdk', name: 'orchestrator', instance: {} } as never;

  it('offer the web, and allow it, only when the outgoing check is there to stand in front of it', () => {
    const without = sessionOptions({ systemPrompt: 'P', mcpServer: server, cwd: '/c', env: {} });
    expect(without.tools).toEqual([]);
    expect(without.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(without).not.toHaveProperty('hooks');
    const hooks = hooksOf();
    const withWeb = sessionOptions({ systemPrompt: 'P', mcpServer: server, cwd: '/c', env: {}, web: hooks });
    expect(withWeb.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(withWeb.tools).toEqual([...WEB_TOOLS]);
    expect(withWeb.allowedTools).toEqual([...ALLOWED_TOOLS, 'WebSearch', 'WebFetch']);
    expect(withWeb.hooks).toEqual(hooks);
    // Still no files and no shell, and still nobody is asked.
    expect(withWeb.permissionMode).toBe('dontAsk');
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task']) expect(withWeb.tools).not.toContain(tool);
  });

  it('are what a conversation session starts with when the daemon gives it the outgoing check', async () => {
    const clock = new ManualClock(Date.parse('2026-10-19T08:00:00Z'));
    const live = new LiveState(log);
    const usage = new UsageState(log, clock, () => clock.now);
    const sdk = fakeSdk();
    const make = (o: Partial<ConstructorParameters<typeof ElfoqsySession>[0]> = {}) =>
      new ElfoqsySession({ conversationId: 'c1', log, usage, state: () => live.get(), systemPrompt: 'P', mcpServer: () => server, cwd: '/c', env: {}, model: 'claude-opus-5-5', effort: 'high', ticketKey: /SHOP-\d+/, queryFn: sdk.queryFn, clock, now: () => clock.now, ...o });
    const plain = make();
    plain.say('hi');
    await tick();
    expect(sdk.sessions[0]!.options.tools).toEqual([]);
    expect(sdk.sessions[0]!.options.effort).toBe('high');
    const webbed = make({ conversationId: 'c2', outbound });
    webbed.say('hi');
    await tick();
    expect(sdk.sessions[1]!.options.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(sdk.sessions[1]!.options.allowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    expect(sdk.sessions[1]!.options.hooks).toHaveProperty('PreToolUse');
    plain.close();
    webbed.close();
    usage.close();
    live.close();
  });
});

describe('her web in the real Claude Code binary', () => {
  const base = mkdtempSync(join(tmpdir(), 'elfoqsy-web-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('is offered WebSearch and WebFetch beside her own tools and nothing else, and what the check refuses never leaves', async () => {
    // A server on this machine that a fetch of its address would reach (the tool upgrades it to https, so what it would see is a
    // connection, not a request): it must see no connection at all.
    const connections: string[] = [];
    const local = createServer((_req, res) => res.end('reached'));
    local.on('connection', (socket) => connections.push(socket.remoteAddress ?? '?'));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const port = (local.address() as AddressInfo).port;

    const offered: string[][] = [];
    const answers = new Map<string, string>();
    const reply = (req: ApiRequest): Reply => {
      offered.push(req.tools);
      const results = toolResults(req);
      if (results.size) {
        for (const [id, text] of results) answers.set(id, text);
        return [{ type: 'text', text: 'Tôi chưa gửi được, để tôi hỏi lại.' }];
      }
      return [
        { type: 'tool_use', name: 'WebFetch', input: { url: `http://127.0.0.1:${port}/leak`, prompt: 'read it' } },
        { type: 'tool_use', name: 'WebSearch', input: { query: 'shop-api deployment status' } },
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://acme.atlassian.net/browse/SHOP-1', prompt: 'read it' } },
      ];
    };
    const api = await fakeAnthropic(reply);
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 90_000);
    try {
      const options = sessionOptions({
        systemPrompt: 'You are Elfoqsy.',
        mcpServer: createSdkMcpServer({ name: 'orchestrator', version: '1', tools: [] }),
        cwd: base,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        model: 'claude-haiku-5-5',
        web: herWebHooks({ log, outbound }),
      });
      for await (const m of query({ prompt: 'nghệ sĩ violin nào đáng nghe năm nay?', options: { ...options, abortController: abort } })) {
        if (m.type === 'result') break;
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      await api.close();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }

    // What the model is offered: the two web tools, and none of the files, the shell, sub-agents.
    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) {
      expect(tools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
      for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'NotebookEdit']) expect(tools, `offered ${tool}`).not.toContain(tool);
    }
    // The three requests were each refused with the rule, and the server on this machine saw nothing.
    expect(connections).toEqual([]);
    expect([...answers.values()].length).toBe(3);
    for (const text of answers.values()) expect(text).toMatch(/Not sent: .* Ask without it\./);
    expect(payloads('action.classified').map((a) => [a.kind, a.decision])).toEqual([
      ['web.fetch', 'refuse'],
      ['web.search', 'refuse'],
      ['web.fetch', 'refuse'],
    ]);
    expect(JSON.stringify([...answers.values()])).not.toContain('shop-api');
  }, 120_000);

  // The control: the same call with the tools offered and no hook in front of them does connect, so the hook is what stops it.
  it('would reach this machine without its hook: the hook is what holds the call back', async () => {
    const connections: string[] = [];
    const local = createServer((_req, res) => res.end('reached'));
    local.on('connection', (socket) => connections.push(socket.remoteAddress ?? '?'));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const port = (local.address() as AddressInfo).port;
    const reply = (req: ApiRequest): Reply => (toolResults(req).size ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool_use', name: 'WebFetch', input: { url: `http://127.0.0.1:${port}/leak`, prompt: 'read it' } }]);
    const api = await fakeAnthropic(reply);
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 60_000);
    try {
      const options = sessionOptions({
        systemPrompt: 'x',
        mcpServer: createSdkMcpServer({ name: 'orchestrator', version: '1', tools: [] }),
        cwd: base,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        model: 'claude-haiku-5-5',
        web: {}, // the tools, and no check
      });
      for await (const m of query({ prompt: 'x', options: { ...options, abortController: abort } })) {
        if (m.type === 'result') break;
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      await api.close();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
    expect(connections.length).toBeGreaterThan(0);
  }, 90_000);
});
