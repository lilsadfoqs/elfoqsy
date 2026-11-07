// The orchestrator's git work. Alex's clones under REPOS_ROOT are only ever read: each run gets its
// own clones under WORKTREES_ROOT, seeded from his (no writes to /code, unlike git worktree, which
// writes into the main clone's .git). Only the orchestrator talks to GitHub, with his credentials;
// it pushes only the run's feature branch, never forced, never main or master.
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { redact } from '../redact';
import { repoDir } from './repoPolicy';

export type Exec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export class GitError extends Error {}

/** The one co-author line every agent commit carries, and the only one. */
export const TRAILER = "Co-Authored-By: Elfoqsy's Claude <noreply@anthropic.com>";
const CO_AUTHOR = /^\s*co-authored-by:/i;

/** What is wrong with a commit message's co-author lines, or null when it has exactly one and it is TRAILER. */
export function coAuthorProblem(message: string): string | null {
  const lines = message.split('\n').filter((l) => CO_AUTHOR.test(l));
  if (lines.length === 1 && lines[0] === TRAILER) return null;
  if (!lines.length) return 'no co-author line';
  return lines.length > 1 ? `${lines.length} co-author lines` : `"${lines[0]!.trim()}" instead`;
}

/** The message with every co-author line taken out and TRAILER added once, in its trailer block. */
export function withOnlyTrailer(message: string): string {
  const lines = message.replace(/\r\n/g, '\n').split('\n').filter((l) => !CO_AUTHOR.test(l));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  // The last paragraph is a trailer block when it is not the subject and every line is "Key: value".
  const blank = lines.findLastIndex((l) => !l.trim());
  const last = lines.slice(blank + 1);
  const block = blank > 0 && last.length > 0 && last.every((l) => /^[A-Za-z0-9-]+:\s/.test(l));
  return `${lines.join('\n')}${block ? '\n' : '\n\n'}${TRAILER}\n`;
}

const PROTECTED = /^(refs\/heads\/)?(main|master)$/;
/** Config the daemon's git always runs with, whatever a clone's own config says. */
const SAFE_CONFIG: Array<[key: string, value: string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
];

