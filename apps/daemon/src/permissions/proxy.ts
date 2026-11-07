// The orchestrator's capability proxies, as one policy. An agent's request is classified into a tier, then:
// 0 runs at once; 1 is recorded, runs at once, and Elfoqsy reports it in one line; 2 runs under a live grant for the same
// kind, ticket and environment, or is asked (batched with others in the same few seconds) and recorded before it runs;
// 3 is refused and Elfoqsy tells alex it is his to do. Calls that need AWS wait while his session is not fresh,
// and a call cut short by an expired session waits and runs again instead of failing. Every action is logged with its
// run, agent and tier: every remote action runs under alex's own identity, so the log is what tells them apart.
import type { Actor, DelegationCategory, PayloadOf, ProxyName } from '@elfoqsy/contracts';
import type { Approvals, Resolution } from '../agents/approvals';
import { answeredBy, unanswered } from '../agents/approvals';
import { actionCategory } from '../decisions/categories';
import type { FirstResponder } from '../decisions/firstResponder';
import type { EventLog } from '../eventLog';
import { redact } from '../redact';
import { tr } from '../elfoqsy/voice';
import { ulid } from '../ulid';
import { carriedStrings, sessionRanOut } from './aws';
import { neverEnds } from './endless';
import type { AwsSession } from './awsSession';
import type { Grants } from './grants';
import { actorName, type Classified, type Outcome, type ProxyHandler, type Recorded, type RunRef } from './types';

export interface ProxyRun extends RunRef {
  /** Holds a call while the run waits for something other than alex's answer: it shows as paused, its clock stopped. */
  hold?<T>(reason: string, until: Promise<T>): Promise<T>;
  /** Waits for alex's answer: the run shows as waiting for him, its clock stopped. */
  asking?<T>(answer: Promise<T>): Promise<T>;
}

export interface ProxiesDeps {
  log: EventLog;
  approvals: Approvals;
  grants: Grants;
  handlers: Array<ProxyHandler<never>>;
  aws?: AwsSession;
  /** Elfoqsy's one line in the run's conversation (from the orchestrator, no Claude turn). */
  say: (run: RunRef, text: string) => void;
  /** An ended run, for an undo: its kubeconfig made again; dispose removes it. ticket: the one the change was on. */
  endedRun?: (runId: string, ticket?: string) => Promise<{ run: RunRef; dispose: () => void } | null>;
  /** Elfoqsy, first responder for tier-2 requests; without her, they go straight to alex. */
  firstResponder?: () => FirstResponder | undefined;
  /** After a Jira write ran: logged as an edit of the ticket, which is read back. recordId: its recorded change. */
  afterWrite?: (w: { run: ProxyRun; target: NonNullable<Classified['target']>; actionId: string; ok: boolean; recordId?: string; output: string }) => void;
  now?: () => number;
}

export interface ProxyAnswer {
  ok: boolean;
  text: string;
  actionId?: string;
}

/** The proxies Elfoqsy reads through herself: kubectl, the AWS CLI, gh and Coralogix. */
export const READ_PROXIES: readonly ProxyName[] = ['kube', 'aws', 'gh', 'logs'];

/** What gate decided: run it (said why), or the refusal for the agent. */
export type GateResult =
  | { allowed: true; actionId: string; how: 'tier' | 'grant' | 'approval' | 'elfoqsy'; resolution?: Resolution; decisionId?: string }
  | { allowed: false; actionId: string; message: string };

