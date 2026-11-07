// Terminal pane v3 (screenshots 01, 03 and 04): prose first, as Markdown at reading size; each tool call one
// light line (its tile, name, arguments in muted mono, status and duration) with a one-line result under it; three or
// more calls in a row as one chip that opens on click (a failed call never joins one); the verdict as a status line;
// Elfoqsy's answers with Change; a question for alex as its card. No card backgrounds, no guide lines, no stripes:
// status is an icon or a dot. The log scrolls freely, follows new entries at the bottom, and offers Latest when up.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { sameOption, type DecisionView, type WorkspaceState } from '@elfoqsy/state';
import { ART } from '../../ui/elfoqsy';
import { CodeBlock, DiffLines, diffRows, inline, Markdown } from '../../ui/Markdown';
import { QuestionCard, sourceText } from '../../ui/QuestionCard';
import { ToolTile } from '../../ui/ToolTile';
import { stream } from '../../state/workspace';
import { cardDuration, diffRange, type CallEntry, type PaneEntry } from './feed';

/** Undo for a change recorded before it ran: what it puts back is in its title; once used, it says so. */
export function UndoButton({ change }: { change: { recordId: string; undo?: string; noUndo?: string; undone: boolean } }) {
  if (change.undone) return <span className="ln-undone">undone</span>;
  if (!change.undo) return null;
  return (
    <button type="button" className="ln-undo" data-tip={change.undo} aria-label={`Undo: ${change.undo}`} onClick={() => stream.undo(change.recordId)}>
      Undo
    </button>
  );
}

export function StatusMark({ status }: { status: CallEntry['status'] }) {
  switch (status) {
    case 'done':
      return (
        <svg className="mark mark--done" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="done">
          <path d="m5 12 4.5 4.5L19 7" />
        </svg>
      );
    case 'failed':
    case 'denied':
      return (
        <svg className="mark mark--failed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" role="img" aria-label={status === 'denied' ? 'not allowed' : 'failed'}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg className="mark mark--cancelled" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" role="img" aria-label="cancelled">
          <path d="M6 12h12" />
        </svg>
      );
    case 'waiting':
      return <span className="mark mark--wait" role="img" aria-label="waiting for alex" />;
    case 'running':
      return <span className="mark mark--spin" role="img" aria-label="running" />;
  }
}

