// Investigators: read-only agent runs Elfoqsy starts herself, with no approval, to answer a question
// from the code, Jira, GitHub, Confluence, the non-prod logs and the public web. They cannot write or run
// commands: their built-in tools are Read, Grep and Glob, kept to the clones they were given, and WebSearch
// and WebFetch, each request checked by the redactor before it leaves. Everything a tool returns is
// redacted before the model sees it. They report findings with sources; the findings are
// saved to memory and Elfoqsy is told in the conversation that asked. At most two run at once, each
// for at most ten minutes, and they pause with everything else on a usage limit.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { copyAbilities, skillOptions, skillRefusal, SKILL_SETTINGS, type Abilities } from '../skill/abilities';
import { skillOf } from '../abilities/engine';
import type { Call } from '../abilities/friction';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { createSdkMcpServer, tool, type CanUseTool, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Effort, Finding } from '@elfoqsy/contracts';
import { modelLabel } from '@elfoqsy/state';
import { realClock, type Clock } from '../clock';
import type { UsageState } from '../claude/usage';
import type { Lookups } from '../elfoqsy/lookups';
import { handleLimitSignal, type QueryFn } from '../elfoqsy/session';
import type { EventLog } from '../eventLog';
import { checkOutbound, checkOutboundResolved, redact, redactDeep, type OutboundContext } from '../redact';
import { ulid } from '../ulid';
import { telemetryEnv } from '../telemetry/env';

export const INVESTIGATOR_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const INVESTIGATOR_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly Effort[];
const TOOLS = 'investigator';
const FRESH_DAYS = 7;
const DAY = 24 * 3600_000;
/** Files that usually hold credentials: never read, whatever the redactor would catch. */
const SECRET_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore))$/i;

export const INVESTIGATOR_PROMPT = `You are an investigator for Elfoqsy, the assistant of alex, a software engineer on the Acme Shop team at Acme. You answer one question by reading, never by changing anything.

You have Read, Grep and Glob over read-only clones of his repositories, read-only lookups of Jira, GitHub, Confluence and the non-prod Coralogix logs, and WebSearch and WebFetch for public documentation. You cannot run commands or edit files; do not try. A web request that carries anything of his (a secret, an internal host, a repository name or path, code, encoded data) is refused before it leaves.

- Every finding needs at least one source: a file and line (owner/repo/path:line), a ticket key, a pull request (owner/repo#number), a commit, a Confluence page, a log query, or a public web page (its URL).
- Say only what a source shows. When something is unknown, say what you checked and what is still open.
- Be brief: at most six findings, one or two sentences each, plain English.
- Call him alex. Never repeat a secret you come across; say where it is instead.
- When you are done, call report_findings exactly once.`;

export interface InvestigatorLimits {
  maxParallel: number;
  maxMinutes: number;
  maxTokens: number;
}

export interface InvestigatorDeps {
  log: EventLog;
  usage: UsageState;
  queryFn: QueryFn;
  lookups: Lookups;
  /** owner/name -> clone path: the configured repositories and their declared dependencies. */
  clones: Map<string, string>;
  /** The Claude Code environment without credentials. */
  baseEnv: Record<string, string>;
  /** Each investigation gets an empty folder here as its working directory. */
  root: string;
  /** Never readable, even inside a clone. */
  protectedPaths: string[];
  /** Where the Abilities skills live (data/skills): each investigation gets its own read-only copy. Absent: no skills. */
  abilitiesDir?: string;
  /** An investigation's calls up to its report: its uses and missed uses, for the abilities engine. */
  abilityUses?: (u: { in: 'investigation'; id: string; calls: Array<Call & { skill?: string }> }) => void;
  /** Called once an investigation has ended and its findings are saved. */
  onFinished: (done: FinishedInvestigation) => void;
  /** What the redactor checks a web request against; without it, investigators have no web. */
  outbound?: OutboundContext;
  limits?: Partial<InvestigatorLimits>;
  clock?: Clock;
  now?: () => number;
}

