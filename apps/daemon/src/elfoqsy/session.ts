// One of Elfoqsy's Claude sessions: one per conversation, so a new conversation starts clean while she
// still knows the live state and what she remembers. A session starts on first need, takes turns
// through streaming input, and turns her replies (her text, plus the blocks she chose with `show`)
// into elfoqsy.message events in its conversation. Its tools are the orchestrator's, behind the outgoing check WebSearch and
// WebFetch (web.ts); it loads none of alex's settings. When Claude refuses work it pauses through the shared UsageState instead of
// retrying.
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { McpSdkServerConfigWithInstance, Options, Query, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { Effort, MessageBlock } from '@elfoqsy/contracts';
import { activeRuns, factsFor, isOpen, isWaiting, type WorkspaceState } from '@elfoqsy/state';
import { realClock, type Clock } from '../clock';
import type { UsageSnapshot, UsageState } from '../claude/usage';
import type { EventLog } from '../eventLog';
import { redact, type OutboundContext } from '../redact';
import { ulid } from '../ulid';
import { ALLOWED_TOOLS, ORCHESTRATOR, type SessionContext } from './tools';
import { cannotLookUp, correction, inventedCauses, lookupCorrection, type ToolOutcome } from './fidelity';
import { WEB_TOOLS, herWebHooks } from './web';
import { mergeHooks } from './hooks';
import { skillOptions, skillRefusal, SKILL_SETTINGS, type Abilities } from '../skill/abilities';
import { skillOf } from '../abilities/engine';
import type { Call } from '../abilities/friction';
import { telemetryEnv } from '../telemetry/env';

export type QueryFn = typeof query;
export type TurnContent = string | ContentBlockParam[];

/** Her reply to a workspace update when nothing needs alex; it is not shown. */
export const QUIET = '(quiet)';
const PRIMING_LINES = 20;
const USAGE_PROBE_MS = 5000;

/** How turns reach her. Appended to the persona in prompts/, which stays the single source of who she is. */
export const TEST_PREFIX = '[From the tester]';
/** Agents' reports since her last turn in a conversation open the next one; each is acknowledged for her. */
export const REPORTS_HEADER = '[Agent reports since your last turn here]';
const SPEAKER = { you: 'alex', test: 'The tester', elfoqsy: 'Elfoqsy' } as const;

export const PROTOCOL = `

## How messages reach you

Each conversation is its own session: you see this conversation's messages, the live state and your memory, not the other conversations. Messages from alex arrive as he typed them. Some messages come from the workspace, not from him:
- "[Context ...]" opens a session: the live state, what you remember, and the conversation so far.
- "[Workspace update]" lists changes that might need him. Speak only if one does, in your usual short style; otherwise reply with exactly ${QUIET} and nothing else.
- "[Investigation finished]" or "[Investigation stopped]" brings an investigator's findings back to you. Show them with a findings block and answer the question they were for.
- "${REPORTS_HEADER}" lists what the agents of this conversation reported since your last turn here: steps, heartbeats, checks, sub-agents, and who answered their requests and how. They are acknowledged for you; mention one only if it matters to what you are answering.
- "[Weekly review]" gives you the week's numbers to write the weekly review.

Messages that start with "${TEST_PREFIX}" were typed by someone testing the workspace, not by alex. Handle them like his requests, but call their sender "the tester", never "you" and never alex, because he reads your replies: write "The tester asked me to start Agent 2", not "you asked". Never attribute a tester's request or a tester's fact to him, in replies, in memory, or in reasons you pass to tools.

With a tester, or anyone else who is not him, you are transparent: you are Elfoqsy, foqs's AI assistant. Say that in a line when asked who you are, without listing what you can do. The character in your identity lives between you and him, so you tell the tester nothing of your own life; answer in the language the tester writes in.`;

export interface SessionOptions {
  conversationId: string;
  log: EventLog;
  usage: UsageState;
  state: () => WorkspaceState;
  systemPrompt: string;
  /** Her tools, serving this conversation. */
  mcpServer: (context: SessionContext) => McpSdkServerConfigWithInstance;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: Effort;
  /** Her read-only copy of the Abilities skills (skill/abilities.ts). Absent: no skills at all. */
  abilities?: Abilities;
  /** A turn's tool calls in order, and whether her reply asked alex something: its uses and missed uses (abilities/engine.ts). */
  abilityUses?: (u: { in: 'conversation'; id: string; calls: Array<Call & { skill?: string }>; askedHim: boolean }) => void;
  /**
   * What the outgoing check knows of his world (hosts, repositories, local paths). With it she has WebSearch and WebFetch, in front of
   * which that check stands (web.ts); without it (a test, simulate mode) she has no web.
   */
  outbound?: OutboundContext;
  /** Ticket keys in her replies become refs.tickets when they match this. */
  ticketKey: RegExp;
  queryFn: QueryFn;
  clock?: Clock;
  now?: () => number;
  /** Called when a turn's result comes back. */
  onTurnEnd?: (session: ElfoqsySession) => void;
}

/**
 * The query options: isolated from alex's own Claude Code setup, and nothing but the orchestrator tools and, when the workspace
 * has its outgoing check to put in front of them, the web (WebSearch, WebFetch; hooks from herWebHooks).
 */
export function sessionOptions(o: { systemPrompt: string; mcpServer: McpSdkServerConfigWithInstance; cwd: string; env: Record<string, string>; model?: string; effort?: Effort; web?: Options['hooks']; abilities?: Abilities; conversationId?: string }): Options {
  const hooks = mergeHooks(o.web, o.abilities ? skillHooks(o.abilities) : undefined);
  return {
    systemPrompt: o.systemPrompt + PROTOCOL,
    tools: [...(o.web ? WEB_TOOLS : []), ...(o.abilities ? ['Skill'] : [])], // no files and no shell; the web only behind its check
    mcpServers: { [ORCHESTRATOR]: o.mcpServer },
    allowedTools: [...ALLOWED_TOOLS, ...(o.web ? WEB_TOOLS : []), ...(o.abilities ? ['Skill'] : [])],
    ...(hooks ? { hooks } : {}),
    // Anything not allowed above is denied; nobody is prompted.
    permissionMode: 'dontAsk' as const,
    settingSources: [], // none of alex's settings, CLAUDE.md, skills or hooks (omitting it would load them all)
    ...skillOptions(o.abilities), // the Abilities skills, or none (not even Claude Code's own)
    strictMcpConfig: true, // and none of his MCP servers
    persistSession: false, // no transcripts in his ~/.claude/projects, so attached images stay only in the workspace's own folder
    settings: { autoMemoryEnabled: false, ...(o.abilities ? SKILL_SETTINGS : {}) }, // and no auto-memory (also off through the environment)
    cwd: o.cwd,
    env: { ...o.env, ...telemetryEnv({ kind: 'conversation', ...(o.conversationId ? { conversationId: o.conversationId } : {}) }) }, // replaces the environment: no API keys, no GitHub or Jira tokens; its traces to the daemon's receiver
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
  };
}

/** Her Skill calls, held to the skills she was given: everything else she may call is on her allow list already. */
function skillHooks(a: Abilities): Options['hooks'] {
  return {
    PreToolUse: [
      {
        matcher: 'Skill',
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const refused = skillRefusal((input.tool_input ?? {}) as Record<string, unknown>, a);
            return refused ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refused } } : {};
          },
        ],
      },
    ],
  };
}

