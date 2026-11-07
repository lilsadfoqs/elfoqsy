// Floating layers (docs/ui-spec.md "Floating layers"): the grown dial, tooltips, menus and panels, and the
// search dialog. One is open at a time: opening one closes the others, but the layers it sits in (a dot's title stays
// with the grown dial). Each closes on a click outside it and on Escape (the top one first), Escape giving focus back
// to where it came from. They stack in a fixed order from design/tokens.css, are drawn in one root on the stage, and
// are placed by place beside their anchor: flipped or shifted to stay on screen and off the other open layers.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { place, SCREEN, stageRect, type Rect, type Side } from './place';

export type LayerKind = 'dial' | 'tooltip' | 'menu' | 'search';
/** Bottom to top, as the --z-* tokens. */
export const LAYER_ORDER: LayerKind[] = ['dial', 'tooltip', 'menu', 'search'];

interface Entry {
  id: string;
  kind: LayerKind;
  parent?: string;
  /** What belongs to it: a click on any of these is not outside it. */
  parts: () => Array<Element | null | undefined>;
  returnTo: HTMLElement | null;
  onClose: () => void;
  seq: number;
}

const open = new Map<string, Entry>();
const listeners = new Set<() => void>();
let seq = 0;
const emit = () => listeners.forEach((l) => l());

const chain = (id: string | undefined): string[] => {
  const out: string[] = [];
  for (let at = id; at && open.has(at); at = open.get(at)!.parent) out.push(at);
  return out;
};
const rank = (e: Entry) => LAYER_ORDER.indexOf(e.kind) * 1e6 + e.seq;
/** Open layers, top first. */
export const openLayers = (): Entry[] => [...open.values()].sort((a, b) => rank(b) - rank(a));

function close(id: string, restore: boolean): void {
  const e = open.get(id);
  if (!e) return;
  // Its own layers go with it.
  for (const child of [...open.values()].filter((c) => c.parent === id)) close(child.id, false);
  open.delete(id);
  e.onClose();
  emit();
  if (restore && e.returnTo?.isConnected) e.returnTo.focus({ preventScroll: true });
}

function show(entry: Omit<Entry, 'seq' | 'returnTo'>): void {
  if (open.has(entry.id)) return;
  const keep = new Set([entry.id, ...chain(entry.parent)]);
  // A tooltip never closes a menu, panel or dialog: while one is open, only the tooltips inside it show, so moving the
  // pointer across the screen cannot shut what he opened.
  if (entry.kind === 'tooltip' && [...open.values()].some((o) => (o.kind === 'menu' || o.kind === 'search') && !keep.has(o.id))) return;
  for (const other of openLayers()) if (!keep.has(other.id) && open.has(other.id)) close(other.id, false);
  const active = document.activeElement;
  open.set(entry.id, { ...entry, seq: ++seq, returnTo: active instanceof HTMLElement && active !== document.body ? active : null });
  emit();
}

const within = (e: Entry, target: Node): boolean =>
  e.parts().some((p) => p?.contains(target)) || [...open.values()].some((c) => c.parent === e.id && within(c, target));

let installed = false;
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Escape closes the top layer only, before anything else hears it (the ticket view's Escape, an editor's Cancel).
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape' || !open.size) return;
      ev.preventDefault();
      ev.stopPropagation();
      close(openLayers()[0]!.id, true);
    },
    true,
  );
  // A press outside a layer closes it; focus goes where he pressed.
  document.addEventListener(
    'pointerdown',
    (ev) => {
      const target = ev.target as Node;
      for (const e of openLayers()) if (open.has(e.id) && !within(e, target)) close(e.id, false);
    },
    true,
  );
}

export interface Layer {
  id: string;
  kind: LayerKind;
  parent?: string;
  open: boolean;
  /** extra: more of it, such as the element that opened it (it is not "outside"). */
  show: () => void;
  hide: (restoreFocus?: boolean) => void;
  toggle: () => void;
  anchor: RefObject<HTMLElement | null>;
  floating: RefObject<HTMLElement | null>;
}

