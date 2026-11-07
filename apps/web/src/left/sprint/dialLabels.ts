// Where the dial's labels go: each dot's digits beside it, on no other dot and no other label, inside the
// dial and off its centre dot and buttons. Dots differ in size (story points), so a label tries twelve directions
// around its own dot at four distances and takes the first that is clear; the open ticket goes first, then larger dots.
// The grown dial (B+) scales all of it together, so this is done once, in the dial's own pixels.
import type { Rect } from '../../ui/place';
import { MAP, type OrbitLayout } from './layout';

/** The map at 42%, as the ticket view's dial; its dots at 55.5% of the map's circles, so they stay clickable. */
export const DIAL_SCALE = 0.42;
export const DIAL_DOT = 0.555;
/** The dial is cropped to the outer ring, centred. */
export const DIAL_SIZE = { w: 320, h: 252 } as const;
/** The expand and search buttons in its top right corner (TicketView), and the centre dot: labels keep off them. */
export const DIAL_KEEP_OFF: Rect[] = [
  { x: DIAL_SIZE.w - 40, y: 0, w: 40, h: 84 },
  { x: DIAL_SIZE.w / 2 - 6, y: DIAL_SIZE.h / 2 - 6, w: 12, h: 12 },
];
const DX = DIAL_SIZE.w / 2 - MAP.cx * DIAL_SCALE;
const DY = DIAL_SIZE.h / 2 - MAP.cy * DIAL_SCALE;
/** A point of the map in the dial's pixels. */
export const toDial = (x: number, y: number): { x: number; y: number } => ({ x: DX + x * DIAL_SCALE, y: DY + y * DIAL_SCALE });

/** The dial's dots from the map's layout: every ticket, and the +N node (unlabelled). */
export function dialDots(layout: Pick<OrbitLayout, 'tickets' | 'cluster'>): DialDot[] {
  return [
    ...layout.tickets.map((p) => ({ key: p.key, ...toDial(p.x, p.y), d: Math.round(p.d * DIAL_DOT) })),
    ...(layout.cluster ? [{ key: '+N', ...toDial(layout.cluster.x, layout.cluster.y), d: Math.round(layout.cluster.d * DIAL_DOT), unlabelled: true }] : []),
  ];
}

/** The labels of a dial's dots, the open ticket's first. */
export const dialLabels = (dots: DialDot[], selected: string): Map<string, DialLabel> => placeDialLabels(dots, { bounds: { x: 0, y: 0, ...DIAL_SIZE }, keepOff: DIAL_KEEP_OFF, first: selected });

