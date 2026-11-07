// What the screens say, derived from the folded state. Urgency follows prompts/elfoqsy-system-prompt.md
// on both screens: broken > waiting for you > blocked.
import type { Effort, Mood, Step, Ticket } from '@elfoqsy/contracts';
import { isRunActive, prKey, type ApprovalView, type ConversationView, type RunView, type SubagentView, type ToolLine, type WorkspaceState } from './fold';

/** One pair in the status cluster: what to look at, how many, and the full sentence its tooltip says. */
export interface StatusItem {
  kind: 'broken' | 'waiting' | 'blocked';
  count: number;
  sentence: string;
}

/** Elfoqsy's states, most urgent first. Each has three portraits, a fox badge and a ring colour. */
export type { Mood };
export const MOODS: readonly Mood[] = ['broken', 'needs', 'done', 'thinking', 'working', 'quiet'];
export const PORTRAITS_PER_MOOD = 3;
/** She looks pleased for this long after a run succeeds. */
export const DONE_MOOD_MS = 2 * 60_000;
/** A brief she started and never finished stops counting as thinking after this. */
export const BRIEF_WRITING_MS = 10 * 60_000;

/** A step as shown: the agent's own name for it. */
export const stepLabel = (step: Step): string => step;

/** "claude-opus-5-5" -> "Opus 5.5". Unknown ids are shown as they are. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!m) return model;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** "Opus 5.5, xhigh": how every agent and sub-agent is labelled. */
export const agentLabel = (model: string, effort: Effort): string => `${modelLabel(model)}, ${effort}`;

/** 412k, 1.1M, 3M: token amounts as the meters show them. */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 45s, 1m 12s, 18m, 1h 3m. */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What a tool call is doing, in plain words, as a verb and its object. */
export function toolWords(line: Pick<ToolLine, 'tool' | 'title'>): { verb: string; object: string; code: boolean } {
  const object = line.title;
  switch (line.tool) {
    case 'Bash':
      return { verb: 'Running', object, code: true };
    case 'Read':
      return { verb: 'Reading', object, code: true };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Editing', object, code: true };
    case 'Write':
      return { verb: 'Writing', object, code: true };
    case 'Grep':
      return { verb: 'Searching for', object, code: true };
    case 'Glob':
      return { verb: 'Listing', object, code: true };
    case 'Agent':
    case 'Task':
      return { verb: 'Starting a sub-agent:', object, code: false };
    default:
      return { verb: line.tool.replace(/^mcp__run__/, '').replace(/_/g, ' '), object, code: false };
  }
}

/** A call that started a sub-agent. Its work shows in the sub-agent's own record, never in the parent's transcript. */
export const startsSubagent = (line: Pick<ToolLine, 'tool'>): boolean => line.tool === 'Agent' || line.tool === 'Task';

/** What an agent is doing right now: its newest unfinished tool call of its own, and for how long. */
export function currentActivity(run: RunView, now: number): (ToolLine & { elapsedMs: number }) | null {
  for (let i = run.transcript.length - 1; i >= 0; i--) {
    const line = run.transcript[i]!;
    if (line.finishedAt === undefined && line.allowed && !startsSubagent(line)) return { ...line, elapsedMs: Math.max(0, now - line.at) };
  }
  return null;
}

export const runningSubagents = (run: RunView): SubagentView[] => run.subagents.filter((s) => s.finishedAt === undefined);

/** Story points of the sprint: done, in progress, to do (Blocked counts as to do, as on the agreed screens). Cancelled never counts. */
export function storyPoints(s: WorkspaceState): { done: number; inProgress: number; toDo: number } {
  const points = { done: 0, inProgress: 0, toDo: 0 };
  for (const t of Object.values(s.tickets)) {
    const n = t.storyPoints ?? 0;
    if (t.status === 'Cancelled') continue;
    if (t.status === 'Done' || t.status === 'Released') points.done += n;
    else if (t.status === 'In progress') points.inProgress += n;
    else points.toDo += n;
  }
  return points;
}

/** Conversations for the sidebar, newest activity first, grouped as Today, Yesterday and Earlier. */
export function conversationGroups(s: WorkspaceState, now: number): { label: 'Today' | 'Yesterday' | 'Earlier'; conversations: ConversationView[] }[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 24 * 3600_000;
  const all = Object.values(s.conversations).sort((a, b) => b.lastAt - a.lastAt);
  const groups = [
    { label: 'Today' as const, conversations: all.filter((c) => c.lastAt >= today) },
    { label: 'Yesterday' as const, conversations: all.filter((c) => c.lastAt >= yesterday && c.lastAt < today) },
    { label: 'Earlier' as const, conversations: all.filter((c) => c.lastAt < yesterday) },
  ];
  return groups.filter((g) => g.conversations.length);
}

export const CARRIED_OVER_WARNING = 6;

export const isOpen = (t: Ticket): boolean => t.status !== 'Done' && t.status !== 'Released' && t.status !== 'Cancelled';
export const isDone = (t: Ticket): boolean => t.status === 'Done' || t.status === 'Released';

/** Sprints a ticket was carried over: it has been in sprintsCarried sprints, this one included. */
export const carriedOver = (t: Ticket): number => Math.max(0, t.sprintsCarried - 1);

export const pendingApprovals = (s: WorkspaceState): ApprovalView[] =>
  Object.values(s.approvals)
    .filter((a) => !a.resolution)
    .sort((a, b) => a.requestedAt - b.requestedAt);

