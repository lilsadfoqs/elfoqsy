// The hide and show icon in a free layout (P2) draws the layout, and for today's arrangement is today's icon.
import { describe, expect, it } from 'vitest';
import { layoutGlyph, todaysGlyph, type GlyphPane } from '../src/ui/layoutGlyph';

/** Today's CollapseButton, as it was before P2: the rectangles it drew for a column of a screen of 2 or 3. */
function legacy(cells: 2 | 3, index: number, shown: boolean) {
  const { width, pitch } = { 2: { width: 10.5, pitch: 14 }, 3: { width: 5.8, pitch: 9.3 } }[cells];
  return Array.from({ length: cells }, (_, i) => {
    const x = 0.8 + i * pitch;
    return i === index && shown ? { x: x - 0.8, y: 0.75, w: width + 1.5, h: 16.5, fill: true } : { x, y: 0.75, w: width, h: 16.5, fill: false, dashed: i === index };
  });
}
const drawn = (cells: ReturnType<typeof layoutGlyph>) => cells.map((c) => (c.filled ? { x: c.x - 0.8, y: c.y, w: c.w + 1.5, h: c.h, fill: true } : { x: c.x, y: c.y, w: c.w, h: c.h, fill: false, dashed: c.own }));
const column = (...panes: Array<[string, boolean?]>): GlyphPane[] => panes.map(([pane, folded]) => ({ pane, folded: !!folded }));

describe("today's icons", () => {
  it('are what a screen of two or three columns draws, for every column, open and folded', () => {
    for (const cells of [2, 3] as const) {
      for (let index = 0; index < cells; index++) {
        for (const shown of [true, false]) {
          const got = drawn(todaysGlyph(cells, index, shown));
          const want = legacy(cells, index, shown);
          expect(got.length).toBe(want.length);
          got.forEach((g, i) => {
            for (const k of ['x', 'y', 'w', 'h'] as const) expect(g[k]).toBeCloseTo(want[i]![k], 9);
            expect(g.fill).toBe(want[i]!.fill);
            expect(!!g.dashed).toBe(!!(want[i] as { dashed?: boolean }).dashed);
          });
        }
      }
    }
  });

  it('are also what a free layout in today’s arrangement draws, while nothing is folded', () => {
    const left = [column(['sprint']), column(['elfoqsy']), column(['conversation'])];
    for (const [i, pane] of ['sprint', 'elfoqsy', 'conversation'].entries()) {
      expect(drawn(layoutGlyph(left, pane))).toEqual(drawn(todaysGlyph(3, i, true)));
    }
    const right = [column(['map']), column(['terminals'])];
    expect(drawn(layoutGlyph(right, 'terminals'))).toEqual(drawn(todaysGlyph(2, 1, true)));
  });
});

describe('the layout drawn', () => {
  it('has one bar per column and a cell for each pane stacked in it, the pane’s own filled when open', () => {
    const cols = [column(['sprint']), column(['elfoqsy', true], ['conversation']), column(['map'])];
    const cells = layoutGlyph(cols, 'conversation');
    expect(cells).toHaveLength(4);
    const xs = [...new Set(cells.map((c) => c.x))];
    expect(xs).toHaveLength(3); // three columns
    const stacked = cells.filter((c) => c.x === cells[1]!.x);
    expect(stacked).toHaveLength(2);
    expect(stacked[0]!.y + stacked[0]!.h).toBeLessThan(stacked[1]!.y); // a gap between the cells of one column
    expect(cells.filter((c) => c.own)).toHaveLength(1);
    expect(cells.find((c) => c.own)!.filled).toBe(true);
    // Everything stays in the 26 × 18 box.
    for (const c of cells) {
      expect(c.x - 0.8).toBeGreaterThanOrEqual(-0.8);
      expect(c.x + c.w + 0.8).toBeLessThanOrEqual(26.1);
      expect(c.y + c.h + 0.75).toBeLessThanOrEqual(18);
    }
  });

  it('draws a folded column thin, and the pane’s own cell dashed when it is folded', () => {
    const cols = [column(['sprint']), column(['elfoqsy', true]), column(['conversation'])];
    const cells = layoutGlyph(cols, 'elfoqsy');
    const thin = cells[1]!;
    expect(thin.w).toBeLessThan(cells[0]!.w / 3);
    expect(thin.own && !thin.filled).toBe(true); // dashed
    // The open columns share the width the thin one left: wider than they are in today's icon.
    expect(cells[0]!.w).toBeGreaterThan(5.8);
    // A folded pane inside a stack leaves its column as wide as the others.
    const stack = layoutGlyph([column(['sprint']), column(['elfoqsy'], ['conversation', true])], 'conversation');
    expect(stack[1]!.w).toBe(stack[2]!.w);
  });

  it('fits five columns in the box without a cell vanishing', () => {
    const five = ['sprint', 'elfoqsy', 'conversation', 'map', 'terminals'].map((p) => column([p]));
    const cells = layoutGlyph(five, 'map');
    expect(cells).toHaveLength(5);
    for (const c of cells) expect(c.w).toBeGreaterThan(2);
    expect(cells.at(-1)!.x + cells.at(-1)!.w + 0.75).toBeLessThanOrEqual(26.1);
  });
});
