// One sync of each source, written against the adapter interfaces (adapters/types.ts), so any tracker or code host
// plugs in. Both are read-only and all-or-nothing: a sync that fails part-way emits nothing, so a flaky page never
// removes tickets or PRs from the screens.
import type { PayloadOf, PullRequest } from '@elfoqsy/contracts';
import type { CodeHostAdapter, HostPullRequest, TrackerAdapter } from '../adapters/types';
import type { SyncTracker } from './tracker';

export async function syncTracker(adapter: TrackerAdapter, tracker: SyncTracker): Promise<void> {
  tracker.applyTickets(await adapter.currentTickets());
}

export async function syncCodeHost(host: CodeHostAdapter, repos: string[], projects: readonly string[], tracker: SyncTracker): Promise<void> {
  const open: HostPullRequest[] = [];
  for (const repo of repos) open.push(...(await host.openPullRequests(repo, projects)));

  // PRs the screens still show as open but the host no longer lists: look each up once to learn
  // whether it was merged or closed, so its moon goes away.
  const stillOpen = new Set(open.map(({ pr }) => `${pr.repo.toLowerCase()}#${pr.number}`));
  const finished: PullRequest[] = [];
  for (const known of tracker.openPrs(repos)) {
    if (stillOpen.has(`${known.repo.toLowerCase()}#${known.number}`)) continue;
    finished.push((await host.pullRequest(known.repo, known.number, projects, known.ticket)).pr);
  }

  tracker.applyPrs([...open.map((o) => o.pr), ...finished]);
  tracker.applyCi(open.flatMap((o): Array<PayloadOf<'ci.status'>> => (o.ci ? [o.ci] : [])));
}
