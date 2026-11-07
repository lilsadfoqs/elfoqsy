// When Elfoqsy may speak first (prompts/elfoqsy-system-prompt.md, "When to speak first"). Only live
// changes count, never history; a burst of changes becomes one short turn; the same thing is never
// raised twice. She still decides whether it is worth saying anything.
import type { Actor, AnyEnvelope } from '@elfoqsy/contracts';
import { CARRIED_OVER_WARNING, activeRuns, carriedOver, prKey, runLabel, type RunView, type WorkspaceState } from '@elfoqsy/state';
import { realClock, type Clock } from '../clock';
import type { LiveState } from './liveState';

export interface Notice {
  /** Same id, same thing: raised once. */
  id: string;
  text: string;
  /** What it is about, so it goes to that ticket's (or run's) conversation. */
  ticket?: string;
  runId?: string;
}

/** What a single change gives her to consider, if anything. Pure. */
export function noticesFor(previous: WorkspaceState, event: AnyEnvelope, next: WorkspaceState): Notice[] {
  switch (event.type) {
    case 'ci.status': {
      const p = event.payload;
      const key = prKey({ repo: p.repo, number: p.pr });
      const pr = next.prs[key];
      if (p.status !== 'failure' || !pr || (pr.state !== 'open' && pr.state !== 'draft')) return [];
      if (previous.ci[key]?.status === 'failure') return [];
      return [{ id: `ci-failed:${key}:${p.sha}`, text: `CI failed on ${p.repo} #${p.pr} (${pr.ticket}).`, ticket: pr.ticket }];
    }
    case 'ticket.synced': {
      const t = event.payload.ticket;
      const before = previous.tickets[t.key];
      const notices: Notice[] = [];
      if (t.status === 'Blocked' && before?.status !== 'Blocked') {
        notices.push({ id: `blocked:${t.key}`, text: `${t.key} is now Blocked. It is ${t.priority}.`, ticket: t.key });
      }
      const carried = carriedOver(t);
      const nobodyOnIt = !activeRuns(next).some((r) => r.ticket === t.key);
      const open = t.status !== 'Done' && t.status !== 'Released' && t.status !== 'Cancelled';
      if (open && nobodyOnIt && carried >= CARRIED_OVER_WARNING && (!before || carriedOver(before) < CARRIED_OVER_WARNING)) {
        notices.push({ id: `carried:${t.key}:${carried}`, text: `${t.key} has been carried over ${carried} sprints and nobody is on it.`, ticket: t.key });
      }
      return notices;
    }
    case 'run.state_changed': {
      // Waiting for Alex needs no turn from her: the orchestrator already posted the question.
      // A budget stop arrives here too, as a failure whose reason names the budget.
      const run = next.runs[event.payload.runId];
      if (!run) return [];
      const who = `Agent ${run.agentNumber} on ${runLabel(run)}`;
      const why = event.payload.reason ? `: ${event.payload.reason}` : '.';
      const about = { ticket: run.ticket, runId: run.runId };
      const made = decisionsMade(run);
      if (event.payload.state === 'failed') return [{ id: `run-end:${run.runId}`, text: `${who} failed${why}${made}`, ...about }];
      if (event.payload.state === 'succeeded') return [{ id: `run-end:${run.runId}`, text: `${who} finished${why}${made}`, ...about }];
      if (event.payload.state === 'stopped') return [{ id: `run-end:${run.runId}`, text: `${who} stopped without finishing${why}${made}`, ...about }];
      return [];
    }
    case 'run.flag': {
      const run = next.runs[event.payload.runId];
      if (!run) return [];
      const loops = run.flags.filter((f) => f.kind === 'loop').length;
      const extra = event.payload.kind !== 'loop' ? '' : loops > 1 ? ` It is still looping: loop flag ${loops} for this run.` : ' This is its first loop flag.';
      return [{ id: `flag:${event.seq}`, text: `Agent ${run.agentNumber} on ${run.ticket}: ${event.payload.detail}${extra}`, ticket: run.ticket, runId: run.runId }];
    }
    // Interventions she did not make herself: noted in one line, and the re-plan watched.
    case 'run.paused':
    case 'run.resumed':
    case 'run.guidance': {
      const p = event.payload;
      const run = next.runs[p.runId];
      if (!run || p.by === 'elfoqsy' || ('reason' in p && p.reason?.startsWith(THROUGH_ELFOQSY))) return [];
      const who = WHO[p.by] ?? p.by;
      const about = { ticket: run.ticket, runId: run.runId };
      const agent = `Agent ${run.agentNumber} on ${run.ticket}`;
      if (event.type === 'run.guidance') {
        return [{ id: `guidance:${event.seq}`, text: `${who} gave ${agent} guidance from its pane (paused, given, resumed): "${event.payload.text}"`, ...about }];
      }
      // Guidance from the pane pauses and resumes around it; the guidance line says it all.
      if (event.type === 'run.paused') return event.payload.reason === GUIDANCE_PAUSE ? [] : [{ id: `paused:${event.seq}`, text: `${who} paused ${agent}.`, ...about }];
      return previous.runs[p.runId]?.paused?.reason === GUIDANCE_PAUSE ? [] : [{ id: `resumed:${event.seq}`, text: `${who} resumed ${agent}.`, ...about }];
    }
    case 'run.step_begun': {
      // The first step after guidance is its re-plan.
      const before = previous.runs[event.payload.runId];
      const run = next.runs[event.payload.runId];
      const guided = before?.guidance.at(-1);
      const lastStep = before?.steps.at(-1);
      const after = (step: NonNullable<typeof lastStep>) => (step.seq !== undefined ? step.seq > guided!.seq : step.beganAt > guided!.at);
      if (!run || !guided || (lastStep && after(lastStep))) return [];
      return [
        {
          id: `replanned:${event.seq}`,
          text: `Agent ${run.agentNumber} on ${run.ticket} re-planned after the guidance: it began "${event.payload.name}": ${event.payload.why}`,
          ticket: run.ticket,
          runId: run.runId,
        },
      ];
    }
    default:
      return [];
  }
}