export interface FinishedInvestigation {
  investigationId: string;
  conversationId: string;
  question: string;
  title: string;
  findings: Finding[];
  /** Why it ended without findings, when it did. */
  stopped?: string;
}

export interface StartArgs {
  question: string;
  model: string;
  effort: string;
  repos?: string[];
  conversationId: string;
}

const DEFAULT_LIMITS: InvestigatorLimits = { maxParallel: 2, maxMinutes: 10, maxTokens: 600_000 };

const sourceShape = z.object({
  kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']),
  ref: z.string().trim().min(1).max(300),
  label: z.string().max(120).optional(),
});
const reportShape = {
  title: z.string().trim().min(1).max(120),
  findings: z
    .array(z.object({ text: z.string().trim().min(1).max(800), sources: z.array(sourceShape).min(1).max(6) }))
    .max(6),
};

/** "acme/shop-api", any case, or just "shop-api" when only one repository has that name. */
export function resolveRepo(known: string[], asked: string): string | undefined {
  const a = asked.trim().toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === a);
  if (exact) return exact;
  const byName = known.filter((k) => k.split('/')[1]?.toLowerCase() === a);
  return byName.length === 1 ? byName[0] : undefined;
}

/** "sonnet" or "claude-sonnet-5-5" -> claude-sonnet-5-5; anything else is refused. */
export function investigatorModel(model: string): (typeof INVESTIGATOR_MODELS)[number] | undefined {
  const m = model.trim().toLowerCase();
  return INVESTIGATOR_MODELS.find((id) => id === m || id.split('-')[1] === m);
}

/**
 * Whether a Read, Grep or Glob call stays inside the investigation's roots and away from secrets.
 * Returns why not, or null when it may run.
 */
export function pathRefusal(toolName: string, input: Record<string, unknown>, cwd: string, roots: string[], protectedPaths: string[]): string | null {
  const raw = toolName === 'Read' ? input.file_path : input.path;
  if (raw === undefined && toolName !== 'Read') return null; // Grep and Glob default to the empty working folder
  if (typeof raw !== 'string' || !raw.trim()) return 'No path given.';
  const asked = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let real = asked;
  try {
    real = realpathSync(asked);
  } catch {
    // A path that does not exist cannot leak anything; it is still checked as written.
  }
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
  if (!roots.some((r) => inside(real, r))) return `${raw} is outside the repositories you can read.`;
  if (protectedPaths.some((p) => inside(real, p))) return `${raw} is not readable.`;
  if (real.split(sep).includes('.git') || (toolName === 'Read' && SECRET_FILE.test(basename(real)))) return `${raw} is not readable.`;
  return null;
}

/** Tokens a result message reports, as agent runs count them. */
const tokensOf = (m: SDKMessage): number =>
  m.type === 'result' ? Object.values(m.modelUsage ?? {}).reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheCreationInputTokens, 0) : 0;

class Investigation {
  report: { title: string; findings: Finding[] } | undefined;
  readonly filesRead = new Set<string>();
  tokens = 0;
  stopped: string | undefined;
  /** Its read-only copy of the Abilities skills, in its own folder. */
  abilities: Abilities | undefined;
  /** Its tool calls up to its report, for the abilities engine; and where each is, by its tool_use id. */
  readonly calls: Array<Call & { skill?: string }> = [];
  readonly callIds = new Map<string, number>();
  readonly abort = new AbortController();
  readonly startedAt: number;

  constructor(
    readonly id: string,
    readonly args: StartArgs & { model: (typeof INVESTIGATOR_MODELS)[number]; effort: Effort; repos: string[] },
    readonly cwd: string,
    readonly roots: string[],
    now: number,
  ) {
    this.startedAt = now;
  }
}

