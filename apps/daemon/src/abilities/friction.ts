// Friction in a piece of work: failed or retried commands, long searches for the same thing, and
// questions asked to alex about environments or process. Deterministic, from the tool calls alone: the friction
// analysis over past work (tools/abilities.ts friction) and the review at the end of every run read it the same way.
import { redact } from '../redact';

export interface Call {
  tool: string;
  /** The command, the run tool's arguments as one line, or the input as JSON. */
  text: string;
  failed: boolean;
  /** The first lines of what it returned. */
  result?: string;
  /** The call's tool_use id, where it is known: it joins the call to its spans (telemetry/store.ts). */
  toolUseId?: string;
}

export interface FrictionPoint {
  kind: 'retried' | 'failed' | 'search' | 'question';
  /** What kind of call it was: the tool and its first words. */
  signature: string;
  /** Calls it took: a retry chain until the first success, a search run, or 1. */
  calls: number;
  example: string;
  error?: string;
  /** The call that finally worked, after a retry chain. */
  fixedBy?: string;
}

/** The run tools, whose first argument words tell what kind of call it was. */
export const RUN_TOOLS = ['kube', 'aws', 'gh', 'logs', 'docker', 'shop', 'jira', 'confluence'];
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'Read', 'LS']);
const SEARCH_CMDS = new Set(['grep', 'rg', 'find', 'ls', 'cat', 'head', 'tail', 'fd', 'tree', 'wc', 'jq', 'sed', 'awk', 'less']);
/** A question about environments or process, not about the code itself. */
export const ENV_OR_PROCESS = /\b(staging|dev|qa|integration|prod|production|cluster|context|namespace|kube|aws|profile|deploy(ed)?|release|branch|pr|pull request|merge|jira|credential|token|login|environment|pipeline|ci|image|helm|argo ?cd|coralogix|logs?|minikube|docker|replicas?|keda|pool|e2e|fixture|teams|confluence|version|hotfix)\b/i;
/** How many calls after a failure still count as retrying it. */
const RETRY_WINDOW = 8;
/** Consecutive search calls that make a long search. */
export const LONG_SEARCH = 6;

const words = (cmd: string): string[] => {
  const s = cmd
    .trim()
    .replace(/^(\s*cd [^;&|]+(&&|;)\s*)+/, '')
    .replace(/^(\w+=\S+\s+)+/, '');
  const toks = s.match(/[^\s'"]+|'[^']*'|"[^"]*"/g) ?? [];
  while (toks.length && /^(sudo|env|time|timeout|nohup|command|exec|\d+[smh]?)$/.test(toks[0]!)) toks.shift();
  return toks;
};

/** The words that are not flags, nor the value of a flag that names where (a context, namespace, profile, repository). */
const plain = (t: string[]): string[] => t.filter((w, i) => !w.startsWith('-') && !(i > 0 && /^--?(context|namespace|n|profile|repo|region)$/.test(t[i - 1]!)));

/** The kind of call: a run tool and its first non-flag words, a program and its subcommand, or the tool. */
export function signature(call: Pick<Call, 'tool' | 'text'>): string {
  const tool = call.tool.replace(/^mcp__run__/, '');
  if (RUN_TOOLS.includes(tool)) return [tool, ...plain(words(call.text)).slice(0, 2)].join(' ');
  if (tool === 'Bash') {
    const t = words(call.text);
    if (!t.length) return 'bash';
    const prog = t[0]!.split('/').pop()!;
    const subs = plain(t.slice(1)).slice(0, 3).filter((x) => /^[a-z][a-z0-9:_-]*$/.test(x));
    return [prog, ...subs.slice(0, ['kubectl', 'aws', 'git', 'gh', 'docker', 'helm', 'pnpm', 'npm', 'npx', 'make'].includes(prog) ? 2 : 1)].join(' ');
  }
  return tool;
}

function isSearch(c: Call): boolean {
  if (SEARCH_TOOLS.has(c.tool)) return true;
  if (c.tool !== 'Bash') return false;
  const t = words(c.text);
  // sed reads (sed -n 1,80p) unless it edits in place.
  return !!t.length && SEARCH_CMDS.has(t[0]!.split('/').pop()!) && !(t[0] === 'sed' && t.some((w) => /^-[a-zA-Z]*i/.test(w)));
}

/** One line of what failed, without numbers, quotes or paths, so the same error reads the same each time. */
export function errorClass(text = ''): string {
  const lines = text.split('\n').filter((l) => /error|denied|not found|no such|failed|forbidden|unauthori|expired|invalid|refused|timed? ?out|cannot|could not|unknown|exit code [1-9]/i.test(l));
  return redact((lines[0] ?? text.split('\n')[0] ?? '').replace(/\d+/g, 'N').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'…'").replace(/(\/[\w.@~-]+)+/g, '<path>'))
    .slice(0, 160)
    .trim();
}

const short = (s: string, n = 200): string => redact(s.replace(/\s+/g, ' ').trim()).slice(0, n);

/** The friction points in one session's calls, in the order they happened. */
export function frictionOf(calls: Call[]): FrictionPoint[] {
  const out: FrictionPoint[] = [];
  const retried = new Set<number>();
  calls.forEach((c, i) => {
    if (!c.failed || retried.has(i)) return;
    const sig = signature(c);
    let n = 1;
    let fixed: Call | undefined;
    for (let j = i + 1; j < calls.length && j <= i + RETRY_WINDOW; j++) {
      const d = calls[j]!;
      if (signature(d) !== sig) continue;
      n++;
      retried.add(j);
      if (!d.failed) {
        fixed = d;
        break;
      }
    }
    out.push({ kind: n > 1 ? 'retried' : 'failed', signature: sig, calls: n, example: short(c.text), error: errorClass(c.result), ...(fixed ? { fixedBy: short(fixed.text) } : {}) });
  });
  let run: Call[] = [];
  const flush = () => {
    if (run.length >= LONG_SEARCH) out.push({ kind: 'search', signature: 'search', calls: run.length, example: short(run.map((c) => c.text).join(' | '), 300) });
    run = [];
  };
  for (const c of calls) {
    if (isSearch(c)) run.push(c);
    else flush();
  }
  flush();
  for (const c of calls) {
    if (!isQuestion(c)) continue;
    if (ENV_OR_PROCESS.test(c.text)) out.push({ kind: 'question', signature: 'ask_user', calls: 1, example: short(c.text) });
  }
  return out;
}

/** A question to alex: an agent's ask_user, a question tool, or (in his own sessions) a question he answered. */
export const isQuestion = (c: Pick<Call, 'tool'>): boolean => /ask_user$|^AskUserQuestion$/.test(c.tool);

/** The friction worth a skill: a retry chain of two calls or more, a long search, or a question about environments or process. */
export const worthASkill = (f: FrictionPoint): boolean => (f.kind === 'retried' && f.calls >= 2) || f.kind === 'search' || f.kind === 'question';
