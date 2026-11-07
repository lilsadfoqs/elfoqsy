// What a terminal pane says, as plain lines: the agent's own transcript, a sub-agent's, the steps strip
// and the status line. Pure and monochrome: colour lives only on dots, badges and bars.
import type { ApprovalView, RunView, StepView, SubagentView, ToolLine, WorkspaceState } from '@elfoqsy/state';
import { durationLabel, startsSubagent, tokensLabel, toolWords } from '@elfoqsy/state';

export interface TermLine {
  kind: 'call' | 'out' | 'guidance' | 'reminder';
  /** Bold tool name, on call lines. */
  tool?: string;
  text: string;
  /** A report (heartbeat, step) Elfoqsy has acknowledged. */
  acked?: boolean;
  /** A call through a proxy: its tier. */
  tier?: 0 | 1 | 2 | 3;
  /** What it changed, recorded before it ran, and whether Undo can put it back. */
  change?: { recordId: string; undo?: string; noUndo?: string; undone: boolean };
}

const GUIDE_WHO = { you: 'alex', tester: 'the tester', elfoqsy: 'Elfoqsy', agent: 'the agent', orchestrator: 'the workspace' } as const;

/** Whether the report a heartbeat or begin_step call made has been acknowledged by Elfoqsy. */
function acked(run: RunView, line: ToolLine): boolean | undefined {
  const name = toolName(line.tool);
  const end = line.finishedAt ?? Number.POSITIVE_INFINITY;
  const within = (t: number) => t >= line.at && t <= end;
  const seq =
    name === 'heartbeat' ? run.heartbeats.find((h) => within(h.at))?.seq : name === 'begin_step' ? run.steps.find((s) => within(s.beganAt))?.seq : undefined;
  return seq === undefined ? undefined : run.acked.includes(seq);
}

const OUTPUT_LINES = 6;
const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** "mcp__run__request_check_approval" -> "request_check_approval". */
export const toolName = (tool: string): string => tool.replace(/^mcp__[^_]+__/, '');

function outputLines(line: ToolLine, waiting: boolean, now: number): TermLine[] {
  if (!line.allowed) return [{ kind: 'out', text: '└ not allowed' }];
  if (line.finishedAt === undefined) {
    return [{ kind: 'out', text: waiting ? '└ waiting for alex' : `└ running  ${durationLabel(now - line.at)}` }];
  }
  if (line.unfinished) return [{ kind: 'out', text: '└ no result: the run ended first' }];
  if (line.tool === 'Read' || !line.output?.trim()) return [];
  const text = line.output.split('\n').filter((l) => l.trim()).slice(0, OUTPUT_LINES);
  // A diff is shown as it is; other output hangs off its call.
  if (DIFF_TOOLS.has(line.tool)) return text.map((t) => ({ kind: 'out', text: t }));
  return text.map((t, i) => ({ kind: 'out', text: `${i === 0 ? '└' : ' '} ${t}` }));
}

/** The agent's own transcript. Sub-agents' work is in their own panes, never here. */
export function transcriptLines(run: RunView, now: number): TermLine[] {
  const own = run.transcript.filter((l) => !startsSubagent(l));
  const waitingOn = run.state === 'waiting_for_you' ? [...own].reverse().find((l) => l.finishedAt === undefined && l.allowed) : undefined;
  const calls = own.map((l) => {
    const seen = acked(run, l);
    return {
      at: l.at,
      lines: [
        {
          kind: 'call' as const,
          tool: toolName(l.tool),
          text: `${l.title}${l.stats ? `  ${l.stats}` : ''}`,
          ...(seen !== undefined ? { acked: seen } : {}),
          ...(l.action ? { tier: l.action.tier } : {}),
          ...(l.change ? { change: { recordId: l.change.recordId, ...(l.change.undo ? { undo: l.change.undo } : {}), ...(l.change.noUndo ? { noUndo: l.change.noUndo } : {}), undone: !!l.change.undone } } : {}),
        },
        ...outputLines(l, l === waitingOn, now),
      ],
    };
  });
  // Guidance from the pane sits in the transcript where it was given.
  const guidance = run.guidance.map((g) => ({ at: g.at, lines: [{ kind: 'guidance' as const, text: `${GUIDE_WHO[g.by]}: ${g.text}` }] }));
  // So are the workspace's reminders, muted: they are not anyone's guidance.
  const reminders = (run.reminders ?? []).map((r) => ({ at: r.at, lines: [{ kind: 'reminder' as const, text: `the workspace: ${r.text}` }] }));
  return [...calls, ...guidance, ...reminders].sort((a, b) => a.at - b.at).flatMap((x) => x.lines);
}

/** What a sub-agent did: each tool call and the first line of what came back. */
export function subagentLines(sub: SubagentView): TermLine[] {
  return sub.tools.flatMap((l) => {
    const first = l.output?.split('\n').find((x) => x.trim());
    return [{ kind: 'call' as const, tool: toolName(l.tool), text: l.title }, ...(first && first !== 'running' ? [{ kind: 'out' as const, text: `└ ${first}` }] : [])];
  });
}