/** One tool call as one light line, its result in one line under it; an Edit shows its numbered diff. */
export function CallLine({ entry, summary, domain }: { entry: CallEntry; summary?: string | undefined; domain?: string | undefined }) {
  const { line, identity, status } = entry;
  const hasDiff = !!line.diff?.hunks.length;
  const output = line.output?.trim() ?? '';
  const failed = status === 'failed' || status === 'denied';
  const [open, setOpen] = useState(false);
  const canOpen = failed && output.split('\n').length > 1;
  const range = hasDiff ? diffRange(line) : undefined;
  const call = domain ? (
    <>
      <span className="ln3-domain">{domain}</span>
      {identity.call.replace(/^https?:\/\/(www\.)?[^/]+/, '')}
    </>
  ) : (
    identity.call
  );
  return (
    <div className={`ln3 ln3--${status}`}>
      <div className="ln3-head">
        <ToolTile name={identity.tile} size={18} />
        <b className="ln3-name">{identity.name}</b>
        <span className="ln3-call">
          {call}
          {line.stats && !hasDiff ? <span className="ln3-stats"> {line.stats}</span> : null}
        </span>
        <span className="ln3-meta">
          {line.change && <UndoButton change={{ recordId: line.change.recordId, ...(line.change.undo ? { undo: line.change.undo } : {}), ...(line.change.noUndo ? { noUndo: line.change.noUndo } : {}), undone: !!line.change.undone }} />}
          {entry.acked && (
            <span className="ln3-ack" role="img" aria-label="Elfoqsy has seen this report" data-tip="Elfoqsy has seen this report">
              seen
            </span>
          )}
          <StatusMark status={status} />
          {range ? <span className="ln3-time">{range}</span> : status !== 'waiting' && <span className="ln3-time">{cardDuration(entry.durationMs)}</span>}
        </span>
      </div>
      {summary && !hasDiff && (
        <div className="ln3-summary">
          {canOpen ? (
            <button type="button" className="ln3-more" aria-expanded={open} onClick={() => setOpen(!open)}>
              {summary}
            </button>
          ) : (
            summary
          )}
        </div>
      )}
      {canOpen && open && <CodeBlock code={output} plain />}
      {hasDiff && (
        <div className="ln3-diff">
          {line.diff!.hunks.map((h, i) => (
            <DiffLines key={i} rows={diffRows(h.lines, { old: h.oldStart, new: h.newStart })} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Three or more calls in a row as one chip: their tiles, "6 reads and searches", done, and ▸; open, their lines. */
function Group({ entry }: { entry: Extract<PaneEntry, { kind: 'group' }> }) {
  const [open, setOpen] = useState(false);
  const tiles = entry.calls.slice(0, 4).map((c) => c.call.identity.tile);
  return (
    <div className="grp">
      <button type="button" className="grp-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="grp-tiles" aria-hidden="true">
          {tiles.map((t, i) => (
            <ToolTile key={i} name={t} size={16} />
          ))}
        </span>
        {entry.noun}
        <StatusMark status="done" />
        <span className="grp-chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="grp-lines">
          {entry.calls.map((c) => (
            <CallLine key={c.call.key} entry={c.call} summary={c.summary} domain={c.domain} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The verdict as one status line, with its points under it. */
function Verdict({ entry }: { entry: Extract<PaneEntry, { kind: 'verdict' }> }) {
  return (
    <div className="vl">
      <div className="vl-head">
        <svg className={`mark ${entry.stops ? 'mark--cancelled' : 'mark--done'}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" />
          {entry.stops ? <path d="M8 12h8" /> : <path d="m8 12.5 2.8 2.8L16.5 9" />}
        </svg>
        <b>{entry.label}</b>
        {entry.detail && <span className="vl-detail">{entry.detail}</span>}
      </div>
      {entry.points.length > 0 && (
        <ul className="vl-points">
          {entry.points.map((p, i) => (
            <li key={i}>{inline(p)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Elfoqsy answered for you · from …", her answer, and Change: another option, which the agent is told. */
function Answer({ decision: d }: { decision: DecisionView }) {
  const [changing, setChanging] = useState(false);
  const current = d.changed?.to ?? d.answer;
  const others = (d.options ?? []).filter((o) => !sameOption(current, o));
  const from = d.basis === 'precedent' ? 'your precedent' : d.sources.map(sourceText).join(', ');
  return (
    <div className="ans">
      <img className="ans-face" src={ART.quiet.faces[0]} alt="" />
      <div className="ans-text">
        <div>
          <b>Elfoqsy answered for you</b>
          <span className="ans-from"> · from {from}</span>
        </div>
        <div className="ans-body">{inline(d.answer)}</div>
        {d.changed?.how === 'changed' && <div className="ans-changed">You changed it to “{d.changed.to}”; the agent was told.</div>}
        {changing && (
          <div className="ans-options">
            {others.map((o) => (
              <button key={o} type="button" className="button-outline button-outline--small" onClick={() => stream.changeDecision(d.decisionId, o) && setChanging(false)}>
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
      {others.length > 0 && (
        <button type="button" className="ans-change" aria-expanded={changing} onClick={() => setChanging(!changing)}>
          Change
        </button>
      )}
    </div>
  );
}

function Entry({ entry, state }: { entry: PaneEntry; state: WorkspaceState }) {
  switch (entry.kind) {
    case 'prose':
      return <Markdown text={entry.text} className="prose" />;
    case 'call':
      return <CallLine entry={entry.call} summary={entry.summary} domain={entry.domain} />;
    case 'group':
      return <Group entry={entry} />;
    case 'verdict':
      return <Verdict entry={entry} />;
    case 'answer':
      return <Answer decision={entry.decision} />;
    case 'assumption':
      return (
        <div className="decided">
          <span className="decided-label">Decided</span> {inline(entry.text)}
          {entry.flag && <span className="decided-flag"> · for your review</span>}
        </div>
      );
    case 'question':
      return <QuestionCard approval={entry.approval} state={state} compact />;
    case 'note':
      return (
        <div className={`note3${entry.reminder ? ' note3--reminder' : ''}`}>
          <span className="feed-mark">›</span> {entry.text}
        </div>
      );
  }
}

/** Within this many pixels of the bottom counts as at the bottom: the log follows new entries. */
const BOTTOM_SLACK = 24;

/** At the bottom (following), or scrolled up (Latest is offered). */
export const atBottomOf = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;

/**
 * The log: opens at the latest entry and follows new ones while at the bottom; scrolled up, it stays put and offers
 * Latest, which smooth-scrolls back down. Reduced motion jumps instead.
 */
export function Feed({ entries, state, label, tail }: { entries: PaneEntry[]; state: WorkspaceState; label: string; tail?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const height = useRef(0);
  // Follows only when something new arrived, so a render for anything else (focus, the clock) never moves the log
  // under the pointer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.scrollHeight === height.current) return;
    height.current = el.scrollHeight;
    if (following.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight; // opens at the latest entry
  }, []);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = atBottomOf(el);
    following.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };
  const latest = () => {
    const el = ref.current;
    if (!el) return;
    following.current = true;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <div className="feed-wrap">
      <div ref={ref} className="feed3" role="log" aria-label={label} onScroll={onScroll}>
        {entries.map((e) => (
          <Entry key={e.key} entry={e} state={state} />
        ))}
        {tail}
      </div>
      {!atBottom && (
        <button type="button" className="feed-latest" onClick={latest}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          Latest
        </button>
      )}
    </div>
  );
}
