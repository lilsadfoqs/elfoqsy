// Past work as tool calls, for the friction analysis: alex's Claude Code sessions (their
// transcripts) and Elfoqsy's runs (the event log). His own commands are read as the run tool that does the same today
// (kubectl as kube, a Coralogix DataPrime query as logs, gh, aws), so one friction reading and one skill's tracking cover
// both. Read-only.
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { EventLog } from '../eventLog';

import { callsOfRun } from './engine';
import type { Call } from './friction';

export interface Session {
  id: string;
  source: 'his-session' | 'elfoqsy-run';
  calls: Call[];
  /** His answers to questions asked him about environments or process, with the question. */
  questions: Array<{ q: string; a?: string }>;
}

const text = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '';

/** A command of his as the run tool that does it today, when there is one. */
export function asRunTool(tool: string, input: Record<string, unknown>): { tool: string; text: string } {
  if (/query_dataprime$/.test(tool)) return { tool: 'logs', text: String(input.query ?? '') };
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    // A one-line helper (k{ kubectl …; }) or a variable for the context still runs kubectl.
    const m = /(?:^|[;&|(]\s*|\bthen\s+)(kubectl|aws|gh)\s+(.*)$/s.exec(cmd.replace(/^\s*(cd [^;&|]+(&&|;)\s*)+/, '').replace(/^(\w+=\S+\s+)+/, ''));
    if (m && cmd.trimStart().startsWith(m[1]!)) return { tool: m[1] === 'kubectl' ? 'kube' : m[1]!, text: m[2]!.trim() };
    if (/^\s*(k\(\)\s*\{\s*kubectl|[A-Z]+=\S*cluster\/\S*;\s*kubectl)/.test(cmd)) return { tool: 'kube', text: cmd };
    return { tool: 'Bash', text: cmd };
  }
  return { tool, text: JSON.stringify(input).slice(0, 2000) };
}

/** One Claude Code transcript (JSONL) as a session of calls. */
export function transcriptSession(file: string): Session {
  const calls: Call[] = [];
  const pending = new Map<string, number>();
  const questions: Session['questions'] = [];
  let lastText: string | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let m: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      continue;
    }
    const content = m.message?.content;
    if (m.type === 'assistant' && Array.isArray(content)) {
      const said = text(content.filter((b: { type?: string }) => b.type === 'text')).trim();
      if (said) lastText = said;
      for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b.type !== 'tool_use') continue;
        pending.set(b.id ?? '', calls.length);
        const asked = b.name === 'AskUserQuestion' ? ((b.input?.questions ?? []) as Array<{ question?: string }>).map((q) => String(q.question ?? '')) : [];
        calls.push(asked.length ? { tool: 'ask_user', text: asked.join(' '), failed: false } : { ...asRunTool(b.name ?? '', b.input ?? {}), failed: false });
        for (const q of asked) questions.push({ q });
      }
    } else if (m.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
          if (b.type !== 'tool_result' || !pending.has(b.tool_use_id ?? '')) continue;
          const i = pending.get(b.tool_use_id ?? '')!;
          pending.delete(b.tool_use_id ?? '');
          const t = text(b.content);
          calls[i] = { ...calls[i]!, failed: !!b.is_error || /^Exit code [1-9]\d*/m.test(t) || /Compilation errors/.test(t), result: t.slice(0, 1500) };
        }
      }
      const typed = typeof content === 'string' ? content : Array.isArray(content) ? text(content.filter((b: { type?: string }) => b.type === 'text')) : '';
      if (typed && !m.isMeta && lastText?.trimEnd().endsWith('?') && !typed.includes('<command-') && !typed.includes('Base directory for this skill')) {
        const q = lastText.trim().split('\n').at(-1)!;
        questions.push({ q, a: typed });
        // A question he answered is a step of the work it interrupted, where it happened.
        calls.push({ tool: 'ask_user', text: q, failed: false });
        lastText = undefined;
      }
    }
  }
  return { id: basename(file).slice(0, 8), source: /-(runs|probes)-/.test(basename(dirname(file))) ? 'elfoqsy-run' : 'his-session', calls, questions };
}

/** Elfoqsy's runs in the event log, as sessions. */
export function runSessions(log: Pick<EventLog, 'readRun'>, runIds: string[]): Session[] {
  return runIds.map((id) => {
    const calls = callsOfRun(log, id);
    return { id: id.slice(-8), source: 'elfoqsy-run' as const, calls, questions: calls.filter((c) => /ask_user$/.test(c.tool)).map((c) => ({ q: c.text })) };
  });
}
