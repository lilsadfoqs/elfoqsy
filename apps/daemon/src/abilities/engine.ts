// The abilities engine. Skills live in data/skills (store.ts); this keeps the event log in step
// with them and does the rest of the brief:
// - discovery during work: at the end of every run, its friction (friction.ts) is reviewed, and a skill is written when
//   one would have removed it (one short session on Elfoqsy's model, no tools);
// - verification: each read step runs through the proxies as Elfoqsy's own tier-0 read; a step with effects is never run;
// - activation: a skill is active as soon as it is written, with no approval, and it grants nothing;
// - tracking: each use in a run records whether it worked and the steps it took, against the median before the skill;
// - repair: a use whose steps failed marks it "needs re-check"; Elfoqsy verifies it again and, when a step really
//   fails, rewrites it and verifies the new version herself;
// - credit and notice: who found it, and one line in her voice when she learns one.
import { ABILITY_TOOLS, type AbilityFinder, type AbilityStepStatus, type AbilityTool, type AnyEnvelope, type PayloadOf, type ProxyName } from '@elfoqsy/contracts';
import { todayConversation, type WorkspaceState } from '@elfoqsy/state';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventLog } from '../eventLog';
import { redact } from '../redact';
import { ulid } from '../ulid';
import { baselineOf, finderName, longSteps, problemsOf, stepViews, toolOfTrack, tracks, type Ability, type AbilityStep } from './ability';
import { errorClass, frictionOf, isQuestion, RUN_TOOLS, worthASkill, type Call, type FrictionPoint } from './friction';
import type { AbilityStore } from './store';
import { ABILITIES } from '../skill/abilities';
import type { TelemetryStore } from '../telemetry/store';
import { telemetryEnv } from '../telemetry/env';

export type QueryFn = (params: { prompt: string; options?: Options }) => Query | AsyncIterable<SDKMessage>;