export class Git {
  constructor(
    private readonly exec: Exec = promisify(execFile) as unknown as Exec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * The daemon runs git in clones an agent can write to, outside the sandbox, with its own environment. What a clone's own
   * config or hooks name (core.fsmonitor, a hook) must never run there: these two are set at command scope, as `git -c` would,
   * so they win over the clone's config. (The sandbox keeps a shell from writing them in the first place; this is the second
   * layer, for whatever that misses.) Found by a review: a core.fsmonitor in .git/config ran under the daemon's plain git status.
   */
  private environment(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv };
    const taken = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
    SAFE_CONFIG.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${taken + i}`] = key;
      env[`GIT_CONFIG_VALUE_${taken + i}`] = value;
    });
    env.GIT_CONFIG_COUNT = String(taken + SAFE_CONFIG.length);
    return env;
  }

  /** trim: false keeps the output byte for byte, as a commit object must be. */
  async run(args: string[], timeout = 120_000, extraEnv: Record<string, string> = {}, trim = true): Promise<string> {
    try {
      const { stdout } = await this.exec('git', args, {
        env: this.environment(extraEnv),
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      });
      return trim ? stdout.trim() : stdout;
    } catch (error) {
      const e = error as { stderr?: string; message?: string };
      throw new GitError(`git ${args.find((a) => !a.startsWith('-') && a !== '-C' && !a.startsWith('/')) ?? ''} failed: ${redact((e.stderr || e.message || '').trim().split('\n').slice(-2).join(' '))}`);
    }
  }

  async tryRun(args: string[]): Promise<string | null> {
    try {
      return await this.run(args);
    } catch {
      return null;
    }
  }
}

export interface LocalClone {
  repo: string;
  path: string;
  url: string;
  defaultBranch: string;
  identity: { name: string; email: string } | null;
}

/** owner/name from a GitHub remote URL (ssh or https). */
export function repoFromUrl(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Finds Alex's main clone of each wanted repository under REPOS_ROOT, by its origin URL. Worktrees are
 * skipped. Read-only git queries only. The identity is what git uses in that clone (his includeIf for
 * /code), so agents commit as he does there, not as his personal identity elsewhere.
 */
export async function discoverClones(git: Git, reposRoot: string, wanted: string[]): Promise<Map<string, LocalClone>> {
  const want = new Map(wanted.map((r) => [r.toLowerCase(), r]));
  const found = new Map<string, LocalClone>();
  const dirs = readdirSync(reposRoot)
    .map((d) => join(reposRoot, d))
    .filter((d) => {
      try {
        return statSync(join(d, '.git')).isDirectory(); // a worktree has a .git file instead
      } catch {
        return false;
      }
    })
    .sort();
  for (const dir of dirs) {
    const url = await git.tryRun(['-C', dir, 'remote', 'get-url', 'origin']);
    const repo = url ? repoFromUrl(url) : null;
    const name = repo ? want.get(repo.toLowerCase()) : undefined;
    if (!url || !name) continue;
    const existing = found.get(name);
    // Prefer the folder named like the repository when several clones share an origin.
    if (existing && existing.path.endsWith(`/${repoDir(name)}`)) continue;
    const head = await git.tryRun(['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const userName = await git.tryRun(['-C', dir, 'config', '--get', 'user.name']);
    const userEmail = await git.tryRun(['-C', dir, 'config', '--get', 'user.email']);
    found.set(name, {
      repo: name,
      path: dir,
      url,
      defaultBranch: head?.replace(/^origin\//, '') || 'master',
      identity: userName && userEmail ? { name: userName, email: userEmail } : null,
    });
  }
  return found;
}

export interface PreparedRepo {
  repo: string;
  path: string;
  role: 'target' | 'dependency';
  base: string;
  /** For targets: the feature branch already existed on GitHub when the run started. */
  branchOnRemote?: boolean;
  /** For targets: the GitHub remote. */
  url?: string;
  /** For targets: the kept run folder clone its branch was started from, instead of GitHub. */
  seededFrom?: string;
}

/**
 * Does the run's branch in Alex's own clone hold work GitHub lacks? Read-only. Its tip counts as on GitHub
 * when it is the branch's head there, or when any remote branch his clone knows contains it.
 */
export async function localBranchBusy(git: Git, clone: LocalClone, branch: string, remoteSha: string | null): Promise<string | null> {
  const local = await git.tryRun(['-C', clone.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!local || local === remoteSha) return null;
  if (await git.tryRun(['-C', clone.path, 'for-each-ref', '--contains', local, '--count=1', '--format=%(refname)', 'refs/remotes/'])) return null;
  return `${branch} exists in ${clone.path} with work that is not on GitHub. Finish or push it there first.`;
}

export async function remoteBranchSha(git: Git, url: string, branch: string): Promise<string | null> {
  const out = await git.run(['ls-remote', '--heads', url, `refs/heads/${branch}`], 60_000);
  return out.split(/\s+/)[0] || null;
}

/**
 * In a run clone's .git while its agent's run is working, and only then: the window the "who made it" timing
 * rule gives an agent. The commit-msg hook gives TRAILER to commits made inside it and leaves others alone.
 */
const AGENT_RUN = 'elfoqsy-agent-run';

/** The run has ended: commits made in its clones from now on are not its agent's (alex's, in a kept folder). */
export function agentRunEnded(runRoot: string): void {
  if (!existsSync(runRoot)) return;
  // Only its clones: the sandbox leaves files such as .bash_profile in the run folder while a command runs (probe P2,
  // where removing a marker under one ended the daemon).
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      rmSync(join(runRoot, entry.name, '.git', AGENT_RUN), { force: true });
    } catch {
      // not a clone
    }
  }
}

/** Whether a commit is an agent's, by the "who made it" timing rule; only an agent's must carry TRAILER. */
export type AgentMade = (commit: { committedAt: number; email: string }) => boolean;
const everyCommit: AgentMade = () => true;

// An agent's commit: every other co-author line goes, Claude Code's own included, and TRAILER is added once.
const COMMIT_MSG_HOOK = `#!/bin/sh
# Added by the Elfoqsy orchestrator. While an agent's run works in this clone, its commits carry exactly one
# co-author line, this one. Any other commit, such as alex's in a kept folder, is left as it is.
[ -f "$(git rev-parse --absolute-git-dir)/${AGENT_RUN}" ] || exit 0
grep -v -i '^[[:space:]]*co-authored-by:' "$1" > "$1.elfoqsy"
mv "$1.elfoqsy" "$1"
git interpret-trailers --in-place --trailer "${TRAILER}" "$1"
`;

/**
 * A clone of a repository the run changes, on the run's branch, with only GitHub as its remote. With `seed`
 * (a kept run folder's clone of the same repository), the branch starts from that clone's branch instead,
 * which must contain the branch as it is on GitHub, so no pushed commit is lost.
 */
/**
 * A target clone in the run folder on the run branch: the branch from GitHub when it is there, else new from the base
 * (the repository's default branch, or another such as release/2.22.0 for a hotfix), or from a kept run's clone (seed).
 */
export async function prepareTarget(git: Git, clone: LocalClone, runRoot: string, branch: string, seed?: string, base = clone.defaultBranch): Promise<PreparedRepo> {
  if (PROTECTED.test(branch)) throw new GitError(`Refusing to work on ${branch}.`);
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith('-') || base.includes('..')) throw new GitError(`${base} is not a branch name.`);
  const dest = join(runRoot, repoDir(clone.repo));
  const remoteSha = await remoteBranchSha(git, clone.url, branch);
  await git.run(['clone', '--quiet', '--no-checkout', '--origin', 'local', clone.path, dest]);
  await git.run(['-C', dest, 'remote', 'add', 'origin', clone.url]);
  const refspecs = [`+refs/heads/${clone.defaultBranch}:refs/remotes/origin/${clone.defaultBranch}`];
  if (base !== clone.defaultBranch) refspecs.push(`+refs/heads/${base}:refs/remotes/origin/${base}`);
  if (remoteSha) refspecs.push(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  await git.run(['-C', dest, 'fetch', '--quiet', 'origin', ...refspecs], 300_000);
  let start = remoteSha ? `origin/${branch}` : `origin/${base}`;
  if (seed) {
    const seeded = `refs/seed/${branch}`;
    await git.run(['-C', dest, 'fetch', '--quiet', seed, `+refs/heads/${branch}:${seeded}`]);
    if (remoteSha && (await git.tryRun(['-C', dest, 'merge-base', '--is-ancestor', `origin/${branch}`, seeded])) === null) {
      throw new GitError(`${branch} in ${seed} does not contain ${branch} as it is on GitHub; starting from it would drop pushed commits.`);
    }
    start = seeded;
  }
  // -C: cloning from his clone may already have created the branch (if it is checked out there).
  await git.run(['-C', dest, 'switch', '--quiet', '--no-track', '-C', branch, start]);
  if (seed) await git.run(['-C', dest, 'update-ref', '-d', `refs/seed/${branch}`]);
  await git.run(['-C', dest, 'remote', 'remove', 'local']);
  const hooks = join(dest, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), COMMIT_MSG_HOOK);
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  writeFileSync(join(dest, '.git', AGENT_RUN), `${runRoot}\n`);
  return { repo: clone.repo, path: dest, role: 'target', base, branchOnRemote: remoteSha !== null, url: clone.url, ...(seed ? { seededFrom: seed } : {}) };
}

/** A read-only sibling the setup scripts need, at the default branch of Alex's clone, with no remote. */
export async function prepareDependency(git: Git, clone: LocalClone, runRoot: string): Promise<PreparedRepo> {
  const dest = join(runRoot, repoDir(clone.repo));
  await git.run(['clone', '--quiet', '--no-checkout', '--origin', 'local', clone.path, dest]);
  const ref = (await git.tryRun(['-C', dest, 'rev-parse', '--verify', '--quiet', `refs/remotes/local/${clone.defaultBranch}`]))
    ? `local/${clone.defaultBranch}`
    : 'local/HEAD';
  await git.run(['-C', dest, 'switch', '--quiet', '--detach', ref]);
  await git.run(['-C', dest, 'remote', 'remove', 'local']);
  return { repo: clone.repo, path: dest, role: 'dependency', base: clone.defaultBranch };
}

/** The commits a push of the run's branch would carry: those GitHub does not have yet. */
async function pushRange(git: Git, repo: PreparedRepo, branch: string): Promise<string> {
  const remote = (await git.tryRun(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) ? `origin/${branch}` : `origin/${repo.base}`;
  return `${remote}..refs/heads/${branch}`;
}

/** Commits on the run's branch that GitHub does not have yet. */
export async function unpushedCount(git: Git, repo: PreparedRepo, branch: string): Promise<number> {
  return Number(await git.run(['-C', repo.path, 'rev-list', '--count', await pushRange(git, repo, branch)])) || 0;
}

/** An agent's commits a push would carry whose co-author lines are not exactly TRAILER, once; oldest first. Others are not checked. */
export async function wrongCoAuthors(git: Git, repo: PreparedRepo, branch: string, agentMade: AgentMade = everyCommit): Promise<Array<{ sha: string; subject: string; problem: string }>> {
  const out = await git.run(['-C', repo.path, 'log', '--reverse', '-z', '--abbrev=7', '--format=%h%x00%ct%x00%ae%x00%B', await pushRange(git, repo, branch)]);
  const fields = out.split('\0');
  const wrong: Array<{ sha: string; subject: string; problem: string }> = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const sha = fields[i]!.trim();
    const message = fields[i + 3]!;
    if (!sha || !agentMade({ committedAt: Number(fields[i + 1]) * 1000, email: fields[i + 2]! })) continue;
    const problem = coAuthorProblem(message);
    if (problem) wrong.push({ sha, subject: message.split('\n')[0]!, problem });
  }
  return wrong;
}

const SIGNATURE = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

/**
 * Rewrites the messages of an agent's commits a push would carry so each has exactly one co-author line,
 * TRAILER. Only commits GitHub lacks are touched; trees, authors and dates stay as they were, and any other
 * commit keeps its message byte for byte (a later one gets a new id only because its parent did). Returns how
 * many messages changed.
 */
export async function fixCoAuthors(git: Git, repo: PreparedRepo, branch: string, agentMade: AgentMade = everyCommit): Promise<number> {
  const range = await pushRange(git, repo, branch);
  const oldHead = await git.run(['-C', repo.path, 'rev-parse', `refs/heads/${branch}`]);
  const shas = (await git.run(['-C', repo.path, 'rev-list', '--reverse', '--topo-order', range])).split('\n').filter(Boolean);
  const msgFile = join(await git.run(['-C', repo.path, 'rev-parse', '--absolute-git-dir']), 'ELFOQSY_COMMIT_MSG');
  const rewritten = new Map<string, string>();
  let fixed = 0;
  try {
    for (const sha of shas) {
      const raw = await git.run(['-C', repo.path, 'cat-file', 'commit', sha], 120_000, {}, false);
      const split = raw.indexOf('\n\n');
      const headers = (split < 0 ? raw : raw.slice(0, split)).split('\n');
      const message = split < 0 ? '' : raw.slice(split + 2);
      const value = (key: string) => headers.filter((h) => h.startsWith(`${key} `)).map((h) => h.slice(key.length + 1));
      const parents = value('parent');
      const newParents = parents.map((p) => rewritten.get(p) ?? p);
      const [author, committer] = [value('author')[0], value('committer')[0]].map((s) => SIGNATURE.exec(s ?? ''));
      if (!author || !committer) throw new GitError(`Could not read who made ${sha.slice(0, 7)}.`);
      const ok = !agentMade({ committedAt: Number(committer[3]) * 1000, email: author[2]! }) || coAuthorProblem(message) === null;
      if (ok && newParents.every((p, i) => p === parents[i])) {
        rewritten.set(sha, sha);
        continue;
      }
      if (!ok) fixed++;
      writeFileSync(msgFile, ok ? message : withOnlyTrailer(message));
      const created = await git.run(['-C', repo.path, 'commit-tree', value('tree')[0]!, ...newParents.flatMap((p) => ['-p', p]), '-F', msgFile], 120_000, {
        GIT_AUTHOR_NAME: author[1]!,
        GIT_AUTHOR_EMAIL: author[2]!,
        GIT_AUTHOR_DATE: `@${author[3]} ${author[4]}`,
        GIT_COMMITTER_NAME: committer[1]!,
        GIT_COMMITTER_EMAIL: committer[2]!,
        GIT_COMMITTER_DATE: `@${committer[3]} ${committer[4]}`,
      });
      rewritten.set(sha, created);
    }
  } finally {
    rmSync(msgFile, { force: true });
  }
  const newHead = rewritten.get(oldHead) ?? oldHead;
  // Only if the branch has not moved meanwhile; the files are the same, so a checked-out branch stays clean.
  if (newHead !== oldHead) await git.run(['-C', repo.path, 'update-ref', `refs/heads/${branch}`, newHead, oldHead]);
  return fixed;
}

/** Commits on the run's branch that GitHub lacks, newest first, with when they were committed and by which identity. */
export async function unpushedLog(git: Git, repo: PreparedRepo, branch: string): Promise<Array<{ sha: string; subject: string; committedAt: number; email: string }>> {
  const out = await git.run(['-C', repo.path, 'log', '--abbrev=7', '--format=%h%x09%ct%x09%ae%x09%s', await pushRange(git, repo, branch)]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', ct = '0', email = '', ...subject] = line.split('\t');
      return { sha, subject: subject.join('\t'), committedAt: Number(ct) * 1000, email };
    });
}

/** Commits on a branch that GitHub lacks, newest first, in a clone of a run folder that was kept. */
export async function unpushedCommits(git: Git, path: string, branch: string, base: string): Promise<Array<{ sha: string; subject: string }>> {
  const remote = (await git.tryRun(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) ? `origin/${branch}` : `origin/${base}`;
  const out = await git.run(['-C', path, 'log', '--abbrev=7', '--format=%h%x09%s', `${remote}..refs/heads/${branch}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', ...subject] = line.split('\t');
      return { sha, subject: subject.join('\t') };
    });
}

