// alex's team-dev skill (~/.claude/skills/team-dev) inside Elfoqsy. Each run takes a read-only copy of it at
// start and follows that copy; its version is a hash of every file's path and contents, logged with the run. The
// adapter (docs/skill-adapter.md, prompts/skill-adapter.md) settles where the skill and Elfoqsy's rules disagree; it was
// written against one version, recorded in config/skill-adapter.json with a hash per section, so when the skill changes
// Elfoqsy tells him once which sections changed. The facts in references/environments.md are seeded into her memory,
// with the skill as their source.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { PayloadOf } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import { tr } from '../elfoqsy/voice';

export const SKILL = 'team-dev';

/** The skill's files, relative and in path order. */
export function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/** The skill's version: SHA-256 over each file's path and contents, in path order; 12 hex characters. */
export function skillHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of skillFiles(dir)) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * A hash per section: each Markdown file split at its "## " headings ("SKILL.md › 2. Implement", with the part before
 * the first heading as the file's own name), and every other file whole.
 */
export function sectionHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of skillFiles(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (!f.endsWith('.md')) {
      out[f] = short(text);
      continue;
    }
    let name = f;
    let body: string[] = [];
    const flush = () => {
      if (body.join('').trim() || name === f) out[name] = short(body.join('\n'));
    };
    for (const line of text.split('\n')) {
      const heading = /^##\s+(.+?)\s*$/.exec(line);
      if (heading) {
        flush();
        name = `${f} › ${heading[1]}`;
        body = [];
      } else body.push(line);
    }
    flush();
  }
  return out;
}

/** The sections added, removed or changed between two versions, in order. */
export function changedSections(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((n) => before[n] !== after[n]).map((n) => (!(n in before) ? `${n} (new)` : !(n in after) ? `${n} (removed)` : n));
}

export interface Snapshot {
  dir: string;
  hash: string;
  files: number;
  skillMd: string;
}

/**
 * A read-only copy of the skill for one run: files mode 0444 (folders stay writable so the run folder can be removed),
 * and the gate refuses every write tool under it. Its hash is taken from the copy.
 */
export function snapshotSkill(src: string, dest: string): Snapshot {
  const files = skillFiles(src);
  for (const f of files) {
    const to = join(dest, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, f), to);
    chmodSync(to, 0o444);
  }
  return { dir: dest, hash: skillHash(dest), files: files.length, skillMd: readFileSync(join(dest, 'SKILL.md'), 'utf8') };
}

/** SKILL.md as the run reads it: its frontmatter left out, and $ARGUMENTS the ticket and mode it was handed. */
export function skillForRun(skillMd: string, args: string): string {
  return skillMd.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\$ARGUMENTS/g, args).trim();
}

/** The version the adapter was written against: its hash and section hashes (config/skill-adapter.json). */
export interface AdapterManifest {
  skill: string;
  hash: string;
  sections: Record<string, string>;
}

export function readManifest(file: string): AdapterManifest | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as AdapterManifest;
}

/**
 * Whether the skill changed since the version the adapter was written against, and he has not been told about this
 * version yet: the skill.changed event to log, or null.
 */
export function skillChange(dir: string, manifest: AdapterManifest | null, s: Pick<WorkspaceState, 'skill'>): PayloadOf<'skill.changed'> | null {
  if (!manifest || !existsSync(join(dir, 'SKILL.md'))) return null;
  const hash = skillHash(dir);
  if (hash === manifest.hash || s.skill?.hash === hash) return null;
  return { skill: SKILL, hash, previous: manifest.hash, sections: changedSections(manifest.sections, sectionHashes(dir)) };
}

/** Elfoqsy's one line about a changed skill. */
export function skillChangeText(c: PayloadOf<'skill.changed'>): string {
  const list = tr(
    c.sections.length > 8 ? `${c.sections.slice(0, 8).join('; ')} and ${c.sections.length - 8} more` : c.sections.join('; '),
    c.sections.length > 8 ? `${c.sections.slice(0, 8).join('; ')} và ${c.sections.length - 8} mục nữa` : c.sections.join('; '),
  );
  return tr(
    `Your ${c.skill} skill changed (${c.previous ?? 'unknown'} → ${c.hash}): ${list || 'no section names changed'}. The adapter (docs/skill-adapter.md) was written for the earlier version and needs a review; runs follow the new version meanwhile.`,
    `Skill ${c.skill} của cậu đã thay đổi (${c.previous ?? 'không rõ'} → ${c.hash}): ${list || 'không có tên mục nào đổi'}. Adapter (docs/skill-adapter.md) được viết cho phiên bản trước và cần được xem lại; trong lúc đó các run theo phiên bản mới.`,
  );
}

/** The facts in references/environments.md, one per bullet or table row, with the section they are under. */
export function environmentFacts(text: string): string[] {
  const facts: string[] = [];
  let section = '';
  let header: string[] | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      header = null;
      continue;
    }
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!header) {
        header = cells;
        continue;
      }
      facts.push(`${section}: ${cells[0]}: ${cells.slice(1).join('; ')}`);
      continue;
    }
    header = null;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) facts.push(`${section}: ${bullet[1]}`);
  }
  return facts.map((f) => (f.length > 400 ? `${f.slice(0, 397)}…` : f));
}

const FACT_PREFIX = 'skill-env-';

/**
 * The memory events that make Elfoqsy's seeded environment facts match this version of the skill: earlier versions'
 * facts forgotten, this version's saved, each with the skill as its source. Empty when they already match.
 */
export function seedEnvironmentFacts(dir: string, s: Pick<WorkspaceState, 'memory'>, now: number): Array<{ type: 'memory.saved'; payload: PayloadOf<'memory.saved'> } | { type: 'memory.forgotten'; payload: PayloadOf<'memory.forgotten'> }> {
  const file = join(dir, 'references', 'environments.md');
  if (!existsSync(file)) return [];
  const hash = skillHash(dir);
  const statements = environmentFacts(readFileSync(file, 'utf8'));
  const ids = statements.map((_, i) => `${FACT_PREFIX}${hash}-${i + 1}`);
  const current = Object.keys(s.memory).filter((id) => id.startsWith(FACT_PREFIX));
  if (current.length === ids.length && ids.every((id) => s.memory[id])) return [];
  const out: Array<{ type: 'memory.saved'; payload: PayloadOf<'memory.saved'> } | { type: 'memory.forgotten'; payload: PayloadOf<'memory.forgotten'> }> = [];
  for (const id of current.filter((id) => !ids.includes(id))) out.push({ type: 'memory.forgotten', payload: { factId: id, by: 'orchestrator' } });
  statements.forEach((statement, i) => {
    if (s.memory[ids[i]!]) return;
    out.push({
      type: 'memory.saved',
      payload: {
        factId: ids[i]!,
        statement,
        sources: [{ kind: 'doc', ref: '~/.claude/skills/team-dev/references/environments.md', label: `${SKILL} skill, version ${hash}` }],
        freshUntil: new Date(now + 30 * 24 * 3600_000).toISOString(),
        origin: 'lookup',
        kind: 'fact',
      },
    });
  });
  return out;
}