const WHO: Partial<Record<Actor, string>> = { you: 'alex', tester: 'The tester' };

/** The decisions a run made itself, flagged ones first, for its hand-back: "" when it made none. */
export function decisionsMade(run: RunView): string {
  const all = [...(run.assumptions ?? [])].sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0));
  if (!all.length) return '';
  return `\nDecisions it made (list them under "Decisions it made", as given; flagged ones are his at review):\n${all.map((a) => `- ${a.flag ? `[${a.flag}] ` : ''}${a.text}`).join('\n')}`;
}
/** The reason a pane's guidance gives the pause around it. */
export const GUIDANCE_PAUSE = 'To give guidance';
/** Pauses and resumes she makes herself carry this reason, so they are not told back to her. */
export const THROUGH_ELFOQSY = 'Through Elfoqsy';

export class Notifier {
  private readonly raised = new Set<string>();
  private pending: Notice[] = [];
  private timer: unknown;
  private readonly unsubscribe: () => void;

  constructor(
    live: LiveState,
    private readonly deliver: (notices: Notice[]) => void,
    private readonly clock: Clock = realClock,
    private readonly windowMs = 5000,
  ) {
    this.unsubscribe = live.onEvent((previous, event, next) => {
      for (const notice of noticesFor(previous, event, next)) this.add(notice);
    });
  }

  close(): void {
    this.unsubscribe();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
  }

  private add(notice: Notice): void {
    if (this.raised.has(notice.id)) return;
    this.raised.add(notice.id);
    this.pending.push(notice);
    this.timer ??= this.clock.setTimeout(() => this.flush(), this.windowMs);
  }

  private flush(): void {
    this.timer = undefined;
    const notices = this.pending;
    this.pending = [];
    if (notices.length) this.deliver(notices);
  }
}