export interface EngineDeps {
  log: EventLog;
  state: () => WorkspaceState;
  store: AbilityStore;
  /** Elfoqsy's own read through the proxies: tier 0 only (orchestrator.elfoqsyRead). */
  read: (proxy: ProxyName, input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  /** For the review and the repair: one short session each, on her model, with no tools and none of his setup. */
  queryFn: QueryFn;
  model: string;
  cwd: string;
  env: Record<string, string>;
  now?: () => number;
  /**
   * What she learned from a run or from files on disk, handed to her to say in one line of her own (elfoqsy/brain.ts
   * announceAbilities: a turn of hers, in his language, which posts the line with the cards). The engine writes no line itself:
   * a template glued to a title ("I just learned how to how long the AWS sessions have left") is never what she says. Without it
   * (a test, simulate mode) nothing is said and the abilities are in the Abilities view.
   */
  announce?: (a: AbilityAnnouncement) => void;
  /**
   * The spans every session exports (telemetry/store.ts), where they are kept: each call's full command and whether its
   * execution failed (better than the log's 200-character summary and the tool's own word), what a use cost (tokens,
   * cache reads, time), and the failures that keep coming back, for discovery.
   */
  telemetry?: Pick<TelemetryStore, 'toolCalls' | 'useCost' | 'recurringFailures'>;
  /**
   * The abilities whose samples are too long for a card's line, handed to her to write shorter (elfoqsy/brain.ts reviseAbilities).
   * True when she was handed them: it is not asked again for those; false when she cannot be handed anything yet.
   */
  revise?: (r: AbilityRevision) => boolean;
}

/** What she is handed to shorten: each ability whole, as stored, with the steps that do not fit a line and how long they are. */
export interface AbilityRevision {
  conversationId: string;
  abilities: Array<{ ability: Ability; long: string[] }>;
}

/** What she is told to say something about: the abilities, where, and whether it is a new version of one she had. */
export interface AbilityAnnouncement {
  conversationId: string;
  updated: boolean;
  abilities: Array<{ name: string; title: string; titleVi: string; tool: AbilityTool; whenToUse: string; finder: AbilityFinder; source: string }>;
}

/** A run as it ended, for the review and the uses. */
export interface EndedRun {
  runId: string;
  agentNumber: number;
  ticket?: string;
  state: 'succeeded' | 'failed' | 'stopped' | 'cancelled';
  /** A tester's run: nothing learned, nothing tracked. */
  test?: boolean;
}

export type Verification = Array<{ status: AbilityStepStatus; note?: string }>;

/** An ability as she writes it: what the engine does not fill in itself (version, credit, source, baseline). */
export type AbilityDraft = Pick<Ability, 'name' | 'title' | 'titleVi' | 'tool' | 'whenToUse' | 'steps' | 'doneWhen' | 'track'> & Partial<Pick<Ability, 'references'>>;
/** `long`: the steps whose text and sample do not fit one line of the card (so she can write them shorter). */
export type WriteResult = { ok: true; name: string; version: number; verification: Verification; long?: string[] } | { error: string; message: string };

/** Calls of an ability's kind, done without it, that make a missed use. */
export const MISSED_AT = 2;

const READ_TIMEOUT_MS = 90_000;
/** A read that could not run now (a session ran out, a proxy not set up) is unverified, not failed. */
const NOT_NOW = /run out|not configured|is not set up|no \w+ proxy|cannot be read now|timed out/i;

/** A run's tool calls from the log, oldest first: what it called, whether the gate or the tool failed it, and what came back. */
export function callsOfRun(log: Pick<EventLog, 'readRun'>, runId: string): Array<Call & { skill?: string }> {
  const events = log.readRun(runId, 50_000) as AnyEnvelope[];
  const finished = new Map<string, PayloadOf<'tool.finished'>>();
  for (const e of events) if (e.type === 'tool.finished' && e.payload.toolUseId) finished.set(e.payload.toolUseId, e.payload);
  const out: Array<Call & { skill?: string }> = [];
  for (const e of events) {
    if (e.type !== 'tool.called') continue;
    const p = e.payload;
    const tool = p.tool.replace(/^mcp__run__/, '');
    const input = summaryInput(p.inputSummary);
    const text = Array.isArray(input.args)
      ? (input.args as unknown[]).map(String).join(' ')
      : typeof input.command === 'string'
        ? input.command
        : typeof input.query === 'string'
          ? input.query
          : typeof input.action === 'string'
            ? `${input.action} ${p.inputSummary}`
            : RUN_TOOLS.includes(tool) || tool === 'Skill'
              ? p.inputSummary
              : p.title || p.inputSummary;
    const fin = p.toolUseId ? finished.get(p.toolUseId) : undefined;
    out.push({
      tool,
      text,
      failed: p.allowed === false || fin?.ok === false,
      result: `${p.allowed === false ? 'refused by the gate\n' : ''}${fin?.outputSummary ?? ''}`,
      ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
      ...(tool === 'Skill' && typeof input.skill === 'string' ? { skill: input.skill.replace(/^\//, '').replace(`${ABILITIES}:`, '') } : {}),
    });
  }
  return out;
}

/**
 * A call's input from its logged summary, which is cut at 200 characters: parsed whole when it can be, else its args
 * (the strings that survived the cut), its command, its skill and its action, read from the text.
 */
export function summaryInput(summary: string): Record<string, unknown> {
  try {
    return JSON.parse(summary) as Record<string, unknown>;
  } catch {
    const strings = (from: string) => [...from.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]!; } });
    const out: Record<string, unknown> = {};
    const args = /"args"\s*:\s*\[(.*)$/s.exec(summary);
    if (args) out.args = strings(args[1]!);
    for (const key of ['command', 'skill', 'action', 'query', 'question']) {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(summary);
      if (m) out[key] = m[1]!.replace(/\\"/g, '"').replace(/\\n/g, ' ');
    }
    return out;
  }
}

/** The JSON object in a model's reply: in a ```json block, or the first {…} span. */
export function jsonIn(text: string): unknown {
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(block);
  } catch {
    return undefined;
  }
}

/** The skill a Skill call loads: its name without the plugin's prefix, or undefined for any other call. */
export function skillOf(tool: string, input: Record<string, unknown>): string | undefined {
  return tool === 'Skill' && typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '').replace(`${ABILITIES}:`, '') : undefined;
}

export class AbilityEngine {
  /** Recurring failures already put to the review since the daemon started: each is asked about once. */
  private readonly askedRecurring = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly repairedVersions = new Set<string>();

