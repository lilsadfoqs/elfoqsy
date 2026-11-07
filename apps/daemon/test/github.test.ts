import { describe, expect, it, vi } from 'vitest';
import { GhError, GhReadOnly, assertReadOnly, ghEnv, summarizeCi, tailOf, type Exec } from '../src/github/gh';
import { checksOf, ciStatusOf, ticketKeyOf, toPullRequest, type GhPullRequest } from '../src/github/prs';

const REPOS = ['acme/shop-shared', 'acme/shop-local-deploy'];
const PROJECTS = ['SHOP', 'CORE'];

describe('gh: read-only allowlist', () => {
  it.each([
    [['auth', 'status']],
    [['pr', 'list', '--repo', 'acme/shop-shared', '--author', '@me', '--json', 'number']],
    [['pr', 'view', '159', '--repo', 'ACME/SHOP-SHARED', '--json', 'state']],
    [['pr', 'list', '--repo', 'acme/shop-local-deploy', '--json', 'number']], // same rules as every repo
    [['api', 'repos/acme/shop-shared/commits/abc/check-runs']],
    [['api', '-X', 'GET', '/repos/acme/shop-shared/pulls']],
    [['run', 'view', '123', '--repo', 'acme/shop-shared', '--log-failed']],
  ])('allows %j', (args) => {
    expect(() => assertReadOnly(args, REPOS)).not.toThrow();
  });

  it.each([
    [['auth', 'token']],
    [['auth', 'status', '--show-token']],
    [['pr', 'create', '--repo', 'acme/shop-shared']],
    [['pr', 'merge', '159', '--repo', 'acme/shop-shared']],
    [['pr', 'list', '--repo', 'someone/else']],
    [['pr', 'list']],
    [['pr', 'view', '159', '--repo', 'acme/shop-shared', '--web']],
    [['run', 'rerun', '1']],
    [['run', 'view', '123', '--repo', 'someone/else', '--log-failed']],
    [['run', 'view', '--repo', 'acme/shop-shared']],
    [['run', 'list', '--repo', 'acme/shop-shared']],
    [['workflow', 'run', 'deploy']],
    [['release', 'create', 'v1']],
    [['api', '-X', 'POST', 'repos/acme/shop-shared/pulls']],
    [['api', 'repos/acme/shop-shared/issues/1/comments', '-f', 'body=x']],
    [['api', 'graphql', '-f', 'query=mutation{}']],
    [['api', 'user']],
  ])('refuses %j', (args) => {
    expect(() => assertReadOnly(args, REPOS)).toThrow(GhError);
  });

  it('runs gh directly with a minimal environment: no tokens, no daemon secrets', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue({ stdout: '[]', stderr: '' });
    const gh = new GhReadOnly(REPOS, exec, {
      PATH: '/usr/bin',
      HOME: '/home/alex',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GH_TOKEN: 'should-not-pass',
      GITHUB_TOKEN: 'should-not-pass',
      JIRA_API_TOKEN: 'should-not-pass',
    });
    await gh.json(['pr', 'list', '--repo', REPOS[0]!, '--json', 'number']);
    const [file, args, options] = exec.mock.calls[0]!;
    expect(file).toBe('gh');
    expect(args).toEqual(['pr', 'list', '--repo', REPOS[0]!, '--json', 'number']);
    expect(options.env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/alex', GH_PROMPT_DISABLED: '1' });
    expect(Object.values(options.env)).not.toContain('should-not-pass');
  });

  it('never runs a refused command', async () => {
    const exec = vi.fn<Exec>();
    const gh = new GhReadOnly(REPOS, exec, {});
    await expect(gh.json(['pr', 'create', '--repo', REPOS[0]!])).rejects.toThrow(GhError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports a failed gh run without its output, redacted', async () => {
    const exec = vi.fn<Exec>().mockRejectedValue({ stderr: 'HTTP 401: Bad credentials (token ' + 'gh' + 'o_' + 'A'.repeat(36) + ')\nmore' });
    const gh = new GhReadOnly(REPOS, exec, {});
    const error = (await gh.json(['pr', 'list', '--repo', REPOS[0]!]).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^gh pr list failed: HTTP 401: Bad credentials/);
    expect(error.message).not.toContain('A'.repeat(36));
  });

  it('knows whether gh is logged in from the exit code', async () => {
    expect(await new GhReadOnly(REPOS, vi.fn<Exec>().mockResolvedValue({ stdout: '', stderr: '' }), {}).authenticated()).toBe(true);
    expect(await new GhReadOnly(REPOS, vi.fn<Exec>().mockRejectedValue({ code: 1 }), {}).authenticated()).toBe(false);
  });

  it('builds the gh environment from an allowlist', () => {
    expect(ghEnv({ HOME: '/h', GH_TOKEN: 'x', SECRET: 'y' })).toEqual({
      HOME: '/h',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      GH_PAGER: 'cat',
    });
  });
});

const pr = (overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 159,
  title: 'Remediate Black Duck findings',
  headRefName: 'feature/SHOP-3472-blackduck',
  headRefOid: 'abc123',
  isDraft: false,
  url: 'https://github.com/acme/shop-shared/pull/159',
  state: 'OPEN',
  statusCheckRollup: [],
  ...overrides,
});

