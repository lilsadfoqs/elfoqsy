// Elfoqsy as first responder: one short session of hers per agent question or escalation. She looks it up and
// either answers it (a question, only from sources she cites and only where alex lets her) or escalates it to
// him with her recommended option. The fidelity rule is checked here, not left to the prompt: every source she cites
// must be something a lookup returned in this session, a memory fact, an investigator's finding, an earlier answer or
// precedent of his, or the run's own ticket. She never answers from her own theory.
import { createSdkMcpServer, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DelegationCategory, Effort, QuestionCard, SourceRef } from '@elfoqsy/contracts';
import { runLabel, type ApprovalView, type WorkspaceState } from '@elfoqsy/state';
import { unanswered } from '../agents/approvals';
import { realClock, type Clock } from '../clock';
import type { UsageState } from '../claude/usage';
import type { Lookups } from '../elfoqsy/lookups';
import { handleLimitSignal, type QueryFn } from '../elfoqsy/session';
import { redact, redactDeep } from '../redact';
import { ticketTypeOf } from './categories';
import { telemetryEnv } from '../telemetry/env';

export const RESPONDER = 'responder';
/** She has this long to look and decide; then it goes to him with no suggestion. */
export const RESPONDER_MINUTES = 5;
const MAX_HIS_ANSWERS = 20;

export interface ResponderRequest {
  requestId: string;
  runId: string;
  kind: 'question' | 'action';
  /** An agent's question, as it asked it. */
  card?: QuestionCard;
  /** A tier-2 request: what it does, why it is asked, and its category. */
  action?: { summary: string; reason: string; category: DelegationCategory };
  /** She may answer it herself: a question whose category he lets her decide. Otherwise she can only escalate. */
  mayAnswer: boolean;
}

export type ResponderOutcome =
  | { kind: 'answer'; option: string; note?: string; sources: SourceRef[] }
  | { kind: 'escalate'; option: string; why: string; sources: SourceRef[] }
  | { kind: 'none'; reason: string };

export interface ResponderDeps {
  state: () => WorkspaceState;
  usage: UsageState;
  queryFn: QueryFn;
  lookups?: Lookups;
  /** Her rules as first responder; her conversation prompt is not used here. */
  systemPrompt: string;
  model: string;
  effort?: Effort;
  cwd: string;
  env: Record<string, string>;
  clock?: Clock;
  minutes?: number;
}

/** What she read in one session, so the sources she cites can be checked against it. */
export class Reads {
  readonly tickets = new Set<string>();
  readonly pages = new Set<string>();
  readonly urls = new Set<string>();
  /** repo/path and path, with the line ranges read or matched. */
  readonly code = new Map<string, Array<[number, number]>>();
  readonly logs: string[] = [];
  readonly prs = new Set<string>();

  /** The link of the thing itself that was read (its `url`), never links it merely mentions. */
  noteUrl(value: unknown): void {
    const url = value && typeof value === 'object' ? (value as { url?: unknown }).url : undefined;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) this.urls.add(url);
  }

  noteCode(repo: string, path: string, from: number, to: number): void {
    for (const key of [`${repo}/${path}`, path, `${repo.split('/')[1] ?? repo}/${path}`]) this.code.set(key, [...(this.code.get(key) ?? []), [from, to]]);
  }
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** An answer alex gave himself: not the tester's, not withdrawn, not closed by the workspace. */
const hisAnswer = (r: ApprovalView['resolution']): boolean => !!r && !r.test && !r.withdrawn && !unanswered(r);

