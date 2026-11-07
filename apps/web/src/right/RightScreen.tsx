// The right screen: watch the work. Two collapsible columns, the live map and the terminals (1 : 1.3);
// the last open column cannot collapse.
import { useEffect, useState } from 'react';
import { statusItems, statusLines } from '@elfoqsy/state';
import { ArrangedScreen } from '../panes/ArrangedScreen';
import { folds, useFolds } from '../panes/folds';
import { useWorkspace } from '../state/workspace';
import { lookOf } from '../ui/elfoqsy';
import { useNow } from '../ui/useNow';
import { focusRun } from './focus';
import { MapColumn } from './map/MapColumn';
import { Terminals } from './terminals/Terminals';

export function RightScreen() {
  const { state, connection } = useWorkspace();
  // Which columns are folded is the window's own state, kept outside this screen (panes/folds.ts).
  const folded = useFolds();
  const open = { map: !folded.has('map'), terminals: !folded.has('terminals') };
  // Panes are laid out once the log has been replayed, and kept through reconnects.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (connection.status === 'live') setReady(true);
  }, [connection.status]);

  // An agent clicked on the map while the terminals are hidden: they open, and its pane takes focus.
  useEffect(() => focusRun.onHidden(() => folds.unfold('terminals')), []);

  const now = useNow();
  const both = open.map && open.terminals;
  const flip = (column: 'map' | 'terminals') => {
    if (open[column] && !(open.map && open.terminals)) return;
    if (open[column]) folds.fold(column);
    else folds.unfold(column);
  };

  return (
    <ArrangedScreen screen={1} label="Elfoqsy's agents">
      <div className="screen screen--right">
        <MapColumn
          state={state}
          items={statusItems(state)}
          look={lookOf(state, now)}
          now={now}
          statusLines={statusLines(state, connection.offlineSince)}
          open={open.map}
          lastOpen={open.map && !both}
          onToggle={() => flip('map')}
        />
        <Terminals
          state={state}
          ready={ready}
          notice={connection.notice}
          open={open.terminals}
          lastOpen={open.terminals && !both}
          onToggle={() => flip('terminals')}
        />
      </div>
    </ArrangedScreen>
  );
}
