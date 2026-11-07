// What a terminal pane v2 shows, in order: the agent's thoughts, a card per tool call,
// and guidance and reminders where they were given. The same feed serves a sub-agent's pane. Pure: the cards are drawn
// in Cards.tsx.
import type { Actor } from '@elfoqsy/contracts';
import type { ApprovalView, DecisionView, RunView, SubagentView, Thought, ToolLine, WorkspaceState } from '@elfoqsy/state';
import { agentLabel, verdictWords } from '@elfoqsy/state';
import { toolIdentity, type ToolIdentity } from '../../ui/toolIcons';

export type CardStatus = 'running' | 'waiting' | 'done' | 'failed' | 'denied' | 'cancelled';

export interface CallEntry {
  kind: 'call';
  key: string;
  line: ToolLine;
  identity: ToolIdentity;
  status: CardStatus;
  /** How long it took, or has been running. */
  durationMs: number;
  /** A report Elfoqsy has acknowledged (begin_step, heartbeat). */
  acked?: boolean;
}

export type FeedEntry =
  | { kind: 'thought'; key: string; text: string }
  | CallEntry
  | { kind: 'guidance'; key: string; text: string; by: Actor }
  | { kind: 'reminder'; key: string; text: string };

const GUIDE_WHO: Record<Actor, string> = { you: 'alex', tester: 'the tester', elfoqsy: 'Elfoqsy', agent: 'the agent', orchestrator: 'the workspace' };
export const guideWho = (by: Actor): string => GUIDE_WHO[by] ?? 'someone';

/** Whether a report call (heartbeat, begin_step) has been acknowledged by Elfoqsy. */
function acked(run: RunView, line: ToolLine): boolean | undefined {
  const name = line.tool.replace(/^mcp__[^_]+__/, '');
  const end = line.finishedAt ?? Number.POSITIVE_INFINITY;
  const within = (t: number) => t >= line.at && t <= end;
  const seq = name === 'heartbeat' ? run.heartbeats.find((h) => within(h.at))?.seq : name === 'begin_step' ? run.steps.find((s) => within(s.beganAt))?.seq : undefined;
  return seq === undefined ? undefined : run.acked.includes(seq);
}

function status(line: ToolLine, waitingOn: ToolLine | undefined): CardStatus {
  if (!line.allowed) return 'denied';
  if (line.finishedAt === undefined) return line === waitingOn ? 'waiting' : 'running';
  return line.ok === false ? 'failed' : 'done';
}

function callEntry(run: RunView | undefined, line: ToolLine, waitingOn: ToolLine | undefined, now: number, i: number): CallEntry {
  let identity = toolIdentity(line.tool, line.title);
  let s = status(line, waitingOn);
  let durationMs = line.durationMs ?? (line.finishedAt ?? now) - line.at;
  // A sub-agent's card shows its model, effort and task, and how it is doing.
  const sub = (line.tool === 'Agent' || line.tool === 'Task') && run ? run.subagents.find((x) => x.parentToolUseId && x.parentToolUseId === line.toolUseId) : undefined;
  if (sub) {
    identity = { ...identity, call: `${agentLabel(sub.model, sub.effort)}: ${sub.task}` };
    s = !sub.outcome ? 'running' : sub.outcome === 'done' ? 'done' : sub.outcome === 'cancelled' ? 'cancelled' : 'failed';
    durationMs = (sub.finishedAt ?? now) - sub.startedAt;
  }
  const seen = run ? acked(run, line) : undefined;
  return { kind: 'call', key: line.toolUseId ?? `call-${i}`, line, identity, status: s, durationMs: Math.max(0, durationMs), ...(seen !== undefined ? { acked: seen } : {}) };
}

type Timed = { at: number; seq: number; entry: FeedEntry };

const thoughtEntries = (thoughts: Thought[] | undefined): Timed[] =>
  (thoughts ?? []).map((t) => ({ at: t.at, seq: t.seq, entry: { kind: 'thought', key: `thought-${t.seq}`, text: t.text } }));

const byTime = (a: Timed, b: Timed) => a.at - b.at || a.seq - b.seq;

