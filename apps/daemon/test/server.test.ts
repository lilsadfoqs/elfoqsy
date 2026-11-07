import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerFrame } from '@elfoqsy/contracts';
import { EventLog } from '../src/eventLog';
import { Intake, IntakeError } from '../src/intake';
import { startServer, type RunningServer } from '../src/server';

let log: EventLog;
let intake: Intake;
let server: RunningServer;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  log = new EventLog(':memory:');
  intake = new Intake(log);
  server = await startServer({ log, intake, mode: 'simulate', jiraSite: 'https://acme.atlassian.net', port: 0 });
});

afterEach(async () => {
  sockets.forEach((s) => s.terminate());
  sockets.length = 0;
  await server.close();
  intake.close();
  log.close();
});

/** Connects and collects frames; `next(n)` resolves once n frames have arrived in total. */
function connect(origin?: string) {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, origin ? { origin } : {});
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as ServerFrame);
    for (const w of waiters.filter((w) => frames.length >= w.n)) w.resolve();
  });
  const next = (n: number) =>
    new Promise<ServerFrame[]>((resolve, reject) => {
      if (frames.length >= n) return resolve(frames);
      waiters.push({ n, resolve: () => resolve(frames) });
      setTimeout(() => reject(new Error(`timed out waiting for ${n} frames, got ${JSON.stringify(frames)}`)), 2000);
    });
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  return { ws, frames, next, send };
}

const note = (text: string) => log.append('simulator', 'run.note', { runId: 'r1', text });

describe('WebSocket stream', () => {
  it('welcomes, replays from the given seq, says live, then streams new events', async () => {
    note('one');
    note('two');
    note('three');
    const c = connect();
    const [welcome] = await c.next(1);
    expect(welcome).toMatchObject({ t: 'welcome', mode: 'simulate', logId: log.logId, headSeq: 3 });

    c.send({ t: 'hello', fromSeq: 1 });
    const frames = await c.next(3);
    expect(frames[1]).toMatchObject({ t: 'events' });
    expect(frames[1]!.t === 'events' && frames[1]!.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(frames[2]).toEqual({ t: 'live' });

    note('four');
    const after = await c.next(4);
    expect(after[3]!.t === 'events' && after[3]!.events.map((e) => e.seq)).toEqual([4]);
  });

  it('replays everything to a client that starts from 0', async () => {
    for (let i = 0; i < 1200; i++) note(`line ${i}`);
    const c = connect();
    await c.next(1);
    c.send({ t: 'hello', fromSeq: 0 });
    const frames = await c.next(5); // welcome, three batches of up to 500, live
    const seqs = frames.flatMap((f) => (f.t === 'events' ? f.events.map((e) => e.seq) : []));
    expect(seqs).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    expect(frames[4]).toEqual({ t: 'live' });
  });

  it('turns a message from Alex into an elfoqsy.message event', async () => {
    const c = connect();
    await c.next(1);
    c.send({ t: 'say', text: 'start an agent on SHOP-3546' });
    await new Promise((r) => setTimeout(r, 50));
    const [conversation, event] = log.readFrom(0);
    expect(conversation).toMatchObject({ type: 'conversation.created', payload: { title: 'start an agent on SHOP-3546', ticket: 'SHOP-3546' } });
    expect(event?.type).toBe('elfoqsy.message');
    expect(event?.payload).toMatchObject({ role: 'you', text: 'start an agent on SHOP-3546', conversationId: (conversation!.payload as { conversationId: string }).conversationId });
  });

  it('answers bad frames and unknown approvals with an error frame', async () => {
    const c = connect();
    await c.next(1);
    c.ws.send('not json');
    c.send({ t: 'answer', approvalId: 'nope', decision: 'approved' });
    const frames = await c.next(3);
    expect(frames.slice(1)).toEqual([
      { t: 'error', message: 'Invalid frame.' },
      { t: 'error', message: 'Unknown approval.' },
    ]);
  });

  it('accepts the workspace served from localhost', async () => {
    const c = connect('http://localhost:5173');
    const [welcome] = await c.next(1);
    expect(welcome?.t).toBe('welcome');
  });

  it('refuses a page from any other origin', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, { origin: 'https://evil.example' });
    sockets.push(ws);
    const error = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(error.message).toMatch(/403/);
  });
});

