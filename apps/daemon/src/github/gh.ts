// The daemon's reads from GitHub: Alex's logged-in gh CLI, run directly (no shell), read-only. It may
// read PRs, their checks and the failed steps' log of a CI run on polled repositories, and nothing
// else: no writes, no `gh auth token`, no other repositories. Writes go through the gh proxy (permissions/gh.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from '../redact';

export type Exec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as Exec;

export class GhError extends Error {}

/**
 * gh gets only what it needs to find Alex's login (home, XDG dirs, the keyring's D-Bus session) and
 * to reach GitHub. Tokens in the environment would override the keyring login, so none are passed,
 * and neither are the daemon's own secrets.
 */
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'GH_CONFIG_DIR', 'GH_HOST',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
];

export function ghEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
  for (const name of PASS_THROUGH) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// gh api flags that take a value, so the endpoint is the first argument that is neither.
const API_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview', '-f', '-F', '--field', '--raw-field', '--input']);

function apiEndpoint(args: string[]): string {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (API_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return '';
}

/** Throws unless args are a read this milestone allows on a polled repository. */
export function assertReadOnly(args: string[], repos: string[]): void {
  const refuse = (why: string): never => {
    throw new GhError(`gh ${args.slice(0, 2).join(' ')} refused: ${why}`);
  };
  const [group = '', verb = ''] = args;
  if (group === 'auth') {
    if (verb === 'status' && args.length === 2) return;
    refuse('only `gh auth status` is allowed');
  }
  if (args.some((a) => a === '--web' || a === '-w')) refuse('no browser');

  if (group === 'pr') {
    if (verb !== 'list' && verb !== 'view') refuse('pull requests are read-only in this milestone');
    const i = args.indexOf('--repo');
    const repo = i >= 0 ? args[i + 1] : undefined;
    if (!repo || !repos.some((r) => sameRepo(r, repo))) refuse('not a polled repository');
    return;
  }
  if (group === 'run') {
    if (verb !== 'view' || !/^\d+$/.test(args[2] ?? '')) refuse('only `gh run view <id>` is allowed');
    const i = args.indexOf('--repo');
    const repo = i >= 0 ? args[i + 1] : undefined;
    if (!repo || !repos.some((r) => sameRepo(r, repo))) refuse('not a polled repository');
    return;
  }
  if (group === 'api') {
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if ((a === '-X' || a === '--method') && args[i + 1]?.toUpperCase() !== 'GET') refuse('GET only');
      if (/^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^(--field|--raw-field|--input)=/.test(a)) {
        refuse('request bodies would make it a write');
      }
    }
    const endpoint = apiEndpoint(args);
    // Code search, only when every repo: qualifier names a polled repository and nothing widens it.
    if (/^\/?search\/code\?/.test(endpoint)) {
      const q = new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1)).get('q') ?? '';
      const named = [...q.matchAll(/\brepo:(\S+)/g)].map((m) => m[1]!);
      if (!named.length || named.some((r) => !repos.some((p) => sameRepo(p, r)))) refuse('code search must name polled repositories');
      if (/\b(org|user):/.test(q)) refuse('code search must name polled repositories');
      return;
    }
    const repo = /^\/?repos\/([^/]+\/[^/?]+)/.exec(endpoint)?.[1];
    if (!repo || !repos.some((r) => sameRepo(r, repo))) refuse('not a polled repository');
    return;
  }
  refuse('not on the read-only allowlist');
}

export interface CiLog {
  workflow: string;
  url: string;
  log: string;
}

export const CI_LOG_LIMITS = { lines: 150, lineChars: 400, chars: 16_000 };

/** The end of a log: failures are near the bottom. Says how much was cut. */
export function tailOf(text: string, limits = CI_LOG_LIMITS): string {
  const all = text.replace(/\r/g, '').split('\n').map((l) => (l.length > limits.lineChars ? `${l.slice(0, limits.lineChars)} [cut]` : l));
  while (all.length && !all.at(-1)!.trim()) all.pop();
  let lines = all.slice(-limits.lines);
  while (lines.length > 1 && lines.join('\n').length > limits.chars) lines = lines.slice(1);
  const cut = all.length - lines.length;
  return `${cut ? `[${cut} earlier lines cut]\n` : ''}${lines.join('\n')}`;
}

