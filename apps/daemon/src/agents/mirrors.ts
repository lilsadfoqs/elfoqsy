// A mirror of each repository, Elfoqsy's own (alex, 18 October). A run's clone is made with `git clone` from a local path, which
// hard-links the object files instead of copying them; made from his clone, that shared the files with it, so a shell that made one
// writable could damage it in his clone. Now the run clones are made from a mirror that is hers: seeded by copying from his clone (a
// fetch copies, it never links), refreshed from GitHub by fetch, and checked with `git fsck` after each run, when it is made again
// if a run damaged it. What a run does to its own object files can reach the mirror, never his clone.
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GitError, type Git, type LocalClone } from './git';
import { repoDir } from './repoPolicy';

export interface MirrorCheck {
  repo: string;
  /** fsck found nothing wrong. */
  ok: boolean;
  /** It was damaged and has been made again from his clone and GitHub. */
  recreated: boolean;
  ms: number;
  /** What fsck said, the last lines of it, when it found something. */
  problem?: string;
}

export interface MirrorOptions {
  now?: () => number;
  /** How long after a fetch the next run start does not fetch again. */
  refreshEveryMs?: number;
  /** A line for the daemon's log: a refresh that failed, a mirror on another disk than the run folders. */
  warn?: (text: string) => void;
  /** The run folders' root: a mirror on another disk is copied into run clones, not linked. */
  runsRoot?: string;
}

const REFRESH_MS = 60_000;
const FETCH_MS = 600_000;
const FSCK_MS = 900_000;

export class Mirrors {
  private readonly chain = new Map<string, Promise<unknown>>();
  private readonly refreshedAt = new Map<string, number>();
  private warnedDisk = false;

  constructor(
    private readonly git: Git,
    readonly dir: string,
    private readonly o: MirrorOptions = {},
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private warn(text: string): void {
    (this.o.warn ?? ((t: string) => console.warn(t)))(text);
  }

  /** Where the mirror of a repository is. */
  pathOf(repo: string): string {
    return join(this.dir, `${repoDir(repo)}.git`);
  }

  /** Everything on one repository goes one after the other: a run does not start from a mirror that is being checked or made again. */
  private locked<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(repo) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chain.set(repo, next.catch(() => undefined));
    return next;
  }

  private exists(path: string): boolean {
    return existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects'));
  }

  /** The repository as run clones are made from it: his clone's description, with the mirror's path in place of his. */
  async source(clone: LocalClone): Promise<LocalClone> {
    return { ...clone, path: await this.ensure(clone) };
  }

  /** The mirror, made when there is none and refreshed from GitHub; its path. */
  ensure(clone: LocalClone): Promise<string> {
    return this.locked(clone.repo, async () => {
      const path = this.pathOf(clone.repo);
      if (!this.exists(path)) await this.create(clone);
      else await this.refresh(clone);
      this.checkDisk(path);
      return path;
    });
  }

  /** git fsck on the mirror after a run; made again if it is damaged. */
  check(clone: LocalClone): Promise<MirrorCheck> {
    return this.locked(clone.repo, async () => {
      const path = this.pathOf(clone.repo);
      const started = this.now();
      if (!this.exists(path)) return { repo: clone.repo, ok: true, recreated: false, ms: 0 };
      try {
        await this.git.run(['-C', path, 'fsck', '--full', '--no-dangling', '--no-progress'], FSCK_MS);
        return { repo: clone.repo, ok: true, recreated: false, ms: this.now() - started };
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        await this.create(clone);
        return { repo: clone.repo, ok: false, recreated: true, ms: this.now() - started, problem };
      }
    });
  }

  /** A bare repository with GitHub as its origin, seeded from his clone's copy of GitHub's branches (copied, not linked), then fetched. */
  private async create(clone: LocalClone): Promise<void> {
    const path = this.pathOf(clone.repo);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    // An empty template: none of his git templates' hooks come along.
    await this.git.run(['init', '--bare', '--quiet', '--template=', path]);
    await this.git.run(['-C', path, 'remote', 'add', 'origin', clone.url]);
    await this.git.run(['-C', path, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
    await this.git.run(['-C', path, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*']);
    let seeded = true;
    try {
      // From his clone, read only: what it holds of GitHub's branches and tags. A fetch writes new object files; it links none.
      await this.git.run(['-C', path, 'fetch', '--quiet', '--no-tags', clone.path, '+refs/remotes/origin/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], FETCH_MS);
      await this.git.tryRun(['-C', path, 'update-ref', '-d', 'refs/heads/HEAD']); // his origin/HEAD, which is not a branch
    } catch {
      seeded = false;
    }
    this.refreshedAt.delete(clone.repo);
    const fetched = await this.fetchFromGitHub(clone, path);
    if (!seeded && !fetched) throw new GitError(`The mirror of ${clone.repo} could not be made: neither his clone nor GitHub could be read.`);
    await this.pointHead(clone, path);
  }

  private async refresh(clone: LocalClone): Promise<void> {
    const last = this.refreshedAt.get(clone.repo);
    if (last !== undefined && this.now() - last < (this.o.refreshEveryMs ?? REFRESH_MS)) return;
    const path = this.pathOf(clone.repo);
    await this.fetchFromGitHub(clone, path);
    await this.pointHead(clone, path);
  }

  /** Whether GitHub could be fetched from. A mirror that could not be refreshed is used as it is: the run fetches what it needs itself. */
  private async fetchFromGitHub(clone: LocalClone, path: string): Promise<boolean> {
    try {
      await this.git.run(['-C', path, 'fetch', '--quiet', '--prune', 'origin'], FETCH_MS);
      this.refreshedAt.set(clone.repo, this.now());
      return true;
    } catch (error) {
      this.warn(`The mirror of ${clone.repo} could not be refreshed from GitHub, so it stays as it is: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Its HEAD names the default branch, so a clone of it has something to check out. */
  private async pointHead(clone: LocalClone, path: string): Promise<void> {
    if (await this.git.tryRun(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${clone.defaultBranch}`])) {
      await this.git.tryRun(['-C', path, 'symbolic-ref', 'HEAD', `refs/heads/${clone.defaultBranch}`]);
    }
  }

  /** On another disk than the run folders, a clone copies the objects instead of linking them: slower, and safe all the same. */
  private checkDisk(path: string): void {
    if (this.warnedDisk || !this.o.runsRoot || !existsSync(this.o.runsRoot)) return;
    this.warnedDisk = true;
    try {
      if (statSync(path).dev !== statSync(this.o.runsRoot).dev) this.warn(`${path} is on another disk than the run folders (${this.o.runsRoot}), so run clones copy its objects instead of linking them.`);
    } catch {
      // nothing to compare
    }
  }
}
