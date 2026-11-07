// Real git in a temporary folder: a bare repository plays GitHub, a clone plays Alex's /code clone.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalClone } from '../../src/agents/git';

export interface GitWorld {
  root: string;
  remote: string;
  clone: LocalClone;
  reposRoot: string;
  worktrees: string;
  git: (cwd: string, ...args: string[]) => string;
  cleanup: () => void;
}

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function gitWorld(repo = 'acme/shop-api', cloneDir = 'shop-api'): GitWorld {
  const root = mkdtempSync(join(tmpdir(), 'elfoqsy-git-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
  const remote = join(root, 'github', `${repo}.git`);
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--quiet', '--bare', '--initial-branch=master');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=master');
  writeFileSync(join(seed, 'README.md'), '# shop-api\n');
  writeFileSync(join(seed, 'CLAUDE.md'), '# Notes for agents\nRun the unit tests.\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'first');
  git(seed, 'push', '--quiet', remote, 'master');
  const reposRoot = join(root, 'code');
  mkdirSync(reposRoot);
  const path = join(reposRoot, cloneDir);
  git(reposRoot, 'clone', '--quiet', remote, path);
  const worktrees = join(root, 'worktrees');
  mkdirSync(worktrees);
  return {
    root,
    remote,
    reposRoot,
    worktrees,
    clone: { repo, path, url: remote, defaultBranch: 'master', identity: { name: 'Alex Rivera', email: 'alex@example.com' } },
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const gitEnv = ENV;