  constructor(private readonly d: EngineDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** One thing at a time: writes to data/skills and the log never interleave. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * At start: every skill on disk the log does not know yet is learned (one line from her for them all), a newer version
   * on disk is a repair, and every current version not verified yet is verified.
   */
  reconcile(): Promise<string[]> {
    return this.serial(async () => {
      const learned: Ability[] = [];
      // One that is about no tool (`other`, from before every skill had one) is told which it is from the run tools it tracks: the card has its logo.
      for (const a of this.d.store.list()) {
        const tool = a.tool === 'other' ? toolOfTrack(a.track.tools) : a.tool;
        if (tool === a.tool) continue;
        await this.d.store.write({ ...a, tool }, `retooled ${a.name}: ${tool}`);
      }
      for (const a of this.d.store.list()) {
        const known = this.d.state().abilities[a.name];
        if (!known) {
          this.appendLearned(a);
          learned.push(a);
        } else if (a.version > known.version || a.tool !== known.tool) {
          // A newer version on disk (updated or repaired elsewhere), or the tool it is about told again: learned again, its counts and credit kept by the fold.
          this.appendLearned(a);
        }
      }
      // Those logged before the origin was kept have it added now, from the same files.
      for (const a of this.d.store.list()) if (this.d.state().abilities[a.name] && !this.d.state().abilities[a.name]!.origin) this.appendOrigin(a);
      // One line for each conversation they were found in (hers, when it still exists), else for Today's.
      const groups = new Map<string, Ability[]>();
      for (const a of learned) {
        const where = a.finder.by === 'elfoqsy' && a.finder.session && this.d.state().conversations[a.finder.session] ? a.finder.session : '';
        groups.set(where, [...(groups.get(where) ?? []), a]);
      }
      for (const [where, group] of groups) this.notice(group, where ? { conversationId: where } : {});
      for (const a of this.d.store.list()) if (!this.d.state().abilities[a.name]?.verification) await this.verifyNow(a);
      return learned.map((a) => a.name);
    });
  }

  /**
   * Hands her the abilities whose samples are too long for a card's line, to write shorter (with the full commands in the skill's
   * references): once for each, ever. Called once she can be handed anything (the brain is up); `revise` says whether she was.
   */
  askShorter(): Promise<string[]> {
    return this.serial(async () => {
      const asked = new Set(this.d.log.readFrom(0, 100_000, ['ability.shorten_asked']).flatMap((e) => (e.payload as PayloadOf<'ability.shorten_asked'>).names));
      const todo = this.d.store.list().filter((a) => !asked.has(a.name) && longSteps(a).length > 0);
      if (!todo.length || !this.d.revise) return [];
      // In Today's conversation, made when there is none (as the notice does).
      const today = todayConversation(this.now());
      if (!this.d.state().conversations[today.conversationId]) this.d.log.append('orchestrator', 'conversation.created', today);
      const handed = this.d.revise({ conversationId: today.conversationId, abilities: todo.map((a) => ({ ability: a, long: longSteps(a) })) });
      if (!handed) return [];
      this.d.log.append('orchestrator', 'ability.shorten_asked', { names: todo.map((a) => a.name) });
      return todo.map((a) => a.name);
    });
  }

  /** A new skill: written and committed, learned, said, and verified. Refused when it is not valid. */
  learn(a: Ability): Promise<void> {
    return this.serial(async () => {
      await this.d.store.write(a, `learned ${a.name}: ${a.title} (${finderName(a.finder)})`);
      this.appendLearned(a);
      this.notice([a]);
      await this.verifyNow(a);
    });
  }

  verify(name: string): Promise<Verification | undefined> {
    return this.serial(async () => {
      const a = this.d.store.get(name);
      return a ? this.verifyNow(a) : undefined;
    });
  }

  /** A run ended: its uses of skills, then the review of its friction. Never for a tester's run. */
  runEnded(run: EndedRun): Promise<void> {
    if (run.test) return Promise.resolve();
    return this.serial(async () => {
      const calls = this.withSpans(callsOfRun(this.d.log, run.runId));
      const repair = this.trackUses(run, calls);
      for (const name of repair) await this.recheck(name);
      await this.review(run, calls);
    });
  }

  /** Where it came from, as its ability.json keeps it: the Abilities view says it in one line (ability.origin). */
  private appendOrigin(a: Ability): void {
    this.d.log.append('orchestrator', 'ability.origin', { name: a.name, version: a.version, foundAt: a.createdAt, cases: a.baseline.cases, from: redact(a.baseline.from).slice(0, 400) });
  }

  private appendLearned(a: Ability): void {
    const hadOrigin = !!this.d.state().abilities[a.name]?.origin;
    this.d.log.append('orchestrator', 'ability.learned', {
      name: a.name,
      version: a.version,
      title: a.title,
      titleVi: a.titleVi,
      tool: a.tool,
      steps: stepViews(a),
      finder: a.finder,
      baselineSteps: a.baseline.steps,
      baselineFailed: a.baseline.failed,
      baselineQuestions: a.baseline.questions,
      source: a.source,
    });
    if (!hadOrigin) this.appendOrigin(a);
  }

  /**
   * What she learned, said by her: in the conversation she wrote it from, else in Today's (made when there is none yet, as
   * routing.ts does). When she wrote it herself (write_ability) the line is hers, posted here with each ability as its small
   * card beside it; otherwise she is handed it to say, in her own words and his language (`announce`). Never assembled here.
   */
  private notice(learned: Ability[], o: { conversationId?: string; updated?: boolean; say?: string } = {}): void {
    let conversationId = o.conversationId && this.d.state().conversations[o.conversationId] ? o.conversationId : undefined;
    if (!conversationId) {
      const today = todayConversation(this.now());
      if (!this.d.state().conversations[today.conversationId]) this.d.log.append('orchestrator', 'conversation.created', today);
      conversationId = today.conversationId;
    }
    if (o.say) {
      this.d.log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: redact(o.say.trim()), conversationId, blocks: learned.map((a) => ({ type: 'ability' as const, ref: a.name })) });
      return;
    }
    this.d.announce?.({
      conversationId,
      updated: !!o.updated,
      abilities: learned.map((a) => ({ name: a.name, title: a.title, titleVi: a.titleVi, tool: a.tool, whenToUse: a.whenToUse, finder: a.finder, source: a.source })),
    });
  }

