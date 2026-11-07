// The traces Elfoqsy's sessions export, kept in data/telemetry.sqlite (telemetry/store.ts), read from the command line.
// Read-only. No dashboard yet: this is how the data is looked at until a few weeks of real runs say what one should show.
//   sessions [n] [kind]  every session of every kind (conversation, investigator, ticket, task, responder, study, exam,
//                        probe, abilities): turns, model calls, tokens with cache, tool calls, failed calls, wall time
//   runs [n]           each run: model calls, tokens (cache reads apart), tool calls, failed calls, time, and its outcome
//   failures [days]    failed tool calls that keep coming back (at least 3, in at least 2 sessions)
//   sql "<query>"      any query that reads: tables spans, events, run_outcomes; views tool_calls, run_summary, session_summary
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../config';
import { TelemetryStore } from '../telemetry/store';

const file = join(resolve(process.env.DATA_DIR ?? join(REPO_ROOT, 'data')), 'telemetry.sqlite');
if (!existsSync(file)) {
  console.error(`No telemetry yet: ${file} does not exist (the daemon makes it when it starts with ELFOQSY_TELEMETRY=on).`);
  process.exit(1);
}
const db = new Database(file, { readonly: true, fileMustExist: true });
const [cmd, arg] = process.argv.slice(2);

function print(rows: unknown[]): void {
  if (!rows.length) return void console.log('(nothing)');
  console.table(rows);
}

if (cmd === 'sessions') {
  // A number is how many; a word is the kind (`sessions conversation`, `sessions 50 investigator`).
  const args = process.argv.slice(3);
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
  const kind = args.find((a) => !/^\d+$/.test(a));
  const rows = db
    .prepare(`SELECT * FROM session_summary ${kind ? 'WHERE agent_kind = ?' : ''} ORDER BY started_ms DESC LIMIT ?`)
    .all(...(kind ? [kind, n] : [n])) as Array<Record<string, number | string | null>>;
  print(
    rows.map((r) => ({
      started: new Date(Number(r.started_ms)).toISOString().slice(0, 16).replace('T', ' '),
      kind: r.agent_kind,
      of: r.ticket ?? r.conversation_id ?? r.run_id ?? String(r.session_id).slice(0, 8),
      turns: r.turns === r.traced_turns ? r.turns : `${r.turns} (${r.traced_turns} traced)`,
      model_calls: r.model_calls,
      input: r.input_tokens,
      output: r.output_tokens,
      cache_write: r.cache_creation_tokens,
      cache_read: r.cache_read_tokens,
      tool_calls: r.tool_calls,
      failed: r.failed_calls,
      wall_s: Math.round(Number(r.wall_ms) / 100) / 10,
    })),
  );
} else if (cmd === 'runs') {
  print(db.prepare('SELECT run_id, ticket, agent_kind, agent_number, model_calls, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, tool_calls, failed_calls, wall_ms, end_state, verdict, pr_state, review_rounds, reopened FROM run_summary ORDER BY started_ms DESC LIMIT ?').all(Number(arg ?? 20)));
} else if (cmd === 'failures') {
  db.close();
  const store = new TelemetryStore(file);
  print(store.recurringFailures(Date.now() - Number(arg ?? 14) * 24 * 3600_000).map((g) => ({ tool: g.tool, call: g.signature, error: g.errorClass, count: g.count, sessions: g.sessions, example: g.examples[0]?.slice(0, 80) })));
  store.close();
} else if (cmd === 'sql' && arg) {
  const stmt = db.prepare(arg);
  if (!stmt.reader) {
    console.error('Only queries that read.');
    process.exit(2);
  }
  print(stmt.all());
} else {
  console.error('telemetry sessions [n] [kind] | runs [n] | failures [days] | sql "<query>" (see the top of src/tools/telemetry.ts)');
  process.exitCode = 2;
}
