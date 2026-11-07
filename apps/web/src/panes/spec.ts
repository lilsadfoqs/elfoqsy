// The five panes and the sizes docs/layout.md gives them (P1): each has a preferred and a minimum width, every one a minimum
// height of 240 px for stacking, and a form picked from its own slot, never from the screen. Pure, so both the screens and
// the tests read the same numbers.

import { MIN_HEIGHT, PANES, PANE_IDS, type PaneId, type PaneSpec } from '@elfoqsy/state';

// The numbers live in @elfoqsy/state (layout.ts): the daemon checks an arrangement against the same ones.
export { MIN_HEIGHT, PANES, PANE_IDS };
export type { PaneId, PaneSpec };

export type SprintForm = 'full' | 'short' | 'compact' | 'list' | 'rail';
export type TerminalsForm = 'four' | 'two' | 'one' | 'tabs';
export type MapForm = 'full' | 'compact';
export type Form = SprintForm | TerminalsForm | MapForm | 'one-form';

/**
 * A pane's form from its slot. Sprint: full from 760 wide and 700 tall; short under 560 tall; compact from 480; list from
 * 240; rail under 240. Terminals: four from 1000 wide and 700 tall; two from 500 (one if under 560 tall); one with tabs
 * from 380; tabs only under 380. Agent map: full, compact under 500 wide or 600 tall. Elfoqsy and Conversation: one form.
 */
export function sprintForm(w: number, h: number): SprintForm {
  if (w < 240) return 'rail';
  if (w < 480) return 'list';
  if (h < 560) return 'short';
  return w < 760 || h < 700 ? 'compact' : 'full';
}
export function terminalsForm(w: number, h: number): TerminalsForm {
  if (w < 380) return 'tabs';
  if (w < 500) return 'one';
  if (w < 1000 || h < 700) return h < 560 ? 'one' : 'two';
  return 'four';
}
export const mapForm = (w: number, h: number): MapForm => (w < 500 || h < 600 ? 'compact' : 'full');

/** The widths and heights where each form begins, for the tests and the size lab. */
export const THRESHOLDS = {
  sprint: { rail: 240, list: 480, wide: 760, tall: 700, short: 560 },
  terminals: { tabs: 380, two: 500, four: 1000, tall: 700, short: 560 },
  map: { wide: 500, tall: 600 },
} as const;

/** The sprint map's own space, 760 × 600 (left/sprint/layout.ts); the fitted form scales it to a slot's box, never under 0.2. */
export const SPRINT_MAP = { width: 760, height: 600 } as const;
export const compactScale = (w: number, h: number): number => Math.max(0.2, Math.min(w / SPRINT_MAP.width, h / SPRINT_MAP.height));

/** The name of a pane's form in a slot of this size, for the lab's readout and the tests. */
export function formName(pane: PaneId, w: number, h: number): string {
  switch (pane) {
    case 'sprint':
      return sprintForm(w, h);
    case 'terminals':
      return terminalsForm(w, h);
    case 'map':
      return mapForm(w, h);
    default:
      return 'one form';
  }
}
