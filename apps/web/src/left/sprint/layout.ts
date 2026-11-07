// Geometry of the sprint orbit map, in its own 760×600 coordinate space (scaled by 1.35 on screen).
// Pure and deterministic: the same tickets always land in the same places. Each ticket sits on its
// priority ring at an angle hashed from its key; tickets linked across boards form a group that is
// hashed and moved as one, so they sit at nearly the same angle. Then neighbours are nudged along
// their rings until no circle, PR orbit or label overlaps another or a fixed label, and no dashed
// link passes behind another ticket.
//
// It survives crowding like the live map: past MAX_TICKETS open tickets (or when a ring is full) the
// least important group into one +N node on the outer ring, blocked tickets always keeping their own
// place; and labels are placed by importance, right of the circle, else left, else hidden until hover.
import type { Priority, PullRequest, Ticket } from '@elfoqsy/contracts';

export const MAP = { width: 760, height: 600, scale: 1.35, cx: 380, cy: 300 } as const;
export const RINGS = { Critical: 120, Major: 210, Minor: 290 } as const;
export const RING_FOR: Record<Priority, number> = { Blocker: 120, Critical: 120, Major: 210, Minor: 290 };

export const LABEL = { gap: 12, height: 26, charWidth: 10.4, padding: 12 } as const;
export const YOU_DOT = 18;
export const MOON = { orbit: 34, size: 20 } as const;
export const RING_LABEL_OFFSET = 8;

export const ticketDiameter = (points: number | null): number => 24 + 6 * (points ?? 0);

/** At most this many tickets keep their own circle; past it, the rest group into one +N node. */
export const MAX_TICKETS = 12;
export const CLUSTER = { key: '+N', d: 44, radius: RINGS.Minor } as const;
/** Share of a ring's length the circles on it may take; past it, the least important group. */
const RING_FILL = 0.8;
/** The arc a ring's own name blocks where it crosses the ring (its height and a margin each side): no circle sits there. */
const RING_LABEL_ARC = LABEL.height + 2 * 6;
const PRIORITY_RANK: Record<Priority, number> = { Blocker: 0, Critical: 1, Major: 2, Minor: 3 };

/** What an agent on a ticket is doing, as far as the map cares: waiting for alex, or at work. */
export type AgentMark = 'waiting' | 'working';

/**
 * Most important first: blocked, then an agent waiting for alex, then any agent, then priority,
 * then the sprints it has slipped, then points.
 */
export function byImportance(agents: Record<string, AgentMark>) {
  const rank = (t: Ticket) => [
    t.status === 'Blocked' ? 0 : 1,
    agents[t.key] === 'waiting' ? 0 : agents[t.key] ? 1 : 2,
    PRIORITY_RANK[t.priority],
    -t.sprintsCarried,
    -(t.storyPoints ?? 0),
  ];
  return (a: Ticket, b: Ticket): number => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return a.key.localeCompare(b.key);
  };
}
export const labelWidth = (key: string): number => key.length * LABEL.charWidth + LABEL.padding;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedTicket {
  key: string;
  x: number;
  y: number;
  d: number;
  angle: number;
  radius: number;
  moons: Array<{ pr: PullRequest; x: number; y: number }>;
  /** Where its key is written: right of the circle, left of it, or only on hover when there is no room. */
  label: 'right' | 'left' | 'hidden';
}

/** The tickets without a circle of their own, as one node on the outer ring, most important first. */
export interface TicketCluster {
  x: number;
  y: number;
  d: number;
  keys: string[];
}

export interface CornerDot {
  ticket: Ticket;
  x: number;
  y: number;
  d: number;
}

export interface OrbitLayout {
  tickets: PlacedTicket[];
  cluster: TicketCluster | null;
  links: Array<[string, string]>;
  done: CornerDot[];
  cancelled: CornerDot[];
}

/** FNV-1a, 32 bit. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((a % TAU) + TAU) % TAU;
const signedDiff = (a: number, b: number): number => {
  const d = wrap(a - b);
  return d > Math.PI ? d - TAU : d;
};

const overlaps = (a: Box, b: Box, margin: number): boolean =>
  a.x0 < b.x1 + margin && b.x0 < a.x1 + margin && a.y0 < b.y1 + margin && b.y0 < a.y1 + margin;

/** The box of a ticket's circle, or of its PR orbit when it has open PRs. */
export function circleBox(t: { x: number; y: number; d: number; hasMoons: boolean }): Box {
  const r = t.hasMoons ? MOON.orbit + MOON.size / 2 : t.d / 2;
  return { x0: t.x - r, y0: t.y - r, x1: t.x + r, y1: t.y + r };
}