/** Why she may not cite this source, or null when she may. */
export function citeProblem(src: SourceRef, ctx: { s: WorkspaceState; runId: string; reads: Reads; question: boolean }): string | null {
  const { s, runId, reads } = ctx;
  const ref = src.ref.trim();
  const run = s.runs[runId];
  const inFindings = Object.values(s.investigations).some((i) => i.findings.some((f) => f.sources.some((x) => x.kind === src.kind && x.ref.trim() === ref)));
  switch (src.kind) {
    case 'ticket':
      return run?.ticket === ref || reads.tickets.has(ref) || inFindings ? null : `${ref}: you did not read that ticket in this session`;
    case 'code': {
      if (inFindings) return null;
      const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(ref);
      if (!m) return `${ref}: a code source is path:line`;
      const ranges = reads.code.get(m[1]!) ?? [];
      const lo = Number(m[2]);
      const hi = Number(m[3] ?? m[2]);
      return ranges.some(([a, b]) => lo >= a && hi <= b) ? null : `${ref}: you did not read those lines in this session`;
    }
    case 'doc':
      return reads.pages.has(ref) || reads.urls.has(ref) || inFindings ? null : `${ref}: you did not read that page in this session`;
    case 'log':
      return reads.logs.some((q) => norm(q) === norm(ref)) ? null : `${ref}: you did not run that log query in this session`;
    case 'pr':
      return reads.prs.has(ref) || inFindings ? null : `${ref}: you did not read that PR in this session`;
    case 'url':
      return reads.urls.has(ref) || inFindings ? null : `${ref}: no tool returned that link in this session`;
    case 'memory':
      return s.memory[ref] ? null : `${ref}: there is no such fact in your memory`;
    case 'decision':
      return hisAnswer(s.approvals[ref]?.resolution) ? null : `${ref}: that is not an answer alex gave`;
    case 'precedent': {
      const p = s.precedents[ref];
      if (!p || p.by !== 'you') return `${ref}: there is no such precedent of alex's`;
      if (p.requestKind !== 'question') return `${ref}: that precedent is about actions, not questions`;
      return p.ticketType === ticketTypeOf(s, runId) ? null : `${ref}: that precedent is for ${p.ticketType} tickets`;
    }
    case 'setting':
      return ctx.question ? `${ref}: a setting is not a source for an answer` : null;
  }
}


const optionOf = (labels: string[], asked: string): string | undefined => labels.find((l) => norm(l) === norm(asked));

/** The options of what she considers: the card's, or Approve and Deny for an action. */
export const optionsOf = (r: ResponderRequest): string[] => (r.card ? r.card.options.map((o) => o.label) : ['Approve', 'Deny']);

export class Responder {
  private readonly clock: Clock;

  constructor(private readonly d: ResponderDeps) {
    this.clock = d.clock ?? realClock;
  }

