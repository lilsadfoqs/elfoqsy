// A screen as the layout says (P2): the top row (the status cluster at the left, the screen menu at the right) and the
// panes in the rectangles the layout engine gives them, 40 px from the sides and 20 px apart. While a pane is dragged this
// shows what the drop would give: the moved pane leaves its place, a skeleton of it at its real size is where it would
// land, and the others make room. The skeleton is only drawn: it takes no pointer, so it never blocks a click.
import { useEffect, useMemo, useState } from 'react';
import { PANES, PANE_IDS, addToScreen, arrange, bringHere, moveToOtherScreen, removedPanes, screenOf, statusItems, statusLines, without, type Layout, type PaneId, type WorkspaceState } from '@elfoqsy/state';
import type { Connection } from '../state/stream';
import { stream } from '../state/workspace';
import { StatusBar } from '../stage/StatusBar';
import { PaneArrangementContext } from '../ui/arrangement';
import { lookOf } from '../ui/elfoqsy';
import { Floating, refTo, useLayer } from '../ui/layers';
import { useNow } from '../ui/useNow';
import type { Preview } from './arrange';
import { FreePane, type PaneFold, type PaneHost } from './FreePane';
import { folds, useFolds } from './folds';
import { PaneSlot } from './slot';

const SCREEN_NAME = ['left', 'right'] as const;
/** What the x says it removes. */
export const REMOVES: Record<PaneId, string> = { sprint: 'the sprint', elfoqsy: 'Elfoqsy', conversation: 'the conversation', map: 'the live map', terminals: 'the agent terminals' };

interface Props {
  screen: 0 | 1;
  state: WorkspaceState;
  connection: Connection;
  /** The layout saved, or today's when none is. */
  current: Layout;
  /** The pane being dragged, and what its drop would give on this screen. */
  dragged: PaneId | null;
  preview: Preview | null;
}

export function FreeScreen({ screen, state, connection, current, dragged, preview }: Props) {
  const now = useNow();
  // Terminals lay out once the log has been replayed, and keep their layout through reconnects.
  const [ready, setReady] = useState(connection.status === 'live');
  useEffect(() => {
    if (connection.status === 'live') setReady(true);
  }, [connection.status]);

  // What this window has folded (today's hide buttons). A pane not on this screen is not folded here; the pane in the hand is
  // shown open, so that its skeleton is its real size and the drop gives exactly that.
  const folded = useFolds();
  useEffect(() => folds.keepOnly(current[screen].flat()), [current, screen]);
  const foldedNow = useMemo(() => (dragged && folded.has(dragged) ? new Set([...folded].filter((p) => p !== dragged)) : folded), [folded, dragged]);

  // What is drawn: the layout the drop would give; else the layout without the pane in the hand (its place is closed up,
  // so the zones the pointer reads are the panes as they are shown); else the layout as it is.
  const shown: Layout = preview ? preview.layout : dragged ? without(current, dragged) : current;
  const rects = arrange(shown[screen], foldedNow).rects;
  const places = arrange(current[screen], folded).rects;
  // A pane stays mounted while it is lifted (so it keeps what it shows), drawn nowhere.
  // In a fixed order, so a layout change moves a pane's box and never its place among the others in the page.
  const there = new Set([...current[screen].flat(), ...shown[screen].flat()]);
  const ids = PANE_IDS.filter((id) => there.has(id));

  const host: PaneHost = useMemo(
    () => ({ state, items: statusItems(state), now, statusLines: statusLines(state, connection.offlineSince), jiraSite: connection.jiraSite, look: lookOf(state, now), ready, notice: connection.notice }),
    [state, now, connection.offlineSince, connection.jiraSite, connection.notice, ready],
  );
  const empty = shown[screen].length === 0 && !(preview && dragged);

  return (
    <div className="screen screen--free" data-screen={SCREEN_NAME[screen]}>
      <div className="ftop">
        <StatusBar items={host.items} now={now} lines={host.statusLines} />
        <ScreenMenu screen={screen} layout={current} saved={state.layout !== null} />
      </div>
      {ids.map((id) => {
        const lifted = id === dragged;
        const rect = lifted ? places[id] : rects[id];
        if (!rect) return null;
        const isFolded = folded.has(id);
        // What is saved always fits with everything open, so a folded pane can always be opened again.
        const unfold = () => folds.unfold(id);
        const fold: PaneFold = { open: !isFolded, shape: rect.fold ?? null, toggle: () => (isFolded ? unfold() : folds.fold(id)), unfold };
        const remove = () => {
          folds.unfold(id);
          stream.setLayout(without(current, id));
        };
        const columns = shown[screen].map((column) => column.map((pane) => ({ pane, folded: foldedNow.has(pane) })));
        return (
          <div
            key={id}
            className="fpane"
            data-fpane={id}
            {...(rect.fold ? { 'data-fold': rect.fold } : {})}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, ...(lifted ? { visibility: 'hidden', pointerEvents: 'none' } : {}) }}
          >
            <PaneArrangementContext.Provider value={{ pane: id, name: REMOVES[id], columns, ...(isFolded ? {} : { remove }) }}>
              <PaneSlot pane={id}>
                <FreePane id={id} host={host} fold={fold} />
              </PaneSlot>
            </PaneArrangementContext.Provider>
          </div>
        );
      })}
      {preview && dragged && rects[dragged] && <Skeleton pane={dragged} rect={rects[dragged]} />}
      {empty && <EmptyScreen screen={screen} current={current} />}
    </div>
  );
}