/** The box of a ticket's key, right or left of its circle. */
export function labelBox(t: { key: string; x: number; y: number; d: number }, side: 'right' | 'left'): Box {
  const w = labelWidth(t.key);
  const x0 = side === 'right' ? t.x + t.d / 2 + LABEL.gap : t.x - t.d / 2 - LABEL.gap - w;
  return { x0, y0: t.y - LABEL.height / 2, x1: x0 + w, y1: t.y + LABEL.height / 2 };
}

/** Boxes a ticket occupies: its circle (or its PR orbit) and its label where it is written. */
export function ticketBoxes(t: { key: string; x: number; y: number; d: number; hasMoons: boolean; label?: PlacedTicket['label'] }): Box[] {
  const side = t.label ?? 'right';
  return side === 'hidden' ? [circleBox(t)] : [circleBox(t), labelBox(t, side)];
}

/** Things drawn at fixed places that tickets must stay clear of: ring names, "you", the two corners. */
export function fixedBoxes(): Box[] {
  const ringLabels = Object.entries(RINGS).map(([name, r]) => {
    const x0 = MAP.cx + r + RING_LABEL_OFFSET - 2;
    return { x0, y0: MAP.cy - 13, x1: x0 + name.length * 8 + 12, y1: MAP.cy + 13 };
  });
  return [
    ...ringLabels,
    { x0: MAP.cx - 44, y0: MAP.cy - 14, x1: MAP.cx + YOU_DOT / 2 + 2, y1: MAP.cy + 14 }, // "you" and its dot
    { x0: 0, y0: 0, x1: 110, y1: 110 }, // cancelled corner
    { x0: 0, y0: 450, x1: 130, y1: MAP.height }, // done corner
  ];
}

export function moonPositions(x: number, y: number, prs: PullRequest[]): PlacedTicket['moons'] {
  return prs.map((pr, i) => {
    const a = ((-60 + (i * 360) / prs.length) * Math.PI) / 180;
    return { pr, x: x + MOON.orbit * Math.cos(a), y: y + MOON.orbit * Math.sin(a) };
  });
}

/** Linked tickets on different boards, both on the map: once per pair, and the groups they form. */
export function linkGroups(open: Ticket[]): { links: Array<[string, string]>; groups: string[][] } {
  const byKey = new Map(open.map((t) => [t.key, t]));
  const links: Array<[string, string]> = [];
  for (const t of open) {
    for (const other of t.linked) {
      const o = byKey.get(other);
      if (!o || o.board === t.board) continue;
      const pair = [t.key, o.key].sort() as [string, string];
      if (!links.some(([a, b]) => a === pair[0] && b === pair[1])) links.push(pair);
    }
  }
  links.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  // Connected components over those links; every other ticket is a group of one.
  const parent = new Map(open.map((t) => [t.key, t.key]));
  const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
  for (const [a, b] of links) parent.set(find(a), find(b));
  const groups = new Map<string, string[]>();
  for (const t of open) groups.set(find(t.key), [...(groups.get(find(t.key)) ?? []), t.key]);
  return {
    links,
    groups: [...groups.values()].map((g) => g.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!)),
  };
}