/** The agent's own pane: thoughts, its tool calls (a sub-agent's call as one card), guidance and reminders. */
export function agentFeed(run: RunView, now: number): FeedEntry[] {
  const waitingOn = run.state === 'waiting_for_you' ? [...run.transcript].reverse().find((l) => l.finishedAt === undefined && l.allowed) : undefined;
  const calls: Timed[] = run.transcript.map((l, i) => ({ at: l.at, seq: l.seq ?? 0, entry: callEntry(run, l, waitingOn, now, i) }));
  const guidance: Timed[] = run.guidance.map((g) => ({ at: g.at, seq: g.seq, entry: { kind: 'guidance', key: `guidance-${g.seq}`, text: g.text, by: g.by } }));
  const reminders: Timed[] = (run.reminders ?? []).map((r, i) => ({ at: r.at, seq: 0, entry: { kind: 'reminder', key: `reminder-${i}`, text: r.text } }));
  return [...thoughtEntries(run.thoughts), ...calls, ...guidance, ...reminders].sort(byTime).map((t) => t.entry);
}

/** A sub-agent's pane: the same thoughts and cards. */
export function subagentFeed(sub: SubagentView, now: number): FeedEntry[] {
  const calls: Timed[] = sub.tools.map((l, i) => ({ at: l.at, seq: l.seq ?? 0, entry: callEntry(undefined, l, undefined, now, i) }));
  return [...thoughtEntries(sub.thoughts), ...calls].sort(byTime).map((t) => t.entry);
}

/** 0.8s, 12s, 41s, 1m 12s: a card's duration. */
export function cardDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** An Edit card's line range from its hunks: "27–29". */
export function diffRange(line: ToolLine): string | undefined {
  const hunks = line.diff?.hunks;
  if (!hunks?.length) return undefined;
  const changed: number[] = [];
  for (const h of hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith('+')) changed.push(n);
      if (!l.startsWith('-')) n++;
    }
    if (!h.lines.some((l) => l.startsWith('+'))) changed.push(h.newStart);
  }
  const lo = Math.min(...changed);
  const hi = Math.max(...changed);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

/** The verdict as the header says it: "Verdict: bug, reproduced". */
export function verdictLabel(run: RunView): string | undefined {
  return run.verdict ? `Verdict: ${verdictWords(run.verdict)}` : undefined;
}

// ------------------------------------------------------------------ terminal v3 (screenshots 01, 03 and 04)

/** The run's own reporting tools: what they report shows elsewhere (steps in the header, the verdict, answers), never as a line. */
const REPORTS = new Set(['begin_step', 'heartbeat', 'declare_goal', 'report_result', 'report_verdict', 'declare_inputs', 'record_assumption', 'ask_user', 'ask_decision', 'request_check_approval', 'deliver', 'report_hypothesis', 'report_finding']);
export const isReport = (tool: string): boolean => REPORTS.has(tool.replace(/^mcp__run__/, ''));

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'mcp__run__jira', 'mcp__run__confluence', 'mcp__run__logs']);
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export type CallKind = 'read' | 'command' | 'edit' | 'agent';

/** What a call is, for a group's name: a read or search, a command (the shell or a proxy), an edit, a sub-agent. */
export function callKind(line: Pick<ToolLine, 'tool' | 'title'>): CallKind {
  if (READS.has(line.tool)) return 'read';
  if (EDITS.has(line.tool)) return 'edit';
  if (line.tool === 'Agent' || line.tool === 'Task') return 'agent';
  // A gh call that only reads is a read too.
  if (line.tool === 'mcp__run__gh' && /^(pr (view|list|diff|checks)|run (view|list)|api\b(?!.*-X\s*(POST|PATCH|PUT|DELETE)))/.test(line.title)) return 'read';
  return 'command';
}

const NOUNS: Record<CallKind, [string, string]> = { read: ['read or search', 'reads and searches'], command: ['command', 'commands'], edit: ['edit', 'edits'], agent: ['sub-agent', 'sub-agents'] };

/** "6 reads and searches", "4 commands", or "5 tool calls" when they are of different kinds. */
export function groupNoun(calls: Array<Pick<ToolLine, 'tool' | 'title'>>): string {
  const kinds = new Set(calls.map(callKind));
  const n = calls.length;
  if (kinds.size === 1) {
    const [one, many] = NOUNS[[...kinds][0]!];
    return `${n} ${n === 1 ? one : many}`;
  }
  return `${n} tool calls`;
}

