// The sprint map in a slot too small for its full form (P1; screenshots 47 and 50): the same geometry drawn smaller, to fit
// the slot, with the digits of each key in place of the key. Text never scales and nothing overlaps: the circles, rings and
// PR orbits shrink with the map, and each label (the dial's, placed by the same rules) goes beside its dot clear of every
// other dot and label, or is left to the dot's tooltip when there is no clear place.
import { useMemo } from 'react';
import type { WorkspaceState } from '@elfoqsy/state';
import { ciFailing } from '@elfoqsy/state';
import { AgentBadge } from '../../ui/TicketBits';
import { PullRequestGlyph, TypeGlyph, glyphSize } from '../../ui/glyphs';
import { useTips } from '../../ui/layers';
import { statusVar, ticketTooltip } from '../../ui/ticket';
import { agentOn } from '../model';
import { compactScale } from '../../panes/spec';
import { placeDialLabels, type DialDot } from './dialLabels';
import { MAP, MOON, RINGS } from './layout';
import { TicketTip, clusterLabel, useLayout } from './OrbitMap';

/** No circle is drawn smaller than this, so a dot stays something a pointer can land on. */
const MIN_D = 14;

export function CompactMap({ state, onSelect, w, h }: { state: WorkspaceState; onSelect: (key: string) => void; w: number; h: number }) {
  const layout = useLayout(state);
  const tips = useTips();
  const s = compactScale(w, h);
  const W = Math.round(MAP.width * s);
  const H = Math.round(MAP.height * s);
  const dia = (d: number) => Math.max(MIN_D, Math.round(d * s));
  const dots: DialDot[] = useMemo(
    () => [
      ...layout.tickets.map((p) => ({ key: p.key, x: p.x * s, y: p.y * s, d: dia(p.d) })),
      ...(layout.cluster ? [{ key: '+N', x: layout.cluster.x * s, y: layout.cluster.y * s, d: dia(layout.cluster.d), unlabelled: true }] : []),
    ],
    [layout, s],
  );
  // The agents' badges sit on their circles' top right corners; no digits go under them.
  const badges = layout.tickets.filter((p) => agentOn(state, p.key)).map((p) => ({ x: p.x * s + dia(p.d) / 2 - 8, y: p.y * s - dia(p.d) / 2 - 8, w: 16, h: 16 }));
  const labels = useMemo(() => placeDialLabels(dots, { bounds: { x: 0, y: 0, w: W, h: H }, keepOff: badges }), [dots, W, H, JSON.stringify(badges)]);
  const placed = new Map(layout.tickets.map((t) => [t.key, t]));
  return (
    <div className="orbit orbit--compact" style={{ width: W, height: H }}>
      <svg className="orbit-lines" width={W} height={H} aria-hidden="true">
        {Object.values(RINGS).map((r) => (
          <circle key={r} cx={MAP.cx * s} cy={MAP.cy * s} r={r * s} className="ring" />
        ))}
        {layout.links.map(([a, b]) => {
          const p = placed.get(a)!;
          const q = placed.get(b)!;
          return <line key={`${a}-${b}`} x1={p.x * s} y1={p.y * s} x2={q.x * s} y2={q.y * s} className="link" />;
        })}
        {layout.tickets
          .filter((t) => t.moons.length)
          .map((t) => (
            <circle key={t.key} cx={t.x * s} cy={t.y * s} r={MOON.orbit * s} className="moon-orbit" />
          ))}
        {[...labels.values()]
          .filter((l) => l.leader && l.clear)
          .map((l) => (
            <line key={l.key} className="dial-leader" x1={l.leader!.x1} y1={l.leader!.y1} x2={l.leader!.x2} y2={l.leader!.y2} />
          ))}
      </svg>
      <span className="you-dot" style={{ left: MAP.cx * s - 4, top: MAP.cy * s - 4, width: 8, height: 8 }} />
      {layout.tickets.map((p) => {
        const t = state.tickets[p.key]!;
        const run = agentOn(state, t.key);
        const d = dia(p.d);
        const label = labels.get(t.key);
        return (
          <span key={t.key} className="cmap-spot" style={{ left: p.x * s - d / 2, top: p.y * s - d / 2, width: d, height: d }}>
            <button
              type="button"
              {...tips.bind(t.key, () => <TicketTip ticket={t} />)}
              className="ticket-circle cmap-dot"
              aria-label={ticketTooltip(t) + (run ? `, Agent ${run.agentNumber} on it` : '')}
              onClick={() => onSelect(t.key)}
              style={{ width: d, height: d, background: statusVar(t.status) }}
            >
              {d >= 18 && <TypeGlyph type={t.type} size={glyphSize(d)} />}
            </button>
            {run && (
              <span className="cmap-badge">
                <AgentBadge run={run} size={16} />
              </span>
            )}
            {label?.clear && (
              <span className="dial-num" style={{ left: label.x - (p.x * s - d / 2), top: label.y - (p.y * s - d / 2) }} aria-hidden="true">
                {label.text}
              </span>
            )}
          </span>
        );
      })}
      {layout.tickets.flatMap((p) =>
        p.moons.map(({ pr, x, y }) => {
          const m = Math.max(10, Math.round(MOON.size * s));
          return (
            <span
              key={`${pr.repo}#${pr.number}`}
              role="img"
              aria-label={`${pr.repo} #${pr.number}, ${pr.state}, for ${pr.ticket}`}
              tabIndex={-1}
              className={`moon moon--${pr.state}${ciFailing(state, pr) ? ' moon--failing' : ''}`}
              style={{ left: x * s - m / 2, top: y * s - m / 2, width: m, height: m }}
            >
              {m >= 16 && <PullRequestGlyph size={Math.round(m * 0.6)} />}
            </span>
          );
        }),
      )}
      {layout.cluster && (
        <button
          type="button"
          className="ticket-cluster cmap-cluster"
          {...tips.bind('+N', () => <span className="tip-title">{clusterLabel(layout.cluster!)}</span>)}
          aria-label={`${clusterLabel(layout.cluster)}. Opens the first; previous and next step through them all.`}
          onClick={() => onSelect(layout.cluster!.keys[0]!)}
          style={{ left: layout.cluster.x * s - dia(layout.cluster.d) / 2, top: layout.cluster.y * s - dia(layout.cluster.d) / 2, width: dia(layout.cluster.d), height: dia(layout.cluster.d) }}
        >
          +{layout.cluster.keys.length}
        </button>
      )}
      {layout.done.map(({ ticket, x, y, d }) => {
        const dd = Math.max(8, Math.round(d * s));
        return <span key={ticket.key} {...tips.bind(ticket.key, () => <TicketTip ticket={ticket} />)} role="img" aria-label={ticketTooltip(ticket)} className="corner-done" style={{ left: x * s - dd / 2, top: y * s - dd / 2, width: dd, height: dd }} />;
      })}
      {tips.node}
    </div>
  );
}
