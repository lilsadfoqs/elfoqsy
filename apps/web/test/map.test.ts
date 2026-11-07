import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { foldAll } from '@elfoqsy/state';
import { drawMap, type Palette } from '../src/right/map/draw';
import { AGENT_R, CLUSTER_R, CORE_R, MAX_DRAWN, TICKET_R, layoutMap } from '../src/right/map/layout';
import { eventFactory, time } from './helpers';

/** n agents: agent 4 waits for him, agent 9 failed, the rest work, each with two running sub-agents. */
function crowd(n: number) {
  const e = eventFactory();
  const events: AnyEnvelope[] = [];
  for (let i = 0; i < n; i++) {
    const number = 3 + i;
    const runId = `r${number}`;
    events.push(e('run.created', { runId, ticket: `SHOP-${3600 + number}`, worktree: '', branch: '', agentNumber: number }, 0));
    events.push(e('run.state_changed', { runId, state: number === 4 ? 'waiting_for_you' : number === 9 ? 'failed' : 'running' }, 0));
    events.push(e('run.step_begun', { runId, stepIndex: 0, name: 'Investigate', why: 'Start' }, 1));
    for (let j = 0; j < 2; j++) {
      events.push(e('subagent.started', { runId, subagentId: `${runId}-s${j}`, model: 'claude-haiku-5-5', effort: 'low', task: 'Search' }, 2));
    }
  }
  return foldAll(events);
}

const W = 786;
const H = 1024;

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const circleRect = (x: number, y: number, r: number): Rect => ({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });

/** A canvas context that records label backgrounds and measures text at 8px a character. */
function recorder() {
  const labels: Rect[] = [];
  const g = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillRect: (x: number, y: number, w: number, h: number) => labels.push({ x, y, w, h }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : () => {}), set: () => true },
  );
  return { g: g as unknown as CanvasRenderingContext2D, labels };
}

const palette = new Proxy({ status: {}, font: 'sans-serif', size: { sm: 13, md: 14, base: 15, '2xl': 18, '3xl': 20 } } as Record<string, unknown>, {
  get: (target, key) => (key in target ? target[key as string] : '#123456'),
}) as unknown as Palette;

beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = class {};
});
afterAll(() => {
  delete (globalThis as { Path2D?: unknown }).Path2D;
});

describe('live map: crowding (30 agents)', () => {
  const state = crowd(30);
  const layout = layoutMap(state, W, H);

  it('draws at most 8 agents on their own, groups the rest as +N, and keeps the waiting and failing ones', () => {
    expect(layout.agents.length + (layout.cluster ? 1 : 0)).toBeLessThanOrEqual(MAX_DRAWN);
    expect(layout.cluster?.runs).toHaveLength(30 - layout.agents.length);
    expect(layout.agents.map((a) => a.run.agentNumber)).toEqual(expect.arrayContaining([4, 9]));
  });

  it('lets nothing overlap: agents, tickets, the +N node, Elfoqsy, sub-agents and labels', () => {
    const { g, labels } = recorder();
    const hits = drawMap(g, { layout, state, now: time(10), t: 0, hover: null, selected: null, sides: new Map() }, palette);
    const shapes: Rect[] = [
      circleRect(layout.center.x, layout.center.y, CORE_R),
      ...layout.agents.flatMap((a) => [circleRect(a.ax, a.ay, AGENT_R), circleRect(a.tx, a.ty, TICKET_R)]),
      circleRect(layout.cluster!.x, layout.cluster!.y, CLUSTER_R),
      ...hits.filter((h) => h.kind === 'sub').map((h) => circleRect(h.x, h.y, h.r)),
    ];
    expect(hits.filter((h) => h.kind === 'sub').length).toBeGreaterThan(0);
    const all = [...shapes, ...labels];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!), `${JSON.stringify(all[i])} ${JSON.stringify(all[j])}`).toBe(false);
    }
    for (const r of all) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W);
      expect(r.y + r.h).toBeLessThanOrEqual(H);
    }
  });

  it('draws every agent individually when there are 8 or fewer', () => {
    const few = layoutMap(crowd(8), W, H);
    expect(few.agents).toHaveLength(8);
    expect(few.cluster).toBeNull();
  });
});
