// What the pointer is near (P2, C): the + at the nearest edge and the x beside today's hide button. Pure, over boxes in stage pixels.
import { describe, expect, it } from 'vitest';
import { PANE_IDS, arrange, type ScreenLayout } from '@elfoqsy/state';
import { gripPane, plusNear, xBeside } from '../src/panes/hover';

const screen: ScreenLayout = [['sprint'], ['conversation'], ['elfoqsy']];
const rects = arrange(screen).rects;

describe('the + near a pane’s edge', () => {
  const sprint = rects.sprint!;
  const ids = PANE_IDS.filter((id) => rects[id]);
  const cy = sprint.y + sprint.h / 2;

  it('is in the gap at the middle of the edge the pointer is nearest, within 48 px inside and 30 px outside', () => {
    expect(plusNear(rects, { x: sprint.x + 10, y: cy }, ids)).toEqual({ pane: 'sprint', side: 'left', x: sprint.x - 23, y: Math.round(cy - 13) });
    expect(plusNear(rects, { x: sprint.x + sprint.w - 10, y: cy }, ids)?.side).toBe('right');
    expect(plusNear(rects, { x: sprint.x + sprint.w / 2 + 100, y: sprint.y + 10 }, ids)).toMatchObject({ pane: 'sprint', side: 'above', y: sprint.y - 25 });
    expect(plusNear(rects, { x: sprint.x + sprint.w / 2 - 100, y: sprint.y + sprint.h - 10 }, ids)).toMatchObject({ pane: 'sprint', side: 'below', y: sprint.y + sprint.h - 3 });
    expect(plusNear(rects, { x: sprint.x + sprint.w / 2, y: cy }, ids)).toBeNull(); // the middle of a wide pane is near no edge
    expect(plusNear(rects, { x: sprint.x - 31, y: cy }, ids)).toBeNull(); // 30 px outside is as far as it goes
  });

  it('is at the right of the grip along the top edge, never on it', () => {
    const at = plusNear(rects, { x: sprint.x + sprint.w / 2, y: sprint.y + 4 }, ids)!;
    expect(at.x).toBe(Math.round(sprint.x + sprint.w / 2 + 38));
    expect(at.x).toBeGreaterThanOrEqual(sprint.x + sprint.w / 2 + 26 + 8); // the grip is 52 wide, centred
  });

  it('is not offered beside a folded pane, a rail or a bar, which has no edge to add beside', () => {
    const folded = { ...rects, sprint: { ...sprint, fold: 'rail' as const } };
    expect(plusNear(folded, { x: sprint.x + 10, y: cy }, ids)).toBeNull();
  });

  it('reads today’s columns and a free layout the same way: only the boxes differ', () => {
    const boxes = { sprint: { x: 40, y: 40, w: 840, h: 1000 }, elfoqsy: { x: 944, y: 40, w: 288, h: 1000 } };
    expect(plusNear(boxes, { x: 870, y: 500 }, ['sprint', 'elfoqsy'])).toEqual({ pane: 'sprint', side: 'right', x: 877, y: 527 });
  });
});

describe('the pane that gets the grip in a free layout', () => {
  it('is the one under the pointer, from 12 px above its top edge', () => {
    const r = rects.conversation!;
    expect(gripPane(rects, { x: r.x + 5, y: r.y + 5 }, PANE_IDS)).toBe('conversation');
    expect(gripPane(rects, { x: r.x + 5, y: r.y - 12 }, PANE_IDS)).toBe('conversation');
    expect(gripPane(rects, { x: r.x + 5, y: r.y - 13 }, PANE_IDS)).toBeNull();
  });
});

describe('the x beside today’s hide button', () => {
  const hide = { x: 846, y: 52, w: 36, h: 36 };
  it('is the same size at the same height, 8 px from the button: left of it, and right of Elfoqsy’s, whose header has other controls on the left', () => {
    expect(xBeside(hide, 'sprint')).toEqual({ x: 802, y: 52, w: 36, h: 36 });
    expect(xBeside(hide, 'terminals')).toEqual({ x: 802, y: 52, w: 36, h: 36 });
    expect(xBeside(hide, 'elfoqsy')).toEqual({ x: 890, y: 52, w: 36, h: 36 });
  });
});
