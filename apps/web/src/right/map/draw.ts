// Draws the live map on a canvas, from the folded state at a given time; ported from
//  Motion comes from event times (a sub-agent grows out when it starts and
// shrinks back when it finishes) and from `t`, which only drives pulses and flowing dots.
import type { RunView, StepView, SubagentView, WorkspaceState } from '@elfoqsy/state';
import { agentLabel, runLabel } from '@elfoqsy/state';
import { GLYPH_PATHS, glyphFor } from '../../ui/glyphs';
import { STATUS_TOKEN } from '../../ui/ticket';
import {
  AGENT_R,
  CLUSTER_R,
  SUB_DISTANCES,
  SUB_R,
  SUB_SIDES,
  Space,
  TICKET_R,
  around,
  reservedRects,
  type MapLayout,
  type PlacedAgent,
} from './layout';

export interface MapHit {
  kind: 'agent' | 'ticket' | 'sub' | 'cluster';
  runId?: string;
  x: number;
  y: number;
  r: number;
  label: string;
}

/** Sub-agent motion, in seconds: growing out, then shrinking back once finished. */
export const GROW_S = 0.7;
export const BACK_S = 0.9;

export type Palette = ReturnType<typeof readPalette>;

const CANVAS_SIZES = ['sm', 'md', 'base', '2xl', '3xl'] as const;
type CanvasSize = (typeof CANVAS_SIZES)[number];

/** Colours and type from design/tokens.css, so the canvas uses the same tokens as the DOM. */
export function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return {
    v,
    font: v('font-sans'),
    /** Font sizes from the type scale, in px, for the canvas. */
    size: Object.fromEntries(CANVAS_SIZES.map((step) => [step, parseFloat(v(`font-size-${step}`))])) as Record<CanvasSize, number>,
    ground: v('bg-canvas'),
    ink: v('text-primary'),
    muted: v('text-muted'),
    secondary: v('text-secondary'),
    thread: v('skobeloff-800'),
    dashed: v('border-default'),
    flow: v('skobeloff-300'),
    glow: v('skobeloff-600'),
    breath: v('skobeloff-400'),
    agent: v('agent-running'),
    sub: v('skobeloff-500'),
    spinner: v('skobeloff-300'),
    ringBase: v('bg-raised'),
    done: v('status-done'),
    failed: v('status-blocked'),
    abandoned: v('status-todo'),
    current: v('blue-400'),
    waiting: v('status-needs-you'),
    result: v('green-400'),
    cancelled: v('status-todo'),
    glyph: v('glyph'),
    status: Object.fromEntries(Object.entries(STATUS_TOKEN).map(([s, token]) => [s, css.getPropertyValue(token).trim()])) as Record<string, string>,
  };
}

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const ease = (x: number): number => {
  const c = Math.max(0, Math.min(1, x));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
};

/** A sub-agent's place beside its agent, kept while it is drawn so it does not jump. */
export type SubSides = Map<string, { angle: number; dist: number } | null>;

interface SubDraw {
  sub: SubagentView;
  x: number;
  y: number;
  bx: number;
  ready: boolean;
}

export interface DrawInput {
  layout: MapLayout;
  state: WorkspaceState;
  /** Daemon time in ms, for event-driven motion. */
  now: number;
  /** Seconds, for pulses; frozen when motion is paused. */
  t: number;
  hover: MapHit | null;
  selected: string | null;
  sides: SubSides;
}

const glyphs = new Map<string, Path2D>();
const glyphPath = (d: string): Path2D => {
  let p = glyphs.get(d);
  if (!p) glyphs.set(d, (p = new Path2D(d)));
  return p;
};

/**
 * Sub-agents drawn now: running ones, the newest first so it gets the first side, then those finished less
 * than BACK_S ago, shrinking back to their agent.
 */
function visibleSubs(run: RunView, now: number): SubagentView[] {
  const shown = run.subagents.filter((s) => s.startedAt <= now && (s.finishedAt === undefined || now - s.finishedAt < BACK_S * 1000)).reverse();
  return [...shown.filter((s) => s.finishedAt === undefined), ...shown.filter((s) => s.finishedAt !== undefined)];
}

