// What the pointer is near on a screen (P2, C): the pane under it gets the grip, straddling its top edge (52 × 24); the edge of
// a pane nearest it, within 48 px, gets a single + (26 px) in the gap at the edge's middle. A pane's edge is near from 30 px
// outside it to 48 px inside. Pure, over the panes' boxes in stage pixels, so a free layout (the engine's rectangles) and
// today's columns (the boxes the page has, no layout saved) are read the same way.
import type { PaneId, PlacedRect, Side } from '@elfoqsy/state';
import type { Rect } from '../ui/place';
import type { PlusAt } from './AddPlus';

export const GRIP = { w: 52, h: 24 } as const;
export const PLUS = 26;
const REACH = 30;
const NEAR = 48;
/** The gap between today's hide button and the x drawn beside it (var(--space-2)). */
const X_GAP = 8;

export type Boxes = Partial<Record<PaneId, PlacedRect>>;

/** The one + the pointer is near, if any: at the edge of an open pane nearest it, in the gap at the middle of the edge. */
export function plusNear(boxes: Boxes, pt: { x: number; y: number }, ids: readonly PaneId[]): PlusAt | null {
  let near: { pane: PaneId; side: Side; dist: number } | null = null;
  for (const id of ids) {
    const r = boxes[id];
    // Folded panes (rails and bars) have no edge to add beside.
    if (!r || r.fold || pt.x < r.x - REACH || pt.x > r.x + r.w + REACH || pt.y < r.y - REACH || pt.y > r.y + r.h + REACH) continue;
    const edges: Array<[Side, number]> = [['left', Math.abs(pt.x - r.x)], ['right', Math.abs(pt.x - (r.x + r.w))], ['above', Math.abs(pt.y - r.y)], ['below', Math.abs(pt.y - (r.y + r.h))]];
    for (const [side, dist] of edges) if (dist <= NEAR && (!near || dist < near.dist)) near = { pane: id, side, dist };
  }
  if (!near) return null;
  const R = boxes[near.pane]!;
  const cx = R.x + R.w / 2;
  const cy = R.y + R.h / 2;
  // In the gap at the middle of the edge; at the top, right of the grip so the two never overlap.
  const place = { left: [R.x - 23, cy - PLUS / 2], right: [R.x + R.w - 3, cy - PLUS / 2], above: [cx + 38, R.y - 25], below: [cx - PLUS / 2, R.y + R.h - 3] }[near.side];
  return { pane: near.pane, side: near.side, x: Math.round(place[0]!), y: Math.round(place[1]!) };
}

/** The pane under the pointer in a free layout, which gets the grip: its box, from 12 px above its top edge. */
export function gripPane(boxes: Boxes, pt: { x: number; y: number }, ids: readonly PaneId[]): PaneId | null {
  let found: PaneId | null = null;
  for (const id of ids) {
    const r = boxes[id];
    if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y - GRIP.h / 2 && pt.y <= r.y + r.h) found = id;
  }
  return found;
}

/**
 * Where today's x goes: beside the pane's hide button, the same size, 8 px from it. In a free layout the x sits in the pane's
 * header, right of the button, and the header makes room for it; today's headers have none to spare, so the x is drawn over
 * them, on the side the header leaves free: left of the button, except Elfoqsy's, which has her other controls there.
 */
export function xBeside(hide: Rect, pane: PaneId): { x: number; y: number; w: number; h: number } {
  const x = pane === 'elfoqsy' ? hide.x + hide.w + X_GAP : hide.x - X_GAP - hide.w;
  return { x: Math.round(x), y: Math.round(hide.y), w: Math.round(hide.w), h: Math.round(hide.h) };
}
