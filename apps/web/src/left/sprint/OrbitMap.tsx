// The sprint as an orbit map: priority rings around "you", one circle per open ticket (size by points,
// fill by Jira status, type glyph inside, the agent's numbered badge on it), PR moons, dashed links
// between boards, and done tickets as green dots. Cancelled work is not shown anywhere. Crowded, the
// least important tickets group into one +N node and labels without room show on hover.
// The same geometry drawn at 42% is the dial of the ticket view.
import { useMemo, type ReactNode } from 'react';
import type { Ticket } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import { ciFailing, isDone, isOpen, isWaiting, recentChange } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { AgentBadge } from '../../ui/TicketBits';
import { PullRequestGlyph, TypeGlyph, glyphSize } from '../../ui/glyphs';
import { pointsText, statusVar, ticketTooltip } from '../../ui/ticket';
import { useLayer, useTips } from '../../ui/layers';
import { agentOn } from '../model';
import { DIAL_DOT, DIAL_SCALE, DIAL_SIZE, dialDots, dialLabels, toDial } from './dialLabels';
import { LABEL, MAP, MOON, RINGS, RING_LABEL_OFFSET, YOU_DOT, layoutOrbit, type AgentMark, type TicketCluster } from './layout';

interface Props {
  state: WorkspaceState;
  onSelect: (key: string) => void;
}

/** Tickets with an agent on them, and whether it waits for alex: they keep their place first. */
function agentMarks(state: WorkspaceState): Record<string, AgentMark> {
  const marks: Record<string, AgentMark> = {};
  for (const t of Object.values(state.tickets)) {
    const run = agentOn(state, t.key);
    if (run) marks[t.key] = isWaiting(state, run) ? 'waiting' : 'working';
  }
  return marks;
}

export function useLayout(state: WorkspaceState) {
  const marks = agentMarks(state);
  const markKey = JSON.stringify(marks);
  return useMemo(() => {
    const tickets = Object.values(state.tickets);
    return layoutOrbit(tickets.filter(isOpen), Object.values(state.prs), { done: tickets.filter(isDone), cancelled: [] }, marks);
    // Recompute only when tickets, PRs or agents' marks change, not on every agent event.
  }, [state.tickets, state.prs, markKey]);
}

export const clusterLabel = (c: TicketCluster) => `${c.keys.length} more tickets: ${c.keys.join(', ')}`;

function Rings({ scale = 1 }: { scale?: number }) {
  return (
    <>
      {Object.values(RINGS).map((r) => (
        <circle key={r} cx={MAP.cx * scale} cy={MAP.cy * scale} r={r * scale} className="ring" />
      ))}
    </>
  );
}

/** A ticket's tooltip: key, title, workflow status and points. */
export function TicketTip({ ticket: t }: { ticket: Ticket }) {
  return (
    <>
      <span className="tip-key">{t.key}</span>
      <span className="tip-title">{t.summary}</span>
      <span className="tip-meta">
        {t.workflowStatus?.name ?? t.status}, {pointsText(t.storyPoints)}
      </span>
    </>
  );
}