export const activeRuns = (s: WorkspaceState): RunView[] =>
  s.runOrder.map((id) => s.runs[id]!).filter((r) => r !== undefined && isRunActive(r));

export function isWaiting(s: WorkspaceState, run: RunView): boolean {
  return run.state === 'waiting_for_you' || pendingApprovals(s).some((a) => a.runId === run.runId);
}

export const isWorking = (s: WorkspaceState, run: RunView): boolean =>
  (run.state === 'running' || run.state === 'queued') && !isWaiting(s, run);

/** The run on a ticket that the screens should talk about: an active one, else the latest. */
export function runForTicket(s: WorkspaceState, key: string): RunView | undefined {
  const runs = s.runOrder.map((id) => s.runs[id]!).filter((r) => r.ticket === key);
  return runs.filter(isRunActive).at(-1) ?? runs.at(-1);
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * The quiet lines under the date: the workspace is offline (no socket), the daemon cannot reach Jira
 * or GitHub (three failed polls in a row), Claude has paused new work (a usage limit or the login), or
 * alex's AWS session is about to end or has ended. Each goes away on its own when things recover.
 */
export function statusLines(s: WorkspaceState, offlineSince: number | null): string[] {
  const lines: string[] = [];
  if (offlineSince !== null) lines.push(`Offline since ${clock(offlineSince)}`);
  if (s.sources.jira?.state === 'unreachable') lines.push(`Jira unreachable since ${clock(s.sources.jira.since)}`);
  if (s.sources.github?.state === 'unreachable') lines.push(`GitHub unreachable since ${clock(s.sources.github.since)}`);
  if (s.claude.state === 'limited') {
    lines.push(s.claude.until !== undefined ? `Claude paused until ${clock(s.claude.until)}` : `Claude paused since ${clock(s.claude.since)}`);
  }
  // alex's AWS session: under 20 minutes left, agents that need AWS wait for a refresh.
  if (s.aws?.state === 'expiring') lines.push(s.aws.expiresAt !== undefined ? `AWS session ends at ${clock(s.aws.expiresAt)}` : 'AWS session ending');
  if (s.aws?.state === 'expired') {
    const envs = Object.entries(s.aws.environments ?? {}).flatMap(([env, state]) => (state === 'expired' ? [env] : []));
    lines.push(envs.length ? `AWS session expired: ${envs.join(', ')}` : s.aws.expiresAt !== undefined ? `AWS session ended at ${clock(s.aws.expiresAt)}` : 'AWS session expired');
  }
  return lines;
}
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** CI fails on this open PR (whether or not the failure was dismissed: the PR stays red). */
export const ciFailing = (s: WorkspaceState, pr: { repo: string; number: number; state: string; checks?: string }): boolean =>
  (pr.state === 'open' || pr.state === 'draft') && (pr.checks === 'failure' || s.ci[prKey(pr)]?.status === 'failure');

/** The status cluster, most urgent first; only what is not zero. */
export function statusItems(s: WorkspaceState): StatusItem[] {
  const runs = activeRuns(s);
  // Broken: a run failed, or CI failed on one of alex's open PRs.
  const failedRuns = runs.filter((r) => r.state === 'failed').length;
  const failedPrs = Object.values(s.prs).filter((pr) => ciFailing(s, pr) && !s.ciDismissed[prKey(pr)]).length;
  const waiting = runs.filter((r) => isWaiting(s, r)).length;
  const blocked = Object.values(s.tickets).filter((t) => isOpen(t) && t.status === 'Blocked').length;

  const items: StatusItem[] = [];
  if (failedRuns + failedPrs) {
    const parts = [failedRuns ? `${plural(failedRuns, 'agent', 'agents')} failed` : '', failedPrs ? `CI failed on ${plural(failedPrs, 'pull request', 'pull requests')}` : ''];
    items.push({ kind: 'broken', count: failedRuns + failedPrs, sentence: parts.filter(Boolean).join(' and ') });
  }
  if (waiting) items.push({ kind: 'waiting', count: waiting, sentence: `${plural(waiting, 'agent needs', 'agents need')} you` });
  if (blocked) items.push({ kind: 'blocked', count: blocked, sentence: `${plural(blocked, 'ticket is', 'tickets are')} blocked` });
  return items;
}

/** One of `count` pictures at random, never `previous`: her portrait is never the same twice in a row. */
export function pickVariant(previous: number | undefined, count = PORTRAITS_PER_MOOD, random: () => number = Math.random): number {
  const choices = Array.from({ length: count }, (_, i) => i).filter((i) => i !== previous);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] ?? 0;
}

/**
 * Elfoqsy's state: broken, needs you, done (for 2 minutes after a run succeeds), thinking (an
 * investigation is running or she is writing a brief), working (any run active), quiet.
 */
export function mood(s: WorkspaceState, now: number): Mood {
  const items = statusItems(s);
  if (items.some((i) => i.kind === 'broken')) return 'broken';
  if (items.some((i) => i.kind === 'waiting')) return 'needs';
  if (Object.values(s.runs).some((r) => r.state === 'succeeded' && now - r.stateAt < DONE_MOOD_MS)) return 'done';
  const investigating = Object.values(s.investigations).some((i) => i.finishedAt === undefined);
  const writing = Object.values(s.briefsInProgress).some((at) => now - at < BRIEF_WRITING_MS);
  if (investigating || writing) return 'thinking';
  if (activeRuns(s).length) return 'working';
  return 'quiet';
}