export interface DialDot {
  key: string;
  x: number;
  y: number;
  d: number;
  /** The +N node: in the way, but has no label. */
  unlabelled?: boolean;
}
export interface DialLabel extends Rect {
  key: string;
  text: string;
  /** Clear of every dot, label and keep-off area. */
  clear: boolean;
  /** A thin line from the dot's edge to its label, when the label had to go farther than DIAL_LABEL.leaderFrom. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

/** JetBrains Mono at 13px: 0.6em a figure, 3px padding each side. */
export const DIAL_LABEL = { charWidth: 7.8, padding: 6, height: 18, gaps: [3, 9, 16, 24, 34, 46, 60], leaderFrom: 12 } as const;
/** Directions to try, nearest to reading order first: right, left, then up and down and round the dot. */
const ANGLES = [0, 180, -30, 30, 150, -150, -60, 60, 120, -120, -90, 90];

export const labelText = (key: string): string => key.split('-')[1] ?? key;

const circleHits = (r: Rect, c: DialDot): boolean => {
  const cx = Math.max(r.x - c.x, 0, c.x - (r.x + r.w));
  const cy = Math.max(r.y - c.y, 0, c.y - (r.y + r.h));
  return cx * cx + cy * cy < (c.d / 2 + 1) ** 2;
};
const rectHits = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * Candidate boxes around a dot, nearest first: at each distance, each direction, the box just beyond the dot's edge.
 * A box past the dial's edge slides back inside (a dot on the top or bottom of the outer ring); one that then covers
 * its own dot is dropped by the caller.
 */
function candidates(c: DialDot, w: number, h: number, bounds: Rect): Rect[] {
  const r = c.d / 2;
  return DIAL_LABEL.gaps.flatMap((g) =>
    ANGLES.map((deg) => {
      const a = (deg * Math.PI) / 180;
      const px = c.x + Math.cos(a) * (r + g);
      const py = c.y + Math.sin(a) * (r + g);
      const x = px - w / 2 + (Math.cos(a) * w) / 2;
      const y = py - h / 2 + (Math.sin(a) * h) / 2;
      return { x: clamp(x, bounds.x, bounds.x + bounds.w - w), y: clamp(y, bounds.y, bounds.y + bounds.h - h), w, h };
    }),
  );
}

/** The leader from a dot to a label placed far from it, if it is. */
function leaderTo(dot: DialDot, r: Rect): Pick<DialLabel, 'leader'> {
  const nx = clamp(dot.x, r.x, r.x + r.w);
  const ny = clamp(dot.y, r.y, r.y + r.h);
  const dist = Math.hypot(nx - dot.x, ny - dot.y);
  if (dist - dot.d / 2 <= DIAL_LABEL.leaderFrom) return {};
  const k = dot.d / 2 / dist;
  return { leader: { x1: dot.x + (nx - dot.x) * k, y1: dot.y + (ny - dot.y) * k, x2: nx, y2: ny } };
}

export function placeDialLabels(dots: DialDot[], o: { bounds: Rect; keepOff?: Rect[]; first?: string }): Map<string, DialLabel> {
  const placed = new Map<string, DialLabel>();
  const order = dots.filter((d) => !d.unlabelled).sort((a, b) => Number(b.key === o.first) - Number(a.key === o.first) || b.d - a.d || a.key.localeCompare(b.key));
  const inBounds = (r: Rect) => r.x >= o.bounds.x && r.y >= o.bounds.y && r.x + r.w <= o.bounds.x + o.bounds.w && r.y + r.h <= o.bounds.y + o.bounds.h;
  /** What a box would cover besides labels: dots (its own too), keep-off areas, the dial's edge. */
  const fixedHits = (r: Rect): number => dots.filter((c) => circleHits(r, c)).length + (o.keepOff ?? []).filter((k) => rectHits(r, k)).length + (inBounds(r) ? 0 : 1);
  const labelHits = (r: Rect, except: string): DialLabel[] => [...placed.values()].filter((l) => l.key !== except && rectHits(r, l));
  const options = new Map(order.map((dot) => [dot.key, candidates(dot, labelText(dot.key).length * DIAL_LABEL.charWidth + DIAL_LABEL.padding, DIAL_LABEL.height, o.bounds)]));
  const dotOf = new Map(order.map((d) => [d.key, d]));
  const put = (key: string, r: Rect, clear: boolean) => placed.set(key, { x: r.x, y: r.y, w: r.w, h: r.h, key, text: labelText(key), clear, ...leaderTo(dotOf.get(key)!, r) });

  for (const dot of order) {
    const mine = options.get(dot.key)!;
    const hits = (r: Rect): number => fixedHits(r) + labelHits(r, dot.key).length;
    const clear = mine.find((r) => hits(r) === 0);
    put(dot.key, clear ?? mine.reduce((a, b) => (hits(b) < hits(a) ? b : a)), !!clear);
  }
  // Repair: a label with no clear place may take one that only other labels hold, if each of those moves to another
  // clear place of its own.
  for (const stuck of [...placed.values()].filter((l) => !l.clear)) {
    for (const r of options.get(stuck.key)!) {
      if (fixedHits(r)) continue;
      const blockers = labelHits(r, stuck.key);
      const moves = new Map<string, Rect>();
      const ok = blockers.every((b) => {
        const to = options.get(b.key)!.find((c) => !fixedHits(c) && !rectHits(c, r) && labelHits(c, b.key).every((l) => blockers.includes(l)) && [...moves.values()].every((m) => !rectHits(c, m)));
        if (to) moves.set(b.key, to);
        return !!to;
      });
      if (!ok) continue;
      for (const [key, to] of moves) put(key, to, true);
      put(stuck.key, r, true);
      break;
    }
  }
  // What is clear is checked once more, on the final places.
  for (const l of [...placed.values()]) put(l.key, l, !fixedHits(l) && !labelHits(l, l.key).length);
  return placed;
}
