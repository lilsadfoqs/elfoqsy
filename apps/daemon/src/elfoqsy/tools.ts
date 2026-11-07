// Elfoqsy's tools, all run by the orchestrator: the workspace state, read-only lookups, investigators,
// memory, blocks for her reply, handoffs, the conversation's title, and starting, telling and stopping
// agents. Every call is recorded as tool.called (source elfoqsy, no runId) and every result is redacted
// before it reaches the model. A session's tools serve one conversation.
import type { AbilityEngine } from '../abilities/engine';
import type { AbilityStep } from '../abilities/ability';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  WRITABLE_ABILITY_TOOLS,
  delegationCategorySchema,
  delegationSettingSchema,
  messageBlockSchema,
  runModeSchema,
  runStateSchema,
  sourceRefSchema,
  type DelegationCategory,
  type DelegationSetting,
  type DeliverableKind,
  type Effort,
  type MessageBlock,
  type ProxyName,
  type RunMode,
  type RunState,
  type SourceRef,
  type TicketDraft,
} from '@elfoqsy/contracts';
import { ciFailing, DELEGATION_CATEGORIES, isOpen, prKey, type WorkspaceState } from '@elfoqsy/state';
import type { RunControl } from '../agents/control';
import { THROUGH_ELFOQSY } from './notifier';
import type { StartArgs } from '../agents/investigator';
import type { EventLog } from '../eventLog';
import type { Environments } from '../permissions/environments';
import type { ProxyAnswer } from '../permissions/proxy';
import { redact, redactDeep } from '../redact';
import { ulid } from '../ulid';
import { activityLine } from './activity';
import { outcomesOf, type ToolOutcome } from './fidelity';
import { blockProblems } from './blocks';
import type { Lookups } from './lookups';

