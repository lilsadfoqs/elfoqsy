import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { UsageState } from '../src/claude/usage';
import { Investigators, INVESTIGATOR_PROMPT, investigatorModel, pathRefusal, resolveRepo, type FinishedInvestigation } from '../src/agents/investigator';
import { Lookups } from '../src/elfoqsy/lookups';
import { EventLog } from '../src/eventLog';
import { ManualClock, fakeSdk, rateLimit, result, runTool, tick } from './helpers/fakeSdk';

const T0 = Date.parse('2026-10-10T14:00:00Z');
let base: string;
let clone: string;
let log: EventLog;
let sdk: ReturnType<typeof fakeSdk>;
let clock: ManualClock;
let usage: UsageState;
let finished: FinishedInvestigation[];
let investigators: Investigators;

const types = () => log.readFrom(0, 1000).map((e) => e.type);
const ofType = (type: string) => log.readFrom(0, 1000).filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'elfoqsy-inv-'));
  clone = join(base, 'shop-api');
  mkdirSync(join(clone, 'src'), { recursive: true });
  mkdirSync(join(clone, '.git'), { recursive: true });
  writeFileSync(join(clone, 'src', 'cache.ts'), 'export const cache = 1;\n');
  writeFileSync(join(clone, '.env'), 'X=1\n');
  writeFileSync(join(base, 'outside.txt'), 'outside\n');
  symlinkSync(join(base, 'outside.txt'), join(clone, 'src', 'escape.ts'));
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  usage = new UsageState(log, clock, () => clock.now);
  sdk = fakeSdk();
  finished = [];
  investigators = new Investigators({
    log,
    usage,
    queryFn: sdk.queryFn,
    lookups: new Lookups({ site: 'https://x.atlassian.net' }),
    clones: new Map([['acme/shop-api', clone]]),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/x' },
    root: join(base, 'investigations'),
    protectedPaths: [join(base, 'data')],
    onFinished: (f) => finished.push(f),
    clock,
    now: () => clock.now,
  });
});

afterEach(() => {
  log.close();
  rmSync(base, { recursive: true, force: true });
});

const start = () =>
  investigators.start({ question: 'Why does the Redis timeout never start?', model: 'sonnet', effort: 'high', repos: ['ACME/shop-api'], conversationId: 'c1' }) as { investigationId: string };

