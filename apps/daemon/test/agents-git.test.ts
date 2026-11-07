import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Git,
  agentGitEnv,
  TRAILER,
  agentRunEnded,
  coAuthorProblem,
  commitTree,
  discoverClones,
  fixCoAuthors,
  isDirty,
  localBranchBusy,
  prepareDependency,
  prepareTarget,
  pushBranch,
  repoFromUrl,
  treeFingerprint,
  unpushedCount,
  withOnlyTrailer,
  wrongCoAuthors,
} from '../src/agents/git';
import { loadRepoPolicies } from '../src/agents/repoPolicy';
import { REPO_ROOT } from '../src/config';
import { neverGh } from '../src/permissions/backends';
import { gitEnv, gitWorld, type GitWorld } from './helpers/realGit';

let world: GitWorld;
const git = new Git(undefined, gitEnv);

beforeEach(() => {
  world = gitWorld();
});
afterEach(() => world.cleanup());

const refs = (path: string) => world.git(path, 'for-each-ref', '--format=%(refname) %(objectname)');

describe('finding Alex’s clones', () => {
  it('reads owner/name from ssh and https remotes', () => {
    expect(repoFromUrl('git@github.com:acme/shop-worker.git')).toBe('acme/shop-worker');
    expect(repoFromUrl('https://github.com/acme/shop-local-deploy')).toBe('acme/shop-local-deploy');
    expect(repoFromUrl('/tmp/x/repo.git')).toBeNull();
  });

  it('finds main clones by origin, skips worktrees, and reads default branch and identity', async () => {
    const url = 'git@github.com:acme/shop-api.git';
    world.git(world.clone.path, 'remote', 'set-url', 'origin', url);
    world.git(world.clone.path, 'config', 'user.name', 'Alex Rivera');
    world.git(world.clone.path, 'config', 'user.email', 'alex@example.com');
    world.git(world.clone.path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    world.git(world.clone.path, 'worktree', 'add', '--quiet', join(world.reposRoot, 'shop-api-3472'), '-b', 'feature/SHOP-3472');
    const found = await discoverClones(git, world.reposRoot, ['acme/shop-api', 'acme/shop-infra']);
    expect([...found.keys()]).toEqual(['acme/shop-api']);
    expect(found.get('acme/shop-api')).toEqual({
      repo: 'acme/shop-api',
      path: world.clone.path,
      url,
      defaultBranch: 'master',
      identity: { name: 'Alex Rivera', email: 'alex@example.com' },
    });
  });
});

describe('a run’s own clones', () => {
  it('seeds a target clone from Alex’s clone without changing it, on the run branch, with only GitHub as remote', async () => {
    const before = refs(world.clone.path);
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    expect(refs(world.clone.path)).toBe(before);
    expect(world.git(repo.path, 'branch', '--show-current')).toBe('feature/SHOP-3546');
    expect(world.git(repo.path, 'remote')).toBe('origin');
    expect(repo).toMatchObject({ role: 'target', base: 'master', branchOnRemote: false });
    expect(readFileSync(join(repo.path, '.git', 'hooks', 'commit-msg'), 'utf8')).toContain("Co-Authored-By: Elfoqsy's Claude <noreply@anthropic.com>");
  });

  it('starts from the existing remote branch when there is one', async () => {
    world.git(world.clone.path, 'switch', '--quiet', '-c', 'feature/SHOP-3546');
    writeFileSync(join(world.clone.path, 'a.txt'), 'a');
    world.git(world.clone.path, 'add', '.');
    world.git(world.clone.path, 'commit', '--quiet', '-m', 'wip');
    world.git(world.clone.path, 'push', '--quiet', 'origin', 'feature/SHOP-3546');
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    expect(repo.branchOnRemote).toBe(true);
    expect(existsSync(join(repo.path, 'a.txt'))).toBe(true);
  });

  it('starts from a kept run folder’s branch only when it contains the branch as it is on GitHub', async () => {
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    const commit = (path: string, file: string) => {
      writeFileSync(join(path, file), file);
      execFileSync('git', ['add', '.'], { cwd: path, env });
      execFileSync('git', ['commit', '--quiet', '-m', file], { cwd: path, env });
    };
    const kept = await prepareTarget(git, world.clone, join(world.worktrees, 'kept'), 'feature/SHOP-3546');
    commit(kept.path, 'kept.ts');
    const seeded = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546', kept.path);
    expect(seeded).toMatchObject({ seededFrom: kept.path, branchOnRemote: false });
    expect(existsSync(join(seeded.path, 'kept.ts'))).toBe(true);
    expect(world.git(seeded.path, 'for-each-ref', 'refs/seed')).toBe(''); // nothing left of the fetch
    expect(world.git(seeded.path, 'remote')).toBe('origin');
    // Once GitHub has a commit the kept branch lacks, starting from it would drop that commit.
    await pushBranch(git, seeded, 'feature/SHOP-3546');
    const other = await prepareTarget(git, world.clone, join(world.worktrees, 'other'), 'feature/SHOP-3546');
    commit(other.path, 'pushed.ts');
    await pushBranch(git, other, 'feature/SHOP-3546');
    await expect(prepareTarget(git, world.clone, join(world.worktrees, 'run2'), 'feature/SHOP-3546', kept.path)).rejects.toThrow(/would drop pushed commits/);
  });

  it('commits as the /code identity with the trailer, pushes only the run branch, and never master', async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    writeFileSync(join(repo.path, 'fix.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo.path, env });
    execFileSync('git', ['commit', '--quiet', '-m', 'Lift error_code'], { cwd: repo.path, env });
    expect(world.git(repo.path, 'log', '-1', '--format=%an <%ae>%n%B')).toBe(
      "Alex Rivera <alex@example.com>\nLift error_code\n\nCo-Authored-By: Elfoqsy's Claude <noreply@anthropic.com>",
    );
    expect(await unpushedCount(git, repo, 'feature/SHOP-3546')).toBe(1);
    expect(await isDirty(git, repo)).toBe(false);

    // The agent's own git cannot reach the remote over SSH: the env command refuses.
    expect(() => execFileSync('git', ['push', 'git@github.com:acme/shop-api.git', 'HEAD'], { cwd: repo.path, env, stdio: 'pipe' })).toThrow(
      /Agents cannot reach GitHub/,
    );

    await pushBranch(git, repo, 'feature/SHOP-3546');
    expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toContain('feature/SHOP-3546');
    expect(await unpushedCount(git, repo, 'feature/SHOP-3546')).toBe(0);
    await expect(pushBranch(git, repo, 'master')).rejects.toThrow(/Never push to master/);
    await expect(prepareTarget(git, world.clone, join(world.worktrees, 'run2'), 'main')).rejects.toThrow(/Refusing/);
  });

  it('keeps exactly one co-author line, Elfoqsy’s, whatever the agent or Claude Code wrote', async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    const commit = (message: string, ...args: string[]) => {
      writeFileSync(join(repo.path, 'f.ts'), `${message.length}${Math.random()}\n`);
      execFileSync('git', ['add', '.'], { cwd: repo.path, env });
      execFileSync('git', ['commit', '--quiet', ...args, '-m', message], { cwd: repo.path, env });
      return world.git(repo.path, 'log', '-1', '--format=%B');
    };
    expect(commit('Lift error_code\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nco-authored-by: Sam <sam@example.com>\nSigned-off-by: N <n@example.com>')).toBe(
      `Lift error_code\n\nSigned-off-by: N <n@example.com>\n${TRAILER}`,
    );
    expect(commit(`Again\n\n${TRAILER}\n${TRAILER}`)).toBe(`Again\n\n${TRAILER}`);
    expect(commit('Amended', '--amend')).toBe(`Amended\n\n${TRAILER}`);
    expect(commit('Body\n\nWhy it changed.')).toBe(`Body\n\nWhy it changed.\n\n${TRAILER}`);
    // Once the run has ended, a commit there is alex's: the hook leaves it as he wrote it. The sandbox's files in
    // the run folder (a .bash_profile while a command runs) are passed over, not taken for clones (probe P2).
    writeFileSync(join(world.worktrees, 'run', '.bash_profile'), '');
    mkdirSync(join(world.worktrees, 'run', '.tmp'), { recursive: true });
    expect(() => agentRunEnded(join(world.worktrees, 'run'))).not.toThrow();
    expect(commit("His note\n\nCo-Authored-By: alex' Claude <noreply@anthropic.com>")).toBe("His note\n\nCo-Authored-By: alex' Claude <noreply@anthropic.com>");
    expect(commit('Plain')).toBe('Plain');
  });

  it('reads a message’s co-author lines, and gives it exactly TRAILER', () => {
    expect(coAuthorProblem(`x\n\n${TRAILER}\n`)).toBeNull();
    expect(coAuthorProblem('x\n')).toBe('no co-author line');
    expect(coAuthorProblem(`x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n${TRAILER}\n`)).toBe('2 co-author lines');
    expect(coAuthorProblem('x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n')).toBe('"Co-Authored-By: Claude <noreply@anthropic.com>" instead');
    expect(coAuthorProblem(`x\n\n${TRAILER} \n`)).not.toBeNull(); // exactly that text
    expect(withOnlyTrailer('Subject only')).toBe(`Subject only\n\n${TRAILER}\n`);
    expect(withOnlyTrailer('S\n\nProse.\n\nSigned-off-by: N <n@x>\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n')).toBe(`S\n\nProse.\n\nSigned-off-by: N <n@x>\n${TRAILER}\n`);
    expect(withOnlyTrailer('S\n\nCo-authored-by: A <a@x>')).toBe(`S\n\n${TRAILER}\n`);
  });

  it('pushes only commits with exactly one co-author line, and fixes the others in the run clone, never pushed ones', async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const at = (n: number) => `@${1_791_600_000 + n} +0700`;
    const commit = (file: string, message: string, n: number, hook = true) => {
      const env = { ...process.env, ...agentGitEnv(world.clone.identity), GIT_AUTHOR_DATE: at(n), GIT_COMMITTER_DATE: at(n + 1) };
      writeFileSync(join(repo.path, file), `${file}\n`);
      execFileSync('git', ['add', '.'], { cwd: repo.path, env });
      execFileSync('git', ['commit', '--quiet', ...(hook ? [] : ['--no-verify']), '-m', message], { cwd: repo.path, env });
    };
    commit('a.ts', 'Pushed one', 1);
    await pushBranch(git, repo, 'feature/SHOP-3546');
    const pushed = world.git(repo.path, 'rev-parse', 'HEAD');
    commit('b.ts', 'Two lines\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Claude <noreply@anthropic.com>', 10, false);
    commit('c.ts', 'None at all', 20, false);
    commit('d.ts', 'Right', 30);
    const before = world.git(repo.path, 'log', '--format=%T %an %ae %ad %cn %ce %cd', '--date=raw', '-4');
    expect((await wrongCoAuthors(git, repo, 'feature/SHOP-3546')).map((w) => [w.subject, w.problem])).toEqual([
      ['Two lines', '2 co-author lines'],
      ['None at all', 'no co-author line'],
    ]);
    await expect(pushBranch(git, repo, 'feature/SHOP-3546')).rejects.toThrow(/Not pushed: .* has 2 co-author lines; .* has no co-author line/);
    expect(world.git(world.remote, 'rev-parse', 'feature/SHOP-3546')).toBe(pushed);

    expect(await fixCoAuthors(git, repo, 'feature/SHOP-3546')).toBe(2);
    expect(await wrongCoAuthors(git, repo, 'feature/SHOP-3546')).toEqual([]);
    expect(world.git(repo.path, 'log', '--format=%T %an %ae %ad %cn %ce %cd', '--date=raw', '-4')).toBe(before); // files, who and when
    expect(world.git(repo.path, 'rev-parse', 'HEAD~3')).toBe(pushed); // GitHub's commit is not rewritten
    expect(world.git(repo.path, 'log', '--format=%B', '-3')).toBe(`Right\n\n${TRAILER}\n\nNone at all\n\n${TRAILER}\n\nTwo lines\n\n${TRAILER}`);
    expect(await isDirty(git, repo)).toBe(false);
    await pushBranch(git, repo, 'feature/SHOP-3546');
    expect(world.git(world.remote, 'log', '--format=%(trailers:key=Co-Authored-By)', 'feature/SHOP-3546')).toBe(Array(4).fill(TRAILER).join('\n\n'));
  });

  it('checks and fixes only an agent’s commits: alex’s keep their messages byte for byte, before or after the agent’s', async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const his = "His note\n\nCo-Authored-By: alex' Claude <noreply@anthropic.com>\n";
    const commit = (file: string, message: string, at: number) => {
      const env = { ...process.env, ...agentGitEnv(world.clone.identity), GIT_AUTHOR_DATE: `@${at} +0700`, GIT_COMMITTER_DATE: `@${at} +0700` };
      writeFileSync(join(repo.path, file), `${file}\n`);
      execFileSync('git', ['add', '.'], { cwd: repo.path, env });
      execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', message], { cwd: repo.path, env });
      return world.git(repo.path, 'rev-parse', 'HEAD');
    };
    const object = (sha: string) => world.git(repo.path, 'cat-file', 'commit', sha).replace(/^parent .*\n/gm, '');
    // The timing rule, as the run gives it: commits from second 2000 on are the agent's.
    const agentMade = ({ committedAt }: { committedAt: number }) => committedAt >= 2_000_000;

    const hisFirst = commit('a.ts', his, 1000);
    commit('b.ts', 'SHOP-3546: carry provider errors\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', 2000);
    const hisAfter = commit('c.ts', his, 1500); // dated before the agent's work, so his
    const before = object(hisAfter);
    expect((await wrongCoAuthors(git, repo, 'feature/SHOP-3546', agentMade)).map((w) => w.problem)).toEqual(['"Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" instead']);
    await expect(pushBranch(git, repo, 'feature/SHOP-3546', agentMade)).rejects.toThrow(/has "Co-Authored-By: Claude Opus 5.5/);

    expect(await fixCoAuthors(git, repo, 'feature/SHOP-3546', agentMade)).toBe(1);
    expect(world.git(repo.path, 'rev-parse', 'HEAD~2')).toBe(hisFirst); // before the agent's: the very same commit
    expect(world.git(repo.path, 'log', '-1', '--format=%B', 'HEAD~1')).toBe(`SHOP-3546: carry provider errors\n\n${TRAILER}`);
    expect(world.git(repo.path, 'rev-parse', 'HEAD')).not.toBe(hisAfter); // after it: a new parent, and nothing else
    expect(object('HEAD')).toBe(before);
    expect(await wrongCoAuthors(git, repo, 'feature/SHOP-3546', agentMade)).toEqual([]);
    await pushBranch(git, repo, 'feature/SHOP-3546', agentMade);
    expect(world.git(world.remote, 'log', '-1', '--format=%B', 'feature/SHOP-3546')).toBe(his.trim());
  });

  it('copies dependencies read-only, with no remote to push to', async () => {
    const dep = await prepareDependency(git, world.clone, join(world.worktrees, 'run'));
    expect(world.git(dep.path, 'remote')).toBe('');
    await expect(pushBranch(git, dep, 'feature/SHOP-3546')).rejects.toThrow(/read-only dependency/);
  });

  it('refuses a branch Alex has unpushed work on in his own clone, not one whose commit a remote branch has', async () => {
    // As SHOP-1164 was: the local branch only points at a commit already on master.
    world.git(world.clone.path, 'switch', '--quiet', '-c', 'feature/SHOP-3472');
    expect(await localBranchBusy(git, world.clone, 'feature/SHOP-3472', null)).toBeNull();
    expect(await localBranchBusy(git, world.clone, 'feature/SHOP-3472', 'some-other-sha')).toBeNull();
    writeFileSync(join(world.clone.path, 'wip.txt'), 'wip');
    world.git(world.clone.path, 'add', '.');
    world.git(world.clone.path, 'commit', '--quiet', '-m', 'wip');
    expect(await localBranchBusy(git, world.clone, 'feature/SHOP-3472', null)).toMatch(/not on GitHub/);
    // Pushed to any branch, it is on GitHub.
    world.git(world.clone.path, 'push', '--quiet', 'origin', 'feature/SHOP-3472:refs/heads/elsewhere');
    expect(await localBranchBusy(git, world.clone, 'feature/SHOP-3472', null)).toBeNull();
    expect(await localBranchBusy(git, world.clone, 'feature/SHOP-9', null)).toBeNull();
  });

  it('gives agents no credential helper and an SSH command that refuses, even over repo config', () => {
    const env = agentGitEnv(null);
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'core.sshCommand',
    });
    const dir = join(world.root, 'probe');
    mkdirSync(dir);
    world.git(dir, 'init', '--quiet');
    world.git(dir, 'config', 'credential.helper', 'store');
    // An empty helper read last (command scope, from the env) clears every helper before it.
    const helper = execFileSync('git', ['config', '--show-scope', '--get-all', 'credential.helper'], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
    expect(helper.split('\n').filter(Boolean).at(-1)).toBe('command\t');
  });
});

