// "What we know" (N1): the ticket's narrative, under the agent block and above the fields. Seven sections written by
// Elfoqsy from the agent's reports (packages/state/src/narrative.ts); none says what no report backs, and one not reached
// yet says what it waits for. At hand-back, section 7 holds the card that gates "Mark ready for review" on his having read it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildNarrative, narrativeMarkdown, type Narrative, type NarrativeBlock, type NarrativeItem, type NarrativeSection, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { inline } from '../../ui/Markdown';

export interface NarrativeScroll {
  section: number;
  /** A click on the same link again scrolls again. */
  nonce: number;
}

export function NarrativeView({ state, runId, scrollTo }: { state: WorkspaceState; runId: string; scrollTo?: NarrativeScroll }) {
  const narrative = useMemo(() => buildNarrative(state, runId), [state, runId]);
  const root = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  // "Read the verdict" in the conversation opens the ticket and scrolls here.
  useEffect(() => {
    if (!scrollTo) return;
    root.current?.querySelector(`[data-section="${scrollTo.section}"]`)?.scrollIntoView({ block: 'start' });
  }, [scrollTo?.nonce]);

  if (!narrative) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(narrativeMarkdown(narrative)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <section ref={root} className="nv" aria-label="What we know">
      <div className="nv-head">
        <h3 className="nv-title">What we know</h3>
        <span className="nv-kept">kept by Elfoqsy from Agent {narrative.agentNumber}'s reports</span>
        <button type="button" className="button-outline nv-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>
      <div className="nv-stages" role="list" aria-label="Stages">
        {narrative.sections.map((s) => (
          <span key={s.key} role="listitem" className={`nv-stage nv-stage--${s.stage}`} data-stage={s.stage}>
            <StageMark stage={s.stage} />
            {s.title}
          </span>
        ))}
      </div>
      {narrative.sections.map((s) => (
        <Section key={s.key} section={s} narrative={narrative} />
      ))}
    </section>
  );
}

function StageMark({ stage }: { stage: NarrativeSection['stage'] }) {
  if (stage === 'done') {
    return (
      <span className="nv-mark nv-mark--done" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--bg-canvas)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 5 5 9-10" />
        </svg>
      </span>
    );
  }
  return <span className={`nv-mark nv-mark--${stage}`} aria-hidden="true" />;
}

function Section({ section: s, narrative }: { section: NarrativeSection; narrative: Narrative }) {
  const waiting = s.blocks.length === 0;
  return (
    <section className={`nv-section${waiting ? ' nv-section--waiting' : ''}`} data-section={s.n} aria-label={s.title}>
      <h4 className="nv-section-title">
        <span className="nv-n" aria-hidden="true">
          {s.n}
        </span>
        {s.title}
        {waiting && <span className="nv-waits">{s.waitsFor}</span>}
      </h4>
      {!waiting && (
        <div className="nv-body">
          {s.blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </div>
      )}
      {s.source && <p className="nv-source">{s.source}</p>}
      {s.key === 'hand_back' && <ReadyCard narrative={narrative} />}
    </section>
  );
}

function Block({ block }: { block: NarrativeBlock }) {
  switch (block.kind) {
    case 'p':
      return <p>{inline(block.md)}</p>;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List>
          <Items items={block.items} />
        </List>
      );
    }
    case 'code':
      return <pre className="nv-code">{block.text}</pre>;
    case 'quote':
      return <blockquote className="nv-quote">{block.text}</blockquote>;
  }
}

function Items({ items }: { items: NarrativeItem[] }) {
  return (
    <>
      {items.map((it, i) => (
        <li key={i}>
          {inline(it.md)}
          {it.children && (
            <ul>
              <Items items={it.children} />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

/**
 * "Ready for review waits for you" (N1): a draft PR is not marked ready until he has ticked that he read the narrative,
 * and a tick counts only while nothing in it has changed since. The tick is recorded as his; the tester's is the tester's.
 */
function ReadyCard({ narrative }: { narrative: Narrative }) {
  const h = narrative.handBack;
  if (!h.handedBack || (!h.drafts.length && !h.readyAsk)) return null;
  const pr = h.drafts[0];
  const prName = pr ? `${pr.repo.split('/').at(-1)}#${pr.number}` : 'the PR';
  // The box shows what was ticked, by him or the tester; only his tick (or the tester's, in the tester's own run) opens the button.
  const shown = h.read || h.testerRead;
  const ticked = h.read || (narrative.test && h.testerRead);
  return (
    <div className="nv-ready" role="group" aria-label="Ready for review waits for you">
      <p className="nv-ready-title">
        <span className="dot dot--needs-you" aria-hidden="true" />
        Ready for review waits for you
      </p>
      <p className="nv-ready-text">Your name goes on this PR. Read sections 1 to 6, then mark it ready.</p>
      <label className="nv-check">
        <input type="checkbox" checked={shown} disabled={shown} onChange={() => !shown && stream.narrativeRead(narrative.runId)} />
        I've read the narrative
      </label>
      {h.changedSinceRead && <p className="nv-ready-note">The agent has reported more since you read it.</p>}
      {h.testerRead && !narrative.test && <p className="nv-ready-note">The tester's tick opens nothing: only yours does.</p>}
      <div className="nv-ready-actions">
        <button type="button" className="button-solid" disabled={!ticked} onClick={() => stream.markReady(narrative.runId)}>
          Mark ready for review
        </button>
        {pr && (
          <a className="button-outline" href={pr.url} target="_blank" rel="noreferrer">
            Open {prName}
          </a>
        )}
      </div>
    </div>
  );
}