  /**
   * Her own ability, from her tool (write_ability): a new one, or a new version of one that exists (update). It goes the
   * way a run's does: the same checks, written and committed, learned, said in one line (in her conversation), verified.
   * Credit: hers for a new one; an update keeps who found it, where, and its baseline. A new one's baseline is what the
   * friction she saw cost (calls, failed calls, questions to him), unless two or more runs in the log already measure it.
   */
  write(d: AbilityDraft, o: { update?: boolean; quiet?: boolean; conversationId?: string; say?: string; friction?: { what: string; calls: number; failed: number; questions: number } } = {}): Promise<WriteResult> {
    return this.serial(async () => {
      const existing = this.d.store.get(d.name);
      // The line that tells him is hers, in his language, written with the ability: no one else makes it up. A quiet update (the same
      // ability with its samples written shorter) has none: she says one line for all of them, in her reply.
      const quiet = !!o.quiet && !!existing && !!o.update;
      if (!quiet && !o.say?.trim()) return { error: 'no_line', message: 'Write the one line you say about it (say), in his language, in your own words.' };
      if (existing && !o.update) return { error: 'exists', message: `${d.name} exists (version ${existing.version}). To change it, send it whole with update: true.` };
      if (!existing && o.update) return { error: 'unknown', message: `There is no ability ${d.name} to update. Write it without update.` };
      if (!existing && !o.friction) return { error: 'no_friction', message: 'Say what friction it removes (what happened, the calls it took, the failed calls, the questions to alex): it is its baseline.' };
      const fromRuns = existing ? undefined : this.baseline(d.track, '', []);
      const conversation = o.conversationId ? this.d.state().conversations[o.conversationId] : undefined;
      const a: Ability = {
        ...d,
        version: existing ? existing.version + 1 : 1,
        finder: existing?.finder ?? { by: 'elfoqsy', ...(o.conversationId ? { session: o.conversationId } : {}) },
        source: existing?.source ?? `${conversation?.title ?? o.conversationId ?? 'her own work'}, Elfoqsy`,
        createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
        baseline:
          existing?.baseline ??
          (fromRuns && fromRuns.cases >= 2 ? fromRuns : { steps: o.friction!.calls, failed: o.friction!.failed, questions: o.friction!.questions, cases: 1, from: `her own work: ${o.friction!.what}`.slice(0, 300) }),
      };
      const problems = problemsOf(a);
      if (problems.length) return { error: 'not_valid', message: `Not written: ${problems.join('; ')}.` };
      await this.d.store.write(a, `${existing ? 'updated' : 'learned'} ${a.name}: ${a.title} (Elfoqsy${existing ? `, v${a.version}` : ''})`);
      this.appendLearned(a);
      if (!quiet) this.notice([a], { ...(o.conversationId ? { conversationId: o.conversationId } : {}), updated: !!existing, say: o.say });
      const verification = await this.verifyNow(a);
      const long = longSteps(a);
      return { ok: true, name: a.name, version: a.version, verification, ...(long.length ? { long } : {}) };
    });
  }