describe('CI for one commit, as evidence for ci checks', () => {
  it('reads the commit’s check runs and statuses on the named repository', async () => {
    const exec = vi
      .fn<Exec>()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ statuses: [] }), stderr: '' });
    const got = await new GhReadOnly(REPOS, exec, {}).commitCi('acme/shop-shared', 'abc123');
    expect(exec.mock.calls.map((c) => c[1])).toEqual([
      ['api', 'repos/acme/shop-shared/commits/abc123/check-runs?per_page=100'],
      ['api', 'repos/acme/shop-shared/commits/abc123/status'],
    ]);
    expect(got).toEqual({ state: 'success', summary: '1 CI check passed' });
  });

  const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });
  it.each([
    ['nothing reported yet', [], [], { state: 'none', summary: 'no CI has reported on it yet' }],
    ['all passed, skipped and neutral count', [run('unit', 'completed', 'success'), run('lint', 'completed', 'skipped'), run('info', 'completed', 'neutral')], [{ context: 'jenkins', state: 'success' }], { state: 'success', summary: '4 CI checks passed' }],
    ['one still running', [run('unit', 'completed', 'success'), run('e2e', 'in_progress')], [], { state: 'pending', summary: 'still running: e2e' }],
    ['a pending status', [run('unit', 'completed', 'success')], [{ context: 'jenkins', state: 'pending' }], { state: 'pending', summary: 'still running: jenkins' }],
    ['a failure wins over pending', [run('unit', 'completed', 'failure'), run('e2e', 'queued')], [{ context: 'jenkins', state: 'error' }], { state: 'failure', summary: 'failed: unit, jenkins' }],
    ['cancelled and timed out fail', [run('unit', 'completed', 'cancelled'), run('e2e', 'completed', 'timed_out')], [], { state: 'failure', summary: 'failed: unit, e2e' }],
  ] as const)('%s', (_name, runs, statuses, expected) => {
    expect(summarizeCi([...runs], [...statuses])).toEqual(expected);
  });
});

