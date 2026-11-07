// The screens' layout engine (P2): the geometry of a screen, the zones a pointer is in, and what a move does to a layout. Pure.
import { describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { AREA, BAR_HEIGHT, DEFAULT_LAYOUT, GAP, MIN_HEIGHT, PANES, RAIL_WIDTH, addToScreen, arrange, bringHere, fits, foldAll, insert, moveToOtherScreen, placeBeside, removedPanes, sameLayout, savedLayout, screenOf, targetAt, without, type Layout, type PaneId } from '@elfoqsy/state';

describe("today's arrangement on the engine's geometry", () => {
  it('gives each pane its preferred width on a screen that has exactly the room', () => {
    const left = arrange(DEFAULT_LAYOUT[0]);
    expect(left.ok).toBe(true);
    expect(left.rects.sprint).toEqual({ x: 40, y: 80, w: 840, h: 972 });
    expect(left.rects.elfoqsy).toEqual({ x: 900, y: 80, w: 342, h: 972 });
    expect(left.rects.conversation).toEqual({ x: 1262, y: 80, w: 618, h: 972 });
    const right = arrange(DEFAULT_LAYOUT[1]);
    expect(right.rects.map).toEqual({ x: 40, y: 80, w: 640, h: 972 });
    expect(right.rects.terminals).toEqual({ x: 700, y: 80, w: 1180, h: 972 });
  });

  it('is exactly what no layout saved means', () => {
    expect(sameLayout(null, DEFAULT_LAYOUT)).toBe(true);
    expect(sameLayout([[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]], null)).toBe(false);
    expect(fits(DEFAULT_LAYOUT)).toBe(true);
  });
});

describe('spare width, and a shortage', () => {
  it('goes to Conversation and Terminals first, then Sprint and Agent map; Elfoqsy grows only when alone', () => {
    // Sprint and Conversation: 840 + 618 + 20 leaves 362; only the 1-flex Conversation takes it.
    const sc = arrange([['sprint'], ['conversation']]).rects;
    expect(sc.sprint!.w).toBe(840);
    expect(sc.conversation!.w).toBe(1840 - 840 - GAP);
    // Sprint and Agent map share it by their preferences (equal flex).
    const sm = arrange([['sprint'], ['map']]).rects;
    expect(sm.sprint!.w + sm.map!.w + GAP).toBe(1840);
    expect(sm.sprint!.w / sm.map!.w).toBeCloseTo(840 / 640, 1);
    // Elfoqsy beside Sprint stays at its preference.
    expect(arrange([['elfoqsy'], ['sprint']]).rects.elfoqsy!.w).toBe(342);
    // Elfoqsy alone fills the screen, and so does any pane alone.
    expect(arrange([['elfoqsy']]).rects.elfoqsy!.w).toBe(1840);
    expect(arrange([['terminals']]).rects.terminals!.w).toBe(1840);
  });

  it('shrinks every column toward its minimum, never under it, when the preferences do not fit', () => {
    const all: PaneId[][] = [['sprint'], ['elfoqsy'], ['conversation'], ['map'], ['terminals']];
    const a = arrange(all);
    expect(a.ok).toBe(true);
    for (const [pane] of all) expect(a.rects[pane!]!.w, pane).toBeGreaterThanOrEqual(PANES[pane!].min);
    const total = all.reduce((n, [p]) => n + a.rects[p!]!.w, 0);
    expect(total + 4 * GAP).toBe(AREA.w);
    // Panes tile with the gap between them and no overlap.
    const cols = all.map(([p]) => a.rects[p!]!);
    for (let i = 1; i < cols.length; i++) expect(cols[i]!.x - (cols[i - 1]!.x + cols[i - 1]!.w)).toBe(GAP);
  });

  it('says it does not fit when a stack leaves a pane under the minimum height', () => {
    // Three stacked are 310 high; four are 228, under 240.
    expect(arrange([['sprint', 'elfoqsy', 'conversation']]).ok).toBe(true);
    expect(arrange([['sprint', 'elfoqsy', 'conversation']]).rects.elfoqsy!.h).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(arrange([['sprint', 'elfoqsy', 'conversation', 'map']]).ok).toBe(false);
  });

  it('shares the height of a stack equally, with the gap between its panes', () => {
    const r = arrange([['map', 'terminals']]).rects;
    expect(r.map).toMatchObject({ y: 80, h: 476 });
    expect(r.terminals!.y).toBe(80 + 476 + GAP);
    expect(r.terminals!.y + r.terminals!.h).toBe(AREA.y + AREA.h);
  });

  it('has no seam: columns tile from side to side at whole pixels', () => {
    for (const screen of [[['sprint'], ['conversation', 'map'], ['terminals']], [['elfoqsy'], ['map'], ['conversation']]] as PaneId[][][]) {
      const a = arrange(screen);
      const cols = screen.map(([p]) => a.rects[p!]!);
      expect(cols[0]!.x).toBe(AREA.x);
      expect(cols.at(-1)!.x + cols.at(-1)!.w).toBe(AREA.x + AREA.w);
      for (const r of Object.values(a.rects)) for (const n of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(n)).toBe(true);
    }
  });
});

describe('the zones of a drag', () => {
  const base = without(DEFAULT_LAYOUT, 'conversation'); // Sprint, Elfoqsy | Map, Terminals
  const rects = arrange(base[0]).rects;
  const sprint = rects.sprint!;

  it('stacks above in the top quarter of a pane, below in the bottom quarter, and puts a new column left or right elsewhere', () => {
    const at = (fx: number, fy: number) => targetAt({ x: sprint.x + sprint.w * fx, y: sprint.y + sprint.h * fy }, 0, base[0], rects);
    expect(at(0.5, 0.1)).toEqual({ screen: 0, kind: 'row', col: 0, row: 0 });
    expect(at(0.5, 0.9)).toEqual({ screen: 0, kind: 'row', col: 0, row: 1 });
    expect(at(0.2, 0.5)).toEqual({ screen: 0, kind: 'col', col: 0 });
    expect(at(0.8, 0.5)).toEqual({ screen: 0, kind: 'col', col: 1 });
    expect(at(0.5, 0.24)).toMatchObject({ kind: 'row', row: 0 });
    expect(at(0.5, 0.26)).toMatchObject({ kind: 'col' });
  });

  it('has no target over the top row, a gap or the margin, and takes a drop anywhere on an empty screen', () => {
    expect(targetAt({ x: 100, y: 40 }, 0, base[0], rects)).toBeNull();
    expect(targetAt({ x: sprint.x + sprint.w + GAP / 2, y: 500 }, 0, base[0], rects)).toBeNull();
    expect(targetAt({ x: 5, y: 5 }, 1, [], {})).toEqual({ screen: 1, kind: 'col', col: 0 });
  });

  it('puts the moved pane exactly where the zone said, and leaves the others as they were', () => {
    const left = insert(base, { screen: 0, kind: 'col', col: 0 }, 'conversation');
    expect(left[0]).toEqual([['conversation'], ['sprint'], ['elfoqsy']]);
    const below = insert(base, { screen: 0, kind: 'row', col: 0, row: 1 }, 'conversation');
    expect(below[0]).toEqual([['sprint', 'conversation'], ['elfoqsy']]);
    const other = insert(base, { screen: 1, kind: 'row', col: 1, row: 0 }, 'conversation');
    expect(other[1]).toEqual([['map'], ['conversation', 'terminals']]);
    expect(base).toEqual([[['sprint'], ['elfoqsy']], [['map'], ['terminals']]]); // never changed in place
  });

  it('takes a pane out with its column when it was alone, and out of a stack without the column', () => {
    expect(without(DEFAULT_LAYOUT, 'elfoqsy')[0]).toEqual([['sprint'], ['conversation']]);
    const stacked: Layout = [[['sprint', 'conversation'], ['elfoqsy']], [['map'], ['terminals']]];
    expect(without(stacked, 'sprint')[0]).toEqual([['conversation'], ['elfoqsy']]);
    expect(without(stacked, 'conversation')[0]).toEqual([['sprint'], ['elfoqsy']]);
  });

  it('does not fit a drop that would push a pane below its minimum: a fourth in a column', () => {
    const three: Layout = [[['sprint', 'elfoqsy', 'conversation']], [['map'], ['terminals']]];
    expect(fits(three)).toBe(true);
    const four = insert(without(three, 'map'), { screen: 0, kind: 'row', col: 0, row: 3 }, 'map');
    expect(fits(four)).toBe(false);
  });
});

describe('the screen menu', () => {
  it('moves a pane to the other screen as a column of its own, and the layout still fits', () => {
    const moved = moveToOtherScreen(DEFAULT_LAYOUT, 'conversation')!;
    expect(moved[0]).toEqual([['sprint'], ['elfoqsy']]);
    expect(moved[1]).toEqual([['map'], ['terminals'], ['conversation']]);
    expect(fits(moved)).toBe(true);
    expect(screenOf(moved, 'conversation')).toBe(1);
    expect(moveToOtherScreen(moved, 'conversation')![0]).toEqual([['sprint'], ['elfoqsy'], ['conversation']]);
  });

  it('can empty a screen, and bringing a pane back puts it alone on it', () => {
    let layout: Layout = DEFAULT_LAYOUT;
    for (const pane of ['map', 'terminals'] as PaneId[]) layout = moveToOtherScreen(layout, pane) ?? layout;
    expect(layout[1]).toEqual([]);
    expect(fits(layout)).toBe(true);
    const back = bringHere(layout, 'terminals', 1);
    expect(back[1]).toEqual([['terminals']]);
    expect(back[0].flat()).not.toContain('terminals');
    expect(fits(back)).toBe(true);
  });

  it('always finds a place for a pane on the other screen: five panes cannot crowd a screen out of width', () => {
    const layouts: Layout[] = [
      DEFAULT_LAYOUT,
      [[['sprint'], ['elfoqsy'], ['conversation'], ['map']], [['terminals']]],
      [[['sprint', 'elfoqsy', 'conversation']], [['map'], ['terminals']]],
      [[], [['sprint', 'elfoqsy', 'conversation'], ['map'], ['terminals']]],
    ];
    for (const layout of layouts) {
      for (const pane of layout.flat(2)) {
        const moved = moveToOtherScreen(layout, pane);
        expect(moved, `${pane} in ${JSON.stringify(layout)}`).not.toBeNull();
        expect(fits(moved!)).toBe(true);
        expect(screenOf(moved!, pane)).toBe(screenOf(layout, pane) === 0 ? 1 : 0);
        expect([...moved!.flat(2)].sort()).toEqual([...layout.flat(2)].sort());
      }
    }
  });
});

describe('folded panes: rails and bars', () => {
  const fold = (...p: PaneId[]) => new Set<PaneId>(p);

  it('makes a lone folded pane a rail, as wide as today\'s and as tall as the screen, and gives its width to the others', () => {
    const a = arrange(DEFAULT_LAYOUT[0], fold('elfoqsy'));
    expect(a.ok).toBe(true);
    expect(a.rects.elfoqsy).toEqual({ x: 900, y: 80, w: RAIL_WIDTH, h: 972, fold: 'rail' });
    // Sprint stays at its preference; the room the rail left goes to the conversation, the pane that takes spare width first.
    expect(a.rects.sprint!.w).toBe(840);
    expect(a.rects.conversation!.x).toBe(900 + RAIL_WIDTH + GAP);
    expect(a.rects.conversation!.x + a.rects.conversation!.w).toBe(AREA.x + AREA.w);
    expect(a.rects.sprint!.fold).toBeUndefined();
  });

  it('never grows a rail: a screen of rails is rails, left to right, with the rest of the width empty', () => {
    const a = arrange(DEFAULT_LAYOUT[0], fold('sprint', 'elfoqsy', 'conversation'));
    expect(Object.values(a.rects).map((r) => r!.w)).toEqual([RAIL_WIDTH, RAIL_WIDTH, RAIL_WIDTH]);
    expect(a.rects.sprint!.x).toBe(40);
    expect(a.rects.elfoqsy!.x).toBe(40 + RAIL_WIDTH + GAP);
    expect(a.ok).toBe(true);
  });

  it('makes a folded pane in a stack a bar, and gives its height to the open ones', () => {
    const a = arrange([['sprint', 'conversation']], fold('conversation'));
    expect(a.rects.conversation).toMatchObject({ h: BAR_HEIGHT, fold: 'bar' });
    expect(a.rects.sprint).toMatchObject({ y: 80, h: 972 - BAR_HEIGHT - GAP });
    expect(a.rects.conversation!.y).toBe(80 + a.rects.sprint!.h + GAP);
    expect(a.rects.conversation!.y + a.rects.conversation!.h).toBe(AREA.y + AREA.h);
    // The column keeps its width: a bar is as wide as the column.
    expect(a.rects.conversation!.w).toBe(a.rects.sprint!.w);
  });

  it('shows a crowded stack with a bar, but a layout is only ever saved if it fits with everything open', () => {
    const four: Layout = [[['sprint', 'elfoqsy', 'conversation', 'map']], [['terminals']]];
    expect(fits(four)).toBe(false); // so it is never saved, and a folded pane can always be opened again
    expect(arrange(four[0], fold('map')).ok).toBe(true); // drawn with a bar it would have room
  });

  it('keeps a stack of folded panes as wide as it would be open at its narrowest, as bars, without growing', () => {
    const a = arrange([['sprint', 'conversation'], ['terminals']], fold('sprint', 'conversation'));
    expect(a.rects.sprint).toMatchObject({ w: 380, h: BAR_HEIGHT, fold: 'bar' });
    expect(a.rects.conversation).toMatchObject({ w: 380, fold: 'bar' });
    expect(a.rects.terminals!.x).toBe(40 + 380 + GAP);
  });

  it('is exactly what it was with nothing folded', () => {
    expect(arrange(DEFAULT_LAYOUT[0], fold())).toEqual(arrange(DEFAULT_LAYOUT[0]));
    // A fold on the other screen changes nothing here.
    expect(arrange(DEFAULT_LAYOUT[0], fold('map'))).toEqual(arrange(DEFAULT_LAYOUT[0]));
  });
});

describe('panes taken off the screens, and put back beside another', () => {
  it('has a pane on neither screen when it is removed, closes its place up, and lists it', () => {
    const left = without(DEFAULT_LAYOUT, 'conversation');
    expect(screenOf(left, 'conversation')).toBeNull();
    expect(removedPanes(left)).toEqual(['conversation']);
    expect(removedPanes(DEFAULT_LAYOUT)).toEqual([]);
    expect(arrange(left[0]).rects.elfoqsy!.w + arrange(left[0]).rects.sprint!.w + GAP).toBe(AREA.w);
    expect(savedLayout(left)).toBe(left); // not today's arrangement: kept
    expect(fits(left)).toBe(true);
    expect(removedPanes([[], []])).toEqual(['sprint', 'elfoqsy', 'conversation', 'map', 'terminals']);
  });

  it('places a pane beside another as a drop there would: left and right as a column, above and below in its column', () => {
    const removed = without(DEFAULT_LAYOUT, 'map');
    expect(placeBeside(removed, 'sprint', 'left', 'map')![0]).toEqual([['map'], ['sprint'], ['elfoqsy'], ['conversation']]);
    expect(placeBeside(removed, 'sprint', 'right', 'map')![0]).toEqual([['sprint'], ['map'], ['elfoqsy'], ['conversation']]);
    expect(placeBeside(removed, 'elfoqsy', 'above', 'map')![0]).toEqual([['sprint'], ['map', 'elfoqsy'], ['conversation']]);
    expect(placeBeside(removed, 'elfoqsy', 'below', 'map')![0]).toEqual([['sprint'], ['elfoqsy', 'map'], ['conversation']]);
    // A pane on the other screen comes from there.
    const from = placeBeside(DEFAULT_LAYOUT, 'sprint', 'above', 'map')!;
    expect(from[0]).toEqual([['map', 'sprint'], ['elfoqsy'], ['conversation']]);
    expect(from[1]).toEqual([['terminals']]);
    expect(placeBeside(without(DEFAULT_LAYOUT, 'sprint'), 'sprint', 'left', 'map')).toBeNull(); // the other pane is not on a screen
  });

  it('says no room where the result does not fit: a fourth in a column, or too many for the width', () => {
    const three: Layout = [[['sprint', 'elfoqsy', 'conversation']], [['terminals']]];
    expect(fits(placeBeside(three, 'sprint', 'above', 'map')!)).toBe(false);
    expect(fits(placeBeside(three, 'sprint', 'right', 'map')!)).toBe(true);
  });

  it('adds a removed pane to a screen as a column of its own at the end, or at the foot of a column when the width is gone', () => {
    const removed = without(DEFAULT_LAYOUT, 'terminals');
    expect(addToScreen(removed, 'terminals', 1)![1]).toEqual([['map'], ['terminals']]);
    expect(addToScreen(removed, 'terminals', 0)![0]).toEqual([['sprint'], ['elfoqsy'], ['conversation'], ['terminals']]);
    expect(moveToOtherScreen(DEFAULT_LAYOUT, 'sprint')![1]).toEqual([['map'], ['terminals'], ['sprint']]);
  });
});

describe('what is saved', () => {
  it('is no layout for today’s arrangement, and the layout itself for any other', () => {
    expect(savedLayout(DEFAULT_LAYOUT)).toBeNull();
    expect(savedLayout(structuredClone(DEFAULT_LAYOUT))).toBeNull();
    expect(savedLayout(null)).toBeNull();
    const own: Layout = [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]];
    expect(savedLayout(own)).toBe(own);
    // The same panes in another order or stacking is another arrangement, so it is kept.
    expect(savedLayout([[['sprint'], ['conversation'], ['elfoqsy']], [['map'], ['terminals']]])).not.toBeNull();
    expect(savedLayout([[['sprint'], ['elfoqsy'], ['conversation']], [['map', 'terminals']]])).not.toBeNull();
  });
});

describe('the fold', () => {
  const e = (seq: number, layout: Layout | null): AnyEnvelope => ({ seq, id: `e${seq}`, ts: '2026-10-18T10:00:00.000Z', type: 'layout.changed', source: 'orchestrator', payload: { layout, by: 'you' } }) as AnyEnvelope;

  it('starts with no layout saved, keeps the latest, and goes back to none on null', () => {
    expect(foldAll([]).layout).toBeNull();
    const custom: Layout = [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]];
    expect(foldAll([e(1, custom)]).layout).toEqual(custom);
    expect(foldAll([e(1, custom), e(2, DEFAULT_LAYOUT)]).layout).toEqual(DEFAULT_LAYOUT);
    expect(foldAll([e(1, custom), e(2, null)]).layout).toBeNull();
  });
});