export interface CommitCi {
  state: 'success' | 'failure' | 'pending' | 'none';
  summary: string;
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

/** Check runs and commit statuses as one verdict: any failure fails it, anything unfinished keeps it pending. */
export function summarizeCi(
  runs: Array<{ name: string; status: string; conclusion: string | null }>,
  statuses: Array<{ context: string; state: string }>,
): CommitCi {
  const all = [
    ...runs.map((r) => ({ name: r.name, outcome: r.status !== 'completed' ? 'pending' : PASSING.has(r.conclusion ?? '') ? 'ok' : 'failed' })),
    ...statuses.map((s) => ({ name: s.context, outcome: s.state === 'success' ? 'ok' : s.state === 'pending' ? 'pending' : 'failed' })),
  ];
  if (!all.length) return { state: 'none', summary: 'no CI has reported on it yet' };
  const named = (outcome: string) => all.filter((a) => a.outcome === outcome).map((a) => a.name);
  if (named('failed').length) return { state: 'failure', summary: `failed: ${named('failed').join(', ')}` };
  if (named('pending').length) return { state: 'pending', summary: `still running: ${named('pending').join(', ')}` };
  return { state: 'success', summary: `${all.length} CI check${all.length === 1 ? '' : 's'} passed` };
}

/** A review by a bot: Copilot, the repository's AI PR review, or any GitHub App. */
const isBot = (user: { login?: string; type?: string } | null | undefined): boolean => !!user && (user.type === 'Bot' || /\[bot\]$/i.test(user.login ?? '') || /copilot/i.test(user.login ?? ''));

/** Bot-review rounds: the commits a bot reviewed, each counted once. A human's review is not a bot round. */
export function botRounds(reviews: Array<{ user?: { login?: string; type?: string } | null; commit_id?: string | null }>): number {
  return new Set(reviews.filter((r) => isBot(r.user) && r.commit_id).map((r) => r.commit_id)).size;
}

export class GhReadOnly {
  constructor(
    private readonly repos: string[],
    private readonly exec: Exec = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Whether gh is installed and logged in. Only the exit code is used; the output is not kept. */
  async authenticated(): Promise<boolean> {
    try {
      await this.run(['auth', 'status']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The failed steps' log of the failed GitHub Actions run at a commit, redacted, then cut to its last
   * lines. null when no Actions run failed there (the failing check comes from elsewhere).
   */
  async failedCiLog(repo: string, sha: string, limits = CI_LOG_LIMITS): Promise<CiLog | null> {
    const { workflow_runs: runs } = await this.json<{ workflow_runs: Array<{ id: number; name: string; html_url: string }> }>([
      'api',
      `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&status=failure&per_page=5`,
    ]);
    const run = runs[0];
    if (!run) return null;
    const raw = await this.run(['run', 'view', String(run.id), '--repo', repo, '--log-failed']);
    return { workflow: run.name, url: run.html_url, log: tailOf(redact(raw), limits) };
  }

  /**
   * What CI says about one commit: its check runs and its commit statuses together. Evidence for ci checks,
   * so a pushed branch proves its CI with or without a pull request.
   */
  async commitCi(repo: string, sha: string): Promise<CommitCi> {
    const runs = await this.json<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>([
      'api',
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    ]);
    const statuses = await this.json<{ statuses: Array<{ context: string; state: string }> }>(['api', `repos/${repo}/commits/${sha}/status`]);
    return summarizeCi(runs.check_runs, statuses.statuses);
  }

  /** How many bot-review rounds a PR has had, from its reviews. */
  async botReviewRounds(repo: string, number: number): Promise<number> {
    const reviews = await this.json<Array<{ user?: { login?: string; type?: string } | null; commit_id?: string | null }>>(['api', `repos/${repo}/pulls/${number}/reviews?per_page=100`]);
    return botRounds(reviews);
  }

  async json<T>(args: string[]): Promise<T> {
    const stdout = await this.run(args);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} returned something that is not JSON`);
    }
  }

  private async run(args: string[]): Promise<string> {
    assertReadOnly(args, this.repos);
    try {
      const { stdout } = await this.exec('gh', args, { env: ghEnv(this.env), timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const e = error as { stderr?: string; message?: string; code?: string | number };
      const detail = (e.stderr || e.message || String(e.code ?? 'failed')).trim().split('\n')[0] ?? 'failed';
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${redact(detail)}`);
    }
  }
}
