// A pane being dragged (P2): what this window knows of it while the pointer is down, for the screen to draw a skeleton, make
// room and show the chip. It is not the layout (that is an event, folded in state.layout, and the same in both windows); it
// is only the drag, and it ends with the drop or the cancel. The drag itself is the browser's (HTML drag and drop), which is
// what crosses from one browser window to the other: the pane's id travels in the drag's type, so the window under the
// pointer knows which pane it is before anything is dropped.
import { useSyncExternalStore } from 'react';
import { PANE_IDS, type Layout, type PaneId, type Rects, type Target } from '@elfoqsy/state';

export const PANE_TYPE = 'application/x-elfoqsy-pane';

/** The pane a drag carries, read from its types (the only part of a drag a window may read before the drop), or null. */
export function paneInDrag(types: readonly string[] | undefined): PaneId | null {
  for (const t of types ?? []) {
    if (!t.startsWith(`${PANE_TYPE}-`)) continue;
    const id = t.slice(PANE_TYPE.length + 1);
    if ((PANE_IDS as readonly string[]).includes(id)) return id as PaneId;
  }
  return null;
}

export interface Pt {
  x: number;
  y: number;
}
export interface Preview {
  /** The layout the drop would give, and where each pane of this screen would be in it. */
  layout: Layout;
  rects: Rects;
}

export interface Drag {
  /** The pane being dragged: from this window, or from the other one over this one. */
  pane: PaneId | null;
  /** The drag began in this window. */
  source: boolean;
  /** The pointer in this window's stage pixels; null when it is not over this window. */
  pt: Pt | null;
  target: Target | null;
  preview: Preview | null;
  /** Dropped here and sent: shown until the daemon's event arrives (the log is the layout, not this). null inside: no layout. */
  pending: { layout: Layout | null } | null;
  /** When the drag last said anything here (performance.now, which no clock change moves): it began, or the pointer moved over this window. */
  at: number;
}

const IDLE: Drag = { pane: null, source: false, pt: null, target: null, preview: null, pending: null, at: 0 };
let current: Drag = IDLE;
const listeners = new Set<() => void>();
const set = (next: Drag) => {
  current = next;
  for (const l of listeners) l();
};

const sameTarget = (a: Target | null, b: Target | null): boolean => JSON.stringify(a) === JSON.stringify(b);

export const arranging = {
  get: (): Drag => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** The grip of a pane in this window was dragged. */
  start(pane: PaneId): void {
    set({ ...IDLE, pane, source: true, at: performance.now(), pending: current.pending });
  },
  /**
   * The pointer is over this window with a pane (its own, or the other window's). A target that has not changed keeps the
   * preview it had, so the screen does not redraw for a pointer that only moved.
   */
  over(pane: PaneId, pt: Pt, target: Target | null, preview: Preview | null): void {
    const same = sameTarget(target, current.target) && current.pane === pane;
    set({ ...current, pane, pt, target, at: performance.now(), preview: same && current.preview && preview ? current.preview : preview });
  },
  /** The pointer left this window: its own drag goes on (the pane stays lifted); the other's is no business of this one. */
  leave(): void {
    if (current.source) set({ ...current, pt: null, target: null, preview: null });
    else set({ ...IDLE, pending: current.pending });
  },
  /** Dropped here: the layout is sent and shown until the daemon says it. */
  drop(layout: Layout | null): void {
    set({ ...IDLE, pending: { layout } });
  },
  /** The drag is over, in this window or somewhere else; a layout awaiting its event is kept. */
  end(): void {
    if (current.pane === null) return;
    set({ ...IDLE, pending: current.pending });
  },
  /** The daemon has said the layout (or a moment has passed and it did not). */
  settle(): void {
    if (current.pending !== null) set({ ...current, pending: null });
  },
  /** Nothing in flight (tests). */
  reset(): void {
    set(IDLE);
  },
};

/** A part of the drag, so a screen that does not draw the pointer is not redrawn with it. */
export function useDrag<T>(select: (d: Drag) => T): T {
  return useSyncExternalStore(arranging.subscribe, () => select(current));
}

/** A client point in the stage's own 1920 × 1080 pixels (the stage is scaled to fit the window). */
export function toStage(stage: HTMLElement, clientX: number, clientY: number): Pt {
  const r = stage.getBoundingClientRect();
  const k = r.width / 1920;
  return { x: (clientX - r.left) / k, y: (clientY - r.top) / k };
}

/** A 1×1 transparent picture for the browser's own drag image: the chip is drawn in the page, where it can be checked. */
let blank: HTMLImageElement | undefined;
export function blankImage(): HTMLImageElement {
  if (!blank) {
    blank = new Image();
    blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  }
  return blank;
}