describe('the fingerprint of a run’s code', () => {
  it('is the content of tracked and untracked files, however they changed, and leaves the clone’s own index alone', async () => {
    const path = world.clone.path;
    const clean = await treeFingerprint(git, path);
    expect(clean).toBe(await commitTree(git, path, 'HEAD')); // a clean tree is exactly its commit
    expect(await treeFingerprint(git, path)).toBe(clean); // reading it changes nothing
    const index = join(path, '.git', 'index');
    const indexBefore = statSync(index).mtimeMs;

    writeFileSync(join(path, 'README.md'), '# shop-api, edited\n');
    const edited = await treeFingerprint(git, path);
    expect(edited).not.toBe(clean);
    writeFileSync(join(path, 'new.ts'), 'export {};\n');
    const added = await treeFingerprint(git, path);
    expect(added).not.toBe(edited);
    writeFileSync(join(path, '.gitignore'), 'build/\n');
    const ignoring = await treeFingerprint(git, path);
    mkdirSync(join(path, 'build'));
    writeFileSync(join(path, 'build', 'out.js'), 'x');
    expect(await treeFingerprint(git, path)).toBe(ignoring); // ignored files are not the code
    rmSync(join(path, 'new.ts'));
    expect(await treeFingerprint(git, path)).not.toBe(ignoring);

    expect(statSync(index).mtimeMs).toBe(indexBefore);
    expect(world.git(path, 'status', '--porcelain')).toContain('?? .gitignore'); // still untracked: nothing was staged
    expect(world.git(path, 'diff', '--cached', '--name-only')).toBe('');
  });
});

