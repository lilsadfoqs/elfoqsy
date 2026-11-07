// Simulate mode: the world of the agreed v1 screens (sim/scenario.ts), written as history at the times it happened,
// then kept moving: sub-agents come and go, heartbeats arrive, and answers, guidance and messages get a reaction.
// Writes events only; it never touches Jira, GitHub or a model.
import { join } from 'node:path';
import type { AnyEnvelope, EventType, MessageBlock, PayloadOf, ProxyName, Ticket } from '@elfoqsy/contracts';
import { realClock, type Clock } from '../clock';
import type { EventLog } from '../eventLog';
import type { Grants } from '../permissions/grants';
import type { Proxies, ProxyRun } from '../permissions/proxy';
import type { Classified } from '../permissions/types';
import { ulid } from '../ulid';
import type { Mock } from './mock';
import {
  AGENTS,
  CONVERSATIONS,
  HANDOFF,
  DAY,
  ENDED_RUNS,
  FACTS,
  INVESTIGATION,
  MINUTE,
  USAGE,
  crowdAgents,
  startedAgent,
  type SimAgent,
  type SimSubagent,
} from './scenario';

export const simRunId = (agentNumber: number): string => `sim-run-${agentNumber}`;
const SIM_API = 'acme/shop-api';
const SIM_SHARED = 'acme/shop-shared';
const shortRepo = (repo: string): string => repo.split('/')[1] ?? repo;
export const simApprovalId = (agentNumber: number): string => `sim-approval-${agentNumber}`;

/** Agents the agreed screens show. More are generated to test crowding. */
export const SCENARIO_AGENTS = AGENTS.length;
/** A running sub-agent finishes and the next one starts this often, per working agent. */
const JOB_SECONDS = 20;
/** The agreed screens stay as they are this long before the first hand-over. */
const FIRST_JOB_SECONDS = 60;
const HEARTBEAT_SECONDS = 300;
const USAGE_SECONDS = 30;
/** How long a simulated investigator runs: long enough to see her thinking. */
const SIM_INVESTIGATION_SECONDS = 30;
const TICKET_AGENT = { model: 'claude-opus-5-5', effort: 'xhigh' as const, budget: { tokens: 3_000_000, minutes: 45 } };

export interface SimulatorOptions {
  worktreesRoot: string;
  clock?: Clock;
  now?: () => number;
  /** Pins the log's clock while history is written; null goes back to real time. */
  setTime?: (ms: number | null) => void;
  /** Agents on the map in total: the three of the agreed screens, and generated ones beyond. */
  agents?: number;
  /** The real tier policy over simulated backends: a bug started here hands back through it. */
  proxies?: Proxies;
  /** For "Allow for this ticket" on agent 4's question from history. */
  grants?: Grants;
}

type Mode = 'work' | 'failed' | 'silent' | 'spent';

interface LiveAgent {
  /** Paused from its pane: nothing moves until it is resumed. */
  paused?: boolean;
  agent: SimAgent & { mode?: Mode };
  runId: string;
  /** The sub-agent the live loop replaces each round, if any. */
  cycling?: { subagentId: string; sub: SimSubagent; startedAt: number; /** Its call in progress. */ toolUseId?: string };
  tokens: number;
  workingSeconds: number;
  step: { index: number; name: string } | null;
  stepCount: number;
  round: number;
}

export class Simulator {
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly timers = new Set<unknown>();
  private readonly live = new Map<string, LiveAgent>();
  /** Agent 4's question from history: marking its PR ready, by approval id. */
  private readonly readies = new Map<string, { runId: string; toolUseId: string; actionId: string; ticket: string; repo: string; pr: number }>();
  private unsubscribe: (() => void) | undefined;
  private t0 = 0;
  /** Open tickets, and the ones an agent is on. */
  private readonly open = new Set<string>();
  private readonly busy = new Map<string, number>();
  private nextAgent = 1;

  constructor(
    private readonly log: EventLog,
    private readonly mock: Mock,
    private readonly options: SimulatorOptions,
  ) {
    this.clock = options.clock ?? realClock;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.t0 = this.now();
    const extra = Math.max(0, (this.options.agents ?? SCENARIO_AGENTS) - SCENARIO_AGENTS);
    const crowd = crowdAgents(extra);
    for (const t of this.mock.sprint.openTickets) this.open.add(t.key);
    for (const a of crowd) this.open.add(a.ticket);
    this.nextAgent = Math.max(...[...AGENTS, ...crowd, ...ENDED_RUNS].map((a) => a.agentNumber)) + 1;
    this.emitSnapshot(crowd);
    this.writeHistory([...AGENTS, ...crowd]);
    this.unsubscribe = this.log.subscribe((event) => this.onEvent(event));
    for (const entry of this.live.values()) this.keepMoving(entry);
  }

  stop(): void {
    for (const handle of this.timers) this.clock.clearTimeout(handle);
    this.timers.clear();
    this.unsubscribe?.();
  }

  private emit<T extends EventType>(type: T, payload: PayloadOf<T>): Extract<AnyEnvelope, { type: T }> {
    return this.log.append('simulator', type, payload);
  }

