// A pane's slot (P1): the box a pane fills, measured, and offered to the pane through a context. A pane never asks the
// screen how big it is; it asks its slot. The box is a size container for the CSS container queries a form uses, and a
// ResizeObserver tells the pane the same numbers for the forms that change its structure. Text never scales: a slot's
// size changes geometry and which form shows, nothing else.
import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface SlotBox {
  w: number;
  h: number;
}

/** What a classic (today's) wide slot is, for a pane rendered with no slot around it. */
const NO_SLOT: SlotBox = { w: 1920, h: 1080 };
const SlotContext = createContext<SlotBox | null>(null);

/** The slot a pane is in, in layout pixels (the stage's scale does not change them). */
export const usePaneSlot = (): SlotBox => useContext(SlotContext) ?? NO_SLOT;

/** The measured size of an element, kept up to date; measured before the first paint so a form never flashes. */
export function useBox(ref: React.RefObject<HTMLElement | null>, dep?: unknown): SlotBox | null {
  const [box, setBox] = useState<SlotBox | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b && b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, dep]);
  return box;
}

/**
 * The box a pane fills. It takes the size its parent gives it (the classic columns' flex, or the layout's rectangle) and
 * hands the measured size to what is inside, which renders once it is known.
 */
export function PaneSlot({ pane, className, style, children }: { pane: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useBox(ref);
  return (
    <div ref={ref} className={className ? `slot ${className}` : 'slot'} data-pane={pane} style={style}>
      {box && <SlotContext.Provider value={box}>{children}</SlotContext.Provider>}
    </div>
  );
}