export class Investigators {
  private readonly running = new Map<string, Investigation>();
  private readonly limits: InvestigatorLimits;
  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(private readonly d: InvestigatorDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...d.limits };
    this.clock = d.clock ?? realClock;
    this.now = d.now ?? (() => Date.now());
  }

  repos(): string[] {
    return [...this.d.clones.keys()];
  }

  start(args: StartArgs): { investigationId: string; model: string; effort: Effort; repos: string[] } | { error: string; message: string } {
    const model = investigatorModel(args.model);
    if (!model) return { error: 'bad_model', message: `Pick Haiku, Sonnet or Opus 5.5, not ${args.model}.` };
    const effort = INVESTIGATOR_EFFORTS.find((e) => e === args.effort);
    if (!effort) return { error: 'bad_effort', message: `Effort is one of ${INVESTIGATOR_EFFORTS.join(', ')}.` };
    if (!args.question.trim()) return { error: 'bad_request', message: 'Ask a question.' };
    const known = this.repos();
    const repos = (args.repos?.length ? args.repos : known).map((r) => resolveRepo(known, r) ?? r);
    const unknown = repos.filter((r) => !known.includes(r));
    if (unknown.length) return { error: 'unknown_repo', message: `Not readable here: ${unknown.join(', ')}. Readable: ${known.join(', ')}.` };
    if (this.d.usage.isPaused) return { error: 'paused', message: 'Claude is paused for the usage limit; no investigation until it resets.' };
    if (this.running.size >= this.limits.maxParallel) {
      return { error: 'busy', message: `${this.running.size} investigators are already running, the most at once.` };
    }

    const id = `inv-${ulid().toLowerCase()}`;
    const cwd = join(this.d.root, id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const roots = [realpathSync(cwd), ...repos.map((r) => realpathSync(this.d.clones.get(r)!))];
    const inv = new Investigation(id, { ...args, question: args.question.trim(), model, effort, repos }, cwd, roots, this.now());
    inv.abilities = this.d.abilitiesDir ? (copyAbilities(this.d.abilitiesDir, join(cwd, '.abilities')) ?? undefined) : undefined;
    this.running.set(id, inv);
    this.d.log.append('orchestrator', 'investigation.started', { investigationId: id, conversationId: args.conversationId, question: redact(inv.args.question), model, effort });

    const q = this.d.queryFn({ prompt: this.firstTurn(inv), options: this.options(inv) });
    const timer = this.clock.setTimeout(() => {
      inv.stopped ??= `It ran out of time (${this.limits.maxMinutes} minutes).`;
      inv.abort.abort();
      q.close();
    }, this.limits.maxMinutes * 60_000);
    void (async () => {
      try {
        for await (const m of q) {
          if (handleLimitSignal(m, this.d.usage)) {
            inv.stopped ??= 'Claude paused for the usage limit.';
            inv.abort.abort();
            break;
          }
          if (m.type === 'result') {
            inv.tokens += tokensOf(m);
            if (m.subtype !== 'success') inv.stopped ??= `It stopped: ${m.subtype.replace(/_/g, ' ')}.`;
            break;
          }
        }
      } catch (error) {
        inv.stopped ??= `It stopped: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
      } finally {
        this.clock.clearTimeout(timer);
        q.close();
        this.finish(inv);
      }
    })();
    return { investigationId: id, model, effort, repos };
  }

  /** Stops every running investigation (the daemon is stopping). */
  close(): void {
    for (const inv of this.running.values()) {
      inv.stopped ??= 'The daemon stopped.';
      inv.abort.abort();
    }
  }

  private firstTurn(inv: Investigation): string {
    const repos = inv.args.repos.map((r) => `- ${r}: ${this.d.clones.get(r)}`).join('\n');
    return redact(`Question from Elfoqsy: ${inv.args.question}

Repositories you can read (read-only clones):
${repos}

Answer from the code and from Jira, GitHub, Confluence and the logs. Cite every finding. When you are done, call report_findings once with a short title and at most six findings; if you cannot find the answer, report what you checked and what is still unknown.`);
  }

  /** The session options. Exported shape is tested: read-only tools, isolation, no credentials. */
  options(inv: Investigation): Options {
    const gate = (toolName: string, input: Record<string, unknown>): string | null => {
      if (toolName.startsWith(`mcp__${TOOLS}__`)) return null;
      if (toolName === 'WebFetch' || toolName === 'WebSearch') {
        if (!this.d.outbound) return 'The web is not set up here.';
        const verdict = checkOutbound(toolName === 'WebFetch' ? { url: String(input.url ?? '') } : { query: String(input.query ?? '') }, this.d.outbound);
        return verdict.ok ? null : `Not sent: ${verdict.reason} Ask without it.`;
      }
      if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return pathRefusal(toolName, input, inv.cwd, inv.roots, this.d.protectedPaths);
      if (toolName === 'Skill') return skillRefusal(input, inv.abilities);
      return `${toolName} is not available to an investigator: reading only.`;
    };
    const canUseTool: CanUseTool = async (toolName, input) => {
      const refusal = gate(toolName, input);
      return refusal ? { behavior: 'deny', message: refusal } : { behavior: 'allow', updatedInput: input };
    };
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      let refusal = gate(input.tool_name, toolInput);
      if (!refusal && input.tool_name === 'WebFetch' && this.d.outbound?.resolve) {
        const verdict = await checkOutboundResolved({ url: String(toolInput.url ?? '') }, this.d.outbound);
        if (!verdict.ok) refusal = `Not sent: ${verdict.reason} Ask without it.`;
      }
      // Its calls up to its report: a skill's use ends there.
      if (!inv.report) {
        const skill = skillOf(input.tool_name, toolInput);
        inv.callIds.set(input.tool_use_id, inv.calls.length);
        inv.calls.push({ tool: input.tool_name, text: typeof toolInput.pattern === 'string' ? toolInput.pattern : typeof toolInput.file_path === 'string' ? toolInput.file_path : JSON.stringify(toolInput).slice(0, 2000), failed: !!refusal, toolUseId: input.tool_use_id, ...(skill ? { skill } : {}) });
      }
      return refusal ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal } } : {};
    };
    const failure: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PostToolUseFailure') return {};
      const i = inv.callIds.get(input.tool_use_id);
      if (i !== undefined) inv.calls[i]!.failed = true;
      return {};
    };
    // Whatever a tool returns is redacted before the model sees it; only rewritten when something changed.
    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      if (input.tool_name === 'Read') {
        const path = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
        if (typeof path === 'string') inv.filesRead.add(path);
      }
      const redacted = redactDeep(input.tool_response);
      if (JSON.stringify(redacted) === JSON.stringify(input.tool_response)) return {};
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redacted } };
    };
    return {
      model: inv.args.model,
      effort: inv.args.effort,
      systemPrompt: INVESTIGATOR_PROMPT,
      tools: ['Read', 'Grep', 'Glob', ...(this.d.outbound ? ['WebSearch', 'WebFetch'] : []), ...(inv.abilities ? ['Skill'] : [])],
      disallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', ...(this.d.outbound ? [] : ['WebFetch', 'WebSearch'])],
      mcpServers: { [TOOLS]: this.server(inv) },
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }], PostToolUseFailure: [{ hooks: [failure] }] },
      permissionMode: 'default',
      settingSources: [], // none of alex's settings, CLAUDE.md, skills or hooks
      ...skillOptions(inv.abilities), // the Abilities skills, or none (not even Claude Code's own)
      strictMcpConfig: true,
      persistSession: false,
      settings: { autoMemoryEnabled: false, ...(inv.abilities ? SKILL_SETTINGS : {}) },
      cwd: inv.cwd,
      additionalDirectories: inv.roots.slice(1),
      env: { ...this.d.baseEnv, ...telemetryEnv({ kind: 'investigator', runId: inv.id, conversationId: inv.args.conversationId }) }, // replaces the environment: no tokens of any kind
      maxTurns: 80,
      taskBudget: { total: this.limits.maxTokens },
      abortController: inv.abort,
    };
  }

  private server(inv: Investigation) {
    const answer = async (work: () => Promise<unknown> | unknown) => {
      try {
        const result = redactDeep(await work());
        const failed = typeof result === 'object' && result !== null && 'error' in result;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(failed ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'failed', message: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) }) }], isError: true };
      }
    };
    const lookups = this.d.lookups;
    return createSdkMcpServer({
      name: TOOLS,
      version: '1.0.0',
      tools: [
        tool('lookup_jira', 'Read Jira: one ticket in full by key (every field Jira shows, with its name; rich text as Markdown; linked items, sub-tasks, Confluence pages, attachments, comments and recent history), or a JQL search (at most 20).', { key: z.string().optional(), jql: z.string().optional() }, async (a) =>
          answer(() => lookups.jira(a)),
        ),
        tool(
          'lookup_github',
          'Read-only GitHub on a polled repository: one PR, its PRs, commits, a commit or branch’s checks, or code search.',
          { repo: z.string(), what: z.enum(['pr', 'prs', 'commits', 'checks', 'search']), number: z.number().int().optional(), ref: z.string().optional(), query: z.string().optional() },
          async (a) => answer(() => lookups.github(a)),
        ),
        tool('lookup_confluence', 'Confluence: a CQL search (at most 10 results) or one page as text.', { cql: z.string().optional(), pageId: z.string().optional() }, async (a) =>
          answer(() => lookups.confluence(a)),
        ),
        tool(
          'lookup_logs',
          'Coralogix logs of a non-prod environment (dev, staging, integration) or application, read-only: the DataPrime after the source and filter (for example: filter $m.severity == ERROR | limit 50); from/to as ISO times or 15m, 2h, 1d back.',
          { query: z.string().max(4000), environment: z.string().max(40).optional(), application: z.string().max(120).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).optional() },
          async (a) => answer(() => lookups.logs(a)),
        ),
        tool('report_findings', 'Your answer, once, at the end: a short title and at most six findings, each with its sources.', reportShape, async (a) => {
          if (inv.report) return answer(() => ({ error: 'already_reported', message: 'Findings are already reported; stop here.' }));
          inv.report = { title: a.title, findings: a.findings.map((f) => ({ text: f.text, sources: f.sources })) };
          return answer(() => ({ ok: true, message: 'Reported. Stop here.' }));
        }),
      ],
    });
  }

  private finish(inv: Investigation): void {
    if (!this.running.delete(inv.id)) return;
    const now = this.now();
    const report = inv.report ? (redactDeep(inv.report) as { title: string; findings: Finding[] }) : undefined;
    const stopped = report ? undefined : (inv.stopped ?? 'It ended without reporting findings.');
    this.d.log.append('orchestrator', 'investigation.finished', {
      investigationId: inv.id,
      conversationId: inv.args.conversationId,
      title: report?.title ?? 'No answer',
      findings: report?.findings ?? [],
      filesRead: inv.filesRead.size,
      tokens: inv.tokens,
      durationMs: Math.max(0, now - inv.startedAt),
    });
    if (inv.calls.length) this.d.abilityUses?.({ in: 'investigation', id: inv.id, calls: inv.calls });
    for (const f of report?.findings ?? []) {
      this.d.log.append('orchestrator', 'memory.saved', {
        factId: `fact-${ulid().toLowerCase()}`,
        statement: f.text,
        sources: f.sources,
        freshUntil: new Date(now + FRESH_DAYS * DAY).toISOString(),
        origin: 'investigator',
      });
    }
    rmSync(inv.cwd, { recursive: true, force: true });
    this.d.onFinished({
      investigationId: inv.id,
      conversationId: inv.args.conversationId,
      question: inv.args.question,
      title: report?.title ?? 'No answer',
      findings: report?.findings ?? [],
      ...(stopped ? { stopped } : {}),
    });
  }
}

/** "Investigator, Sonnet 5.5 high": how she names one in a line. */
export const investigatorLabel = (model: string, effort: string): string => `Investigator, ${modelLabel(model)} ${effort}`;
