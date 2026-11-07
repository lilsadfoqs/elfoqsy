import { describe, expect, it } from 'vitest';
import type { PullRequest, Ticket } from '@elfoqsy/contracts';
import { CLUSTER, MAP, MAX_TICKETS, RING_FOR, fixedBoxes, layoutOrbit, segmentCrossesBox, ticketBoxes, ticketDiameter, type AgentMark, type Box } from '../src/left/sprint/layout';
import { mockSprint } from './helpers';

const { open, closed, prs: mockPrs } = mockSprint();
const prs: PullRequest[] = mockPrs.map((p) => ({ ...p, state: 'open', url: '', checks: 'none' }));
const corners = {
  done: closed.filter((t) => t.status === 'Done' || t.status === 'Released'),
  cancelled: closed.filter((t) => t.status === 'Cancelled'),
};

const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function assertNoOverlaps(tickets: Ticket[], pullRequests: PullRequest[] = [], agents: Record<string, AgentMark> = {}) {
  const layout = layoutOrbit(tickets, pullRequests, { done: [], cancelled: [] }, agents);
  // Each drawn ticket's circle and, when written, its label; the +N node is a circle without one.
  const boxes = layout.tickets.map((t) => ({ key: t.key, boxes: ticketBoxes({ ...t, hasMoons: t.moons.length > 0 }) }));
  if (layout.cluster) boxes.push({ key: CLUSTER.key, boxes: ticketBoxes({ key: CLUSTER.key, x: layout.cluster.x, y: layout.cluster.y, d: CLUSTER.d, hasMoons: false, label: 'hidden' }) });
  // No dashed line passes behind or through a ticket other than its own two.
  for (const [a, b] of layout.links) {
    const p = layout.tickets.find((t) => t.key === a)!;
    const q = layout.tickets.find((t) => t.key === b)!;
    for (const other of boxes.filter((o) => o.key !== a && o.key !== b)) {
      const crosses = other.boxes.some((box) => segmentCrossesBox(p.x, p.y, q.x, q.y, box));
      expect(crosses, `the ${a}–${b} line crosses ${other.key}`).toBe(false);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (const f of fixedBoxes()) {
      expect(boxes[i]!.boxes.some((b) => overlap(b, f)), `${boxes[i]!.key} overlaps a fixed label`).toBe(false);
    }
    for (let j = i + 1; j < boxes.length; j++) {
      const hit = boxes[i]!.boxes.some((a) => boxes[j]!.boxes.some((b) => overlap(a, b)));
      expect(hit, `${boxes[i]!.key} overlaps ${boxes[j]!.key}`).toBe(false);
    }
  }
  return layout;
}

describe('orbit layout', () => {
  it('puts each ticket on its priority ring, Blocker with Critical', () => {
    const layout = layoutOrbit(open, prs, corners);
    for (const placed of layout.tickets) {
      const t = open.find((o) => o.key === placed.key)!;
      expect(Math.hypot(placed.x - MAP.cx, placed.y - MAP.cy)).toBeCloseTo(RING_FOR[t.priority], 6);
      expect(placed.d).toBe(ticketDiameter(t.storyPoints));
    }
    expect(RING_FOR.Blocker).toBe(RING_FOR.Critical);
  });

  it('sizes circles 24 + 6 × points, 24 when unestimated', () => {
    expect(ticketDiameter(null)).toBe(24);
    expect(ticketDiameter(5)).toBe(54);
  });

  it('is stable: same tickets, same places, whatever order they arrive in', () => {
    const a = layoutOrbit(open, prs, corners);
    const b = layoutOrbit([...open].reverse(), [...prs].reverse(), { done: [...corners.done].reverse(), cancelled: [...corners.cancelled].reverse() });
    expect(b).toEqual(a);
  });

  it('keeps circles, PR orbits and labels apart for the real sprint', () => {
    assertNoOverlaps(open, prs);
  });

  it('keeps them apart in a crowded sprint too', () => {
    const priorities: Ticket['priority'][] = ['Critical', 'Major', 'Major', 'Minor', 'Minor'];
    const crowded = Array.from({ length: 15 }, (_, i) => ({
      ...open[0]!,
      key: `SHOP-${4000 + i * 7}`,
      priority: priorities[i % priorities.length]!,
      storyPoints: [1, 2, 3, 5, 8, null][i % 6] ?? null,
    }));
    assertNoOverlaps(crowded);
  });

  it('links only linked tickets that sit on different boards', () => {
    expect(layoutOrbit(open, prs, corners).links).toEqual([['CORE-18891', 'SHOP-3546']]);
  });

  it('places linked tickets next to each other, as one group', () => {
    const layout = layoutOrbit(open, prs, corners);
    const a = layout.tickets.find((t) => t.key === 'SHOP-3546')!;
    const b = layout.tickets.find((t) => t.key === 'CORE-18891')!;
    // Both are Major, so they share a ring and sit side by side on it.
    const gap = Math.abs(Math.atan2(Math.sin(a.angle - b.angle), Math.cos(a.angle - b.angle)));
    expect(gap).toBeLessThan(Math.PI / 3);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(200);
  });

  it('keeps linked tickets on different rings at nearly the same angle', () => {
    const critical = { ...open[0]!, key: 'SHOP-5000', board: 'SHOP', priority: 'Critical' as const, linked: ['CORE-6000'] };
    const minor = { ...open[0]!, key: 'CORE-6000', board: 'CORE', priority: 'Minor' as const, linked: ['SHOP-5000'] };
    const layout = layoutOrbit([critical, minor], [], { done: [], cancelled: [] });
    const [a, b] = layout.tickets;
    expect(Math.abs(Math.atan2(Math.sin(a!.angle - b!.angle), Math.cos(a!.angle - b!.angle)))).toBeLessThan(0.2);
  });

  it('keeps lines and tickets apart in a crowded sprint with several linked groups', () => {
    const priorities: Ticket['priority'][] = ['Critical', 'Major', 'Major', 'Minor', 'Minor', 'Blocker'];
    const tickets: Ticket[] = Array.from({ length: 16 }, (_, i) => ({
      ...open[0]!,
      key: i % 4 === 3 ? `CORE-${7000 + i}` : `SHOP-${5000 + i * 7}`,
      board: i % 4 === 3 ? 'CORE' : 'SHOP',
      priority: priorities[i % priorities.length]!,
      storyPoints: [1, 2, 3, 5, null][i % 5] ?? null,
      linked: [],
    }));
    // Link each CORE ticket to the SHOP ticket before it, and one CORE ticket to two SHOP tickets.
    for (let i = 3; i < tickets.length; i += 4) {
      tickets[i]!.linked = [tickets[i - 1]!.key];
      tickets[i - 1]!.linked = [tickets[i]!.key];
    }
    tickets[3]!.linked.push(tickets[0]!.key);
    tickets[0]!.linked = [tickets[3]!.key];
    assertNoOverlaps(tickets);
    const shuffled = [...tickets].reverse();
    expect(layoutOrbit(shuffled, [], { done: [], cancelled: [] })).toEqual(layoutOrbit(tickets, [], { done: [], cancelled: [] }));
  });

  it('knows when a line crosses a box', () => {
    const box = { x0: 10, y0: 10, x1: 20, y1: 20 };
    expect(segmentCrossesBox(0, 15, 30, 15, box)).toBe(true);
    expect(segmentCrossesBox(0, 0, 30, 5, box)).toBe(false);
    expect(segmentCrossesBox(12, 12, 14, 14, box)).toBe(true);
  });

  it('draws open and draft PRs as moons, never merged or closed ones', () => {
    const withDraft: PullRequest[] = [
      ...prs,
      { repo: 'shop-api', number: 7, state: 'draft', ticket: 'SHOP-3546', url: '', checks: 'none' },
      { repo: 'shop-api', number: 6, state: 'merged', ticket: 'SHOP-3546', url: '', checks: 'none' },
    ];
    const layout = layoutOrbit(open, withDraft, corners);
    const moons = (key: string) => layout.tickets.find((t) => t.key === key)!.moons.map((m) => `${m.pr.repo}#${m.pr.number}`);
    expect(moons('SHOP-3472')).toEqual(['shop-shared#159', 'shop-worker#212']);
    expect(moons('SHOP-3546')).toEqual(['shop-api#7']);
  });

  it('puts done (and released) tickets in the lower left, cancelled ones in the upper left', () => {
    const layout = layoutOrbit(open, prs, corners);
    expect(layout.done.map((d) => d.ticket.key)).toEqual(['SHOP-2753', 'SHOP-3490']);
    expect(layout.cancelled).toHaveLength(4);
    for (const d of layout.done) expect(d.y).toBeGreaterThan(MAP.height * 0.75);
    for (const c of layout.cancelled) expect(c.y).toBeLessThan(MAP.height * 0.25);
  });
});

/** A made-up sprint: priorities, points, statuses and slips spread out, deterministic for a seed. */
function sprint(n: number, seed = 1): Ticket[] {
  let x = seed;
  const next = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const priorities: Ticket['priority'][] = ['Blocker', 'Critical', 'Major', 'Major', 'Minor', 'Minor'];
  const statuses: Ticket['status'][] = ['To do', 'To do', 'In progress', 'In progress', 'Blocked'];
  return Array.from({ length: n }, (_, i) => ({
    ...open[0]!,
    key: `SHOP-${6000 + i * 13}`,
    priority: priorities[Math.floor(next() * priorities.length)]!,
    status: statuses[Math.floor(next() * statuses.length)]!,
    storyPoints: [1, 2, 3, 5, 8, null][Math.floor(next() * 6)] ?? null,
    sprintsCarried: 1 + Math.floor(next() * 10),
    linked: [],
  }));
}

describe('orbit layout under crowding', () => {
  it('draws a sprint of 12 tickets or fewer whole, with every key written', () => {
    const layout = layoutOrbit(open, prs, corners);
    expect(layout.cluster).toBeNull();
    expect(layout.tickets).toHaveLength(open.length);
    expect(layout.tickets.every((t) => t.label === 'right')).toBe(true);
  });

  it('with 30 tickets, keeps 11 circles and groups the rest into +N, blocked and waiting tickets always kept, nothing overlapping', () => {
    const tickets = sprint(30);
    const blocked = tickets.filter((t) => t.status === 'Blocked').map((t) => t.key);
    const minor = tickets.find((t) => t.priority === 'Minor' && t.status !== 'Blocked')!;
    const agents: Record<string, AgentMark> = { [minor.key]: 'waiting' };
    expect(blocked.length).toBeGreaterThan(2);
    const layout = assertNoOverlaps(tickets, [], agents);
    const drawn = layout.tickets.map((t) => t.key);
    expect(drawn.length).toBeLessThanOrEqual(MAX_TICKETS - 1);
    expect(layout.cluster!.keys).toHaveLength(30 - drawn.length);
    expect(drawn).toEqual(expect.arrayContaining([...blocked, minor.key]));
    expect(layout.cluster!.keys.some((k) => blocked.includes(k))).toBe(false);
    // Every circle sits on its priority ring; the +N node on the outer one.
    for (const t of layout.tickets) expect(Math.hypot(t.x - MAP.cx, t.y - MAP.cy)).toBeCloseTo(RING_FOR[tickets.find((x) => x.key === t.key)!.priority], 6);
    expect(Math.hypot(layout.cluster!.x - MAP.cx, layout.cluster!.y - MAP.cy)).toBeCloseTo(CLUSTER.radius, 6);
    // The same sprint in another order lands in the same places.
    expect(layoutOrbit([...tickets].reverse(), [], { done: [], cancelled: [] }, agents)).toEqual(layout);
  });

  it('keeps more than 11 circles only for blocked tickets', () => {
    const tickets = sprint(30, 7).map((t, i) =>
      i < 14 ? { ...t, status: 'Blocked' as const, priority: 'Minor' as const, storyPoints: 1 } : { ...t, status: t.status === 'Blocked' ? ('To do' as const) : t.status },
    );
    const layout = assertNoOverlaps(tickets);
    expect(layout.tickets.map((t) => t.key).sort()).toEqual(tickets.slice(0, 14).map((t) => t.key).sort());
    expect(layout.cluster!.keys).toHaveLength(16);
  });

  it('groups tickets a full ring has no room for, even under 12', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ ...open[0]!, key: `SHOP-${7000 + i}`, priority: 'Critical' as const, status: 'To do' as const, storyPoints: 13, linked: [] }));
    const layout = assertNoOverlaps(big);
    expect(layout.cluster).not.toBeNull();
    expect(layout.tickets.length + layout.cluster!.keys.length).toBe(10);
  });

  it('never overlaps across 60 random sprints of 13 to 40 tickets', () => {
    for (let seed = 1; seed <= 60; seed++) assertNoOverlaps(sprint(13 + (seed % 28), seed));
  });
});
