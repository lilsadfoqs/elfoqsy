// One terminal pane (v3): its header (badge, ticket or task, model, steps as dots and the current step's name, a
// ⋯ menu for split, timeline, pause and close), an agent's transcript or run timeline, a stack of its sub-agents, or a
// new pane that offers to attach to an agent or to give Elfoqsy a ticket; and a full-size message input at the bottom.
import { useState, type KeyboardEvent } from 'react';
import type { RunView, SubagentView, WorkspaceState } from '@elfoqsy/state';
import { agentLabel, durationLabel, isRunActive, runLabel, tokensLabel } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { holdNote, runTokens, shortDuration, stackOrder, statusLine, subagentCounts, subagentElapsed, subagentMeta, subagentResult } from './lines';
import { Feed } from './Cards';
import { paneEntries, stepDots, subagentEntries } from './feed';
import type { Side, Tile } from './tree';
import { FailedLine } from './FailedLine';
import { Floating, refTo, useLayer } from '../../ui/layers';

/** A pane with no room beside it shows its agent's sub-agents in place, in 'stack' mode. */
export type PaneMode = 'log' | 'timeline' | 'stack';

export interface PaneProps {
  tile: Tile;
  state: WorkspaceState;
  now: number;
  focused: boolean;
  /** More than one pane: only then can this one close. */
  many: boolean;
  mode: PaneMode;
  canSplit: Record<Side, boolean>;
  /** Whether this run's sub-agent stack is open somewhere. */
  stackShown: boolean;
  /** Agents with no pane, for a new pane to attach to. */
  attachable: RunView[];
  stackPick: string | null;
  timelinePick: string | null;
  onFocus: () => void;
  onSplit: (side: Side) => void;
  onClose: () => void;
  onMode: (mode: PaneMode) => void;
  onToggleStack: () => void;
  onAttach: (runId: string) => void;
  onAskForTicket: (text: string) => void;
  onStackPick: (subagentId: string) => void;
  onTimelinePick: (subagentId: string | null) => void;
}

const SPLITS: { side: Side; label: string }[] = [
  { side: 'right', label: 'New pane on the right' },
  { side: 'down', label: 'New pane below' },
  { side: 'left', label: 'New pane on the left' },
  { side: 'up', label: 'New pane above' },
];

export function Pane(props: PaneProps) {
  const { tile, state, focused } = props;
  const run = tile.leaf.runId ? state.runs[tile.leaf.runId] : undefined;
  const style = { left: tile.x, top: tile.y, width: tile.w, height: tile.h };
  const label = run ? (tile.leaf.stack ? `Agent ${run.agentNumber} sub-agents` : `Agent ${run.agentNumber} on ${runLabel(run)}`) : 'New pane';
  const narrow = tile.w < 560;
  return (
    <section className={`pane${focused ? ' pane--focused' : ''}${narrow ? ' pane--narrow' : ''}`} style={style} aria-label={label} data-run={run?.runId} onMouseDown={props.onFocus}>
      <PaneHead {...props} run={run} />
      {run && (tile.leaf.stack || props.mode === 'stack') ? <Stack {...props} run={run} /> : run ? <AgentBody {...props} run={run} /> : <EmptyBody {...props} />}
    </section>
  );
}

function Badge({ run, empty }: { run?: RunView; empty?: boolean }) {
  const ring = run?.state === 'waiting_for_you' ? ' badge--waiting' : run?.state === 'failed' ? ' badge--failed' : '';
  return <span className={`badge${empty ? ' badge--empty' : ''}${ring}`}>{run ? run.agentNumber : '+'}</span>;
}

/** The steps as dots, the current one marked by how the run is doing, and its name beside them. */
function StepDots({ run }: { run: RunView }) {
  const { dots, current } = stepDots(run);
  if (!dots.length) return null;
  const how = run.state === 'waiting_for_you' ? 'waiting' : run.state === 'failed' ? 'failed' : 'working';
  return (
    <span className="pdots" data-tip={run.steps.map((s) => s.name).join(', ')} aria-label={`Steps: ${run.steps.map((s) => s.name).join(', ')}.${current ? ` Now: ${current}.` : ''}`}>
      <span className="pdots-row" aria-hidden="true">
        {dots.map((d, i) => (
          <span key={i} className={`pdot pdot--${d === 'current' ? how : d}`} />
        ))}
      </span>
      {current && <span className="pdots-name">{current}</span>}
    </span>
  );
}

