// The sprint column: the status bar, then the orbit map, a ticket (with the map shrunk to a dial), or a brief as
// a document; the story-point bar always bottom left. Hidden, it is a rail with the bar and a blocked dot.
import { useEffect, useState } from 'react';
import { agentLabel, currentActivity, durationLabel, storyPoints, tokensLabel, toolWords } from '@elfoqsy/state';
import type { BriefView, HandoffView, RunView, StatusItem, WorkspaceState } from '@elfoqsy/state';
import { handoffMarkdown } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { StatusBar } from '../../stage/StatusBar';
import { CollapseButton } from '../../ui/CollapseButton';
import { Markdown } from '../../ui/Markdown';
import { AgentBadge } from '../../ui/TicketBits';
import { briefMarkdown, hhmm } from '../model';
import { CreateTicket } from './CreateTicket';
import type { NarrativeScroll } from './Narrative';
import { CompactMap } from './CompactMap';
import { OrbitMap } from './OrbitMap';
import { SprintList } from './SprintList';
import { useBox } from '../../panes/slot';
import type { SprintForm } from '../../panes/spec';
import { useRef } from 'react';
import { TicketView } from './TicketView';

/** create: his create form, empty or from a draft ("Edit first"). */
/** scrollTo: "Read the verdict" in the conversation opens the ticket at a section of its narrative (N1). */
export type SprintView = { kind: 'map' } | { kind: 'ticket'; key: string; scrollTo?: NarrativeScroll } | { kind: 'brief'; briefId: string } | { kind: 'handoff'; handoffId: string } | { kind: 'create'; draftId?: string };

interface Props {
  state: WorkspaceState;
  items: StatusItem[];
  now: number;
  statusLines: string[];
  jiraSite: string;
  view: SprintView;
  onView: (view: SprintView) => void;
  open: boolean;
  lastOpen: boolean;
  onToggle: () => void;
  /** Find a ticket: the button under the dial's expand button opens the search dialog, as Ctrl K does. */
  onFind: () => void;
  /** Its form, from its slot (P1); full when left out. */
  form?: SprintForm;
  /**
   * classic: today's column, its status bar and its collapse button in the header. free (P2): a pane that can be anywhere:
   * the screen's top row carries the status bar, and the column does not collapse.
   */
  chrome?: 'classic' | 'free';
}