/** A web read's domain, shown on its line: WebFetch's host. */
export function webDomain(line: Pick<ToolLine, 'tool' | 'title'>): string | undefined {
  if (line.tool !== 'WebFetch') return undefined;
  try {
    return new URL(line.title).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** One line of what a call came back with: "212 lines", "4 matches", the last line a command printed, or why it failed. */
export function resultSummary(line: ToolLine): string | undefined {
  if (!line.allowed) return 'not allowed';
  if (line.finishedAt === undefined || line.unfinished) return line.unfinished ? 'no result: the run ended first' : undefined;
  const lines = (line.output ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return line.stats;
  // A command's last line is what it ended with (tests passed, the error); anything else leads with its first.
  const pick = line.tool === 'Bash' && line.ok !== false ? lines.at(-1)! : lines[0]!;
  return pick.length > 140 ? `${pick.slice(0, 139)}…` : pick;
}

export type PaneEntry =
  | { kind: 'prose'; key: string; text: string }
  | { kind: 'call'; key: string; call: CallEntry; summary?: string; domain?: string }
  | { kind: 'group'; key: string; calls: Array<{ call: CallEntry; summary?: string; domain?: string }>; noun: string }
  | { kind: 'verdict'; key: string; label: string; detail?: string; points: string[]; stops: boolean }
  | { kind: 'answer'; key: string; decision: DecisionView }
  | { kind: 'assumption'; key: string; text: string; flag?: string }
  | { kind: 'question'; key: string; approval: ApprovalView }
  | { kind: 'note'; key: string; text: string; reminder: boolean };

const STOPS = new Set(['ALREADY_FIXED', 'EXPECTED_BEHAVIOR/INVALID', 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED']);

/** A call may join a group once it has ended well: a failed, refused or running one always shows on its own. */
const groupable = (e: CallEntry): boolean => e.status === 'done';

/** Three or more consecutive calls that ended well become one group; everything else stays as it is. */
function grouped(timeline: PaneEntry[]): PaneEntry[] {
  const out: PaneEntry[] = [];
  let run: Array<Extract<PaneEntry, { kind: 'call' }>> = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: 'group', key: `group-${run[0]!.key}`, calls: run.map((r) => ({ call: r.call, ...(r.summary ? { summary: r.summary } : {}), ...(r.domain ? { domain: r.domain } : {}) })), noun: groupNoun(run.map((r) => r.call.line)) });
    else out.push(...run);
    run = [];
  };
  for (const e of timeline) {
    if (e.kind === 'call' && groupable(e.call)) run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

const callItem = (e: CallEntry): Extract<PaneEntry, { kind: 'call' }> => {
  const summary = resultSummary(e.line);
  const domain = webDomain(e.line);
  return { kind: 'call', key: e.key, call: e, ...(summary ? { summary } : {}), ...(domain ? { domain } : {}) };
};

/**
 * What an agent's pane shows, in order: its prose, each call as one light line (three or more in a row that
 * ended well as one group), the verdict as a status line, Elfoqsy's answers to it, what it decided itself, guidance, and
 * any question waiting for alex at the end.
 */
export function paneEntries(run: RunView, state: Pick<WorkspaceState, 'decisions' | 'approvals'> & Partial<Pick<WorkspaceState, 'considering'>>, now: number): PaneEntry[] {
  const timed: Array<{ at: number; seq: number; entry: PaneEntry }> = [];
  for (const e of agentFeed(run, now)) {
    if (e.kind === 'thought') timed.push({ at: 0, seq: 0, entry: { kind: 'prose', key: e.key, text: e.text } });
    else if (e.kind === 'call') {
      if (isReport(e.line.tool)) continue;
      timed.push({ at: 0, seq: 0, entry: callItem(e) });
    } else timed.push({ at: 0, seq: 0, entry: { kind: 'note', key: e.key, text: e.kind === 'guidance' ? `${guideWho(e.by)}: ${e.text}` : `the workspace: ${e.text}`, reminder: e.kind === 'reminder' } });
  }
  // agentFeed is already in time order; the rest is placed by time among it.
  const base = timed.map((t, i) => ({ ...t, at: atOf(run, t.entry), seq: i }));
  const extra: typeof base = [];
  const v = run.verdict;
  if (v) {
    extra.push({
      at: v.at,
      seq: 1e6,
      entry: { kind: 'verdict', key: `verdict-${v.at}`, label: v.verdict, ...(verdictDetail(v) ? { detail: verdictDetail(v)! } : {}), points: (v.findings ?? []).map((f) => f.text).slice(0, 4), stops: STOPS.has(v.verdict) },
    });
  }
  for (const d of Object.values(state.decisions)) {
    if (d.runId === run.runId && d.requestKind === 'question') extra.push({ at: d.at, seq: 1e6 + 1, entry: { kind: 'answer', key: `answer-${d.decisionId}`, decision: d } });
  }
  for (const a of run.assumptions ?? []) extra.push({ at: a.at, seq: 1e6 + 2, entry: { kind: 'assumption', key: `as-${a.assumptionId}`, text: a.text, ...(a.flag ? { flag: a.flag } : {}) } });
  const merged = [...base, ...extra].sort((a, b) => a.at - b.at || a.seq - b.seq).map((t) => t.entry);
  const open = Object.values(state.approvals).filter((a) => a.runId === run.runId && !a.resolution).sort((a, b) => a.requestedAt - b.requestedAt);
  // What reached Elfoqsy first and is still with her: it shows before it becomes his, if it does.
  const considered = Object.values(state.considering ?? {}).filter((c) => c.runId === run.runId);
  return [
    ...grouped(merged),
    ...considered.map((c): PaneEntry => ({ kind: 'note', key: `elf-${c.requestId}`, text: `Elfoqsy is looking into ${c.requestKind === 'question' ? 'its question' : 'its request'}: ${c.summary}`, reminder: true })),
    ...open.map((approval): PaneEntry => ({ kind: 'question', key: `q-${approval.approvalId}`, approval })),
  ];
}

/** A sub-agent's pane: its prose and calls, grouped the same way. */
export function subagentEntries(sub: SubagentView, now: number): PaneEntry[] {
  return grouped(subagentFeed(sub, now).map((e): PaneEntry => (e.kind === 'call' ? callItem(e) : e.kind === 'thought' ? { kind: 'prose', key: e.key, text: e.text } : { kind: 'note', key: e.key, text: 'text' in e ? e.text : '', reminder: false })));
}

/** When an entry of agentFeed happened, for placing the verdict and answers among them. */
function atOf(run: RunView, e: PaneEntry): number {
  if (e.kind === 'call') return e.call.line.at;
  if (e.kind === 'prose') return run.thoughts?.find((t) => `thought-${t.seq}` === e.key)?.at ?? 0;
  if (e.kind === 'note') {
    const g = run.guidance.find((x) => `guidance-${x.seq}` === e.key);
    if (g) return g.at;
    const i = Number(e.key.replace('reminder-', ''));
    return run.reminders?.[i]?.at ?? 0;
  }
  return 0;
}

/** "reproduced", "not reproduced yet", or nothing. */
function verdictDetail(v: NonNullable<RunView['verdict']>): string | undefined {
  if (v.verdict === 'VALID') return v.reproduced ? 'reproduced' : 'not reproduced yet';
  if (v.verdict === 'VALID_FINDING') return 'reproduced from the scanner’s inputs';
  if (v.verdict === 'NEW_BEHAVIOR') return 'a story';
  return undefined;
}

/** The steps as the header shows them: a dot per step, the current one marked, and its name. */
export function stepDots(run: RunView): { dots: Array<'done' | 'failed' | 'abandoned' | 'current'>; current?: string } {
  const dots = run.steps.map((s) => (s.endedAt === undefined ? 'current' : s.outcome === 'failed' ? 'failed' : s.outcome === 'abandoned' ? 'abandoned' : 'done'));
  const current = run.steps.findLast((s) => s.endedAt === undefined)?.name ?? run.steps.at(-1)?.name;
  return { dots, ...(current ? { current } : {}) };
}
