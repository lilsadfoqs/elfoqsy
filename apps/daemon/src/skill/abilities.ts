// The Abilities skills (data/skills) in Elfoqsy's sessions. The SDK loads them natively, as a
// local plugin copied for each session: the model sees each skill's name and description up front and its content only
// when it invokes the Skill tool. Ticket runs, task agents, investigators and Elfoqsy's conversation get them; study, exam
// and every other session get none (skills: []), which also keeps the skills bundled with Claude Code out of their context.
// His own skills (~/.claude/skills) stay out: every session keeps settingSources: [].
//
// A skill never grants anything. Proved on the real binary (test/abilities.test.ts): a skill's allowed-tools let its tools
// past canUseTool, its hooks run commands on the host, and its !`command` lines run before the model sees the skill. So the
// copy keeps only the frontmatter keys that describe a skill, a session that has skills disables their inline commands, and
// the Skill tool still goes through each session's gate, which lets through only the skills it was given.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** The plugin's name: the model and the gate see each skill as abilities:<name>. */
export const ABILITIES = 'abilities';

/** The frontmatter keys a copy keeps: what lists and describes a skill. Anything else (allowed-tools, hooks, model, agent…) goes. */
export const KEPT_KEYS = ['name', 'description', 'when_to_use', 'argument-hint', 'disable-model-invocation', 'user-invocable'] as const;

/** A skill's folder name, as the SDK takes it in its skills list. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What a session that has skills sets: their !`command` lines are replaced with a placeholder instead of being run. */
export const SKILL_SETTINGS = { disableSkillShellExecution: true } as const;

export interface Abilities {
  /** The plugin's root: the session's own copy. */
  dir: string;
  /** Each skill as the session names it: abilities:<name>. */
  names: string[];
  /** For each skill whose frontmatter lost keys, which ones. */
  stripped: Record<string, string[]>;
}

/** The skills in a source folder: each folder with a SKILL.md and a name the SDK accepts, in name order. */
export function abilityNames(src: string): string[] {
  if (!existsSync(src)) return [];
  return readdirSync(src)
    .filter((n) => NAME.test(n) && lstatSync(join(src, n)).isDirectory() && existsSync(join(src, n, 'SKILL.md')) && lstatSync(join(src, n, 'SKILL.md')).isFile())
    .sort();
}

/**
 * SKILL.md with its frontmatter cut to KEPT_KEYS. A key's value runs on over the lines indented under it (a list, a map,
 * a block string) and over list items at the margin. A file with no frontmatter is returned as it is: it has nothing to grant.
 */
export function cleanFrontmatter(skillMd: string): { text: string; dropped: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(skillMd);
  if (!m) return { text: skillMd, dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  let keep = false;
  for (const line of m[1]!.split(/\r?\n/)) {
    const key = /^([^\s#:][^:]*):/.exec(line)?.[1]?.trim();
    if (key !== undefined) {
      keep = (KEPT_KEYS as readonly string[]).includes(key);
      if (!keep) dropped.push(key);
    } else if (line.trim() !== '' && !/^(\s|-\s|-$)/.test(line) && !line.startsWith('#')) {
      // Not a key and not under one: nothing a reader of YAML would keep, so nothing to copy.
      keep = false;
    }
    if (keep || (key === undefined && line.trim() === '')) kept.push(line);
  }
  return { text: `---\n${kept.join('\n').trim()}\n---\n${skillMd.slice(m[0].length)}`, dropped };
}

/**
 * A skill folder's files, relative; links are never followed or copied (a link could lead to his home), and neither are
 * hidden files nor the engine's own ability.json (abilities/ability.ts): a session needs SKILL.md and what it refers to.
 */
function regularFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (name.startsWith('.') || (!rel && name === 'ability.json')) continue;
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, path));
    if (st.isDirectory()) out.push(...regularFiles(dir, path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

/**
 * The session's own read-only copy of the skills in src, as a local plugin at dest (made afresh). Null when src holds no
 * skill: the session then gets none.
 */
export function copyAbilities(src: string, dest: string): Abilities | null {
  const skills = abilityNames(src);
  rmSync(dest, { recursive: true, force: true });
  if (!skills.length) return null;
  const stripped: Record<string, string[]> = {};
  const put = (to: string, write: () => void) => {
    mkdirSync(dirname(to), { recursive: true });
    write();
    chmodSync(to, 0o444);
  };
  put(join(dest, '.claude-plugin', 'plugin.json'), () => writeFileSync(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: ABILITIES })));
  for (const skill of skills) {
    for (const f of regularFiles(join(src, skill))) {
      const from = join(src, skill, f);
      const to = join(dest, 'skills', skill, f);
      if (f === 'SKILL.md') {
        const clean = cleanFrontmatter(readFileSync(from, 'utf8'));
        if (clean.dropped.length) stripped[skill] = clean.dropped;
        put(to, () => writeFileSync(to, clean.text));
      } else put(to, () => copyFileSync(from, to));
    }
  }
  return { dir: dest, names: skills.map((s) => `${ABILITIES}:${s}`), stripped };
}

/** The session options for its skills: the plugin and its names, or none at all (no bundled skills either). */
export function skillOptions(a: Abilities | null | undefined): Pick<Options, 'plugins' | 'skills'> {
  return a ? { plugins: [{ type: 'local', path: a.dir }], skills: a.names } : { skills: [] };
}

/** Whether a Skill call is one the session was given: null when it is, else why not. */
export function skillRefusal(input: Record<string, unknown>, a: Abilities | null | undefined): string | null {
  const asked = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '') : '';
  const named = asked.includes(':') ? asked : `${ABILITIES}:${asked}`;
  if (a && a.names.includes(named)) return null;
  return a?.names.length ? `${asked || 'That skill'} is not one of the skills here: ${a.names.join(', ')}.` : 'There are no skills in this session.';
}