export const ORCHESTRATOR = 'orchestrator';
export const TOOL_NAMES = [
  'list_sprint',
  'get_ticket',
  'spawn_agent',
  'list_runs',
  'get_run',
  'cancel_run',
  'dismiss_run',
  'tell_agent',
  'read_events',
  'show',
  'name_conversation',
  'remember',
  'recall',
  'lookup_jira',
  'lookup_github',
  'lookup_confluence',
  'lookup_code',
  // her own reads of the environments, through the proxies' tier-0 operations (no agent, nothing to approve).
  'kube',
  'aws',
  'gh',
  'logs',
  'investigate',
  'write_handoff',
  'pause_run',
  'resume_run',
  'save_rule',
  'forget',
  'dismiss_ci',
  'record_review',
  'close_out',
  // task agents, delegation, her decisions.
  'start_task',
  'delegation',
  'set_delegation',
  'remove_precedent',
  'set_max_agents',
  'decisions',
  // her own Jira edits, through the proxy and his delegation; drafts of new tickets, which only he creates.
  'jira_write',
  'draft_ticket',
  // the design notes: her own abilities, written and updated through the engine's writer, verification and credit.
  'write_ability',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** The names the model sees, and the only tools the session allows. */
export const ALLOWED_TOOLS = TOOL_NAMES.map((name) => `mcp__${ORCHESTRATOR}__${name}`);

const NOT_YET = { error: 'not_available', message: 'Agent runs are not available here (simulate mode or tests).' } as const;
const NO_READS = { error: 'not_available', message: 'Reading the environments is not available here (simulate mode or tests).' } as const;
/** Said with a kubectl answer that a name was not found: she lists before she asks about one. */
const LIST_FIRST = 'Do not guess names: list first (for example kube get deployments --context <environment>), then ask about one that is in the list.';
const SETTING_WORDS: Record<DelegationSetting, string> = { decide: 'Elfoqsy decides', decide_and_tell: 'Elfoqsy decides and tells you', ask: 'you are asked' };
const NO_CONVERSATION = { error: 'no_conversation', message: 'This only works inside a conversation.' } as const;
const MAX_EVENTS = 500;
const DAY = 24 * 3600_000;

/** The conversation a session serves, and the reply she is writing in it. */
export interface SessionContext {
  conversationId: string;
  /** Who wrote the latest message she is answering here. */
  speaker: () => 'alex' | 'tester';
  /** Blocks for the reply she is writing. */
  addBlocks: (blocks: MessageBlock[]) => void;
  /** What a tool dropped, rejected or changed in this turn, and why, so her reply can be held to it. */
  noteOutcomes?: (outcomes: ToolOutcome[]) => void;
}


export interface ToolDeps {
  log: EventLog;
  state: () => WorkspaceState;
  /** Starts and stops agent runs; absent in tests and simulate mode, where both say not available. */
  orchestrator?: {
    spawn(args: { ticketKey: string; goal?: string; repos?: string[]; confirmManual?: boolean; handoffId?: string; conversationId?: string; test?: boolean; fromRun?: string }): Promise<unknown>;
    cancel(runId: string, reason: string): unknown;
    /** A message for the agent of a run, as a new turn, labelled with who it is from. */
    tell(runId: string, text: string, from: 'alex' | 'tester'): unknown;
    /** The close-out of a merged ticket once QA passed. */
    closeOut?(key: string, qa: string): Promise<unknown>;
    /** A ticket drafted for him: a card that waits; only he creates tickets. */
    draftTicket?(o: { by: 'elfoqsy'; conversationId?: string; draft: TicketDraft }): { draftId: string } | { error: string; message: string };
    /** Her own Jira edit through the proxy and his delegation; asked ones run when he approves. */
    elfoqsyJira?(input: Record<string, unknown>): Promise<{ ok: boolean; text: string; asked?: true }>;
    /** A task agent for work he asked for that is not tied to a ticket. */
    spawnTask?(args: { name: string; goal: string; deliverable: DeliverableKind; model: string; effort: Effort; repos?: string[]; conversationId?: string; test?: boolean }): Promise<unknown>;
    /** Her own read of an environment through the proxies' tier-0 operations: kube, aws, gh or logs. */
    elfoqsyRead?(proxy: ProxyName, input: Record<string, unknown>): Promise<ProxyAnswer>;
  };
  /** The environments she may read, for her tools' descriptions (their names, so she never guesses one). */
  environments?: Environments;
  /** How long her turn waits for one read of an environment (READ_TIMEOUT_MS). */
  readTimeoutMs?: number;
  lookups?: Lookups;
  investigators?: { start(args: StartArgs): unknown };
  /** Pause and resume a live run (the orchestrator). */
  control?: RunControl;
  /** Weekly reviews waiting for her suggestions: the period's numbers, by weekOf. */
  reviews?: { pending(weekOf: string): Record<string, number> | undefined; done(weekOf: string): void };
  session?: SessionContext;
  /** The abilities engine (abilities/engine.ts): her write_ability goes through its writer, verification and credit. */
  abilities?: Pick<AbilityEngine, 'write'>;
  now?: () => number;
}

function runSummary(s: WorkspaceState) {
  return s.runOrder
    .map((id) => s.runs[id]!)
    .map((r) => ({ runId: r.runId, ticket: r.ticket, agentNumber: r.agentNumber, step: r.step, state: r.state, startedAt: new Date(r.createdAt).toISOString() }));
}

/** A fact that reads as a diagnosis or a plan: the handoff carries observations, never how to fix the ticket. */
const CONCLUSION = /\b(root[- ]cause|the (bug|problem|issue|fault) (is|was|lies)|caused by|because|due to|fix(es|ed|ing)?\b|should|must|needs? to|instead of|so that|the solution|we (can|could|should)|change (it|the|this))\b/i;

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
/** His messages a handoff carries, the latest ones. */
const MAX_CONTEXT = 20;
const norm = (t: string) => t.toLowerCase().replace(/[“”"'`‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:!?…]+$/, '');

/**
 * Why a fact's source is not one the agent can check, or null: the ticket's own text (its key), a file and line an
 * investigator in this conversation read (its findings name it), a log query, a page or a link, a PR.
 */
function sourceProblem(src: SourceRef, read: Set<string>): string | null {
  const ref = src.ref.trim();
  switch (src.kind) {
    case 'ticket':
      return KEY.test(ref) ? null : `${ref} is not a ticket key`;
    case 'code': {
      if (!/:\d+(-\d+)?$/.test(ref)) return `${ref} needs a line (path:line)`;
      const path = ref.replace(/:\d+(-\d+)?$/, '');
      return read.has(ref) || read.has(path) ? null : `${ref} was not read by an investigator in this conversation`;
    }
    case 'log':
      return ref.length >= 3 ? null : 'a log source is the query that finds it';
    case 'doc':
    case 'url':
      return /^https?:\/\/\S+$/.test(ref) || /^\d{6,}$/.test(ref) ? null : `${ref} is not a link or a page id`;
    case 'pr':
      return /^[\w.-]+\/[\w.-]+#\d+$/.test(ref) || /^https:\/\/github\.com\/\S+\/pull\/\d+/.test(ref) ? null : `${ref} is not a PR (owner/name#n)`;
    case 'memory':
    case 'decision':
    case 'precedent':
    case 'setting':
      return `a ${src.kind} is not a source an agent can check; cite what it rests on`;
  }
}

/** The tool bodies, without the SDK around them, so they can be tested on their own. */

/** How long her turn waits for one read of an environment. */
export const READ_TIMEOUT_MS = 45_000;

export function orchestratorHandlers({ log, state, orchestrator, lookups, investigators, control, reviews, session, abilities, readTimeoutMs = READ_TIMEOUT_MS, now = Date.now }: ToolDeps) {
  // Who it is from is not hers to say: it is whoever wrote the latest message she is answering.
  const speaker = (): 'alex' | 'tester' => {
    if (session) return session.speaker();
    const last = [...state().messages].reverse().find((m) => m.role !== 'elfoqsy');
    return last?.role === 'test' ? 'tester' : 'alex';
  };
  // His settings change only when he asked, in his own words, in his latest message here: a report, a finding
  // or a page she read cannot change them for him, and neither can the tester.
  const hisLatest = (asked: string): { error: 'not_his'; message: string } | null => {
    if (speaker() === 'tester' || !session) return { error: 'not_his', message: 'Only alex changes delegation, precedents and how many agents work at once.' };
    const latest = [...state().messages].reverse().find((m) => m.conversationId === session.conversationId && (m.role === 'you' || m.role === 'test'));
    const quote = norm(asked);
    if (!latest || latest.role !== 'you' || quote.length < 12 || quote.split(' ').length < 3 || !norm(latest.text).includes(quote)) {
      return { error: 'not_his', message: 'asked must quote, word for word, his latest message in this conversation, where he asks for this change. Only he changes these.' };
    }
    return null;
  };
  const ticketKey = (key: string) => key.trim().toUpperCase();
  // What the proxy says, in its words: the output, or why it was refused or failed (a name kubectl did not find says to list first).
  const readEnvironment = async (proxy: ProxyName, input: Record<string, unknown>) => {
    if (!orchestrator?.elfoqsyRead) return NO_READS;
    // Whatever else would hold her turn, which is waited on, is not waited for: the call goes on to its own end by itself.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((done) => {
      timer = setTimeout(() => done('late'), readTimeoutMs);
      timer.unref?.();
    });
    const answered = await Promise.race([orchestrator.elfoqsyRead(proxy, input), late]).finally(() => clearTimeout(timer));
    if (answered === 'late') return { error: 'failed', message: `That read took longer than ${Math.round(readTimeoutMs / 1000)} seconds, so it is not waited for. Ask for less (a smaller time range, --tail, one name from a list).` };
    const r = answered;
    if (r.ok) return { proxy, output: r.text };
    const hint = proxy === 'kube' && /\bNotFound\b|not found/i.test(r.text) ? ` ${LIST_FIRST}` : '';
    return { error: r.text.startsWith('Refused:') ? 'refused' : 'failed', message: `${r.text}${hint}` };
  };
  return {
    list_sprint: () => {
      const s = state();
      const tickets = Object.values(s.tickets).sort((a, b) => a.key.localeCompare(b.key));
      const sprints = [...new Map(tickets.filter((t) => t.sprint).map((t) => [`${t.board}/${t.sprint}`, { board: t.board, name: t.sprint }])).values()];
      return { sprints, tickets, prs: Object.values(s.prs) };
    },
    get_ticket: ({ key }: { key: string }) => {
      const s = state();
      const ticket = s.tickets[key.toUpperCase()];
      if (!ticket) return { error: 'unknown_ticket' };
      return {
        ticket,
        prs: Object.values(s.prs).filter((p) => p.ticket === ticket.key),
        runs: s.runOrder.map((id) => s.runs[id]!).filter((r) => r.ticket === ticket.key),
      };
    },
    // One agent per ticket, always Opus 5.5 at xhigh: there is deliberately no model parameter.
    // A run the tester asked for is the tester's: its folder is kept only for commits.
    spawn_agent: (args: { ticketKey: string; goal?: string; repos?: string[]; confirmManual?: boolean; handoffId?: string; fromRun?: string }) =>
      orchestrator
        ? orchestrator.spawn({ ...args, ...(session ? { conversationId: session.conversationId } : {}), ...(speaker() === 'tester' ? { test: true } : {}) })
        : NOT_YET,
    list_runs: ({ state: wanted }: { state?: RunState }) => ({
      runs: runSummary(state()).filter((r) => !wanted || r.state === wanted),
    }),
    get_run: ({ runId }: { runId: string }) => {
      const run = state().runs[runId];
      if (!run) return { error: 'unknown_run' };
      return { run, recentEvents: log.readRun(runId, 50) };
    },
    cancel_run: ({ runId, reason }: { runId: string; reason: string }) => (orchestrator ? orchestrator.cancel(runId, reason) : NOT_YET),
    // Recorded as asked for by whoever wrote the message she is answering; the run stays failed in history.
    dismiss_run: ({ runId, reason }: { runId: string; reason?: string }) => {
      const run = state().runs[runId];
      if (!run) return { error: 'unknown_run', message: `There is no run ${runId}.` };
      if (run.state !== 'failed') return { error: 'not_failed', message: `Agent ${run.agentNumber} on ${run.ticket} has not failed (${run.state}); only a failed run can be dismissed.` };
      if (run.dismissed) return { error: 'already_dismissed', message: `Agent ${run.agentNumber} on ${run.ticket} is already dismissed.` };
      log.append('elfoqsy', 'run.dismissed', { runId, by: speaker() === 'tester' ? 'tester' : 'you', ...(reason?.trim() ? { reason: reason.trim() } : {}) });
      return { ok: true, message: `Agent ${run.agentNumber} on ${run.ticket} no longer counts as broken; it stays failed in history.` };
    },
    tell_agent: ({ runId, text }: { runId: string; text: string }) => (orchestrator ? orchestrator.tell(runId, text, speaker()) : NOT_YET),
    read_events: ({ sinceSeq, types, limit }: { sinceSeq?: number; types?: string[]; limit?: number }) => ({
      events: log.readFrom(sinceSeq ?? 0, Math.min(limit ?? 100, MAX_EVENTS), types),
    }),

    // A task agent, only for work he asked for in this conversation: request quotes his message word for word.
    draft_ticket: (args: TicketDraft) => {
      if (!session) return NO_CONVERSATION;
      if (!orchestrator?.draftTicket) return NOT_YET;
      const made = orchestrator.draftTicket({ by: 'elfoqsy', conversationId: session.conversationId, draft: { ...args, project: args.project.toUpperCase() } });
      if ('error' in made) return made;
      session.addBlocks([{ type: 'draft', ref: made.draftId }]);
      return { ok: true, draftId: made.draftId, note: 'The card is in your reply; it waits for him. Nothing was created in Jira.' };
    },
    jira_write: async (args: { action: 'set_field' | 'comment' | 'transition'; key: string; field?: string; text?: string; value?: unknown; to?: string }) => {
      // Jira writes are his: never on the tester's word.
      if (speaker() === 'tester') return { error: 'not_his', message: 'Only alex has his Jira tickets changed; the tester cannot.' };
      if (!orchestrator?.elfoqsyJira) return NOT_YET;
      const key = ticketKey(args.key);
      const input =
        args.action === 'set_field'
          ? { action: 'set_field', key, field: args.field ?? '', ...(args.text !== undefined ? { text: args.text } : {}), ...(args.value !== undefined ? { value: args.value } : {}) }
          : args.action === 'comment'
            ? { action: 'comment', key, text: args.text ?? '' }
            : { action: 'transition', key, to: args.to ?? '' };
      return orchestrator.elfoqsyJira(input);
    },
    start_task: (args: { name: string; goal: string; deliverable: DeliverableKind; model: string; effort: Effort; repos?: string[]; request: string }) => {
      if (!session) return NO_CONVERSATION;
      if (!orchestrator?.spawnTask) return NOT_YET;
      const quote = norm(args.request);
      const theirs = state().messages.filter((m) => m.conversationId === session.conversationId && (m.role === 'you' || m.role === 'test'));
      const from = quote.length >= 20 && quote.split(' ').length >= 4 ? theirs.filter((m) => norm(m.text).includes(quote)) : [];
      if (!from.length) {
        return { error: 'not_asked', message: 'request must quote, word for word, the message in this conversation where alex asked for this work. Work he never asked for needs his agreement first.' };
      }
      const test = speaker() === 'tester' || from.every((m) => m.role === 'test');
      return orchestrator.spawnTask({ name: args.name, goal: args.goal, deliverable: args.deliverable, model: args.model, effort: args.effort, ...(args.repos?.length ? { repos: args.repos } : {}), conversationId: session.conversationId, ...(test ? { test: true } : {}) });
    },
    // His delegation settings, precedents and the agents-at-once limit: what she may decide for him.
    delegation: () => {
      const s = state();
      return {
        settings: DELEGATION_CATEGORIES.map((c) => ({ category: c.category, what: c.label, setting: s.delegation[c.category] })),
        precedents: Object.values(s.precedents).map((p) => ({ precedentId: p.precedentId, category: p.category, ticketType: p.ticketType, question: p.question, answer: p.answer, at: new Date(p.at).toISOString() })),
        maxAgents: s.settings.maxAgents,
      };
    },
    set_delegation: ({ category, setting, asked }: { category: DelegationCategory; setting: DelegationSetting; asked: string }) => {
      const not = hisLatest(asked);
      if (not) return not;
      log.append('elfoqsy', 'delegation.set', { category, setting, by: 'you' });
      return { ok: true, message: `${DELEGATION_CATEGORIES.find((c) => c.category === category)?.label}: ${SETTING_WORDS[setting]}.` };
    },
    remove_precedent: ({ precedentId, asked }: { precedentId: string; asked: string }) => {
      const not = hisLatest(asked);
      if (not) return not;
      if (!state().precedents[precedentId]) return { error: 'unknown_precedent', message: `There is no precedent ${precedentId}.` };
      log.append('elfoqsy', 'precedent.removed', { precedentId, by: 'you' });
      return { ok: true };
    },
    set_max_agents: ({ value, asked }: { value: number; asked: string }) => {
      const not = hisLatest(asked);
      if (not) return not;
      log.append('elfoqsy', 'workspace.setting', { key: 'maxAgents', value, by: 'you' });
      return { ok: true, message: `Up to ${value} agents work at once.` };
    },
    // What she decided as first responder, newest first, with what each rests on and whether he changed it.
    decisions: ({ runId, limit }: { runId?: string; limit?: number }) => ({
      decisions: Object.values(state().decisions)
        .filter((d) => !runId || d.runId === runId)
        .sort((a, b) => b.at - a.at)
        .slice(0, Math.min(limit ?? 20, 50))
        .map((d) => ({ decisionId: d.decisionId, runId: d.runId, summary: d.summary, answer: d.answer, category: d.category, basis: d.basis, sources: d.sources, at: new Date(d.at).toISOString(), ...(d.changed ? { changed: d.changed.how, to: d.changed.to } : {}) })),
    }),

    show: ({ blocks }: { blocks: MessageBlock[] }) => {
      if (!session) return NO_CONVERSATION;
      const problems = blockProblems(state(), blocks);
      if (problems.length) return { error: 'bad_blocks', message: problems.join(' ') };
      session.addBlocks(blocks);
      return { ok: true, message: `${blocks.length} block${blocks.length === 1 ? '' : 's'} will show under your reply.` };
    },
    write_ability: async (a: z.infer<z.ZodObject<typeof SHAPES.write_ability>>) => {
      if (!abilities) return { error: 'not_set_up', message: 'Abilities are not set up here.' };
      // The shared abilities are his and his agents': the tester's conversation does not change them.
      if (speaker() === 'tester') return { error: 'not_his', message: 'The tester is testing: abilities are written from alex\'s work only.' };
      const { update, quiet, friction, steps, say, ...draft } = a;
      return abilities.write(
        { ...draft, steps: steps.map(({ effect, ...s }) => ({ ...s, ...(effect ? { effect: true as const } : {}) })) as AbilityStep[] },
        { ...(update ? { update } : {}), ...(quiet ? { quiet } : {}), ...(friction ? { friction } : {}), ...(say ? { say } : {}), ...(session ? { conversationId: session.conversationId } : {}) },
      );
    },
    name_conversation: ({ title, ticket }: { title: string; ticket?: string }) => {
      if (!session) return NO_CONVERSATION;
      const key = ticket ? ticketKey(ticket) : undefined;
      if (key && !state().tickets[key]) return { error: 'unknown_ticket', message: `${key} is not in the sprint.` };
      log.append('elfoqsy', 'conversation.renamed', { conversationId: session.conversationId, title: title.trim(), ...(key ? { ticket: key } : {}) });
      return { ok: true };
    },
    remember: ({ statement, sources, freshForDays, learnedFrom }: { statement: string; sources: Array<z.infer<typeof sourceRefSchema>>; freshForDays: number; learnedFrom: 'lookup' | 'run' | 'alex' }) => {
      // A fact the tester told her is never saved as his.
      if (learnedFrom === 'alex' && speaker() === 'tester') {
        return { error: 'not_his', message: 'The tester said this, not alex; save only what a lookup or a run showed.' };
      }
      const factId = `fact-${ulid().toLowerCase()}`;
      log.append('elfoqsy', 'memory.saved', {
        factId,
        statement: statement.trim(),
        sources,
        freshUntil: new Date(now() + freshForDays * DAY).toISOString(),
        origin: learnedFrom === 'alex' ? 'you' : learnedFrom,
      });
      return { ok: true, factId };
    },
    recall: ({ text, ticket }: { text?: string; ticket?: string }) => {
      const words = (text ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const key = ticket ? ticketKey(ticket) : undefined;
      const facts = Object.values(state().memory)
        .filter((f) => {
          const hay = `${f.statement} ${f.sources.map((s) => s.ref).join(' ')}`.toLowerCase();
          return (!key || hay.includes(key.toLowerCase())) && words.every((w) => hay.includes(w));
        })
        .sort((a, b) => b.at - a.at)
        .slice(0, 20)
        .map((f) => ({ factId: f.factId, statement: f.statement, sources: f.sources, found: new Date(f.at).toISOString(), by: f.origin, stale: f.freshUntil < now() }));
      return { facts };
    },
    lookup_jira: (args: { key?: string; jql?: string; limit?: number }) => (lookups ? lookups.jira(args) : NOT_YET),
    lookup_github: (args: { repo: string; what: 'pr' | 'prs' | 'commits' | 'checks' | 'search'; number?: number; ref?: string; query?: string }) =>
      lookups ? lookups.github(args) : NOT_YET,
    lookup_confluence: (args: { cql?: string; pageId?: string; limit?: number }) => (lookups ? lookups.confluence(args) : NOT_YET),
    lookup_code: (args: { repo: string; text?: string; glob?: string; ignoreCase?: boolean; path?: string; from?: number; lines?: number }) =>
      lookups ? lookups.code(args) : NOT_YET,
    // Her own reads: the proxies' tier-0 operations, classified and logged like an agent's, never asked and never a write.
    kube: ({ args }: { args: string[] }) => readEnvironment('kube', { args }),
    aws: ({ args }: { args: string[] }) => readEnvironment('aws', { args }),
    gh: ({ args }: { args: string[] }) => readEnvironment('gh', { args }),
    logs: (args: { query: string; environment?: string; application?: string; from?: string; to?: string; limit?: number }) => readEnvironment('logs', args),
    investigate: (args: { question: string; model: string; effort: string; repos?: string[] }) => {
      if (!session) return NO_CONVERSATION;
      return investigators ? investigators.start({ ...args, conversationId: session.conversationId }) : NOT_YET;
    },
    // The handoff: his words (every message of his in this conversation, copied by the orchestrator, never hers), his
    // constraints (each quoted from one of those messages) and facts with a source the agent can check. A fact without
    // one, or one that reads as a diagnosis or a plan, is dropped. Nothing of how to fix the ticket reaches the agent.
    write_handoff: (args: {
      ticket: string;
      mode: RunMode;
      bases?: Array<{ repo: string; branch: string }>;
      constraints: Array<{ text: string }>;
      facts: Array<{ text: string; sources: SourceRef[] }>;
    }) => {
      if (!session) return NO_CONVERSATION;
      const s = state();
      const key = ticketKey(args.ticket);
      const t = s.tickets[key];
      if (!t || !isOpen(t)) return { error: 'unknown_ticket', message: `${key} is not an open ticket in the sprint.` };
      const bases = Object.fromEntries((args.bases ?? []).map((b) => [b.repo, b.branch.trim()]));
      if (args.mode === 'hotfix') {
        if (!args.bases?.length) return { error: 'base_needed', message: 'A hotfix needs its target branch (release/<version>) in each repository. Ask alex which one when it is not clear from the ticket.' };
        const wrong = Object.entries(bases).filter(([, b]) => !/^release\/[\w.-]+$/.test(b));
        if (wrong.length) return { error: 'base_needed', message: `A hotfix targets a release branch (release/<version>), not ${wrong.map(([, b]) => b).join(', ')}. Ask alex if unsure.` };
      }
      // His words, as he wrote them: every message of his (or the tester's, in a test) in this conversation. Hers never.
      const context = s.messages
        .filter((m) => m.conversationId === session.conversationId && (m.role === 'you' || m.role === 'test'))
        .slice(-MAX_CONTEXT)
        .map((m) => ({ messageId: m.messageId, role: m.role === 'test' ? ('test' as const) : ('you' as const), text: m.text }));
      const dropped: Array<{ text: string; reason: string }> = [];
      const constraints: Array<{ text: string; messageId: string }> = [];
      for (const c of args.constraints) {
        const from = norm(c.text).length >= 3 ? context.find((m) => norm(m.text).includes(norm(c.text))) : undefined;
        if (!from) dropped.push({ text: c.text, reason: 'not his words: a constraint is quoted from one of his messages in this conversation, as he wrote it' });
        else constraints.push({ text: c.text.trim(), messageId: from.messageId });
      }
      // What investigators in this conversation read: a file and line counts as a source only then.
      const read = new Set(
        Object.values(s.investigations)
          .filter((i) => i.conversationId === session.conversationId)
          .flatMap((i) => i.findings.flatMap((f) => f.sources.filter((x) => x.kind === 'code').flatMap((x) => [x.ref, x.ref.replace(/:\d+(-\d+)?$/, '')]))),
      );
      const facts: Array<{ text: string; sources: SourceRef[] }> = [];
      for (const f of args.facts) {
        if (CONCLUSION.test(f.text)) {
          dropped.push({ text: f.text, reason: 'it reads as a diagnosis or a plan; the handoff says what was observed, and the agent decides the rest' });
          continue;
        }
        const checked = f.sources.map((src) => ({ src, problem: sourceProblem(src, read) }));
        const good = checked.filter((c) => !c.problem).map((c) => c.src);
        if (!good.length) {
          dropped.push({ text: f.text, reason: `no source the agent can check${checked.length ? ` (${checked.map((c) => c.problem).join('; ')})` : ''}` });
          continue;
        }
        facts.push({ text: f.text.trim(), sources: good });
      }
      const handoffId = `handoff-${ulid().toLowerCase()}`;
      log.append('elfoqsy', 'handoff.created', {
        handoffId,
        conversationId: session.conversationId,
        ticket: key,
        mode: args.mode,
        ...(Object.keys(bases).length ? { bases } : {}),
        context,
        constraints,
        facts,
        ...(dropped.length ? { dropped } : {}),
      });
      return {
        ok: true,
        handoffId,
        kept: { hisMessages: context.length, constraints: constraints.length, facts: facts.length },
        ...(dropped.length ? { dropped } : {}),
        message: `Start the agent with spawn_agent and this handoffId, and show it with a handoff block (ref ${handoffId}). spawn_agent refuses it once alex writes again in this conversation: then write a fresh one.${dropped.length ? ' The dropped items are not in it; do not repeat them to the agent.' : ''}`,
      };
    },
    // Recorded as asked for by whoever she is answering; the reason marks it as hers so it is not told back to her.
    pause_run: ({ runId, reason }: { runId: string; reason?: string }) => {
      if (!control) return NOT_YET;
      return control.pause(runId, speaker() === 'tester' ? 'tester' : 'you', `${THROUGH_ELFOQSY}${reason?.trim() ? `: ${reason.trim()}` : ''}`);
    },
    resume_run: ({ runId }: { runId: string }) => (control ? control.resume(runId, speaker() === 'tester' ? 'tester' : 'you', THROUGH_ELFOQSY) : NOT_YET),
    // A rule from guidance, once confirmed: for the run's repositories, or all repos. The tester's are kept
    // but never given to a real run.
    save_rule: ({ statement, runId, allRepos }: { statement: string; runId?: string; allRepos?: boolean }) => {
      const run = runId ? state().runs[runId] : undefined;
      if (!allRepos && !run?.repos?.length) {
        return { error: 'no_repo', message: runId ? `That run's repositories are not known; save it for all repos only if alex says so.` : 'Name the run the guidance was given to, or allRepos.' };
      }
      const tester = speaker() === 'tester';
      const factId = `rule-${ulid().toLowerCase()}`;
      log.append('elfoqsy', 'memory.saved', {
        factId,
        statement: statement.trim(),
        sources: run ? [{ kind: 'ticket', ref: run.ticket, label: `guidance to Agent ${run.agentNumber}` }] : [],
        freshUntil: new Date(now() + 10 * 365 * DAY).toISOString(),
        origin: tester ? 'tester' : 'you',
        kind: 'rule',
        ...(allRepos ? {} : { repos: run!.repos! }),
      });
      return { ok: true, factId, scope: allRepos ? 'all repos' : run!.repos!.join(', '), ...(tester ? { note: 'Confirmed by the tester: kept, but never given to a real run.' } : {}) };
    },
    forget: ({ factId }: { factId: string }) => {
      const fact = state().memory[factId];
      if (!fact) return { error: 'unknown_fact', message: `There is no fact or rule ${factId}.` };
      log.append('elfoqsy', 'memory.forgotten', { factId, by: speaker() === 'tester' ? 'tester' : 'you' });
      return { ok: true, forgotten: fact.statement };
    },
    dismiss_ci: ({ repo, number, reason }: { repo: string; number: number; reason?: string }) => {
      const s = state();
      const key = prKey({ repo, number });
      const pr = s.prs[key];
      if (!pr || !ciFailing(s, pr)) return { error: 'not_failing', message: `CI is not failing on ${repo} #${number}.` };
      if (s.ciDismissed[key]) return { error: 'already_dismissed', message: `The CI failure on ${repo} #${number} is already dismissed.` };
      log.append('elfoqsy', 'ci.dismissed', { repo, pr: number, sha: s.ci[key]?.sha ?? 'checks', by: speaker() === 'tester' ? 'tester' : 'you', ...(reason?.trim() ? { reason: reason.trim() } : {}) });
      return { ok: true, message: `The CI failure on ${repo} #${number} no longer counts as broken until its next CI result. The PR stays red on the map and in the ticket.` };
    },
    // QA is his word: from him, never from the tester, and the files are the workspace's.
    close_out: ({ ticket, qa }: { ticket: string; qa: string }) => {
      if (speaker() === 'tester') return { error: 'not_his', message: 'Only alex says QA passed.' };
      return orchestrator?.closeOut ? orchestrator.closeOut(ticketKey(ticket), qa.trim()) : NOT_YET;
    },
    record_review: ({ weekOf, suggestions }: { weekOf: string; suggestions: string[] }) => {
      if (!session) return NO_CONVERSATION;
      const metrics = reviews?.pending(weekOf);
      if (!metrics) return { error: 'no_review', message: `There is no weekly review waiting for ${weekOf}.` };
      log.append('elfoqsy', 'review.weekly', { weekOf, conversationId: session.conversationId, metrics, suggestions: suggestions.map((x) => x.trim()) });
      reviews!.done(weekOf);
      return { ok: true, message: `Recorded. Show it with a review block (ref ${weekOf}).` };
    },
  } satisfies Record<ToolName, (args: never) => unknown>;
}

const DISCOVER = 'Discover before you act: list first (for example get deployments), then ask about one that was in the list; never guess a name.';
const YOURS = 'This is yours: a question these reads can answer, you answer here, yourself, without starting an agent or an investigator. Reads only: a change, a secret, anything that is not a free read, prod and a context or profile that is not ours are refused, and the answer says so; an agent asks him for those.';

/**
 * Her own reads of the environments. With the environments known, the description names them: she picks from
 * those and never guesses one.
 */
export function readDescription(name: 'kube' | 'aws' | 'gh' | 'logs', envs?: Environments): string {
  const contexts = envs?.list.filter((e) => e.kubeContext).map((e) => e.name).join(', ');
  const profiles = envs?.list.filter((e) => e.awsProfile).map((e) => `${e.awsProfile} (${e.name})`).join(', ');
  const apps = envs?.list.filter((e) => e.coralogixApplication).map((e) => e.name).join(', ');
  switch (name) {
    case 'kube':
      return `Read a cluster yourself, through the orchestrator (kubectl, with your own kubeconfig): get, describe, logs, events, top, rollout status. Pass kubectl's arguments without "kubectl", and name the environment on every call with --context${contexts ? `: ${contexts}` : ''}; the environment's namespace is added for you. get -o json and -o yaml, describe and rollout history show every environment variable's value as <hidden>; an output format that can print a value by itself is refused to you (read the whole object with -o yaml instead). For several environments, call once for each, together. ${DISCOVER} ${YOURS}`;
    case 'aws':
      return `Read AWS yourself, through the orchestrator (the AWS CLI): describe-, list- and get- calls, s3 ls, sts get-caller-identity. Reads whose answer is a secret or text a secret can hide in (secretsmanager, an SSM parameter of any type, command output, user data, an API key's value, a configuration's content, a Lambda function's environment values with get-function or get-function-configuration, a resource's whole configuration from cloudcontrol or config, a Step Functions execution's input and output, an Amplify app's login) are refused to you, and an agent asks him for them; calls that mint credentials or tokens are never done. Every other read that returns environment variables (lambda list-functions, ECS task definitions and tasks, Batch, CodeBuild and more) or a field that holds a credential (a client secret, a webhook's token, a connection's password) is yours, with each such value shown as <hidden> (names and fields stay; the answer is JSON, and a --query runs on it with the values already hidden). A read that writes its answer to a file named in the call is refused to you too. Write options in full (--profile, not --prof): the start of an option's name is refused. Pass aws's arguments without "aws", and name the profile on every call with --profile${profiles ? `: ${profiles}` : ''}. ${DISCOVER} ${YOURS}`;
    case 'gh':
      return `Read GitHub yourself, through the orchestrator (gh, with alex's login): pr view, list, diff and checks, run list and view, api reads, search. Pass gh's arguments without "gh", and name the repository with --repo OWNER/NAME. ${DISCOVER} ${YOURS}`;
    case 'logs':
      return `Read Coralogix logs of a non-prod environment${apps ? ` (${apps})` : ''} or application yourself: the DataPrime after the source and filter (for example: filter $m.severity == ERROR | limit 50), and from/to as ISO times or how far back (15m, 2h, 1d). The workspace adds the application filter. Discover before you act: list first (a small query without a filter shows the fields the logs really have), then filter on those; never guess a name. ${YOURS}`;
  }
}

export const DESCRIPTIONS: Record<ToolName, string> = {
  list_sprint: "alex's tickets in the open SHOP and CORE sprints, with their pull requests.",
  get_ticket: 'One ticket as the workspace knows it, with its pull requests and any agent runs on it.',
  spawn_agent:
    "Start the one agent for a ticket (Opus 5.5 at xhigh; it picks its own sub-agents) once alex agrees to work on it. Pass handoffId: the handoff you wrote is its first instruction, with its mode. Pass repos (owner/name) unless the ticket already has open PRs. Pass fromRun (an ended run of the same ticket) only when he agreed to start from that run's kept work: the branch then starts from its kept folder, and the push lists those commits and who made them. If the result carries a usage notice, the agent has started: say the notice in one short sentence, with nothing to confirm. If it says he may be working on the ticket himself, ask him, and call again with confirmManual: true only when he says go.",
  list_runs: 'Agent runs, optionally only those in one state.',
  get_run: 'One agent run and its last 50 events.',
  cancel_run: 'Stop an agent run. The result says what is left: whether the branch is on GitHub, unpushed commits, uncommitted changes, and whether the run folder was removed. Tell him its summary and nothing beyond it.',
  dismiss_run:
    'Acknowledge a failed run when alex (or the tester) says to dismiss it: it stops counting as broken and leaves the map, and stays failed in history and analytics. Only when asked.',
  tell_agent:
    "Pass a message from alex to a run's agent, for example his objection to its plan, in his words. Only when he asks. The agent gets it as a new turn and may change its plan.",
  read_events: 'Events from the workspace log after a given seq, optionally only some types, at most 500.',
  show:
    "Blocks to show under the reply you are writing: ticket (key), findings (investigation id), progress (run id), sprint (sprint name), approval (approval id), handoff (handoff id), verdict (run id: its agent's verdict), code (inline, with language and diff). Every id must exist; the screen fills them in.",
  name_conversation: 'Give this conversation a short title, and its ticket when it is about one.',
  write_ability:
    "Write an ability: a short procedure for next time, active at once, granting nothing. Write one, without asking, as soon as friction in your own conversation or reads is worth it: the same friction twice, or once at a high cost (several failed or retried calls, a long search, a question to alex). tool: the tool its card shows the logo of: kubernetes, coralogix, github, aws, jira, confluence, docker, test, teams, outlook, sharepoint or onedrive, or elfoqsy when it is about your own workspace (runs, events, the sprint, tickets). Steps: at most 8, one short line each with its sample (code), the shortest form that still runs (the program and its main argument: about 30 characters beside a text of 40, because a card shows a step on one line); the full commands with their flags and what explains them go in references (markdown, 4000 characters at most), which an agent reads when a sample is not enough; the result lists the steps still too long for a line (long): write them again shorter; a read step carries the exact request of your kube, aws, gh or logs tool that shows it works (it is run, tier 0 only, to verify it); a step that changes anything is effect and is never run. track: the tools it covers (kube, aws, gh, logs, start_task) and optionally a regular expression over their arguments. whenToUse: phrased the way alex asks for that work. friction: what happened, in one short clause of 80 characters at most (the Abilities view shows it on one line), and what it cost (calls, failed calls, questions to him): it is its baseline. To change one, send it whole with update: true; its credit and baseline stay. A quiet update (quiet: true, with update: true) is the same ability with its samples written shorter, and has no message of its own: no say; you say one line about all of them at the end of your reply. say: the one line you tell him about it, written by you, in your voice and in the language he is writing to you now (Vietnamese with tôi and cậu when he writes Vietnamese): what you can do now that you could not, as a sentence of your own, never the ability's title put after 'I learned how to'. It is posted in this conversation with the ability's card: do not repeat it in your reply. Procedures go here; facts go to remember.",
  remember:
    'Save a fact you will need again, with its sources and how many days it stays true. learnedFrom says where it came from: a lookup, a run, or alex himself (never the tester). An investigator\'s findings are saved for you already; do not save them again.',
  recall: 'Facts you saved earlier that mention these words or this ticket, newest first; stale ones need re-checking.',
  lookup_jira: 'Read Jira: one ticket in full by key (every field Jira shows, with its name; rich text as Markdown; linked items, sub-tasks, Confluence pages, attachments, comments and recent history), or a JQL search (at most 20). Read-only.',
  lookup_github: 'Read GitHub on a polled repository: one PR (number), its PRs, commits (ref), checks of a commit or branch (ref), or code search (query). Read-only.',
  lookup_confluence: 'Read Confluence: a CQL search (at most 10 results) or one page (pageId) as text. Read-only.',
  lookup_code:
    "Read alex's clones: search for text as written (text, optional glob), or read part of a file (path, from, lines). Read-only.",
  kube: readDescription('kube'),
  aws: readDescription('aws'),
  gh: readDescription('gh'),
  logs: readDescription('logs'),
  investigate:
    'Start a read-only investigator on a question you cannot answer from the state, memory or lookups. Pick the model (haiku, sonnet or opus) and effort (low to xhigh) by how hard it is; it reads the code, Jira, GitHub and Confluence and reports findings with sources, which come back to you in this conversation. No approval needed.',
  pause_run: 'Pause an agent when alex asks: its turn stops and nothing runs until resume_run. A pending approval stays as it is.',
  resume_run: 'Resume a paused agent when alex asks.',
  save_rule:
    'Keep guidance as a lasting rule, only after alex confirmed it: for the repositories of the run it was given to (runId), or all repos when he says so (allRepos). Later runs there get it in their first instruction.',
  forget: 'Forget a fact or rule (its id) when alex says "forget that rule".',
  dismiss_ci:
    'Acknowledge a CI failure on an open PR when alex says to dismiss it: it stops counting as broken until the next CI result on that PR; the PR stays red on the map and in the ticket. Nothing reaches GitHub. Only when asked.',
  record_review: "Record the weekly review's suggestions (at most three, each with the number behind it) for the weekOf you were given; then show the review block.",
  close_out:
    "When alex says QA passed on a merged ticket an agent worked on: case.md regenerated from the log, the QA testing notes and the solution page's draft go to its ticket folder, and publishing the page is asked. qa: how it passed, in his words. Jira moving the ticket to Done does the same on its own.",
  start_task:
    "Start a task agent for work alex asked for that is not tied to a ticket: reviewing a teammate's PR, a Confluence solution page in the team's usual style, release notes, comparing what runs on integration and staging, analysing logs, triaging Black Duck findings, QA notes. name: a short name (shown where a ticket key would be); goal: what to do and what to deliver; deliverable: document, table or code; model and effort by the work (haiku for lookups, sonnet for drafting, opus for deep code work); repos it needs, if any; request: his message asking for it, quoted word for word. Work he never asked for needs his agreement first. Its result comes back into this conversation.",
  delegation: 'His delegation settings (what you decide, decide and tell him, or ask him), his precedents, and how many agents may work at once.',
  draft_ticket:
    "Draft a new Jira ticket for alex: a card in your reply with Create in Jira, Edit first and Discard. Only he creates tickets; this creates nothing. project (SHOP), type (Bug, Story, Task), summary, description as Markdown, and if you know them: priority, storyPoints, sprint { id, name }, labels, links ({ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }), parent.",
  jira_write:
    "Change one of alex's Jira tickets, through the Jira proxy and his delegation. set_field: a field by its Jira name (text as Markdown for rich text, or value in Jira's own shape); comment: text; transition: to, the target status or transition name. Filling an empty field of a ticket assigned to him follows his delegation (by default you do it and tell him in one line). Comments, transitions and writing over a value are asked of him and run when he approves; you hear that it was asked, so say so in one line and do not ask again. Never on the tester's word. Tickets are created only by him.",
  set_delegation: 'Change one delegation setting (decide, decide_and_tell or ask), only when alex asks: asked quotes his latest message, word for word, where he asks for it.',
  remove_precedent: 'Remove one of his precedents ("Let Elfoqsy decide this kind next time"), only when he asks: asked quotes his latest message, word for word.',
  set_max_agents: 'Change how many agents may work at once, only when alex asks: asked quotes his latest message, word for word.',
  decisions: 'What you decided as first responder for agents (answers and requests), newest first, with what each rests on and whether he changed it.',
  write_handoff:
    "Hand a ticket over to its agent once alex agrees to work on it. You gather context and facts; you do not decide how it is fixed. His messages in this conversation go in word for word on their own (yours never do). constraints: his constraints, each quoted word for word from one of his messages. facts: what is known, each with a source the agent can check (the ticket, a file and line an investigator read, a log query, a page or link, a PR); a fact without one, or one that reads as a cause or a fix, is dropped. mode: normal, read_only, hotfix (bases: the release/<version> branch per repository; ask him if unclear) or remediation (Black Duck or Sonar). It opens as a document on the left screen.",
};

const blockShape = z.array(messageBlockSchema).min(1).max(6);

export const SHAPES = {
  list_sprint: {},
  get_ticket: { key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]+-\d+$/) },
  spawn_agent: {
    ticketKey: z.string(),
    goal: z.string().optional(),
    repos: z.array(z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/)).optional(),
    confirmManual: z.boolean().optional(),
    handoffId: z.string().optional(),
    fromRun: z.string().min(1).optional(),
  },
  list_runs: { state: runStateSchema.optional() },
  get_run: { runId: z.string().min(1) },
  cancel_run: { runId: z.string().min(1), reason: z.string() },
  dismiss_run: { runId: z.string().min(1), reason: z.string().max(300).optional() },
  tell_agent: { runId: z.string().min(1), text: z.string().trim().min(1).max(2000) },
  read_events: {
    sinceSeq: z.number().int().nonnegative().optional(),
    types: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(MAX_EVENTS).optional(),
  },
  show: { blocks: blockShape },
  name_conversation: { title: z.string().trim().min(1).max(80), ticket: z.string().optional() },
  remember: {
    statement: z.string().trim().min(1).max(400),
    sources: z.array(sourceRefSchema).min(1).max(6),
    freshForDays: z.number().int().min(1).max(90),
    learnedFrom: z.enum(['lookup', 'run', 'alex']),
  },
  recall: { text: z.string().optional(), ticket: z.string().optional() },
  lookup_jira: { key: z.string().optional(), jql: z.string().optional(), limit: z.number().int().positive().max(20).optional() },
  lookup_github: {
    repo: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/),
    what: z.enum(['pr', 'prs', 'commits', 'checks', 'search']),
    number: z.number().int().positive().optional(),
    ref: z.string().optional(),
    query: z.string().optional(),
  },
  lookup_confluence: { cql: z.string().optional(), pageId: z.string().optional(), limit: z.number().int().positive().max(10).optional() },
  lookup_code: {
    repo: z.string(),
    text: z.string().optional(),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    path: z.string().optional(),
    from: z.number().int().positive().optional(),
    lines: z.number().int().positive().max(400).optional(),
  },
  kube: { args: z.array(z.string()).min(1).max(60) },
  aws: { args: z.array(z.string()).min(2).max(60) },
  gh: { args: z.array(z.string()).min(1).max(60) },
  logs: {
    query: z.string().max(4000),
    environment: z.string().max(40).optional(),
    application: z.string().max(120).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  investigate: {
    question: z.string().trim().min(1).max(1500),
    model: z.enum(['haiku', 'sonnet', 'opus']),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']),
    repos: z.array(z.string()).optional(),
  },
  draft_ticket: {
    project: z.string().regex(/^[A-Za-z][A-Za-z0-9_]+$/),
    type: z.string().min(1).max(60),
    summary: z.string().trim().min(1).max(255),
    description: z.string().max(20_000).optional(),
    priority: z.string().max(40).optional(),
    storyPoints: z.number().nonnegative().optional(),
    sprint: z.object({ id: z.number().int(), name: z.string() }).optional(),
    labels: z.array(z.string().min(1).max(100)).max(20).optional(),
    links: z.array(z.object({ linkType: z.string().min(1).max(80), direction: z.enum(['inward', 'outward']), other: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) })).max(10).optional(),
    parent: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/).optional(),
  },
  jira_write: {
    action: z.enum(['set_field', 'comment', 'transition']),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]+-\d+$/),
    field: z.string().max(120).optional(),
    text: z.string().max(20_000).optional(),
    value: z.unknown().optional(),
    to: z.string().max(80).optional(),
  },
  start_task: {
    name: z.string().trim().min(1).max(40),
    goal: z.string().trim().min(1).max(3000),
    deliverable: z.enum(['document', 'table', 'code']),
    model: z.enum(['haiku', 'sonnet', 'opus']),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']),
    repos: z.array(z.string()).max(6).optional(),
    request: z.string().trim().min(1).max(1000),
  },
  delegation: {},
  set_delegation: { category: delegationCategorySchema, setting: delegationSettingSchema, asked: z.string().trim().min(1).max(1000) },
  remove_precedent: { precedentId: z.string().min(1), asked: z.string().trim().min(1).max(1000) },
  set_max_agents: { value: z.number().int().min(1).max(20), asked: z.string().trim().min(1).max(1000) },
  decisions: { runId: z.string().optional(), limit: z.number().int().positive().max(50).optional() },
  pause_run: { runId: z.string().min(1), reason: z.string().max(200).optional() },
  resume_run: { runId: z.string().min(1) },
  save_rule: { statement: z.string().trim().min(1).max(300), runId: z.string().optional(), allRepos: z.boolean().optional() },
  forget: { factId: z.string().min(1) },
  dismiss_ci: { repo: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/), number: z.number().int().positive(), reason: z.string().max(300).optional() },
  record_review: { weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), suggestions: z.array(z.string().trim().min(1).max(300)).max(3) },
  close_out: { ticket: z.string(), qa: z.string().trim().min(1).max(500) },
  write_ability: {
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().trim().min(1).max(60),
    titleVi: z.string().trim().min(1).max(90),
    tool: z.enum(WRITABLE_ABILITY_TOOLS),
    whenToUse: z.string().trim().min(1).max(300),
    steps: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(80),
          code: z.string().max(200).optional(),
          read: z.object({ proxy: z.enum(['kube', 'aws', 'gh', 'logs']), input: z.record(z.string(), z.unknown()) }).optional(),
          effect: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(8),
    // The longer detail a short sample points to (the full commands with their flags, what explains them): the skill's references/steps.md.
    references: z.string().trim().min(1).max(4000).optional(),
    doneWhen: z.string().trim().min(1).max(200),
    track: z.object({ tools: z.array(z.string().min(1).max(80)).min(1).max(6), match: z.string().max(200).optional() }),
    friction: z.object({ what: z.string().trim().min(1).max(80), calls: z.number().int().min(0).max(200), failed: z.number().int().min(0).max(200), questions: z.number().int().min(0).max(50) }).optional(),
    update: z.boolean().optional(),
    // An update that needs no message of its own (the same ability, its samples written shorter): no say, one line in her reply instead.
    quiet: z.boolean().optional(),
    // What she says about it: her own words, in the language he is writing to her now. Required, but for a quiet update (the engine refuses without it).
    say: z.string().trim().min(8).max(300).optional(),
  },
  write_handoff: {
    ticket: z.string(),
    mode: runModeSchema,
    bases: z.array(z.object({ repo: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/), branch: z.string().trim().min(1).max(100) })).max(6).optional(),
    constraints: z.array(z.object({ text: z.string().trim().min(1).max(400) })).max(12),
    facts: z.array(z.object({ text: z.string().trim().min(1).max(500), sources: z.array(sourceRefSchema).max(6) })).max(20),
  },
} satisfies Record<ToolName, z.ZodRawShape>;

