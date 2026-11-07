// How the two screens are arranged (P2): pure geometry over a layout, shared by the windows, the daemon (which refuses an
// arrangement that does not fit) and the tests. A screen is a row of columns, each a stack of panes; the stage is a fixed
// 1920 × 1080 (stage/Stage.tsx), the top row is 80 px, panes sit 40 px from the sides and 20 px apart. The model is the
// brief's ArrangePlay: each pane has a preferred and a minimum width, every pane a minimum height of 240 for stacking, spare
// width goes to Conversation and Terminals first, then Sprint and Agent map, and Elfoqsy grows only when alone. A pane may be
// folded (a rail when it is alone in its column, a bar inside a stack) or left off the screens altogether.
import type { Layout, PaneId, ScreenLayout } from '@elfoqsy/contracts';

export type { Layout, PaneId, ScreenLayout };
export const PANE_IDS: readonly PaneId[] = ['sprint', 'elfoqsy', 'conversation', 'map', 'terminals'];

export interface PaneSpec {
  name: string;
  /** Preferred width: what a column of this pane asks for. */
  pref: number;
  /** The narrowest slot it renders correctly in. */
  min: number;
  /** Share of spare width: Conversation and Terminals first, then Sprint and Agent map; Elfoqsy grows only when alone. */
  flex: number;
}

export const PANES: Record<PaneId, PaneSpec> = {
  sprint: { name: 'Sprint', pref: 840, min: 240, flex: 0.6 },
  elfoqsy: { name: 'Elfoqsy', pref: 342, min: 330, flex: 0 },
  conversation: { name: 'Conversation', pref: 618, min: 380, flex: 1 },
  map: { name: 'Agent map', pref: 640, min: 300, flex: 0.6 },
  terminals: { name: 'Terminals', pref: 1180, min: 300, flex: 1 },
};

/** Every pane's minimum height, so that stacks of them fit a screen. */
export const MIN_HEIGHT = 240;

/** Where panes go on a screen: below the top row (the status cluster and the screen menu), clear of the sides. */
export const AREA = { x: 40, y: 80, w: 1840, h: 972 } as const;
export const GAP = 20;

