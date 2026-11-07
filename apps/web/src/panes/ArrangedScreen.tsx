// One window's screen, with its arrangement (P2). With no layout saved it shows what it always showed (the classic columns
// its screen passes in); with a layout saved, or while a pane is being dragged, it shows the layout engine's arrangement.
// It also is where a pane is picked up (a grip at the top centre of the pane under the pointer) and dropped (the browser's
// drag and drop, which is what crosses from one browser window to the other), and where the chip that follows the pointer is
// drawn. In today's columns the + and an x beside each pane's hide button are offered too, drawn here over the panes so that
// today's screens are not touched; the first one used saves a layout (today's arrangement, changed), as the first drag does. The saved layout is an event: both windows fold it, so both agree at once and after a reload.
import { useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from 'react';
import { DEFAULT_LAYOUT, PANES, PANE_IDS, arrange, fits, insert, sameLayout, savedLayout, targetAt, without, type PaneId, type Target } from '@elfoqsy/state';
import { Stage } from '../stage/Stage';
import { stream, useWorkspace } from '../state/workspace';
import { stageRect } from '../ui/place';
import { AddPlus, type PlusAt } from './AddPlus';
import { PANE_TYPE, arranging, blankImage, paneInDrag, toStage, useDrag } from './arrange';
import { FreeScreen, REMOVES } from './FreeScreen';
import { AbilitiesView } from '../abilities/AbilitiesView';
import { useAbilitiesView } from '../ui/abilitiesView';
import { folds, useFolds } from './folds';
import { GRIP, gripPane, plusNear, xBeside, type Boxes } from './hover';

/** A pane in the other window's hand is believed to be over this window only while it keeps sending events: the browser sends one at least every half second. */
const SILENT_MS = 1500;
/** After this, a pointer event in the page means the drag is over: the browser sends none during one. */
const GRACE_MS = 400;

interface Hover {
  grip: { pane: PaneId; x: number; y: number } | null;
  plus: PlusAt | null;
  /** In today's columns: the x beside the hide button of the pane under the pointer. */
  x: { pane: PaneId; x: number; y: number; w: number; h: number } | null;
}
const NOTHING: Hover = { grip: null, plus: null, x: null };

/** Each pane's own box in today's columns; a free screen's boxes say so themselves (data-fpane). */
const CLASSIC: Array<[PaneId, string]> = [
  ['sprint', '.lcol-wrap:has(> .lcol--sprint)'],
  ['elfoqsy', '.elf'],
  ['conversation', '.chat:not(.chat--rail)'],
  ['map', '.rcol--map'],
  ['terminals', '.rcol--terminals'],
];

function paneUnder(node: EventTarget | null): { pane: PaneId; el: Element } | null {
  if (!(node instanceof Element)) return null;
  const free = node.closest('[data-fpane]');
  if (free) return { pane: (free as HTMLElement).dataset.fpane as PaneId, el: free };
  for (const [pane, selector] of CLASSIC) {
    const el = node.closest(selector);
    if (el) return { pane, el };
  }
  return null;
}

export function ArrangedScreen({ screen, label, children }: { screen: 0 | 1; label: string; children: ReactNode }) {
  const { state, connection } = useWorkspace();
  // The Abilities view, when this window has it open: over the whole screen, the panes kept behind it as they are.
  const abilities = useAbilitiesView();
  const dragged = useDrag((d) => d.pane);
  const preview = useDrag((d) => d.preview);
  const pending = useDrag((d) => d.pending);
  // A drop is shown from the moment it is sent; a drop that gives today's arrangement is shown as today's screens.
  const effective = pending ? pending.layout : state.layout;
  const current = effective ?? DEFAULT_LAYOUT;
  const free = effective !== null || dragged !== null;
  const folded = useFolds();

  // What the handlers need, as it is when they run.
  const latest = useRef({ screen, current, saved: state.layout });
  latest.current = { screen, current, saved: state.layout };

  // The layout is what the daemon says: a drop is shown from the moment it is sent, until the event comes (or does not).
  useEffect(() => {
    if (pending === null) return;
    if (JSON.stringify(pending.layout) === JSON.stringify(state.layout)) return arranging.settle();
    const t = setTimeout(() => arranging.settle(), 1500);
    return () => clearTimeout(t);
  }, [pending, state.layout]);
  // A layout arrived (a drop in the other window, a reset): a drag that began here is over, whether or not the browser says so.
  useEffect(() => arranging.end(), [state.layout]);

  // The browser says a drag ended, or stops sending pointer events once it has.
  useEffect(() => {
    const end = () => arranging.end();
    const alive = () => {
      const d = arranging.get();
      if (d.pane && performance.now() - d.at > GRACE_MS) arranging.end();
    };
    document.addEventListener('dragend', end, true);
    window.addEventListener('pointermove', alive, true);
    window.addEventListener('keydown', alive, true);
    return () => {
      document.removeEventListener('dragend', end, true);
      window.removeEventListener('pointermove', alive, true);
      window.removeEventListener('keydown', alive, true);
    };
  }, []);

  // A drag from the other window that stopped sending events (its pointer went away without a dragleave) is not over this one.
  useEffect(() => {
    if (!dragged) return;
    const t = setInterval(() => {
      const d = arranging.get();
      if (d.pane && !d.source && performance.now() - d.at > SILENT_MS) arranging.leave();
    }, SILENT_MS / 3);
    return () => clearInterval(t);
  }, [dragged]);

  const over = (e: DragEvent<HTMLElement>) => {
    const pane = paneInDrag(e.dataTransfer?.types);
    if (!pane) return;
    const { screen: s, current: layout } = latest.current;
    const pt = toStage(e.currentTarget, e.clientX, e.clientY);
    const d = arranging.get();
    const base = without(layout, pane);
    // The pane in the hand is shown open, whatever it was; what this window has folded stays folded.
    const f = new Set([...folds.get()].filter((p) => p !== pane));
    // While the pointer is over the skeleton the target holds, so nothing flickers.
    const at = d.pane === pane ? d.preview?.rects[pane] : undefined;
    const held = at && pt.x >= at.x && pt.x <= at.x + at.w && pt.y >= at.y && pt.y <= at.y + at.h;
    let target: Target | null = held ? d.target : targetAt(pt, s, base[s], d.pane === pane && d.preview ? d.preview.rects : arrange(base[s], f).rects);
    let next = null;
    if (target) {
      const layoutAfter = insert(base, target, pane);
      // A drop that would push a pane below its minimum shows nothing, and does nothing.
      if (fits(layoutAfter)) next = { layout: layoutAfter, rects: arrange(layoutAfter[s], f).rects };
      else target = null;
    }
    arranging.over(pane, pt, target, next);
    if (next) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  // The pointer left the window: the browser's dragleave then has its point at an edge (or at 0, 0), where a move from one
  // element to another inside the window has it in the middle.
  const leave = (e: DragEvent<HTMLElement>) => {
    const edge = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
    if (edge) arranging.leave();
  };
  const drop = (e: DragEvent<HTMLElement>) => {
    if (!paneInDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    const given = arranging.get().preview?.layout;
    // Today's arrangement is saved as no layout. A drop that gives what is saved already sends nothing.
    const layout = given ? savedLayout(given) : undefined;
    if (layout !== undefined && !sameLayout(layout, latest.current.saved)) {
      // A pane that was folded is open where it lands, as its skeleton showed.
      const lifted = arranging.get().pane;
      if (lifted) folds.unfold(lifted);
      arranging.drop(layout);
      stream.setLayout(layout);
    } else arranging.end();
  };

  // The grip and the +: drawn in the stage, above the panes, near the pointer. In a free layout they come from the panes'
  // rectangles; in today's columns (no layout saved) only the grip does, from the column under the pointer.
  const [hover, setHover] = useState<Hover>(NOTHING);
  // The add menu is open: the + it belongs to stays where it is, and nothing else is offered.
  const [pinned, setPinned] = useState(false);
  const setIfChanged = (next: Hover) => setHover((h) => (JSON.stringify(h) === JSON.stringify(next) ? h : next));
  // Where the panes are changed under a pointer that has not moved (a pane folded, one removed, a layout arrived): what it was
  // near is not what is there now. It is offered again at the next move.
  useEffect(() => {
    if (!pinned) setHover(NOTHING);
  }, [effective, folded]); // eslint-disable-line react-hooks/exhaustive-deps
  const track = (e: PointerEvent<HTMLElement>) => {
    if (arranging.get().pane || pinned) return;
    const target = e.target as Element;
    if (target.closest?.('.pgrip, .fplus, .pane-xf')) return;
    const root = e.currentTarget;
    const pt = toStage(root, e.clientX, e.clientY);
    if (effective === null) {
      // Today's columns: the grip from the column under the pointer; the + from the boxes the page has for the panes of this
      // screen that are open; the x beside the hide button of the pane under the pointer.
      const hit = paneUnder(target);
      const here = DEFAULT_LAYOUT[screen].flat().filter((p) => !folded.has(p));
      const boxes: Boxes = {};
      for (const [pane, selector] of CLASSIC) {
        const el = here.includes(pane) ? root.querySelector(selector) : null;
        if (el) boxes[pane] = stageRect(el);
      }
      const grip = hit ? { pane: hit.pane, x: Math.round(stageRect(hit.el).x + stageRect(hit.el).w / 2), y: Math.round(stageRect(hit.el).y) } : null;
      const button = hit && !folded.has(hit.pane) ? hit.el.querySelector('button.collapse') : null;
      const x = hit && button ? { pane: hit.pane, ...xBeside(stageRect(button), hit.pane) } : null;
      return setIfChanged({ grip, plus: plusNear(boxes, pt, here), x });
    }
    const rects = arrange(current[screen], folded).rects;
    const ids = PANE_IDS.filter((id) => rects[id]);
    const lifted = gripPane(rects, pt, ids);
    const grip = lifted ? { pane: lifted, x: Math.round(rects[lifted]!.x + rects[lifted]!.w / 2), y: rects[lifted]!.y } : null;
    setIfChanged({ grip, plus: plusNear(rects, pt, ids), x: null });
  };

  return (
    <Stage
      label={label}
      offline={connection.offlineSince !== null}
      handlers={{ onDragEnter: over, onDragOver: over, onDragLeave: leave, onDrop: drop, onPointerMove: track, onPointerLeave: () => !pinned && setHover(NOTHING) }}
    >
      {free ? <FreeScreen screen={screen} state={state} connection={connection} current={current} dragged={dragged} preview={preview} /> : children}
      {abilities.open && <AbilitiesView state={state} now={stream.now()} />}
      <Grip at={abilities.open ? null : hover.grip} lifted={dragged !== null} />
      {hover.x && !dragged && !abilities.open && <PaneX at={hover.x} />}
      {hover.plus && !dragged && !abilities.open && (
        <AddPlus
          at={hover.plus}
          screen={screen}
          layout={current}
          onOpen={() => setPinned(true)}
          onClosed={() => {
            setPinned(false);
            setHover(NOTHING);
          }}
        />
      )}
      <Chip />
    </Stage>
  );
}

/** Today's x (no layout saved): beside the pane's hide button, it takes the pane off the screens, which saves today's arrangement without it. */
function PaneX({ at }: { at: { pane: PaneId; x: number; y: number; w: number; h: number } }) {
  const label = `Remove ${REMOVES[at.pane]} from this screen`;
  return (
    <button
      type="button"
      className="collapse pane-xf"
      data-xf={at.pane}
      aria-label={label}
      data-tip={label}
      style={{ left: at.x, top: at.y }}
      onClick={() => {
        folds.unfold(at.pane);
        stream.setLayout(without(DEFAULT_LAYOUT, at.pane));
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

function Grip({ at, lifted }: { at: { pane: PaneId; x: number; y: number } | null; lifted: boolean }) {
  return (
    <span
      className={`pgrip${at && !lifted ? ' pgrip--shown' : ''}`}
      role="button"
      aria-label={at ? `Move ${PANES[at.pane].name}: drag it to another place or screen` : 'Move a pane'}
      tabIndex={-1}
      draggable={!!at}
      data-grip={at?.pane}
      style={at ? { left: at.x - GRIP.w / 2, top: at.y - GRIP.h / 2 } : undefined}
      onDragStart={(e) => {
        if (!at) return e.preventDefault();
        const pane = at.pane;
        // The pane's id travels in the type, so a window under the pointer reads it before the drop.
        e.dataTransfer.setData(PANE_TYPE, pane);
        e.dataTransfer.setData(`${PANE_TYPE}-${pane}`, pane);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(blankImage(), 0, 0);
        // Not in this event: the browser takes the drag as it is when the handler returns, and a changed page can cancel it.
        requestAnimationFrame(() => arranging.start(pane));
      }}
      onDragEnd={() => arranging.end()}
    >
      <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true" fill="currentColor">
        {[3, 9, 15].flatMap((x) => [2, 8].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
      </svg>
    </span>
  );
}

/** The pane's name, following the pointer: drawn in the page, so it is where a window's own checks and pictures can see it. */
function Chip() {
  const pane = useDrag((d) => d.pane);
  const pt = useDrag((d) => d.pt);
  if (!pane || !pt) return null;
  return (
    <div className="fchip" data-chip={pane} aria-hidden="true" style={{ left: Math.round(pt.x) + 18, top: Math.round(pt.y) + 14 }}>
      <svg width="12" height="8" viewBox="0 0 16 10" fill="currentColor" aria-hidden="true">
        {[3, 8, 13].flatMap((x) => [2, 8].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" />))}
      </svg>
      {PANES[pane].name}
    </div>
  );
}