export function SprintColumn(props: Props) {
  const { state, view, onView } = props;
  const form = props.form ?? 'full';
  const free = props.chrome === 'free';
  const points = storyPoints(state);
  const blocked = Object.values(state.tickets).filter((t) => t.status === 'Blocked').length;
  const area = useRef<HTMLDivElement>(null);
  const box = useBox(area, view.kind + form);

  const rail = (collapse: boolean) => {
    const total = points.done + points.inProgress + points.toDo || 1;
    return (
      <section className="lcol lcol--rail" aria-label={collapse ? 'Sprint, hidden' : 'Sprint, narrow'}>
        {collapse && <CollapseButton cells={3} index={0} shown={false} label="Show the sprint" onClick={props.onToggle} />}
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="var(--text-muted)" strokeWidth="1.6" aria-label="Sprint">
          <circle cx="15" cy="15" r="13" />
          <circle cx="15" cy="15" r="8" />
          <circle cx="15" cy="15" r="2.5" fill="var(--text-primary)" stroke="none" />
        </svg>
        <div className="points-rail" role="img" aria-label={pointsLabel(points)}>
          <span style={{ height: (100 * points.done) / total, ['--p' as string]: (100 * points.done) / total, background: 'var(--status-done)' }} />
          <span style={{ height: (100 * points.inProgress) / total, ['--p' as string]: (100 * points.inProgress) / total, background: 'var(--status-in-progress)' }} />
          <span style={{ height: (100 * points.toDo) / total, ['--p' as string]: (100 * points.toDo) / total, background: 'var(--status-todo)' }} />
        </div>
        {blocked > 0 && <span className="rail-dot rail-dot--broken" role="img" aria-label={`${blocked} ticket${blocked === 1 ? ' is' : 's are'} blocked`} data-tip={`${blocked} ticket${blocked === 1 ? ' is' : 's are'} blocked`} />}
      </section>
    );
  };
  if (!props.open) return rail(true);
  // Under 240 wide, the rail: the sprint as a bar and a dot.
  if (form === 'rail') return rail(false);

  const brief = view.kind === 'brief' ? state.briefs[view.briefId] : undefined;
  const handoff = view.kind === 'handoff' ? state.handoffs[view.handoffId] : undefined;
  // A ticket, a brief or the create form need a slot 480 wide and 560 tall; smaller, the map's own form shows, and says so.
  const document = view.kind !== 'map' && (form === 'full' || form === 'compact');
  const small = form === 'list' || form === 'short';
  return (
    <section className={`lcol lcol--sprint${free ? ' lcol--free' : ''}${small ? ' lcol--small' : ''}`} aria-label="Sprint">
      {!free && (
        <header className="lcol-head">
          <StatusBar items={props.items} now={props.now} lines={props.statusLines} />
          <CollapseButton cells={3} index={0} shown label="Hide the sprint" disabled={props.lastOpen} onClick={props.onToggle} />
        </header>
      )}
      {free && (
        <header className="lcol-head lcol-head--free">
          <CollapseButton cells={3} index={0} shown label="Hide the sprint" onClick={props.onToggle} />
        </header>
      )}
      {view.kind !== 'map' && !document && (
        <p className="sprint-needs">
          {view.kind === 'ticket' ? view.key : 'This'} needs a slot 480 wide and 560 tall.{' '}
          <button type="button" className="link-button" onClick={() => onView({ kind: 'map' })}>
            Back to the map
          </button>
        </p>
      )}
      {document ? (
        view.kind === 'ticket' ? (
          <TicketView state={state} ticketKey={view.key} jiraSite={props.jiraSite} onView={onView} onFind={props.onFind} {...(view.scrollTo ? { scrollTo: view.scrollTo } : {})} />
        ) : view.kind === 'create' ? (
          <CreateTicket key={view.draftId ?? 'new'} state={state} {...(view.draftId ? { draftId: view.draftId } : {})} onView={onView} onClose={() => onView({ kind: 'map' })} />
        ) : brief ? (
          <BriefDocument state={state} brief={brief} onView={onView} />
        ) : handoff ? (
          <HandoffDocument state={state} handoff={handoff} onView={onView} />
        ) : (
          <SprintMapArea form={form} free={free} state={state} onSelect={(key) => onView({ kind: 'ticket', key })} area={area} box={box} />
        )
      ) : (
        <SprintMapArea form={form} free={free} state={state} onSelect={(key) => onView({ kind: 'ticket', key })} area={area} box={box} />
      )}
      <PointsBar points={points} {...(small || form === 'compact' ? { width: 260 } : {})} />
    </section>
  );
}

/** The map's area: the full map as today, or the fitted map, or the list, as the slot's form says. */
function SprintMapArea({ form, free, state, onSelect, area, box }: { form: SprintForm; free: boolean; state: WorkspaceState; onSelect: (key: string) => void; area: React.RefObject<HTMLDivElement | null>; box: { w: number; h: number } | null }) {
  if (form === 'list') return <SprintList state={state} onSelect={onSelect} />;
  if (form === 'full') {
    return (
      <div ref={area} className={free ? 'sprint-map sprint-map--fit' : 'sprint-map'}>
        <OrbitMap state={state} onSelect={onSelect} />
      </div>
    );
  }
  // compact and short: the map fitted to what is left of the slot.
  return (
    <div ref={area} className="sprint-map sprint-map--fit">
      {box && box.w > 0 && box.h > 0 && <CompactMap state={state} onSelect={onSelect} w={box.w} h={box.h} />}
    </div>
  );
}

const pointsLabel = (p: { done: number; inProgress: number; toDo: number }) => `Story points: ${p.done} done, ${p.inProgress} in progress, ${p.toDo} to do`;

