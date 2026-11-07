import { describe, expect, it } from 'vitest';
import {
  GAP,
  MIN_H,
  MIN_W,
  canSplit,
  close,
  dragRatio,
  initialTree,
  layout,
  leaf,
  leaves,
  moveFocus,
  resizeFocused,
  split,
  type PaneNode,
  type Side,
} from '../src/right/terminals/tree';

const BOX = { w: 1022, h: 940 };
const tiles = (t: PaneNode, w = BOX.w, h = BOX.h) => layout(t, 0, 0, w, h);
const ids = (t: PaneNode) => tiles(t).tiles.map((x) => x.leaf.runId);

describe('panes: the first layout', () => {
  it('gives two agents side by side, three as one beside a column of two, and four in a 2x2 grid (v3)', () => {
    expect(ids(initialTree(['r3', 'r4']))).toEqual(['r3', 'r4']);
    expect(ids(initialTree(['r3', 'r4', 'r5']))).toEqual(['r3', 'r4', 'r5']);
    const four = tiles(initialTree(['a', 'b', 'c', 'd'])).tiles;
    expect(four.map((t) => t.leaf.runId)).toEqual(['a', 'b', 'c', 'd']);
    expect([four[0]!.x === four[2]!.x, four[1]!.x === four[3]!.x, four[0]!.y === four[1]!.y, four[2]!.y === four[3]!.y]).toEqual([true, true, true, true]);
    expect(ids(initialTree([]))).toEqual([null]);
  });
});

describe('panes: never smaller than 320 by 190', () => {
  it('refuses a split without room for two', () => {
    const t = initialTree(['a', 'b']);
    const { tiles: ts } = tiles(t);
    expect(ts[0]!.w).toBe(505);
    expect(canSplit(ts[0], 'right')).toBe(false);
    expect(split(t, ts, ts[0]!.leaf.id, 'right', leaf(null))).toBeNull();
    expect(split(t, ts, ts[0]!.leaf.id, 'down', leaf(null))).not.toBeNull();
  });

  it('stops keyboard resizes and drags at the minimum', () => {
    let t = initialTree(['a', 'b']);
    const focus = tiles(t).tiles[0]!.leaf.id;
    for (let i = 0; i < 40; i++) t = resizeFocused(t, tiles(t).dividers, focus, -0.05);
    expect(tiles(t).tiles[0]!.w).toBe(MIN_W);
    for (let i = 0; i < 40; i++) t = resizeFocused(t, tiles(t).dividers, focus, 0.05);
    expect(tiles(t).tiles[1]!.w).toBe(MIN_W);
    const d = tiles(t).dividers[0]!;
    expect(dragRatio(d, -500) * d.span).toBeCloseTo(MIN_W, 0);
    expect((1 - dragRatio(d, 5000)) * d.span).toBeCloseTo(MIN_W, 0);
  });

  it('keeps every pane at least 320 by 190 through any sequence of splits, resizes and closes', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sides: Side[] = ['left', 'right', 'up', 'down'];
    for (let run = 0; run < 300; run++) {
      const [w, h] = run % 3 === 0 ? [700, 640] : [BOX.w, BOX.h];
      let t: PaneNode = initialTree(['a', 'b', 'c', 'd'].slice(0, w < 1000 ? 2 : 4));
      for (let step = 0; step < 60; step++) {
        const { tiles: ts, dividers } = tiles(t, w, h);
        for (const x of ts) {
          expect(x.w, JSON.stringify(x)).toBeGreaterThanOrEqual(MIN_W);
          expect(x.h, JSON.stringify(x)).toBeGreaterThanOrEqual(MIN_H);
        }
        const pick = ts[Math.floor(rand() * ts.length)]!;
        const r = rand();
        if (r < 0.4) t = split(t, ts, pick.leaf.id, sides[Math.floor(rand() * 4)]!, leaf(null)) ?? t;
        else if (r < 0.8) t = resizeFocused(t, dividers, pick.leaf.id, (rand() - 0.5) * 0.6);
        else t = close(t, pick.leaf.id)?.tree ?? t;
      }
    }
  });

  it('clamps a stored ratio when the box gets smaller, rather than squeezing a pane', () => {
    let t = initialTree(['a', 'b']);
    const focus = tiles(t).tiles[1]!.leaf.id;
    for (let i = 0; i < 10; i++) t = resizeFocused(t, tiles(t).dividers, focus, -0.05);
    const narrow = tiles(t, 2 * MIN_W + GAP + 10).tiles;
    expect(narrow.every((x) => x.w >= MIN_W)).toBe(true);
  });
});

describe('panes: focus and closing', () => {
  it('moves focus to the neighbour that shares an edge, like Zellij', () => {
    const t = initialTree(['a', 'b', 'c', 'd']);
    const ts = tiles(t).tiles;
    const id = (run: string) => ts.find((x) => x.leaf.runId === run)!.leaf.id;
    expect(moveFocus(ts, id('a'), 'right')).toBe(id('b'));
    expect(moveFocus(ts, id('a'), 'down')).toBe(id('c'));
    expect(moveFocus(ts, id('b'), 'down')).toBe(id('d'));
    expect(moveFocus(ts, id('d'), 'up')).toBe(id('b'));
    expect(moveFocus(ts, id('c'), 'right')).toBe(id('d'));
    expect(moveFocus(ts, id('a'), 'left')).toBe(id('a'));
  });

  it('gives a closed pane’s space to its sibling, and never closes the last one', () => {
    const t = initialTree(['a', 'b']);
    const [a, b] = leaves(t);
    const next = close(t, a!.id)!;
    expect(leaves(next.tree).map((l) => l.runId)).toEqual(['b']);
    expect(next.focus).toBe(b!.id);
    expect(close(next.tree, b!.id)).toBeNull();
  });
});