describe('the repositories agents work in', () => {
  const policies = loadRepoPolicies(resolve(REPO_ROOT, 'config', 'agent-repos.json'));

  it('covers every repository in GITHUB_REPOS', () => {
    expect(Object.keys(policies).sort()).toEqual([
      'acme/shop-api',
      'acme/shop-infra',
      'acme/shop-local-deploy',
      'acme/shop-shared',
      'acme/shop-worker',
    ]);
  });

  it('says nothing about approvals for tests: every test in the run folder is free', () => {
    for (const p of Object.values(policies)) expect(p.notes).not.toMatch(/need (Alex's |alex's )?approval/i);
  });
});

describe('the last guard before gh runs', () => {
  it.each([
    [['pr', 'create', '--repo', 'acme/shop-api', '--head', 'feature/SHOP-3546', '--draft']],
    [['pr', 'view', '7', '--repo', 'acme/shop-api']],
    [['run', 'rerun', '123', '--repo', 'acme/shop-local-deploy', '--failed']],
    [['secret', 'list', '--repo', 'acme/shop-api']],
  ])('lets %j through', (args) => {
    expect(neverGh(args)).toBeNull();
  });

  it.each([
    [['pr', 'merge', '7', '--repo', 'acme/shop-api']],
    [['pr', 'merge', '--repo', 'acme/shop-api', '7']],
    [['pr', 'create', '--auto', '--repo', 'acme/shop-api']],
    [['release', 'create', 'v1', '--repo', 'acme/shop-api']],
    [['repo', 'delete', 'acme/shop-api']],
    [['auth', 'token']],
    [['secret', 'set', 'X', '--repo', 'acme/shop-api']],
  ])('refuses %j', (args) => {
    expect(neverGh(args)).toMatch(/^gh refused/);
  });
});

