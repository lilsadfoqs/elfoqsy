// Analytics, computed from the event log alone: per run, then per period for the weekly review. Pure, so
// the same log always gives the same numbers. A dismissed run still counts as failed.
import type { AnyEnvelope, PlanCheck } from '@elfoqsy/contracts';

const ENDED = new Set(['succeeded', 'stopped', 'failed', 'cancelled']);

export interface SubagentStat {
  model: string;
  effort: string;
  /** The task's first word, lower case: "run", "review", "find"... */
  kind: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'running';
  tokens: number;
  durationMs: number;
}

export interface RunStat {
  runId: string;
  ticket: string;
  agentNumber: number;
  /** Its last state, and whether a failure was dismissed. */
  state: string;
  dismissed: boolean;
  createdAt: number;
  endedAt?: number;
  steps: Array<{ name: string; ms: number; tokens: number; outcome?: string }>;
  waitingMs: number;
  pausedMs: number;
  workingSeconds: number;
  tokens: number;
  subagents: SubagentStat[];
  ciFailures: number;
  retries: number;
  /** Goal and checks declared again after the first time. */
  planChanges: number;
  /** Changes of a check's status. */
  checkChanges: number;
  /** Guidance given, and pauses without guidance. */
  interventions: number;
  /** Checks without passing evidence when the run ended. */
  evidenceMissing: number;
}

/**
 * When the daemon was off: from its last event before each restart to the restart. A restart is a
 * daemon.started event, or (before those existed) the failure the startup recovery gives a run that was
 * active when the daemon stopped. Time in these gaps is neither waiting, paused, nor working.
 */
export function daemonGaps(events: readonly AnyEnvelope[]): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = [];
  let last: number | undefined;
  for (const e of events) {
    const t = Date.parse(e.ts);
    const restart = e.type === 'daemon.started' || (e.type === 'run.state_changed' && e.payload.state === 'failed' && !!e.payload.reason?.startsWith('The daemon restarted'));
    if (restart) {
      if (last !== undefined && t > last && !gaps.some((g) => g.from === last)) gaps.push({ from: last, to: t });
    } else last = t;
  }
  return gaps;
}

const kindOf = (task: string): string => (task.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '') || 'other';

