// Small pieces that say what a ticket is, the way Jira does: its type icon, status, priority and points,
// and the numbered badge of the agent on it (with a yellow ring while it waits for alex).
import type { Priority, Ticket } from '@elfoqsy/contracts';
import type { RunView } from '@elfoqsy/state';
import { GLYPH_PATHS, glyphFor } from './glyphs';
import { statusVar } from './ticket';

export function TypeIcon({ type, size = 26 }: { type: Ticket['type']; size?: number }) {
  const g = GLYPH_PATHS[glyphFor(type)];
  const inner = Math.round(size * 0.68);
  return (
    <span className={`type-icon type-icon--${type.replace(/\W/g, '')}`} style={{ width: size, height: size }} role="img" aria-label={type}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" aria-hidden="true">
        {g.fill ? (
          <path d={g.d} fill="var(--glyph)" />
        ) : (
          <path d={g.d} fill="none" stroke="var(--glyph)" strokeWidth={g.stroke} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

export function StatusChip({ status }: { status: Ticket['status'] }) {
  return (
    <span className="chip-status" style={{ background: statusVar(status) }}>
      {status}
    </span>
  );
}

const PRIORITY_PATH: Record<Priority, string> = {
  Blocker: 'M5 12h14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  Critical: 'm6 13 6-6 6 6M6 19l6-6 6 6',
  Major: 'm6 15 6-6 6 6',
  Minor: 'm6 9 6 6 6-6',
};

export function PriorityChip({ priority }: { priority: Priority }) {
  return (
    <span className="chip-soft">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className={`priority priority--${priority}`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={PRIORITY_PATH[priority]} />
      </svg>
      {priority}
    </span>
  );
}

export function PointsChip({ points }: { points: number | null }) {
  return <span className="chip-soft chip-soft--round">{points === null ? 'not estimated' : `${points} pt`}</span>;
}

/** The badge's number grows with the badge, in steps of the type scale; never under 12px. */
const badgeType = (size: number): string => `var(--font-size-${size >= 30 ? 'base' : size >= 26 ? 'sm' : 'xs'})`;

export function AgentBadge({ run, size = 22 }: { run: RunView; size?: number }) {
  const ring = run.state === 'waiting_for_you' ? ' agent-badge--waiting' : run.state === 'failed' ? ' agent-badge--failed' : '';
  return (
    <span className={`agent-badge${ring}`} style={{ width: size, height: size, fontSize: badgeType(size) }} data-tip={`Agent ${run.agentNumber}`}>
      {run.agentNumber}
    </span>
  );
}

/** A ticket named in running text: its type icon and key. */
export function TicketChip({ ticket, keyText, onOpen }: { ticket?: Ticket; keyText: string; onOpen?: () => void }) {
  const body = (
    <>
      {ticket && <TypeIcon type={ticket.type} size={18} />}
      {keyText}
    </>
  );
  return onOpen ? (
    <button type="button" className="ticket-chip" data-tip={ticket?.summary} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <span className="ticket-chip" data-tip={ticket?.summary}>
      {body}
    </span>
  );
}