export function PointsBar({ points, width = 260 }: { points: { done: number; inProgress: number; toDo: number }; width?: number }) {
  const total = points.done + points.inProgress + points.toDo;
  if (!total) return null;
  const seg = (n: number, color: string) =>
    n > 0 && (
      <span style={{ width: `${(100 * n) / total}%`, background: color }}>
        {n}
      </span>
    );
  return (
    <div className="points-bar" role="img" aria-label={pointsLabel(points)} style={{ width: `min(${width}px, 100%)` }}>
      {seg(points.done, 'var(--status-done)')}
      {seg(points.inProgress, 'var(--status-in-progress)')}
      {seg(points.toDo, 'var(--status-todo)')}
    </div>
  );
}

/** What the agent on this ticket is doing: activity, steps so far, and its budget used. */
export function AgentWork({ state, run }: { state: WorkspaceState; run: RunView }) {
  const now = useNow();
  const activity = currentActivity(run, now);
  const approval = Object.values(state.approvals).find((a) => a.runId === run.runId && !a.resolution);
  const tokens = run.usage?.tokens ?? 0;
  const minutes = Math.round((run.usage?.workingSeconds ?? 0) / 60);
  return (
    <div className="agent-work">
      <div className="agent-work-head">
        <AgentBadge run={run} size={30} />
        <span className="agent-work-name">Agent {run.agentNumber} is on it</span>
        <span className="agent-work-model">{agentLabel(run.model, run.effort)}</span>
      </div>
      <span className="agent-work-activity">
        {approval ? (
          <>Waiting for you: {approval.action ?? approval.question}</>
        ) : activity ? (
          <Activity line={activity} />
        ) : run.state === 'failed' ? (
          <>Failed{run.reason ? `: ${run.reason}` : ''}</>
        ) : (
          <>{run.step ? `At ${run.step}` : 'Starting'}</>
        )}
      </span>
      {run.steps.length > 0 && (
        <div className="agent-work-steps">
          {run.steps.map((s, i) => (
            <span key={i} className={`step-tag step-tag--${s.endedAt === undefined ? (run.state === 'waiting_for_you' ? 'waiting' : 'current') : s.outcome === 'done' ? 'done' : 'other'}`}>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="meters">
        <span className="meter-name">Tokens</span>
        <Meter share={run.budget ? tokens / run.budget.tokens : 0} />
        <span className="meter-value">{run.budget ? `${tokensLabel(tokens)} of ${tokensLabel(run.budget.tokens)}` : tokensLabel(tokens)}</span>
        <span className="meter-name">Working time</span>
        <Meter share={run.budget ? minutes / run.budget.minutes : 0} />
        <span className="meter-value">{run.budget ? `${minutes} of ${run.budget.minutes} min` : `${minutes} min`}</span>
      </div>
    </div>
  );
}

function Activity({ line }: { line: ReturnType<typeof currentActivity> & object }) {
  const w = toolWords(line);
  return (
    <>
      {w.verb} {w.code ? <code>{w.object}</code> : w.object}
      {line.where ? ` in ${line.where}` : ''}, {durationLabel(line.elapsedMs)}
    </>
  );
}

export function Meter({ share, tone = 'agent' }: { share: number; tone?: 'agent' | 'plain' }) {
  return (
    <span className="meter">
      <span className={`meter-fill meter-fill--${tone}`} style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
    </span>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => stream.now());
  useEffect(() => {
    const id = setInterval(() => setNow(stream.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const MODE_LINE = { normal: 'Normal', read_only: 'Read-only: no edits at all', hotfix: 'Hotfix', remediation: 'Remediation' } as const;

/**
 * A handoff as a document: Ticket, Conversation (his words, quoted), Constraints and Known facts with their sources,
 * then what the workspace left out and why. Copy as Markdown gives what the agent read.
 */
function HandoffDocument({ state, handoff, onView }: { state: WorkspaceState; handoff: HandoffView; onView: (v: SprintView) => void }) {
  const [copied, setCopied] = useState(false);
  const runs = handoff.runIds.map((id) => state.runs[id]).filter((r): r is RunView => !!r);
  const run = runs.at(-1);
  const conversation = state.conversations[handoff.conversationId];
  const ticket = state.tickets[handoff.ticket];
  const copy = () => {
    void navigator.clipboard?.writeText(handoffMarkdown(handoff)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const working = run && run.state !== 'succeeded' && run.state !== 'stopped' && run.state !== 'cancelled';
  const bases = Object.entries(handoff.bases ?? {});
  return (
    <article className="brief-doc" aria-label="Handoff">
      <div className="brief-bar">
        <button type="button" className="button-outline" onClick={() => onView({ kind: 'map' })}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
          Sprint map
        </button>
        {run && (
          <span className="brief-agent">
            <AgentBadge run={run} size={24} />
            Agent {run.agentNumber} {working ? 'is working' : 'worked'} from this
          </span>
        )}
        <button type="button" className="button-outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>
      <div className="brief-title">
        <span className="brief-meta">
          Handoff by Elfoqsy, {hhmm(handoff.at)}
          {conversation ? `, from "${conversation.title}"` : ''}
        </span>
        <h2>
          {handoff.ticket}
          {ticket ? `: ${ticket.summary}` : ''}
        </h2>
      </div>
      <section className="brief-section">
        <h3>Ticket</h3>
        <p>
          {MODE_LINE[handoff.mode]}
          {bases.length ? `, on ${bases.map(([repo, base]) => `${base} in ${repo}`).join(', ')}` : ''}.
        </p>
      </section>
      <section className="brief-section">
        <h3>Conversation</h3>
        {handoff.context.length ? (
          handoff.context.map((m) => (
            <blockquote key={m.messageId} className="handoff-quote">
              <span className="handoff-who">{m.role === 'test' ? 'The tester' : 'alex'}</span>
              <Markdown text={m.text} />
            </blockquote>
          ))
        ) : (
          <p className="handoff-none">Nothing beyond the ticket.</p>
        )}
      </section>
      <section className="brief-section">
        <h3>Constraints</h3>
        {handoff.constraints.length ? (
          <ul>
            {handoff.constraints.map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
          </ul>
        ) : (
          <p className="handoff-none">None.</p>
        )}
      </section>
      <section className="brief-section">
        <h3>Known facts</h3>
        {handoff.facts.length ? (
          <ul>
            {handoff.facts.map((f, i) => (
              <li key={i}>
                {f.text}
                <span className="handoff-sources">{f.sources.map((s) => s.ref).join('; ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="handoff-none">None beyond the ticket.</p>
        )}
      </section>
      {handoff.dropped?.length ? (
        <section className="brief-section handoff-dropped">
          <h3>Left out by the workspace</h3>
          <ul>
            {handoff.dropped.map((d, i) => (
              <li key={i}>
                {d.text}
                <span className="handoff-sources">{d.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

/** A brief as a document: back to the map, the agent working from it, Copy as Markdown, its sections. */
function BriefDocument({ state, brief, onView }: { state: WorkspaceState; brief: BriefView; onView: (v: SprintView) => void }) {
  const [copied, setCopied] = useState(false);
  const runs = brief.runIds.map((id) => state.runs[id]).filter((r): r is RunView => !!r);
  const run = runs.at(-1);
  const conversation = state.conversations[brief.conversationId];
  const copy = () => {
    void navigator.clipboard?.writeText(briefMarkdown(brief)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const working = run && run.state !== 'succeeded' && run.state !== 'stopped' && run.state !== 'cancelled';
  return (
    <article className="brief-doc" aria-label="Brief">
      <div className="brief-bar">
        <button type="button" className="button-outline" onClick={() => onView({ kind: 'map' })}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
          Sprint map
        </button>
        {run && (
          <span className="brief-agent">
            <AgentBadge run={run} size={24} />
            Agent {run.agentNumber} {working ? 'is working' : 'worked'} from this
          </span>
        )}
        <button type="button" className="button-outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>
      <div className="brief-title">
        <span className="brief-meta">
          Brief by Elfoqsy, {hhmm(brief.at)}
          {conversation ? `, from "${conversation.title}"` : ''}
        </span>
        <h2>{brief.title}</h2>
      </div>
      {brief.sections.map((s) => (
        <section key={s.heading} className="brief-section">
          <h3>{s.heading}</h3>
          <Markdown text={s.markdown} />
        </section>
      ))}
    </article>
  );
}