  /** Each step verified, logged; a step that failed marks it "needs re-check". */
  private async verifyNow(a: Ability): Promise<Verification> {
    const steps: Verification = [];
    for (const s of a.steps) steps.push(await this.verifyStep(s));
    this.d.log.append('orchestrator', 'ability.verified', { name: a.name, version: a.version, steps });
    const failed = steps.findIndex((s) => s.status === 'failed');
    if (failed >= 0) this.d.log.append('orchestrator', 'ability.needs_recheck', { name: a.name, version: a.version, step: failed, reason: steps[failed]!.note ?? 'The step failed.' });
    return steps;
  }

  private async verifyStep(s: AbilityStep): Promise<{ status: AbilityStepStatus; note?: string }> {
    if (s.effect) return { status: 'unverified', note: 'It changes something, so it is never run to verify it.' };
    if (!s.read) return { status: 'unverified', note: 'Nothing to run.' };
    const r = await Promise.race([
      this.d.read(s.read.proxy, s.read.input).catch((error: unknown) => ({ ok: false, text: error instanceof Error ? error.message : String(error) })),
      new Promise<{ ok: false; text: string }>((resolve) => setTimeout(() => resolve({ ok: false, text: 'The read timed out.' }), READ_TIMEOUT_MS).unref?.()),
    ]);
    if (r.ok) return { status: 'ok' };
    const note = redact(errorClass(r.text) || r.text.split('\n')[0] || 'It failed.').slice(0, 200);
    return NOT_NOW.test(r.text) ? { status: 'unverified', note } : { status: 'failed', note };
  }

  /** Each use in this run. The names whose use failed on a step, to check again. */
  private trackUses(run: EndedRun, calls: Array<Call & { skill?: string }>): string[] {
    return this.uses('run', run.runId, calls, false);
  }