function stepColor(p: Palette, step: StepView, current: boolean, mode: PlacedAgent['mode'], t: number): string {
  if (current) {
    if (mode === 'waiting') return p.waiting;
    if (mode === 'failed') return p.failed;
    if (mode === 'paused') return p.current;
    return rgba(p.current, 0.55 + 0.45 * Math.sin(t * 4));
  }
  if (step.outcome === 'failed') return p.failed;
  if (step.outcome === 'abandoned') return p.abandoned;
  return p.done;
}

export function drawMap(g: CanvasRenderingContext2D, input: DrawInput, p: Palette): MapHit[] {
  const { layout, state, now, t, hover, selected, sides } = input;
  const { W, H, head, center: C, agents, cluster } = layout;
  // The geometry's scale: 1 at full size; smaller in a smaller slot. Text sizes never use it.
  const K = layout.k;
  const AR = AGENT_R * K;
  const TR = TICKET_R * K;
  const SR = SUB_R * K;
  const CR = CLUSTER_R * K;
  const F = p.font;
  const S = p.size;
  const hits: MapHit[] = [];
  const space = new Space(W, H, reservedRects(W, H, C, head, K));
  const labels: { text: string; font: string; color: string; r: { x: number; y: number; w: number; h: number } }[] = [];
  const place = (text: string, font: string, color: string, cands: ReturnType<typeof around>, h: number, force = false): void => {
    g.font = font;
    const r = space.place(g.measureText(text).width + 8, h, cands, force);
    if (r) labels.push({ text, font, color, r });
  };

  g.clearRect(0, 0, W, H);

  // Elfoqsy's breathing glow.
  const grd = g.createRadialGradient(C.x, C.y, 40 * K, C.x, C.y, 230 * K);
  grd.addColorStop(0, rgba(p.glow, 0.26));
  grd.addColorStop(1, rgba(p.glow, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(C.x, C.y, 230 * K, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = rgba(p.breath, 0.25 + 0.2 * Math.sin(t * 1.6));
  g.lineWidth = 2;
  g.beginPath();
  g.arc(C.x, C.y, (74 + 4 * Math.sin(t * 1.6)) * K, 0, Math.PI * 2);
  g.stroke();

  // Pass 1: threads, tickets and agents reserve their space first.
  for (const a of agents) {
    g.strokeStyle = p.thread;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(C.x + a.dx * 72 * K, C.y + a.dy * 72 * K);
    g.lineTo(a.ax - a.dx * AR, a.ay - a.dy * AR);
    g.stroke();
    g.setLineDash([6, 8]);
    g.strokeStyle = p.dashed;
    g.beginPath();
    g.moveTo(a.ax + a.dx * AR, a.ay + a.dy * AR);
    g.lineTo(a.tx - a.dx * TR, a.ty - a.dy * TR);
    g.stroke();
    g.setLineDash([]);
    if (a.mode === 'work') {
      // Instructions flowing out to a working agent.
      const reach = Math.hypot(a.ax - C.x, a.ay - C.y) - 118 * K;
      for (let i = 0; i < 3; i++) {
        const f = (t * 0.45 + i / 3 + a.run.agentNumber * 0.13) % 1;
        g.fillStyle = rgba(p.flow, 0.9 - f * 0.6);
        g.beginPath();
        g.arc(C.x + a.dx * (72 * K + f * reach), C.y + a.dy * (72 * K + f * reach), 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    space.reserveCircle(a.ax, a.ay, AR);
    space.reserveCircle(a.tx, a.ty, TR);
  }
  if (cluster) space.reserveCircle(cluster.x, cluster.y, CR);

  // Pass 2: sub-agents beside their agent, where they fit.
  const drawn = new Set<string>();
  const subsOf = new Map<string, SubDraw[]>();
  for (const a of agents) {
    const base = Math.atan2(a.dy, a.dx);
    const list: SubDraw[] = [];
    for (const sub of visibleSubs(a.run, now)) {
      drawn.add(sub.subagentId);
      const at = (side: { angle: number; dist: number }) => ({ x: a.ax + Math.cos(base + side.angle) * side.dist * K, y: a.ay + Math.sin(base + side.angle) * side.dist * K });
      let side = sides.get(sub.subagentId);
      const finishing = sub.finishedAt !== undefined;
      if (finishing && !side) continue;
      if (!finishing && (side === undefined || (side && !space.circleFits(at(side).x, at(side).y, SR)))) {
        side = null;
        for (const dist of SUB_DISTANCES) {
          for (const deg of SUB_SIDES) {
            const c = { angle: (deg * Math.PI) / 180, dist };
            const q = at(c);
            if (space.circleFits(q.x, q.y, SR)) {
              side = c;
              break;
            }
          }
          if (side) break;
        }
        sides.set(sub.subagentId, side);
      }
      if (!side) continue; // no room: it is still in the pane
      const full = at(side);
      // A finishing one is shrinking away; a new one may take its side.
      if (!finishing) space.reserveCircle(full.x, full.y, SR);
      const u = (now - sub.startedAt) / 1000;
      const grow = ease(u / GROW_S);
      const back = sub.finishedAt !== undefined ? ease((now - sub.finishedAt) / 1000 / BACK_S) : 0;
      const k = grow * (1 - back);
      const sx = a.ax + (full.x - a.ax) * k;
      const sy = a.ay + (full.y - a.ay) * k;
      const r = 9 * K * Math.max(0.2, grow) * (1 - back * 0.7);
      g.strokeStyle = rgba(p.sub, 0.5 * (1 - back));
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(a.ax, a.ay);
      g.lineTo(sx, sy);
      g.stroke();
      g.fillStyle =
        sub.finishedAt === undefined ? p.sub : sub.outcome === 'failed' ? p.failed : sub.outcome === 'cancelled' ? p.cancelled : p.done;
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.fill();
      if (sub.finishedAt === undefined && u > GROW_S) {
        const sp = t * 5 + sub.index;
        g.strokeStyle = p.spinner;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(sx, sy, r + 6 * K, sp, sp + Math.PI * 0.9);
        g.stroke();
      }
      if (sub.finishedAt !== undefined) {
        // Its result travels back to Elfoqsy.
        g.fillStyle = p.result;
        g.beginPath();
        g.arc(a.ax + (C.x - a.ax) * back, a.ay + (C.y - a.ay) * back, 4, 0, Math.PI * 2);
        g.fill();
      }
      list.push({ sub, x: sx, y: sy, bx: Math.cos(base + side.angle), ready: grow > 0.9 && back < 0.1 });
      hits.push({ kind: 'sub', runId: a.run.runId, x: sx, y: sy, r: SR, label: `${agentLabel(sub.model, sub.effort)}: ${sub.task}` });
    }
    subsOf.set(a.run.runId, list);
  }
  for (const id of sides.keys()) if (!drawn.has(id)) sides.delete(id);

  // Pass 3: tickets and agents.
  for (const a of agents) {
    const ticket = state.tickets[a.run.ticket];
    g.fillStyle = (ticket && p.status[ticket.status]) || p.abandoned;
    g.beginPath();
    g.arc(a.tx, a.ty, 18 * K, 0, Math.PI * 2);
    g.fill();
    const glyph = GLYPH_PATHS[glyphFor(ticket?.type ?? (a.run.task ? 'Task' : 'Bug'))];
    g.save();
    g.translate(a.tx - 8 * K, a.ty - 8 * K);
    g.scale((16 / 24) * K, (16 / 24) * K);
    if (glyph.fill) {
      g.fillStyle = p.glyph;
      g.fill(glyphPath(glyph.d));
    } else {
      g.strokeStyle = p.glyph;
      g.lineWidth = glyph.stroke + 0.2;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke(glyphPath(glyph.d));
    }
    g.restore();

    if (a.mode === 'waiting') {
      g.strokeStyle = rgba(p.waiting, 0.4 + 0.35 * Math.sin(t * 3));
      g.lineWidth = 3;
      g.beginPath();
      g.arc(a.ax, a.ay, (50 + 3 * Math.sin(t * 3)) * K, 0, Math.PI * 2);
      g.stroke();
      // The question travels toward the left screen, where he answers.
      const w = (t * 0.35) % 1;
      g.fillStyle = rgba(p.waiting, 1 - w);
      g.beginPath();
      g.arc(a.ax - a.ax * w, a.ay, 5, 0, Math.PI * 2);
      g.fill();
    }

    // One fixed arc per step formed; no arcs for steps that do not exist yet.
    const steps = a.run.steps;
    const seg = (Math.PI * 2) / Math.max(12, steps.length);
    g.strokeStyle = p.ringBase;
    g.lineWidth = 6 * K;
    g.beginPath();
    g.arc(a.ax, a.ay, 38 * K, 0, Math.PI * 2);
    g.stroke();
    steps.forEach((step, s) => {
      g.strokeStyle = stepColor(p, step, step.endedAt === undefined, a.mode, t);
      g.beginPath();
      g.arc(a.ax, a.ay, 38 * K, -Math.PI / 2 + s * seg + 0.08, -Math.PI / 2 + (s + 1) * seg - 0.08);
      g.stroke();
    });

    g.fillStyle = p.agent;
    g.beginPath();
    g.arc(a.ax, a.ay, 28 * K, 0, Math.PI * 2);
    g.fill();
    if (selected === a.run.runId) {
      g.strokeStyle = p.ink;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(a.ax, a.ay, 60 * K, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = p.ink;
    g.font = `800 ${S['3xl']}px ${F}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(a.run.agentNumber), a.ax, a.ay + 1);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    hits.push({ kind: 'agent', runId: a.run.runId, x: a.ax, y: a.ay, r: 50 * K, label: `Agent ${a.run.agentNumber}, ${agentLabel(a.run.model, a.run.effort)}` });
    hits.push({ kind: 'ticket', runId: a.run.runId, x: a.tx, y: a.ty, r: TR, label: ticket ? `${ticket.key} ${ticket.summary}` : a.run.task ? `${a.run.task.name}: ${a.run.task.goal}` : a.run.ticket });
  }

  if (cluster) {
    g.strokeStyle = p.breath;
    g.lineWidth = 2;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.arc(cluster.x, cluster.y, 30 * K, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = p.ink;
    g.font = `800 ${S['2xl']}px ${F}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`+${cluster.runs.length}`, cluster.x, cluster.y + 1);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    const numbers = cluster.runs.map((r) => r.agentNumber).sort((x, y) => x - y);
    hits.push({ kind: 'cluster', x: cluster.x, y: cluster.y, r: CR, label: `${numbers.length} more agents: ${numbers.join(', ')}` });
  }

  // Pass 4: labels, most important first (and the agents that need him before the rest); whatever finds no
  // free spot stays hidden until hovered.
  const urgent = [...agents].sort((x, y) => Number(y.mode === 'waiting' || y.mode === 'failed') - Number(x.mode === 'waiting' || x.mode === 'failed'));
  for (const a of urgent) place(`Agent ${a.run.agentNumber}`, `700 ${S.base}px ${F}`, p.ink, around(a.ax, a.ay, 70 * K, 54 * K, 56 * K), 17);
  for (const a of urgent) place(runLabel(a.run), `700 ${S.base}px ${F}`, p.ink, around(a.tx, a.ty, 40 * K, 28 * K, 28 * K), 17);
  for (const a of urgent) {
    place(agentLabel(a.run.model, a.run.effort), `600 ${S.sm}px ${F}`, p.muted, around(a.ax, a.ay, 88 * K, 72 * K, 0).slice(0, 2), 15);
  }
  for (const a of agents) {
    for (const s of subsOf.get(a.run.runId) ?? []) {
      if (!s.ready) continue;
      const right = s.bx >= 0;
      place(
        agentLabel(s.sub.model, s.sub.effort),
        `600 ${S.sm}px ${F}`,
        p.secondary,
        [
          { x: s.x + (right ? 16 : -16) * K, y: s.y + 5, align: right ? 'left' : 'right' },
          { x: s.x + (right ? -16 : 16) * K, y: s.y + 5, align: right ? 'right' : 'left' },
          { x: s.x, y: s.y - 16 * K, align: 'center' },
          { x: s.x, y: s.y + 28 * K, align: 'center' },
        ],
        15,
      );
    }
  }
  if (hover) place(hover.label, `700 ${S.md}px ${F}`, p.ink, [{ x: hover.x, y: hover.y - (hover.r + 10), align: 'center' }], 16, true);
  for (const l of labels) {
    g.fillStyle = p.ground;
    g.fillRect(l.r.x, l.r.y, l.r.w, l.r.h);
    g.font = l.font;
    g.fillStyle = l.color;
    g.textAlign = 'left';
    g.fillText(l.text, l.r.x + 4, l.r.y + l.r.h - 4);
  }
  return hits;
}

export function hitAt(hits: MapHit[], x: number, y: number): MapHit | null {
  let best: { h: MapHit; d: number } | null = null;
  for (const h of hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= h.r && (!best || d < best.d)) best = { h, d };
  }
  return best?.h ?? null;
}