// The daemon runs git in a run's clone, which an agent can write to, outside the sandbox and with its own environment. Whatever the
// clone's config or hooks name must not run there. Found by a review: a core.fsmonitor in .git/config ran under a plain git status.
describe('the daemon’s own git does not run what a clone names', () => {
  const HOOKS = ['pre-push', 'reference-transaction', 'post-checkout', 'post-commit', 'post-merge'];

  const planted = async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    // The agent's own commit first, with its hook: that is the agent's git, in its sandbox.
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    writeFileSync(join(repo.path, 'work.ts'), 'work\n');
    execFileSync('git', ['add', '.'], { cwd: repo.path, env });
    execFileSync('git', ['commit', '--quiet', '-m', 'Lift error_code'], { cwd: repo.path, env });
    // Then what it could plant: hooks, and a core.fsmonitor in .git/config. Each touches a marker.
    const marks = mkdtempSync(join(tmpdir(), 'elfoqsy-marks-'));
    const plant = (name: string, path: string) => {
      writeFileSync(path, `#!/bin/sh\ntouch '${join(marks, name)}'\nexit 0\n`);
      chmodSync(path, 0o755);
    };
    for (const hook of HOOKS) plant(hook, join(repo.path, '.git', 'hooks', hook));
    plant('fsmonitor', join(repo.path, '.git', 'fsmon.sh'));
    execFileSync('git', ['-C', repo.path, 'config', 'core.fsmonitor', join(repo.path, '.git', 'fsmon.sh')], { env: gitEnv });
    return { repo, marks };
  };

  it('runs no hook and no fsmonitor of the clone, in status, add, a switch, update-ref, the fingerprint and the push', async () => {
    const { repo, marks } = await planted();
    try {
      // The control: plain git, as the daemon used to run it, does run the fsmonitor of the clone.
      execFileSync('git', ['-C', repo.path, 'status', '--porcelain'], { env: gitEnv, stdio: 'ignore' });
      expect(readdirSync(marks), 'the vector exists in this git: a plain status runs the clone’s fsmonitor').toContain('fsmonitor');
      for (const m of readdirSync(marks)) rmSync(join(marks, m));

      await isDirty(git, repo);
      await treeFingerprint(git, repo.path);
      await unpushedCount(git, repo, 'feature/SHOP-3546');
      await git.run(['-C', repo.path, 'switch', '--quiet', '-c', 'scratch']);
      await git.run(['-C', repo.path, 'update-ref', 'refs/heads/scratch2', 'HEAD']);
      await git.run(['-C', repo.path, 'switch', '--quiet', 'feature/SHOP-3546']);
      await pushBranch(git, repo, 'feature/SHOP-3546');
      expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toContain('feature/SHOP-3546'); // it did push
      expect(readdirSync(marks)).toEqual([]);
    } finally {
      rmSync(marks, { recursive: true, force: true });
    }
  });

  it('keeps what the environment already says to git, and adds to it', async () => {
    const seen: string[] = [];
    const spy = new Git(async (_file, _args, o) => {
      seen.push(JSON.stringify(Object.entries(o.env).filter(([k]) => k.startsWith('GIT_CONFIG_'))));
      return { stdout: '', stderr: '' };
    }, { ...gitEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' });
    await spy.run(['status']);
    const env = Object.fromEntries(JSON.parse(seen[0]!) as Array<[string, string]>);
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null' });
  });

  it('pushes to the URL the workspace recorded, not to where a remote in the clone’s config now points', async () => {
    const repo = await prepareTarget(git, world.clone, join(world.worktrees, 'run'), 'feature/SHOP-3546');
    const env = { ...process.env, ...agentGitEnv(world.clone.identity) };
    writeFileSync(join(repo.path, 'work.ts'), 'work\n');
    execFileSync('git', ['add', '.'], { cwd: repo.path, env });
    execFileSync('git', ['commit', '--quiet', '-m', 'Lift error_code'], { cwd: repo.path, env });
    const elsewhere = mkdtempSync(join(tmpdir(), 'elfoqsy-elsewhere-'));
    try {
      execFileSync('git', ['init', '--quiet', '--bare', elsewhere], { env: gitEnv });
      execFileSync('git', ['-C', repo.path, 'remote', 'set-url', 'origin', elsewhere], { env: gitEnv });
      await pushBranch(git, repo, 'feature/SHOP-3546');
      expect(world.git(world.remote, 'branch', '--list', 'feature/SHOP-3546')).toContain('feature/SHOP-3546');
      expect(world.git(elsewhere, 'branch', '--list')).toBe('');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