/** Every run in the log, as of `now`. */
export function runStats(events: readonly AnyEnvelope[], now: number): RunStat[] {
  const gaps = daemonGaps(events);
  /** How long [a, b) lasted while the daemon was running. */
  const span = (a: number, b: number) => Math.max(0, b - a - gaps.reduce((n, g) => n + Math.max(0, Math.min(b, g.to) - Math.max(a, g.from)), 0));
  const runs = new Map<
    string,
    RunStat & {
      _wait?: number;
      _pause?: number;
      _guided?: boolean;
      _step?: { name: string; at: number; tokens: number };
      _running?: number;
      _runningMs: number;
      _usage: boolean;
      _checks: Map<string, string>;
      _subs: Map<string, SubagentStat & { at: number }>;
    }
  >();
  const prTicket = new Map<string, string>();
  const at = (e: AnyEnvelope) => Date.parse(e.ts);
  for (const e of events) {
    if (e.type === 'pr.synced') prTicket.set(`${e.payload.pr.repo}#${e.payload.pr.number}`, e.payload.pr.ticket);
    if (e.type === 'run.created') {
      const p = e.payload;
      runs.set(p.runId, {
        runId: p.runId,
        ticket: p.ticket,
        agentNumber: p.agentNumber,
        state: 'queued',
        dismissed: false,
        createdAt: at(e),
        steps: [],
        waitingMs: 0,
        pausedMs: 0,
        workingSeconds: 0,
        tokens: 0,
        subagents: [],
        ciFailures: 0,
        retries: 0,
        planChanges: 0,
        checkChanges: 0,
        interventions: 0,
        evidenceMissing: 0,
        _runningMs: 0,
        _usage: false,
        _checks: new Map(),
        _subs: new Map(),
      });
      continue;
    }
    if (e.type === 'ci.status' && e.payload.status === 'failure') {
      const ticket = prTicket.get(`${e.payload.repo}#${e.payload.pr}`);
      for (const r of runs.values()) if (r.ticket === ticket && r.endedAt === undefined) r.ciFailures++;
      continue;
    }
    const runId = (e.payload as { runId?: string }).runId;
    const r = runId ? runs.get(runId) : undefined;
    if (!r) continue;
    const t = at(e);
    switch (e.type) {
      case 'run.state_changed': {
        const s = e.payload.state;
        if (r._wait !== undefined && s !== 'waiting_for_you') {
          r.waitingMs += span(r._wait, t);
          r._wait = undefined;
        }
        if (r._running !== undefined && s !== 'running') {
          r._runningMs += span(r._running, t);
          r._running = undefined;
        }
        if (s === 'waiting_for_you') r._wait ??= t;
        if (s === 'running' && r.endedAt === undefined) r._running ??= t;
        if (ENDED.has(s) && r.endedAt === undefined) {
          r.endedAt = t;
          if (r._step) closeStep(r, span(r._step.at, t), undefined);
          if (r._pause !== undefined) r.pausedMs += span(r._pause, t);
          r._pause = undefined;
          r.evidenceMissing = [...r._checks.values()].filter((v) => v !== 'passed').length;
        }
        r.state = s;
        break;
      }
      case 'run.dismissed':
        r.dismissed = true;
        break;
      case 'run.goal_declared':
        if (e.payload.revision > 1 || r._checks.size) r.planChanges++;
        r._checks = new Map(e.payload.checks.map((c: PlanCheck) => [c.id, r._checks.get(c.id) ?? 'pending']));
        break;
      case 'run.check_changed':
        r.checkChanges++;
        r._checks.set(e.payload.checkId, e.payload.status);
        break;
      case 'run.step_begun':
        if (r._step) closeStep(r, span(r._step.at, t), undefined);
        r._step = { name: e.payload.name, at: t, tokens: r.tokens };
        break;
      case 'run.step_ended':
        if (r._step) closeStep(r, span(r._step.at, t), e.payload.outcome);
        break;
      case 'run.usage':
        r.tokens = Math.max(r.tokens, e.payload.tokens);
        r.workingSeconds = e.payload.workingSeconds;
        r._usage = true;
        break;
      case 'run.paused':
        r._pause ??= t;
        r._guided = false;
        break;
      case 'run.guidance':
        r.interventions++;
        r._guided = true;
        break;
      case 'run.resumed':
        if (r._pause !== undefined) r.pausedMs += span(r._pause, t);
        if (r._guided === false) r.interventions++; // a pause to stop and think
        r._pause = undefined;
        r._guided = undefined;
        break;
      case 'tool.called':
        if (!e.payload.subagentId && /request_ci_rerun$/.test(e.payload.tool)) r.retries++;
        break;
      case 'subagent.started': {
        const p = e.payload;
        const sub = { model: p.model, effort: p.effort, kind: kindOf(p.task), outcome: 'running' as const, tokens: 0, durationMs: 0, at: t };
        r._subs.set(p.subagentId, sub);
        break;
      }
      case 'subagent.finished': {
        const sub = r._subs.get(e.payload.subagentId);
        if (sub) Object.assign(sub, { outcome: e.payload.outcome, tokens: e.payload.tokens, durationMs: e.payload.durationMs });
        break;
      }
    }
  }
  return [...runs.values()].map((r) => {
    if (r._wait !== undefined) r.waitingMs += span(r._wait, now);
    if (r._pause !== undefined) r.pausedMs += span(r._pause, now);
    if (r._running !== undefined) r._runningMs += span(r._running, now);
    if (r._step) r.steps.push({ name: r._step.name, ms: span(r._step.at, now), tokens: r.tokens - r._step.tokens });
    // Runs from before run.usage existed: their time running stands in for working time.
    if (!r._usage) r.workingSeconds = Math.round(r._runningMs / 1000);
    const { _wait, _pause, _guided, _step, _running, _runningMs, _usage, _checks, _subs, ...stat } = r;
    return { ...stat, subagents: [..._subs.values()].map(({ at: _at, ...s }) => s) };
  });
}

/** Closes the open step, which lasted `ms` while the daemon was running. */
function closeStep(r: RunStat & { _step?: { name: string; at: number; tokens: number } }, ms: number, outcome: string | undefined): void {
  const s = r._step!;
  r.steps.push({ name: s.name, ms, tokens: r.tokens - s.tokens, ...(outcome ? { outcome } : {}) });
  r._step = undefined;
}

/**
 * alex's tickets worked with the team-dev skill alone, before Elfoqsy ran them (~/team-dev-retrospective.md,
 * 2026-10-11): active hours and substantive interventions per ticket. The weekly review's baseline.
 */
