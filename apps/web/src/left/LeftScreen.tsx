// The left screen: talk to Elfoqsy. Three collapsible columns: the sprint, Elfoqsy (portrait,
// conversations, usage) and the conversation; Elfoqsy and the conversation share one panel. The last open
// column cannot collapse. Each is a pane (P1) that fills the box it is given; this is the arrangement every screen
// starts with, and what it shows with no layout saved, laid out as it always was. With a layout saved (P2) the
// arranged screen shows that instead (panes/ArrangedScreen.tsx).
import { statusItems, statusLines } from '@elfoqsy/state';
import { useWorkspace } from '../state/workspace';
import { lookOf } from '../ui/elfoqsy';
import { useNow } from '../ui/useNow';
import { ArrangedScreen } from '../panes/ArrangedScreen';
import { folds, useFolds } from '../panes/folds';
import { ConversationPane, ElfoqsyPane } from '../panes/ConversationPane';
import { SprintPane } from '../panes/SprintPane';

type Column = 'sprint' | 'elf' | 'chat';

export function LeftScreen() {
  const { state, connection } = useWorkspace();
  const now = useNow();
  const items = statusItems(state);
  const look = lookOf(state, now);
  // Which columns are folded is the window's own state, kept outside this screen (panes/folds.ts) so that a free layout, and
  // today's columns again after a drag is cancelled, show the same panes folded.
  const folded = useFolds();
  const open: Record<Column, boolean> = { sprint: !folded.has('sprint'), elf: !folded.has('elfoqsy'), chat: !folded.has('conversation') };
  const pane = { sprint: 'sprint', elf: 'elfoqsy', chat: 'conversation' } as const;
  const setOpen = (c: Column, to: boolean) => (to ? folds.unfold(pane[c]) : folds.fold(pane[c]));

  const count = Number(open.sprint) + Number(open.elf) + Number(open.chat);
  const flip = (c: Column) => {
    if (open[c] && count === 1) return;
    setOpen(c, !open[c]);
  };
  const sprintFlex = !open.sprint ? '0 0 var(--rail-width)' : open.chat ? '0 0 840px' : '1 1 840px';
  const panelFlex = open.chat || (open.elf && !open.sprint) ? '1 1 0' : '0 0 auto';

  return (
    <ArrangedScreen screen={0} label="Sprint and Elfoqsy">
      <div className="screen screen--left">
        <div className="lcol-wrap" style={{ flex: sprintFlex }}>
          <SprintPane
              state={state}
              items={items}
              now={now}
              statusLines={statusLines(state, connection.offlineSince)}
              jiraSite={connection.jiraSite}
              chrome={{ kind: 'classic', open: open.sprint, lastOpen: open.sprint && count === 1, onToggle: () => flip('sprint'), ensureOpen: () => setOpen('sprint', true) }}
          />
        </div>
        <section className="panel" aria-label="Elfoqsy" style={{ flex: panelFlex }}>
          <ElfoqsyPane
            state={state}
            look={look}
            chrome={{ kind: 'classic', open: open.elf, lastOpen: open.elf && count === 1, onToggle: () => flip('elf') }}
            alone={!open.sprint && !open.chat}
          />
          <ConversationPane state={state} chrome={{ kind: 'classic', open: open.chat, lastOpen: open.chat && count === 1, onToggle: () => flip('chat') }} />
        </section>
      </div>
    </ArrangedScreen>
  );
}