describe('Intake', () => {
  const request = (kind: 'push' | 'question') =>
    log.append('orchestrator', 'approval.requested', {
      approvalId: `a-${kind}`,
      runId: 'r1',
      kind,
      question: kind === 'push' ? 'Push feature/SHOP-3546?' : 'Which Confluence space?',
    });

  it('resolves a push with approve, once', () => {
    request('push');
    intake.handle({ t: 'answer', approvalId: 'a-push', decision: 'approved' });
    expect(log.readFrom(1).map((e) => e.type)).toEqual(['approval.resolved']);
    expect(() => intake.handle({ t: 'answer', approvalId: 'a-push', decision: 'denied' })).toThrow(IntakeError);
  });

  it('needs approve or deny for a push, and a written answer for a question', () => {
    request('push');
    request('question');
    expect(() => intake.handle({ t: 'answer', approvalId: 'a-push', decision: 'answered', answer: 'ok' })).toThrow(IntakeError);
    expect(() => intake.handle({ t: 'answer', approvalId: 'a-question', decision: 'approved' })).toThrow(IntakeError);
  });

  it('records the written answer to a question in the conversation first', () => {
    request('question');
    intake.handle({ t: 'answer', approvalId: 'a-question', decision: 'answered', answer: 'SHOP space' });
    const [message, resolved] = log.readFrom(1);
    expect(message).toMatchObject({ type: 'elfoqsy.message', payload: { role: 'you', text: 'SHOP space', refs: { approvalId: 'a-question', runId: 'r1' } } });
    expect(resolved).toMatchObject({ type: 'approval.resolved', payload: { approvalId: 'a-question', decision: 'answered', answer: 'SHOP space' } });
  });

  it('logs test frames as test, never as Alex', () => {
    request('push');
    request('question');
    intake.handle({ t: 'say', text: 'start an agent on SHOP-3546', test: true });
    intake.handle({ t: 'answer', approvalId: 'a-push', decision: 'denied', test: true });
    intake.handle({ t: 'answer', approvalId: 'a-question', decision: 'answered', answer: 'SHOP space', test: true });
    const after = log.readFrom(3).map((e) => e.payload);
    expect(after).toEqual([
      { messageId: expect.any(String), role: 'test', text: 'start an agent on SHOP-3546', conversationId: expect.any(String) },
      { approvalId: 'a-push', decision: 'denied', test: true },
      { messageId: expect.any(String), role: 'test', text: 'SHOP space', refs: { approvalId: 'a-question', runId: 'r1' } },
      { approvalId: 'a-question', decision: 'answered', answer: 'SHOP space', test: true },
    ]);
  });

  it('knows approvals requested before it started', () => {
    request('push');
    const late = new Intake(log);
    late.handle({ t: 'answer', approvalId: 'a-push', decision: 'denied' });
    expect(log.readFrom(1)[0]).toMatchObject({ type: 'approval.resolved', payload: { decision: 'denied' } });
    late.close();
  });
});

describe('Windows share the layout and pass intents (P2)', () => {
  it('sends a saved layout to every window as an event, replays it on a reload, and passes an intent to the other window only', async () => {
    const a = connect();
    const b = connect();
    await a.next(1);
    await b.next(1);
    a.send({ t: 'hello', fromSeq: 0 });
    b.send({ t: 'hello', fromSeq: 0 });
    await a.next(2);
    await b.next(2);

    const layout = [[['conversation'], ['elfoqsy']], [['sprint'], ['map', 'terminals']]];
    b.send({ t: 'layout_set', layout });
    const seen = (c: ReturnType<typeof connect>) => c.frames.flatMap((f) => (f.t === 'events' ? f.events : [])).filter((e) => e.type === 'layout.changed');
    await a.next(3);
    await b.next(3);
    expect(seen(a).map((e) => e.payload)).toEqual([{ layout, by: 'you' }]);
    expect(seen(b).map((e) => e.payload)).toEqual([{ layout, by: 'you' }]);

    // A window that opens later is replayed the layout.
    const c = connect();
    await c.next(1);
    c.send({ t: 'hello', fromSeq: 0 });
    await c.next(3);
    expect(seen(c).map((e) => e.payload)).toEqual([{ layout, by: 'you' }]);

    a.send({ t: 'relay', intent: { t: 'open_ticket', key: 'SHOP-3546', section: 2 } });
    await b.next(4);
    await c.next(4);
    expect(b.frames.at(-1)).toEqual({ t: 'relay', intent: { t: 'open_ticket', key: 'SHOP-3546', section: 2 } });
    expect(a.frames.some((f) => f.t === 'relay')).toBe(false); // never sent back
    expect(log.headSeq()).toBe(1); // and kept nowhere
  });

  it('answers an arrangement that does not fit with an error frame and saves nothing', async () => {
    const a = connect();
    await a.next(1);
    a.send({ t: 'hello', fromSeq: 0 });
    await a.next(2);
    a.send({ t: 'layout_set', layout: [[['sprint', 'elfoqsy', 'conversation', 'map'], ['terminals']], []] });
    const frames = await a.next(3);
    expect(frames[2]).toMatchObject({ t: 'error', message: expect.stringMatching(/does not fit/) });
    expect(log.headSeq()).toBe(0);
  });
});