/** No layout saved: today's arrangement, as a layout (what a drag starts from, and what Reset goes back to). */
export const DEFAULT_LAYOUT: Layout = [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** How a folded pane is shown: today's rail (a column of its own, narrow and as tall as the screen), or a bar inside a stack. */
export type Fold = 'rail' | 'bar';
export interface PlacedRect extends Rect {
  fold?: Fold;
}
export type Rects = Partial<Record<PaneId, PlacedRect>>;
export interface Arranged {
  rects: Rects;
  /** Every open pane is at least its minimum size. */
  ok: boolean;
}

/** A folded column is as wide as today's rail (--rail-width); a folded pane in a stack is a bar this high. */
export const RAIL_WIDTH = 56;
export const BAR_HEIGHT = 48;
const NONE: ReadonlySet<PaneId> = new Set();

const sum = (n: number[]): number => n.reduce((a, b) => a + b, 0);

/**
 * The rectangles of one screen's panes, in that screen's own stage coordinates, and whether they all fit. `folded` names the
 * panes shown as rails or bars: a folded pane alone in its column is a rail (RAIL_WIDTH wide, all the height, never grown); in
 * a stack it is a bar (BAR_HEIGHT high) and the open panes share what is left; a stack of folded panes is as wide as its
 * narrowest open form would be, and does not grow.
 */
export function arrange(screen: ScreenLayout, folded: ReadonlySet<PaneId> = NONE): Arranged {
  const rects: Rects = {};
  let ok = true;
  const n = screen.length;
  if (!n) return { rects, ok };
  const avail = AREA.w - GAP * (n - 1);
  const open = screen.map((c) => c.filter((p) => !folded.has(p)));
  const rail = screen.map((c) => c.length === 1 && folded.has(c[0]!));
  const stack = screen.map((_, i) => !rail[i] && open[i]!.length === 0);
  const pref = screen.map((c, i) => (rail[i] ? RAIL_WIDTH : stack[i] ? Math.max(...c.map((p) => PANES[p].min)) : Math.max(...open[i]!.map((p) => PANES[p].pref))));
  const min = screen.map((c, i) => (rail[i] ? RAIL_WIDTH : stack[i] ? Math.max(...c.map((p) => PANES[p].min)) : Math.max(...open[i]!.map((p) => PANES[p].min))));
  const flex = screen.map((_, i) => (rail[i] || stack[i] ? 0 : Math.max(...open[i]!.map((p) => PANES[p].flex))));
  let w = pref.slice();
  const total = sum(pref);
  if (total > avail) {
    const need = total - avail;
    const room = sum(pref.map((p, i) => p - min[i]!));
    if (room < need) {
      ok = false;
      w = min.slice();
    } else w = pref.map((p, i) => p - ((p - min[i]!) * need) / room);
  } else if (total < avail) {
    const extra = avail - total;
    const growing = screen.map((_, i) => i).filter((i) => !rail[i] && !stack[i]);
    const top = Math.max(0, ...growing.map((i) => flex[i]!));
    const share = growing.filter((i) => (top > 0 ? flex[i] === top : true));
    const base = sum(share.map((i) => pref[i]!));
    for (const i of share) w[i] = w[i]! + (extra * pref[i]!) / base;
  }
  let x = AREA.x;
  screen.forEach((column, ci) => {
    const k = column.length;
    // Edges are rounded, not sizes, so neighbours never overlap or leave a seam.
    const x0 = Math.round(x);
    const x1 = Math.round(x + w[ci]!);
    if (rail[ci]) {
      rects[column[0]!] = { x: x0, y: AREA.y, w: x1 - x0, h: AREA.h, fold: 'rail' };
      x += w[ci]! + GAP;
      return;
    }
    const bars = k - open[ci]!.length;
    const h = open[ci]!.length ? (AREA.h - GAP * (k - 1) - BAR_HEIGHT * bars) / open[ci]!.length : BAR_HEIGHT;
    if (open[ci]!.length && h < MIN_HEIGHT) ok = false;
    let top = AREA.y;
    for (const pane of column) {
      const hh = folded.has(pane) ? BAR_HEIGHT : h;
      const y0 = Math.round(top);
      rects[pane] = { x: x0, y: y0, w: x1 - x0, h: Math.round(top + hh) - y0, ...(folded.has(pane) ? { fold: 'bar' as const } : {}) };
      top += hh + GAP;
    }
    x += w[ci]! + GAP;
  });
  return { rects, ok };
}

/**
 * Both screens fit: no pane is smaller than its minimum, no column holds more panes than the height allows. This is about the
 * panes open: what is saved always fits, so folding is a way to see less, never a way to have more, and a folded pane can
 * always be shown again.
 */
export const fits = (layout: Layout): boolean => arrange(layout[0]).ok && arrange(layout[1]).ok;


/** Where a dragged pane would go: a new column at an index, or a row in an existing column. */
export type Target = { screen: 0 | 1; kind: 'col'; col: number } | { screen: 0 | 1; kind: 'row'; col: number; row: number };

/** The layout without a pane: its column goes with it when it was alone in it. */
export function without(layout: Layout, pane: PaneId): Layout {
  const strip = (screen: ScreenLayout): ScreenLayout => screen.map((c) => c.filter((p) => p !== pane)).filter((c) => c.length);
  return [strip(layout[0]), strip(layout[1])];
}

/** The layout with a pane put at a target (the layout it is put into has not got it). */
export function insert(base: Layout, target: Target, pane: PaneId): Layout {
  const copy: Layout = [base[0].map((c) => c.slice()), base[1].map((c) => c.slice())];
  const columns = copy[target.screen];
  if (target.kind === 'col') columns.splice(target.col, 0, [pane]);
  else columns[target.col]!.splice(target.row, 0, pane);
  return copy;
}

/**
 * The zone a pointer is in, read from the panes as they are shown (`rects`, of `base`'s panes on that screen): the top
 * quarter of a pane stacks the moved pane above it, the bottom quarter below it, and elsewhere the left or right half
 * puts it in a new column on that side. Over nothing, there is no target; an empty screen takes a drop anywhere.
 */
export function targetAt(pt: { x: number; y: number }, screen: 0 | 1, base: ScreenLayout, rects: Rects): Target | null {
  if (!base.length) return { screen, kind: 'col', col: 0 };
  for (let ci = 0; ci < base.length; ci++) {
    const column = base[ci]!;
    for (let ri = 0; ri < column.length; ri++) {
      const r = rects[column[ri]!];
      if (!r || pt.x < r.x || pt.x > r.x + r.w || pt.y < r.y || pt.y > r.y + r.h) continue;
      const fy = (pt.y - r.y) / r.h;
      const fx = (pt.x - r.x) / r.w;
      if (fy < 0.25) return { screen, kind: 'row', col: ci, row: ri };
      if (fy > 0.75) return { screen, kind: 'row', col: ci, row: ri + 1 };
      return { screen, kind: 'col', col: fx < 0.5 ? ci : ci + 1 };
    }
  }
  return null;
}

export const sameLayout = (a: Layout | null, b: Layout | null): boolean => JSON.stringify(a ?? DEFAULT_LAYOUT) === JSON.stringify(b ?? DEFAULT_LAYOUT);

/**
 * What is saved for an arrangement: today's arrangement is no layout at all, so the screens go back to today's own geometry
 * by themselves, and a layout is only ever kept when it is one of his own.
 */
export const savedLayout = (layout: Layout | null): Layout | null => (layout && sameLayout(layout, null) ? null : layout);

/** The screen a pane is on, in a layout; null for a pane that has been removed from the screens. */
export const screenOf = (layout: Layout, pane: PaneId): 0 | 1 | null => (layout[0].some((c) => c.includes(pane)) ? 0 : layout[1].some((c) => c.includes(pane)) ? 1 : null);

/** The panes on neither screen. */
export const removedPanes = (layout: Layout): PaneId[] => PANE_IDS.filter((p) => screenOf(layout, p) === null);

/**
 * A pane put on a screen, from a menu: a column of its own at the end, or, when the screen has no room for another column, on
 * the bottom of the column that takes it; null when it fits nowhere. It leaves where it was, if it was on a screen.
 */
export function addToScreen(layout: Layout, pane: PaneId, screen: 0 | 1): Layout | null {
  const base = without(layout, pane);
  const attempts: Layout[] = [insert(base, { screen, kind: 'col', col: base[screen].length }, pane)];
  base[screen].forEach((column, col) => attempts.push(insert(base, { screen, kind: 'row', col, row: column.length }, pane)));
  return attempts.find(fits) ?? null;
}

/** A pane moved to the other screen, from its menu. */
export function moveToOtherScreen(layout: Layout, pane: PaneId): Layout | null {
  const from = screenOf(layout, pane);
  return addToScreen(layout, pane, from === 0 ? 1 : 0);
}

/** A pane moved to a screen, from the empty screen's buttons: alone on it, in a column. */
export const bringHere = (layout: Layout, pane: PaneId, screen: 0 | 1): Layout => insert(without(layout, pane), { screen, kind: 'col', col: 0 }, pane);

export type Side = 'left' | 'right' | 'above' | 'below';

/**
 * A pane put beside another (the + at its edge): left or right, a column of its own; above or below, in its column. The pane
 * comes from where it was, if it was on a screen. Null when the other pane is not on a screen; it may not fit (see `fits`).
 */
export function placeBeside(layout: Layout, anchor: PaneId, side: Side, pane: PaneId): Layout | null {
  const base = without(layout, pane);
  for (const screen of [0, 1] as const) {
    for (let col = 0; col < base[screen].length; col++) {
      const row = base[screen][col]!.indexOf(anchor);
      if (row < 0) continue;
      const target: Target = side === 'left' ? { screen, kind: 'col', col } : side === 'right' ? { screen, kind: 'col', col: col + 1 } : side === 'above' ? { screen, kind: 'row', col, row } : { screen, kind: 'row', col, row: row + 1 };
      return insert(base, target, pane);
    }
  }
  return null;
}