export const SHOP_DEV_BASELINE = {
  source: 'the team-dev retrospective of 11 October 2026',
  tickets: [
    { key: 'SHOP-2430', hours: 10.7, interventions: 25 },
    { key: 'SHOP-3389', hours: 8.1, interventions: 25 },
    { key: 'SHOP-3276', hours: 10.4, interventions: 22 },
    { key: 'SHOP-3394', hours: 4.6, interventions: 22 },
    { key: 'SHOP-3472', hours: 3.8, interventions: 21 },
    { key: 'SHOP-3490', hours: 1.1, interventions: 12 },
    { key: 'SHOP-3507', hours: 0.2, interventions: 2 },
    { key: 'SHOP-3567', hours: 3.2, interventions: 18 },
  ],
} as const;

const tenth = (n: number): number => Math.round(n * 10) / 10;

/** The baseline per ticket: 5.3 active hours and 18.4 interventions. */
export const baselinePerTicket = (): { hours: number; interventions: number } => {
  const t = SHOP_DEV_BASELINE.tickets;
  return { hours: tenth(t.reduce((n, x) => n + x.hours, 0) / t.length), interventions: tenth(t.reduce((n, x) => n + x.interventions, 0) / t.length) };
};

/** A gap between two events on a ticket that still counts as working on it, as the retrospective counted. */
export const ACTIVE_GAP_MS = 30 * 60_000;

export interface TicketStat {
  ticket: string;
  /** The sum of gaps of 30 minutes or less between consecutive events on the ticket: its runs' and its conversations'. */
  activeHours: number;
  /** alex stepping in: guidance and pauses, his answers to its runs' questions and approvals, his messages about it. */
  interventions: number;
}

/**
 * Active hours and interventions per ticket in [from, to), measured as the team-dev retrospective measured its
 * baseline: an event belongs to a ticket through its run or its conversation; the tester's messages and answers do
 * not count as his.
 */
export function ticketStats(events: readonly AnyEnvelope[], from: number, to: number): TicketStat[] {
  const runTicket = new Map<string, string>();
  const convTicket = new Map<string, string>();
  const approvalRun = new Map<string, string>();
  const times = new Map<string, number[]>();
  const interventions = new Map<string, number>();
  const touch = (ticket: string | undefined, t: number, intervention = false) => {
    if (!ticket || t < from || t >= to) return;
    times.set(ticket, [...(times.get(ticket) ?? []), t]);
    if (intervention) interventions.set(ticket, (interventions.get(ticket) ?? 0) + 1);
  };
  for (const e of events) {
    const t = Date.parse(e.ts);
    switch (e.type) {
      case 'run.created':
        runTicket.set(e.payload.runId, e.payload.ticket);
        touch(e.payload.ticket, t);
        continue;
      case 'conversation.created':
      case 'conversation.renamed':
        if (e.payload.ticket) convTicket.set(e.payload.conversationId, e.payload.ticket);
        continue;
      case 'approval.requested':
        approvalRun.set(e.payload.approvalId, e.payload.runId);
        touch(runTicket.get(e.payload.runId), t);
        continue;
      case 'approval.resolved': {
        const runId = approvalRun.get(e.payload.approvalId);
        touch(runId ? runTicket.get(runId) : undefined, t, !e.payload.test && !!runId && runTicket.has(runId));
        continue;
      }
      case 'elfoqsy.message':
        touch(e.payload.conversationId ? convTicket.get(e.payload.conversationId) : undefined, t, e.payload.role === 'you');
        continue;
      case 'run.guidance':
        touch(runTicket.get(e.payload.runId), t, e.payload.by === 'you');
        continue;
      case 'run.paused':
        touch(runTicket.get(e.payload.runId), t, e.payload.by === 'you');
        continue;
    }
    const runId = (e.payload as { runId?: string }).runId;
    if (runId) touch(runTicket.get(runId), t);
  }
  return [...times.entries()]
    .map(([ticket, list]) => {
      const sorted = list.sort((a, b) => a - b);
      let ms = 0;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i]! - sorted[i - 1]!;
        if (gap <= ACTIVE_GAP_MS) ms += gap;
      }
      return { ticket, activeHours: tenth(ms / 3_600_000), interventions: interventions.get(ticket) ?? 0 };
    })
    .sort((a, b) => a.ticket.localeCompare(b.ticket));
}

export interface Rate {
  key: string;
  done: number;
  failed: number;
  cancelled: number;
  /** Done out of finished, 0 to 1. */
  successRate: number;
}

export interface PeriodStats {
  from: number;
  to: number;
  runs: RunStat[];
  /** Flat numbers, as review.weekly records them. */
  metrics: Record<string, number>;
  subagentsByModel: Rate[];
  subagentsByKind: Rate[];
  /** The slowest steps of the period, by name. */
  slowestSteps: Array<{ ticket: string; name: string; minutes: number }>;
  interventionsByTicket: Record<string, number>;
  /** Active hours and interventions per ticket, the way the team-dev baseline was measured. */
  tickets: TicketStat[];
}