export function OrbitMap({ state, onSelect }: Props) {
  const layout = useLayout(state);
  const placed = new Map(layout.tickets.map((t) => [t.key, t]));
  const tips = useTips();

  return (
    <div className="orbit" style={{ width: MAP.width, height: MAP.height }}>
      <svg className="orbit-lines" width={MAP.width} height={MAP.height} aria-hidden="true">
        <Rings />
        {layout.links.map(([a, b]) => {
          const p = placed.get(a)!;
          const q = placed.get(b)!;
          return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="link" />;
        })}
        {layout.tickets
          .filter((t) => t.moons.length)
          .map((t) => (
            <circle key={t.key} cx={t.x} cy={t.y} r={MOON.orbit} className="moon-orbit" />
          ))}
      </svg>

      {Object.entries(RINGS).map(([name, r]) => (
        <span key={name} className="ring-label" style={{ left: MAP.cx + r + RING_LABEL_OFFSET, top: MAP.cy }}>
          {name}
        </span>
      ))}
      <span className="you-dot" style={{ left: MAP.cx - YOU_DOT / 2, top: MAP.cy - YOU_DOT / 2, width: YOU_DOT, height: YOU_DOT }} />
      <span className="you-label" style={{ right: MAP.width - MAP.cx + YOU_DOT / 2 + 4, top: MAP.cy }}>
        you
      </span>

      {layout.tickets.map((p) => {
        const t = state.tickets[p.key]!;
        const run = agentOn(state, t.key);
        const h = Math.max(p.d, LABEL.height);
        const label = `${t.key}, ${t.type}, ${t.workflowStatus?.name ?? t.status}, ${pointsText(t.storyPoints)}${run ? `, Agent ${run.agentNumber} on it` : ''}`;
        // A left label puts the button's right edge at the circle's, so the circle stays where it was placed.
        const at = p.label === 'left' ? { right: MAP.width - (p.x + p.d / 2) } : { left: p.x - p.d / 2 };
        return (
          <button
            key={p.key}
            type="button"
            {...tips.bind(t.key, () => <TicketTip ticket={t} />)}
            className={`ticket ticket--label-${p.label}`}
            onClick={() => onSelect(t.key)}
            style={{ ...at, top: p.y - h / 2, height: h }}
          >
            <span role="img" aria-label={label} className="ticket-circle" style={{ width: p.d, height: p.d, background: statusVar(t.status) }}>
              <TypeGlyph type={t.type} size={glyphSize(p.d)} />
              {run && (
                <span className="ticket-badge">
                  <AgentBadge run={run} />
                </span>
              )}
            </span>
            <span className="ticket-label" {...(p.label === 'hidden' ? { hidden: true } : {})}>
              {t.key}
              {(() => {
                // Someone else just changed it in Jira: who, and what, for a few seconds.
                const c = recentChange(state.ticketDetails[t.key], stream.now());
                return c ? (
                  <span className="ticket-change">
                    {c.by}: {c.names.join(', ')}
                  </span>
                ) : null;
              })()}
            </span>
          </button>
        );
      })}

      {layout.tickets.flatMap((p) =>
        p.moons.map(({ pr, x, y }) => (
          <span
            key={`${pr.repo}#${pr.number}`}
            role="img"
            aria-label={`${pr.repo} #${pr.number}, ${pr.state}, for ${pr.ticket}`}
            {...tips.bind(`${pr.repo}#${pr.number}`, () => (
              <>
                <span className="tip-key">
                  {pr.repo} #{pr.number}
                </span>
                <span className="tip-meta">
                  {pr.state}, for {pr.ticket}
                </span>
              </>
            ))}
            tabIndex={-1}
            className={`moon moon--${pr.state}${ciFailing(state, pr) ? ' moon--failing' : ''}`}
            style={{ left: x - MOON.size / 2, top: y - MOON.size / 2, width: MOON.size, height: MOON.size }}
          >
            <PullRequestGlyph size={12} />
          </span>
        )),
      )}

      {layout.cluster && (
        <button
          type="button"
          className="ticket-cluster"
          {...tips.bind('+N', () => <span className="tip-title">{clusterLabel(layout.cluster!)}</span>)}
          aria-label={`${clusterLabel(layout.cluster)}. Opens the first; previous and next step through them all.`}
          onClick={() => onSelect(layout.cluster!.keys[0]!)}
          style={{ left: layout.cluster.x - layout.cluster.d / 2, top: layout.cluster.y - layout.cluster.d / 2, width: layout.cluster.d, height: layout.cluster.d }}
        >
          +{layout.cluster.keys.length}
        </button>
      )}

      {layout.done.map(({ ticket, x, y, d }) => (
        <span key={ticket.key} {...tips.bind(ticket.key, () => <TicketTip ticket={ticket} />)} role="img" aria-label={ticketTooltip(ticket)} className="corner-done" style={{ left: x - d / 2, top: y - d / 2, width: d, height: d }} />
      ))}
      {tips.node}
    </div>
  );
}

/** The digits of a key, as the dial and the arrows name tickets ("3538"). */
export const keyDigits = (key: string): string => key.split('-')[1] ?? key;

/**
 * The dial (B+), with its buttons. At rest only the open ticket is named. Hovered, or reached by
 * keyboard, it grows about 1.7× in place over the header as a floating layer (so any other layer opening shrinks it)
 * and every dot shows its digits, placed clear of the other dots and labels; a dot's own hover shows its title and
 * workflow status in a tooltip that belongs to the grown dial. Reduced motion: it grows without animating.
 */
