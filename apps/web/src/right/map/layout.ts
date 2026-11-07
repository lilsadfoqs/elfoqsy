// Where things go on the live map, from  Pure, so crowding can be tested:
// at most MAX_DRAWN agents get a place of their own (waiting and failing first), the rest group into +N,
// and labels go into free space by priority or stay hidden until hovered.
import { isRunActive, type RunView, type WorkspaceState } from '@elfoqsy/state';

export type AgentMode = 'waiting' | 'failed' | 'paused' | 'work';

export const MAX_DRAWN = 8;
/** Agent circle with its ring, ticket circle, sub-agent, +N node: radii that keep everything apart. */
export const AGENT_R = 46;
export const TICKET_R = 22;
export const SUB_R = 16;
export const CLUSTER_R = 34;
export const CORE_R = 66;
/** Sub-agents sit beside their agent, never between it and its ticket or Elfoqsy (degrees off the thread). */
export const SUB_SIDES = [90, -90, 55, -55, 125, -125];
export const SUB_DISTANCES = [80, 64];

export function agentMode(run: RunView): AgentMode {
  if (run.state === 'waiting_for_you') return 'waiting';
  if (run.state === 'failed') return 'failed';
  if (run.paused) return 'paused';
  return 'work';
}

const RANK: Record<AgentMode, number> = { waiting: 0, failed: 1, paused: 2, work: 2 };

/** Agents on the map: every run that has not ended, the ones that need him first, then by number. */
export function agentsByUrgency(s: WorkspaceState): RunView[] {
  return Object.values(s.runs)
    .filter(isRunActive)
    .sort((a, b) => RANK[agentMode(a)] - RANK[agentMode(b)] || a.agentNumber - b.agentNumber);
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedAgent {
  run: RunView;
  mode: AgentMode;
  /** Unit vector from Elfoqsy along the agent's thread. */
  dx: number;
  dy: number;
  /** The agent, and its ticket at the end of the thread. */
  ax: number;
  ay: number;
  tx: number;
  ty: number;
}

export interface Cluster {
  x: number;
  y: number;
  runs: RunView[];
}

export interface Size {
  w: number;
  h: number;
}

/** Room the status bar takes at the top left, until it has been measured. */
export const DEFAULT_HEAD: Size = { w: 300, h: 72 };

export interface MapLayout {
  W: number;
  H: number;
  /** The geometry's scale (P1): 1 in a slot that holds the map as it is drawn, less in a smaller one. Text never scales. */
  k: number;
  /** The status bar's corner, kept clear of labels. */
  head: Size;
  center: Point;
  /** Agent radius and ticket radius from the centre; both shrink to the space the column has. */
  R: number;
  RT: number;
  agents: PlacedAgent[];
  cluster: Cluster | null;
}

/** The room (from the centre to a ticket) at which the map holds its full geometry; under it the geometry scales. */
const FULL_ROOM = 216;

/** The geometry's scale in a box of this size: 1 where the map holds as drawn, less in a smaller one (never under 0.4). */
export const mapScale = (W: number, H: number): number => Math.max(0.4, Math.min(1, (Math.min(W * 0.5, H * 0.44) - 34) / FULL_ROOM));

export function layoutMap(s: WorkspaceState, W: number, H: number, head: Size = DEFAULT_HEAD): MapLayout {
  const center = { x: W * 0.5, y: H * 0.56 };
  const ordered = agentsByUrgency(s);
  const shown = ordered.slice(0, ordered.length > MAX_DRAWN ? MAX_DRAWN - 1 : MAX_DRAWN).sort((a, b) => a.agentNumber - b.agentNumber);
  const hidden = ordered.slice(shown.length);
  const slots = shown.length + (hidden.length ? 1 : 0);
  const room = Math.min(W * 0.5, H * 0.44) - 34;
  const k = mapScale(W, H);
  const RT = Math.min(420, room);
  const R = Math.max(124 * k, Math.min(270, RT - 150 * k));
  const at = (i: number) => ((-28 + (i * 360) / Math.max(1, slots)) * Math.PI) / 180;
  const agents = shown.map((run, i) => {
    const dx = Math.cos(at(i));
    const dy = Math.sin(at(i));
    return { run, mode: agentMode(run), dx, dy, ax: center.x + dx * R, ay: center.y + dy * R, tx: center.x + dx * RT, ty: center.y + dy * RT };
  });
  const cluster = hidden.length
    ? { x: center.x + Math.cos(at(shown.length)) * R, y: center.y + Math.sin(at(shown.length)) * R, runs: hidden }
    : null;
  return { W, H, k, head, center, R, RT, agents, cluster };
}

/**
 * Free space on the map. Everything drawn reserves its rectangle; a label goes to the first candidate
 * spot that is free, or nowhere.
 */
export class Space {
  readonly taken: Rect[];

  constructor(
    readonly W: number,
    readonly H: number,
    reserved: Rect[] = [],
  ) {
    this.taken = [...reserved];
  }

  collides(r: Rect): boolean {
    if (r.x < 4 || r.y < 4 || r.x + r.w > this.W - 4 || r.y + r.h > this.H - 4) return true;
    return this.taken.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  }

  reserveCircle(x: number, y: number, r: number): void {
    this.taken.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
  }

  circleFits(x: number, y: number, r: number): boolean {
    return !this.collides({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
  }

  /**
   * A label `w` wide whose baseline sits at the candidate's y. Returns the rectangle it took, or null.
   * `force` places it at the first candidate whatever is there (the hovered label).
   */
  place(w: number, h: number, candidates: { x: number; y: number; align: 'left' | 'center' | 'right' }[], force = false): Rect | null {
    for (const c of candidates) {
      const r = { x: c.x - (c.align === 'center' ? w / 2 : c.align === 'right' ? w : 0), y: c.y - h + 3, w, h: h + 2 };
      if (force || !this.collides(r)) {
        this.taken.push(r);
        return r;
      }
    }
    return null;
  }
}

/** The fixed things on the map column that labels must avoid: status bar, collapse button, Play, Elfoqsy. */
export function reservedRects(W: number, H: number, center: Point, head: Size = DEFAULT_HEAD, k = 1): Rect[] {
  const core = CORE_R * k;
  return [
    { x: 0, y: 0, w: Math.min(W, head.w), h: head.h },
    { x: W - 48, y: 16, w: 48, h: 52 },
    { x: 0, y: H - 52, w: 110, h: 52 },
    { x: center.x - core, y: center.y - core, w: 2 * core, h: 2 * core },
  ];
}

/** Label spots in order of preference: under, over, right, then left of a circle. */
export function around(x: number, y: number, under: number, over: number, side: number): { x: number; y: number; align: 'left' | 'center' | 'right' }[] {
  return [
    { x, y: y + under, align: 'center' },
    { x, y: y - over, align: 'center' },
    { x: x + side, y: y + 6, align: 'left' },
    { x: x - side, y: y + 6, align: 'right' },
  ];
}