  private after(seconds: number, fn: () => void): void {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, seconds * 1000);
    this.timers.add(handle);
  }

  private hhmm(minutesAgo: number): string {
    return new Date(this.t0 - minutesAgo * MINUTE).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  private emitSnapshot(crowd: SimAgent[]): void {
    const { sprint } = this.mock;
    for (const t of sprint.openTickets) {
      const { descriptionSummary, ...rest } = t;
      this.emit('ticket.synced', { ticket: { ...rest, description: descriptionSummary } });
    }
    // The snapshot keeps only the headline fields of closed tickets; the rest is filled in plainly.
    for (const t of sprint.closedTickets) {
      const board = t.key.split('-')[0] ?? '';
      const ticket: Ticket = {
        ...t,
        board,
        sprint: sprint.jira.sprints.find((s) => s.board === board)?.name ?? '',
        sprintsCarried: 1,
        epic: null,
        reporter: '',
        created: '',
        updated: '',
        labels: [],
        linked: [],
        description: '',
      };
      this.emit('ticket.synced', { ticket });
    }
    for (const a of crowd) {
      this.emit('ticket.synced', {
        ticket: {
          key: a.ticket,
          board: 'SHOP',
          summary: 'Generated to test crowding',
          type: 'Bug',
          status: 'To do',
          priority: 'Minor',
          storyPoints: 1,
          sprint: 'SHOP Sprint 52',
          sprintsCarried: 1,
          epic: null,
          reporter: '',
          created: '',
          updated: '',
          labels: [],
          linked: [],
          description: '',
        },
      });
    }
    for (const pr of sprint.pullRequests) {
      // The GitHub organisation is not known in the snapshot, so the simulated PRs carry no URL.
      this.emit('pr.synced', { pr: { ...pr, url: '', checks: 'none' } });
      this.emit('ci.status', { repo: pr.repo, pr: pr.number, sha: `3f2c1a7${pr.number}`, status: 'success', url: '' });
    }
  }

  /** Everything before now, in the order it happened, each event at its own time. */
  private writeHistory(agents: (SimAgent & { mode?: Mode })[]): void {
    const items: { at: number; order: number; run: () => void }[] = [];
    let order = 0;
    const add = (minutesAgo: number, run: () => void) => items.push({ at: minutesAgo, order: order++, run });

    for (const run of ENDED_RUNS) this.endedRun(run, add);
    this.conversations(add);
    for (const agent of agents) this.agentHistory(agent, add);

    add(0.02, () =>
      this.emit('usage.status', {
        fiveHourPct: USAGE.fiveHourPct,
        sevenDayPct: USAGE.sevenDayPct,
        resetsAt: new Date(this.t0 + USAGE.resetsInMinutes * MINUTE).toISOString(),
      }),
    );

    items.sort((a, b) => b.at - a.at || a.order - b.order);
    for (const item of items) {
      this.options.setTime?.(this.t0 - item.at * MINUTE);
      item.run();
    }
    this.options.setTime?.(null);
  }

  private endedRun(run: (typeof ENDED_RUNS)[number], add: (at: number, fn: () => void) => void): void {
    const runId = simRunId(run.agentNumber);
    add(run.startedAt, () => {
      this.emit('run.created', { runId, ticket: run.ticket, worktree: join(this.options.worktreesRoot, `${run.ticket}-${runId}`), branch: `feature/${run.ticket}`, agentNumber: run.agentNumber, ...TICKET_AGENT });
      this.emit('run.state_changed', { runId, state: 'running' });
      this.emit('run.goal_declared', { runId, revision: 1, goal: `Close ${run.ticket}.`, checks: [{ id: 'unit', description: 'The unit tests pass', proof: 'command', command: 'npm run test:unit' }] });
      this.emit('run.step_begun', { runId, stepIndex: 0, name: 'Fix', why: 'The cause is known from the ticket.' });
    });
    add(run.startedAt - run.minutes, () => {
      this.emit('run.check_changed', { runId, checkId: 'unit', status: 'passed', evidence: `\`npm run test:unit\` passed at ${this.hhmm(run.startedAt - run.minutes)}.` });
      this.emit('run.step_ended', { runId, stepIndex: 0, outcome: 'done' });
      this.emit('run.usage', { runId, tokens: 600_000, workingSeconds: run.minutes * 60 });
      this.emit('run.state_changed', { runId, state: run.state, reason: run.reason });
    });
  }

  private conversations(add: (at: number, fn: () => void) => void): void {
    for (const c of CONVERSATIONS) {
      const first = c.messages[0]!;
      add(first.at + 0.01, () =>
        this.emit('conversation.created', { conversationId: c.conversationId, title: c.firstTitle ?? c.title, ...(c.ticket ? { ticket: c.ticket } : {}) }),
      );
      // Elfoqsy proposes a better title once she knows what the conversation is about.
      if (c.firstTitle) add(first.at - 0.05, () => this.emit('conversation.renamed', { conversationId: c.conversationId, title: c.title }));
      for (const m of c.messages) {
        // The weekly review's message shows its review block, named by the week it covers.
        const blocks = c.conversationId === 'sim-conv-review' && m.role === 'elfoqsy' ? [...(m.blocks ?? []), { type: 'review' as const, ref: this.reviewWeekOf() }] : m.blocks;
        add(m.at, () =>
          this.emit('elfoqsy.message', {
            messageId: m.messageId ?? ulid(),
            role: m.role,
            text: m.text,
            conversationId: c.conversationId,
            ...(blocks ? { blocks } : {}),
            ...(m.blocks?.some((b) => b.type === 'ticket') ? { refs: { tickets: m.blocks.filter((b) => b.type === 'ticket').map((b) => (b as { ref: string }).ref) } } : {}),
          }),
        );
      }
    }
    // The planning conversation: an investigator, its findings saved to memory, then the handoff.
    const inv = INVESTIGATION;
    add(inv.startedAt - 0.05, () =>
      this.emit('investigation.started', { investigationId: inv.investigationId, conversationId: inv.conversationId, question: inv.question, model: inv.model, effort: inv.effort }),
    );
    add(inv.startedAt - inv.minutes, () => {
      this.emit('investigation.finished', {
        investigationId: inv.investigationId,
        conversationId: inv.conversationId,
        title: inv.title,
        findings: inv.findings,
        filesRead: inv.filesRead,
        tokens: inv.tokens,
        durationMs: Math.round(inv.minutes * MINUTE),
      });
      for (const f of FACTS) {
        this.emit('memory.saved', {
          factId: f.factId,
          statement: f.statement,
          sources: [{ kind: 'code', ref: f.ref }],
          freshUntil: new Date(this.t0 + 7 * DAY).toISOString(),
          origin: 'investigator',
        });
      }
    });
    add(HANDOFF.at + 0.05, () => {
      const { at: _at, ...handoff } = HANDOFF;
      this.emit('handoff.created', handoff);
    });
    // Monday's review of the past week.
    const review = CONVERSATIONS.find((c) => c.conversationId === 'sim-conv-review')!;
    add(review.messages[0]!.at - 0.01, () =>
      this.emit('review.weekly', {
        weekOf: this.reviewWeekOf(),
        conversationId: review.conversationId,
        metrics: {
          periodStart: this.t0 - review.messages[0]!.at * MINUTE - 7 * DAY,
          periodEnd: this.t0 - review.messages[0]!.at * MINUTE,
          runs: 6,
          succeeded: 4,
          stopped: 1,
          failed: 0,
          cancelled: 1,
          tokens: 9_400_000,
          workingMinutes: 212,
          waitingMinutes: 38,
          pausedMinutes: 6,
          subagents: 31,
          subagentsFailed: 3,
          subagentsCancelled: 2,
          ciFailures: 2,
          retries: 1,
          interventions: 1,
          evidenceMissing: 1,
        },
        suggestions: ['Haiku sub-agents running tests failed 3 times in 10; use Sonnet medium for test runs.'],
      }),
    );
  }

  private agentHistory(agent: SimAgent & { mode?: Mode }, add: (at: number, fn: () => void) => void): void {
    const runId = simRunId(agent.agentNumber);
    const entry: LiveAgent = { agent, runId, tokens: agent.tokens, workingSeconds: agent.workingMinutes * 60, step: null, stepCount: agent.steps.length, round: 0 };
    this.busy.set(agent.ticket, agent.agentNumber);
    const elapsed = (minutesAgo: number) => Math.max(0, agent.startedAt - minutesAgo);
    const ack = (seq: number, note?: string) => this.emit('run.ack', { runId, refEventSeq: seq, ...(note ? { note } : {}) });

    add(agent.startedAt, () => {
      this.emit('run.created', {
        runId,
        ticket: agent.ticket,
        worktree: join(this.options.worktreesRoot, `${agent.ticket}-${runId}`),
        branch: `feature/${agent.ticket}`,
        agentNumber: agent.agentNumber,
        ...TICKET_AGENT,
        ...(agent.handoffId ? { handoffId: agent.handoffId, mode: agent.runMode ?? 'normal' } : {}),
        ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
      });
      if (agent.handoffId) this.emit('handoff.handed_off', { handoffId: agent.handoffId, runId });
      this.emit('run.state_changed', { runId, state: 'running' });
    });
    add(agent.startedAt - 0.1, () => {
      const goal = this.emit('run.goal_declared', { runId, revision: 1, goal: agent.goal, checks: agent.checks });
      ack(goal.seq);
    });

    agent.steps.forEach((step, index) => {
      add(step.at, () => {
        const begun = this.emit('run.step_begun', { runId, stepIndex: index, name: step.name, why: step.why });
        ack(begun.seq);
        entry.step = { index, name: step.name };
      });
      if (step.end) {
        const end = step.end;
        add(end.at + 0.001, () => {
          this.emit('run.step_ended', { runId, stepIndex: index, outcome: end.outcome, ...(end.note ? { note: end.note } : {}) });
          entry.step = null;
        });
      }
    });

    agent.tools.forEach((call, i) => {
      const toolUseId = `${runId}-t${i}`;
      add(call.at, () =>
        this.emit('tool.called', {
          runId,
          toolUseId,
          tool: call.tool,
          title: call.title,
          ...(call.where ? { where: call.where } : {}),
          inputSummary: JSON.stringify(call.tool === 'Bash' ? { command: call.title } : { file_path: call.title }),
          allowed: true,
        }),
      );
      if (call.finish) {
        const f = call.finish;
        add(call.at - f.after, () =>
          this.emit('tool.finished', { runId, toolUseId, ok: f.ok, outputSummary: f.output, ...(f.stats ? { stats: f.stats } : {}), durationMs: Math.round(f.after * MINUTE), ...(f.diff ? { diff: f.diff } : {}) }),
        );
      }
      if (agent.handBack && call.title.startsWith('git push')) {
        const hb = agent.handBack;
        // Pushing the run branch is tier 1: done at once, recorded, and reported in one line.
        add(call.at - 0.02, () => {
          const actionId = `${runId}-push`;
          this.emit('action.classified', { actionId, runId, toolUseId, proxy: 'git', kind: 'git.push', tier: 1, summary: `git push origin feature/${agent.ticket} (${hb.repo}, ${hb.commits} commit${hb.commits === 1 ? '' : 's'})`, decision: 'run', reason: "Pushing the run's own branch is done at once and reported." });
          this.emit('change.recorded', { recordId: `${runId}-push-rec`, actionId, runId, target: `feature/${agent.ticket} on GitHub`, before: `${hb.repo}: not on GitHub`, noUndo: 'Taking a push back would need a force-push, which only alex may do.' });
          this.emit('action.finished', { actionId, runId, ok: true, outputSummary: `Pushed feature/${agent.ticket} to ${shortRepo(hb.repo)}.`, durationMs: 1800 });
          this.emit('elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: `Agent ${agent.agentNumber} pushed feature/${agent.ticket} to ${shortRepo(hb.repo)} (${hb.commits} commit${hb.commits === 1 ? '' : 's'}).`, conversationId: hb.conversationId, refs: { tickets: [agent.ticket], runId } });
        });
      }
    });

    agent.subagents.forEach((sub, j) => {
      const subagentId = `${runId}-s${j}`;
      const parentToolUseId = `${runId}-a${j}`;
      add(sub.start, () => {
        this.emit('tool.called', { runId, toolUseId: parentToolUseId, tool: 'Agent', title: sub.task, inputSummary: JSON.stringify({ description: sub.task }), allowed: true });
        this.emit('subagent.started', { runId, subagentId, parentToolUseId, model: sub.model, effort: sub.effort, task: sub.task });
      });
      const end = sub.ran !== undefined ? sub.start - sub.ran : 0;
      sub.tools.forEach((t, k) => {
        const toolUseId = `${subagentId}-t${k}`;
        const at = sub.start - ((sub.start - end) * (k + 1)) / (sub.tools.length + 1);
        // A sub-agent still at work is in the middle of its last call; the others have reported back.
        if (sub.ran === undefined && k === sub.tools.length - 1) {
          add(at, () => this.emit('tool.called', { runId, subagentId, toolUseId, tool: t.tool, title: t.input, inputSummary: JSON.stringify({ command: t.input }), allowed: true }));
          return;
        }
        add(at, () => this.emit('subagent.tool_called', { runId, subagentId, toolUseId, tool: t.tool, inputSummary: t.input, outputSummary: t.output, ok: t.ok ?? true }));
      });
      if (sub.ran !== undefined) {
        add(end, () => {
          this.emit('subagent.finished', {
            runId,
            subagentId,
            outcome: sub.outcome ?? 'done',
            ...(sub.cancelledBy ? { by: sub.cancelledBy } : {}),
            ...(sub.reason ? { reason: sub.reason } : {}),
            result: sub.result,
            tokens: sub.tokens,
            toolCalls: sub.tools.length,
            durationMs: Math.round(sub.ran! * MINUTE),
          });
          this.emit('tool.finished', { runId, toolUseId: parentToolUseId, ok: sub.outcome !== 'failed', outputSummary: sub.result, durationMs: Math.round(sub.ran! * MINUTE) });
        });
      } else if (!entry.cycling || sub.task === 'Run the unit tests') {
        entry.cycling = { subagentId, sub, startedAt: this.now() - sub.start * MINUTE, ...(sub.tools.length ? { toolUseId: `${subagentId}-t${sub.tools.length - 1}` } : {}) };
      }
    });

    for (const t of agent.thoughts ?? []) add(t.at, () => this.emit('run.thought', { runId, text: t.text }));
    if (agent.verdict) {
      const v = agent.verdict;
      add(v.at, () => this.emit('run.verdict', { runId, verdict: v.verdict, reproduced: v.reproduced, summary: v.summary }));
    }

    for (const p of agent.passed) {
      add(p.at, () => this.emit('run.check_changed', { runId, checkId: p.checkId, status: 'passed', evidence: p.evidence.replace('{time}', this.hhmm(p.at)) }));
    }

    for (const beat of agent.heartbeats) {
      add(beat.at, () => {
        const share = elapsed(beat.at) / Math.max(1, agent.workingMinutes);
        const hb = this.emit('run.heartbeat', {
          runId,
          step: agent.steps.filter((s) => s.at >= beat.at).at(-1)?.name ?? 'Getting started',
          sinceLast: beat.sinceLast,
          next: beat.next,
          progress: beat.progress,
          risks: beat.risks,
          tokens: Math.round(agent.tokens * Math.min(1, share)),
          workingSeconds: Math.round(elapsed(beat.at) * 60),
        });
        ack(hb.seq, beat.risks.length ? 'Noted the risk.' : undefined);
      });
    }

    if (agent.intervention) {
      const i = agent.intervention;
      add(i.at, () => this.emit('run.paused', { runId, by: 'you', reason: i.reason }));
      add(i.at - 0.05, () => {
        const g = this.emit('run.guidance', { runId, text: i.guidance, by: 'you' });
        ack(g.seq, 'Watching that it follows.');
      });
      add(i.at - 0.1, () => this.emit('run.resumed', { runId, by: 'you' }));
    }

    add(0.05, () => this.emit('run.usage', { runId, tokens: agent.tokens, workingSeconds: agent.workingMinutes * 60 }));

    if (agent.handBack) {
      const hb = agent.handBack;
      const repoName = shortRepo(hb.repo);
      const say = (text: string) => this.emit('elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, conversationId: hb.conversationId, refs: { tickets: [agent.ticket], runId } });
      // Its draft PR (tier 1), opened at once; then linked in its Jira ticket (tier 1).
      add(hb.at - 0.4, () => {
        const toolUseId = `${runId}-pr`;
        const actionId = `${runId}-pr-act`;
        const summary = `gh pr create --repo ${hb.repo} --title "${agent.ticket}: surface payment provider errors" --draft`;
        this.emit('tool.called', { runId, toolUseId, tool: 'mcp__run__gh', title: summary.replace(/^gh /, ''), where: repoName, inputSummary: JSON.stringify({ args: ['pr', 'create'] }), allowed: true });
        this.emit('action.classified', { actionId, runId, toolUseId, proxy: 'gh', kind: 'gh.pr.create', tier: 1, summary, decision: 'run', reason: "Opening the run's own PR as a draft is done at once; no reviewer is notified." });
        this.emit('change.recorded', { recordId: `${actionId}-rec`, actionId, runId, target: `${hb.repo}, a PR from feature/${agent.ticket}`, before: `No PR from feature/${agent.ticket}.`, undo: { proxy: 'gh', summary: `Close the PR from feature/${agent.ticket} on ${hb.repo}`, request: { args: ['pr', 'close', `feature/${agent.ticket}`, '--repo', hb.repo] } } });
        this.emit('action.finished', { actionId, runId, ok: true, outputSummary: `https://github.com/${hb.repo}/pull/${hb.pr}`, durationMs: 2100 });
        this.emit('tool.finished', { runId, toolUseId, ok: true, outputSummary: `https://github.com/${hb.repo}/pull/${hb.pr}\n\n(Done at once; Elfoqsy told alex.)`, durationMs: 2100 });
        this.emit('pr.synced', { pr: { repo: repoName, number: hb.pr, state: 'draft', ticket: agent.ticket, url: '', checks: 'success' } });
        say(`Agent ${agent.agentNumber} opened ${repoName} #${hb.pr} as a draft.`);
      });
      add(hb.at - 0.7, () => {
        const toolUseId = `${runId}-link`;
        const actionId = `${runId}-link-act`;
        const url = `https://github.com/${hb.repo}/pull/${hb.pr}`;
        this.emit('tool.called', { runId, toolUseId, tool: 'mcp__run__jira', title: `link_pr ${agent.ticket} ${url}`, inputSummary: JSON.stringify({ action: 'link_pr' }), allowed: true });
        this.emit('action.classified', { actionId, runId, toolUseId, proxy: 'jira', kind: 'jira.link_pr', tier: 1, summary: `Link ${url} in ${agent.ticket}`, decision: 'run', reason: "Linking the run's own PR in its ticket is done at once." });
        this.emit('change.recorded', { recordId: `${actionId}-rec`, actionId, runId, target: `${agent.ticket}'s links`, before: 'No links.', undo: { proxy: 'jira', summary: `Remove the link to ${url} from ${agent.ticket}`, request: { action: 'unlink_pr', key: agent.ticket, url } } });
        this.emit('action.finished', { actionId, runId, ok: true, outputSummary: `Linked ${url} in ${agent.ticket}.`, durationMs: 600 });
        this.emit('tool.finished', { runId, toolUseId, ok: true, outputSummary: `Linked ${url} in ${agent.ticket}.`, durationMs: 600 });
        say(`Agent ${agent.agentNumber} linked ${repoName} #${hb.pr} in ${agent.ticket}.`);
      });
      // Marking it ready for review notifies reviewers: tier 2, asked, and it has waited since.
      add(hb.at - 0.9, () => {
        const approvalId = simApprovalId(agent.agentNumber);
        const toolUseId = `${runId}-ready`;
        const actionId = `${runId}-ready-act`;
        const summary = `gh pr ready ${hb.pr} --repo ${hb.repo}`;
        this.readies.set(approvalId, { runId, toolUseId, actionId, ticket: agent.ticket, repo: hb.repo, pr: hb.pr });
        this.emit('tool.called', { runId, toolUseId, tool: 'mcp__run__gh', title: summary.replace(/^gh /, ''), where: repoName, inputSummary: JSON.stringify({ args: ['pr', 'ready'] }), allowed: true });
        this.emit('action.classified', { actionId, runId, toolUseId, proxy: 'gh', kind: 'gh.pr.ready', tier: 2, summary, decision: 'ask', reason: 'Marking a PR ready for review notifies its reviewers: asked first.', approvalId });
        this.emit('approval.requested', {
          approvalId,
          runId,
          kind: 'action',
          question: `Agent ${agent.agentNumber} on ${agent.ticket} wants to run the command below. Marking a PR ready for review notifies its reviewers: asked first.`,
          action: summary,
          tier: 2,
          grantable: { kind: 'gh.pr.ready' },
          batchId: `${approvalId}-batch`,
        });
        this.emit('run.state_changed', { runId, state: 'waiting_for_you' });
        this.emit('elfoqsy.message', {
          messageId: ulid(),
          role: 'elfoqsy',
          text: `Agent ${agent.agentNumber} needs your approval.`,
          conversationId: hb.conversationId,
          blocks: [{ type: 'approval', ref: approvalId }],
          refs: { tickets: [agent.ticket], runId, approvalId },
        });
      });
    }

    if (agent.mode === 'failed') {
      add(1, () => {
        this.emit('run.state_changed', { runId, state: 'failed', reason: 'CI failed on shop-api: integration › upload. Retrying.' });
        this.emit('run.flag', { runId, kind: 'loop', detail: '`npm run test:unit` failed the same way 3 times.' });
      });
    }
    if (agent.mode === 'silent') {
      add(0.5, () => this.emit('run.flag', { runId, kind: 'missed_heartbeats', detail: 'No heartbeat for 11 working minutes.' }));
    }
    if (agent.mode === 'spent') {
      add(0.4, () => this.emit('run.flag', { runId, kind: 'budget', detail: '2.7M of 3M tokens used, and the unit tests still fail.' }));
    }

    if (!agent.handBack && agent.mode !== 'failed') this.live.set(runId, entry);
  }

  /** Working agents keep at it: their running sub-agent hands over to the next one, heartbeats and usage tick. */
  private keepMoving(entry: LiveAgent): void {
    const offset = (entry.agent.agentNumber * 3.7) % JOB_SECONDS;
    if (entry.cycling) this.after(FIRST_JOB_SECONDS - offset, () => this.cycle(entry));
    this.after(HEARTBEAT_SECONDS - offset, () => this.heartbeat(entry));
    this.after(USAGE_SECONDS, () => this.tick(entry));
  }

  private cycle(entry: LiveAgent): void {
    const running = entry.cycling;
    if (!running || !this.live.has(entry.runId)) return;
    if (entry.paused) {
      this.after(JOB_SECONDS, () => this.cycle(entry));
      return;
    }
    const { runId } = entry;
    const { sub } = running;
    const ms = this.now() - running.startedAt;
    const last = sub.tools.at(-1);
    if (running.toolUseId && last) {
      this.emit('subagent.tool_called', { runId, subagentId: running.subagentId, toolUseId: running.toolUseId, tool: last.tool, inputSummary: last.input, outputSummary: sub.task === 'Run the unit tests' ? 'Tests: 52 passed, 52 total' : last.output === 'running' ? 'done' : last.output, ok: true });
    }
    this.emit('subagent.finished', { runId, subagentId: running.subagentId, outcome: 'done', result: sub.task === 'Run the unit tests' ? '52 passed' : 'Found it', tokens: sub.tokens + 4_000, toolCalls: sub.tools.length + 1, durationMs: Math.max(0, ms) });
    entry.round += 1;
    const subagentId = `${runId}-live${entry.round}`;
    const parentToolUseId = `${runId}-live-a${entry.round}`;
    this.emit('tool.called', { runId, toolUseId: parentToolUseId, tool: 'Agent', title: sub.task, inputSummary: JSON.stringify({ description: sub.task }), allowed: true });
    this.emit('subagent.started', { runId, subagentId, parentToolUseId, model: sub.model, effort: sub.effort, task: sub.task });
    const toolUseId = `${subagentId}-t0`;
    const first = sub.tools.at(-1);
    this.emit('tool.called', { runId, subagentId, toolUseId, tool: first?.tool ?? 'Bash', title: first?.input ?? sub.task, inputSummary: JSON.stringify({ command: first?.input ?? sub.task }), allowed: true });
    entry.cycling = { subagentId, sub, startedAt: this.now(), toolUseId };
    this.after(JOB_SECONDS, () => this.cycle(entry));
  }

  private heartbeat(entry: LiveAgent): void {
    if (!this.live.has(entry.runId)) return;
    if (entry.paused) {
      this.after(HEARTBEAT_SECONDS, () => this.heartbeat(entry));
      return;
    }
    const hb = this.emit('run.heartbeat', {
      runId: entry.runId,
      step: entry.step?.name ?? 'Getting started',
      sinceLast: `Still on ${entry.step?.name ?? 'the first step'}; sub-agents report back as they finish.`,
      next: 'Finish this step.',
      progress: 'most',
      risks: [],
      tokens: entry.tokens,
      workingSeconds: entry.workingSeconds,
    });
    this.emit('run.ack', { runId: entry.runId, refEventSeq: hb.seq });
    this.after(HEARTBEAT_SECONDS, () => this.heartbeat(entry));
  }

  private tick(entry: LiveAgent): void {
    if (!this.live.has(entry.runId)) return;
    if (entry.paused) {
      this.after(USAGE_SECONDS, () => this.tick(entry));
      return;
    }
    entry.tokens += 4_000;
    entry.workingSeconds += USAGE_SECONDS;
    this.emit('run.usage', { runId: entry.runId, tokens: entry.tokens, workingSeconds: entry.workingSeconds });
    this.after(USAGE_SECONDS, () => this.tick(entry));
  }

  private onEvent(event: AnyEnvelope): void {
    if (event.source === 'simulator') return;
    if (event.type === 'approval.resolved') this.onAnswer(event.payload);
    else if (event.type === 'run.guidance') this.onGuidance(event.payload);
    else if (event.type === 'run.paused' || event.type === 'run.resumed') {
      const entry = this.live.get(event.payload.runId);
      if (entry) entry.paused = event.type === 'run.paused';
    }
    else if (event.type === 'elfoqsy.message' && event.payload.role !== 'elfoqsy' && event.payload.conversationId) {
      this.onMessage(event.payload.conversationId, event.payload.text, event.payload.messageId, event.payload.role === 'test' ? 'test' : 'you');
    }
  }

  /**
   * Agent 4's question is answered. Approved: the PR is marked ready (and with "Allow for this ticket" from alex,
   * a grant), CI passes on it and the run succeeds. Declined: the agent goes another way.
   */
  private onAnswer(p: PayloadOf<'approval.resolved'>): void {
    const ready = this.readies.get(p.approvalId);
    if (!ready) return;
    this.readies.delete(p.approvalId);
    const { runId, toolUseId, actionId } = ready;
    const agent = AGENTS.find((a) => simRunId(a.agentNumber) === runId)!;
    const stepIndex = agent.steps.length - 1;
    const who = p.test ? 'The tester (not alex)' : 'alex';
    this.after(0.6, () => {
      if (p.decision === 'approved') {
        if (p.scope === 'ticket' && !p.test) this.options.grants?.create({ ticket: ready.ticket, runId, kind: 'gh.pr.ready', by: 'you', approvalId: p.approvalId });
        this.emit('action.finished', { actionId, runId, ok: true, outputSummary: `✓ Pull request ${ready.repo}#${ready.pr} is marked as "ready for review"`, durationMs: 700 });
        this.emit('tool.finished', { runId, toolUseId, ok: true, outputSummary: `✓ Pull request ${ready.repo}#${ready.pr} is marked as "ready for review"\n\n(${who} approved it.)` });
        this.emit('pr.synced', { pr: { repo: shortRepo(ready.repo), number: ready.pr, state: 'open', ticket: ready.ticket, url: '', checks: 'pending' } });
        this.emit('run.step_ended', { runId, stepIndex, outcome: 'done' });
        this.emit('run.step_begun', { runId, stepIndex: stepIndex + 1, name: 'Wait for CI', why: 'The PR is ready for review; CI runs on its head.' });
        this.emit('run.state_changed', { runId, state: 'running' });
        this.after(45, () => {
          this.emit('run.check_changed', { runId, checkId: 'ci', status: 'passed', evidence: `CI on ${ready.repo} at 3f2c1a7: 4 CI checks passed.` });
          this.emit('pr.synced', { pr: { repo: shortRepo(ready.repo), number: ready.pr, state: 'open', ticket: ready.ticket, url: '', checks: 'success' } });
          this.emit('run.step_ended', { runId, stepIndex: stepIndex + 1, outcome: 'done' });
          this.emit('run.state_changed', { runId, state: 'succeeded', reason: 'All 2 checks have passing evidence.' });
          this.busy.delete(agent.ticket);
        });
      } else {
        const message = `${who} declined: gh pr ready ${ready.pr} --repo ${ready.repo}.`;
        this.emit('action.finished', { actionId, runId, ok: false, outputSummary: message });
        this.emit('tool.finished', { runId, toolUseId, ok: false, outputSummary: message });
        this.emit('run.step_ended', { runId, stepIndex, outcome: 'abandoned', note: 'Marking the PR ready was declined' });
        this.emit('run.step_begun', { runId, stepIndex: stepIndex + 1, name: 'Rework', why: 'Marking the PR ready was declined; ask what to change.' });
        this.emit('run.state_changed', { runId, state: 'running' });
      }
    });
  }

  /** Guidance from a pane: Elfoqsy acknowledges it and the agent answers by beginning its next step. */
  private onGuidance(p: PayloadOf<'run.guidance'>): void {
    const entry = this.live.get(p.runId);
    if (!entry) return;
    this.after(1, () => {
      this.emit('run.ack', { runId: p.runId, refEventSeq: this.log.headSeq(), note: 'Watching that it follows.' });
      if (entry.step) this.emit('run.step_ended', { runId: p.runId, stepIndex: entry.step.index, outcome: 'abandoned', note: 'Re-planned after guidance' });
      const index = entry.stepCount++;
      entry.step = { index, name: 'Re-plan' };
      this.emit('run.step_begun', { runId: p.runId, stepIndex: index, name: 'Re-plan', why: `Guidance: ${p.text}` });
    });
  }

  /**
   * "do SHOP-1234" starts a simulated agent. A question shows how an investigator looks (she is thinking
   * while it runs) without pretending to have found anything; anything else gets a reply saying this is
   * simulate mode.
   */
  /** Her actions before she answers, for the thinking indicator: each runs for a moment, then is done. */
  private activities(conversationId: string, lines: Array<{ tool: string; text: string }>, then: () => void): void {
    let at = 0.3;
    for (const line of lines) {
      const activityId = ulid();
      this.after(at, () => this.emit('elfoqsy.activity', { conversationId, activityId, tool: line.tool, text: line.text, state: 'running' }));
      at += 2;
      this.after(at, () => this.emit('elfoqsy.activity', { conversationId, activityId, tool: line.tool, text: line.text, state: 'done' }));
    }
    this.after(at + 0.4, then);
  }

  private onMessage(conversationId: string, text: string, messageId: string, role: 'you' | 'test'): void {
    const command = /^\s*(do|check)\s+([a-z][a-z0-9]*-\d+)\s*$/i.exec(text);
    const key = command?.[2]?.toUpperCase();
    const readOnly = command?.[1]?.toLowerCase() === 'check';
    const lines = key
      ? [
          { tool: 'jira', text: `Read ${key} and its comments` },
          { tool: 'workspace', text: 'Look at the agents' },
        ]
      : text.trim().endsWith('?')
        ? [
            { tool: 'jira', text: 'Read the ticket and its comments' },
            { tool: 'code', text: 'Find where it happens in the code' },
            { tool: 'kube', text: 'Check the dev and staging config' },
          ]
        : [{ tool: 'workspace', text: 'Read the sprint' }];
    this.activities(conversationId, lines, () => {
      const say = (reply: string, blocks?: MessageBlock[]) =>
        this.emit('elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: reply, conversationId, ...(blocks ? { blocks } : {}) });
      if (!key && text.trim().endsWith('?')) {
        const investigationId = `sim-inv-${ulid()}`;
        this.emit('investigation.started', { investigationId, conversationId, question: text.trim(), model: 'claude-sonnet-5-5', effort: 'high' });
        say("This is simulate mode, so no investigator really runs; here's how one looks while it works.", [{ type: 'findings', ref: investigationId }]);
        this.after(SIM_INVESTIGATION_SECONDS, () =>
          this.emit('investigation.finished', {
            investigationId,
            conversationId,
            title: 'Simulate mode',
            findings: [{ text: 'No investigator ran. Live, what it found and its sources would be here.', sources: [] }],
            filesRead: 0,
            tokens: 0,
            durationMs: SIM_INVESTIGATION_SECONDS * 1000,
          }),
        );
        return;
      }
      if (!key) {
        say("This is simulate mode, so I can't act on that. Live, I'd answer from the sprint, my memory or an investigator.");
        return;
      }
      const busy = this.busy.get(key);
      if (busy !== undefined) say(`Agent ${busy} is already on ${key}.`);
      else if (!this.open.has(key)) say(`${key} is not an open ticket in this sprint.`);
      else {
        const n = this.nextAgent++;
        const ticket = this.mock.sprint.openTickets.find((t) => t.key === key);
        this.emit('conversation.renamed', { conversationId, title: `${readOnly ? 'Check' : 'Start an agent on'} ${key}`, ticket: key });
        // The handoff: his message as he wrote it, and what the ticket says, with the ticket as its source.
        const handoffId = `sim-handoff-${ulid().toLowerCase()}`;
        this.emit('handoff.created', {
          handoffId,
          conversationId,
          ticket: key,
          mode: readOnly ? 'read_only' : 'normal',
          context: [{ messageId, role, text }],
          constraints: [],
          facts: ticket ? [{ text: `The ticket reports: ${ticket.summary}`, sources: [{ kind: 'ticket', ref: key }] }] : [],
        });
        this.startAgent({ ...startedAgent(n, key, conversationId), handoffId, runMode: readOnly ? 'read_only' : 'normal' }, ticket?.type, readOnly);
        say(`Agent ${n} is on ${key}${readOnly ? ', read-only' : ''}. Say stop and I'll stop it.`, [{ type: 'handoff', ref: handoffId }]);
      }
    });
  }

  /** The week the simulated weekly review covers, as YYYY-MM-DD. */
  private reviewWeekOf(): string {
    const review = CONVERSATIONS.find((c) => c.conversationId === 'sim-conv-review')!;
    return new Date(this.t0 - review.messages[0]!.at * MINUTE - 7 * DAY).toISOString().slice(0, 10);
  }

  /** An agent started now: its few first events, then the same live loop as the others; a bug also hands back. */
  private startAgent(agent: SimAgent, type?: Ticket['type'], readOnly = false): void {
    const items: { at: number; run: () => void }[] = [];
    this.agentHistory(agent, (at, run) => items.push({ at, run }));
    items.sort((a, b) => b.at - a.at).forEach((item) => item.run());
    const entry = this.live.get(simRunId(agent.agentNumber));
    if (entry) this.keepMoving(entry);
    if (this.options.proxies && (readOnly || type === 'Bug')) void this.handBack(agent, this.options.proxies, readOnly);
  }

  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => this.after(seconds, resolve));
  }

  /**
   * An agent started here works the ticket the v1.2 way, through the real tier policy over simulated backends:
   * Understand, Locate, a verdict before any code, Reproduce (a failing test, then the verdict again, reproduced), its
   * input classes, Fix, Prove, one fresh review, and Hand back: push, a draft PR on each repository and the Jira links,
   * each done at once and reported by Elfoqsy in one line; then the first PR marked ready, which is asked (with "Allow
   * for this ticket", the second goes through on the grant). A read-only check stops at its verdict, EXPECTED_BEHAVIOR/INVALID, and
   * Elfoqsy proposes the default: the agent's comment on the ticket, asked as a Jira comment.
   */
  private async handBack(agent: SimAgent, proxies: Proxies, readOnly = false): Promise<void> {
    const runId = simRunId(agent.agentNumber);
    const key = agent.ticket;
    const branch = `feature/${key}`;
    const repos = [SIM_API, SIM_SHARED];
    const ticket = this.mock.sprint.openTickets.find((t) => t.key === key);
    const conversationId = agent.conversationId;
    const run: ProxyRun = {
      runId,
      ticket: key,
      agentNumber: agent.agentNumber,
      branch,
      targets: repos.map((repo) => ({ repo, base: 'master' })),
      kubeconfig: join(this.options.worktreesRoot, '.sim', 'kubeconfig'),
      asking: async (answer) => {
        this.emit('run.state_changed', { runId, state: 'waiting_for_you' });
        try {
          return await answer;
        } finally {
          if (this.live.has(runId)) this.emit('run.state_changed', { runId, state: 'running' });
        }
      },
    };
    proxies.register(run);
    let n = 0;
    const alive = () => this.live.has(runId);
    const call = async (proxy: ProxyName, title: string, input: Record<string, unknown>, where?: string) => {
      const toolUseId = `${runId}-proxy-${n++}`;
      this.emit('tool.called', { runId, toolUseId, tool: `mcp__run__${proxy}`, title, ...(where ? { where } : {}), inputSummary: JSON.stringify(input).slice(0, 200), allowed: true });
      const started = this.now();
      const r = await proxies.request(run, proxy, input, toolUseId);
      this.emit('tool.finished', { runId, toolUseId, ok: r.ok, outputSummary: r.text.split('\n').slice(0, 4).join('\n'), durationMs: Math.max(0, this.now() - started) });
      return r;
    };
    const step = (name: string, why: string) => {
      const entry = this.live.get(runId);
      if (!entry) return;
      if (entry.step) this.emit('run.step_ended', { runId, stepIndex: entry.step.index, outcome: 'done' });
      const index = entry.stepCount++;
      entry.step = { index, name };
      this.emit('run.step_begun', { runId, stepIndex: index, name, why });
    };
    const tool = (title: string, toolName: string, output: string, where: string, stats?: string, diff?: { hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> }, ok = true) => {
      const toolUseId = `${runId}-own-${n++}`;
      this.emit('tool.called', { runId, toolUseId, tool: toolName, title, where, inputSummary: JSON.stringify({ command: title }), allowed: true });
      this.emit('tool.finished', { runId, toolUseId, ok, outputSummary: output, ...(stats ? { stats } : {}), durationMs: 900, ...(diff ? { diff } : {}) });
    };
    const thought = (text: string) => this.emit('run.thought', { runId, text });
    const say = (text: string, blocks?: MessageBlock[]) =>
      this.emit('elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, ...(conversationId ? { conversationId } : {}), refs: { tickets: [key], runId }, ...(blocks ? { blocks } : {}) });
    let verdicts = 0;
    const verdict = (p: Omit<PayloadOf<'run.verdict'>, 'runId'>) => {
      this.emit('run.verdict', { runId, ...p, evidence: (p.findings ?? []).flatMap((f) => f.sources) });
      // The first one is one line with a link into the narrative, at its verdict (N1); a later report of it is a plain line.
      if (p.verdict === 'VALID') {
        const words = `VALID, ${p.reproduced ? 'reproduced' : 'not reproduced yet'}`;
        if (verdicts++) say(`Agent ${agent.agentNumber}'s verdict on ${key}: ${words}.`);
        else say(`Agent ${agent.agentNumber} reached its verdict on ${key}: ${words}. ${p.summary} Nothing waits for you.`, [{ type: 'narrative', ref: runId, section: 2 }]);
      }
    };
    const symptom = ticket?.summary ?? key;

    await this.wait(3);
    if (!alive()) return;
    step('Understand', 'Read the ticket, its comments and its links.');
    await call('jira', `get ${key}`, { action: 'get', key });
    thought(`The handoff gives alex's words and one fact, the ticket itself; no cause. The reported symptom is "${symptom}". I check the code before I believe anything about why.`);
    this.emit('run.understanding', {
      runId,
      claim: symptom,
      input: 'A webhook config whose token already starts with "Basic ".',
      actual: 'The header is sent as "Basic Basic dXNlcjpwYXNz".',
      expected: 'The header is sent as "Basic dXNlcjpwYXNz", the scheme once.',
      sources: [{ kind: 'ticket', ref: key }],
    });
    await this.wait(3);
    if (!alive()) return;
    step('Locate', 'Map the reported behaviour to the code, and pin what is deployed where.');
    tool('"Basic " in shop-api/src', 'Grep', 'src/webhook/auth.ts:27     headers.Authorization = `Basic ${token}`', 'shop-api');
    await call('kube', '--context dev get deployment/shop-api -o wide', { args: ['--context', 'dev', 'get', 'deployment/shop-api', '-o', 'wide'] }, 'dev');

    if (readOnly) {
      await this.wait(3);
      if (!alive()) return;
      step('Verdict', 'The code does what the docs describe; compare with the ticket.');
      thought('The docs say the setting holds the whole header value, scheme included, and the code sends it as it is. What the ticket calls wrong is the documented behaviour: EXPECTED_BEHAVIOR/INVALID.');
      const comment = `This is the documented behaviour: the webhook sends the configured value as it is (shop-api/src/webhook/auth.ts:27), and the docs say the setting holds the whole header value. No code change is planned for ${key}.`;
      verdict({
        verdict: 'EXPECTED_BEHAVIOR/INVALID',
        reproduced: false,
        summary: 'The webhook sends the configured header value unchanged, as the docs describe.',
        ticketComment: comment,
        findings: [
          { text: 'auth.ts sends the configured value without adding a scheme.', sources: [{ kind: 'code', ref: 'shop-api/src/webhook/auth.ts:27' }] },
          { text: 'The docs describe the setting as the whole header value.', sources: [{ kind: 'url', ref: 'https://acme.atlassian.net/wiki/spaces/SHOP/pages/7340001' }] },
        ],
      });
      await this.wait(2);
      if (!alive()) return;
      const entry = this.live.get(runId);
      if (entry?.step) this.emit('run.step_ended', { runId, stepIndex: entry.step.index, outcome: 'done' });
      this.live.delete(runId);
      this.emit('run.state_changed', { runId, state: 'stopped', reason: 'Its verdict: EXPECTED_BEHAVIOR/INVALID. The webhook sends the configured header value unchanged, as the docs describe.' });
      this.busy.delete(key);
      proxies.unregister(runId);
      say(`Agent ${agent.agentNumber} stopped after its verdict on ${key}: EXPECTED_BEHAVIOR/INVALID. I propose to update ${key} to say it is the expected behaviour, with the comment it wrote; approve it to post it, or not.`, [{ type: 'verdict', ref: runId }]);
      // The run has ended: the proposal waits for him without making it wait again.
      const { asking: _asking, ...ended } = run;
      void proxies.request(ended, 'jira', { action: 'comment', key, text: comment }).catch(() => undefined);
      return;
    }

    await this.wait(3);
    if (!alive()) return;
    step('Verdict', 'The code adds the scheme to a value that may already carry it.');
    thought('The config value can already carry "Basic ", and auth.ts adds it again. The Bearer path in the same file does not double its scheme. VALID, not reproduced yet: I write the failing test first.');
    const findings = [
      { text: 'auth.ts adds "Basic " to the configured value whatever it holds.', sources: [{ kind: 'code' as const, ref: 'shop-api/src/webhook/auth.ts:27' }] },
      { text: 'The Bearer path in the same file sends its scheme once.', sources: [{ kind: 'code' as const, ref: 'shop-api/src/webhook/auth.ts:34' }] },
    ];
    const chain = [
      { ref: 'shop-api/src/webhook/send.ts:18', role: 'entry' as const, note: 'builds the request headers' },
      { ref: 'shop-api/src/webhook/auth.ts:27', role: 'fault' as const, note: 'adds "Basic " to a value that may have it' },
    ];
    const siblingAt = { kind: 'code' as const, ref: 'shop-api/src/webhook/auth.ts:34', label: 'the Bearer path' };
    verdict({ verdict: 'VALID', reproduced: false, summary: 'auth.ts adds the scheme to a setting that may already have it.', symptom, sibling: 'The Bearer path in auth.ts:34 sends one scheme; the Basic path adds a second.', siblingAt, chain, findings });
    step('Reproduce', 'A deterministic test that fails on the current code.');
    tool('test/webhook/auth.test.ts', 'Edit', '', 'shop-api', '+9 −0', {
      hunks: [{ oldStart: 40, newStart: 40, lines: [' });', '+', "+it('sends the configured Basic value once', () => {", "+  const h = headersFor({ token: 'Basic dXNlcjpwYXNz' });", "+  expect(h.Authorization).toBe('Basic dXNlcjpwYXNz');", '+});'] }],
    });
    tool('npm run test:unit -- auth', 'Bash', "FAIL test/webhook/auth.test.ts\n  ✕ sends the configured Basic value once\n    Expected: 'Basic dXNlcjpwYXNz'\n    Received: 'Basic Basic dXNlcjpwYXNz'", 'shop-api', undefined, undefined, false);
    this.emit('run.test_run', { runId, toolUseId: `${runId}-own-${n - 1}`, command: 'npm run test:unit -- auth', ok: false, durationMs: 900, summary: "FAIL test/webhook/auth.test.ts\n  ✕ sends the configured Basic value once\n    Expected: 'Basic dXNlcjpwYXNz'\n    Received: 'Basic Basic dXNlcjpwYXNz'", passed: 54, failed: 1, failedNames: ['sends the configured Basic value once'] });
    await this.wait(3);
    if (!alive()) return;
    verdict({
      verdict: 'VALID',
      reproduced: true,
      summary: 'auth.ts adds the scheme to a setting that already has it; the new test fails on the current code.',
      symptom,
      sibling: 'The Bearer path in auth.ts:34 sends one scheme; the Basic path adds a second.',
      siblingAt,
      chain,
      findings: [...findings, { text: 'The new test fails: it receives "Basic Basic …".', sources: [{ kind: 'code' as const, ref: 'shop-api/test/webhook/auth.test.ts:42' }] }],
    });
    this.emit('run.reproduction', {
      runId,
      how: 'A unit test sends the configured Basic value through the real header builder.',
      environment: 'local, vitest, shop-api',
      test: { path: 'shop-api/test/webhook/auth.test.ts', name: 'sends the configured Basic value once' },
      command: 'npm run test:unit -- auth',
    });
    this.emit('run.inputs_declared', { runId, classes: ['a configured value with the Basic scheme', 'a bare token', 'a Bearer value', 'no auth configured'] });
    step('Fix', 'The cause is in shop-api and the shared modules; fix both.');
    thought('Fixing it by stripping an existing scheme before adding it, so both old and new config values work.');
    this.emit('run.root_cause', { runId, text: 'auth.ts adds "Basic " to the configured token whatever it holds, so a token that already carries the scheme is sent with it twice.', lines: [{ kind: 'code', ref: 'shop-api/src/webhook/auth.ts:27' }] });
    this.emit('run.approach', {
      runId,
      approach: 'Strip an existing "Basic " scheme from the token before adding it, so old and new config values both work.',
      alternatives: [{ option: 'Reject a token that already carries the scheme at load', rejectedBecause: 'Existing configs hold it, and the docs say the setting is the whole header value.' }],
    });
    tool('src/webhook/auth.ts', 'Edit', '', 'shop-api', '+2 −1', {
      hunks: [
        {
          oldStart: 26,
          newStart: 26,
          lines: ['   const token = config.token.trim();', '-  headers.Authorization = `Basic ${token}`;', '+  const value = token.replace(/^Basic\\s+/i, "");', '+  headers.Authorization = `Basic ${value}`;', '   return headers;'],
        },
      ],
    });
    tool('src/auth/scheme.ts', 'Edit', '', 'shop-shared', '+6 −0');
    await this.wait(5);
    if (!alive()) return;
    step('Prove', 'The failing test passes now, with the whole suite and the type checks.');
    tool('npm run test:unit', 'Bash', 'Tests: 55 passed, 55 total', 'shop-api');
    this.emit('run.test_run', { runId, toolUseId: `${runId}-own-${n - 1}`, command: 'npm run test:unit -- auth', ok: true, durationMs: 900, summary: 'Tests: 1 passed, 1 total', passed: 1 });
    this.emit('run.test_run', { runId, toolUseId: `${runId}-own-${n - 1}`, command: 'npm run test:unit', ok: true, durationMs: 4100, summary: 'Tests: 55 passed, 55 total', passed: 55 });
    this.emit('run.check_changed', { runId, checkId: 'unit', status: 'passed', evidence: `\`npm run test:unit\` passed at ${new Date(this.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` });
    // One fresh-context review before the first push.
    const reviewId = `${runId}-reviewer`;
    const reviewCall = `${runId}-own-${n++}`;
    this.emit('tool.called', { runId, toolUseId: reviewCall, tool: 'Agent', title: 'Review the diff against RULESET.md', inputSummary: JSON.stringify({ subagent_type: 'reviewer' }), allowed: true });
    this.emit('subagent.started', { runId, subagentId: reviewId, parentToolUseId: reviewCall, model: 'claude-sonnet-5-5', effort: 'high', task: 'Review the diff against RULESET.md' });
    await this.wait(4);
    if (!alive()) return;
    this.emit('subagent.finished', { runId, subagentId: reviewId, outcome: 'done', result: 'No Blocker or Major findings; one Minor: a comment says what, not why.', tokens: 22_000, toolCalls: 6, durationMs: 4000 });
    this.emit('tool.finished', { runId, toolUseId: reviewCall, ok: true, outputSummary: 'No Blocker or Major findings.', durationMs: 4000 });
    await this.wait(3);
    if (!alive()) return;
    step('Hand back', 'Proven locally and reviewed: push, open the draft PRs, link them, and ask for review.');
    // git push of the run branch: the orchestrator pushes it at once (tier 1).
    const pushId = `${runId}-own-${n++}`;
    this.emit('tool.called', { runId, toolUseId: pushId, tool: 'Bash', title: `git push origin ${branch}`, inputSummary: JSON.stringify({ command: `git push origin ${branch}` }), allowed: true });
    const c: Classified = { tier: 1, kind: 'git.push', summary: `git push origin ${branch} (${repos.map((r) => `${r}, 1 commit`).join('; ')})`, reason: "Pushing the run's own branch is done at once and reported." };
    const gate = await proxies.gate(run, 'git', c, { toolUseId: pushId });
    if (gate.allowed) {
      await proxies.perform(run, c, gate.actionId, async () => ({ ok: true, output: `Pushed ${branch}.`, done: `pushed ${branch} to ${repos.map(shortRepo).join(' and ')} (2 commits)` }), {
        record: async () => ({ target: `${branch} on GitHub`, before: repos.map((r) => `${r}: not on GitHub`).join('; '), noUndo: 'Taking a push back would need a force-push, which only alex may do.' }),
      });
    }
    this.emit('tool.finished', { runId, toolUseId: pushId, ok: true, outputSummary: `The orchestrator pushed ${branch} at once (tier 1; Elfoqsy told alex).`, durationMs: 1500 });
    this.emit('run.pushed', {
      runId,
      repos: [
        { repo: SIM_API, branch, head: '3f2a1c9', commits: [{ sha: '5b1e0d2', subject: `${key}: add the failing test` }, { sha: '3f2a1c9', subject: `${key}: send one Basic scheme` }], files: [{ path: 'src/webhook/auth.ts', added: 2, removed: 1 }, { path: 'test/webhook/auth.test.ts', added: 9, removed: 0 }] },
        { repo: SIM_SHARED, branch, head: '8c4d7e1', commits: [{ sha: '8c4d7e1', subject: `${key}: add the scheme helper` }], files: [{ path: 'src/auth/scheme.ts', added: 6, removed: 0 }] },
      ],
    });
    const urls: string[] = [];
    for (const repo of repos) {
      await this.wait(3);
      if (!alive()) return;
      const title = `${branch}: send one Basic scheme in the webhook header`;
      const r = await call('gh', `pr create --repo ${repo} --title "${title}"`, { args: ['pr', 'create', '--repo', repo, '--title', title, '--body', `When the setting already holds "Basic …", the header doubled the scheme; now it is sent once. Test: test/webhook/auth.test.ts:42.`] }, shortRepo(repo));
      const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.text)?.[0];
      if (url) urls.push(url);
    }
    for (const url of urls) {
      await this.wait(2);
      if (!alive()) return;
      await call('jira', `link_pr ${key} ${url}`, { action: 'link_pr', key, url });
    }
    // The hand-back (N1): what it did not verify and what waits for him, then its last message, labelled.
    this.emit('run.reported', { runId, result: 'succeeded', summary: 'The header is sent once; the unit suite passes and the PRs are open as drafts.', notVerified: ['A real webhook receiver replying on dev'], waitingOnYou: ['Read what we know, then mark the PRs ready for review'] });
    this.emit('run.handed_back', { runId, message: `The webhook now sends the scheme once. I opened a draft PR on each repository and linked them in ${key}. Not verified: a real webhook receiver on dev. Decisions I made: none.` });
    const apiPr = urls[0] ? /github\.com\/(\S+)\/pull\/(\d+)/.exec(urls[0]) : null;
    say(`Agent ${agent.agentNumber} handed back ${key} with draft PR ${shortRepo(SIM_API)}#${apiPr?.[2] ?? ''}. Read what we know, then mark it ready.`, [{ type: 'narrative', ref: runId, section: 7 }]);
    // Marking a PR ready notifies reviewers: tier 2. The first asks; the second runs on a grant if there is one.
    for (const url of urls) {
      await this.wait(4);
      if (!alive()) return;
      const [, repo = '', pr = ''] = /github\.com\/(\S+)\/pull\/(\d+)/.exec(url) ?? [];
      await call('gh', `pr ready ${pr} --repo ${repo}`, { args: ['pr', 'ready', pr, '--repo', repo] }, shortRepo(repo));
    }
    await this.wait(45);
    if (!alive()) return;
    const entry = this.live.get(runId);
    if (entry?.step) this.emit('run.step_ended', { runId, stepIndex: entry.step.index, outcome: 'done' });
    this.live.delete(runId);
    this.emit('run.state_changed', { runId, state: 'succeeded', reason: 'All 1 check has passing evidence.' });
    this.busy.delete(key);
    proxies.unregister(runId);
  }
}