describe('the failed CI log for an agent', () => {
  it('finds the failed Actions run at the commit and returns its failed steps, redacted, from the end', async () => {
    const token = 'gh' + 'p_' + 'B'.repeat(36);
    const lines = Array.from({ length: 300 }, (_, i) => `test\tRun jest\tline ${i + 1}`);
    lines[290] = `test\tRun jest\tAuthorization: token ${token}`;
    const exec = vi
      .fn<Exec>()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ workflow_runs: [{ id: 42, name: 'ci', html_url: 'https://github.com/o/r/actions/runs/42' }] }), stderr: '' })
      .mockResolvedValueOnce({ stdout: lines.join('\n') + '\n', stderr: '' });
    const gh = new GhReadOnly(REPOS, exec, {});
    const got = await gh.failedCiLog('acme/shop-shared', 'abc123', { lines: 20, lineChars: 400, chars: 16_000 });
    expect(exec.mock.calls.map((c) => c[1])).toEqual([
      ['api', 'repos/acme/shop-shared/actions/runs?head_sha=abc123&status=failure&per_page=5'],
      ['run', 'view', '42', '--repo', 'acme/shop-shared', '--log-failed'],
    ]);
    expect(got).toMatchObject({ workflow: 'ci', url: 'https://github.com/o/r/actions/runs/42' });
    expect(got!.log.split('\n')[0]).toBe('[280 earlier lines cut]');
    expect(got!.log).toContain('line 300');
    expect(got!.log).not.toContain('line 280\n');
    expect(got!.log).not.toContain(token);
  });

  it('returns null when no Actions run failed at that commit', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue({ stdout: '{"workflow_runs":[]}', stderr: '' });
    expect(await new GhReadOnly(REPOS, exec, {}).failedCiLog('acme/shop-shared', 'abc')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('keeps a log within its character budget and cuts very long lines', () => {
    const out = tailOf(['a'.repeat(1000), 'b'.repeat(50), 'c'.repeat(50)].join('\n'), { lines: 10, lineChars: 100, chars: 120 });
    expect(out).toBe(`[1 earlier lines cut]\n${'b'.repeat(50)}\n${'c'.repeat(50)}`);
  });
});

describe('pull requests', () => {
  it('links a PR to a ticket by the key in its branch, else its title', () => {
    expect(ticketKeyOf(pr(), PROJECTS)).toBe('SHOP-3472');
    expect(ticketKeyOf(pr({ headRefName: 'fix-limit', title: '[core-18891] raise the limit' }), PROJECTS)).toBe('CORE-18891');
    expect(ticketKeyOf(pr({ headRefName: 'feature/SHOP-3546', title: 'CORE-1 also' }), PROJECTS)).toBe('SHOP-3546');
    expect(ticketKeyOf(pr({ headRefName: 'chore/bump', title: 'Bump deps' }), PROJECTS)).toBeNull();
    expect(ticketKeyOf(pr({ headRefName: 'XSHOP-12', title: 'SHOP-123456x' }), PROJECTS)).toBeNull();
  });

  it('rolls up checks the way GitHub does', () => {
    expect(checksOf([])).toBe('none');
    expect(checksOf(null)).toBe('none');
    expect(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('success');
    expect(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(checksOf([{ state: 'PENDING' }])).toBe('pending');
    expect(checksOf([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failure');
    expect(checksOf([{ state: 'ERROR' }])).toBe('failure');
    expect(checksOf([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }])).toBe('success');
    expect(ciStatusOf([{ status: 'QUEUED' }])).toBe('queued');
    expect(ciStatusOf([{ status: 'IN_PROGRESS' }])).toBe('running');
    expect(ciStatusOf([])).toBeNull();
  });

  it('maps state, keeps the full owner/name, and marks drafts', () => {
    const repo = 'acme/shop-shared';
    expect(toPullRequest(repo, pr(), 'SHOP-3472')).toEqual({
      repo,
      number: 159,
      state: 'open',
      ticket: 'SHOP-3472',
      url: 'https://github.com/acme/shop-shared/pull/159',
      checks: 'none',
      title: pr().title,
      review: 'none',
    });
    // The review decision GitHub gives (N1: the narrative's hand-back shows it); none when nobody has reviewed.
    expect(toPullRequest(repo, pr({ reviewDecision: 'APPROVED' }), 'X-1').review).toBe('approved');
    expect(toPullRequest(repo, pr({ reviewDecision: 'CHANGES_REQUESTED' }), 'X-1').review).toBe('changes_requested');
    expect(toPullRequest(repo, pr({ reviewDecision: 'REVIEW_REQUIRED' }), 'X-1').review).toBe('review_required');
    expect(toPullRequest(repo, pr({ reviewDecision: '' }), 'X-1').review).toBe('none');
    expect(toPullRequest(repo, pr({ isDraft: true }), 'X-1').state).toBe('draft');
    expect(toPullRequest(repo, pr({ state: 'MERGED' }), 'X-1').state).toBe('merged');
    expect(toPullRequest(repo, pr({ state: 'CLOSED' }), 'X-1').state).toBe('closed');
  });
});
