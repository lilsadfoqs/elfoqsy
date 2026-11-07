// What the windows send and hear for the free layout (P2), and the drag's own small state. The geometry is arrange.test.ts;
// the drag as a person does it, in two browser windows, is the browser tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Intent, ServerFrame } from '@elfoqsy/contracts';
import { DEFAULT_LAYOUT, type Layout } from '@elfoqsy/state';
import { PANE_TYPE, arranging, paneInDrag, toStage } from '../src/panes/arrange';
import { bus } from '../src/panes/bus';
import { connectRelay } from '../src/panes/relay';
import { session } from '../src/panes/session';
import { sprintView } from '../src/panes/sprintView';
import { focusRun } from '../src/right/focus';
import { EventStream, type SocketLike } from '../src/state/stream';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let socket: FakeSocket;
const open = (options: { tester?: boolean } = {}): EventStream => {
  const stream = new EventStream(
    'ws://test/ws',
    () => (socket = new FakeSocket()),
    options,
  );
  stream.start();
  return stream;
};

beforeEach(() => {
  arranging.reset();
  session.reset();
  bus.setRelay(undefined);
});
afterEach(() => bus.setRelay(undefined));

describe('the layout and intents on the socket', () => {
  it('sends his layout, null for none, and marks the tester’s so the daemon can refuse it', () => {
    const stream = open();
    const own = [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]] as Layout;
    stream.setLayout(own);
    stream.setLayout(null);
    expect(socket.sent).toEqual([{ t: 'layout_set', layout: own }, { t: 'layout_set', layout: null }]);
    const tester = open({ tester: true });
    tester.setLayout(own);
    expect(socket.sent).toEqual([{ t: 'layout_set', layout: own, test: true }]);
  });

  it('sends today’s arrangement as no layout, so the screens go back to their own geometry', () => {
    const stream = open();
    stream.setLayout(DEFAULT_LAYOUT);
    stream.setLayout(structuredClone(DEFAULT_LAYOUT));
    expect(socket.sent).toEqual([{ t: 'layout_set', layout: null }, { t: 'layout_set', layout: null }]);
  });

  it('folds a layout event, so a reload replays it and both windows have the same one', () => {
    const stream = open();
    socket.receive({ t: 'events', events: [{ seq: 1, id: 'L1', ts: '2026-10-18T10:00:00.000Z', source: 'orchestrator', type: 'layout.changed', payload: { layout: DEFAULT_LAYOUT, by: 'you' } }] });
    expect(stream.getSnapshot().state.layout).toEqual(DEFAULT_LAYOUT);
    socket.receive({ t: 'events', events: [{ seq: 2, id: 'L2', ts: '2026-10-18T10:01:00.000Z', source: 'orchestrator', type: 'layout.changed', payload: { layout: null, by: 'you' } }] });
    expect(stream.getSnapshot().state.layout).toBeNull();
  });

  it('relays a pane’s intent to the other window, hears the other window’s, and never sends one back', () => {
    const stream = open();
    connectRelay(stream);
    bus.emit({ t: 'open_ticket', key: 'SHOP-3546', section: 2 });
    expect(socket.sent).toEqual([{ t: 'relay', intent: { t: 'open_ticket', key: 'SHOP-3546', section: 2 } }]);

    const heard: Intent[] = [];
    const passedOn = vi.fn();
    bus.setRelay(passedOn); // anything this window would pass on
    const stop = bus.listen((i) => heard.push(i));
    socket.receive({ t: 'relay', intent: { t: 'open_brief', briefId: 'b1' } });
    expect(heard).toEqual([{ t: 'open_brief', briefId: 'b1' }]);
    expect(passedOn).not.toHaveBeenCalled();
    stop();
  });

  it('takes a conversation chosen in the other window as its own choice, and a clicked agent as a request to focus', () => {
    const stream = open();
    connectRelay(stream);
    socket.receive({ t: 'relay', intent: { t: 'select_conversation', id: 'c9' } });
    expect(session.get().chosen).toBe('c9');
    socket.receive({ t: 'relay', intent: { t: 'select_conversation', id: null } });
    expect(session.get().chosen).toBeNull();

    const focused: string[] = [];
    const off = focusRun.subscribe((id) => focused.push(id));
    socket.receive({ t: 'relay', intent: { t: 'focus_run', runId: 'r3' } });
    expect(focused).toEqual(['r3']);
    off();
  });

  it('sends a conversation chosen here, and a focus request from here, to the other window', () => {
    const stream = open();
    connectRelay(stream);
    session.choose('c2');
    focusRun.request('r4');
    expect(socket.sent).toEqual([
      { t: 'relay', intent: { t: 'select_conversation', id: 'c2' } },
      { t: 'relay', intent: { t: 'focus_run', runId: 'r4' } },
    ]);
  });
});

