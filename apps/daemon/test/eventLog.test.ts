import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { parseEnvelope } from '@elfoqsy/contracts';
import { EventLog } from '../src/eventLog';

let dir: string;
let file: string;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elfoqsy-log-'));
  file = join(dir, 'events.sqlite');
  log = new EventLog(file);
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('EventLog', () => {
  it('assigns increasing seq, a ULID and an ISO timestamp', () => {
    const a = log.append('simulator', 'run.note', { runId: 'r1', text: 'one' });
    const b = log.append('simulator', 'run.note', { runId: 'r1', text: 'two' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Date(a.ts).toISOString()).toBe(a.ts);
    expect(log.headSeq()).toBe(2);
  });

  it('replays from a seq in order, and every stored envelope is valid', () => {
    for (let i = 1; i <= 5; i++) log.append('simulator', 'run.note', { runId: 'r1', text: `line ${i}` });
    const replay = log.readFrom(2);
    expect(replay.map((e) => e.seq)).toEqual([3, 4, 5]);
    for (const event of replay) expect(parseEnvelope(event)).toEqual(event);
    expect(log.readFrom(0, 2).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('redacts the payload before writing it', () => {
    const key = 'ab12'.repeat(10);
    log.append('jira', 'ticket.synced', {
      ticket: {
        key: 'CORE-18891',
        board: 'CORE',
        summary: 'Raise the payment API rate limit',
        type: 'Task',
        status: 'To do',
        priority: 'Major',
        storyPoints: null,
        sprint: 'Platform 2026-10',
        sprintsCarried: 1,
        epic: null,
        reporter: 'Quinn Bauer',
        created: '8 Oct 2026',
        updated: '8 Oct 2026',
        labels: [],
        linked: [],
        description: `Key: apikey: ${key}`,
      },
    });
    const raw = new Database(file, { readonly: true }).prepare('SELECT payload FROM events').get() as { payload: string };
    expect(raw.payload).not.toContain(key);
    expect(raw.payload).toContain('[redacted secret]');
  });

  it('rejects an invalid payload and writes nothing', () => {
    expect(() =>
      log.append('agent', 'run.check_changed', { runId: 'r1', checkId: 'unit', status: 'green', evidence: '' } as never),
    ).toThrow();
    expect(log.headSeq()).toBe(0);
  });

  it('notifies subscribers synchronously, until they unsubscribe', () => {
    const seen: AnyEnvelope[] = [];
    const stop = log.subscribe((e) => seen.push(e));
    log.append('simulator', 'run.note', { runId: 'r1', text: 'a' });
    stop();
    log.append('simulator', 'run.note', { runId: 'r1', text: 'b' });
    expect(seen.map((e) => e.seq)).toEqual([1]);
  });

  it('refuses updates and deletes at the database level', () => {
    log.append('simulator', 'run.note', { runId: 'r1', text: 'a' });
    const db = new Database(file);
    expect(() => db.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM events').run()).toThrow(/append-only/);
    db.close();
  });

  it('keeps its logId across reopen', () => {
    const id = log.logId;
    log.close();
    log = new EventLog(file);
    expect(log.logId).toBe(id);
  });
});
