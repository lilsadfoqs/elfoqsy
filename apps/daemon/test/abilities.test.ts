// The Abilities skills (data/skills), loaded natively by the SDK as a local plugin copied for each session: what the copy
// keeps and drops, which sessions get them and which get none, the gate on the Skill tool, and, on the real Claude Code
// binary against a fake API (no model call), that a skill grants nothing: our PreToolUse hook and canUseTool still decide
// every tool a skill names, its hooks and inline commands never run, and the model sees its description before its content.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type HookCallback, type HookInput, type Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '@elfoqsy/contracts';
import { ABILITIES, abilityNames, cleanFrontmatter, copyAbilities, KEPT_KEYS, SKILL_SETTINGS, skillOptions, skillRefusal } from '../src/skill/abilities';
import { sessionOptions } from '../src/elfoqsy/session';
import { ALLOWED_TOOLS } from '../src/elfoqsy/tools';
import { fakeAnthropic, toolResults, type ApiRequest, type Reply } from './helpers/fakeAnthropic';
import { tick } from './helpers/fakeSdk';
import { SHOP_API, orchestratorWorld, type OrchestratorWorld } from './helpers/orchestratorWorld';
import { sandboxAvailable } from './helpers/sandboxProof';

const base = mkdtempSync(join(tmpdir(), 'elfoqsy-abilities-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A skill as someone might write it: with keys that would grant or run something, beside the ones that describe it. */
const RISKY = (dir: string) => `---
name: triage
description: TRIAGE-DESCRIPTION Use when a cart total looks wrong.
when_to_use: |
  When a cart total is missing a discount.
allowed-tools: Bash Write
"allowed-tools": Read
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: "touch ${dir}/hook-ran"
model: claude-opus-5-5
context: fork
agent: general-purpose
argument-hint: "<ticket>"
---

TRIAGE-BODY Read the result, then touch the marker.

Now: !\`touch ${dir}/inline-ran\`
`;

function source(name: string, files: Record<string, string>): string {
  const src = join(base, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(src, path, '..'), { recursive: true });
    writeFileSync(join(src, path), content);
  }
  return src;
}

describe('the copy of a skill', () => {
  it('keeps only the frontmatter keys that describe it, and its body as written', () => {
    const { text, dropped } = cleanFrontmatter(RISKY('/x'));
    expect(dropped).toEqual(['allowed-tools', '"allowed-tools"', 'hooks', 'model', 'context', 'agent']);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
    expect(front).toBe('name: triage\ndescription: TRIAGE-DESCRIPTION Use when a cart total looks wrong.\nwhen_to_use: |\n  When a cart total is missing a discount.\nargument-hint: "<ticket>"');
    expect(text).not.toMatch(/allowed-tools|hooks:|touch \/x\/hook-ran|model:|context:|agent:/);
    expect(text).toContain('TRIAGE-BODY Read the result');
    expect(KEPT_KEYS).not.toContain('allowed-tools');
  });

  it('drops a list at the margin with its key, and keeps one under a kept key', () => {
    const { text, dropped } = cleanFrontmatter('---\nname: a\nallowed-tools:\n- Bash\n- Write\ndescription: d\n---\nbody\n');
    expect(dropped).toEqual(['allowed-tools']);
    expect(text).toBe('---\nname: a\ndescription: d\n---\nbody\n');
  });

  it('leaves a file with no frontmatter as it is', () => {
    expect(cleanFrontmatter('just a body\n')).toEqual({ text: 'just a body\n', dropped: [] });
  });

  it('is a read-only local plugin of every skill folder, under abilities:<name>, with what was stripped reported', () => {
    const outside = join(base, 'outside-secret');
    writeFileSync(outside, 'SECRET');
    const src = source('src-copy', {
      'triage/SKILL.md': RISKY('/x'),
      'triage/references/steps.md': 'STEPS',
      'release-notes/SKILL.md': '---\nname: release-notes\ndescription: Draft notes.\n---\nBODY\n',
      'Bad Name/SKILL.md': '---\nname: bad\n---\n',
      'no-skill/README.md': 'not a skill',
    });
    symlinkSync(outside, join(src, 'triage', 'linked-secret'));
    expect(abilityNames(src)).toEqual(['release-notes', 'triage']);
    const dest = join(base, 'dest-copy');
    const a = copyAbilities(src, dest)!;
    expect(a.names).toEqual([`${ABILITIES}:release-notes`, `${ABILITIES}:triage`]);
    expect(a.stripped).toEqual({ triage: ['allowed-tools', '"allowed-tools"', 'hooks', 'model', 'context', 'agent'] });
    expect(JSON.parse(readFileSync(join(dest, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'abilities' });
    expect(readFileSync(join(dest, 'skills', 'triage', 'references', 'steps.md'), 'utf8')).toBe('STEPS');
    expect(readFileSync(join(dest, 'skills', 'triage', 'SKILL.md'), 'utf8')).not.toContain('allowed-tools');
    // A link is never followed or copied, and nothing outside the skills comes along.
    expect(existsSync(join(dest, 'skills', 'triage', 'linked-secret'))).toBe(false);
    expect(existsSync(join(dest, 'skills', 'no-skill'))).toBe(false);
    for (const f of ['.claude-plugin/plugin.json', 'skills/triage/SKILL.md', 'skills/triage/references/steps.md']) expect(statSync(join(dest, f)).mode & 0o222, f).toBe(0);
    // Made afresh each time: a skill removed from the source is gone from the next copy.
    rmSync(join(src, 'release-notes'), { recursive: true });
    expect(copyAbilities(src, dest)!.names).toEqual([`${ABILITIES}:triage`]);
    expect(existsSync(join(dest, 'skills', 'release-notes'))).toBe(false);
  });

  it('is nothing when there are no skills, and leaves no folder behind', () => {
    const dest = join(base, 'dest-none');
    mkdirSync(dest, { recursive: true });
    expect(copyAbilities(join(base, 'missing'), dest)).toBeNull();
    expect(existsSync(dest)).toBe(false);
  });
});

describe('the Skill tool, and the options for it', () => {
  const a = { dir: '/p', names: ['abilities:triage'], stripped: {} };

  it('lets through only the skills the session was given, by either name', () => {
    expect(skillRefusal({ skill: 'abilities:triage' }, a)).toBeNull();
    expect(skillRefusal({ skill: 'triage' }, a)).toBeNull();
    expect(skillRefusal({ skill: '/abilities:triage' }, a)).toBeNull();
    expect(skillRefusal({ skill: 'update-config' }, a)).toMatch(/not one of the skills here: abilities:triage/);
    expect(skillRefusal({ skill: 'twg:twg-jira' }, a)).toMatch(/not one of the skills here/);
    expect(skillRefusal({}, a)).toMatch(/not one of the skills here/);
    expect(skillRefusal({ skill: 'triage' }, undefined)).toBe('There are no skills in this session.');
  });

  it('load the plugin and its names, or no skills at all', () => {
    expect(skillOptions(a)).toEqual({ plugins: [{ type: 'local', path: '/p' }], skills: ['abilities:triage'] });
    expect(skillOptions(undefined)).toEqual({ skills: [] });
    expect(SKILL_SETTINGS).toEqual({ disableSkillShellExecution: true });
  });
});

const ticket = (key: string): Ticket => ({ key, board: 'SHOP', summary: 'x', type: 'Bug', status: 'To do', priority: 'Major', storyPoints: 1, sprint: 's', sprintsCarried: 1, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: 'd' });

/** Our PreToolUse hook on one call, as the SDK would make it: the permission decision it returns, if any. */
async function preToolUse(options: Options, tool: string, input: Record<string, unknown>, cwd: string): Promise<string | undefined> {
  const out: Array<{ hookSpecificOutput?: { permissionDecision?: string } }> = [];
  for (const m of options.hooks?.PreToolUse ?? []) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(tool)) continue;
    for (const h of m.hooks) out.push((await (h as HookCallback)({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `t-${out.length}`, session_id: 's', transcript_path: '', cwd, permission_mode: 'default' } as HookInput, `t-${out.length}`, { signal: new AbortController().signal })) as never);
  }
  return out.find((o) => o.hookSpecificOutput?.permissionDecision)?.hookSpecificOutput?.permissionDecision;
}

describe('the sessions that get the skills', () => {
  let w: OrchestratorWorld;
  let src: string;
  beforeEach(() => {
    src = source(`src-${Math.random().toString(36).slice(2)}`, { 'triage/SKILL.md': RISKY('/x') });
    w = orchestratorWorld({ tickets: true, overrides: { abilitiesDir: src } });
    w.log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546') });
  });
  afterEach(async () => w.close());

  it('a ticket run: its own copy in its folder, the plugin and its names, no inline commands, and a gate on Skill', async () => {
    expect(await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] })).not.toHaveProperty('error');
    await tick();
    const { worktree } = w.log.readFrom(0, 1000, ['run.created']).at(-1)!.payload as { worktree: string };
    const options = w.sdk.sessions.at(-1)!.options;
    const copy = join(worktree, '.elfoqsy', 'abilities');
    expect(options.plugins).toEqual([{ type: 'local', path: copy }]);
    expect(options.skills).toEqual(['abilities:triage']);
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toMatchObject({ disableSkillShellExecution: true });
    expect(readFileSync(join(copy, 'skills', 'triage', 'SKILL.md'), 'utf8')).not.toContain('allowed-tools');
    expect(await preToolUse(options, 'Skill', { skill: 'abilities:triage' }, worktree)).toBe('allow');
    expect(await preToolUse(options, 'Skill', { skill: 'update-config' }, worktree)).toBe('deny');
    // Its copy is read-only to it, as the team-dev copy is.
    expect(await preToolUse(options, 'Write', { file_path: join(copy, 'skills', 'triage', 'SKILL.md'), content: 'x' }, worktree)).toBe('deny');
  });

  it('a task agent: the same', async () => {
    expect(await w.orchestrator.spawnTask({ name: 'Notes', goal: 'Draft the notes.', deliverable: 'document', model: 'haiku', effort: 'low' })).not.toHaveProperty('error');
    await tick();
    const { worktree } = w.log.readFrom(0, 1000, ['run.created']).at(-1)!.payload as { worktree: string };
    const options = w.sdk.sessions.at(-1)!.options;
    expect(options.plugins).toEqual([{ type: 'local', path: join(worktree, '.elfoqsy', 'abilities') }]);
    expect(options.skills).toEqual(['abilities:triage']);
    expect(options.settings).toMatchObject({ disableSkillShellExecution: true });
    expect(await preToolUse(options, 'Skill', { skill: 'triage' }, worktree)).toBe('allow');
    expect(await preToolUse(options, 'Skill', { skill: 'loop' }, worktree)).toBe('deny');
  });

  it('a run with no skills to load has none, not even Claude Code’s own', async () => {
    await w.close();
    w = orchestratorWorld({ tickets: true, overrides: { abilitiesDir: join(base, 'no-such-folder') } });
    w.log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546') });
    await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
    await tick();
    const options = w.sdk.sessions.at(-1)!.options;
    expect(options.skills).toEqual([]);
    expect(options).not.toHaveProperty('plugins');
    expect(options.settings).not.toHaveProperty('disableSkillShellExecution');
    expect(await preToolUse(options, 'Skill', { skill: 'triage' }, '/')).toBe('deny');
  });

  it('Elfoqsy’s conversation: Skill offered and allowed with the plugin, held to her skills; without them, no Skill and no skills', async () => {
    const server = { type: 'sdk', name: 'orchestrator', instance: {} } as never;
    const a = copyAbilities(src, join(base, `her-${Math.random().toString(36).slice(2)}`))!;
    const withSkills = sessionOptions({ systemPrompt: 'P', mcpServer: server, cwd: '/c', env: {}, abilities: a });
    expect(withSkills.tools).toEqual(['Skill']);
    expect(withSkills.allowedTools).toEqual([...ALLOWED_TOOLS, 'Skill']);
    expect(withSkills.plugins).toEqual([{ type: 'local', path: a.dir }]);
    expect(withSkills.skills).toEqual(['abilities:triage']);
    expect(withSkills.settingSources).toEqual([]);
    expect(withSkills.settings).toMatchObject({ disableSkillShellExecution: true });
    expect(await preToolUse(withSkills, 'Skill', { skill: 'abilities:triage' }, '/c')).toBeUndefined();
    expect(await preToolUse(withSkills, 'Skill', { skill: 'twg-jira' }, '/c')).toBe('deny');
    const without = sessionOptions({ systemPrompt: 'P', mcpServer: server, cwd: '/c', env: {} });
    expect(without.tools).toEqual([]);
    expect(without.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(without.skills).toEqual([]);
    expect(without).not.toHaveProperty('plugins');
  });
});

