// The reviewer reads files and nothing else, by configuration: the real Claude Code binary, started with the sub-agent
// definitions a run really gets, is not even offered a shell or a tool that writes for it, and when a reviewer tries one anyway
// (here a fake model that does) the SDK refuses and nothing reaches the host. The gate checks the same on every call
// (v13-agents.test.ts), but this is the layer that does not depend on any rule being read right. No model is called.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import type { Ticket } from '@elfoqsy/contracts';
import { reviewPackDir, writeReviewPack } from '../src/agents/reviewPack';
import { REVIEWER_NEVER, REVIEWER_TOOLS, subagentDefinitions } from '../src/agents/subagents';
import { fakeAnthropic, toolResults, type ApiRequest, type Reply } from './helpers/fakeAnthropic';
import { sandboxAvailable } from './helpers/sandboxProof';

describe('the reviewer’s definition', () => {
  const reviewer = subagentDefinitions(['claude-haiku-5-5'], ['low']).reviewer!;

  it('offers it files to read and nothing else: no shell, no writer, no sub-agent, no web, no run tools', () => {
    expect(reviewer.tools).toEqual(['Read', 'Grep', 'Glob', 'LS']);
    expect(reviewer.tools).toEqual(REVIEWER_TOOLS);
    for (const tool of ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'WebFetch', 'WebSearch']) {
      expect(reviewer.tools, tool).not.toContain(tool);
      expect(reviewer.disallowedTools, tool).toContain(tool);
    }
    expect(reviewer.disallowedTools).toEqual(expect.arrayContaining(REVIEWER_NEVER));
    expect(reviewer.disallowedTools).toContain('mcp__run');
  });

  it('tells it so, and where its diff is: a file the ticket agent writes, since it cannot run git', () => {
    expect(reviewer.prompt).toContain('You have no shell and no tool that writes');
    expect(reviewer.prompt).toContain('names a diff file in the run folder');
    expect(reviewer.prompt).not.toMatch(/git diff against the base|shell is held to reads/);
  });

  it('is given the ticket’s handoff and acceptance criteria as files, and told to hold the diff to them', () => {
    expect(reviewer.prompt).toContain('handoff.md and acceptance-criteria.md, written by Elfoqsy, not by the ticket agent');
    expect(reviewer.prompt).toContain('Read those two first, then the diff');
    expect(reviewer.prompt).toContain('For each acceptance criterion say MET, NOT MET, or CANNOT TELL');
    expect(reviewer.prompt).toContain("a constraint of alex's in the handoff that it breaks, is a finding");
    expect(reviewer.prompt).toContain('The handoff\'s facts are leads, not conclusions');
    expect(reviewer.prompt).toContain('If the folder is missing or says there is no handoff');
    // Its result still ends with the three lines the push gate reads.
    expect(reviewer.prompt).toMatch(/CONTRACT: none[\s\S]*CACHE_BYPASS: none[\s\S]*RESULT: success/);
    expect(reviewer.description).toContain('handoff and acceptance criteria');
    // A line for each criterion, in the form the orchestrator reads, between the two it always asked for and its result.
    expect(reviewer.prompt).toMatch(/CACHE_BYPASS: none[\s\S]*CRITERION <n>: MET \|[\s\S]*CRITERION <n>: NOT MET \|[\s\S]*CRITERION <n>: CANNOT TELL \|[\s\S]*CRITERIA: none stated[\s\S]*RESULT: success/);
    expect(reviewer.prompt).toContain('Every criterion you call NOT MET is shown to alex and holds the ticket agent\'s report that the run succeeded');
  });
});

