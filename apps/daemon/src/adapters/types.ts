// The two extension points of the sync layer. A tracker adapter turns an issue tracker (Jira, Linear, GitHub Issues...)
// into the contract's Ticket; a code-host adapter turns a code host (GitHub, GitLab, Bitbucket...) into the contract's
// PullRequest and CI status. The sync logic in sync/sources.ts only talks to these interfaces, so a new tracker or
// host is one file that implements them, registered in adapters/index.ts. Both are read-only: nothing here writes.
import type { PayloadOf, PullRequest, Ticket } from '@elfoqsy/contracts';

export interface TrackerAdapter {
  /** A short id for logs and the sync.* events, e.g. "jira". */
  readonly id: string;
  /** The ticket keys' prefixes this tracker owns (SHOP in SHOP-123): code-host adapters link PRs to tickets with them. */
  readonly projects: readonly string[];
  /**
   * Every ticket of the current iteration (the open sprints, cycles or milestones) that the screens should show.
   * All or nothing: throw when any page fails, so a partial read never removes tickets from the screens.
   */
  currentTickets(): Promise<Ticket[]>;
}

/** One pull or merge request as a code host sees it, already mapped to the contract. */
export interface HostPullRequest {
  pr: PullRequest;
  /** Its head commit's CI status, when the host reports one. */
  ci?: PayloadOf<'ci.status'>;
}

export interface CodeHostAdapter {
  /** A short id for logs and the sync.* events, e.g. "github". */
  readonly id: string;
  /**
   * The open pull requests of one repository that belong to a ticket of `projects` (by key in branch or title).
   * One without a ticket key is not returned: every PR on the screens belongs to a ticket.
   */
  openPullRequests(repo: string, projects: readonly string[]): Promise<HostPullRequest[]>;
  /** One pull request by number, open or not: how a PR that left the open list is learned to be merged or closed. */
  pullRequest(repo: string, number: number, projects: readonly string[], fallbackTicket: string): Promise<HostPullRequest>;
}
