// data/skills, versioned with git: one folder per ability, its ability.json and the SKILL.md rendered
// from it. Every write is a commit by Elfoqsy, so each version of a skill (learned, repaired) can be read back. One
// shared set for Elfoqsy and every agent; sessions load a read-only copy of it (skill/abilities.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Git } from '../agents/git';
import { ABILITY_FILE, REFERENCES_FILE, problemsOf, renderSkill, type Ability } from './ability';

/** git with nothing of his: no global or system config, no prompts, Elfoqsy as the author. */
const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Elfoqsy', GIT_AUTHOR_EMAIL: 'elfoqsy@localhost', GIT_COMMITTER_NAME: 'Elfoqsy', GIT_COMMITTER_EMAIL: 'elfoqsy@localhost' };

export class AbilityStore {
  private readonly git = new Git(undefined, { PATH: process.env.PATH ?? '/usr/bin:/bin', ...ENV });

  constructor(readonly dir: string) {}

  /** Every ability on disk, by name; a folder whose ability.json does not parse or is not valid is left out. */
  list(): Ability[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => !n.startsWith('.'))
      .sort()
      .map((n) => this.get(n))
      .filter((a): a is Ability => a !== undefined);
  }

  get(name: string): Ability | undefined {
    const file = join(this.dir, name, ABILITY_FILE);
    if (!existsSync(file)) return undefined;
    try {
      const a = JSON.parse(readFileSync(file, 'utf8')) as Ability;
      return a.name === name && !problemsOf(a).length ? a : undefined;
    } catch {
      return undefined;
    }
  }

  /** Writes it (ability.json and SKILL.md) and commits it. Refused, with the reasons, when it is not valid. */
  async write(a: Ability, message: string): Promise<void> {
    const problems = problemsOf(a);
    if (problems.length) throw new Error(`Not a valid ability: ${problems.join('; ')}.`);
    await this.init();
    mkdirSync(join(this.dir, a.name), { recursive: true });
    writeFileSync(join(this.dir, a.name, ABILITY_FILE), `${JSON.stringify(a, null, 2)}\n`);
    writeFileSync(join(this.dir, a.name, 'SKILL.md'), renderSkill(a));
    // Its references, beside SKILL.md: written when it has them, taken away when a new version has none.
    const references = join(this.dir, a.name, REFERENCES_FILE);
    if (a.references) {
      mkdirSync(dirname(references), { recursive: true });
      writeFileSync(references, `${a.references.trimEnd()}\n`);
    } else rmSync(references, { force: true });
    await this.git.run(['-C', this.dir, 'add', '--', a.name]);
    // Nothing changed: nothing to commit.
    if ((await this.git.run(['-C', this.dir, 'status', '--porcelain', '--', a.name])) === '') return;
    await this.git.run(['-C', this.dir, 'commit', '-q', '--no-verify', '-m', message, '--', a.name]);
  }

  /** The versions of one ability, newest first: commit and message. */
  async history(name: string): Promise<Array<{ commit: string; message: string }>> {
    if (!existsSync(join(this.dir, '.git'))) return [];
    const out = await this.git.run(['-C', this.dir, 'log', '--format=%h%x09%s', '--', name]).catch(() => '');
    return out ? out.split('\n').map((l) => ({ commit: l.split('\t')[0]!, message: l.split('\t').slice(1).join('\t') })) : [];
  }

  private async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, '.git'))) await this.git.run(['-C', this.dir, 'init', '-q', '-b', 'main']);
  }
}
