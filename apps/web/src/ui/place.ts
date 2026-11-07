// Where a floating layer goes (docs/ui-spec.md "Floating layers"): beside its anchor on the preferred side,
// flipped to the opposite side when it does not fit, then the other two, and shifted along the side to stay inside the
// bounds (the screen, or the grown dial for a dot's title) and off the other open layers. Pure, in stage pixels.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Placement {
  x: number;
  y: number;
  side: Side;
  /** Fits the bounds and touches no rect to avoid. */
  clean: boolean;
}

/** The stage everything is drawn on: 1920 × 1080 (stage/Stage.tsx). */
export const SCREEN: Rect = { x: 0, y: 0, w: 1920, h: 1080 };

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const overlap = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
export const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function place(
  anchor: Rect,
  size: { w: number; h: number },
  o: { side: Side; align?: 'start' | 'center' | 'end'; gap?: number; bounds?: Rect; margin?: number; avoid?: Rect[] },
): Placement {
  const gap = o.gap ?? 6;
  const margin = o.margin ?? 8;
  const b = o.bounds ?? SCREEN;
  const inner: Rect = { x: b.x + margin, y: b.y + margin, w: b.w - 2 * margin, h: b.h - 2 * margin };
  const avoid = o.avoid ?? [];
  const order: Side[] = [o.side, OPPOSITE[o.side], ...(['bottom', 'top', 'right', 'left'] as Side[]).filter((s) => s !== o.side && s !== OPPOSITE[o.side])];
  const along = (start: number, length: number, size: number): number => (o.align === 'end' ? start + length - size : o.align === 'center' ? start + (length - size) / 2 : start);
  let best: (Placement & { cost: number }) | undefined;
  for (const side of order) {
    const vertical = side === 'top' || side === 'bottom';
    let x = vertical ? along(anchor.x, anchor.w, size.w) : side === 'right' ? anchor.x + anchor.w + gap : anchor.x - gap - size.w;
    let y = vertical ? (side === 'bottom' ? anchor.y + anchor.h + gap : anchor.y - gap - size.h) : along(anchor.y, anchor.h, size.h);
    // Shift along the side to stay inside; the side itself is not moved, or it would cover its anchor.
    if (vertical) x = clamp(x, inner.x, inner.x + inner.w - size.w);
    else y = clamp(y, inner.y, inner.y + inner.h - size.h);
    let r: Rect = { x, y, ...size };
    // Off the other open layers: slide past each one along the side, if that stays inside.
    for (const a of avoid) {
      if (!intersects(r, a)) continue;
      const slid = vertical ? [{ ...r, x: a.x + a.w + gap }, { ...r, x: a.x - gap - size.w }] : [{ ...r, y: a.y + a.h + gap }, { ...r, y: a.y - gap - size.h }];
      const fit = slid.find((s) => inside(s, inner) && !intersects(s, anchor) && !avoid.some((o2) => intersects(s, o2)));
      if (fit) r = fit;
    }
    const cost = (inside(r, inner) ? 0 : size.w * size.h - overlap(r, inner)) + avoid.reduce((c, a) => c + overlap(r, a), 0) + overlap(r, anchor);
    if (cost === 0) return { x: r.x, y: r.y, side, clean: true };
    if (!best || cost < best.cost) best = { x: r.x, y: r.y, side, clean: false, cost };
  }
  return { x: best!.x, y: best!.y, side: best!.side, clean: false };
}

/** The stage a node is drawn on, and its scale: layers are placed in the stage's own 1920 × 1080 pixels. */
export function stageOf(node: Element): { el: HTMLElement; scale: number; box: DOMRect } | null {
  const el = node.closest<HTMLElement>('.stage');
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { el, scale: box.width / SCREEN.w || 1, box };
}

/** A node's box in stage pixels. */
export function stageRect(node: Element): Rect {
  const r = node.getBoundingClientRect();
  const s = stageOf(node);
  if (!s) return { x: r.left, y: r.top, w: r.width, h: r.height };
  return { x: (r.left - s.box.left) / s.scale, y: (r.top - s.box.top) / s.scale, w: r.width / s.scale, h: r.height / s.scale };
}

/** A screen rectangle (a caret's, say) in stage pixels. */
export function toStage(r: { left: number; top: number; width?: number; height?: number }, near: Element): Rect {
  const s = stageOf(near);
  if (!s) return { x: r.left, y: r.top, w: r.width ?? 0, h: r.height ?? 0 };
  return { x: (r.left - s.box.left) / s.scale, y: (r.top - s.box.top) / s.scale, w: (r.width ?? 0) / s.scale, h: (r.height ?? 0) / s.scale };
}