function rates(subs: SubagentStat[], key: (s: SubagentStat) => string): Rate[] {
  const by = new Map<string, Rate>();
  for (const s of subs) {
    if (s.outcome === 'running') continue;
    const k = key(s);
    const r = by.get(k) ?? { key: k, done: 0, failed: 0, cancelled: 0, successRate: 0 };
    r[s.outcome]++;
    by.set(k, r);
  }
  return [...by.values()]
    .map((r) => ({ ...r, successRate: r.done / Math.max(1, r.done + r.failed + r.cancelled) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Runs that were at work at any time in [from, to), and what they add up to. */
export function periodStats(events: readonly AnyEnvelope[], from: number, to: number): PeriodStats {
  const runs = runStats(events, to).filter((r) => r.createdAt < to && (r.endedAt === undefined || r.endedAt >= from));
  const subs = runs.flatMap((r) => r.subagents);
  const sum = (f: (r: RunStat) => number) => runs.reduce((n, r) => n + f(r), 0);
  const count = (state: string) => runs.filter((r) => r.state === state).length;
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const interventionsByTicket: Record<string, number> = {};
  for (const r of runs) if (r.interventions) interventionsByTicket[r.ticket] = (interventionsByTicket[r.ticket] ?? 0) + r.interventions;
  const tickets = ticketStats(events, from, to).filter((t) => runs.some((r) => r.ticket === t.ticket));
  const baseline = baselinePerTicket();
  const decisions = decisionStats(events, from, to);
  return {
    from,
    to,
    runs,
    metrics: {
      periodStart: from,
      periodEnd: to,
      runs: runs.length,
      succeeded: count('succeeded'),
      stopped: count('stopped'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      stillActive: runs.filter((r) => r.endedAt === undefined).length,
      dismissed: runs.filter((r) => r.dismissed).length,
      tokens: sum((r) => r.tokens),
      workingMinutes: Math.round(sum((r) => r.workingSeconds) / 60),
      waitingMinutes: minutes(sum((r) => r.waitingMs)),
      pausedMinutes: minutes(sum((r) => r.pausedMs)),
      subagents: subs.length,
      subagentsFailed: subs.filter((s) => s.outcome === 'failed').length,
      subagentsCancelled: subs.filter((s) => s.outcome === 'cancelled').length,
      ciFailures: sum((r) => r.ciFailures),
      retries: sum((r) => r.retries),
      planChanges: sum((r) => r.planChanges),
      checkChanges: sum((r) => r.checkChanges),
      interventions: sum((r) => r.interventions),
      evidenceMissing: sum((r) => r.evidenceMissing),
      ticketsWorked: tickets.length,
      activeHours: tenth(tickets.reduce((n, t) => n + t.activeHours, 0)),
      activeHoursPerTicket: tickets.length ? tenth(tickets.reduce((n, t) => n + t.activeHours, 0) / tickets.length) : 0,
      interventionsPerTicket: tickets.length ? tenth(tickets.reduce((n, t) => n + t.interventions, 0) / tickets.length) : 0,
      baselineHoursPerTicket: baseline.hours,
      baselineInterventionsPerTicket: baseline.interventions,
      decisionsMade: decisions.made,
      decisionsChanged: decisions.changed,
      decisionsChangedPct: decisions.made ? Math.round((decisions.changed / decisions.made) * 100) : 0,
    },
    subagentsByModel: rates(subs, (s) => `${s.model} ${s.effort}`),
    subagentsByKind: rates(subs, (s) => s.kind),
    slowestSteps: runs
      .flatMap((r) => r.steps.map((s) => ({ ticket: r.ticket, name: s.name, minutes: minutes(s.ms) })))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 5),
    interventionsByTicket,
    tickets,
  };
}

/**
 * Elfoqsy's decisions as first responder made in [from, to), and how many of them alex changed or undid (at any
 * time up to the end of the log given): how often he overrides her, for Insights.
 */
export function decisionStats(events: readonly AnyEnvelope[], from: number, to: number): { made: number; changed: number } {
  const made = new Set<string>();
  const changed = new Set<string>();
  for (const e of events) {
    if (e.type === 'decision.made') {
      const at = Date.parse(e.ts);
      if (at >= from && at < to) made.add(e.payload.decisionId);
    } else if (e.type === 'decision.changed' && e.payload.by === 'you') changed.add(e.payload.decisionId);
  }
  return { made: made.size, changed: [...changed].filter((id) => made.has(id)).length };
}
