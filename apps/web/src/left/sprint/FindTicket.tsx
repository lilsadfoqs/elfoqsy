// Find anywhere (C in; a centred dialog from v1.4.1): Ctrl K, or the search button under the
// dial's expand button. Keys match exactly, titles by their words; the sprint answers at once and Jira (a tier-0 read) right after, so tickets outside
// the sprint are found too. Up and Down choose, Enter opens the ticket in Elfoqsy, Escape closes. "New ticket" opens
// his create form.
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { Floating, type Layer } from '../../ui/layers';
import { TypeIcon } from '../../ui/TicketBits';
import { ticketOrder } from '../model';
import { findResults, searching } from './find';
import { FindGlyph, WorkflowChip } from './TicketView';

/** Jira is asked once typing pauses. */
const SEARCH_DELAY_MS = 250;

/**
 * The search dialog (the top floating layer): centred on the left screen over a dimmed backdrop, whatever opened it.
 * A press on the backdrop or Escape closes it, and focus goes back to where it was.
 */
export function FindTicket({ state, layer, onOpen, onCreate }: { state: WorkspaceState; layer: Layer; onOpen: (key: string) => void; onCreate: () => void }) {
  return (
    <Floating layer={layer} modal className="find" role="dialog" aria-label="Find a ticket">
      <FindBody state={state} layer={layer} onOpen={onOpen} onCreate={onCreate} />
    </Floating>
  );
}

function FindBody({ state, layer, onOpen, onCreate }: { state: WorkspaceState; layer: Layer; onOpen: (key: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = findResults(state, ticketOrder(state), query);
  const waiting = searching(state, query);

  // Focused once placed: a layer is hidden until it has its place, and a hidden input takes no focus.
  useEffect(() => {
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    setChosen(0);
    const q = query.trim();
    if (q.length < 2) return;
    const id = setTimeout(() => stream.searchTickets(q), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [query]);

  const open = (key: string | undefined) => {
    if (!key) return;
    layer.hide();
    onOpen(key);
  };

  return (
    <>
      <div className="find-input">
        <FindGlyph size={18} />
        <input
          ref={input}
          value={query}
          aria-label="Find a ticket by key or words"
          placeholder="Find a ticket by key or words"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="find-results"
          aria-activedescendant={results[chosen] ? `find-${results[chosen]!.key}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setChosen((c) => Math.min(c + 1, Math.max(0, results.length - 1)));
            else if (e.key === 'ArrowUp') setChosen((c) => Math.max(c - 1, 0));
            else if (e.key === 'Enter') open(results[chosen]?.key);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <span className="find-esc">Esc</span>
      </div>
      {results.length > 0 && (
        <div className="find-results" id="find-results" role="listbox" aria-label="Tickets found">
          {results.map((r, n) => (
            <div
              key={r.key}
              id={`find-${r.key}`}
              role="option"
              aria-selected={n === chosen}
              className={`find-row${n === chosen ? ' find-row--on' : ''}`}
              onMouseEnter={() => setChosen(n)}
              onMouseDown={(e) => {
                e.preventDefault();
                open(r.key);
              }}
            >
              <TypeIcon type={r.type} size={18} />
              <span className="find-key">{r.key}</span>
              <span className="find-title">{r.summary}</span>
              {r.status.name && <WorkflowChip name={r.status.name} category={r.status.category} />}
              <span className="tag-outline">{r.where}</span>
            </div>
          ))}
        </div>
      )}
      {query.trim() && !results.length && <p className="find-note">{waiting ? 'Searching Jira…' : `No ticket matches "${query.trim()}".`}</p>}
      {results.length > 0 && waiting && <p className="find-note">Searching Jira for more…</p>}
      <button
        type="button"
        className="find-new"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          layer.hide();
          onCreate();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New ticket
      </button>
    </>
  );
}
