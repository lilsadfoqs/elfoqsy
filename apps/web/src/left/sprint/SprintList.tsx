// The sprint as a list, in a slot from 240 to 480 wide (P1;): the open tickets under their priority, each
// a dot in its status colour, its key and its title. Blockers sit with Critical, as on the map. A title wraps; nothing is
// cut short, and the done tickets stay the points bar's business.
import type { Priority } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import { ticketOrder } from '../model';
import { statusVar, ticketTooltip } from '../../ui/ticket';

const GROUP: Record<Priority, 'Critical' | 'Major' | 'Minor'> = { Blocker: 'Critical', Critical: 'Critical', Major: 'Major', Minor: 'Minor' };

export function SprintList({ state, onSelect }: { state: WorkspaceState; onSelect: (key: string) => void }) {
  const groups = (['Critical', 'Major', 'Minor'] as const).map((name) => ({ name, tickets: ticketOrder(state).filter((t) => GROUP[t.priority] === name) })).filter((g) => g.tickets.length);
  return (
    <div className="slist" role="list" aria-label="Open tickets by priority">
      {groups.map((g) => (
        <section key={g.name} className="slist-group" role="listitem" aria-label={g.name}>
          <h4>{g.name}</h4>
          {g.tickets.map((t) => (
            <button key={t.key} type="button" className="slist-row" aria-label={ticketTooltip(t)} onClick={() => onSelect(t.key)}>
              <span className="slist-dot" style={{ background: statusVar(t.status) }} aria-hidden="true" />
              <span className="slist-key">{t.key}</span>
              <span className="slist-title">{t.summary}</span>
            </button>
          ))}
        </section>
      ))}
      {!groups.length && <p className="slist-none">No open tickets.</p>}
    </div>
  );
}