  /**
   * The uses in a stretch of work: each Skill call, measured over the calls after it up to its next load or the end.
   * - In a run or an investigation, a skill loaded and never acted on is not a use, and a use worked when the last call
   *   of its kind did.
   * - In her conversation every Skill call is a use, and it worked when every call after it in the turn succeeded and
   *   her reply asked alex nothing (askedHim, counted against the turn's last use).
   * The names whose use failed on a call of its kind, to check again.
   */
  private uses(where: 'run' | 'conversation' | 'investigation', id: string, calls: Array<Call & { skill?: string }>, askedHim: boolean): string[] {
    const recheck: string[] = [];
    // A task an ability covers, done without it: two or more of its kind of calls, and the skill never loaded here.
    const loaded = new Set(calls.flatMap((c) => (c.skill ? [c.skill] : [])));
    for (const a of this.d.store.list()) {
      if (loaded.has(a.name)) continue;
      const n = calls.filter((c) => tracks(a, c)).length;
      if (n >= MISSED_AT) this.d.log.append('orchestrator', 'ability.missed', { name: a.name, runId: id, ...(where === 'run' ? {} : { in: where }), steps: n });
    }
    const loads = calls.flatMap((c, i) => (c.skill ? [i] : []));
    loads.forEach((i, k) => {
      const a = this.d.store.get(calls[i]!.skill!);
      if (!a) return;
      const until = calls.findIndex((d, j) => j > i && d.skill === a.name);
      const following = calls.slice(i + 1, until < 0 ? undefined : until);
      const tracked = following.filter((d) => tracks(a, d));
      if (where !== 'conversation' && !tracked.length) return;
      const questions = following.filter(isQuestion).length + (askedHim && k === loads.length - 1 ? 1 : 0);
      const failedCalls = tracked.filter((d) => d.failed).length;
      const worked = where === 'conversation' ? following.every((d) => !d.failed) && questions === 0 : !tracked.at(-1)!.failed;
      this.d.log.append('orchestrator', 'ability.used', {
        name: a.name,
        runId: id,
        ...(where === 'run' ? {} : { in: where }),
        worked,
        steps: tracked.length,
        baselineSteps: a.baseline.steps,
        failedCalls,
        baselineFailed: a.baseline.failed,
        questions,
        baselineQuestions: a.baseline.questions,
        ...(this.useCostOf(calls, i, until) ?? {}),
      });
      const bad = tracked.filter((d) => d.failed).at(-1);
      if (!worked && bad) {
        const step = Math.max(0, a.steps.findIndex((s) => s.read?.proxy === bad.tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')));
        this.d.log.append('orchestrator', 'ability.needs_recheck', { name: a.name, version: a.version, step, reason: errorClass(bad.result) || 'The step failed.' });
        recheck.push(a.name);
      }
    });
    return [...new Set(recheck)];
  }

  /** What a use cost, from the spans (tokens, cache reads, time), from its Skill call to the next load of it or the end. */
  private useCostOf(calls: Array<Call & { skill?: string }>, i: number, until: number): { tokens: number; cacheRead: number; ms: number } | undefined {
    const from = calls[i]?.toolUseId;
    if (!this.d.telemetry || !from) return undefined;
    const cost = this.d.telemetry.useCost(from, until < 0 ? undefined : calls[until]?.toolUseId);
    return cost ? { tokens: cost.tokens, cacheRead: cost.cacheRead, ms: cost.ms } : undefined;
  }

  /**
   * Each call as its spans tell it, where they are kept: the full command (the log keeps 200 characters of its input) and
   * whether its execution failed (a command can fail while the tool answers), with the error's class.
   */
  private withSpans<T extends Call>(calls: T[]): T[] {
    if (!this.d.telemetry) return calls;
    const facts = this.d.telemetry.toolCalls(calls.flatMap((c) => (c.toolUseId ? [c.toolUseId] : [])));
    if (!facts.size) return calls;
    return calls.map((c) => {
      const f = c.toolUseId ? facts.get(c.toolUseId) : undefined;
      if (!f) return c;
      return {
        ...c,
        ...(f.command && c.tool === 'Bash' ? { text: f.command } : {}),
        failed: c.failed || f.failed,
        ...(f.failed && !c.failed ? { result: `${f.errorClass ?? 'failed'}\n${c.result ?? ''}` } : {}),
      };
    });
  }

  /**
   * Failures that keep coming back across sessions, from the spans (the last two weeks): one that no ability covers yet
   * goes to the same short session a run's review uses, and an ability is written when one would have removed it,
   * credited to her. Each failure is asked about once; the daemon calls this once a day.
   */
  discoverRecurring(sinceMs?: number): Promise<string | undefined> {
    return this.serial(async () => {
      if (!this.d.telemetry) return undefined;
      const known = this.d.store.list();
      const group = this.d.telemetry
        .recurringFailures(sinceMs ?? this.now() - 14 * 24 * 3600_000)
        .filter((g) => !this.askedRecurring.has(`${g.signature}|${g.errorClass ?? ''}`))
        .find((g) => !known.some((a) => g.examples.some((e) => tracks(a, { tool: g.tool, text: e }))));
      if (!group) return undefined;
      this.askedRecurring.add(`${group.signature}|${group.errorClass ?? ''}`);
      const input = [
        `A failure that keeps coming back, from the traces of the last two weeks: ${group.count} failed ${group.tool} calls (${group.signature}${group.errorClass ? `, ${group.errorClass}` : ''}) in ${group.sessions} sessions${group.runs.length ? `, runs ${group.runs.slice(0, 6).join(', ')}` : ''}.`,
        '',
        'Examples:',
        ...group.examples.map((e) => `- ${e}`),
        '',
        `The skills already known: ${known.map((a) => `${a.name} (${a.title})`).join(', ') || 'none'}.`,
      ].join('\n');
      const proposal = (jsonIn(await this.ask(REVIEW_PROMPT, input)) as { skill?: Partial<Ability> | null } | undefined)?.skill;
      if (!proposal || !proposal.name || !proposal.steps || !proposal.track || known.some((a) => a.name === proposal.name)) return undefined;
      const per = (n: number) => Math.round((n / Math.max(1, group.sessions)) * 100) / 100;
      const a: Ability = {
        name: proposal.name,
        version: 1,
        title: proposal.title ?? '',
        titleVi: proposal.titleVi ?? '',
        tool: proposal.tool && proposal.tool !== 'other' && ABILITY_TOOLS.includes(proposal.tool) ? proposal.tool : toolOfTrack(proposal.track.tools),
        whenToUse: proposal.whenToUse ?? '',
        steps: proposal.steps,
        doneWhen: proposal.doneWhen ?? '',
        finder: { by: 'elfoqsy', session: 'traces' },
        source: `recurring failures in the traces, ${group.sessions} sessions`,
        createdAt: new Date(this.now()).toISOString(),
        baseline: { steps: per(group.count), failed: per(group.count), questions: 0, cases: group.sessions, from: `the traces: ${group.count} failed ${group.signature} calls in ${group.sessions} sessions` },
        track: proposal.track,
      };
      if (problemsOf(a).length) return undefined;
      await this.d.store.write(a, `learned ${a.name}: ${a.title} (Elfoqsy, from recurring failures in the traces)`);
      this.appendLearned(a);
      this.notice([a]);
      await this.verifyNow(a);
      return a.name;
    });
  }

  /**
   * A turn of her conversation, or an investigation at its report, with its calls in order (a Skill call names its
   * skill): its uses, as above, then each that failed on a step checked again.
   */
  sessionUses(u: { in: 'conversation' | 'investigation'; id: string; calls: Array<Call & { skill?: string }>; askedHim?: boolean }): Promise<void> {
    if (!u.calls.length) return Promise.resolve();
    return this.serial(async () => {
      for (const name of this.uses(u.in, u.id, this.withSpans(u.calls), !!u.askedHim)) await this.recheck(name);
    });
  }

  /** Verified again; a step that really fails is rewritten once per version, and the new version verified. */
  private async recheck(name: string): Promise<void> {
    const a = this.d.store.get(name);
    if (!a) return;
    const steps = await this.verifyNow(a);
    if (!steps.some((s) => s.status === 'failed')) return;
    const key = `${a.name}@${a.version}`;
    if (this.repairedVersions.has(key)) return;
    this.repairedVersions.add(key);
    const reply = await this.ask(REPAIR_PROMPT, `The skill, as JSON:\n${JSON.stringify(a, null, 2)}\n\nIts verification:\n${steps.map((s, i) => `${i + 1}. ${s.status}${s.note ? `: ${s.note}` : ''}`).join('\n')}`);
    const fixed = (jsonIn(reply) as { steps?: AbilityStep[] } | undefined)?.steps;
    if (!Array.isArray(fixed)) return;
    const next: Ability = { ...a, version: a.version + 1, steps: fixed };
    if (problemsOf(next).length) return;
    const reason = steps
      .map((s, i) => (s.status === 'failed' ? `step ${i + 1}: ${s.note ?? 'failed'}` : ''))
      .filter(Boolean)
      .join('; ');
    await this.d.store.write(next, `repaired ${a.name} v${next.version}: ${reason}`.slice(0, 200));
    this.d.log.append('orchestrator', 'ability.repaired', { name: a.name, version: next.version, steps: stepViews(next), reason: reason.slice(0, 300) });
    await this.verifyNow(next);
  }

  /**
   * The review at the end of a run: its friction worth a skill, minus what a skill it used already covers. When there is
   * some, one short session decides whether a skill would have removed it, and writes it.
   */
  private async review(run: EndedRun, calls: Array<Call & { skill?: string }>): Promise<void> {
    const known = this.d.store.list();
    const friction = frictionOf(calls)
      .filter(worthASkill)
      .filter((f) => !known.some((a) => tracks(a, { tool: f.signature.split(' ')[0]!, text: f.example })));
    if (!friction.length) return;
    const reply = await this.ask(REVIEW_PROMPT, reviewInput(run, friction, known));
    const proposal = (jsonIn(reply) as { skill?: Partial<Ability> | null } | undefined)?.skill;
    if (!proposal || !proposal.name || !proposal.steps || !proposal.track) return;
    if (known.some((a) => a.name === proposal.name)) return;
    const baseline = this.baseline(proposal.track, run.runId, calls);
    const a: Ability = {
      name: proposal.name,
      version: 1,
      title: proposal.title ?? '',
      titleVi: proposal.titleVi ?? '',
      tool: proposal.tool && proposal.tool !== 'other' && ABILITY_TOOLS.includes(proposal.tool) ? proposal.tool : toolOfTrack(proposal.track.tools),
      whenToUse: proposal.whenToUse ?? '',
      steps: proposal.steps,
      doneWhen: proposal.doneWhen ?? '',
      finder: { by: 'agent', agentNumber: run.agentNumber, runId: run.runId, ...(run.ticket ? { ticket: run.ticket } : {}) },
      source: run.ticket ? `${run.ticket}, Agent ${run.agentNumber}` : `Agent ${run.agentNumber}`,
      createdAt: new Date(this.now()).toISOString(),
      baseline,
      track: proposal.track,
    };
    if (problemsOf(a).length) return;
    await this.d.store.write(a, `learned ${a.name}: ${a.title} (Agent ${run.agentNumber}${run.ticket ? `, ${run.ticket}` : ''})`);
    this.appendLearned(a);
    this.notice([a]);
    await this.verifyNow(a);
  }

  /**
   * The median steps of this kind of task before the skill: the calls it covers in each earlier run that made any,
   * this run included. A run is one case.
   */
  private baseline(track: Ability['track'], runId: string, calls: Call[]): Ability['baseline'] {
    const runs = [{ calls }, ...Object.keys(this.d.state().runs).filter((id) => id !== runId).map((id) => ({ calls: callsOfRun(this.d.log, id) }))];
    const b = baselineOf(track, runs);
    return { steps: b.steps, failed: b.failed, questions: b.questions, cases: b.cases, from: 'runs in the log before the skill' };
  }

  private async ask(system: string, prompt: string): Promise<string> {
    const q = this.d.queryFn({
      prompt,
      options: {
        systemPrompt: system,
        model: this.d.model,
        effort: 'medium',
        tools: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        persistSession: false,
        settings: { autoMemoryEnabled: false },
        maxTurns: 1,
        cwd: this.d.cwd,
        env: { ...this.d.env, ...telemetryEnv({ kind: 'abilities' }) },
      },
    });
    let text = '';
    try {
      for await (const m of q) {
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') text += b.text;
        if (m.type === 'result') break;
      }
    } catch {
      return text;
    }
    return text;
  }
}

function reviewInput(run: EndedRun, friction: FrictionPoint[], known: Ability[]): string {
  return [
    `A run just ended: Agent ${run.agentNumber}${run.ticket ? ` on ${run.ticket}` : ''}, ${run.state}.`,
    '',
    'Its friction:',
    ...friction.map((f) => `- ${f.kind}, ${f.calls} call${f.calls === 1 ? '' : 's'}: ${f.signature}: ${f.example}${f.error ? ` -> ${f.error}` : ''}${f.fixedBy ? `; it worked with: ${f.fixedBy}` : ''}`),
    '',
    `The skills already known: ${known.map((a) => `${a.name} (${a.title})`).join(', ') || 'none'}.`,
  ].join('\n');
}

const FORMAT = `A skill, as JSON:
{"name": "kebab-case", "title": "short, at most 60 characters", "titleVi": "the same as a Vietnamese phrase that follows 'cách'",
 "tool": "kubernetes | coralogix | github | aws | jira | confluence | docker | test | teams | outlook | sharepoint | onedrive | elfoqsy (the workspace's own runs, events and sprint)",
 "whenToUse": "one or two sentences", "doneWhen": "one sentence",
 "references": "optional markdown: the full commands with their flags and what explains them, when a sample has to be short",
 "steps": [{"text": "one short line", "code": "the sample it runs, as short as it can be and still run (about 30 characters beside its text)", "read": {"proxy": "kube | aws | gh | logs", "input": {...the run tool's input...}}} or {"text": "...", "code": "...", "effect": true}],
 "track": {"tools": ["the run tools it covers: kube, aws, gh, logs, jira, ..."], "match": "optional regular expression over the call's arguments"}}
At most 8 steps, each one short line. A read step carries the exact tier-0 request that shows it works (the kube tool takes {"args": [...]}, logs takes {"environment", "query", "from"}, gh {"args": [...]}, aws {"args": [...]}). A step that changes anything is marked effect and has no read. Never a token, key, password or signed URL.`;

const REVIEW_PROMPT = `You are Elfoqsy, reviewing the friction of a run that just ended: failed or retried commands, long searches for the same thing, and questions asked to alex about environments or process. Write a skill only when one would have removed that friction for the next run, from what the run itself shows worked (never invent a command it did not run). If no skill would have helped, or a known skill covers it, reply {"skill": null}.

${FORMAT}

Reply with one JSON object: {"skill": {...}} or {"skill": null}.`;

const REPAIR_PROMPT = `You are Elfoqsy, repairing a skill whose steps started failing. Rewrite only the failing steps, from what the verification says; keep the others as they are. Each read step keeps the exact tier-0 request that shows it works.

${FORMAT}

Reply with one JSON object: {"steps": [...all the steps, in order...]}.`;