/** An async queue of user turns, fed while a session runs. */
export class TurnInput implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiting: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  /** `priority: 'next'` asks Claude Code to take it at the next point it can, not only after the turn ends. */
  push(content: TurnContent, priority?: 'now' | 'next' | 'later'): void {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/** True for the SDK messages that mean Claude refused work; pauses the shared usage state if so. */
export function handleLimitSignal(m: SDKMessage, usage: UsageState): boolean {
  if (m.type === 'rate_limit_event') {
    usage.observe(m.rate_limit_info);
    return m.rate_limit_info.status === 'rejected';
  }
  if (m.type === 'system' && m.subtype === 'api_retry' && (m.error === 'rate_limit' || m.error === 'billing_error')) {
    // The CLI would retry by itself; stop at the first one instead.
    usage.limit('limit', m.error, usage.lastResetsAt);
    return true;
  }
  if (m.type === 'assistant' && m.parent_tool_use_id === null) {
    if (m.error === 'rate_limit' || m.error === 'billing_error') {
      usage.limit('limit', m.error, usage.lastResetsAt);
      return true;
    }
    if (m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed' || m.error === 'account_on_hold') {
      usage.limit('login', m.error);
      return true;
    }
  }
  return false;
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
/** "Friday 9 October 2026, 21:00". */
const when = (ms: number): string => `${DAY.format(ms).replace(',', '')}, ${TIME.format(ms)}`;

/** The live state in a few lines: enough to answer the easy questions; tools give the rest. */
export function stateDigest(s: WorkspaceState): string {
  const open = Object.values(s.tickets).filter(isOpen);
  const blocked = open.filter((t) => t.status === 'Blocked').map((t) => t.key);
  const runs = activeRuns(s).map((r) => `Agent ${r.agentNumber} on ${r.ticket} (${isWaiting(s, r) ? 'waiting for alex' : r.state}${r.step ? `, step ${r.step}` : ''})`);
  const investigating = Object.values(s.investigations).filter((i) => i.finishedAt === undefined).map((i) => `${i.investigationId}: ${i.question}`);
  return [
    `Sprint: ${open.length} open tickets${blocked.length ? `; blocked: ${blocked.join(', ')}` : ''}.`,
    `Agents: ${runs.length ? runs.join('; ') : 'none running'}.`,
    ...(investigating.length ? [`Investigators running: ${investigating.join('; ')}.`] : []),
  ].join('\n');
}

interface Turn {
  content: TurnContent;
  speaker?: 'alex' | 'tester';
}

export class ElfoqsySession implements SessionContext {
  readonly conversationId: string;
  private q: Query | undefined;
  private input: TurnInput | undefined;
  private turnText: string[] = [];
  /** This turn's tool calls, for the abilities engine; and where each is, by its tool_use id. */
  private turnCalls: Array<Call & { skill?: string }> = [];
  private readonly callIds = new Map<string, number>();
  private blocks: MessageBlock[] = [];
  private held: Turn[] = [];
  private who: 'alex' | 'tester' = 'alex';
  /** What her tools dropped, rejected or changed in this turn, and the reasons they gave. */
  private outcomes: ToolOutcome[] = [];
  /** This turn's reply already went back to her once for a cause no tool gave. */
  private corrected = false;
  private readonly unsubscribe: () => void;
  private readonly clock: Clock;
  private readonly now: () => number;
  /** A turn has been sent and its result has not come back. */
  busy = false;
  lastActive: number;

  constructor(private readonly o: SessionOptions) {
    this.conversationId = o.conversationId;
    this.clock = o.clock ?? realClock;
    this.now = o.now ?? (() => Date.now());
    this.lastActive = this.now();
    this.unsubscribe = o.usage.onChange((paused) => {
      if (paused) {
        this.turnText = [];
        this.blocks = [];
        this.busy = false;
        void this.q?.interrupt().catch(() => undefined);
      } else {
        for (const turn of this.held.splice(0)) this.send(turn);
      }
    });
  }

  // SessionContext, for her tools.
  speaker = (): 'alex' | 'tester' => this.who;
  addBlocks = (blocks: MessageBlock[]): void => {
    const seen = new Set(this.blocks.map((b) => JSON.stringify(b)));
    this.blocks.push(...blocks.filter((b) => !seen.has(JSON.stringify(b))));
  };
  noteOutcomes = (outcomes: ToolOutcome[]): void => {
    this.outcomes.push(...outcomes);
  };

  get isOpen(): boolean {
    return this.q !== undefined;
  }

  /**
   * alex said something, or someone testing the workspace did (marked, never passed off as his).
   * Attachments come as content blocks after the text. While paused it is kept; only alex writing
   * ends a pause with no known end.
   */
  say(text: string, from: 'owner' | 'tester' = 'owner', attached: ContentBlockParam[] = [], reports?: string): void {
    if (from === 'owner') this.o.usage.ownerWrote();
    const said = from === 'tester' ? `${TEST_PREFIX} ${redact(text)}` : redact(text);
    const line = reports ? `${redact(reports)}\n\n${said}` : said;
    this.send({ content: attached.length ? [{ type: 'text', text: line }, ...attached] : line, speaker: from === 'tester' ? 'tester' : 'alex' });
  }

  /** Changes that might need alex; she decides whether to speak. */
  notify(lines: string[], reports?: string): void {
    const update = `[Workspace update]\n${lines.map((l) => `- ${l}`).join('\n')}`;
    this.send({ content: redact(reports ? `${reports}\n\n${update}` : update) });
  }

  /** Something the workspace tells her, such as an investigator's findings or a weekly review to write. */
  inform(text: string, reports?: string): void {
    this.send({ content: redact(reports ? `${reports}\n\n${text}` : text) });
  }

  /**
   * His plan's 5-hour and 7-day usage, read through a live session. The SDK marks this call
   * experimental; it is best effort and returns undefined whenever it cannot answer quickly.
   */
  async usageSnapshot(): Promise<UsageSnapshot | undefined> {
    const q = this.q;
    if (!q || typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return undefined;
    try {
      const answer = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        new Promise<undefined>((resolve) => this.clock.setTimeout(() => resolve(undefined), USAGE_PROBE_MS)),
      ]);
      const limits = answer?.rate_limits;
      if (!answer?.rate_limits_available || !limits) return undefined;
      const window = (w: { utilization: number | null; resets_at: string | null } | null | undefined) =>
        w ? { utilization: w.utilization, ...(w.resets_at ? { resetsAt: Date.parse(w.resets_at) } : {}) } : undefined;
      const fiveHour = window(limits.five_hour);
      const sevenDay = window(limits.seven_day);
      return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: Date.now() };
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.unsubscribe();
    this.input?.end();
    this.q?.close();
    this.q = undefined;
  }

  private send(turn: Turn): void {
    if (this.o.usage.isPaused) {
      this.held.push(turn);
      return;
    }
    if (turn.speaker) this.who = turn.speaker;
    this.busy = true;
    this.lastActive = this.now();
    if (!this.input) this.start(turn.content);
    else this.input.push(turn.content);
  }

  private start(first: TurnContent): void {
    const input = new TurnInput();
    this.input = input;
    input.push(this.primed(first));
    const server = this.o.mcpServer(this);
    const web = this.o.outbound ? herWebHooks({ log: this.o.log, outbound: this.o.outbound }) : undefined;
    const q = this.o.queryFn({
      prompt: input,
      options: sessionOptions({ ...this.o, mcpServer: server, ...(web ? { web } : {}) }),
    });
    this.q = q;
    void this.consume(q, input);
  }

  /** A session starts with the workspace's context and this conversation so far, so a restart loses nothing. */
  private primed(first: TurnContent): TurnContent {
    const s = this.o.state();
    const conversation = s.conversations[this.conversationId];
    const opening = typeof first === 'string' ? first : (first.find((b) => b.type === 'text') as { text: string } | undefined)?.text ?? '';
    // Agent reports may come first; what was typed is after them.
    const firstText = opening.startsWith(REPORTS_HEADER) ? opening.slice(opening.indexOf('\n\n') + 2) : opening;
    const lines = s.messages
      .filter((m) => m.conversationId === this.conversationId)
      .map((m) => `${SPEAKER[m.role]}: ${m.text}${m.blocks.length ? ` [showed ${m.blocks.map((b) => ('ref' in b ? `${b.type} ${b.ref}` : b.type)).join(', ')}]` : ''}`);
    // The message being sent is already in the log; leave it out of the context.
    const sent = firstText.startsWith(`${TEST_PREFIX} `) ? `${SPEAKER.test}: ${firstText.slice(TEST_PREFIX.length + 1)}` : `${SPEAKER.you}: ${firstText}`;
    if (lines.at(-1) === sent) lines.pop();
    const facts = factsFor(s, conversation?.ticket, this.now()).map(
      (f) => `- ${f.statement} (${f.sources.map((src) => src.ref).join(', ') || 'no source'}; from ${f.origin}, ${new Date(f.at).toISOString().slice(0, 10)}${f.stale ? '; stale, re-check' : ''})`,
    );
    const context = redact(
      [
        `[Context for this conversation, from the workspace]\nThis conversation: "${conversation?.title ?? 'untitled'}"${conversation?.ticket ? `, about ${conversation.ticket}` : ''}.`,
        `Now: ${when(this.now())}.`,
        stateDigest(s),
        facts.length ? `What you remember:\n${facts.join('\n')}` : 'What you remember: nothing yet.',
        lines.length ? `Earlier in this conversation:\n${lines.slice(-PRIMING_LINES).join('\n')}` : 'This conversation is new.',
      ].join('\n\n'),
    );
    if (typeof first === 'string') return `${context}\n\n${first}`;
    return [{ type: 'text', text: context }, ...first];
  }

  private async consume(q: Query, input: TurnInput): Promise<void> {
    try {
      for await (const message of q) this.handle(message);
    } catch (error) {
      console.warn(`Elfoqsy's session for ${this.conversationId} ended: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    } finally {
      input.end();
      if (this.q === q) {
        this.q = undefined;
        this.input = undefined;
        this.turnText = [];
        this.blocks = [];
        this.turnCalls = [];
        this.callIds.clear();
        this.busy = false;
      }
    }
  }

  private handle(m: SDKMessage): void {
    if (handleLimitSignal(m, this.o.usage)) return;
    if (m.type === 'assistant' && m.parent_tool_use_id === null) {
      for (const block of m.message.content) {
        // Words before a tool call are preamble; the reply is what she says after her last call.
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
          this.turnText = [];
          this.noteCall(block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
        } else if (block.type === 'text' && block.text.trim()) this.turnText.push(block.text.trim());
      }
    } else if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type !== 'tool_result') continue;
        const i = this.callIds.get(block.tool_use_id);
        if (i !== undefined && block.is_error) this.turnCalls[i]!.failed = true;
      }
    } else if (m.type === 'result') {
      const text = this.turnText.join('\n\n').trim();
      // A cause no tool returned, for something a tool dropped, rejected or changed: back to her once, unposted.
      const invented = this.corrected || m.subtype !== 'success' ? [] : inventedCauses(text, this.outcomes);
      // "I cannot look it up", when no tool said no: she can, and goes back to do it.
      const unable = this.corrected || m.subtype !== 'success' || invented.length ? [] : cannotLookUp(text, this.outcomes);
      if ((invented.length || unable.length) && this.input) {
        this.corrected = true;
        this.turnText = [];
        this.o.log.append('elfoqsy', 'elfoqsy.reply_corrected', { conversationId: this.conversationId, invented: invented.length ? invented : unable });
        this.input.push(
          invented.length
            ? correction(invented, this.outcomes)
            : lookupCorrection(unable, !!this.o.outbound),
        );
        return;
      }
      // A turn with tool calls: its uses (a Skill call in conversation is a use) and its missed uses, measured by the engine.
      if (this.turnCalls.length) {
        const last = text.split(/\n\s*\n/).at(-1)?.trim() ?? '';
        this.o.abilityUses?.({ in: 'conversation', id: this.conversationId, calls: this.turnCalls, askedHim: /\?\s*$/.test(last) });
      }
      this.turnCalls = [];
      this.callIds.clear();
      this.outcomes = [];
      this.corrected = false;
      const blocks = this.blocks;
      this.turnText = [];
      this.blocks = [];
      this.busy = false;
      this.lastActive = this.now();
      if ((text && text !== QUIET) || blocks.length) this.speak(text === QUIET ? '' : text, blocks);
      this.o.onTurnEnd?.(this);
    }
  }

  /** One of her tool calls this turn, as the abilities engine reads calls: the tool, its input as one line, and its skill. */
  private noteCall(id: string, name: string, input: Record<string, unknown>): void {
    this.callIds.set(id, this.turnCalls.length);
    const line = Array.isArray(input.args) ? input.args.map(String).join(' ') : typeof input.query === 'string' ? input.query : typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 2000);
    const skill = skillOf(name, input);
    this.turnCalls.push({ tool: name, text: line, failed: false, toolUseId: id, ...(skill ? { skill } : {}) });
  }

  private speak(text: string, blocks: MessageBlock[]): void {
    const keys = new RegExp(this.o.ticketKey.source, `${this.o.ticketKey.flags.replace('g', '')}g`);
    const tickets = [...new Set([...text.matchAll(keys)].map((m) => m[0].toUpperCase()))];
    this.o.log.append('elfoqsy', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      text,
      conversationId: this.conversationId,
      ...(blocks.length ? { blocks } : {}),
      ...(tickets.length ? { refs: { tickets } } : {}),
    });
  }
}