/** Does the segment from (x1, y1) to (x2, y2) cross the box? Liang–Barsky clipping. */
export function segmentCrossesBox(x1: number, y1: number, x2: number, y2: number, b: Box, margin = 0): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const edges: Array<[number, number]> = [
    [-dx, x1 - (b.x0 - margin)],
    [dx, b.x1 + margin - x1],
    [-dy, y1 - (b.y0 - margin)],
    [dy, b.y1 + margin - y1],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

interface Member {
  key: string;
  radius: number;
  d: number;
  hasMoons: boolean;
  /** The +N node has no label beside it. */
  labelled: boolean;
  /** Angle relative to its group; grows only as far as needed to keep members apart. */
  offset: number;
  unit: Unit;
}

interface Unit {
  base: number;
  members: Member[];
}

/**
 * Which tickets keep their own circle: all of them up to MAX_TICKETS, as long as their ring has room;
 * past that the most important ones, blocked tickets always. The rest go into the +N node.
 */
export function chooseDrawn(open: Ticket[], hasMoons: (key: string) => boolean, agents: Record<string, AgentMark> = {}): { drawn: Ticket[]; grouped: Ticket[] } {
  const ranked = [...open].sort(byImportance(agents));
  const limit = open.length > MAX_TICKETS ? MAX_TICKETS - 1 : MAX_TICKETS;
  const used = new Map<number, number>();
  const footprint = (t: Ticket) => (hasMoons(t.key) ? 2 * (MOON.orbit + MOON.size / 2) : ticketDiameter(t.storyPoints)) + 12;
  const drawn: Ticket[] = [];
  const grouped: Ticket[] = [];
  for (const t of ranked) {
    const ring = RING_FOR[t.priority];
    const fits = (used.get(ring) ?? 0) + footprint(t) <= RING_FILL * TAU * ring - RING_LABEL_ARC;
    if (t.status === 'Blocked' || (drawn.length < limit && fits)) {
      drawn.push(t);
      used.set(ring, (used.get(ring) ?? 0) + footprint(t));
    } else grouped.push(t);
  }
  return { drawn, grouped };
}

export function layoutOrbit(
  open: Ticket[],
  prs: PullRequest[],
  closed: { done: Ticket[]; cancelled: Ticket[] },
  agents: Record<string, AgentMark> = {},
): OrbitLayout {
  const moonsOf = new Map<string, PullRequest[]>();
  for (const pr of [...prs].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)) {
    if (pr.state !== 'open' && pr.state !== 'draft') continue;
    moonsOf.set(pr.ticket, [...(moonsOf.get(pr.ticket) ?? []), pr]);
  }
  const { drawn, grouped } = chooseDrawn(open, (key) => moonsOf.has(key), agents);

  // A linked group moves as one unit: hashed as a group, its members on their own rings at nearly
  // the same angle, so the dashed line between them stays short.
  const byKey = new Map(drawn.map((t) => [t.key, t]));
  const { links, groups } = linkGroups(drawn);
  const units: Unit[] = groups.map((keys) => {
    const unit: Unit = { base: (hash(keys.join('+')) / 2 ** 32) * TAU, members: [] };
    unit.members = keys.map((key) => {
      const t = byKey.get(key)!;
      return { key, radius: RING_FOR[t.priority], d: ticketDiameter(t.storyPoints), hasMoons: moonsOf.has(key), labelled: true, offset: 0, unit };
    });
    return unit;
  });
  if (grouped.length) {
    const unit: Unit = { base: (hash(CLUSTER.key) / 2 ** 32) * TAU, members: [] };
    unit.members = [{ key: CLUSTER.key, radius: CLUSTER.radius, d: CLUSTER.d, hasMoons: false, labelled: false, offset: 0, unit }];
    units.push(unit);
  }
  const members = units.flatMap((u) => u.members);
  const memberOf = new Map(members.map((m) => [m.key, m]));

  const angleOf = (m: Member) => wrap(m.unit.base + m.offset);
  const place = (m: Member) => {
    const a = angleOf(m);
    return { key: m.key, d: m.d, hasMoons: m.hasMoons, x: MAP.cx + m.radius * Math.cos(a), y: MAP.cy + m.radius * Math.sin(a) };
  };
  const STEP = 4; // px along the ring per nudge
  const nudge = (m: Member, dir: number, wholeUnit: boolean) => {
    if (wholeUnit) m.unit.base = wrap(m.unit.base + (dir * STEP) / m.radius);
    else m.offset += (dir * STEP) / m.radius;
  };
  /** Push a and b apart: within a group by their offsets, across groups by moving both groups. */
  const separate = (a: Member, b: Member, dir: number) => {
    const same = a.unit === b.unit;
    nudge(a, dir, !same);
    nudge(b, -dir, !same);
  };
  const fixed = fixedBoxes();
  const MARGIN = 6;

  // First with labels beside every circle; if that cannot settle (a crowded ring), circles alone,
  // and the labels then go wherever there is room.
  if (!settle(true)) settle(false);

  function settle(withLabels: boolean): boolean {
    for (let round = 0; round < 800; round++) {
      let moved = false;
      const placed = new Map(members.map((m) => [m.key, place(m)]));
      const boxes = new Map(members.map((m) => [m.key, withLabels && m.labelled ? ticketBoxes(placed.get(m.key)!) : [circleBox(placed.get(m.key)!)]]));

      for (let i = 0; i < members.length; i++) {
        const a = members[i]!;
        const boxesA = boxes.get(a.key)!;
        for (let j = i + 1; j < members.length; j++) {
          const b = members[j]!;
          if (!boxesA.some((x) => boxes.get(b.key)!.some((y) => overlaps(x, y, MARGIN)))) continue;
          separate(a, b, Math.sign(signedDiff(angleOf(a), angleOf(b))) || -1);
          moved = true;
        }
        for (const f of fixed) {
          if (!boxesA.some((x) => overlaps(x, f, MARGIN))) continue;
          const toward = Math.atan2((f.y0 + f.y1) / 2 - MAP.cy, (f.x0 + f.x1) / 2 - MAP.cx);
          nudge(a, Math.sign(signedDiff(angleOf(a), toward)) || 1, true);
          moved = true;
        }
      }

      // A dashed line never passes behind or through another ticket.
      for (const [ka, kb] of links) {
        const p = placed.get(ka)!;
        const q = placed.get(kb)!;
        const lineAngle = Math.atan2((p.y + q.y) / 2 - MAP.cy, (p.x + q.x) / 2 - MAP.cx);
        const owner = memberOf.get(ka)!;
        for (const m of members) {
          if (m.key === ka || m.key === kb) continue;
          if (!boxes.get(m.key)!.some((box) => segmentCrossesBox(p.x, p.y, q.x, q.y, box, MARGIN / 2))) continue;
          const dir = Math.sign(signedDiff(angleOf(m), lineAngle)) || 1;
          if (m.unit === owner.unit) nudge(m, dir, false);
          else {
            nudge(m, dir, true);
            nudge(owner, -dir, true);
          }
          moved = true;
        }
      }
      if (!moved) return true;
    }
    return false;
  }

  // Labels by importance: right of the circle, else left, else only on hover.
  const final = new Map(members.map((m) => [m.key, place(m)]));
  const circles = members.map((m) => ({ key: m.key, box: circleBox(final.get(m.key)!) }));
  const taken: Box[] = [];
  const sides = new Map<string, PlacedTicket['label']>();
  for (const t of drawn) {
    const p = final.get(t.key)!;
    const side = (['right', 'left'] as const).find((s) => {
      const box = labelBox(p, s);
      return (
        !circles.some((c) => c.key !== t.key && overlaps(box, c.box, 0)) &&
        !fixed.some((f) => overlaps(box, f, 0)) &&
        !taken.some((l) => overlaps(box, l, 0))
      );
    });
    sides.set(t.key, side ?? 'hidden');
    if (side) taken.push(labelBox(p, side));
  }

  const tickets: PlacedTicket[] = members
    .filter((m) => m.labelled)
    .map((m) => ({ m, p: final.get(m.key)! }))
    .sort((a, b) => a.m.key.localeCompare(b.m.key))
    .map(({ m, p }) => ({
      key: m.key,
      x: p.x,
      y: p.y,
      d: m.d,
      angle: angleOf(m),
      radius: m.radius,
      moons: moonPositions(p.x, p.y, moonsOf.get(m.key) ?? []),
      label: sides.get(m.key)!,
    }));
  const node = memberOf.get(CLUSTER.key);
  const cluster = node ? { x: final.get(CLUSTER.key)!.x, y: final.get(CLUSTER.key)!.y, d: CLUSTER.d, keys: grouped.map((t) => t.key) } : null;

  return { tickets, cluster, links, ...cornerLayout(closed.done, closed.cancelled) };
}

/** Done tickets as small dots in the lower left corner, cancelled ones as rings in the upper left. */
export function cornerLayout(done: Ticket[], cancelled: Ticket[]): Pick<OrbitLayout, 'done' | 'cancelled'> {
  const byKey = (a: Ticket, b: Ticket) => a.key.localeCompare(b.key);
  return {
    done: [...done].sort(byKey).map((ticket, i) => {
      const d = 10 + 1.2 * (ticket.storyPoints ?? 0);
      const col = Math.floor(i / 4);
      const row = i % 4;
      return { ticket, d, x: 48 + (row % 2) * 28 + col * 60, y: 478 + row * 34 };
    }),
    cancelled: [...cancelled].sort(byKey).map((ticket, i) => {
      const col = Math.floor(i / 5);
      const row = i % 5;
      return { ticket, d: 14, x: 27 + (row % 2) * 22 + (Math.floor(row / 2) % 2) * 3 + col * 60, y: 31 + row * 18 };
    }),
  };
}
