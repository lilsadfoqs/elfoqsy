// The + at the edge of a pane (P2): one, in the gap at the middle of the edge nearest the pointer (at the top edge, right of the
// grip), which opens a menu of the panes that are not on this screen. Choosing one puts it on that side of the pane, as a drop
// there would. The menu is a floating layer: one at a time, it closes on a click outside and on Escape.
import { PANES, PANE_IDS, fits, placeBeside, screenOf, type Layout, type PaneId, type Side } from '@elfoqsy/state';
import { stream } from '../state/workspace';
import { Floating, refTo, useLayer } from '../ui/layers';
import { folds } from './folds';
import { PaneIcon } from './icons';

export interface PlusAt {
  pane: PaneId;
  side: Side;
  /** The top left of the 26 px circle, in the stage's pixels. */
  x: number;
  y: number;
}

/** "Add above Sprint", "Add to the left of Elfoqsy". */
const title = (side: Side, anchor: PaneId): string => `Add ${side === 'left' || side === 'right' ? `to the ${side} of` : side} ${PANES[anchor].name}`;

export function AddPlus({ at, screen, layout, onOpen, onClosed }: { at: PlusAt; screen: 0 | 1; layout: Layout; onOpen: () => void; onClosed: () => void }) {
  const menu = useLayer('menu', { onClose: onClosed });
  // Every pane that is not on this screen: those on the other one (they move), and those taken off the screens (they come back).
  const offered = PANE_IDS.filter((p) => screenOf(layout, p) !== screen).map((pane) => {
    const after = placeBeside(layout, at.pane, at.side, pane);
    const ok = !!after && fits(after);
    const note = !ok ? 'no room' : screenOf(layout, pane) === null ? 'not on a screen' : 'moves from the other screen';
    return { pane, after, ok, note };
  });
  const label = `Add a pane ${at.side === 'left' || at.side === 'right' ? `to the ${at.side} of` : at.side} ${PANES[at.pane].name}`;
  return (
    <>
      <button
        type="button"
        className="fplus"
        data-plus={`${at.pane}:${at.side}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        ref={refTo(menu.anchor)}
        style={{ left: at.x, top: at.y }}
        onClick={() => {
          onOpen();
          menu.toggle();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gray-950)" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <Floating layer={menu} side="bottom" align="start" gap={6} className="addmenu" role="menu" aria-label={label}>
        <span className="addmenu-title">{title(at.side, at.pane)}</span>
        {offered.map(({ pane, after, ok, note }) => (
          <button
            key={pane}
            type="button"
            role="menuitem"
            className="addmenu-item"
            disabled={!ok}
            onClick={() => {
              if (!after) return;
              folds.unfold(pane);
              stream.setLayout(after);
              menu.hide(true);
              onClosed();
            }}
          >
            <PaneIcon pane={pane} />
            <span className="addmenu-name">{PANES[pane].name}</span>
            <span className="addmenu-note">{note}</span>
          </button>
        ))}
        {offered.length === 0 && <span className="addmenu-none">Every pane is on this screen</span>}
      </Floating>
    </>
  );
}