describe.skipIf(!sandboxAvailable())('the reviewer in the real SDK', () => {
  const base = mkdtempSync(join(tmpdir(), 'elfoqsy-reviewer-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('is offered the file reads and no more, and cannot run or write what it tries anyway', async () => {
    const cwd = join(base, 'run');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'review.diff'), '--- a/x\n+++ b/x\n');
    // The ticket's handoff and acceptance criteria, as the orchestrator writes them when a run starts.
    writeReviewPack(cwd, { ticket: { key: 'SHOP-1', summary: 'Lift error_code', description: 'AC: error_code at the top.' } as Ticket, acceptance: '- error_code is at the top of an error result.', handoff: 'Keep the v1 path.' });
    const pack = reviewPackDir(cwd);
    const shellMarker = join(base, 'ran-a-shell');
    const writeMarker = join(base, 'wrote-a-file');
    const editMarker = join(base, 'edited-a-file');
    const offered: string[][] = [];
    const answers = new Map<string, string>();

    const reply = (req: ApiRequest): Reply => {
      const isReviewer = req.system.includes('You are a fresh-context code reviewer');
      if (!isReviewer) {
        // The ticket agent: start the reviewer once, then finish.
        const started = req.messages.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
        if (started) return [{ type: 'text', text: 'review done' }];
        return [{ type: 'tool_use', name: 'Agent', input: { description: 'review', prompt: `Review the diff in ${cwd}/review.diff.`, subagent_type: 'reviewer', run_in_background: false } }];
      }
      offered.push(req.tools);
      const results = toolResults(req);
      if (results.size) {
        for (const [id, text] of results) answers.set(id, text);
        return [{ type: 'text', text: 'RESULT: failure, I could not do what I tried' }];
      }
      // A reviewer that reads what it is given, and does what it must not: a shell, a write, an edit (also into the pack).
      return [
        { type: 'tool_use', name: 'Read', input: { file_path: join(pack, 'acceptance-criteria.md') } },
        { type: 'tool_use', name: 'Write', input: { file_path: join(pack, 'handoff.md'), content: 'tampered' } },
        { type: 'tool_use', name: 'Bash', input: { command: `: > '${shellMarker}'`, description: 'try a shell' } },
        { type: 'tool_use', name: 'Write', input: { file_path: writeMarker, content: 'x' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: join(cwd, 'review.diff'), old_string: '+++', new_string: '***' } },
      ];
    };

    const api = await fakeAnthropic(reply);
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 90_000);
    try {
      for await (const m of query({
        prompt: 'Review it.',
        options: {
          abortController: abort,
          cwd,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          model: 'claude-haiku-5-5',
          tools: { type: 'preset', preset: 'claude_code' },
          agents: subagentDefinitions(['claude-haiku-5-5'], ['low']),
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          permissionMode: 'default',
          // Everything a tool is allowed to run is allowed: the only thing between the reviewer and the machine is what it is offered.
          canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        },
      })) {
        if (m.type === 'result') break;
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      await api.close();
    }

    // What it was offered, as the API request lists it: the file reads, and at most the tool search that finds tools it has.
    expect(offered.length, 'the reviewer ran').toBeGreaterThan(0);
    for (const tools of offered) {
      // Read, Grep and Glob exist in this SDK; LS is in the definition for versions that have it, and is not offered here.
      expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
      for (const tool of ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'WebFetch', 'WebSearch']) expect(tools, `offered ${tool}`).not.toContain(tool);
      expect(tools.filter((t) => !REVIEWER_TOOLS.includes(t) && t !== 'ToolSearch'), 'nothing beyond the file reads').toEqual([]);
    }
    // What it tried anyway did nothing: not on the host, and the SDK answered each with an error, not a result.
    for (const marker of [shellMarker, writeMarker, editMarker]) expect(existsSync(marker), marker).toBe(false);
    expect(readFileOrNothing(join(cwd, 'review.diff'))).toBe('--- a/x\n+++ b/x\n');
    expect([...answers.values()].length, 'each of the five calls was answered').toBe(5);
    // The read gave it the pack's text; each of the four tries it must not make was refused as a tool it was never offered.
    const [reads, refused] = [[...answers.values()].filter((t) => t.includes('error_code is at the top of an error result.')), [...answers.values()].filter((t) => !t.includes('error_code is at the top'))];
    expect(reads, 'the acceptance criteria, read by the real Read tool').toHaveLength(1);
    expect(refused).toHaveLength(4);
    for (const text of refused) expect(text).toMatch(/no such tool|not available|unknown tool|isn't available|not a valid tool/i);
    expect(readFileOrNothing(join(pack, 'handoff.md'))).toContain('Keep the v1 path.');
  }, 120_000);
});

function readFileOrNothing(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '(gone)';
  }
}