export function useLayer(kind: LayerKind, o: { parent?: string; onClose?: () => void; parts?: () => Array<Element | null | undefined> } = {}): Layer {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const floating = useRef<HTMLElement | null>(null);
  const latest = useRef(o);
  latest.current = o;
  install();
  const isOpen = useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => open.has(id),
    () => false,
  );
  useEffect(() => () => close(id, false), [id]);
  const entry = () => ({
    id,
    kind,
    ...(latest.current.parent ? { parent: latest.current.parent } : {}),
    parts: () => [anchor.current, floating.current, ...(latest.current.parts?.() ?? [])],
    onClose: () => latest.current.onClose?.(),
  });
  return {
    id,
    kind,
    ...(o.parent ? { parent: o.parent } : {}),
    open: isOpen,
    show: () => show(entry()),
    hide: (restoreFocus = false) => close(id, restoreFocus),
    toggle: () => (open.has(id) ? close(id, true) : show(entry())),
    anchor,
    floating,
  };
}

/** A callback ref that fills a layer's anchor (or any ref) with an element of any kind. */
export const refTo =
  (r: RefObject<HTMLElement | null>) =>
  (el: HTMLElement | null): void => {
    r.current = el;
  };

/** The stage's root for floating layers (stage/Stage.tsx): one stacking order for them all. */
export const LayerRoot = createContext<HTMLElement | null>(null);

/** The other open layers' boxes, to keep off; not the ones this sits in. */
function others(layer: Layer): Rect[] {
  const mine = new Set([layer.id, ...chain(layer.parent)]);
  return openLayers()
    .filter((e) => !mine.has(e.id) && e.parent !== layer.id)
    .flatMap((e) => {
      const el = document.querySelector(`[data-layer-id="${CSS.escape(e.id)}"]`);
      return el ? [stageRect(el)] : [];
    });
}

/**
 * A floating layer, drawn in the stage's layer root while it is open, beside its anchor (or the rect given), within the
 * bounds (the screen by default). Hidden until placed, so it never shows where it does not belong.
 */
