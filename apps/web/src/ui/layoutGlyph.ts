// The hide and show icon of a pane in a free layout (P2): a miniature of the screen it is on, 26 × 18, drawn from the real
// layout. One bar per column, a thin bar for a folded column, a column's bar cut into a cell for each pane stacked in it; the
// pane's own cell is filled when it is open and dashed when it is folded, the others outlined. For today's arrangement (two or
// three columns of one pane) it is today's icon, number for number, so a screen laid out as today draws what it always did.

export interface GlyphPane {
  pane: string;
  folded: boolean;
}
export interface GlyphCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** This pane's own cell. */
  own: boolean;
  /** Its own cell is open: filled. */
  filled: boolean;
}

/** Today's icons: the width of a cell and the pitch between cells, for a screen of two or of three columns. */
const TODAY = {
  2: { width: 10.5, pitch: 14 },
  3: { width: 5.8, pitch: 9.3 },
} as const;
/** The space columns share, from the first cell's edge to the last one's, and the space between them. */
const SPAN = 24.5;
const EDGE = 0.8;
const FOLDED_WIDTH = 0.8;
const CELL_TOP = 0.75;
const CELL_HEIGHT = 16.5;
const STACK_GAP = 2;

/**
 * `thin`: a folded column is drawn as a thin bar (a free layout). Without it every column is as wide as the others and a folded
 * pane is only dashed, as today's icons are.
 */
export function layoutGlyph(columns: GlyphPane[][], own: string, thin = true): GlyphCell[] {
  const n = columns.length;
  const foldedColumn = columns.map((c) => thin && c.every((p) => p.folded));
  // Today's icons: two or three columns of one pane, none of them thin.
  const today = (n === 2 || n === 3) && columns.every((c) => c.length === 1) && !foldedColumn.some(Boolean) ? TODAY[n] : null;
  const gap = n <= 3 ? 3.5 : 2.5;
  const openCount = foldedColumn.filter((f) => !f).length;
  const openWidth = openCount ? (SPAN - gap * (n - 1) - FOLDED_WIDTH * (n - openCount)) / openCount : 0;
  const cells: GlyphCell[] = [];
  let x = EDGE;
  columns.forEach((column, ci) => {
    const w = today ? today.width : foldedColumn[ci] ? FOLDED_WIDTH : openWidth;
    const k = column.length;
    const segment = (CELL_HEIGHT - STACK_GAP * (k - 1)) / k;
    column.forEach((p, ri) => {
      cells.push({ x, y: CELL_TOP + ri * (segment + STACK_GAP), w, h: segment, own: p.pane === own, filled: p.pane === own && !p.folded });
    });
    x += today ? today.pitch : w + gap;
  });
  return cells;
}

/** The icon today's collapse buttons draw for a column of a screen of 2 or 3: the same cells, as the layout glyph's. */
export const todaysGlyph = (cells: 2 | 3, index: number, shown: boolean): GlyphCell[] =>
  layoutGlyph(
    Array.from({ length: cells }, (_, i) => [{ pane: String(i), folded: i === index && !shown }]),
    String(index),
    false,
  );
