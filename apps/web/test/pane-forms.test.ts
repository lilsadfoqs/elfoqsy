// The panes' sizes and forms (P1): each pane's form comes from its own slot, at the thresholds docs/layout.md gives.
import { describe, expect, it } from 'vitest';
import { MIN_HEIGHT, PANES, PANE_IDS, THRESHOLDS, compactScale, mapForm, sprintForm, terminalsForm } from '../src/panes/spec';
import { layoutMap, mapScale } from '../src/right/map/layout';
import { initialState } from '@elfoqsy/state';

describe('the five panes and their sizes (docs/layout.md)', () => {
  it('has the preferred and minimum widths, and a minimum height of 240 for stacking', () => {
    expect(PANE_IDS).toEqual(['sprint', 'elfoqsy', 'conversation', 'map', 'terminals']);
    expect(Object.fromEntries(PANE_IDS.map((p) => [p, [PANES[p].pref, PANES[p].min]]))).toEqual({
      sprint: [840, 240],
      elfoqsy: [342, 330],
      conversation: [618, 380],
      map: [640, 300],
      terminals: [1180, 300],
    });
    expect(MIN_HEIGHT).toBe(240);
  });

  it('gives spare width to Conversation and Terminals first, then Sprint and Agent map; Elfoqsy grows only when alone', () => {
    expect(PANES.conversation.flex).toBe(1);
    expect(PANES.terminals.flex).toBe(1);
    expect(PANES.sprint.flex).toBeLessThan(PANES.conversation.flex);
    expect(PANES.map.flex).toBeLessThan(PANES.terminals.flex);
    expect(PANES.sprint.flex).toBeGreaterThan(PANES.elfoqsy.flex);
    expect(PANES.elfoqsy.flex).toBe(0);
  });
});

describe('Sprint: full from 760 wide and 700 tall; short under 560 tall; compact from 480; list from 240; rail under 240', () => {
  it.each([
    [840, 972, 'full'],
    [760, 700, 'full'],
    [759, 700, 'compact'],
    [760, 699, 'compact'],
    [480, 700, 'compact'],
    [480, 560, 'compact'],
    [480, 559, 'short'],
    [1000, 559, 'short'],
    [479, 972, 'list'],
    [240, 972, 'list'],
    [240, 100, 'list'],
    [239, 972, 'rail'],
    [56, 972, 'rail'],
  ])('%i x %i is %s', (w, h, form) => {
    expect(sprintForm(w, h)).toBe(form);
  });
});

describe('Terminals: four from 1000 wide and 700 tall; two from 500 (one if under 560 tall); one with tabs from 380; tabs only under', () => {
  it.each([
    [1180, 972, 'four'],
    [1000, 700, 'four'],
    [999, 972, 'two'],
    [1000, 699, 'two'],
    [500, 560, 'two'],
    [500, 559, 'one'],
    [1000, 559, 'one'],
    [499, 972, 'one'],
    [380, 972, 'one'],
    [379, 972, 'tabs'],
    [300, 240, 'tabs'],
  ])('%i x %i is %s', (w, h, form) => {
    expect(terminalsForm(w, h)).toBe(form);
  });
});

describe('Agent map: full, compact under 500 wide or 600 tall', () => {
  it.each([
    [640, 972, 'full'],
    [500, 600, 'full'],
    [499, 600, 'compact'],
    [500, 599, 'compact'],
    [300, 300, 'compact'],
  ])('%i x %i is %s', (w, h, form) => {
    expect(mapForm(w, h)).toBe(form);
  });

  it('keeps its geometry as drawn wherever it is full, and scales it down (never under 0.4) in a smaller box, never its text', () => {
    // From the smallest full slot up: scale 1, exactly as today's column draws it.
    for (const [w, h] of [[500, 600], [640, 972], [786, 1000], [1800, 1000]] as const) expect(mapScale(w, h)).toBe(1);
    expect(mapScale(400, 500)).toBeLessThan(1);
    expect(mapScale(300, 300)).toBeGreaterThanOrEqual(0.4);
    expect(mapScale(100, 100)).toBe(0.4);
    expect(layoutMap(initialState, 300, 300).k).toBe(mapScale(300, 300));
    // The agents stay inside the box at the smallest scale.
    const l = layoutMap(initialState, 300, 240);
    expect(l.RT).toBeLessThan(150);
    expect(l.R).toBeLessThan(l.RT);
  });
});

describe('the sprint map fitted to a small slot', () => {
  it('shrinks to the slot, whichever side is the tighter, and never to nothing', () => {
    expect(compactScale(760, 600)).toBe(1);
    expect(compactScale(380, 600)).toBe(0.5);
    expect(compactScale(760, 300)).toBe(0.5);
    expect(compactScale(100, 100)).toBe(0.2);
  });

  it('has thresholds the lab and the tests share', () => {
    expect(THRESHOLDS.sprint).toEqual({ rail: 240, list: 480, wide: 760, tall: 700, short: 560 });
    expect(THRESHOLDS.terminals).toEqual({ tabs: 380, two: 500, four: 1000, tall: 700, short: 560 });
    expect(THRESHOLDS.map).toEqual({ wide: 500, tall: 600 });
  });
});