export function Floating({
  layer,
  side = 'bottom',
  align = 'start',
  gap = 6,
  at,
  placeKey,
  modal,
  bounds,
  className,
  style,
  children,
  ...aria
}: {
  layer: Layer;
  side?: Side;
  align?: 'start' | 'center' | 'end';
  gap?: number;
  /** The anchor's box, when it is not layer.anchor (a caret, a dot). */
  at?: () => Rect | null;
  /** Placed again when this changes (the same tooltip moving to another dot). */
  placeKey?: string | number | null;
  /** A dialog: centred on the screen near its top, over a dimmed backdrop that closes it when pressed. */
  modal?: boolean;
  bounds?: () => Rect;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  role?: string;
  id?: string;
  'aria-label'?: string;
  onMouseDown?: (e: React.MouseEvent) => void;
}) {
  const root = useContext(LayerRoot);
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null);
  useLayoutEffect(() => {
    if (!layer.open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = layer.floating.current;
      if (el && modal) {
        const x = Math.round((SCREEN.w - el.offsetWidth) / 2);
        const y = Math.max(8, Math.min(Math.round(SCREEN.h * 0.16), SCREEN.h - 8 - el.offsetHeight));
        setPos((old) => (old && old.x === x && old.y === y ? old : { x, y, side: 'bottom' }));
        return;
      }
      const anchorRect = at?.() ?? (layer.anchor.current ? stageRect(layer.anchor.current) : null);
      if (!el || !anchorRect) return;
      const p = place(anchorRect, { w: el.offsetWidth, h: el.offsetHeight }, { side, align, gap, bounds: bounds?.() ?? SCREEN, avoid: others(layer) });
      setPos((old) => (old && old.x === p.x && old.y === p.y && old.side === p.side ? old : { x: p.x, y: p.y, side: p.side }));
    };
    update();
    const ro = new ResizeObserver(update);
    if (layer.floating.current) ro.observe(layer.floating.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [layer.open, placeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!layer.open) return null;
  const node = (
    <div
      {...aria}
      ref={(el) => {
        layer.floating.current = el;
      }}
      className={`layer layer--${layer.kind}${className ? ` ${className}` : ''}`}
      data-layer={layer.kind}
      data-layer-id={layer.id}
      {...(layer.parent ? { 'data-layer-parent': layer.parent } : {})}
      {...(pos ? { 'data-side': pos.side } : {})}
      style={{ ...style, position: 'fixed', left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  );
  const drawn = modal ? (
    <>
      <div className="layer-backdrop" aria-hidden="true" />
      {node}
    </>
  ) : (
    node
  );
  return root ? createPortal(drawn, root) : drawn;
}

/**
 * Tooltips for many anchors that share one layer (the dots of the dial, the tickets of the map): bind each anchor,
 * and draw node once. Hover or keyboard focus shows it beside that anchor; leaving or blurring hides it.
 */
export function useTips(o: { parent?: string; side?: Side; className?: string } = {}) {
  const [current, setCurrent] = useState<{ id: string; content: ReactNode; side?: Side } | null>(null);
  const anchors = useRef(new Map<string, Element>());
  const layer = useLayer('tooltip', { ...(o.parent ? { parent: o.parent } : {}), onClose: () => setCurrent(null) });
  const open = (id: string, content: () => ReactNode, side?: Side) => {
    setCurrent({ id, content: content(), ...(side ? { side } : {}) });
    layer.show();
  };
  const bind = (id: string, content: () => ReactNode, side?: Side) => ({
    ref: (el: Element | null) => {
      if (el) anchors.current.set(id, el);
      else anchors.current.delete(id);
    },
    onMouseEnter: () => open(id, content, side),
    onMouseLeave: () => layer.hide(),
    onFocus: (e: React.FocusEvent) => e.currentTarget.matches(':focus-visible') && open(id, content, side),
    onBlur: () => layer.hide(),
  });
  const node = (
    <Floating
      layer={layer}
      side={current?.side ?? o.side ?? 'right'}
      gap={8}
      placeKey={current?.id ?? null}
      at={() => {
        const el = current ? anchors.current.get(current.id) : undefined;
        return el ? stageRect(el) : null;
      }}
      className={`tip${o.className ? ` ${o.className}` : ''}`}
      role="tooltip"
    >
      {current?.content}
    </Floating>
  );
  return { bind, node, layer, current: current?.id ?? null };
}

/**
 * The browser's own tooltips, replaced (his answer 5): any element with data-tip="…" shows that text in a
 * tooltip layer, under the same rules as every other layer, on hover, or on keyboard focus (not in a text field, where
 * it would sit over what he types). A press anywhere hides it, as the browser's did. One per stage.
 */
export function DataTips() {
  const [current, setCurrent] = useState<{ el: HTMLElement; text: string; parent?: string; n: number } | null>(null);
  const latest = useRef(current);
  latest.current = current;
  const seq = useRef(0);
  const host = useRef<HTMLSpanElement>(null);
  const layer = useLayer('tooltip', { ...(current?.parent ? { parent: current.parent } : {}), onClose: () => setCurrent(null), parts: () => [latest.current?.el] });
  const hide = useRef(layer.hide);
  hide.current = layer.hide;
  // Shown once the state that names its anchor (and the layer it sits in) is in place.
  useEffect(() => {
    if (current) layer.show();
  }, [current?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const stage = host.current?.closest('.stage');
    if (!stage) return;
    const tipOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null);
    const point = (el: HTMLElement | null) => {
      const now = latest.current;
      if (el === now?.el && el?.isConnected) return;
      if (now) hide.current();
      const text = el?.dataset.tip;
      if (el && text) setCurrent({ el, text, ...(el.closest('[data-layer-id]') ? { parent: el.closest('[data-layer-id]')!.getAttribute('data-layer-id')! } : {}), n: ++seq.current });
    };
    const over = (e: Event) => point(tipOf(e.target));
    const focus = (e: Event) => {
      const el = tipOf(e.target);
      if (el && el === e.target && el.matches(':focus-visible') && !el.matches('input, textarea, [contenteditable="true"]')) point(el);
    };
    const blur = (e: Event) => {
      if (latest.current && latest.current.el.contains(e.target as Node)) hide.current();
    };
    const press = () => hide.current();
    const leave = () => hide.current();
    stage.addEventListener('mouseover', over);
    stage.addEventListener('focusin', focus);
    stage.addEventListener('focusout', blur);
    stage.addEventListener('pointerdown', press, true);
    stage.addEventListener('mouseleave', leave);
    return () => {
      stage.removeEventListener('mouseover', over);
      stage.removeEventListener('focusin', focus);
      stage.removeEventListener('focusout', blur);
      stage.removeEventListener('pointerdown', press, true);
      stage.removeEventListener('mouseleave', leave);
    };
  }, []);
  return (
    <>
      <span ref={host} hidden />
      <Floating
        layer={layer}
        side="bottom"
        align="start"
        gap={8}
        placeKey={current?.n ?? null}
        at={() => (current?.el.isConnected ? stageRect(current.el) : null)}
        className="tip tip--text"
        role="tooltip"
      >
        <span className="tip-title">{current?.text}</span>
      </Floating>
    </>
  );
}

