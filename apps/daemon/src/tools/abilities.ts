// The abilities from the command line. Read-only but for write.
//   friction --out <file.json> [--eventlog <elfoqsy.sqlite>] <transcript.jsonl>...
//       The friction analysis over past work: his Claude Code sessions and Elfoqsy's runs. Clusters of failed and retried
//       calls (with what finally worked), long searches, and questions to him about environments or process.
//   baseline <ability.json>... -- [--eventlog <elfoqsy.sqlite>] <transcript.jsonl>...
//       Each ability's baseline from the same past work: the median steps its kind of task took, and over how many cases.
//   write <ability.json>...
//       Writes abilities to data/skills (validated, committed there). The daemon learns them at its next start.
//   list
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { REPO_ROOT } from '../config';
import { redact } from '../redact';
import { frictionOf, signature, worthASkill, ENV_OR_PROCESS } from '../abilities/friction';
import { runSessions, transcriptSession, type Session } from '../abilities/history';
import { baselineOf, finderName, problemsOf, type Ability } from '../abilities/ability';
import { AbilityStore } from '../abilities/store';

const dataDir = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, 'data'));

function eventReader(file: string): { readRun(runId: string, limit: number): AnyEnvelope[]; runIds(): string[] } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  type Row = { seq: number; id: string; ts: string; source: string; type: string; payload: string };
  const env = (r: Row) => ({ ...r, payload: JSON.parse(r.payload) }) as unknown as AnyEnvelope;
  return {
    readRun: (runId, limit) => (db.prepare("SELECT * FROM events WHERE json_extract(payload, '$.runId') = ? ORDER BY seq DESC LIMIT ?").all(runId, limit) as Row[]).map(env).reverse(),
    runIds: () => (db.prepare("SELECT json_extract(payload, '$.runId') AS id FROM events WHERE type = 'run.created' ORDER BY seq").all() as Array<{ id: string }>).map((r) => r.id),
  };
}

function sessionsFrom(args: string[]): Session[] {
  const out: Session[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--eventlog') {
      const r = eventReader(args[++i]!);
      out.push(...runSessions(r, r.runIds()));
    } else out.push(transcriptSession(args[i]!));
  }
  return out;
}

function friction(args: string[]): void {
  const outAt = args.indexOf('--out');
  const out = args[outAt + 1]!;
  const sessions = sessionsFrom(args.filter((_, i) => i !== outAt && i !== outAt + 1));
  type Cluster = { signature: string; fails: number; retried: number; wasted: number; chains: number[]; sessions: Set<string>; sources: Record<string, number>; errors: Map<string, number>; fixedBy: Map<string, number>; examples: string[] };
  const clusters = new Map<string, Cluster>();
  let searches = 0;
  let searchCalls = 0;
  const questions: Array<{ session: string; source: string; q: string; a?: string }> = [];
  for (const s of sessions) {
    for (const f of frictionOf(s.calls)) {
      if (f.kind === 'search') {
        searches++;
        searchCalls += f.calls;
        continue;
      }
      if (f.kind === 'question') continue;
      const c: Cluster = clusters.get(f.signature) ?? { signature: f.signature, fails: 0, retried: 0, wasted: 0, chains: [], sessions: new Set(), sources: {}, errors: new Map(), fixedBy: new Map(), examples: [] };
      c.fails++;
      c.sessions.add(s.id);
      c.sources[s.source] = (c.sources[s.source] ?? 0) + 1;
      if (f.error) c.errors.set(f.error, (c.errors.get(f.error) ?? 0) + 1);
      if (f.kind === 'retried') {
        c.retried++;
        c.wasted += f.calls;
        c.chains.push(f.calls);
      }
      if (f.fixedBy) c.fixedBy.set(f.fixedBy, (c.fixedBy.get(f.fixedBy) ?? 0) + 1);
      if (c.examples.length < 4) c.examples.push(f.example);
      clusters.set(f.signature, c);
    }
    for (const q of s.questions) if (ENV_OR_PROCESS.test(q.q)) questions.push({ session: s.id, source: s.source, q: redact(q.q).slice(0, 200), ...(q.a ? { a: redact(q.a).slice(0, 120) } : {}) });
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const report = {
    sessions: { all: sessions.length, his: sessions.filter((s) => s.source === 'his-session').length, runs: sessions.filter((s) => s.source === 'elfoqsy-run').length },
    calls: sessions.reduce((n, s) => n + s.calls.length, 0),
    failures: [...clusters.values()]
      .sort((a, b) => b.wasted - a.wasted || b.fails - a.fails)
      .map((c) => ({ signature: c.signature, fails: c.fails, retryChains: c.retried, wastedCalls: c.wasted, sessions: c.sessions.size, sources: c.sources, errors: top(c.errors, 3), fixedBy: top(c.fixedBy, 2), examples: c.examples })),
    longSearches: { count: searches, calls: searchCalls },
    questions,
    worthASkill: sessions.reduce((n, s) => n + frictionOf(s.calls).filter(worthASkill).length, 0),
  };
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`${report.sessions.all} sessions (${report.sessions.his} his, ${report.sessions.runs} runs), ${report.calls} calls; ${report.failures.length} kinds of failing call; ${searches} long searches (${searchCalls} calls); ${questions.length} questions about environments or process. Written to ${out}.`);
}

function baseline(args: string[]): void {
  const cut = args.indexOf('--');
  const files = args.slice(0, cut);
  const sessions = sessionsFrom(args.slice(cut + 1));
  for (const f of files) {
    const a = JSON.parse(readFileSync(f, 'utf8')) as Ability;
    const b = baselineOf(a.track, sessions);
    const fails = sessions.reduce((n, s) => n + s.calls.filter((c) => c.failed && new RegExp(a.track.match ?? '.', 'i').test(c.text) && a.track.tools.includes(c.tool)).length, 0);
    console.log(JSON.stringify({ name: a.name, steps: b.steps, failed: b.failed, questions: b.questions, cases: b.cases, failedCalls: fails, sessions: sessions.filter((s) => s.calls.some((c) => a.track.tools.includes(c.tool) && new RegExp(a.track.match ?? '.', 'i').test(c.text))).length, signatureOfFirst: a.steps[0]?.code ? signature({ tool: a.track.tools[0]!, text: a.steps[0].code }) : undefined }));
  }
}

async function write(files: string[]): Promise<void> {
  const store = new AbilityStore(join(dataDir, 'skills'));
  for (const f of files) {
    const a = JSON.parse(readFileSync(f, 'utf8')) as Ability;
    const problems = problemsOf(a);
    if (problems.length) throw new Error(`${f}: ${problems.join('; ')}`);
    const was = store.get(a.name);
    await store.write(a, `${was ? `updated ${a.name} v${a.version}` : `learned ${a.name}`}: ${a.title} (${finderName(a.finder)}, ${a.source})`);
    console.log(`Written: ${a.name} v${a.version}.`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'friction') friction(rest);
else if (cmd === 'baseline') baseline(rest);
else if (cmd === 'write') await write(rest);
else if (cmd === 'list') for (const a of new AbilityStore(join(dataDir, 'skills')).list()) console.log(`${a.name} v${a.version} (${a.tool}): ${a.title}, ${a.steps.length} steps, baseline ${a.baseline.steps} over ${a.baseline.cases}`);
else {
  console.error('abilities friction | baseline | write | list (see the top of src/tools/abilities.ts)');
  process.exitCode = 2;
}
