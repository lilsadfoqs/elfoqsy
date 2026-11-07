// GitHub as a code host, through the gh CLI the user is already logged in with (read-only calls only).
import type { GhReadOnly } from '../github/gh';
import { ciStatusOf, listOpen, ticketKeyOf, toPullRequest, view, type GhPullRequest } from '../github/prs';
import type { CodeHostAdapter, HostPullRequest } from './types';

export class GitHubHost implements CodeHostAdapter {
  readonly id = 'github';
  constructor(private readonly gh: GhReadOnly) {}

  async openPullRequests(repo: string, projects: readonly string[]): Promise<HostPullRequest[]> {
    const out: HostPullRequest[] = [];
    for (const pr of await listOpen(this.gh, repo)) {
      const ticket = ticketKeyOf(pr, [...projects]);
      if (ticket) out.push(toHost(repo, pr, ticket));
    }
    return out;
  }

  async pullRequest(repo: string, number: number, projects: readonly string[], fallbackTicket: string): Promise<HostPullRequest> {
    const pr = await view(this.gh, repo, number);
    return toHost(repo, pr, ticketKeyOf(pr, [...projects]) ?? fallbackTicket);
  }
}

function toHost(repo: string, pr: GhPullRequest, ticket: string): HostPullRequest {
  const status = ciStatusOf(pr.statusCheckRollup);
  return { pr: toPullRequest(repo, pr, ticket), ...(status ? { ci: { repo, pr: pr.number, sha: pr.headRefOid, status, url: `${pr.url}/checks` } } : {}) };
}