describe('the sessions that get none', () => {
  it('the responder asks for no skills', () => {
    // Each builds its options inline with live dependencies; what matters is that each says skills: [] beside settingSources: [].
    for (const file of ['decisions/responder.ts']) {
      const text = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      expect(text, file).toMatch(/settingSources: \[\],\s*(\/\/[^\n]*\n\s*)?skills: \[\]/);
      expect(text, file).not.toMatch(/plugins:/);
    }
  });
});

describe.skipIf(!sandboxAvailable())('a skill on the real Claude Code binary', () => {
  /**
   * One session against a fake API: the model invokes the skill, then calls the Bash and Write the skill names. What our
   * PreToolUse hook and canUseTool saw, what the model saw first and after the skill, and what ran on the host.
   */
  async function session(plugin: string, names: string[], settings: Options['settings'], cwd: string) {
    const pre: string[] = [];
    const asked: string[] = [];
    const requests: ApiRequest[] = [];
    const reply = (req: ApiRequest): Reply => {
      requests.push(req);
      const results = toolResults(req);
      if (results.size === 0) return [{ type: 'tool_use', name: 'Skill', input: { skill: 'abilities:triage' } }];
      if (results.size === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: `touch '${join(cwd, 'bash-ran')}'`, description: 'touch' } }, { type: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'written.txt'), content: 'x' } }];
      return [{ type: 'text', text: 'done' }];
    };
    const api = await fakeAnthropic(reply);
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 90_000);
    try {
      for await (const m of query({
        prompt: 'Triage it.',
        options: {
          abortController: abort,
          cwd,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(cwd, 'home'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key-not-real', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          model: 'claude-haiku-5-5',
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          permissionMode: 'default',
          plugins: [{ type: 'local', path: plugin }],
          skills: names,
          ...(settings ? { settings } : {}),
          hooks: { PreToolUse: [{ hooks: [async (i) => (pre.push((i as { tool_name: string }).tool_name), {})] }] },
          canUseTool: async (tool, input) => (asked.push(tool), { behavior: 'allow', updatedInput: input }),
        },
      })) {
        if (m.type === 'result') break;
      }
    } finally {
      clearTimeout(deadline);
      await api.close();
    }
    const said = (r: ApiRequest | undefined) => (r ? r.system + JSON.stringify(r.messages) : '');
    return { pre, asked, first: said(requests[0]), afterSkill: said(requests[1]), offered: requests[0]?.tools ?? [], ran: (f: string) => existsSync(join(cwd, f)) };
  }

  it('through our copy, grants nothing: our hook and canUseTool decide its tools, its hooks and inline command never run', async () => {
    const cwd = join(base, 'real-copied');
    mkdirSync(join(cwd, 'home'), { recursive: true });
    const src = source('real-src', { 'triage/SKILL.md': RISKY(cwd) });
    const a = copyAbilities(src, join(cwd, '.elfoqsy', 'abilities'))!;
    const s = await session(a.dir, a.names, SKILL_SETTINGS, cwd);
    // Native loading: the description before the skill is invoked, the content only after; the bundled skills nowhere.
    expect(s.offered).toContain('Skill');
    expect(s.first).toContain('TRIAGE-DESCRIPTION');
    expect(s.first).not.toContain('TRIAGE-BODY');
    expect(s.first).not.toMatch(/update-config|fewer-permission-prompts/);
    expect(s.afterSkill).toContain('TRIAGE-BODY');
    // Every tool the skill names went through our hook and our canUseTool.
    expect(s.pre).toEqual(['Skill', 'Bash', 'Write']);
    expect(s.asked).toEqual(['Bash', 'Write']);
    // Nothing of the skill's own ran on the host: not its hook, not its inline command (shown as a placeholder instead).
    expect(s.ran('hook-ran')).toBe(false);
    expect(s.ran('inline-ran')).toBe(false);
    expect(s.afterSkill).toContain('[shell command execution disabled by policy]');
  }, 120_000);

  /** A plugin with the skill exactly as written, not through our copy. */
  function rawPlugin(cwd: string, skillMd: string): string {
    const plugin = join(cwd, 'plugin');
    mkdirSync(join(cwd, 'home'), { recursive: true });
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: ABILITIES }));
    mkdirSync(join(plugin, 'skills', 'triage'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'triage', 'SKILL.md'), skillMd);
    return plugin;
  }

  it('as written, its allowed-tools would let its tools past canUseTool: why the copy strips it', async () => {
    const cwd = join(base, 'real-raw-allowed');
    const plugin = rawPlugin(cwd, '---\nname: triage\ndescription: TRIAGE-DESCRIPTION\nallowed-tools: Bash Write\n---\n\nTRIAGE-BODY\n');
    const s = await session(plugin, ['abilities:triage'], SKILL_SETTINGS, cwd);
    // Only our PreToolUse hook still sees them; canUseTool is never asked.
    expect(s.pre).toEqual(['Skill', 'Bash', 'Write']);
    expect(s.asked).toEqual([]);
    expect(s.ran('bash-ran')).toBe(true);
  }, 120_000);

  it('as written, its hooks would run commands on the host: why the copy strips them', async () => {
    const cwd = join(base, 'real-raw-hooks');
    const plugin = rawPlugin(cwd, `---\nname: triage\ndescription: TRIAGE-DESCRIPTION\nhooks:\n  PreToolUse:\n    - matcher: "*"\n      hooks:\n        - type: command\n          command: "touch ${cwd}/hook-ran"\n---\n\nTRIAGE-BODY\n`);
    const s = await session(plugin, ['abilities:triage'], SKILL_SETTINGS, cwd);
    expect(s.ran('hook-ran')).toBe(true);
    expect(lstatSync(join(cwd, 'hook-ran')).isFile()).toBe(true);
  }, 120_000);
});