/** Where the moved pane would land, at its real size: its name and the shape of a panel, nothing it could be clicked on. */
function Skeleton({ pane, rect }: { pane: PaneId; rect: { x: number; y: number; w: number; h: number } }) {
  return (
    <div className="fskel" data-skeleton={pane} aria-hidden="true" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <b>{PANES[pane].name}</b>
      <i className="fskel-bar fskel-bar--title" />
      <i className="fskel-bar" />
      <i className="fskel-bar fskel-bar--short" />
      <i className="fskel-block" />
      <i className="fskel-bar" />
      <i className="fskel-bar fskel-bar--short" />
      <i className="fskel-foot" />
    </div>
  );
}

/** A screen with no pane: the other screen's panes as buttons, and a drop anywhere. */
function EmptyScreen({ screen, current }: { screen: 0 | 1; current: Layout }) {
  // Every pane that is not on this screen: those on the other one, and those taken off the screens.
  const here = current[screen].flat();
  return (
    <div className="fempty" data-empty-screen>
      <p className="fempty-title">Nothing on this screen</p>
      <div className="fempty-panes">
        {PANE_IDS.filter((p) => !here.includes(p)).map((p) => (
          <button key={p} type="button" className="fempty-pane" onClick={() => stream.setLayout(bringHere(current, p, screen))}>
            {PANES[p].name}
          </button>
        ))}
      </div>
      <p className="fempty-hint">Bring a pane here, or drag one over from the other screen.</p>
    </div>
  );
}

/** The ⋯ at the top right: move a pane of this screen to the other one, or reset the layout. A floating layer (a menu). */
function ScreenMenu({ screen, layout, saved }: { screen: 0 | 1; layout: Layout; saved: boolean }) {
  const menu = useLayer('menu');
  const other = SCREEN_NAME[screen === 0 ? 1 : 0];
  const act = (fn: () => void) => () => {
    menu.hide(true);
    fn();
  };
  return (
    <span className="fmenu">
      <button
        type="button"
        className="fmenu-button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label="This screen: move panes, reset the layout"
        ref={refTo(menu.anchor)}
        onClick={() => menu.toggle()}
      >
        ⋯
      </button>
      <Floating layer={menu} side="bottom" align="end" gap={4} className="pmenu fmenu-list" role="menu" aria-label="This screen">
        {layout[screen].flat().map((pane) => {
          const moved = moveToOtherScreen(layout, pane);
          return (
            <button key={pane} type="button" role="menuitem" disabled={!moved} onClick={act(() => moved && stream.setLayout(moved))}>
              Move {PANES[pane].name} to the {other} screen
            </button>
          );
        })}
        {removedPanes(layout).map((pane) => {
          const added = addToScreen(layout, pane, screen);
          return (
            <button key={pane} type="button" role="menuitem" disabled={!added} onClick={act(() => added && stream.setLayout(added))}>
              Add {PANES[pane].name} to this screen
            </button>
          );
        })}
        <button type="button" role="menuitem" disabled={!saved} onClick={act(() => { folds.reset(); stream.setLayout(null); })}>
          Reset the layout
        </button>
      </Floating>
    </span>
  );
}
