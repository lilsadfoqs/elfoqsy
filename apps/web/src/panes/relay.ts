// What crosses from one window to the other (P2): a pane's intent, when the pane that owns it is on the other screen. The
// daemon passes it on as it came and keeps nothing. This is the one place that knows which intents have an owner outside
// the pane bus (the conversation choice, the terminals' focus, what the Sprint pane shows).
import type { EventStream } from '../state/stream';
import { focusRun } from '../right/focus';
import { bus } from './bus';
import { session } from './session';
import { sprintView } from './sprintView';

export function connectRelay(stream: Pick<EventStream, 'relay' | 'onRelay'>): void {
  bus.setRelay((intent) => void stream.relay(intent));
  stream.onRelay((intent) => {
    if (intent.t === 'select_conversation') session.chooseFromElsewhere(intent.id);
    else if (intent.t === 'focus_run') focusRun.fromElsewhere(intent.runId);
    else if (intent.t === 'sprint_view') sprintView.fromElsewhere(intent.view);
    else bus.receive(intent);
  });
}