  /** Her answer or escalation, or why she has neither. Never throws. */
  async consider(r: ResponderRequest): Promise<ResponderOutcome> {
    if (this.d.usage.isPaused) return { kind: 'none', reason: 'Claude is paused for the usage limit, so Elfoqsy could not look into it.' };
    const reads = new Reads();
    let outcome: ResponderOutcome | undefined;
    const settle = (o: ResponderOutcome) => {
      outcome ??= o;
    };
    const abort = new AbortController();
    const q = this.d.queryFn({ prompt: this.firstTurn(r), options: this.options(r, reads, settle, abort) });
    const minutes = this.d.minutes ?? RESPONDER_MINUTES;
    const timer = this.clock.setTimeout(() => {
      settle({ kind: 'none', reason: `Elfoqsy did not finish looking into it within ${minutes} minutes.` });
      abort.abort();
      q.close();
    }, minutes * 60_000);
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (handleLimitSignal(m, this.d.usage)) {
          settle({ kind: 'none', reason: 'Claude paused for the usage limit while Elfoqsy was looking into it.' });
          break;
        }
        if (outcome) break;
        if (m.type === 'result') break;
      }
    } catch (error) {
      settle({ kind: 'none', reason: `Elfoqsy could not look into it: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}` });
    } finally {
      this.clock.clearTimeout(timer);
      q.close();
    }
    return outcome ?? { kind: 'none', reason: 'Elfoqsy ended without answering or recommending.' };
  }

  /** What she is given: the run, the request, his precedents and earlier answers. */
  firstTurn(r: ResponderRequest): string {
    const s = this.d.state();
    const run = s.runs[r.runId];
    const ticket = run && !run.task ? s.tickets[run.ticket] : undefined;
    const type = ticketTypeOf(s, r.runId);
    const who = run ? `Agent ${run.agentNumber} on ${runLabel(run)}` : 'An agent';
    const lines: string[] = [];
    if (r.card) {
      lines.push(`${who} asks: ${r.card.question}`);
      if (r.card.why.length) lines.push('Why it asks:', ...r.card.why.map((w) => `- ${w}`));
      lines.push('Options:', ...r.card.options.map((o) => `- ${o.label}: ${o.consequence}`));
      lines.push(`It recommends: ${r.card.recommendation}`);
      if (r.card.sources.length) lines.push('Its sources:', ...r.card.sources.map((x) => `- ${x.kind} ${x.ref}${x.label ? ` (${x.label})` : ''}`));
    } else if (r.action) {
      lines.push(`${who} wants to: ${r.action.summary}`, `Why it is asked: ${r.action.reason}`, `Options: Approve, Deny.`);
    }
    if (ticket) {
      lines.push('', `Its ticket, ${ticket.key} (${ticket.type}, ${ticket.status}): ${ticket.summary}`, ticket.description.slice(0, 4000) || '(no description)');
    } else if (run?.task) {
      lines.push('', `Its task, ${run.task.name}: ${run.task.goal}`);
    }
    if (run?.verdict) lines.push('', `Its verdict so far: ${run.verdict.verdict}${run.verdict.reproduced ? ', reproduced' : ''}: ${run.verdict.summary}`);
    if (run?.assumptions?.length) lines.push('', 'What it decided itself so far:', ...run.assumptions.map((a) => `- ${a.text}`));
    const precedents = Object.values(s.precedents).filter((p) => p.by === 'you' && p.requestKind === 'question' && p.ticketType === type);
    if (precedents.length) lines.push('', `alex's precedents for ${type} tickets (cite one as precedent <id> only for the same kind of question):`, ...precedents.map((p) => `- ${p.precedentId}: "${p.question}" -> ${p.answer}`));
    const his = Object.values(s.approvals)
      .filter((a) => hisAnswer(a.resolution))
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, MAX_HIS_ANSWERS);
    if (his.length) lines.push('', 'His recent answers (cite one as decision <approvalId>):', ...his.map((a) => `- ${a.approvalId}: "${(a.card?.question ?? a.action ?? a.question).slice(0, 200)}" -> ${a.resolution!.answer ?? a.resolution!.decision}`));
    lines.push(
      '',
      r.mayAnswer
        ? 'Answer it with answer only if a source you cite says so: the ticket and its AC, a page, code you read, logs you ran, a fact in your memory, an earlier answer or precedent of his. Otherwise escalate it to him with your recommended option and why.'
        : 'This one is his to decide: look into it, then escalate it with your recommended option, why, and the sources you read.',
    );
    return redact(lines.join('\n'));
  }

  private options(r: ResponderRequest, reads: Reads, settle: (o: ResponderOutcome) => void, abort: AbortController): Options {
    const server = this.server(r, reads, settle);
    const names = [...server.names].map((n) => `mcp__${RESPONDER}__${n}`);
    return {
      systemPrompt: this.d.systemPrompt,
      tools: [], // no built-in tools: no files, no shell, no web
      mcpServers: { [RESPONDER]: server.config },
      allowedTools: names,
      permissionMode: 'dontAsk',
      settingSources: [],
      skills: [], // no skills, not even Claude Code's own
      strictMcpConfig: true,
      persistSession: false,
      settings: { autoMemoryEnabled: false },
      cwd: this.d.cwd,
      env: { ...this.d.env, ...telemetryEnv({ kind: 'responder', runId: r.runId }) },
      model: this.d.model,
      effort: this.d.effort ?? 'medium',
      maxTurns: 30,
      abortController: abort,
    };
  }

  private server(r: ResponderRequest, reads: Reads, settle: (o: ResponderOutcome) => void) {
    const lookups = this.d.lookups;
    const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(redactDeep(value)) }], ...(isError ? { isError: true } : {}) });
    const run = async (work: () => Promise<unknown> | unknown, note: (result: unknown) => void) => {
      if (!lookups) return text({ error: 'not_available', message: 'Lookups are not available here.' }, true);
      try {
        const result = await work();
        const failed = typeof result === 'object' && result !== null && 'error' in result;
        // Only what was read counts as read: a ticket fetched by key, a page by id, lines read or matched, a query run.
        if (!failed) note(result);
        return text(result, failed);
      } catch (error) {
        return text({ error: 'failed', message: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) }, true);
      }
    };
    const options = optionsOf(r);
    const sourceShape = z.object({
      kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url', 'memory', 'decision', 'precedent']),
      ref: z.string().trim().min(1).max(500),
      label: z.string().max(120).optional(),
    });
    const checkSources = (sources: SourceRef[]) => sources.flatMap((x) => {
      const problem = citeProblem(x, { s: this.d.state(), runId: r.runId, reads, question: r.kind === 'question' });
      return problem ? [problem] : [];
    });
    const tools = [
      tool('lookup_jira', 'Read Jira: one ticket in full by key (every field Jira shows, with its name; rich text as Markdown; linked items, sub-tasks, Confluence pages, attachments, comments and recent history), or a JQL search (at most 20).', { key: z.string().optional(), jql: z.string().optional() }, (a) =>
        run(() => lookups!.jira(a), (res) => {
          if (!a.key) return; // a search lists tickets; it does not read them
          reads.tickets.add(a.key.toUpperCase());
          reads.noteUrl(res);
        }),
      ),
      tool('lookup_confluence', 'Read Confluence: a CQL search (at most 10 results) or one page (pageId) as text.', { cql: z.string().optional(), pageId: z.string().optional() }, (a) =>
        run(() => lookups!.confluence(a), (res) => {
          if (!a.pageId) return; // a search lists pages; it does not read them
          reads.pages.add(a.pageId);
          reads.noteUrl(res);
        }),
      ),
      tool(
        'lookup_code',
        "Read alex's clones: search for text as written (text, optional glob), or read part of a file (path, from, lines). Cite code as repo/path:line from what you read.",
        { repo: z.string(), text: z.string().optional(), glob: z.string().optional(), path: z.string().optional(), from: z.number().int().positive().optional(), lines: z.number().int().positive().max(400).optional() },
        (a) =>
          run(() => lookups!.code(a), (res) => {
            const read = res as { repo?: string; path?: string; from?: number; to?: number; matches?: Array<{ path: string; line: number }> };
            if (read.path && read.from && read.to) reads.noteCode(read.repo ?? a.repo, read.path, read.from, read.to);
            for (const m of read.matches ?? []) reads.noteCode(read.repo ?? a.repo, m.path, m.line, m.line);
          }),
      ),
      tool(
        'lookup_logs',
        'Coralogix logs of a non-prod environment, read-only: the DataPrime after the source and filter, an environment, and from/to (ISO, or 15m, 2h, 1d back). Cite a log source by the query you ran.',
        { query: z.string().max(4000), environment: z.string().max(40).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).optional() },
        (a) =>
          run(() => lookups!.logs(a), () => {
            reads.logs.push(a.query);
          }),
      ),
      tool(
        'lookup_github',
        'Read GitHub on a polled repository: one PR (number), its PRs, commits (ref), checks (ref), or code search (query).',
        { repo: z.string(), what: z.enum(['pr', 'prs', 'commits', 'checks', 'search']), number: z.number().int().positive().optional(), ref: z.string().optional(), query: z.string().optional() },
        (a) =>
          run(() => lookups!.github(a), (res) => {
            if (a.what !== 'pr' || !a.number) return;
            reads.prs.add(`${a.repo}#${a.number}`);
            reads.noteUrl(res);
          }),
      ),
      tool('recall', 'Facts in your memory that mention these words; cite one as memory <factId>.', { text: z.string() }, async (a) => {
        const words = a.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const facts = Object.values(this.d.state().memory)
          .filter((f) => words.every((w) => `${f.statement} ${f.sources.map((x) => x.ref).join(' ')}`.toLowerCase().includes(w)))
          .slice(0, 20)
          .map((f) => ({ factId: f.factId, statement: f.statement, sources: f.sources }));
        return text({ facts });
      }),
    ];
    const answer = tool(
      'answer',
      `Answer the question yourself: one of its options (${options.join(', ')}), a short note if it helps, and the sources that say so. Only from sources you read in this session, your memory, or his earlier answers and precedents.`,
      { option: z.string().min(1), note: z.string().max(300).optional(), sources: z.array(sourceShape).min(1).max(6) },
      async (a) => {
        const option = optionOf(options, a.option);
        if (!option) return text({ error: 'unknown_option', message: `Pick one of: ${options.join(', ')}.` }, true);
        const sources = a.sources.map((x) => ({ kind: x.kind, ref: x.ref, ...(x.label ? { label: x.label } : {}) })) as SourceRef[];
        const problems = checkSources(sources);
        if (problems.length) return text({ error: 'unchecked_sources', message: `Not answered: ${problems.join('; ')}. Cite only what you read, or escalate it.` }, true);
        settle({ kind: 'answer', option, ...(a.note?.trim() ? { note: a.note.trim() } : {}), sources });
        return text({ ok: true, message: 'Answered. Stop here.' });
      },
    );
    const escalate = tool(
      'escalate',
      `Hand it to alex with your recommendation: one of the options (${options.join(', ')}), why in one or two sentences, and the sources you read (none if you found none).`,
      { option: z.string().min(1), why: z.string().trim().min(1).max(400), sources: z.array(sourceShape).max(6) },
      async (a) => {
        const option = optionOf(options, a.option);
        if (!option) return text({ error: 'unknown_option', message: `Pick one of: ${options.join(', ')}.` }, true);
        const sources = a.sources.map((x) => ({ kind: x.kind, ref: x.ref, ...(x.label ? { label: x.label } : {}) })) as SourceRef[];
        const problems = checkSources(sources);
        if (problems.length) return text({ error: 'unchecked_sources', message: `Not sent: ${problems.join('; ')}. Cite only what you read, or none.` }, true);
        settle({ kind: 'escalate', option, why: a.why, sources });
        return text({ ok: true, message: 'Sent to alex. Stop here.' });
      },
    );
    const all = [...tools, ...(r.mayAnswer ? [answer] : []), escalate];
    return { config: createSdkMcpServer({ name: RESPONDER, version: '1.0.0', tools: all }), names: new Set(all.map((t) => t.name)) };
  }

}
