// Any pane in any slot (P1, P2): the host that turns a pane id into the pane, as it is when it is not one of today's fixed
// columns. It fills the box it is given, picks its form from that box, and has no collapse button and no status bar of its
// own (the screen's top row carries the status bar). Elfoqsy and the conversation each get their own panel here; in today's
// arrangement they share one.
import type { Fold, StatusItem, WorkspaceState } from '@elfoqsy/state';
import { MapColumn } from '../right/map/MapColumn';
import { Terminals } from '../right/terminals/Terminals';
import type { Look } from '../ui/elfoqsy';
import { ConversationPane, ElfoqsyPane } from './ConversationPane';
import { SprintPane } from './SprintPane';
import type { PaneId } from './spec';

/** What every pane needs from the screen that hosts it. */
export interface PaneHost {
  state: WorkspaceState;
  items: StatusItem[];
  now: number;
  statusLines: string[];
  jiraSite: string;
  look: Look;
  /** The log has been replayed: the terminals lay out their panes. */
  ready: boolean;
  notice: { message: string; at: number } | null;
}

/** A pane's fold in a free layout (P2): open or folded, folded as a rail or as a bar, how to flip it, and how to open it. */
export interface PaneFold {
  open: boolean;
  shape: Fold | null;
  toggle: () => void;
  unfold: () => void;
}
const OPEN: PaneFold = { open: true, shape: null, toggle: () => undefined, unfold: () => undefined };

export function FreePane({ id, host, fold = OPEN }: { id: PaneId; host: PaneHost; fold?: PaneFold }) {
  const chrome = { kind: 'free', open: fold.open, onToggle: fold.toggle, ensureOpen: fold.unfold } as const;
  const panel = `panel panel--solo${fold.shape ? ` panel--${fold.shape}` : ''}`;
  switch (id) {
    case 'sprint':
      return <SprintPane state={host.state} items={host.items} now={host.now} statusLines={host.statusLines} jiraSite={host.jiraSite} chrome={chrome} />;
    case 'elfoqsy':
      return (
        <section className={panel} aria-label="Elfoqsy">
          <ElfoqsyPane state={host.state} look={host.look} chrome={chrome} alone />
        </section>
      );
    case 'conversation':
      return (
        <section className={panel} aria-label="Conversation">
          <ConversationPane state={host.state} chrome={chrome} />
        </section>
      );
    case 'map':
      return <MapColumn state={host.state} items={host.items} look={host.look} now={host.now} statusLines={host.statusLines} open={fold.open} lastOpen={false} onToggle={fold.toggle} chrome="free" />;
    case 'terminals':
      return <Terminals state={host.state} ready={host.ready} notice={host.notice} open={fold.open} lastOpen={false} onToggle={fold.toggle} chrome="free" />;
  }
}
