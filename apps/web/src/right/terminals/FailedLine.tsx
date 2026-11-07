// A failed run's pane offers to dismiss it: it stops counting as broken and stays in history.
import type { RunView } from '@elfoqsy/state';

export function FailedLine({ run, onDismiss }: { run: RunView; onDismiss: () => void }) {
  return (
    <span className="pfoot-row pfoot-row--failed">
      <span className="pfoot-failed">
        <span className="failed-dot" aria-hidden="true" />
        Agent {run.agentNumber} failed{run.reason ? `: ${run.reason}` : '.'}
      </span>
      <button type="button" className="button-outline button-outline--small" data-tip="It stops counting as broken and leaves the map; it stays in history." onClick={onDismiss}>
        Dismiss
      </button>
    </span>
  );
}