/** A reason as Elfoqsy says it to alex himself. */
export const toHim = (reason: string): string =>
  reason
    .replace(/alex's(?= to\b|[.,;:]|$)/g, 'yours')
    .replace(/alex's/g, 'your')
    .replace(/alex/g, 'you');

const firstLines = (text: string, lines = 6, max = 600): string => {
  const t = text.trim().split('\n').slice(0, lines).join('\n');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};


export class Proxies {
  private readonly handlers = new Map<ProxyName, ProxyHandler<never>>();
  private readonly runs = new Map<string, ProxyRun>();
  private readonly records = new Map<string, { record: PayloadOf<'change.recorded'>; undone: boolean }>();
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ProxiesDeps) {
    for (const h of deps.handlers) this.handlers.set(h.name, h);
    this.now = deps.now ?? Date.now;
    // Recorded changes outlive their runs and the daemon: Undo works from the log.
    for (const e of deps.log.readFrom(0, 1_000_000, ['change.recorded', 'change.undone'])) this.track(e);
    this.unsubscribe = deps.log.subscribe((e) => this.track(e));
  }

  private track(e: ReturnType<EventLog['readFrom']>[number]): void {
    if (e.type === 'change.recorded') this.records.set(e.payload.recordId, { record: e.payload, undone: false });
    else if (e.type === 'change.undone') {
      const entry = this.records.get(e.payload.recordId);
      if (entry) entry.undone = true;
    }
  }

  register(run: ProxyRun): void {
    this.runs.set(run.runId, run);
  }

  /** The run ended: its grants end with it. */
  unregister(runId: string): void {
    this.runs.delete(runId);
    this.deps.grants.endRun(runId);
  }

  has(proxy: ProxyName): boolean {
    return this.handlers.has(proxy);
  }

  /** An agent's request through one of the proxies, from classification to Elfoqsy's line. */
  async request(run: ProxyRun, proxy: ProxyName, input: unknown, toolUseId?: string): Promise<ProxyAnswer> {
    const handler = this.handlers.get(proxy);
    if (!handler) return { ok: false, text: `There is no ${proxy} proxy.` };
    const parsed = handler.schema.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The request does not fit the ${proxy} tool: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` };
    const request = parsed.data;
    let c: Classified;
    try {
      c = await handler.classify(request, run);
    } catch (error) {
      c = { tier: 3, kind: `${proxy}.unclassified`, summary: `${proxy} request`, reason: `It could not be classified: ${error instanceof Error ? error.message : String(error)}`, invalid: true };
    }
    const gate = await this.gate(run, proxy, c, { ...(toolUseId ? { toolUseId } : {}) });
    if (!gate.allowed) return { ok: false, text: gate.message, actionId: gate.actionId };
    const outcome = await this.perform(run, c, gate.actionId, () => handler.execute(request, c, run), { carried: carriedStrings(request), ...(handler.record ? { record: () => handler.record!(request, c, run) } : {}) });
    return { ok: outcome.ok, text: this.withNote(outcome, c, gate), actionId: gate.actionId };
  }

  /**
   * A request alex himself approved with a click (N1: "Mark ready for review" on the narrative, after he read it): it is
   * classified and logged like any other, and runs without asking, because the click is the answer.
   */
  async approvedRequest(run: ProxyRun, proxy: ProxyName, input: unknown, approvedBy: string): Promise<ProxyAnswer> {
    const handler = this.handlers.get(proxy);
    if (!handler) return { ok: false, text: `There is no ${proxy} proxy.` };
    const parsed = handler.schema.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The request does not fit the ${proxy} tool: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` };
    const request = parsed.data;
    let c: Classified;
    try {
      c = await handler.classify(request, run);
    } catch (error) {
      c = { tier: 3, kind: `${proxy}.unclassified`, summary: `${proxy} request`, reason: `It could not be classified: ${error instanceof Error ? error.message : String(error)}`, invalid: true };
    }
    const gate = await this.gate(run, proxy, c, { approvedBy });
    if (!gate.allowed) return { ok: false, text: gate.message, actionId: gate.actionId };
    const outcome = await this.perform(run, c, gate.actionId, () => handler.execute(request, c, run), { carried: carriedStrings(request), ...(handler.record ? { record: () => handler.record!(request, c, run) } : {}) });
    return { ok: outcome.ok, text: this.withNote(outcome, c, gate), actionId: gate.actionId };
  }

  /**
   * A read by Elfoqsy herself, in her own session: classified by the same handler, so the same per-environment tiers,
   * the same redaction and the same log as an agent's request, but only tier 0 runs. What an agent's tool would
   * record, ask or refuse is refused to her, and logged as refused: her session never asks alex and never
   * changes anything. An AWS session that has run out is said at once instead of waited for, so her turn does not hang.
   */
  async read(run: ProxyRun, proxy: ProxyName, input: unknown): Promise<ProxyAnswer> {
    if (!READ_PROXIES.includes(proxy)) return { ok: false, text: `${proxy} is not one of the tools Elfoqsy reads through: ${READ_PROXIES.join(', ')}.` };
    const handler = this.handlers.get(proxy);
    if (!handler) return { ok: false, text: `There is no ${proxy} proxy.` };
    const parsed = handler.schema.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The request does not fit the ${proxy} tool: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` };
    const request = parsed.data;
    let c: Classified;
    try {
      c = await handler.classify(request, run);
    } catch (error) {
      c = { tier: 3, kind: `${proxy}.unclassified`, summary: `${proxy} request`, reason: `It could not be classified: ${error instanceof Error ? error.message : String(error)}`, invalid: true };
    }
    const refuse = (reason: string): ProxyAnswer => {
      const actionId = ulid();
      this.deps.log.append('orchestrator', 'action.classified', {
        actionId,
        runId: run.runId,
        proxy,
        kind: c.kind,
        tier: c.tier,
        ...(c.environment ? { environment: c.environment } : {}),
        summary: redact(c.summary),
        decision: 'refuse',
        reason,
      });
      return { ok: false, text: `Refused: ${reason}`, actionId };
    };
    if (c.tier !== 0) {
      return refuse(c.invalid || c.tier === 3 ? c.reason : `only reads that run at once are Elfoqsy's own (tier 0), and this is tier ${c.tier}: ${c.reason}`);
    }
    // A read that follows or watches never ends and her turn is waited on: refused here, and logged like any refusal.
    const endless = neverEnds(proxy, (request as { args?: string[] }).args ?? []);
    if (endless) return refuse(endless);
    if (c.needsAws && this.deps.aws && !this.deps.aws.fresh(c.environment)) {
      return refuse(`alex's AWS session for ${c.environment} has run out, so ${c.environment} cannot be read now. Tell him to paste a fresh one into ~/.aws/credentials; do not retry before he has.`);
    }
    const gate = await this.gate(run, proxy, c);
    if (!gate.allowed) return { ok: false, text: gate.message, actionId: gate.actionId };
    const outcome = await this.perform(run, c, gate.actionId, () => handler.execute(request, c, run), { noWait: true, carried: carriedStrings(request) });
    return { ok: outcome.ok, text: this.withNote(outcome, c, gate), actionId: gate.actionId };
  }

  /**
   * The tier policy for one classified action: logs it, refuses tier 3 (and anything that could not be classified),
   * and for tier 2 uses a live grant or asks. It runs nothing itself.
   */
  async gate(
    run: ProxyRun,
    proxy: ProxyName,
    c: Classified,
    o: {
      toolUseId?: string;
      approvalKind?: 'action' | 'outside_worktree';
      /** Already approved by alex himself (his Undo), and why. */
      approvedBy?: string;
      /** Its delegation category when the caller knows it better (a file ask inside the run folder). */
      category?: DelegationCategory;
    } = {},
  ): Promise<GateResult> {
    const { toolUseId, approvalKind = 'action' } = o;
    const actionId = ulid();
    const classified = (decision: PayloadOf<'action.classified'>['decision'], extra: { grantId?: string; approvalId?: string; decisionId?: string } = {}) =>
      this.deps.log.append('orchestrator', 'action.classified', {
        actionId,
        runId: run.runId,
        ...(toolUseId ? { toolUseId } : {}),
        proxy,
        kind: c.kind,
        tier: c.tier,
        ...(c.environment ? { environment: c.environment } : {}),
        summary: redact(c.summary),
        decision,
        reason: c.reason,
        ...extra,
      });
    if (c.tier === 3) {
      classified('refuse');
      if (c.invalid) return { allowed: false, actionId, message: `Refused: ${c.reason}` };
      this.deps.say(run, tr(`${actorName(run)} tried \`${redact(c.summary).slice(0, 160)}\`. I refused it: ${toHim(c.reason)}`, `${actorName(run)} đã thử \`${redact(c.summary).slice(0, 160)}\`. Tôi đã từ chối, lý do (của quy tắc, bằng tiếng Anh): “${toHim(c.reason)}”`));
      return { allowed: false, actionId, message: `Refused: ${c.reason} It is alex's to do, and Elfoqsy has told him; if it is needed, say so in your summary.` };
    }
    if (c.tier < 2) {
      classified('run');
      return { allowed: true, actionId, how: 'tier' };
    }
    if (o.approvedBy) {
      this.deps.log.append('orchestrator', 'action.classified', {
        actionId,
        runId: run.runId,
        proxy,
        kind: c.kind,
        tier: c.tier,
        ...(c.environment ? { environment: c.environment } : {}),
        summary: redact(c.summary),
        decision: 'run',
        reason: o.approvedBy,
      });
      return { allowed: true, actionId, how: 'tier' };
    }
    // Marking ready for review (N1) is never covered by a grant: each one waits for him to have read the narrative.
    const gate = c.kind === 'gh.pr.ready' ? ('narrative' as const) : undefined;
    const grant = gate ? undefined : this.deps.grants.find(run.ticket, c.kind, c.environment);
    if (grant) {
      classified('grant', { grantId: grant.grantId });
      return { allowed: true, actionId, how: 'grant' };
    }
    const approvalId = ulid();
    const question = `${run.actor === 'elfoqsy' ? 'Elfoqsy' : `${actorName(run)} on ${run.label ?? run.ticket}`} wants to ${wants(redact(c.summary))}. ${c.reason}${c.warning ? ` ${c.warning}` : ''}`;
    const grantable = gate ? undefined : { kind: c.kind, ...(c.environment ? { environment: c.environment } : {}) };
    // Elfoqsy first: what he delegated she decides at once; the rest goes to him with her suggestion.
    const responder = this.deps.firstResponder?.();
    const ask = { runId: run.runId, ticket: run.ticket, actionId, approvalId, approvalKind, category: o.category ?? actionCategory(proxy, c), question, action: redact(c.summary), reason: c.reason, kind: c.kind, ...(grantable ? { grantable } : {}), ...(gate ? { gate } : {}) };
    const decided = responder?.decideNow(ask);
    if (decided) {
      classified('elfoqsy', { decisionId: decided.decisionId });
      return { allowed: true, actionId, how: 'elfoqsy', decisionId: decided.decisionId };
    }
    classified('ask', { approvalId });
    const wait = <T>(p: Promise<T>): Promise<T> => (run.asking ? run.asking(p) : p);
    const answer = responder
      ? await responder.escalate(ask, wait)
      : await wait(this.deps.approvals.request({ approvalId, runId: run.runId, ticket: run.ticket, kind: approvalKind, question, action: redact(c.summary), tier: 2, ...(grantable ? { grantable } : {}), ...(gate ? { gate } : {}) }));
    if (answer.decision !== 'approved') {
      const message = unanswered(answer)
        ? `Not run, and nobody answered: ${c.summary}. ${answer.answer}`
        : `${answeredBy(answer)} declined: ${c.summary}.${answer.answer ? ` (${answer.answer})` : ''}`;
      this.deps.log.append('orchestrator', 'action.finished', { actionId, runId: run.runId, ok: false, outputSummary: message });
      return { allowed: false, actionId, message };
    }
    // "Allow for this ticket" counts only from alex; the tester's approval covers this one request.
    if (answer.scope === 'ticket' && !answer.test && !gate) {
      this.deps.grants.create({ ticket: run.ticket, runId: run.runId, kind: c.kind, ...(c.environment ? { environment: c.environment } : {}), by: 'you', approvalId });
    }
    return { allowed: true, actionId, how: 'approval', resolution: answer };
  }

  /**
   * Runs an allowed action: waits for a fresh AWS session if it needs one, records what a write will change, runs it,
   * logs how it ended, and for tier 1 posts Elfoqsy's line. A call cut short by an expired session waits and runs again.
   */
  async perform(
    run: ProxyRun,
    c: Classified,
    actionId: string,
    execute: () => Promise<Outcome>,
    o: {
      record?: () => Promise<Recorded | null>;
      /** No line from Elfoqsy: the caller says what happened. */
      quiet?: boolean;
      /** An AWS session that has run out is reported at once, not waited for (Elfoqsy's own reads: her turn is waited on). */
      noWait?: boolean;
      /** Every string the request carried: an error that repeats one of them is no proof that the session ran out. */
      carried?: readonly string[];
    } = {},
  ): Promise<Outcome> {
    const { record } = o;
    const started = this.now();
    let recordId: string | undefined;
    // The one exit of every action: whatever a proxy let through is redacted here again (a pre-signed URL's signature, a token),
    // so neither the model that reads the answer nor the log ever holds it. The proxies redact their own output; this is the
    // guarantee that does not depend on one of them remembering to. Redacting twice changes nothing.
    const finished = (o: Outcome): Outcome => {
      const safe: Outcome = { ...o, output: redact(o.output), ...(o.done !== undefined ? { done: redact(o.done) } : {}), ...(o.doneVi !== undefined ? { doneVi: redact(o.doneVi) } : {}) };
      this.deps.log.append('orchestrator', 'action.finished', {
        actionId,
        runId: run.runId,
        ok: safe.ok,
        outputSummary: firstLines(safe.output),
        durationMs: Math.max(0, this.now() - started),
        ...(safe.notSent ? { notSent: true as const } : {}),
      });
      return safe;
    };
    // A tester's run: every write (tier 1, or tier 2 once approved) is logged as it would be and not sent. Tier 1 is
    // proven live with alex's own runs.
    if (run.test && c.tier >= 1) {
      if (!o.quiet) this.deps.say(run, tr(`${actorName(run)} would have run \`${redact(c.summary).slice(0, 160)}\` (a tester's run: logged, not sent).`, `${actorName(run)} sẽ chạy \`${redact(c.summary).slice(0, 160)}\` (lượt chạy của người test: chỉ ghi lại, không gửi đi).`));
      return finished({ ok: true, notSent: true, output: `Not sent: this is a tester's run, where writes are logged as they would be and not sent. Nothing reached ${c.environment ?? 'the service'}; carry on as if it was done.` });
    }
    if (!o.noWait) await this.awsReady(run, c);
    if (record && c.tier > 0) {
      let recorded: Recorded | null;
      try {
        recorded = await this.retryOnExpiry(run, c, record, o.carried);
      } catch (error) {
        return finished({ ok: false, output: `Nothing was changed: the earlier state could not be recorded first (${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}).` });
      }
      if (recorded) {
        recordId = ulid();
        this.deps.log.append('orchestrator', 'change.recorded', {
          recordId,
          actionId,
          runId: run.runId,
          ...(c.environment ? { environment: c.environment } : {}),
          target: redact(recorded.target),
          before: redact(recorded.before).slice(0, 2000),
          ...(recorded.undo ? { undo: recorded.undo } : {}),
          ...(recorded.noUndo ? { noUndo: recorded.noUndo } : {}),
        });
      }
    }
    let outcome = await execute().catch((error: unknown): Outcome => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
    // The session is marked expired only when this call itself failed with AWS saying so, and the request carried no text
    // that says so too: an error repeats what it was given (an instance id written "ExpiredToken"), and that is not AWS.
    if (!outcome.ok && c.needsAws && this.deps.aws && sessionRanOut(outcome.output, o.carried)) {
      this.deps.aws.markExpired(c.environment);
      if (o.noWait) {
        // Said at once, not waited for: her turn is waited on.
        outcome = { ok: false, output: `${outcome.output}\n\nAWS's answer says the session for ${c.environment} has run out. Tell alex to paste a fresh one into ~/.aws/credentials; do not retry before he has.` };
      } else {
        await this.awsReady(run, c);
        outcome = await execute().catch((error: unknown): Outcome => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
      }
    }
    outcome = finished(outcome);
    if (c.target) this.deps.afterWrite?.({ run, target: c.target, actionId, ok: outcome.ok, ...(recordId ? { recordId } : {}), output: outcome.output });
    if (outcome.ok && c.tier === 1 && outcome.done && !o.quiet) this.deps.say(run, tr(`${actorName(run)} ${redact(outcome.done)}.`, `${actorName(run)} ${redact(outcome.doneVi ?? outcome.done)}.`));
    return outcome;
  }

  private async awsReady(run: ProxyRun, c: Classified): Promise<void> {
    const aws = this.deps.aws;
    if (!c.needsAws || !aws || aws.fresh(c.environment)) return;
    const wait = `Waiting for alex to refresh the AWS session for ${c.environment}.`;
    await (run.hold ? run.hold(wait, aws.whenFresh(c.environment)) : aws.whenFresh(c.environment));
  }

  private async retryOnExpiry<T>(run: ProxyRun, c: Classified, fn: () => Promise<T>, carried: readonly string[] = []): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (!c.needsAws || !this.deps.aws || !sessionRanOut(error instanceof Error ? error.message : String(error), carried)) throw error;
      this.deps.aws.markExpired(c.environment);
      await this.awsReady(run, c);
      return fn();
    }
  }

  private withNote(outcome: Outcome, c: Classified, gate: Extract<GateResult, { allowed: true }>): string {
    const out = outcome.output || (outcome.ok ? 'Done.' : 'It failed.');
    if (!outcome.ok) return out;
    if (gate.how === 'grant') return `${out}\n\n(Allowed by alex's grant for this kind of action on ${c.environment ? `${c.environment} for ` : ''}this ticket.)`;
    if (gate.how === 'elfoqsy') return `${out}\n\n(Elfoqsy decided it for alex, as he delegated this kind of request to her.)`;
    if (gate.how === 'approval') {
      const r = gate.resolution!;
      return `${out}\n\n(${answeredBy(r)} approved it${r.scope === 'ticket' && !r.test ? ', and allowed this kind of action for the rest of this ticket' : ''}.)`;
    }
    return c.tier === 1 ? `${out}\n\n(Done at once; Elfoqsy told alex.)` : out;
  }

  /**
   * Undo from a pane: the recorded request goes through the same proxy and tier rules. alex's own click is the
   * approval a tier-2 undo needs; the tester's is not, so it is asked. Tier 3 is refused like any other.
   */
  async undo(recordId: string, by: Actor): Promise<{ ok: true } | { error: string; message: string }> {
    const entry = this.records.get(recordId);
    if (!entry) return { error: 'unknown_record', message: 'There is no such change to undo.' };
    if (entry.undone) return { error: 'already_undone', message: 'That change is already undone.' };
    const { record } = entry;
    if (!record.undo) return { error: 'no_undo', message: record.noUndo ?? 'That change cannot be undone here.' };
    const handler = this.handlers.get(record.undo.proxy);
    if (!handler) return { error: 'no_proxy', message: `There is no ${record.undo.proxy} proxy.` };
    const parsed = handler.schema.safeParse(record.undo.request);
    if (!parsed.success) return { error: 'bad_record', message: 'The recorded undo could not be read.' };
    let run: ProxyRun | undefined = this.runs.get(record.runId);
    let dispose: (() => void) | undefined;
    if (!run) {
      const key = (record.undo.request as { key?: unknown }).key;
      const ended = await this.deps.endedRun?.(record.runId, typeof key === 'string' ? key : undefined);
      if (!ended) return { error: 'unknown_run', message: 'The run that made that change cannot be found.' };
      run = ended.run;
      dispose = ended.dispose;
    }
    entry.undone = true; // one undo at a time
    try {
      const request = parsed.data;
      const c = await handler.classify(request, run);
      const gate = await this.gate(run, record.undo.proxy, c, by === 'you' ? { approvedBy: `Undo of ${record.target}, asked by alex from the pane.` } : {});
      if (!gate.allowed) {
        entry.undone = false;
        return { error: 'refused', message: gate.message };
      }
      const target = run;
      const outcome = await this.perform(target, c, gate.actionId, () => handler.execute(request, c, target), { quiet: true, carried: carriedStrings(request), ...(handler.record ? { record: () => handler.record!(request, c, target) } : {}) });
      if (!outcome.ok) {
        entry.undone = false;
        this.deps.say(run, tr(`The undo of ${record.target} failed: ${firstLines(redact(outcome.output), 2, 300)}`, `Không hoàn tác được ${record.target}: ${firstLines(redact(outcome.output), 2, 300)}`));
        return { error: 'failed', message: outcome.output };
      }
      this.deps.log.append('orchestrator', 'change.undone', { recordId, actionId: gate.actionId, by });
      this.deps.say(run, tr(`Undone, as ${by === 'tester' ? 'the tester' : 'you'} asked: ${lowerFirst(record.undo.summary)}.`, `Đã hoàn tác theo yêu cầu của ${by === 'tester' ? 'người test' : 'cậu'}: “${lowerFirst(record.undo.summary)}”.`));
      return { ok: true };
    } finally {
      dispose?.();
    }
  }

  close(): void {
    this.unsubscribe();
  }
}

/** What the agent wants, for the question: a command is shown under it as it is, anything else is said as a phrase. */
const wants = (summary: string): string => (/^(gh|kubectl|aws|git) /.test(summary) ? 'run the command below' : lowerFirst(summary));

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