/** 54s, 1.2m: how long a sub-agent ran, as the stack and timeline show it. */
export function shortDuration(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 1 ? `${Math.round(minutes * 60)}s` : `${Math.round(minutes * 10) / 10}m`;
}

export const subagentElapsed = (sub: SubagentView, now: number): number => (sub.finishedAt ?? now) - sub.startedAt;

/** "running 1.2m" or "done, 54s". */
export function subagentMeta(sub: SubagentView, now: number): string {
  const d = shortDuration(subagentElapsed(sub, now));
  return sub.outcome ? `${sub.outcome}, ${d}` : `running ${d}`;
}

/** Its result once finished; while it runs, what it is doing and for how long. */
export function subagentResult(sub: SubagentView, now: number): string {
  if (sub.outcome) return sub.result || sub.outcome;
  const last = sub.tools.at(-1);
  const elapsed = durationLabel(now - sub.startedAt);
  if (!last) return `Working, ${elapsed}`;
  const w = toolWords({ tool: toolName(last.tool), title: last.title });
  return `${w.verb} ${w.object}, ${elapsed}`;
}

/** Running sub-agents first, then the most recently started. */
export function stackOrder(run: RunView): SubagentView[] {
  return [...run.subagents].sort((a, b) => (a.outcome ? 1 : 0) - (b.outcome ? 1 : 0) || b.startedAt - a.startedAt);
}

export function subagentCounts(run: RunView): { label: string; outcome: 'running' | 'done' | 'failed' | 'cancelled' }[] {
  const counts = { running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const s of run.subagents) counts[s.outcome ?? 'running']++;
  return (['running', 'done', 'failed', 'cancelled'] as const).filter((k) => counts[k]).map((k) => ({ outcome: k, label: `${counts[k]} ${k}` }));
}

export function pendingApproval(s: WorkspaceState, runId: string): ApprovalView | null {
  return Object.values(s.approvals).find((a) => a.runId === runId && !a.resolution) ?? null;
}

/** The approval line's question, short: "push feature/SHOP-3546?" */
export function approvalPrompt(approval: ApprovalView, run: RunView): string {
  if (approval.kind === 'push') return `push ${run.branch}?`;
  if (approval.kind === 'question') return approval.question;
  return approval.action ? `${approval.action}?` : approval.question;
}

export function runTokens(run: RunView): number {
  return run.usage?.tokens ?? run.heartbeats.at(-1)?.tokens ?? 0;
}

/** "step 3, 412k of 3M tokens, waiting for you". */
export function statusLine(run: RunView): string {
  const parts = [run.steps.length ? `step ${run.steps.length}` : 'starting'];
  const tokens = tokensLabel(runTokens(run));
  parts[0] += `, ${run.budget ? `${tokens} of ${tokensLabel(run.budget.tokens)}` : tokens} tokens`;
  if (run.state === 'waiting_for_you') parts.push('waiting for you');
  if (run.state === 'failed') parts.push(run.reason ? `failed: ${run.reason}` : 'failed');
  if (run.dismissed) parts.push(`dismissed by ${run.dismissed.by === 'tester' ? 'the tester' : 'you'}`);
  // Held by the workspace (waiting for a fresh AWS session) says why; otherwise who paused it.
  if (run.paused) {
    parts.push(
      run.paused.by === 'orchestrator'
        ? (run.paused.reason ?? 'paused by the workspace').replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())
        : `paused by ${run.paused.by === 'tester' ? 'the tester' : run.paused.by === 'elfoqsy' ? 'Elfoqsy' : 'you'}`,
    );
  }
  const flag = run.flags.at(-1);
  if (flag) parts.push(flag.detail.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()));
  return parts.join(', ');
}

export type StepChip = { name: string; state: 'current' | 'done' | 'failed' | 'abandoned' };

export function stepChips(run: RunView): StepChip[] {
  return run.steps.map((s: StepView) => ({
    name: s.name,
    state: s.endedAt === undefined ? 'current' : s.outcome === 'failed' ? 'failed' : s.outcome === 'abandoned' ? 'abandoned' : 'done',
  }));
}

/**
 * What holds a run or what Elfoqsy flagged, for the line above its input (v3): paused and by whom, or its latest flag.
 * Undefined while nothing does: the pane says no more than it must.
 */
export function holdNote(run: RunView): string | undefined {
  if (run.paused) {
    return run.paused.by === 'orchestrator'
      ? (run.paused.reason ?? 'Paused by the workspace.')
      : `Paused by ${run.paused.by === 'tester' ? 'the tester' : run.paused.by === 'elfoqsy' ? 'Elfoqsy' : 'you'}.`;
  }
  const flag = run.flags.at(-1);
  return flag && run.state !== 'succeeded' ? flag.detail : undefined;
}
