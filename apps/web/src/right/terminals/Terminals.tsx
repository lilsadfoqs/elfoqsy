// The terminals column: panes in a split tree, Zellij style. Alt n opens a pane where it fits, Alt and an
// arrow (or h j k l) moves focus, Alt + and - resize, borders drag. Hidden, it is a rail with the count of
// agents at work.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { isRunActive, runLabel, type RunView, type WorkspaceState } from '@elfoqsy/state';
import { useBox } from '../../panes/slot';
import { terminalsForm, type TerminalsForm } from '../../panes/spec';
import { stream } from '../../state/workspace';
import { CollapseButton } from '../../ui/CollapseButton';
import { Hint, KeyRow } from '../../ui/Hint';
import { agentsByUrgency } from '../map/layout';
import { Pane, type PaneMode } from './Pane';
import { focusRun } from '../focus';
import {
  canSplit,
  close,
  dragRatio,
  firstLeaf,
  initialTree,
  layout,
  leaf,
  leaves,
  moveFocus,
  placeRun,
  resizeFocused,
  setRatio,
  split,
  updateLeaf,
  GAP,
  type Divider,
  type Leaf,
  type PaneNode,
  type Side,
} from './tree';

/** Room above the first row of panes: none since v3, whose header is inside the pane. */
const TITLE_ROOM = 0;
const NOTICE_MS = 8000;
const ARROWS: Record<string, Side> = { ArrowLeft: 'left', h: 'left', ArrowRight: 'right', l: 'right', ArrowUp: 'up', k: 'up', ArrowDown: 'down', j: 'down' };

interface Props {
  state: WorkspaceState;
  ready: boolean;
  notice: { message: string; at: number } | null;
  open: boolean;
  lastOpen: boolean;
  onToggle: () => void;
  /** classic: today's column, which hides to a rail. free (P2): a pane anywhere; it does not collapse. */
  chrome?: 'classic' | 'free';
}

export function Terminals({ state, ready, notice, open, lastOpen, onToggle, chrome = 'classic' }: Props) {
  const free = chrome === 'free';
  const root = useRef<HTMLElement>(null);
  const box = useBox(root, open);
  // Its form comes from its own slot (P1): four panes from 1000 wide and 700 tall, two from 500, one with tabs from 380, tabs only under.
  const form = box ? terminalsForm(box.w, box.h) : 'four';
  const working = Object.values(state.runs).filter(isRunActive).length;
  if (!open) {
    return (
      <section className="rcol rcol--rail" aria-label="Agent terminals, hidden">
        <CollapseButton cells={2} index={1} shown={false} label="Show the agent terminals" onClick={onToggle} />
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Terminals">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M12 15h5" />
        </svg>
        <span className="rail-count" data-tip={`${working} agents at work`}>
          {working}
        </span>
      </section>
    );
  }
  return (
    <section ref={root} className={`rcol rcol--terminals${form === 'four' ? '' : ` rcol--${form}`}`} aria-label="Agent terminals">
      <div className="rcol-head">
        <span className="rcol-title">Terminals</span>
        <Hint label="Keyboard shortcuts" icon={<KeyboardIcon />}>
          <KeyRow keys={['Alt', 'N']}>New pane</KeyRow>
          <KeyRow keys={['Alt', '←', '↑', '↓', '→']}>Move focus</KeyRow>
          <KeyRow keys={['Alt', 'H', 'J', 'K', 'L']}>Move focus</KeyRow>
          <KeyRow keys={['Alt', '+']}>Grow pane</KeyRow>
          <KeyRow keys={['Alt', '−']}>Shrink pane</KeyRow>
          <KeyRow keys="Drag a border">Resize</KeyRow>
        </Hint>
        {notice && Date.now() - notice.at < NOTICE_MS && <span className="rcol-notice">Not sent: {notice.message}</span>}
        <CollapseButton cells={2} index={1} shown label="Hide the agent terminals" disabled={lastOpen} onClick={onToggle} />
      </div>
      {ready && <PaneTree state={state} form={form} />}
    </section>
  );
}

