// The live map column: the status bar, the canvas, Elfoqsy at the centre (the face of her current
// portrait, her fox badge on its corner), motion control. Hidden, it is a rail that keeps her avatar and a
// dot for each thing waiting on alex or broken.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { runLabel, type StatusItem, type WorkspaceState } from '@elfoqsy/state';
import { StatusBar } from '../../stage/StatusBar';
import { CollapseButton } from '../../ui/CollapseButton';
import { ART, AVATAR, type Look } from '../../ui/elfoqsy';
import { FoxBadge } from '../../ui/FoxBadge';
import { stream } from '../../state/workspace';
import { focusRun } from '../focus';
import { drawMap, hitAt, readPalette, type MapHit, type Palette, type SubSides } from './draw';
import { DEFAULT_HEAD, agentMode, layoutMap, mapScale, type Size } from './layout';
import { useBox } from '../../panes/slot';

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Props {
  state: WorkspaceState;
  items: StatusItem[];
  look: Look;
  now: number;
  statusLines: string[];
  open: boolean;
  lastOpen: boolean;
  onToggle: () => void;
  /** classic: today's column, its status bar and collapse button over the map. free (P2): the screen's top row has the status bar. */
  chrome?: 'classic' | 'free';
}

export function MapColumn({ state, items, look, now, statusLines, open, lastOpen, onToggle, chrome = 'classic' }: Props) {
  const free = chrome === 'free';
  const root = useRef<HTMLElement>(null);
  const box = useBox(root, open);
  // The geometry's scale in this slot (P1): 1 as drawn, less in a smaller one; the core's portrait follows it.
  const k = box ? mapScale(box.w, box.h) : 1;
  const bar = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<Size>(DEFAULT_HEAD);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    // Labels on the map keep clear of the status bar, however wide it is.
    const measure = () => setHead({ w: el.offsetWidth + 24, h: el.offsetTop + el.offsetHeight + 12 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) {
    const waiting = items.find((i) => i.kind === 'waiting');
    const broken = items.find((i) => i.kind === 'broken');
    return (
      <section className="rcol rcol--rail" aria-label="Live map, hidden">
        <CollapseButton cells={2} index={0} shown={false} label="Show the live map" onClick={onToggle} />
        <img className="rail-portrait" src={AVATAR} alt="Elfoqsy" />
        {waiting && <span className="rail-dot rail-dot--waiting" role="img" aria-label={waiting.sentence} data-tip={waiting.sentence} />}
        {broken && <span className="rail-dot rail-dot--broken" role="img" aria-label={broken.sentence} data-tip={broken.sentence} />}
      </section>
    );
  }
  return (
    <section ref={root} className="rcol rcol--map" aria-label="Live map" {...(k < 1 ? { style: { ['--map-k' as string]: k } } : {})}>
      <MapCanvas state={state} head={free ? { w: 0, h: 0 } : head} />
      {!free && (
        <div className="map-status" ref={bar}>
          <StatusBar items={items} now={now} lines={statusLines} />
        </div>
      )}
      <div className="rcol-control">
        <CollapseButton cells={2} index={0} shown label="Hide the live map" disabled={lastOpen} onClick={onToggle} />
      </div>
      <div className="map-core">
        <div className="map-core-face">
          <img src={ART[look.mood].faces[look.variant]} alt={ART[look.mood].alt} />
        </div>
        <FoxBadge mood={look.mood} size={40} />
      </div>
    </section>
  );
}

function MapCanvas({ state, head }: { state: WorkspaceState; head: Size }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [hover, setHover] = useState<MapHit | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const hits = useRef<MapHit[]>([]);
  const sides = useRef<SubSides>(new Map());
  const palette = useRef<Palette | null>(null);
  const clock = useRef({ t: 4, last: 0 });
  const latest = useRef({ state, hover, selected, size, head });
  latest.current = { state, hover, selected, size, head };

  useEffect(() => {
    const el = canvas.current!.parentElement!;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    c.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [size]);

  const draw = useCallback(() => {
    const c = canvas.current;
    const { state, hover, selected, size, head } = latest.current;
    if (!c || !size.w) return;
    palette.current ??= readPalette();
    const layout = layoutMap(state, size.w, size.h, head);
    hits.current = drawMap(c.getContext('2d')!, { layout, state, now: stream.now(), t: clock.current.t, hover, selected, sides: sides.current }, palette.current);
  }, []);

  useEffect(() => {
    void document.fonts.ready.then(() => {
      palette.current = readPalette();
      draw();
    });
  }, [draw]);

  useEffect(() => {
    if (!playing) {
      draw();
      return;
    }
    let frame = requestAnimationFrame(function loop(ts) {
      const c = clock.current;
      if (c.last) c.t += Math.min(0.05, (ts - c.last) / 1000);
      c.last = ts;
      draw();
      frame = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(frame);
      clock.current.last = 0;
    };
  }, [playing, draw]);

  // A still frame whenever something changes while motion is off.
  useEffect(() => {
    if (!playing) draw();
  }, [playing, state, hover, selected, size, head, draw]);

  const toCanvas = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * size.w) / r.width, y: ((e.clientY - r.top) * size.h) / r.height };
  };
  const onMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvas(e);
    const h = hitAt(hits.current, x, y);
    if (h?.label !== hover?.label || h?.x !== hover?.x) setHover(h);
    e.currentTarget.style.cursor = h ? 'pointer' : 'default';
  };
  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvas(e);
    const h = hitAt(hits.current, x, y);
    setSelected(h?.runId && h.kind === 'agent' ? (selected === h.runId ? null : h.runId) : null);
    // Its terminal comes into focus beside the map, opened first if it has no pane.
    if (h?.runId && h.kind === 'agent') focusRun.request(h.runId);
  };

  return (
    <>
      <canvas
        ref={canvas}
        className="map-canvas"
        role="img"
        aria-label={describe(state)}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      />
      {/* Each agent as a button over its circle (v1.3): Tab and Enter focus its terminal as a click does. The canvas still
          takes the mouse, so hover and click work as drawn. */}
      {size.w > 0 &&
        layoutMap(state, size.w, size.h, head).agents.map((a) => (
          <button
            key={a.run.runId}
            type="button"
            className="map-agent"
            style={{ left: a.ax, top: a.ay }}
            data-run={a.run.runId}
            aria-label={`Agent ${a.run.agentNumber} on ${runLabel(a.run)}: show its terminal`}
            onClick={() => focusRun.request(a.run.runId)}
          />
        ))}
      <button type="button" className="map-play" onClick={() => setPlaying((p) => !p)}>
        {playing ? 'Pause' : 'Play'}
      </button>
    </>
  );
}

function describe(state: WorkspaceState): string {
  const layout = layoutMap(state, 1, 1);
  const parts = layout.agents.map((a) => {
    const doing = a.mode === 'waiting' ? 'waiting for you' : a.mode === 'failed' ? 'failed' : a.mode === 'paused' ? 'paused' : 'at work';
    return `Agent ${a.run.agentNumber} on ${runLabel(a.run)}, ${doing}`;
  });
  if (layout.cluster) parts.push(`${layout.cluster.runs.length} more agents`);
  return `Live map: Elfoqsy in the centre${parts.length ? `; ${parts.join('; ')}` : ', no agents'}.`;
}
