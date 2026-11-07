// The terminal panes as a binary split tree, like Zellij. Pure: every change returns a new tree.
// A pane is never smaller than MIN_W by MIN_H; splits, drags and keyboard resizes all stop there.

export const MIN_W = 320;
export const MIN_H = 190;
export const GAP = 12;

export interface Leaf {
  type: 'leaf';
  id: string;
  /** The agent's run, or null for a new pane that offers attach or "do SHOP-1234". */
  runId: string | null;
  /** A stacked pane of that run's sub-agents. */
  stack?: boolean;
  /** A ticket this pane asked Elfoqsy to start; the pane attaches to the agent once it exists. */
  pendingTicket?: string;
}

export interface Split {
  type: 'split';
  id: string;
  dir: 'row' | 'col';
  /** Share of the span given to `a`. */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = Leaf | Split;
export type Side = 'left' | 'right' | 'up' | 'down';

export interface Tile {
  leaf: Leaf;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  split: Split;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the split's span starts on its axis, and how long it is (without the gap). */
  origin: number;
  span: number;
}

let seq = 0;
export const newId = (prefix: string): string => `${prefix}${++seq}`;

export const leaf = (runId: string | null, extra: Partial<Leaf> = {}): Leaf => ({ type: 'leaf', id: newId('p'), runId, ...extra });

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.max(lo, Math.min(hi, v));

/** The smallest a subtree can be along an axis. */
export function minSize(node: PaneNode, axis: 'x' | 'y'): number {
  if (node.type === 'leaf') return axis === 'x' ? MIN_W : MIN_H;
  const a = minSize(node.a, axis);
  const b = minSize(node.b, axis);
  const along = (node.dir === 'row' && axis === 'x') || (node.dir === 'col' && axis === 'y');
  return along ? a + GAP + b : Math.max(a, b);
}

/**
 * The range a split's ratio may take for a span, so neither side gets smaller than its minimum. When the
 * span cannot hold both (the box itself shrank), both sides give way in proportion to their minimums.
 */
export function bounds(split: Split, span: number): [number, number] {
  const axis = split.dir === 'row' ? 'x' : 'y';
  const a = minSize(split.a, axis);
  const b = minSize(split.b, axis);
  if (a + b > span) return [a / (a + b), a / (a + b)];
  return [a / span, Math.max(a / span, 1 - b / span)];
}

/** The size of side `a` in pixels: the ratio's share, never under either side's minimum when both fit. */
function sizeA(split: Split, span: number): number {
  const axis = split.dir === 'row' ? 'x' : 'y';
  const a = minSize(split.a, axis);
  const b = minSize(split.b, axis);
  const px = Math.round(span * clamp(split.ratio, bounds(split, span)));
  return a + b <= span ? Math.min(Math.max(px, a), span - b) : px;
}

/** Where every pane and divider goes in a box. Ratios that no longer fit are clamped here, not stored. */
export function layout(node: PaneNode, x: number, y: number, w: number, h: number): { tiles: Tile[]; dividers: Divider[] } {
  const tiles: Tile[] = [];
  const dividers: Divider[] = [];
  const walk = (n: PaneNode, x: number, y: number, w: number, h: number): void => {
    if (n.type === 'leaf') {
      tiles.push({ leaf: n, x, y, w, h });
      return;
    }
    if (n.dir === 'row') {
      const span = w - GAP;
      const wa = sizeA(n, span);
      walk(n.a, x, y, wa, h);
      walk(n.b, x + wa + GAP, y, w - wa - GAP, h);
      dividers.push({ split: n, x: x + wa, y, w: GAP, h, origin: x, span });
    } else {
      const span = h - GAP;
      const ha = sizeA(n, span);
      walk(n.a, x, y, w, ha);
      walk(n.b, x, y + ha + GAP, w, h - ha - GAP);
      dividers.push({ split: n, x, y: y + ha, w, h: GAP, origin: y, span });
    }
  };
  walk(node, x, y, w, h);
  return { tiles, dividers };
}

export function leaves(node: PaneNode): Leaf[] {
  return node.type === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export const firstLeaf = (node: PaneNode): Leaf => (node.type === 'leaf' ? node : firstLeaf(node.a));

/** Replaces one node (by id) anywhere in the tree. */
function replace(node: PaneNode, id: string, make: (n: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return make(node);
  if (node.type === 'leaf') return node;
  const a = replace(node.a, id, make);
  const b = replace(node.b, id, make);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export const updateLeaf = (tree: PaneNode, id: string, patch: Partial<Omit<Leaf, 'type' | 'id'>>): PaneNode =>
  replace(tree, id, (n) => ({ ...(n as Leaf), ...patch }));

export const setRatio = (tree: PaneNode, splitId: string, ratio: number): PaneNode => replace(tree, splitId, (n) => ({ ...(n as Split), ratio }));

/** Whether a pane of this size has room to split on that side. */
export const canSplit = (tile: { w: number; h: number } | undefined, side: Side): boolean =>
  !!tile && (side === 'left' || side === 'right' ? tile.w >= 2 * MIN_W + GAP : tile.h >= 2 * MIN_H + GAP);

/** Splits a pane, putting `added` on the given side. Null when the pane has no room. */
export function split(tree: PaneNode, tiles: Tile[], id: string, side: Side, added: Leaf): PaneNode | null {
  if (!canSplit(tiles.find((t) => t.leaf.id === id), side)) return null;
  const first = side === 'left' || side === 'up';
  return replace(tree, id, (old) => ({
    type: 'split',
    id: newId('s'),
    dir: side === 'left' || side === 'right' ? 'row' : 'col',
    ratio: 0.5,
    a: first ? added : old,
    b: first ? old : added,
  }));
}

/** Closes a pane; its sibling takes its place. The last pane cannot close. */
export function close(tree: PaneNode, id: string): { tree: PaneNode; focus: string } | null {
  if (tree.type === 'leaf') return null;
  const walk = (n: PaneNode): PaneNode => {
    if (n.type === 'leaf') return n;
    if (n.a.id === id) return n.b;
    if (n.b.id === id) return n.a;
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  const next = walk(tree);
  if (next === tree) return null;
  // Focus moves to the pane that grew into the space.
  const parent = findParent(tree, id)!;
  const sibling = parent.a.id === id ? parent.b : parent.a;
  return { tree: next, focus: firstLeaf(sibling).id };
}

function findParent(node: PaneNode, id: string): Split | null {
  if (node.type === 'leaf') return null;
  if (node.a.id === id || node.b.id === id) return node;
  return findParent(node.a, id) ?? findParent(node.b, id);
}

/** The pane in a direction: neighbours that share an edge span come first, then the nearest. */
export function moveFocus(tiles: Tile[], focusId: string, dir: Side): string {
  const cur = tiles.find((t) => t.leaf.id === focusId);
  if (!cur) return focusId;
  const horiz = dir === 'left' || dir === 'right';
  let best: { id: string; score: number } | null = null;
  for (const t of tiles) {
    if (t === cur) continue;
    const ahead =
      dir === 'left' ? t.x + t.w <= cur.x + 1 : dir === 'right' ? t.x >= cur.x + cur.w - 1 : dir === 'up' ? t.y + t.h <= cur.y + 1 : t.y >= cur.y + cur.h - 1;
    if (!ahead) continue;
    const overlap = horiz ? Math.min(cur.y + cur.h, t.y + t.h) - Math.max(cur.y, t.y) : Math.min(cur.x + cur.w, t.x + t.w) - Math.max(cur.x, t.x);
    const gap = horiz
      ? dir === 'left'
        ? cur.x - (t.x + t.w)
        : t.x - (cur.x + cur.w)
      : dir === 'up'
        ? cur.y - (t.y + t.h)
        : t.y - (cur.y + cur.h);
    const score = (overlap > 0 ? 0 : 100_000) + gap * 10 - Math.max(0, overlap);
    if (!best || score < best.score) best = { id: t.leaf.id, score };
  }
  return best ? best.id : focusId;
}

/** Grows (delta > 0) or shrinks the focused pane against its sibling, within the minimum sizes. */
export function resizeFocused(tree: PaneNode, dividers: Divider[], focusId: string, delta: number): PaneNode {
  const parent = findParent(tree, focusId);
  if (!parent) return tree;
  const inA = parent.a.id === focusId;
  const divider = dividers.find((d) => d.split.id === parent.id);
  const range = divider ? bounds(parent, divider.span) : ([0.15, 0.85] as [number, number]);
  return setRatio(tree, parent.id, clamp(parent.ratio + (inA ? delta : -delta), range));
}

/** The ratio a divider drag lands on, within the minimum sizes. */
export function dragRatio(divider: Divider, pointer: number): number {
  return clamp((pointer - divider.origin) / divider.span, bounds(divider.split, divider.span));
}

/** The first layout: one pane each for up to four agents, the ones that need him first. */
/** The first panes (v3): four agents in a 2x2 grid , three as one beside a column of two, two side by side. */
export function initialTree(runIds: string[]): PaneNode {
  const [a, b, c, d] = runIds;
  const row = (x: PaneNode, y: PaneNode, ratio = 0.5): Split => ({ type: 'split', id: newId('s'), dir: 'row', ratio, a: x, b: y });
  const col = (x: PaneNode, y: PaneNode): Split => ({ type: 'split', id: newId('s'), dir: 'col', ratio: 0.5, a: x, b: y });
  if (a && b && c && d) return col(row(leaf(a), leaf(b)), row(leaf(c), leaf(d)));
  if (a && b && c) return row(leaf(a), col(leaf(b), leaf(c)));
  if (a && b) return row(leaf(a), leaf(b));
  return leaf(a ?? null);
}

/**
 * Where an agent's pane goes: the pane already showing it; else an empty pane; else a new pane beside the
 * focused one if a split fits (the same minimum sizes as Alt n); else it takes over a pane: the one least worth keeping
 * (keep: a finished agent's or an empty one before a working one, and one waiting for him last), focused least recently.
 * focusedAt: when each leaf was last focused (unknown counts as never). Returns the tree, the leaf that shows it, and
 * whether it took that leaf over from another agent.
 */
export function placeRun(
  tree: PaneNode,
  tiles: Tile[],
  runId: string,
  focusId: string,
  focusedAt: Record<string, number>,
  keep: (l: Leaf) => number = () => 0,
): { tree: PaneNode; leafId: string; tookOver?: true } {
  const showing = tiles.find((t) => t.leaf.runId === runId && !t.leaf.stack);
  if (showing) return { tree, leafId: showing.leaf.id };
  const empty = tiles.find((t) => t.leaf.runId === null && !t.leaf.pendingTicket);
  if (empty) return { tree: updateLeaf(tree, empty.leaf.id, { runId }), leafId: empty.leaf.id };
  const focused = tiles.find((t) => t.leaf.id === focusId) ?? tiles[0];
  if (focused) {
    const sides: Side[] = focused.w >= focused.h ? ['right', 'down'] : ['down', 'right'];
    for (const side of sides) {
      const added = leaf(runId);
      const next = split(tree, tiles, focused.leaf.id, side, added);
      if (next) return { tree: next, leafId: added.id };
    }
  }
  const candidates = tiles.length > 1 ? tiles.filter((t) => t.leaf.id !== focusId) : tiles;
  const oldest = [...candidates].sort((a, b) => keep(a.leaf) - keep(b.leaf) || (focusedAt[a.leaf.id] ?? 0) - (focusedAt[b.leaf.id] ?? 0))[0]!;
  return { tree: updateLeaf(tree, oldest.leaf.id, { runId, stack: undefined, pendingTicket: undefined }), leafId: oldest.leaf.id, tookOver: true };
}
