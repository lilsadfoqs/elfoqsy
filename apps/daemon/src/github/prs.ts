// Alex's pull requests on the polled repositories, as the contract's PullRequest.
import type { PayloadOf, PullRequest } from '@elfoqsy/contracts';
import type { GhReadOnly } from './gh';

/** One entry of gh's statusCheckRollup: a check run or a commit status. */
export interface RollupItem {
  __typename?: string;
  status?: string; // check runs: QUEUED, IN_PROGRESS, COMPLETED, ...
  conclusion?: string | null; // check runs: SUCCESS, FAILURE, NEUTRAL, ...
  state?: string; // commit statuses: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED
}

export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  statusCheckRollup?: RollupItem[] | null;
  /** GitHub's review decision; empty when the repository does not require reviews or none has been given. */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '' | null;
}

export const PR_FIELDS = 'number,title,headRefName,headRefOid,isDraft,url,state,statusCheckRollup,reviewDecision';

export function listOpen(gh: GhReadOnly, repo: string): Promise<GhPullRequest[]> {
  return gh.json(['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
}

export function view(gh: GhReadOnly, repo: string, number: number): Promise<GhPullRequest> {
  return gh.json(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
}

/** The ticket a PR belongs to: a key in its branch name, else in its title. */
export function ticketKeyOf(pr: Pick<GhPullRequest, 'headRefName' | 'title'>, projects: string[]): string | null {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(${projects.join('|')})-(\\d+)(?![A-Za-z0-9])`, 'i');
  for (const text of [pr.headRefName, pr.title]) {
    const m = re.exec(text);
    if (m) return `${m[1]!.toUpperCase()}-${m[2]}`;
  }
  return null;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/** Rolls checks up the way GitHub does: any failure fails, anything unfinished is pending. */
export function checksOf(rollup: RollupItem[] | null | undefined): PullRequest['checks'] {
  const items = rollup ?? [];
  if (!items.length) return 'none';
  const outcome = (i: RollupItem) => (i.conclusion ?? i.state ?? '').toUpperCase();
  if (items.some((i) => FAILED.has(outcome(i)))) return 'failure';
  const unfinished = (i: RollupItem) =>
    i.status !== undefined ? i.status.toUpperCase() !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes((i.state ?? '').toUpperCase());
  if (items.some(unfinished)) return 'pending';
  return 'success';
}

/** The CI state for a ci.status event, or null when the PR has no checks. */
export function ciStatusOf(rollup: RollupItem[] | null | undefined): PayloadOf<'ci.status'>['status'] | null {
  const checks = checksOf(rollup);
  if (checks === 'none') return null;
  if (checks !== 'pending') return checks;
  return (rollup ?? []).some((i) => (i.status ?? '').toUpperCase() === 'IN_PROGRESS') ? 'running' : 'queued';
}

export function toPullRequest(repo: string, pr: GhPullRequest, ticket: string): PullRequest {
  const state: PullRequest['state'] =
    pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
  const review: PullRequest['review'] = pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : 'none';
  return { repo, number: pr.number, state, ticket, url: pr.url, checks: checksOf(pr.statusCheckRollup), ...(pr.title ? { title: pr.title } : {}), review };
}