describe('investigators', () => {
  it('run read-only: Read, Grep and Glob only, nothing that writes, runs or browses, isolated, no credentials', () => {
    start();
    const o = sdk.sessions[0]!.options;
    expect(o).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      systemPrompt: INVESTIGATOR_PROMPT,
      tools: ['Read', 'Grep', 'Glob'],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      env: { PATH: '/usr/bin', HOME: '/home/x' },
      permissionMode: 'default',
    });
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent']));
    expect(o.additionalDirectories).toEqual([clone]);
    expect(Object.keys(o.mcpServers!)).toEqual(['investigator']);
    expect(sdk.sessions[0]!.sent[0]).toContain('Question from Elfoqsy: Why does the Redis timeout never start?');
    expect(INVESTIGATOR_PROMPT).not.toMatch(/Alex|Tran Trong/);
  });

  it('keep every read inside the clones, away from links out, .git, .env and protected paths', () => {
    const cwd = join(base, 'cwd');
    const roots = [cwd, clone];
    expect(pathRefusal('Read', { file_path: join(clone, 'src/cache.ts') }, cwd, roots, [])).toBeNull();
    expect(pathRefusal('Grep', { pattern: 'x' }, cwd, roots, [])).toBeNull();
    expect(pathRefusal('Grep', { pattern: 'x', path: clone }, cwd, roots, [])).toBeNull();
    expect(pathRefusal('Read', { file_path: join(base, 'outside.txt') }, cwd, roots, [])).toMatch(/outside/);
    expect(pathRefusal('Read', { file_path: join(clone, 'src/escape.ts') }, cwd, roots, [])).toMatch(/outside/);
    expect(pathRefusal('Glob', { pattern: '*', path: '/etc' }, cwd, roots, [])).toMatch(/outside/);
    expect(pathRefusal('Read', { file_path: join(clone, '.env') }, cwd, roots, [])).toMatch(/not readable/);
    expect(pathRefusal('Read', { file_path: join(clone, '.git/config') }, cwd, roots, [])).toMatch(/not readable/);
    expect(pathRefusal('Read', { file_path: join(clone, 'src/cache.ts') }, cwd, roots, [join(clone, 'src')])).toMatch(/not readable/);
  });

  it('deny other tools through both the permission callback and the hook', async () => {
    start();
    const o = sdk.sessions[0]!.options;
    const signal = new AbortController().signal;
    const ask = (name: string, input: Record<string, unknown>) => o.canUseTool!(name, input, { signal, toolUseID: 't', requestId: 'r' } as never);
    expect(await ask('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('Write', { file_path: join(clone, 'x') })).toMatchObject({ behavior: 'deny' });
    expect(await ask('Read', { file_path: join(clone, 'src/cache.ts') })).toMatchObject({ behavior: 'allow' });
    expect(await ask('mcp__investigator__lookup_jira', { key: 'SHOP-1' })).toMatchObject({ behavior: 'allow' });
    const pre = o.hooks!.PreToolUse![0]!.hooks[0]! as HookCallback;
    const hook = (tool_name: string, tool_input: unknown) => pre({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' } as HookInput, 't', { signal });
    expect(await hook('Read', { file_path: '/etc/passwd' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await hook('Read', { file_path: join(clone, 'src/cache.ts') })).toEqual({});
  });

  it('redact what a tool returns before the model sees it, and count the files read', async () => {
    start();
    const post = sdk.sessions[0]!.options.hooks!.PostToolUse![0]!.hooks[0]! as HookCallback;
    const signal = new AbortController().signal;
    const fake = `ghp_${'A1b2C3d4'.repeat(5)}`; // the shape of a GitHub token, not a real one
    const output = { type: 'text', file: { filePath: join(clone, 'src/cache.ts'), content: `const t = "${fake}";` } };
    const rewritten = await post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(clone, 'src/cache.ts') }, tool_response: output, tool_use_id: 't' } as HookInput, 't', { signal });
    expect(JSON.stringify(rewritten)).not.toContain(fake);
    expect(JSON.stringify(rewritten)).toContain('[redacted github token]');
    const clean = await post({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {}, tool_response: { files: ['a.ts'] }, tool_use_id: 't' } as HookInput, 't', { signal });
    expect(clean).toEqual({});
  });

  it('hand their skill uses to the engine at their report: the calls up to it, a refused or failed one as failed', async () => {
    const uses: unknown[] = [];
    investigators = new Investigators({
      log,
      usage,
      queryFn: sdk.queryFn,
      lookups: new Lookups({ site: 'https://x.atlassian.net' }),
      clones: new Map([['acme/shop-api', clone]]),
      baseEnv: {},
      root: join(base, 'investigations'),
      protectedPaths: [join(base, 'data')],
      onFinished: (f) => finished.push(f),
      abilityUses: (u) => uses.push(u),
      clock,
      now: () => clock.now,
    });
    start();
    const o = sdk.sessions.at(-1)!.options;
    const hook = (event: 'PreToolUse' | 'PostToolUseFailure', tool: string, input: Record<string, unknown>, id: string) =>
      (o.hooks![event]![0]!.hooks[0] as HookCallback)({ hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: base, permission_mode: 'default', ...(event === 'PostToolUseFailure' ? { error: 'boom' } : {}) } as HookInput, id, { signal: new AbortController().signal });
    await hook('PreToolUse', 'Skill', { skill: 'abilities:find-request-logs' }, 't1');
    await hook('PreToolUse', 'Grep', { pattern: 'redisTimeout', path: clone }, 't2');
    await hook('PostToolUseFailure', 'Grep', { pattern: 'redisTimeout', path: clone }, 't2');
    await hook('PreToolUse', 'Bash', { command: 'ls' }, 't3');
    await runTool(o, 'report_findings', { title: 'Why', findings: [{ text: 'It never starts.', sources: [{ kind: 'code', ref: 'acme/shop-api/src/cache.ts:1' }] }] }, 'investigator');
    // After its report: not part of the use.
    await hook('PreToolUse', 'Grep', { pattern: 'later', path: clone }, 't4');
    sdk.sessions.at(-1)!.emit(result());
    await tick();
    expect(uses).toEqual([
      {
        in: 'investigation',
        id: expect.stringMatching(/^inv-/),
        calls: [
          { tool: 'Skill', text: '{"skill":"abilities:find-request-logs"}', failed: true, toolUseId: 't1', skill: 'find-request-logs' },
          { tool: 'Grep', text: 'redisTimeout', failed: true, toolUseId: 't2' },
          { tool: 'Bash', text: '{"command":"ls"}', failed: true, toolUseId: 't3' },
        ],
      },
    ]);
  });

  it('report findings with sources: saved to memory, its folder removed, and Elfoqsy told in that conversation', async () => {
    const { investigationId } = start();
    expect(ofType('investigation.started')[0]).toMatchObject({ investigationId, conversationId: 'c1', model: 'claude-sonnet-5-5', effort: 'high' });
    const cwd = join(base, 'investigations', investigationId);
    expect(existsSync(cwd)).toBe(true);
    const o = sdk.sessions[0]!.options;
    const noSource = await runTool(o, 'report_findings', { title: 'x', findings: [{ text: 'y', sources: [] }] }, 'investigator');
    expect(noSource).toMatch(/too_small|at least|>=1/i);
    const ok = await runTool(
      o,
      'report_findings',
      { title: "What's actually happening", findings: [{ text: 'Cached steps never start the Redis timeout.', sources: [{ kind: 'code', ref: 'acme/shop-api/src/cache.ts:1' }] }] },
      'investigator',
    );
    expect(ok).toContain('Reported');
    clock.advance(220_000);
    sdk.sessions[0]!.emit(result({ 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0 } }));
    await tick();
    expect(ofType('investigation.finished')[0]).toMatchObject({ investigationId, title: "What's actually happening", tokens: 1200, durationMs: 220_000 });
    expect(ofType('memory.saved')[0]).toMatchObject({ statement: 'Cached steps never start the Redis timeout.', origin: 'investigator', freshUntil: new Date(T0 + 220_000 + 7 * 86_400_000).toISOString() });
    expect(finished).toEqual([expect.objectContaining({ investigationId, conversationId: 'c1', title: "What's actually happening" })]);
    expect(existsSync(cwd)).toBe(false);
  });

  it('stop after ten minutes, with no answer and a reason', async () => {
    start();
    clock.advance(10 * 60_000);
    await tick();
    expect(ofType('investigation.finished')[0]).toMatchObject({ title: 'No answer', findings: [] });
    expect(finished[0]!.stopped).toMatch(/ran out of time/);
  });

  it('stop at a usage limit, and start none while paused', async () => {
    start();
    sdk.sessions[0]!.emit(rateLimit('rejected', T0 + 3600_000));
    await tick();
    expect(finished[0]!.stopped).toMatch(/usage limit/);
    expect(usage.isPaused).toBe(true);
    expect(investigators.start({ question: 'q', model: 'haiku', effort: 'low', conversationId: 'c1' })).toMatchObject({ error: 'paused' });
  });

  it('run at most two at once, and refuse a model, effort or repository they cannot use', () => {
    start();
    start();
    expect(investigators.start({ question: 'q', model: 'haiku', effort: 'low', conversationId: 'c1' })).toMatchObject({ error: 'busy' });
    expect(investigators.start({ question: 'q', model: 'gpt', effort: 'low', conversationId: 'c1' })).toMatchObject({ error: 'bad_model' });
    expect(investigators.start({ question: 'q', model: 'opus', effort: 'max', conversationId: 'c1' })).toMatchObject({ error: 'bad_effort' });
    expect(investigators.start({ question: 'q', model: 'opus', effort: 'low', repos: ['x/y'], conversationId: 'c1' })).toMatchObject({ error: 'unknown_repo' });
    expect(investigatorModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(resolveRepo(['acme/shop-api', 'acme/shop-infra'], 'shop-api')).toBe('acme/shop-api');
    expect(resolveRepo(['a/x', 'b/x'], 'x')).toBeUndefined();
    expect(types().filter((t) => t === 'investigation.started')).toHaveLength(2);
  });
});
