// Append-only event log in SQLite. Every payload is validated against its zod schema and redacted
// before it is written; seq, id and ts are assigned here and nowhere else.
import Database from 'better-sqlite3';
import type { AnyEnvelope, EventType, PayloadOf, Source } from '@elfoqsy/contracts';
import { parsePayload } from '@elfoqsy/contracts';
import { redactDeep } from './redact';
import { ulid } from './ulid';

type Listener = (event: AnyEnvelope) => void;

interface Row {
  seq: number;
  id: string;
  ts: string;
  type: string;
  source: string;
  payload: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq     INTEGER PRIMARY KEY,
    id      TEXT NOT NULL UNIQUE,
    ts      TEXT NOT NULL,
    type    TEXT NOT NULL,
    source  TEXT NOT NULL,
    payload JSON NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
`;

export class EventLog {
  readonly logId: string;
  private readonly db: Database.Database;
  private readonly listeners = new Set<Listener>();
  private readonly insert: Database.Statement<[string, string, string, string, string]>;
  private readonly selectFrom: Database.Statement<[number, number], Row>;
  private readonly selectHead: Database.Statement<[], { head: number | null }>;
  private readonly selectRun: Database.Statement<[string, number], Row>;

  constructor(file: string, private readonly now: () => Date = () => new Date()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare('INSERT INTO events (id, ts, type, source, payload) VALUES (?, ?, ?, ?, ?)');
    this.selectFrom = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
    this.selectHead = this.db.prepare('SELECT MAX(seq) AS head FROM events');
    this.selectRun = this.db.prepare("SELECT * FROM events WHERE json_extract(payload, '$.runId') = ? ORDER BY seq DESC LIMIT ?");
    this.logId = this.loadOrCreateLogId();
  }

  append<T extends EventType>(source: Source, type: T, payload: PayloadOf<T>): Extract<AnyEnvelope, { type: T }> {
    const clean = redactDeep(parsePayload(type, payload));
    const at = this.now();
    const id = ulid(at.getTime());
    const ts = at.toISOString();
    const { lastInsertRowid } = this.insert.run(id, ts, type, source, JSON.stringify(clean));
    const event = { seq: Number(lastInsertRowid), id, ts, source, type, payload: clean } as unknown as Extract<
      AnyEnvelope,
      { type: T }
    >;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('event listener failed', error);
      }
    }
    return event;
  }

  /** Events with seq greater than afterSeq, oldest first, optionally only some types. */
  readFrom(afterSeq: number, limit = 1000, types?: string[]): AnyEnvelope[] {
    if (!types?.length) return this.selectFrom.all(afterSeq, limit).map(toEnvelope);
    const placeholders = types.map(() => '?').join(', ');
    return this.db
      .prepare<unknown[], Row>(`SELECT * FROM events WHERE seq > ? AND type IN (${placeholders}) ORDER BY seq LIMIT ?`)
      .all(afterSeq, ...types, limit)
      .map(toEnvelope);
  }

  /** The latest events that belong to a run (payload.runId), oldest first. */
  readRun(runId: string, limit = 50): AnyEnvelope[] {
    return this.selectRun.all(runId, limit).map(toEnvelope).reverse();
  }

  headSeq(): number {
    return this.selectHead.get()?.head ?? 0;
  }

  /** Called synchronously after each append. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }

  private loadOrCreateLogId(): string {
    const row = this.db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'logId'").get();
    if (row) return row.value;
    const logId = ulid();
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('logId', ?)").run(logId);
    return logId;
  }
}

function toEnvelope(row: Row): AnyEnvelope {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    source: row.source,
    type: row.type,
    payload: JSON.parse(row.payload),
  } as AnyEnvelope;
}
