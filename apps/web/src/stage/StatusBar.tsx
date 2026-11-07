// Top left of both screens, on the 36px control line: what needs looking at as icon-and-count pairs (only
// what is not zero, most urgent first, the full sentence on hover), the date as a calendar tile and the
// time as digits, then any quiet status line (offline, Jira or GitHub unreachable, Claude paused).
import type { StatusItem } from '@elfoqsy/state';

const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Thursday 8 October 2026": the tile's tooltip and accessible name. */
export const longDate = (at: number): string => dayFormat.format(at).replace(',', '');

export function StatusBar({ items, now, lines }: { items: StatusItem[]; now: number; lines: string[] }) {
  const label = items.length ? items.map((i) => i.sentence).join(', ') : 'Nothing needs you';
  return (
    <div className="status-bar" role="status" aria-label={label}>
      {items.map((item) => (
        <span key={item.kind} className="status-pair" data-tip={item.sentence}>
          <StatusIcon kind={item.kind} />
          {item.count}
        </span>
      ))}
      <span className="status-when">
        <CalendarTile at={now} />
        <span className="status-time">{timeFormat.format(now)}</span>
      </span>
      {lines.map((line) => (
        <span key={line} className="status-line">
          {line}
        </span>
      ))}
    </div>
  );
}

function StatusIcon({ kind }: { kind: StatusItem['kind'] }) {
  return (
    <span className={`status-icon status-icon--${kind}`} aria-hidden="true">
      {kind === 'waiting' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--bg-canvas)">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--glyph)" strokeWidth="3.4" strokeLinecap="round">
          <path d={kind === 'broken' ? 'M7 7l10 10M17 7 7 17' : 'M6 12h12'} />
        </svg>
      )}
    </span>
  );
}

export function CalendarTile({ at }: { at: number }) {
  const label = longDate(at);
  return (
    <span className="calendar-tile" role="img" aria-label={label} data-tip={label}>
      <span className="calendar-month">{MONTHS[new Date(at).getMonth()]}</span>
      <span className="calendar-day">{new Date(at).getDate()}</span>
    </span>
  );
}