describe('what the Sprint pane shows follows it (P2)', () => {
  it('is kept outside the pane, passed to the other window as it changes, without where it was scrolled to', () => {
    const stream = open();
    connectRelay(stream);
    sprintView.reset();
    sprintView.set({ kind: 'ticket', key: 'SHOP-3546', scrollTo: { section: 2, nonce: 7 } });
    expect(sprintView.get()).toEqual({ kind: 'ticket', key: 'SHOP-3546', scrollTo: { section: 2, nonce: 7 } }); // here it is as it was
    expect(socket.sent).toEqual([{ t: 'relay', intent: { t: 'sprint_view', view: { kind: 'ticket', key: 'SHOP-3546' } } }]);
    sprintView.set({ kind: 'create', draftId: 'd1' });
    expect(socket.sent.at(-1)).toEqual({ t: 'relay', intent: { t: 'sprint_view', view: { kind: 'create', draftId: 'd1' } } });
    sprintView.set({ kind: 'map' });
    expect(socket.sent.at(-1)).toEqual({ t: 'relay', intent: { t: 'sprint_view', view: { kind: 'map' } } });
  });

  it('takes the other window’s view as its own, so a pane that lands here shows it, and does not send it back', () => {
    const stream = open();
    connectRelay(stream);
    sprintView.reset();
    socket.sent.length = 0;
    socket.receive({ t: 'relay', intent: { t: 'sprint_view', view: { kind: 'brief', briefId: 'b1' } } });
    expect(sprintView.get()).toEqual({ kind: 'brief', briefId: 'b1' });
    expect(socket.sent).toEqual([]);
  });

  it('is told to the other window again when the pane leaves this one', () => {
    const stream = open();
    connectRelay(stream);
    sprintView.reset();
    sprintView.fromElsewhere({ kind: 'handoff', handoffId: 'h1' });
    socket.sent.length = 0;
    sprintView.leaving();
    expect(socket.sent).toEqual([{ t: 'relay', intent: { t: 'sprint_view', view: { kind: 'handoff', handoffId: 'h1' } } }]);
  });
});

describe('a focus request nobody took', () => {
  it('waits for the terminals to come back, but only a moment: not for a pane that is moved here minutes later', () => {
    vi.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
    try {
      const got: string[] = [];
      focusRun.request('r1');
      let off = focusRun.subscribe((id) => got.push(id));
      expect(got).toEqual(['r1']);
      off();
      focusRun.request('r2');
      vi.advanceTimersByTime(5000);
      off = focusRun.subscribe((id) => got.push(id));
      expect(got).toEqual(['r1']);
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a pane in a drag', () => {
  it('is read from the drag’s types, which is all a window may read before the drop', () => {
    expect(paneInDrag([PANE_TYPE, `${PANE_TYPE}-terminals`])).toBe('terminals');
    expect(paneInDrag(['text/plain'])).toBeNull();
    expect(paneInDrag([`${PANE_TYPE}-inbox`])).toBeNull();
    expect(paneInDrag(undefined)).toBeNull();
  });

  it('keeps the preview of a target that has not changed, and ends clean', () => {
    const preview = { layout: DEFAULT_LAYOUT, rects: {} };
    arranging.start('sprint');
    arranging.over('sprint', { x: 10, y: 10 }, { screen: 0, kind: 'col', col: 1 }, preview);
    const first = arranging.get().preview;
    arranging.over('sprint', { x: 20, y: 12 }, { screen: 0, kind: 'col', col: 1 }, { layout: DEFAULT_LAYOUT, rects: {} });
    expect(arranging.get().preview).toBe(first); // the pointer moved over the same zone: nothing is redrawn
    arranging.over('sprint', { x: 400, y: 500 }, { screen: 0, kind: 'row', col: 0, row: 0 }, { layout: DEFAULT_LAYOUT, rects: {} });
    expect(arranging.get().preview).not.toBe(first);
    arranging.end();
    expect(arranging.get()).toMatchObject({ pane: null, preview: null, pt: null, target: null });
  });

  it('lets a window that began the drag keep the pane in hand when the pointer leaves, and one that did not forget it', () => {
    arranging.start('map');
    arranging.over('map', { x: 5, y: 5 }, { screen: 1, kind: 'col', col: 0 }, { layout: DEFAULT_LAYOUT, rects: {} });
    arranging.leave();
    expect(arranging.get()).toMatchObject({ pane: 'map', source: true, pt: null, preview: null });
    arranging.end();
    arranging.over('conversation', { x: 5, y: 5 }, null, null); // from the other window
    arranging.leave();
    expect(arranging.get().pane).toBeNull();
  });

  it('shows a dropped layout until the daemon has said it, and goes on showing it through the end of the drag', () => {
    const layout = [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]] as never;
    arranging.start('sprint');
    arranging.drop(layout);
    expect(arranging.get()).toMatchObject({ pane: null, pending: { layout } });
    arranging.end();
    expect(arranging.get().pending).toEqual({ layout });
    arranging.settle();
    expect(arranging.get().pending).toBeNull();
  });

  it('can show a drop that gives no layout (today’s arrangement) until the daemon says it', () => {
    arranging.start('conversation');
    arranging.drop(null);
    expect(arranging.get().pending).toEqual({ layout: null }); // not "nothing pending": the screens are to be today's
    arranging.settle();
    expect(arranging.get().pending).toBeNull();
  });

  it('turns a client point into the stage’s own pixels, whatever the window scale', () => {
    const stage = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 960 }) } as unknown as HTMLElement;
    expect(toStage(stage, 100 + 480, 50 + 270)).toEqual({ x: 960, y: 540 });
  });
});