/**
 * Pushes the run's branch, as itself, without force. Only the orchestrator calls this, after approval, and
 * never with an agent's commit whose co-author lines are not exactly TRAILER.
 */
export async function pushBranch(git: Git, repo: PreparedRepo, branch: string, agentMade: AgentMade = everyCommit): Promise<void> {
  if (repo.role !== 'target') throw new GitError(`${repo.repo} is a read-only dependency of this run.`);
  if (PROTECTED.test(branch)) throw new GitError(`Never push to ${branch}.`);
  const wrong = await wrongCoAuthors(git, repo, branch, agentMade);
  if (wrong.length) throw new GitError(`Not pushed: ${wrong.map((w) => `${w.sha} has ${w.problem}`).join('; ')}. Every commit needs exactly one co-author line: ${TRAILER}`);
  // To the URL the workspace recorded for this repository, not to whatever "origin" says in a clone an agent can write to
  // (a remote, or an insteadOf, set in its config would send the push, with his credentials, somewhere else).
  const target = repo.url ?? 'origin';
  await git.run(['-C', repo.path, 'push', '--quiet', '--no-verify', target, `refs/heads/${branch}:refs/heads/${branch}`], 300_000);
  await git.tryRun(['-C', repo.path, 'fetch', '--quiet', target, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/**
 * The content of a clone's working tree: its tracked and untracked files (not ignored ones), as the hash
 * of the git tree they would make. Any change to them, however it was made, changes it. Built in a
 * private index inside the clone's .git, so the clone's own index and history are never touched.
 */
export async function treeFingerprint(git: Git, path: string): Promise<string> {
  const gitDir = await git.run(['-C', path, 'rev-parse', '--absolute-git-dir']);
  const index = join(gitDir, 'elfoqsy-fingerprint-index');
  // Starting from the real index lets git reuse its file stats instead of hashing every file again.
  if (existsSync(join(gitDir, 'index'))) copyFileSync(join(gitDir, 'index'), index);
  const env = { GIT_INDEX_FILE: index };
  await git.run(['-C', path, 'add', '--all', '--', '.'], 300_000, env);
  return git.run(['-C', path, 'write-tree'], 120_000, env);
}

/** The tree of a commit, to compare with a fingerprint: equal means the working tree is exactly that commit. */
export function commitTree(git: Git, path: string, sha: string): Promise<string | null> {
  return git.tryRun(['-C', path, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
}

/** Uncommitted changes in a clone: edits, new files, or a stash. */
export async function hasChanges(git: Git, path: string): Promise<boolean> {
  if ((await git.run(['-C', path, 'status', '--porcelain'])).length > 0) return true;
  return (await git.tryRun(['-C', path, 'rev-parse', '--verify', '--quiet', 'refs/stash'])) !== null;
}

/** Uncommitted changes in a run clone. */
export const isDirty = (git: Git, repo: PreparedRepo): Promise<boolean> => hasChanges(git, repo.path);

/**
 * The git environment of an agent session: it can commit as Alex's /code identity, but it cannot
 * reach GitHub with his credentials. GIT_CONFIG_* entries act like `git -c` and override anything the
 * agent writes into a repo's config: no credential helper, an SSH command that refuses.
 */
export function agentGitEnv(identity: { name: string; email: string } | null): Record<string, string> {
  const refuse = "sh -c 'echo \"Agents cannot reach GitHub with git. Run git push: the orchestrator pushes after alex approves.\" >&2; exit 1'";
  return {
    GIT_SSH_COMMAND: refuse,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.sshCommand',
    GIT_CONFIG_VALUE_1: refuse,
    ...(identity
      ? {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        }
      : {}),
  };
}

export const runFolderExists = (path: string): boolean => existsSync(path);
