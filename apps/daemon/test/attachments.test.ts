import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentError, AttachmentStore, cleanName } from '../src/attachments';
import { EventLog } from '../src/eventLog';
import { Intake, IntakeError } from '../src/intake';
import { startServer, type RunningServer } from '../src/server';

let dir: string;
let store: AttachmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elfoqsy-att-'));
  store = new AttachmentStore(join(dir, 'attachments'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('attachments: the store', () => {
  it('keeps an image as it is, under an id, with its name, type and size', () => {
    const a = store.save('Screenshot 14.15.png', 'image/png', PNG);
    expect(a).toMatchObject({ name: 'Screenshot 14.15.png', mediaType: 'image/png', bytes: PNG.length });
    expect(readFileSync(store.get(a.attachmentId)!.file)).toEqual(PNG);
  });

  it('redacts text before it is written', () => {
    const a = store.save('clone.log', 'text/plain; charset=utf-8', Buffer.from('git clone https://bot:s3cret@github.com/org/repo'));
    expect(readFileSync(store.get(a.attachmentId)!.file, 'utf8')).toBe('git clone https://bot:[redacted password]@github.com/org/repo');
    expect(a.mediaType).toBe('text/plain');
  });

  it('refuses other types, empty files and files over 10 MB', () => {
    expect(() => store.save('x.sh', 'application/x-sh', Buffer.from('rm -rf /'))).toThrow(AttachmentError);
    expect(() => store.save('x.txt', 'text/plain', Buffer.alloc(0))).toThrow(AttachmentError);
    expect(() => store.save('x.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(AttachmentError);
  });

  it('never lets a name or an id reach outside its folder', () => {
    expect(cleanName('../../etc/passwd')).toBe('passwd');
    expect(cleanName('C:\\Users\\x\\shot.png')).toBe('shot.png');
    expect(store.get('../elfoqsy.sqlite')).toBeUndefined();
  });
});

describe('attachments: upload, download and messages', () => {
  let log: EventLog;
  let intake: Intake;
  let server: RunningServer;

  beforeEach(async () => {
    log = new EventLog(':memory:');
    intake = new Intake(log, { attachments: store });
    server = await startServer({ log, intake, mode: 'simulate', jiraSite: '', port: 0, attachments: store });
  });
  afterEach(async () => {
    intake.close();
    await server.close();
    log.close();
  });

  const upload = (body: Buffer, type: string, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/attachments`, { method: 'POST', body, headers: { 'content-type': type, 'x-file-name': encodeURIComponent('freeze.png'), ...headers } });

  it('uploads, then serves an image inline with nosniff', async () => {
    const res = await upload(PNG, 'image/png', { origin: 'http://127.0.0.1:5173' });
    expect(res.status).toBe(200);
    const a = (await res.json()) as { attachmentId: string; name: string };
    expect(a.name).toBe('freeze.png');
    const got = await fetch(`${server.url}/attachments/${a.attachmentId}`);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it('refuses uploads and downloads from another site', async () => {
    expect((await upload(PNG, 'image/png', { origin: 'https://evil.example' })).status).toBe(403);
    const a = store.save('x.png', 'image/png', PNG);
    expect((await fetch(`${server.url}/attachments/${a.attachmentId}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await upload(Buffer.from('#!/bin/sh'), 'application/x-sh')).status).toBe(400);
  });

  it('puts what was stored on the message, not what the client says, and refuses unknown ids', () => {
    const a = store.save('freeze.png', 'image/png', PNG);
    intake.handle({ t: 'say', text: 'This is the freeze', attachmentIds: [a.attachmentId], test: true });
    const message = log.readFrom(0).find((e) => e.type === 'elfoqsy.message')!;
    expect(message.payload).toMatchObject({ role: 'test', attachments: [{ attachmentId: a.attachmentId, name: 'freeze.png', mediaType: 'image/png', bytes: PNG.length }] });
    expect(() => intake.handle({ t: 'say', text: 'x', attachmentIds: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'], test: true })).toThrow(IntakeError);
  });
});