export function Dial({ state, selected, onSelect, controls }: { state: WorkspaceState; selected: string; onSelect: (key: string) => void; controls?: (tip: ReturnType<typeof useTips>['bind']) => ReactNode }) {
  const layout = useLayout(state);
  const grow = useLayer('dial');
  const tips = useTips({ parent: grow.id });
  const k = DIAL_SCALE;
  const { x: dx, y: dy } = toDial(0, 0);
  const labels = useMemo(() => dialLabels(dialDots(layout), selected), [layout, selected]);
  return (
    <div
      ref={(el) => {
        grow.anchor.current = el;
      }}
      className={`tv-dial-box${grow.open ? ' tv-dial-box--grown' : ''}`}
      {...(grow.open ? { 'data-layer': 'dial', 'data-layer-id': grow.id } : {})}
      onMouseEnter={grow.show}
      onMouseLeave={() => grow.hide()}
      onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && grow.show()}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && grow.hide()}
    >
      <div className="dial" style={{ width: DIAL_SIZE.w, height: DIAL_SIZE.h }}>
        <svg className="orbit-lines" width={DIAL_SIZE.w} height={DIAL_SIZE.h} aria-hidden="true">
          <g transform={`translate(${dx} ${dy})`}>
            <Rings scale={k} />
          </g>
          {[...labels.values()]
            .filter((l) => l.leader && l.clear)
            .map((l) => (
              <line key={l.key} className={`dial-leader${l.key === selected ? ' dial-leader--on' : ''}`} x1={l.leader!.x1} y1={l.leader!.y1} x2={l.leader!.x2} y2={l.leader!.y2} />
            ))}
        </svg>
        <span className="dial-you" style={{ left: dx + MAP.cx * k - 4, top: dy + MAP.cy * k - 4 }} />
        {layout.tickets.map((p) => {
          const t = state.tickets[p.key]!;
          const d = Math.round(p.d * DIAL_DOT);
          const x = dx + p.x * k;
          const y = dy + p.y * k;
          const on = t.key === selected;
          const changed = recentChange(state.ticketDetails[t.key], stream.now());
          const label = labels.get(t.key);
          return (
            <span key={t.key} className="dial-spot" style={{ left: x - d / 2, top: y - d / 2, width: d, height: d }}>
              <button
                {...tips.bind(t.key, () => <TicketTip ticket={t} />)}
                type="button"
                className={`dial-dot${on ? ' dial-dot--on' : ''}${changed ? ' dial-dot--changed' : ''}`}
                aria-label={`${t.key}, ${t.summary}, ${t.workflowStatus?.name ?? t.status}`}
                aria-current={on}
                onClick={() => onSelect(t.key)}
                style={{ width: d, height: d, background: statusVar(t.status) }}
              />
              {/* A label with no clear place (none found in 500 test sprints) is left to the tooltip, never drawn over a dot. */}
              {label?.clear && (
                <span className={`dial-num${on ? ' dial-num--on' : ''}`} style={{ left: label.x - (x - d / 2), top: label.y - (y - d / 2) }} aria-hidden="true">
                  {label.text}
                </span>
              )}
            </span>
          );
        })}
        {layout.cluster && <DialCluster cluster={layout.cluster} selected={selected} at={{ dx, dy }} onSelect={onSelect} tip={tips.bind('+N', () => <span className="tip-title">{clusterLabel(layout.cluster!)}</span>)} />}
      </div>
      {controls?.(tips.bind)}
      {tips.node}
    </div>
  );
}

/** The +N node on the dial; it is ringed when the open ticket is one of the grouped ones. */
function DialCluster({ cluster, selected, at, onSelect, tip }: { cluster: TicketCluster; selected: string; at: { dx: number; dy: number }; onSelect: (key: string) => void; tip: ReturnType<ReturnType<typeof useTips>['bind']> }) {
  const d = Math.round(cluster.d * DIAL_DOT);
  const x = at.dx + cluster.x * DIAL_SCALE;
  const y = at.dy + cluster.y * DIAL_SCALE;
  const on = cluster.keys.includes(selected);
  return (
    <button
      type="button"
      {...tip}
      className={`dial-dot dial-dot--cluster${on ? ' dial-dot--on' : ''}`}
      aria-label={clusterLabel(cluster)}
      aria-current={on}
      onClick={() => onSelect(cluster.keys[0]!)}
      style={{ left: x - d / 2, top: y - d / 2, width: d, height: d }}
    />
  );
}