/** The header: badge, ticket (or task), model, steps; sub-agents; split, timeline, pause and close in the ⋯ menu. */
function PaneHead(props: PaneProps & { run: RunView | undefined }) {
  const { run, tile, mode } = props;
  // The ⋯ menu is a floating layer: a click outside, Escape or another layer closes it.
  const menu = useLayer('menu');
  const stack = tile.leaf.stack;
  const running = run ? run.subagents.filter((s) => !s.outcome).length : 0;
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    menu.hide(true);
    fn();
  };
  const subsLabel = run ? `${running} sub-agents running, ${run.subagents.length} in this run. ${props.stackShown ? 'Hide' : 'Show'} their terminals` : '';
  const paused = !!run?.paused;
  const waiting = run?.state === 'waiting_for_you';
  return (
    <header className="phead">
      <Badge run={run} empty={!run} />
      <b className="phead-title">{run ? (stack ? `Agent ${run.agentNumber} sub-agents` : runLabel(run)) : 'New pane'}</b>
      {run && !props.tile.leaf.stack && tile.w >= 560 && <span className="phead-model">{agentLabel(run.model, run.effort)}</span>}
      {run && !stack && <StepDots run={run} />}
      {run && !stack && run.subagents.length > 0 && (
        <button type="button" className={`subs${props.stackShown ? ' subs--on' : ''}`} aria-pressed={props.stackShown} aria-label={subsLabel} data-tip={subsLabel} onClick={stop(props.onToggleStack)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="6" cy="5" r="2.5" />
            <circle cx="6" cy="19" r="2.5" />
            <circle cx="18" cy="12" r="2.5" />
            <path d="M6 7.5v9M8.5 6c5 0 7 2 7.5 3.5" />
          </svg>
          {running}
        </button>
      )}
      <span className="phead-menu">
        <button
          type="button"
          className="phead-more"
          aria-haspopup="menu"
          ref={refTo(menu.anchor)}
          aria-expanded={menu.open}
          aria-label="Pane menu: split, timeline, pause, close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            menu.toggle();
          }}
        >
          ⋯
        </button>
        <Floating layer={menu} side="bottom" align="end" gap={4} className="pmenu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
            {run && !stack && mode !== 'stack' && (
              <button type="button" role="menuitem" onClick={stop(() => props.onMode(mode === 'log' ? 'timeline' : 'log'))}>
                {mode === 'log' ? 'Show the run timeline' : 'Show the transcript'}
              </button>
            )}
            {run && !stack && isRunActive(run) && run.state !== 'failed' && (
              <button
                type="button"
                role="menuitem"
                aria-disabled={waiting && !paused}
                data-tip={waiting && !paused ? `Agent ${run.agentNumber} is waiting for your answer` : undefined}
                onClick={stop(() => {
                  if (waiting && !paused) return;
                  if (paused) stream.resume(run.runId);
                  else stream.pause(run.runId);
                })}
              >
                {paused ? `Resume agent ${run.agentNumber}` : `Pause agent ${run.agentNumber}`}
              </button>
            )}
            {SPLITS.map((sp) => (
              <button key={sp.side} type="button" role="menuitem" disabled={!props.canSplit[sp.side]} onClick={stop(() => props.onSplit(sp.side))}>
                {sp.label}
              </button>
            ))}
            <button type="button" role="menuitem" aria-disabled={!props.many} onClick={stop(() => props.many && props.onClose())}>
              Close this pane
            </button>
        </Floating>
      </span>
    </header>
  );
}

export { UndoButton } from './Cards';

function AgentBody(props: PaneProps & { run: RunView }) {
  const { run, state, now, mode } = props;
  return (
    <>
      <div className="pbody">
        {mode === 'log' ? (
          <Feed entries={paneEntries(run, state, now)} state={state} label={`Agent ${run.agentNumber} activity`} />
        ) : (
          <Timeline run={run} now={now} pick={props.timelinePick} onPick={props.onTimelinePick} />
        )}
      </div>
      {run.state === 'failed' ? (
        // A dismissed failure keeps only its status line: nothing is running to message.
        <footer className="pfoot">{!run.dismissed ? <FailedLine run={run} onDismiss={() => stream.dismiss(run.runId)} /> : <span className="pfoot-note">{statusLine(run)}</span>}</footer>
      ) : (
        <GuideInput run={run} />
      )}
    </>
  );
}

