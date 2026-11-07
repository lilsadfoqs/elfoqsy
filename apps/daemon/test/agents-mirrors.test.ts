// The mirror run clones are made from (alex, 18 October): Elfoqsy's own copy of each repository, so the object files a run's clone
// shares with its source are the mirror's, never those of his own clone. Real git in a temporary folder; the property is checked on the disk,
// by inode: which files a run clone, the mirror and his clone have in common.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git, GitError, prepareDependency, prepareTarget } from '../src/agents/git';
import { Mirrors } from '../src/agents/mirrors';
import { gitEnv, gitWorld, type GitWorld } from './helpers/realGit';

let world: GitWorld;
let warnings: string[];
const git = new Git(undefined, gitEnv);

beforeEach(() => {
  world = gitWorld();
  warnings = [];
});
afterEach(() => world.cleanup());

const mirrorsOf = (o: { refreshEveryMs?: number } = {}) => new Mirrors(git, join(world.root, 'mirrors'), { runsRoot: world.worktrees, refreshEveryMs: 0, warn: (t) => warnings.push(t), ...o });

/** The files under a folder, as "device:inode", which is what hard links share. */
function inodes(dir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const s = statSync(path);
        out.add(`${s.dev}:${s.ino}`);
      }
    }
  };
  walk(dir);
  return out;
}
const common = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;

/** A commit on GitHub (the bare repository), on a branch, made from a separate clone. */
function pushToGitHub(branch: string, file: string): string {
  const work = join(world.root, `work-${branch.replace(/\W/g, '-')}`);
  execFileSync('git', ['clone', '--quiet', world.remote, work], { env: gitEnv });
  if (branch !== 'master') world.git(work, 'switch', '--quiet', '-c', branch);
  writeFileSync(join(work, file), `${file}\n`);
  world.git(work, 'add', '.');
  world.git(work, 'commit', '--quiet', '-m', file);
  world.git(work, 'push', '--quiet', 'origin', branch);
  return world.git(work, 'rev-parse', 'HEAD');
}

/** Damage an object file the way a shell with a link to it could: in place, through the run clone's own path. */
function damage(file: string): void {
  chmodSync(file, 0o644);
  const bytes = readFileSync(file);
  const at = Math.min(40, bytes.length - 1);
  for (let i = at; i < Math.min(at + 24, bytes.length); i++) bytes[i] = bytes[i]! ^ 0xff;
  writeFileSync(file, bytes);
}

const objectFiles = (repoGitDir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (path.includes('/objects/pack/') ? path.endsWith('.pack') : /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(path))) out.push(path);
    }
  };
  walk(join(repoGitDir, 'objects'));
  return out;
};

