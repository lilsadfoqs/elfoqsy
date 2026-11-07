// Click to edit, select to read. A field enters edit mode only on a plain click: not at the end of a drag, not
// on a double or triple click, not when the click leaves text selected, and not on a link or control inside it (that
// opens the link). So a click waits as long as a double click takes before it counts; Enter or Space on the focused
// field edits at once.
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';

/** How long a click waits for a second one before it counts as plain: a slow double click (desktop defaults are
 * 400 to 500 ms) must not open the editor on its first press. */
export const CLICK_SETTLE_MS = 450;
/** A press that moves farther than this before release is a drag. */
export const DRAG_PX = 4;

/** Whether a click is one that edits: one press, held still, on the field itself, leaving no selection. */
export function isPlainClick(c: { detail: number; button: number; moved: number; onControl: boolean; selected: boolean }): boolean {
  return c.button === 0 && c.detail === 1 && c.moved <= DRAG_PX && !c.onControl && !c.selected;
}

/** Text selected inside this element. */
const selectedIn = (el: Element): boolean => {
  const s = typeof window === 'undefined' ? null : window.getSelection();
  if (!s || s.isCollapsed || !s.toString().trim()) return false;
  return el.contains(s.anchorNode) || el.contains(s.focusNode);
};

/** A link or control inside the field (not the field itself): it does its own thing. */
const onControl = (target: EventTarget | null, field: Element): boolean => {
  const hit = target instanceof Element ? target.closest('a, button, input, select, textarea, summary, label, [role="button"]') : null;
  return !!hit && hit !== field && field.contains(hit);
};

/** Handlers for a field that edits on a plain click: spread them on the element that shows its value. */
export function usePlainClick(activate: () => void, enabled = true) {
  const down = useRef<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(activate);
  latest.current = activate;
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!enabled) return {};
  return {
    role: 'button',
    tabIndex: 0,
    onMouseDown: (e: MouseEvent) => {
      down.current = { x: e.clientX, y: e.clientY };
      // The second press of a double click: the first click no longer counts.
      if (e.detail > 1) clearTimeout(timer.current);
    },
    onClick: (e: MouseEvent) => {
      clearTimeout(timer.current);
      const field = e.currentTarget;
      const moved = down.current ? Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) : 0;
      // A selection is judged when the wait is over: a click inside an old selection clears it only after this event.
      if (!isPlainClick({ detail: e.detail, button: e.button, moved, onControl: onControl(e.target, field), selected: false })) return;
      // Wait out a double click, then check that the click left nothing selected.
      timer.current = setTimeout(() => {
        if (!selectedIn(field)) latest.current();
      }, CLICK_SETTLE_MS);
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      latest.current();
    },
  };
}