/** The message input, full size, and the run's tokens against its budget; what holds it, when something does. */
function GuideInput({ run }: { run: RunView }) {
  const [text, setText] = useState('');
  const send = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && text.trim() && stream.guide(run.runId, text.trim())) setText('');
  };
  const note = holdNote(run);
  return (
    <footer className="pfoot">
      {note && <span className="pfoot-note">{note}</span>}
      <span className="pfoot-row">
        <input
          type="text"
          className="pfoot-input"
          aria-label={`Message agent ${run.agentNumber}`}
          data-tip="Sending pauses the agent, gives it this and resumes it; it then re-plans its next step."
          placeholder={`Message agent ${run.agentNumber}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={send}
        />
        <span className="pfoot-meter" data-tip={statusLine(run)}>
          {tokensLabel(runTokens(run))}
          {run.budget ? ` / ${tokensLabel(run.budget.tokens)}` : ''}
        </span>
      </span>
    </footer>
  );
}

function Timeline({ run, now, pick, onPick }: { run: RunView; now: number; pick: string | null; onPick: (id: string | null) => void }) {
  const start = run.createdAt;
  const end = run.state === 'succeeded' || run.state === 'stopped' || run.state === 'cancelled' ? run.stateAt : now;
  const span = Math.max(60_000, end - start);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start) / span) * 100));
  const picked = run.subagents.find((s) => s.subagentId === pick);
  return (
    <div className="timeline" aria-label="Run timeline">
      <div className="tl-row tl-axis">
        <span />
        <span className="tl-scale">
          <span>0m</span>
          <span>{axisLabel(span / 2)}</span>
          <span>now, {axisLabel(span)}</span>
        </span>
      </div>
      <div className="tl-row">
        <span className="tl-who">
          <span className="tl-model tl-model--agent">{agentLabel(run.model, run.effort)}</span>
          <span className="tl-task">Agent {run.agentNumber}</span>
        </span>
        <span className="tl-track">
          <span className="tl-bar tl-bar--agent" style={{ left: '0%', width: `${pct(end)}%` }} />
        </span>
      </div>
      {run.subagents.map((s) => (
        <button key={s.subagentId} type="button" className={`tl-row tl-row--pick${pick === s.subagentId ? ' tl-row--on' : ''}`} aria-pressed={pick === s.subagentId} data-tip={s.task} onClick={() => onPick(pick === s.subagentId ? null : s.subagentId)}>
          <span className="tl-who">
            <span className="tl-model">{agentLabel(s.model, s.effort)}</span>
            <span className="tl-task">{s.task}</span>
          </span>
          <span className="tl-track">
            <span
              className={`tl-bar tl-bar--${s.outcome ?? 'running'}`}
              style={{ left: `${pct(s.startedAt)}%`, width: `${Math.max(1.2, pct(s.finishedAt ?? now) - pct(s.startedAt))}%` }}
            />
          </span>
        </button>
      ))}
      {picked && <PickedSubagent sub={picked} run={run} now={now} />}
    </div>
  );
}

/** 9m, 18m, 21h 18m: the timeline's scale. */
const axisLabel = (ms: number): string => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : durationLabel(ms));

function PickedSubagent({ sub, run, now }: { sub: SubagentView; run: RunView; now: number }) {
  const ran = sub.outcome ? `ran ${shortDuration(subagentElapsed(sub, now))}` : 'still running';
  const tokens = sub.tokens !== undefined ? `, ${Math.round(sub.tokens / 1000)}k tokens` : '';
  return (
    <div className="tl-detail">
      <span className="tl-detail-task">{sub.task}</span>
      <span className="tl-detail-meta">
        {agentLabel(sub.model, sub.effort)}, started at {((sub.startedAt - run.createdAt) / 60_000).toFixed(1)}m, {ran}
        {tokens}, {sub.toolCalls} tool calls
        {sub.by ? `, cancelled by ${sub.by === 'agent' ? `Agent ${run.agentNumber}` : sub.by === 'you' ? 'alex' : sub.by}` : ''}
      </span>
      <span className="tl-detail-outcome">
        <span className={`dot dot--${sub.outcome ?? 'running'}`} />
        {subagentResult(sub, now)}
      </span>
    </div>
  );
}

function Stack(props: PaneProps & { run: RunView }) {
  const { run, now } = props;
  const order = stackOrder(run);
  const open = props.stackPick && order.some((s) => s.subagentId === props.stackPick) ? props.stackPick : order[0]?.subagentId;
  return (
    <div className="stack">
      <div className="stack-summary">
        {subagentCounts(run).map((c) => (
          <span key={c.outcome}>
            <span className={`dot dot--${c.outcome}`} />
            {c.label}
          </span>
        ))}
      </div>
      {order.map((s) => {
        const isOpen = s.subagentId === open;
        return (
          <div key={s.subagentId} className={`stack-row${isOpen ? ' stack-row--open' : ''}`}>
            <button type="button" className="stack-head" aria-expanded={isOpen} onClick={() => props.onStackPick(s.subagentId)}>
              <span className={`dot dot--${s.outcome ?? 'running'}`} />
              <span className="stack-model">{agentLabel(s.model, s.effort)}</span>
              <span className="stack-task">{s.task}</span>
              <span className="stack-meta">{subagentMeta(s, now)}</span>
            </button>
            {isOpen && (
              <div className="stack-log">
                <Feed entries={subagentEntries(s, now)} state={props.state} label={`${s.task}, what it did`} tail={<div className="feed-result">{subagentResult(s, now)}</div>} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyBody(props: PaneProps) {
  const [text, setText] = useState('');
  const roomy = props.tile.h >= 260;
  const send = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && text.trim()) {
      props.onAskForTicket(text.trim());
      setText('');
    }
  };
  return (
    <div className="empty">
      {props.attachable.length > 0 && (
        <>
          {roomy && <span className="empty-note">attach to a running agent</span>}
          <div className="empty-attach">
            {props.attachable.map((r) => (
              <button key={r.runId} type="button" className="attach" onClick={() => props.onAttach(r.runId)}>
                <Badge run={r} />
                {runLabel(r)}
              </button>
            ))}
          </div>
        </>
      )}
      {roomy && <span className="empty-note">or give Elfoqsy a ticket</span>}
      <div className="empty-do">
        <span className="prompt">›</span>
        <input type="text" aria-label="Start an agent on a ticket" placeholder="do SHOP-1234" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={send} />
      </div>
    </div>
  );
}