describe('making the mirror', () => {
  it('copies what his clone has and fetches GitHub, with HEAD on the default branch, and shares no object file with his clone', async () => {
    pushToGitHub('feature/other', 'other.ts'); // on GitHub, not in his clone
    const mirrors = mirrorsOf();
    const path = await mirrors.ensure(world.clone);
    expect(path).toBe(join(world.root, 'mirrors', 'shop-api.git'));
    const heads = world.git(path, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort();
    expect(heads).toEqual(['refs/heads/feature/other', 'refs/heads/master']);
    expect(world.git(path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/master');
    expect(world.git(path, 'remote', 'get-url', 'origin')).toBe(world.remote);
    // His clone is read, never linked: nothing in the mirror is a file of his, nor of GitHub's.
    const mine = inodes(join(path, 'objects'));
    expect(mine.size).toBeGreaterThan(0);
    expect(common(mine, inodes(join(world.clone.path, '.git', 'objects')))).toBe(0);
    expect(common(mine, inodes(join(world.remote, 'objects')))).toBe(0);
    // And his clone is as it was: no remote, branch or config added by it.
    expect(world.git(world.clone.path, 'remote')).toBe('origin');
    expect(world.git(world.clone.path, 'branch', '--list')).toContain('master');
    expect(world.git(path, 'config', '--get-all', 'remote.origin.fetch').split('\n')).toEqual(['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
  });

  it('describes the repository as run clones are made from it: his clone’s facts, the mirror’s path', async () => {
    const source = await mirrorsOf().source(world.clone);
    expect(source).toEqual({ ...world.clone, path: join(world.root, 'mirrors', 'shop-api.git') });
  });

  it('is made from his clone alone when GitHub cannot be read, and refuses when neither can', async () => {
    const offline = { ...world.clone, url: join(world.root, 'nowhere.git') };
    const path = await mirrorsOf().ensure(offline);
    expect(world.git(path, 'rev-parse', 'refs/heads/master')).toBe(world.git(world.clone.path, 'rev-parse', 'refs/remotes/origin/master'));
    expect(warnings.join('\n')).toContain('could not be refreshed from GitHub');
    await expect(mirrorsOf().ensure({ ...world.clone, repo: 'acme/other', path: join(world.root, 'gone'), url: join(world.root, 'nowhere.git') })).rejects.toThrow(GitError);
  });

  it('keeps no template hook of his: it is made with an empty template', async () => {
    const path = await mirrorsOf().ensure(world.clone);
    expect(existsSync(join(path, 'hooks')) ? readdirSync(join(path, 'hooks')) : []).toEqual([]);
  });
});

describe('run clones made from it', () => {
  it('share their object files with the mirror and none with his clone, as a target and as a dependency', async () => {
    const mirrors = mirrorsOf();
    const source = await mirrors.source(world.clone);
    const target = await prepareTarget(git, source, join(world.worktrees, 'run-a'), 'feature/SHOP-3546');
    const dependency = await prepareDependency(git, source, join(world.worktrees, 'run-b'));
    const mirror = inodes(join(source.path, 'objects'));
    const his = inodes(join(world.clone.path, '.git', 'objects'));
    for (const [name, repo] of [['target', target], ['dependency', dependency]] as const) {
      const run = inodes(join(repo.path, '.git', 'objects'));
      expect(common(run, mirror), `${name}: linked from the mirror`).toBeGreaterThan(0);
      expect(common(run, his), `${name}: none of his`).toBe(0);
    }
    // What the run holds is right: GitHub is the target's origin, and the branch is its own.
    expect(world.git(target.path, 'remote', 'get-url', 'origin')).toBe(world.remote);
    expect(world.git(target.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/SHOP-3546');
    expect(world.git(dependency.path, 'remote')).toBe('');
  });

  it('start from GitHub’s default branch, with GitHub as the only remote', async () => {
    pushToGitHub('master', 'newer.ts');
    const mirrors = mirrorsOf();
    const source = await mirrors.source(world.clone);
    const target = await prepareTarget(git, source, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    expect(world.git(target.path, 'remote')).toBe('origin');
    expect(world.git(target.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/SHOP-3546');
    expect(existsSync(join(target.path, 'newer.ts'))).toBe(true); // GitHub's newer commit, which his clone had not fetched
    expect(existsSync(join(world.clone.path, 'newer.ts'))).toBe(false);
  });

  it('make a dependency of GitHub’s default branch, not of his local branch', async () => {
    // His own clone is ahead of GitHub with a commit that was never pushed; a dependency must not carry it.
    writeFileSync(join(world.clone.path, 'local-only.ts'), 'mine\n');
    world.git(world.clone.path, 'add', '.');
    world.git(world.clone.path, 'commit', '--quiet', '-m', 'mine, not pushed');
    const source = await mirrorsOf().source(world.clone);
    const dependency = await prepareDependency(git, source, join(world.worktrees, 'dep'));
    expect(existsSync(join(dependency.path, 'README.md'))).toBe(true);
    expect(existsSync(join(dependency.path, 'local-only.ts'))).toBe(false);
  });
});

describe('keeping it current', () => {
  it('fetches GitHub each time a run starts, and not again within the refresh window', async () => {
    const first = mirrorsOf({ refreshEveryMs: 60_000 });
    const path = await first.ensure(world.clone);
    const before = world.git(path, 'rev-parse', 'refs/heads/master');
    const newer = pushToGitHub('master', 'newer.ts');
    await first.ensure(world.clone); // inside the window: not fetched
    expect(world.git(path, 'rev-parse', 'refs/heads/master')).toBe(before);
    await mirrorsOf({ refreshEveryMs: 0 }).ensure(world.clone); // a new window: fetched
    expect(world.git(path, 'rev-parse', 'refs/heads/master')).toBe(newer);
  });

  it('follows a branch deleted on GitHub, and keeps the mirror as it is when GitHub cannot be reached', async () => {
    pushToGitHub('feature/gone', 'g.ts');
    const mirrors = mirrorsOf();
    const path = await mirrors.ensure(world.clone);
    expect(world.git(path, 'for-each-ref', 'refs/heads/feature/gone')).not.toBe('');
    world.git(world.remote, 'branch', '-D', 'feature/gone');
    await mirrors.ensure(world.clone);
    expect(world.git(path, 'for-each-ref', 'refs/heads/feature/gone')).toBe('');
    // Offline: the same mirror, and a line for the log.
    const offline = { ...world.clone, url: join(world.root, 'nowhere.git') };
    world.git(path, 'remote', 'set-url', 'origin', offline.url);
    expect(await mirrors.ensure(offline)).toBe(path);
    expect(warnings.some((w) => w.includes('stays as it is'))).toBe(true);
  });

  it('does everything on one repository one after the other', async () => {
    const mirrors = mirrorsOf();
    const paths = await Promise.all([mirrors.ensure(world.clone), mirrors.ensure(world.clone), mirrors.check(world.clone).then(() => mirrors.ensure(world.clone)), mirrors.ensure(world.clone)]);
    expect(new Set(paths).size).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe('checking it after a run', () => {
  it('passes a mirror nothing has touched, and has nothing to check before there is one', async () => {
    const mirrors = mirrorsOf();
    expect(await mirrors.check(world.clone)).toMatchObject({ ok: true, recreated: false });
    await mirrors.ensure(world.clone);
    const result = await mirrors.check(world.clone);
    expect(result).toMatchObject({ repo: world.clone.repo, ok: true, recreated: false });
    expect(result.problem).toBeUndefined();
  });

  it('finds what a run did to an object file through its own clone, and makes the mirror again, sharing nothing with the damaged files', async () => {
    const mirrors = mirrorsOf();
    const source = await mirrors.source(world.clone);
    const target = await prepareTarget(git, source, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const mirrorGit = join(source.path);
    // A file the run clone has in common with the mirror, damaged by its path in the run folder.
    const runFiles = objectFiles(join(target.path, '.git'));
    const mirrorInodes = inodes(join(mirrorGit, 'objects'));
    const linked = runFiles.find((f) => {
      const s = statSync(f);
      return mirrorInodes.has(`${s.dev}:${s.ino}`);
    });
    expect(linked, 'a file linked into the run clone').toBeDefined();
    damage(linked!);

    const result = await mirrors.check(world.clone);
    expect(result).toMatchObject({ ok: false, recreated: true });
    expect(result.problem).toBeTruthy();
    // The mirror is whole again, from his clone and GitHub, and shares no file with the damaged one.
    expect(execFileSync('git', ['-C', mirrorGit, 'fsck', '--full', '--no-dangling'], { env: gitEnv, stdio: 'pipe' }).toString()).not.toMatch(/error|missing|corrupt/i);
    expect(common(inodes(join(mirrorGit, 'objects')), inodes(join(target.path, '.git', 'objects')))).toBe(0);
    // A run started now is whole.
    const later = await prepareTarget(git, await mirrors.source(world.clone), join(world.worktrees, 'later'), 'feature/SHOP-3547');
    expect(world.git(later.path, 'log', '--oneline')).toContain('first');
    // And his clone was never part of it.
    expect(world.git(world.clone.path, 'fsck', '--full', '--no-dangling')).not.toMatch(/error|missing|corrupt/i);
  });

  it('finds a damaged loose object as well as a damaged pack', async () => {
    const mirrors = mirrorsOf();
    const path = await mirrors.ensure(world.clone);
    // Make a loose object in the mirror (a fetch writes packs), and damage it.
    world.git(path, 'hash-object', '-w', '--stdin', '--literally'); // nothing on stdin: an empty blob is written
    const loose = objectFiles(path).find((f) => !f.endsWith('.pack'));
    expect(loose).toBeDefined();
    // A loose object only fsck would miss if it did not read it: put real content in the file, which no longer matches its name.
    chmodSync(loose!, 0o644);
    writeFileSync(loose!, 'not a git object');
    expect(await mirrors.check(world.clone)).toMatchObject({ ok: false, recreated: true });
    expect(await mirrors.check(world.clone)).toMatchObject({ ok: true, recreated: false });
  });
});

describe('where the mirror lives', () => {
  it('has a folder per repository, named like the clone’s folder', () => {
    const mirrors = mirrorsOf();
    expect(mirrors.pathOf('acme/shop-api')).toBe(join(world.root, 'mirrors', 'shop-api.git'));
    expect(mirrors.pathOf('acme/shop-worker')).toBe(join(world.root, 'mirrors', 'shop-worker.git'));
    mkdirSync(join(world.root, 'mirrors'), { recursive: true });
  });
});
