// The size lab (P1): one pane in a box of the size the address names, as it would be in a slot of that size, for checking
// each form at the thresholds and between them. /panes?pane=sprint&w=500&h=620. The corner drags the box to another size,
// as the prototypes' do. Nothing here is a screen; it only mounts the pane the screens mount.
import { useRef, useState, type PointerEvent } from 'react';
import { statusItems, statusLines } from '@elfoqsy/state';
import { useWorkspace } from '../state/workspace';
import { Stage } from '../stage/Stage';
import { lookOf } from '../ui/elfoqsy';
import { useNow } from '../ui/useNow';
import { FreePane } from './FreePane';
import { PaneSlot } from './slot';
import { PANES, PANE_IDS, formName, type PaneId } from './spec';

export function Lab() {
  const { state, connection } = useWorkspace();
  const now = useNow();
  const q = new URLSearchParams(location.search);
  const pane = (PANE_IDS as readonly string[]).includes(q.get('pane') ?? '') ? (q.get('pane') as PaneId) : 'sprint';
  const [size, setSize] = useState({ w: Math.max(100, Number(q.get('w')) || 840), h: Math.max(100, Number(q.get('h')) || 972) });
  const drag = useRef<{ x: number; y: number; w: number; h: number; k: number } | null>(null);
  const grip = (e: PointerEvent<HTMLButtonElement>) => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h, k: stage.width / 1920 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setSize({ w: Math.round(Math.max(100, Math.min(1840, d.w + (e.clientX - d.x) / d.k))), h: Math.round(Math.max(100, Math.min(972, d.h + (e.clientY - d.y) / d.k))) });
  };
  return (
    <Stage label="Pane lab" offline={connection.offlineSince !== null}>
      <div className="screen lab" data-pane-lab={pane}>
        <p className="lab-readout" aria-live="off">
          <b>{PANES[pane].name}</b> <span className="lab-form">{formName(pane, size.w, size.h)}</span> <span className="lab-size">{size.w} × {size.h}</span>
        </p>
        <div className="lab-box" style={{ width: size.w, height: size.h }}>
          <PaneSlot pane={pane}>
            <FreePane
              id={pane}
              host={{
                state,
                items: statusItems(state),
                now,
                statusLines: statusLines(state, connection.offlineSince),
                jiraSite: connection.jiraSite,
                look: lookOf(state, now),
                ready: connection.status === 'live',
                notice: connection.notice,
              }}
            />
          </PaneSlot>
          <button type="button" className="lab-grip" aria-label="Drag to resize the box" onPointerDown={grip} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)} />
        </div>
      </div>
    </Stage>
  );
}