/** Runs one tool call: recorded first, then answered as redacted JSON. */
export async function callTool(deps: ToolDeps, name: ToolName, args: Record<string, unknown>) {
  deps.log.append('elfoqsy', 'tool.called', { tool: name, inputSummary: JSON.stringify(args).slice(0, 200), allowed: true });
  // Her thinking indicator: what she is doing in this conversation, in one line.
  const line = deps.session ? activityLine(name, args, deps.state()) : null;
  const activityId = ulid();
  const activity = (state: 'running' | 'done' | 'failed') => {
    if (line && deps.session) deps.log.append('elfoqsy', 'elfoqsy.activity', { conversationId: deps.session.conversationId, activityId, tool: line.tool, text: redact(line.text), state });
  };
  activity('running');
  try {
    const handler = orchestratorHandlers(deps)[name] as (a: Record<string, unknown>) => unknown;
    const result = redactDeep(await handler(args));
    deps.session?.noteOutcomes?.(outcomesOf(name, result));
    const failed = typeof result === 'object' && result !== null && 'error' in result;
    activity(failed ? 'failed' : 'done');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(failed ? { isError: true } : {}) };
  } catch (error) {
    activity('failed');
    // The workspace's own errors (a refused path, Jira's answer) say what to fix; redacted like the rest.
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'failed', message }) }], isError: true };
  }
}

const isReadTool = (name: ToolName): name is 'kube' | 'aws' | 'gh' | 'logs' => name === 'kube' || name === 'aws' || name === 'gh' || name === 'logs';

/** The in-process MCP server Elfoqsy's session connects to. */
export function orchestratorServer(deps: ToolDeps) {
  return createSdkMcpServer({
    name: ORCHESTRATOR,
    version: '1.0.0',
    tools: TOOL_NAMES.map((name) =>
      tool(name, deps.environments && isReadTool(name) ? readDescription(name, deps.environments) : DESCRIPTIONS[name], SHAPES[name], async (args) => callTool(deps, name, args as Record<string, unknown>)),
    ),
  });
}
