// The weekly review in the chat: the week's numbers and at most three suggestions, from review.weekly, or
// a correction of them (review.corrected). A superseded review keeps its numbers and says so.
import { reviewByRef, type WorkspaceState } from '@elfoqsy/state';
import { inline } from '../../ui/Markdown';

const MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

/** The week's numbers and at most three suggestions; monochrome, the numbers to read, not to look at. */
export function ReviewBlock({ state, reviewId }: { state: WorkspaceState; reviewId: string }) {
  const review = reviewByRef(state, reviewId);
  if (!review) return <div className="block block--missing">That weekly review is not in the workspace any more.</div>;
  const m = review.metrics;
  const n = (k: string) => m[k] ?? 0;
  const tokens = n('tokens') >= 1_000_000 ? `${(n('tokens') / 1_000_000).toFixed(1)}M` : `${Math.round(n('tokens') / 1000)}k`;
  const rows: Array<[string, string]> = [
    ['Runs', `${n('runs')}: ${n('succeeded')} succeeded, ${n('failed')} failed, ${n('stopped')} stopped, ${n('cancelled')} cancelled`],
    ['Time', `${n('workingMinutes')} min working, ${n('waitingMinutes')} waiting for you, ${n('pausedMinutes')} paused`],
    ['Tokens', tokens],
    ['Sub-agents', `${n('subagents')}: ${n('subagentsFailed')} failed, ${n('subagentsCancelled')} cancelled`],
    ['CI', `${n('ciFailures')} failures, ${n('retries')} retries`],
    ['Interventions', String(n('interventions'))],
    ['Checks without evidence', String(n('evidenceMissing'))],
  ];
  // Per ticket against alex's team-dev baseline (reviews from v1.2.1 on).
  if (m.ticketsWorked !== undefined && n('ticketsWorked') > 0) {
    rows.push([
      'Per ticket',
      `${n('activeHoursPerTicket')} active h, ${n('interventionsPerTicket')} interventions over ${n('ticketsWorked')} ticket${n('ticketsWorked') === 1 ? '' : 's'}; team-dev alone: ${n('baselineHoursPerTicket')} h, ${n('baselineInterventionsPerTicket')}`,
    ]);
  }
  return (
    <div className={`block block--review${review.supersededAt ? ' block--superseded' : ''}`}>
      <span className="block-title">
        Weekly review{m.periodStart && m.periodEnd ? `, ${MONTH.format(m.periodStart)} to ${MONTH.format(m.periodEnd)}` : ''}
        {review.revision > 1 ? ', corrected' : ''}
      </span>
      {review.supersededAt ? (
        <span className="review-note">Superseded by a correction on {MONTH.format(review.supersededAt)}; nothing counts these numbers any more.</span>
      ) : null}
      <dl className="review-numbers">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {review.suggestions.length > 0 ? (
        <ol className="review-suggestions">
          {review.suggestions.map((x, i) => (
            <li key={i}>{inline(x)}</li>
          ))}
        </ol>
      ) : (
        <span className="review-none">{review.withdrawn?.length ? 'No suggestions stand.' : 'No suggestions this week.'}</span>
      )}
      {review.withdrawn?.map((x, i) => (
        <span key={i} className="review-note">
          Withdrawn: {x}
        </span>
      ))}
    </div>
  );
}

