// A pull request in the ticket view, with its CI.
import type { PullRequest } from '@elfoqsy/contracts';
import { ciFailing, prKey, type WorkspaceState } from '@elfoqsy/state';
import { StateIcon } from '../../ui/Icons';
import { prStateIcon } from '../../ui/linkIcons';

/**
 * A pull request and its CI. A failure stays red here and on the map even once dismissed; Dismiss only
 * stops it counting as broken until the next CI result.
 */
export function PrLine({ state, pr, onDismiss }: { state: WorkspaceState; pr: PullRequest; onDismiss: () => void }) {
  const key = prKey(pr);
  const failing = ciFailing(state, pr);
  const status = state.ci[key]?.status ?? (pr.checks === 'none' ? undefined : pr.checks);
  const dismissed = state.ciDismissed[key];
  const ci = failing ? 'CI failed' : status === 'success' ? 'CI passed' : status === 'pending' || status === 'running' || status === 'queued' ? 'CI running' : undefined;
  return (
    <span className="pr-line">
      <StateIcon name={prStateIcon(pr.state)} />
      <a href={pr.url || undefined} target="_blank" rel="noreferrer">
        {pr.repo.split('/')[1]} #{pr.number}
      </a>{' '}
      {pr.state}
      {ci && (
        <>
          <StateIcon name={failing ? 'ci-failed' : status === 'success' ? 'ci-passed' : 'ci-running'} />
          {ci}
        </>
      )}
      {failing && dismissed && <span className="pr-dismissed">dismissed until its next CI result</span>}
      {failing && !dismissed && (pr.state === 'open' || pr.state === 'draft') && (
        <button type="button" className="button-outline pr-dismiss" data-tip="It stops counting as broken until the next CI result; the PR stays red. Nothing reaches GitHub." onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </span>
  );
}

