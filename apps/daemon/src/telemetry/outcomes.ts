// Each run's outcome, kept beside its spans so the two join by run id: how it ended, its
// verdict, its ticket's PRs (merged, closed or open), the PRs' bot review rounds (read from GitHub once a PR is merged or
// closed), and whether the ticket was reopened after it (Done or Released, then open again). Kept up to date from the
// event log as it happens, and filled for every run already in the state when the daemon starts.
import type { AnyEnvelope } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import type { Outcome, TelemetryStore } from './store';

const FINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled']);
const DONE = new Set(['Done', 'Released']);

/** What the state says of a run's outcome (not its review rounds nor a reopening, which come from what happens later). */
export function outcomeOf(s: WorkspaceState, runId: string): Outcome | undefined {
  const run = s.runs[runId];
  if (!run) return undefined;
  const prs = Object.values(s.prs).filter((p) => p.ticket === run.ticket);
  const prState = !prs.length ? undefined : prs.some((p) => p.state === 'merged') ? 'merged' : prs.every((p) => p.state === 'closed') ? 'closed' : prs.some((p) => p.state === 'draft') && !prs.some((p) => p.state === 'open') ? 'draft' : 'open';
  return {
    runId,
    ticket: run.ticket,
    agentKind: run.task ? 'task' : 'ticket',
    agentNumber: run.agentNumber,
    ...(FINAL.has(run.state) ? { endState: run.state } : {}),
    ...(run.verdict ? { verdict: run.verdict.verdict } : {}),
    ...(prState ? { prState } : {}),
  };
}

export interface WatchOptions {
  store: Pick<TelemetryStore, 'upsertOutcome'>;
  state: () => WorkspaceState;
  onEvent: (listener: (previous: WorkspaceState, event: AnyEnvelope, next: WorkspaceState) => void) => () => void;
  /** Bot review rounds of one PR, read from GitHub (gh.botReviewRounds); absent, rounds stay unknown. */
  reviewRounds?: (repo: string, number: number) => Promise<number>;
  now?: () => number;
}

export function watchOutcomes(o: WatchOptions): () => void {
  const now = o.now ?? Date.now;
  const put = (s: WorkspaceState, runId: string) => {
    const out = outcomeOf(s, runId);
    if (out) o.store.upsertOutcome(out, now());
  };
  for (const runId of Object.keys(o.state().runs)) put(o.state(), runId);
  return o.onEvent((previous, event, next) => {
    const p = event.payload as { runId?: unknown };
    if (typeof p.runId === 'string' && next.runs[p.runId]) put(next, p.runId);
    if (event.type === 'pr.synced') {
      const pr = event.payload.pr;
      const runs = Object.values(next.runs).filter((r) => r.ticket === pr.ticket);
      for (const r of runs) put(next, r.runId);
      const was = previous.prs[`${pr.repo}#${pr.number}`]?.state;
      // Once, when the PR is merged or closed: its review rounds, added up over the ticket's finished PRs.
      if ((pr.state === 'merged' || pr.state === 'closed') && was !== pr.state && o.reviewRounds && runs.length) {
        const finished = Object.values(next.prs).filter((x) => x.ticket === pr.ticket && (x.state === 'merged' || x.state === 'closed'));
        void Promise.all(finished.map((x) => o.reviewRounds!(x.repo, x.number).catch(() => 0))).then((counts) => {
          const rounds = counts.reduce((a, b) => a + b, 0);
          for (const r of runs) o.store.upsertOutcome({ runId: r.runId, reviewRounds: rounds }, now());
        });
      }
    }
    if (event.type === 'ticket.synced') {
      const key = event.payload.ticket.key;
      const before = previous.tickets[key]?.status;
      const after = next.tickets[key]?.status;
      if (before && after && DONE.has(before) && !DONE.has(after)) {
        for (const r of Object.values(next.runs).filter((x) => x.ticket === key)) o.store.upsertOutcome({ runId: r.runId, reopened: true }, now());
      }
    }
  });
}