function PaneTree({ state, form }: { state: WorkspaceState; form: TerminalsForm }) {
  const [tree, setTree] = useState<PaneNode>(() => initialTree(agentsByUrgency(state).slice(0, 4).sort((a, b) => a.agentNumber - b.agentNumber).map((r) => r.runId)));
  const [focusId, setFocusId] = useState(() => firstLeaf(tree).id);
  const [modes, setModes] = useState<Record<string, PaneMode>>({});
  const [stackPick, setStackPick] = useState<Record<string, string>>({});
  const [timelinePick, setTimelinePick] = useState<Record<string, string | null>>({});
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [now, setNow] = useState(() => stream.now());
  const [drag, setDrag] = useState<Divider | null>(null);
  const el = useRef<HTMLDivElement>(null);
  // When each pane was last focused, for which one a new agent takes over when there is no room.
  const focusedAt = useRef<Record<string, number>>({});
  const focusClock = useRef(0);
  useEffect(() => {
    focusedAt.current[focusId] = ++focusClock.current;
  }, [focusId]);
  // Agents whose pane is still to be placed: new ones (not focused), and those clicked on the map (focused).
  const [queue, setQueue] = useState<Array<{ runId: string; focus: boolean }>>([]);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(stream.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const node = el.current!;
    const measure = () => setBox({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // A pane that asked Elfoqsy for a ticket attaches to that agent once it starts.
  useEffect(() => {
    for (const l of leaves(tree)) {
      if (!l.pendingTicket || l.runId) continue;
      const run = Object.values(state.runs).find((r) => r.ticket === l.pendingTicket && isRunActive(r));
      if (run) setTree((t) => updateLeaf(t, l.id, { runId: run.runId, pendingTicket: undefined }));
    }
  }, [state.runs, tree]);

  const { tiles, dividers } = useMemo(() => layout(tree, 0, TITLE_ROOM, box.w, Math.max(0, box.h - TITLE_ROOM)), [tree, box]);

  // A new agent's terminal opens by itself: runs that appear after the panes were laid out.
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(state.runOrder);
      return;
    }
    const fresh = state.runOrder.filter((id) => !known.current!.has(id));
    if (!fresh.length) return;
    for (const id of fresh) known.current.add(id);
    setQueue((q) => [...q, ...fresh.filter((id) => state.runs[id] && isRunActive(state.runs[id]!)).map((runId) => ({ runId, focus: false }))]);
  }, [state.runOrder, state.runs]);

  // Clicking an agent on the map focuses its pane, opening it first if it has none.
  useEffect(() => focusRun.subscribe((runId) => setQueue((q) => [...q, { runId, focus: true }])), []);

  // One placement at a time, each on the panes as the last one left them.
  useEffect(() => {
    if (!queue.length || box.w <= 0) return;
    const next = queue[0]!;
    // A pane worth keeping: a finished agent's least, then a working one's, and one waiting for him most.
    const keep = (l: Leaf): number => {
      const run = l.runId ? state.runs[l.runId] : undefined;
      if (!run || !isRunActive(run) || run.state === 'failed') return 0;
      return run.state === 'waiting_for_you' ? 2 : 1;
    };
    const placed = placeRun(tree, tiles, next.runId, focusId, focusedAt.current, keep);
    if (placed.tree !== tree) setTree(placed.tree);
    if (placed.tookOver) {
      // The pane starts afresh for its new agent: the log, not the old agent's view or picks.
      const id = placed.leafId;
      setModes(({ [id]: _m, ...m }) => m);
      setStackPick(({ [id]: _s, ...s }) => s);
      setTimelinePick(({ [id]: _t, ...t }) => t);
    }
    if (next.focus) setFocusId(placed.leafId);
    setQueue((q) => q.slice(1));
  }, [queue, tree, tiles, focusId, box.w, state.runs]);
  // The tree is the same in every form; what shows of it is the form's (P1): all of it, the focused pane and the one used before it,
  // the focused pane alone under a row of agent tabs, or only the agents as rows, one of which opens its pane in place.
  const [opened, setOpened] = useState(false);
  const shown = useMemo(() => {
    if (form === 'four') return tiles;
    const cap = form === 'two' ? 2 : form === 'one' || opened ? 1 : 0;
    const ranked = [...tiles].sort((a, b) => Number(b.leaf.id === focusId) - Number(a.leaf.id === focusId) || (focusedAt.current[b.leaf.id] ?? 0) - (focusedAt.current[a.leaf.id] ?? 0));
    const pick = ranked.slice(0, cap);
    const half = Math.floor((box.h - GAP) / 2);
    return pick.map((t, i) => (cap === 2 ? { ...t, x: 0, y: i * (half + GAP), w: box.w, h: i === 0 ? half : box.h - half - GAP } : { ...t, x: 0, y: 0, w: box.w, h: box.h }));
  }, [form, opened, tiles, focusId, box.w, box.h]);
  const agents = useMemo(() => agentsByUrgency(state).sort((a, b) => a.agentNumber - b.agentNumber), [state.runs]);
  // An agent tab or row: its pane takes focus, opening first if it has none (as a click on the map does).
  const pick = (run: RunView) => {
    const own = tiles.find((t) => t.leaf.runId === run.runId && !t.leaf.stack);
    if (own) setFocusId(own.leaf.id);
    else focusRun.request(run.runId);
  };
  const many = tiles.length > 1;
  const attached = new Set(tiles.filter((t) => t.leaf.runId && !t.leaf.stack).map((t) => t.leaf.runId!));
  const stacked = new Set(tiles.filter((t) => t.leaf.stack).map((t) => t.leaf.runId!));
  const attachable = agentsByUrgency(state).filter((r) => !attached.has(r.runId));

  const doSplit = (id: string, side: Side, added = leaf(null)): boolean => {
    const next = split(tree, tiles, id, side, added);
    if (!next) return false;
    setTree(next);
    setFocusId(added.id);
    return true;
  };
  const doClose = (id: string) => {
    const next = close(tree, id);
    if (!next) return;
    setTree(next.tree);
    setFocusId(next.focus);
  };
  const toggleStack = (paneId: string, runId: string) => {
    const open = tiles.find((t) => t.leaf.stack && t.leaf.runId === runId);
    if (open) return doClose(open.leaf.id);
    const added = leaf(runId, { stack: true });
    if (!doSplit(paneId, 'right', added) && !doSplit(paneId, 'down', added)) {
      // No room beside it: the agent's own pane shows the stack until the count is clicked again.
      setModes((m) => ({ ...m, [paneId]: m[paneId] === 'stack' ? 'log' : 'stack' }));
    }
  };

  // Pane keys work wherever focus is on this screen, like a terminal multiplexer's.
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = tiles.find((t) => t.leaf.id === focusId);
    if (e.key === 'n') {
      e.preventDefault();
      const prefer: Side[] = cur && cur.h > cur.w ? ['down', 'right'] : ['right', 'down'];
      for (const side of prefer) if (doSplit(focusId, side)) break;
    } else if (ARROWS[e.key]) {
      e.preventDefault();
      setFocusId(moveFocus(tiles, focusId, ARROWS[e.key]!));
    } else if (e.key === '=' || e.key === '+' || e.key === '-') {
      e.preventDefault();
      setTree(resizeFocused(tree, dividers, focusId, e.key === '-' ? -0.05 : 0.05));
    }
  };

  const keys = useRef(onKey);
  keys.current = onKey;
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const r = el.current!.getBoundingClientRect();
    const scale = r.width / (el.current!.clientWidth || 1);
    const move = (e: MouseEvent) => {
      const pointer = drag.split.dir === 'row' ? (e.clientX - r.left) / scale : (e.clientY - r.top) / scale;
      setTree((t) => setRatio(t, drag.split.id, dragRatio(drag, pointer)));
    };
    const up = () => setDrag(null);
    document.body.style.cursor = drag.split.dir === 'row' ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag]);

  const wide = form === 'four';
  const focusedRun = tiles.find((t) => t.leaf.id === focusId)?.leaf.runId;
  const areaHidden = form === 'tabs' && !opened;
  return (
    <div className={wide ? 'pwrap pwrap--four' : 'pwrap'}>
      {form === 'one' && (
        <div className="ptabs" role="tablist" aria-label="Agents">
          {agents.map((run) => (
            <button key={run.runId} type="button" role="tab" aria-selected={run.runId === focusedRun} className={`ptab${run.runId === focusedRun ? ' ptab--on' : ''}`} onClick={() => pick(run)}>
              <span className="ptab-n">{run.agentNumber}</span>
              <span className="ptab-key">{runLabel(run)}</span>
              <RunStatus run={run} />
            </button>
          ))}
        </div>
      )}
      {form === 'tabs' && !opened && (
        <div className="prows" role="list" aria-label="Agents">
          {agents.map((run) => (
            <button
              key={run.runId}
              type="button"
              role="listitem"
              className="prow"
              onClick={() => {
                pick(run);
                setOpened(true);
              }}
            >
              <span className="ptab-n">{run.agentNumber}</span>
              <span className="prow-text">
                <b>{runLabel(run)}</b>
                <span>{run.step ?? 'Starting'}</span>
              </span>
              <RunStatus run={run} />
            </button>
          ))}
          {!agents.length && <p className="prow-none">No agents at work.</p>}
        </div>
      )}
      {form === 'tabs' && opened && (
        <button type="button" className="pback" onClick={() => setOpened(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
          Agents
        </button>
      )}
      <div
        ref={el}
        className="panes"
        {...(areaHidden ? { hidden: true } : {})}
        aria-label="Agent terminals. Alt n opens a pane, Alt and an arrow moves focus, Alt plus or minus resizes."
      >
        {box.w > 0 &&
          shown.map((t) => {
            const id = t.leaf.id;
            const runId = t.leaf.runId;
            return (
              <Pane
                key={id}
                tile={t}
                state={state}
                now={now}
                focused={id === focusId}
                many={many}
                mode={modes[id] ?? 'log'}
                canSplit={wide ? { left: canSplit(t, 'left'), right: canSplit(t, 'right'), up: canSplit(t, 'up'), down: canSplit(t, 'down') } : { left: false, right: false, up: false, down: false }}
                stackShown={!!runId && (stacked.has(runId) || modes[id] === 'stack')}
                attachable={attachable}
                stackPick={stackPick[id] ?? null}
                timelinePick={timelinePick[id] ?? null}
                onFocus={() => setFocusId(id)}
                onSplit={(side) => doSplit(id, side)}
                onClose={() => doClose(id)}
                onMode={(mode) => setModes((m) => ({ ...m, [id]: mode }))}
                onToggleStack={() => runId && toggleStack(id, runId)}
                onAttach={(r) => setTree(updateLeaf(tree, id, { runId: r }))}
                onAskForTicket={(text) => {
                  const key = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/.exec(text)?.[1]?.toUpperCase();
                  if (stream.say(text) && key) setTree(updateLeaf(tree, id, { pendingTicket: key }));
                }}
                onStackPick={(sub) => setStackPick((p) => ({ ...p, [id]: sub }))}
                onTimelinePick={(sub) => setTimelinePick((p) => ({ ...p, [id]: sub }))}
              />
            );
          })}
        {wide &&
          dividers.map((d) => (
            <div
              key={d.split.id}
              className={`divider divider--${d.split.dir}${drag?.split.id === d.split.id ? ' divider--on' : ''}`}
              style={{ left: d.x, top: d.y, width: d.w, height: d.h }}
              aria-hidden="true"
              onMouseDown={(e: ReactMouseEvent) => {
                e.preventDefault();
                setDrag(d);
              }}
            >
              <span />
            </div>
          ))}
      </div>
    </div>
  );
}

/** How an agent is doing, as a mark: a spinner while it works, a yellow dot when it waits for him, a red one when it failed. */
function RunStatus({ run }: { run: RunView }) {
  if (run.state === 'waiting_for_you') return <span className="rstat rstat--waiting" role="img" aria-label="needs you" />;
  if (run.state === 'failed') return <span className="rstat rstat--failed" role="img" aria-label="failed" />;
  return <span className="rstat rstat--work" role="img" aria-label={run.paused ? 'paused' : 'working'} />;
}

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}
