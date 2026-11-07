// The Sprint pane (P1): the sprint column in whatever slot it has. It owns what is shown in it (the map, a ticket, a brief, a
// handoff, the create form) and the search, and does what the other panes ask of it by intent: a link in the conversation
// opens a ticket here, wherever this pane is.
import { useEffect } from 'react';
import type { StatusItem, WorkspaceState } from '@elfoqsy/state';
import { FindTicket } from '../left/sprint/FindTicket';
import { SprintColumn } from '../left/sprint/SprintColumn';
import { useLayer } from '../ui/layers';
import { useIntent } from './bus';
import { usePaneSlot } from './slot';
import { sprintForm } from './spec';
import { sprintView, useSprintView } from './sprintView';

/**
 * The classic column hides to a rail and cannot hide when it is the last one open; a free pane (P2) folds to a rail or a bar,
 * and may be the last one open.
 */
export type SprintChrome = { kind: 'classic'; open: boolean; lastOpen: boolean; onToggle: () => void; ensureOpen: () => void } | { kind: 'free'; open: boolean; onToggle: () => void; ensureOpen: () => void };

interface Props {
  state: WorkspaceState;
  items: StatusItem[];
  now: number;
  statusLines: string[];
  jiraSite: string;
  chrome: SprintChrome;
}

export function SprintPane({ state, items, now, statusLines, jiraSite, chrome }: Props) {
  const slot = usePaneSlot();
  const form = sprintForm(slot.w, slot.h);
  // What it shows lives outside the pane, so it follows the pane to the other window and through a rearrangement of this one.
  const view = useSprintView();
  const setView = sprintView.set;
  useEffect(() => () => sprintView.leaving(), []);
  // Find a ticket: the search dialog, the top floating layer.
  const search = useLayer('search');
  const ensureOpen = chrome.ensureOpen;

  // What the other panes ask of this one.
  useIntent((i) => {
    switch (i.t) {
      case 'open_ticket':
        ensureOpen();
        setView({ kind: 'ticket', key: i.key, ...(i.section ? { scrollTo: { section: i.section, nonce: Date.now() } } : {}) });
        break;
      case 'open_brief':
        ensureOpen();
        setView({ kind: 'brief', briefId: i.briefId });
        break;
      case 'open_handoff':
        ensureOpen();
        setView({ kind: 'handoff', handoffId: i.handoffId });
        break;
      case 'edit_draft':
        ensureOpen();
        setView({ kind: 'create', draftId: i.draftId });
        break;
      case 'new_ticket':
        ensureOpen();
        setView({ kind: 'create' });
        break;
      case 'find_ticket':
        ensureOpen();
        search.show();
        break;
    }
  });

  // Ctrl K finds a ticket from anywhere on this screen, opening the column if it was hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      ensureOpen();
      search.show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <SprintColumn
        state={state}
        items={items}
        now={now}
        statusLines={statusLines}
        jiraSite={jiraSite}
        view={view}
        onView={setView}
        open={chrome.open}
        lastOpen={chrome.kind === 'classic' ? chrome.lastOpen : false}
        onToggle={chrome.onToggle}
        onFind={search.show}
        form={form}
        chrome={chrome.kind === 'classic' ? 'classic' : 'free'}
      />
      <FindTicket
        state={state}
        layer={search}
        onOpen={(key) => {
          ensureOpen();
          setView({ kind: 'ticket', key });
        }}
        onCreate={() => {
          ensureOpen();
          setView({ kind: 'create' });
        }}
      />
    </>
  );
}
