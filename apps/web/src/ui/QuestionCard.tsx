// A question for alex as a card : who asks, the question in one line, why in short points,
// the options as buttons with Elfoqsy's suggestion marked, the sources collapsed, and "Let Elfoqsy decide this kind next
// time". A tier-2 request gets the same card with Approve, Allow for this ticket and Deny. compact: the pane's version
// , the question and its options only. Status shows as a dot, never as a stripe.
import { useState } from 'react';
import type { SourceRef } from '@elfoqsy/contracts';
import { runLabel, type ApprovalView, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../state/workspace';
import { inline } from './Markdown';
import { AgentBadge } from './TicketBits';

interface Option {
  label: string;
  consequence: string;
  /** What answering with it sends. */
  answer: () => boolean;
}

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** A source as one short line. */
export const sourceText = (s: SourceRef): string => (s.label ? `${s.label}, ${s.ref}` : s.kind === 'setting' ? `your setting for ${s.ref.replace(/_/g, ' ')}` : s.ref);

/** The options a card offers: the agent's, or Approve, Allow for this ticket and Deny for a request. */
export function cardOptions(a: ApprovalView, precedent: () => boolean): Option[] {
  if (a.card) return a.card.options.map((o) => ({ label: o.label, consequence: o.consequence, answer: () => stream.answer(a.approvalId, 'answered', o.label, undefined, precedent()) }));
  if (a.kind === 'question') return [];
  return [
    { label: 'Approve', consequence: a.grantable ? 'This request runs now, once' : 'It runs now', answer: () => stream.answer(a.approvalId, 'approved', undefined, a.grantable ? 'once' : undefined, precedent()) },
    ...(a.grantable
      ? [{ label: 'Allow for this ticket', consequence: `This kind runs without asking on this ticket for 8 hours`, answer: () => stream.answer(a.approvalId, 'approved', undefined, 'ticket', precedent()) }]
      : []),
    { label: 'Deny', consequence: 'The agent is told no', answer: () => stream.answer(a.approvalId, 'denied') },
  ];
}

export function QuestionCard({ approval: a, state, compact }: { approval: ApprovalView; state: WorkspaceState; compact?: boolean }) {
  const [precedent, setPrecedent] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const run = state.runs[a.runId];
  const question = a.card?.question ?? (a.kind === 'question' ? a.question.replace(/^Agent \d+ on \S+ asks: /, '') : a.question);
  const options = cardOptions(a, () => precedent);
  const suggested = a.suggestion?.option;
  const sources = [...(a.card?.sources ?? []), ...(a.suggestion?.sources ?? [])];
  const why = a.card?.why ?? [];

  if (a.resolution) {
    const r = a.resolution;
    const what = r.withdrawn ? 'Withdrawn after 72 hours' : r.decision === 'answered' ? `Answered: ${r.answer}` : r.decision === 'approved' ? (r.scope === 'ticket' ? 'Allowed for this ticket' : 'Approved') : 'Denied';
    return (
      <div className={`qcard qcard--done${compact ? ' qcard--compact' : ''}`}>
        <span className="qcard-q qcard-q--done">{question}</span>
        <span className="qcard-resolved">
          {what}
          {r.test ? ' by the tester' : ''}, {hhmm(r.at)}
          {r.precedent ? '; Elfoqsy decides this kind from now on' : ''}
        </span>
      </div>
    );
  }

  return (
    <div className={`qcard${compact ? ' qcard--compact' : ''}`} role="group" aria-label={`Question from Agent ${run?.agentNumber ?? ''}`}>
      {compact ? (
        <span className="qcard-needs">
          <span className="needs-dot" aria-hidden="true" />
          needs you
        </span>
      ) : (
        <div className="qcard-head">
          {run && <AgentBadge run={run} size={26} />}
          <span className="qcard-who">{run ? `Agent ${run.agentNumber} · ${runLabel(run)}` : 'An agent'}</span>
          <span className="qcard-needs">
            <span className="needs-dot" aria-hidden="true" />
            needs you
          </span>
        </div>
      )}
      <b className="qcard-q">{question}</b>
      {!compact && why.length > 0 && (
        <ul className="qcard-why">
          {why.map((w, i) => (
            <li key={i}>{inline(w)}</li>
          ))}
        </ul>
      )}
      {!a.card && a.action && <code className="approval-action">{a.action}</code>}
      {options.length > 0 ? (
        <div className={`qcard-options qcard-options--${Math.min(options.length, 3)}`}>
          {options.map((o) => (
            <button key={o.label} type="button" className={`qcard-option${o.label === suggested ? ' qcard-option--suggested' : ''}`} onClick={() => o.answer()}>
              {compact ? (
                // In a pane, one line: "Per API key: matches the 429s in the ticket" .
                <span className="qcard-option-label">
                  {o.label}
                  {o.label === suggested && <span className="qcard-suggests"> · Elfoqsy suggests</span>}: <span className="qcard-option-consequence">{o.consequence}</span>
                </span>
              ) : (
                <>
                  <span className="qcard-option-label">
                    {o.label}
                    {o.label === suggested && <span className="qcard-suggests"> · Elfoqsy suggests</span>}
                  </span>
                  <span className="qcard-option-consequence">{o.consequence}</span>
                </>
              )}
            </button>
          ))}
        </div>
      ) : (
        <input
          className="approval-answer"
          type="text"
          aria-label="Your answer"
          placeholder="Type your answer and press Enter"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.trim() && stream.answer(a.approvalId, 'answered', typed.trim())) setTyped('');
          }}
        />
      )}
      {!compact && (
        <div className="qcard-foot">
          {(sources.length > 0 || a.suggestion || a.noSuggestion) && (
            <button type="button" className="qcard-sources-toggle" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(!sourcesOpen)}>
              {sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'Why'}
            </button>
          )}
          {a.precedentable && (
            <label className="qcard-precedent">
              <input type="checkbox" checked={precedent} onChange={(e) => setPrecedent(e.target.checked)} />
              Let Elfoqsy decide this kind next time
            </label>
          )}
        </div>
      )}
      {!compact && sourcesOpen && (
        <div className="qcard-sources">
          {a.suggestion && <p className="qcard-elf-why">Elfoqsy: {a.suggestion.why}</p>}
          {a.noSuggestion && <p className="qcard-elf-why">Elfoqsy has no suggestion: {a.noSuggestion}</p>}
          {sources.length > 0 && (
            <ul>
              {sources.map((s, i) => (
                <li key={i}>
                  <code className="source">{sourceText(s)}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
