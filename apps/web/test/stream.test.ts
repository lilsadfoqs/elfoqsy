import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyEnvelope, ServerFrame } from '@elfoqsy/contracts';
import { EventStream, OFFLINE_GRACE_MS, type SocketLike } from '../src/state/stream';
import { eventFactory, mockSprint } from './helpers';

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
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const welcome = (logId: string, headSeq = 0): ServerFrame => ({
  t: 'welcome',
  mode: 'simulate',
  logId,
  headSeq,
  serverTime: new Date().toISOString(),
  jiraSite: 'https://acme.atlassian.net',
});

let sockets: FakeSocket[];
let stream: EventStream;
let events: AnyEnvelope[];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-09T14:32:00Z') });
  sockets = [];
  stream = new EventStream('ws://test/ws', () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const e = eventFactory();
  events = mockSprint().open.map((ticket) => e('ticket.synced', { ticket }));
});

afterEach(() => vi.useRealTimers());

describe('EventStream', () => {
  it('replays from 0 after the welcome, then goes live', () => {
    stream.start();
    sockets[0]!.receive(welcome('log-1'));
    expect(sockets[0]!.sent).toEqual([{ t: 'hello', fromSeq: 0 }]);
    sockets[0]!.receive({ t: 'events', events });
    sockets[0]!.receive({ t: 'live' });
    const { state, connection } = stream.getSnapshot();
    expect(Object.keys(state.tickets)).toHaveLength(7);
    expect(connection).toMatchObject({ status: 'live', mode: 'simulate', offlineSince: null });
  });

  it('is not offline during a short drop, and resumes from its last seq', () => {
    stream.start();
    sockets[0]!.receive(welcome('log-1'));
    sockets[0]!.receive({ t: 'events', events });
    sockets[0]!.close();
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 100); // the retry happens at 500ms
    expect(stream.getSnapshot().connection.offlineSince).toBeNull();
    sockets[1]!.receive(welcome('log-1', 7));
    expect(sockets[1]!.sent).toEqual([{ t: 'hello', fromSeq: 7 }]);
    vi.advanceTimersByTime(5000);
    expect(stream.getSnapshot().connection.offlineSince).toBeNull();
    expect(Object.keys(stream.getSnapshot().state.tickets)).toHaveLength(7);
  });

  it('says offline since the moment the socket went down, once it stays down', () => {
    stream.start();
    sockets[0]!.receive(welcome('log-1'));
    const downAt = Date.now();
    sockets[0]!.close();
    sockets[1]?.close(); // the first retry fails too
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    expect(stream.getSnapshot().connection).toMatchObject({ status: 'down', offlineSince: downAt });
    // Back up: the line and the dimming go away.
    vi.advanceTimersByTime(5000);
    sockets.at(-1)!.receive(welcome('log-1'));
    expect(stream.getSnapshot().connection.offlineSince).toBeNull();
  });

  it('starts over from 0 when the daemon log was recreated', () => {
    stream.start();
    sockets[0]!.receive(welcome('log-1'));
    sockets[0]!.receive({ t: 'events', events });
    sockets[0]!.close();
    vi.advanceTimersByTime(600);
    sockets[1]!.receive(welcome('log-2'));
    expect(sockets[1]!.sent).toEqual([{ t: 'hello', fromSeq: 0 }]);
    expect(stream.getSnapshot().state.tickets).toEqual({});
  });

  it('dismisses a failed run from its pane, marked as the tester’s with ?tester', () => {
    const tester = new EventStream('ws://test/ws', () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }, { tester: true });
    tester.start();
    const socket = sockets.at(-1)!;
    socket.receive(welcome('log-1'));
    expect(tester.dismiss('r3')).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ t: 'dismiss', runId: 'r3', test: true });
  });

  it('sends nothing while the socket is not open', () => {
    stream.start();
    sockets[0]!.readyState = 0;
    expect(stream.say('hello')).toBe(false);
    expect(sockets[0]!.sent).toEqual([]);
  });
});
