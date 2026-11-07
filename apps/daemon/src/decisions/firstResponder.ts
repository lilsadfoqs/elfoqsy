// Elfoqsy is the first responder: every agent question and every tier-2 request reaches her first.
// - A tier-2 request in a category he delegated is decided at once in her name, with no model call: the delegation
//   setting (or his precedent) is what it rests on. "Decide and tell me" also posts her line.
// - A question goes to her responder session: she answers it only from sources she cites, where he lets her, or
//   escalates it with her recommendation.
// - Everything else is escalated: the structured card goes to him with her suggestion, and his answer is the agent's.
// Every decision she makes is a decision.made event with what it rests on. His "Let Elfoqsy decide this kind next time"
// is stored as a precedent; his changes to her answers and undos of her decisions are counted for Insights.
import type { AnyEnvelope, DelegationCategory, MessageBlock, QuestionCard, SourceRef } from '@elfoqsy/contracts';
import { isRunActive, runLabel, sameOption, type WorkspaceState } from '@elfoqsy/state';
import { CLOSED_ANSWERS, unanswered, type Approvals, type Resolution } from '../agents/approvals';
import type { EventLog } from '../eventLog';
import { redact } from '../redact';
import { ulid } from '../ulid';
import { langField, tr } from '../elfoqsy/voice';
import { categoryWords, effectiveSetting, NO_PRECEDENT, ticketTypeOf } from './categories';
import type { Responder, ResponderOutcome } from './responder';

export interface FirstResponderDeps {
  log: EventLog;
  state: () => WorkspaceState;
  approvals: Approvals;
  /** Her responder session; absent (simulate mode, some tests) everything she cannot decide by setting goes to him. */
  responder?: Responder;
  /** Her one line in the run's conversation, from the orchestrator (no Claude turn). */
  say: (runId: string, text: string, blocks?: MessageBlock[], ticket?: string) => void;
  /** The agent is told when he changes her answer. */
  tell?: (runId: string, text: string, from: 'alex' | 'tester') => void;
}

/** Wraps the wait for alex's answer (the run's waitForHim). */
export type Wait = <T>(answer: Promise<T>) => Promise<T>;

/** How an agent's question ended: her answer, or his (or the tester's), or nobody's. */
export interface QuestionOutcome {
  resolution: Resolution;
  /** Her decision, when she answered it. */
  decision?: { decisionId: string; option: string; note?: string; sources: SourceRef[] };
}

/** A tier-2 request, as the proxies hand it over once no grant covers it. */
export interface ActionAsk {
  runId: string;
  ticket: string;
  actionId: string;
  approvalId: string;
  approvalKind: 'action' | 'outside_worktree';
  category: DelegationCategory;
  /** The question as he would be asked it, and the action in short. */
  question: string;
  action: string;
  reason: string;
  /** The action's kind ("jira.comment"): a precedent counts for its own kind only. */
  kind: string;
  grantable?: { kind: string; environment?: string };
  /** Marking ready for review (N1): never decided for him, and no precedent: he reads the narrative first. */
  gate?: 'narrative';
}


const sourceWords = (sources: SourceRef[]): string =>
  sources
    .map((s) =>
      s.label
        ? `${s.label} (${s.ref})`
        : s.kind === 'setting'
          ? tr(`your setting for ${categoryWords(s.ref as DelegationCategory)}`, `cài đặt của cậu cho ${categoryWords(s.ref as DelegationCategory)}`)
          : s.kind === 'precedent'
            ? tr('your precedent', 'tiền lệ của cậu')
            : `${s.kind} ${s.ref}`,
    )
    .join(', ');

/** The stand-in run under which Elfoqsy's own Jira edits go through the proxies. */
export const ELFOQSY_RUN = 'elfoqsy';

export class FirstResponder {
  private readonly unsubscribe: () => void;
  /** Recorded changes by recordId: the action each one belongs to, so an undo can be matched to her decision. */
  private readonly recordActions = new Map<string, string>();

  constructor(private readonly d: FirstResponderDeps) {
    for (const e of d.log.readFrom(0, 1_000_000, ['change.recorded'])) this.track(e);
    this.unsubscribe = d.log.subscribe((e) => this.track(e));
  }

  close(): void {
    this.unsubscribe();
  }

  private track(e: AnyEnvelope): void {
    if (e.type === 'change.recorded') this.recordActions.set(e.payload.recordId, e.payload.actionId);
    else if (e.type === 'change.undone' && (e.payload.by === 'you' || e.payload.by === 'tester')) {
      // He undid what one of her decisions let run: that counts as changing it.
      const actionId = this.recordActions.get(e.payload.recordId);
      const decision = actionId ? Object.values(this.d.state().decisions).find((x) => x.actionId === actionId) : undefined;
      if (decision && !decision.changed) this.d.log.append('orchestrator', 'decision.changed', { decisionId: decision.decisionId, by: e.payload.by, how: 'undone' });
    }
  }

  /**
   * Whether the run is still at work. A request is closed unanswered when its run was at work as it asked and ended
   * while she looked into it (up to 5 minutes); a close-out's request for an ended run goes on as asked.
   */
  private live(runId: string): boolean {
    const run = this.d.state().runs[runId];
    return !!run && run.state !== 'failed' && isRunActive(run);
  }

  /** Who an agent is, as her line says it; the card's own text is interface wording and stays English (`lang: 'en'`). */
  private who(runId: string, lang: 'en' | 'auto' = 'auto'): string {
    if (runId === ELFOQSY_RUN) return 'Elfoqsy';
    const run = this.d.state().runs[runId];
    const say = (en: string, vi: string): string => (lang === 'en' ? en : tr(en, vi));
    return run ? say(`Agent ${run.agentNumber} on ${runLabel(run)}`, `Agent ${run.agentNumber} trên ${runLabel(run)}`) : say('An agent', 'Một agent');
  }

  /**
   * An agent's question: her answer from sources she cites, or his answer to the card she escalated. wait wraps the wait
   * for his answer only (the run shows it is waiting for him, and withdraws it after 72 hours).
   */
  async question(runId: string, card: QuestionCard, wait: Wait = (p) => p): Promise<QuestionOutcome> {
    const s = this.d.state();
    const requestId = `req-${ulid().toLowerCase()}`;
    const answerSetting = effectiveSetting(s, 'sourced_answer', runId).setting;
    const mayAnswer = answerSetting !== 'ask';
    const wasLive = this.live(runId);
    this.d.log.append('orchestrator', 'decision.considering', { requestId, runId, requestKind: 'question', summary: redact(card.question) });
    const outcome: ResponderOutcome = this.d.responder
      ? await this.d.responder.consider({ requestId, runId, kind: 'question', card, mayAnswer })
      : { kind: 'none', reason: 'Elfoqsy cannot look into questions here.' };
    // Ended meanwhile: nobody is waiting, so neither her answer nor a card for him.
    if (wasLive && !this.live(runId)) return { resolution: { decision: 'denied', answer: CLOSED_ANSWERS.runEnded } };
    if (outcome.kind === 'answer' && mayAnswer) {
      const decisionId = `dec-${ulid().toLowerCase()}`;
      const told = answerSetting === 'decide_and_tell';
      const basis = outcome.sources.some((x) => x.kind === 'precedent') ? 'precedent' : 'sources';
      const answer = `${outcome.option}${outcome.note ? `: ${outcome.note}` : ''}`;
      this.d.log.append('orchestrator', 'decision.made', {
        decisionId,
        requestId,
        runId,
        requestKind: 'question',
        category: 'sourced_answer',
        summary: redact(tr(`Answered "${card.question}": ${outcome.option}`, `Đã trả lời "${card.question}": ${outcome.option}`)).slice(0, 300),
        question: redact(card.question),
        options: card.options.map((o) => o.label),
        answer: redact(answer),
        sources: outcome.sources,
        basis,
        told,
        ...langField(),
      });
      if (told) {
        this.d.say(
          runId,
          tr(`I answered ${this.who(runId)}: ${redact(answer)}. From ${sourceWords(outcome.sources)}.`, `Tôi đã trả lời ${this.who(runId)}: ${redact(answer)}. Dựa vào ${sourceWords(outcome.sources)}.`),
          [{ type: 'decision', ref: decisionId }],
        );
      }
      return { resolution: { decision: 'answered', answer }, decision: { decisionId, option: outcome.option, ...(outcome.note ? { note: outcome.note } : {}), sources: outcome.sources } };
    }
    // His: the card with her suggestion, or why she has none.
    const category: DelegationCategory = outcome.kind === 'escalate' && outcome.sources.length && !mayAnswer ? 'sourced_answer' : 'unsourced';
    const approvalId = ulid();
    const resolution = await wait(this.d.approvals.request({
      approvalId,
      runId,
      ticket: s.runs[runId]?.ticket ?? '',
      kind: 'question',
      question: `${this.who(runId, 'en')} asks: ${card.question}`,
      card,
      category,
      requestId,
      precedentable: true,
      ...(outcome.kind === 'escalate' ? { suggestion: { option: outcome.option, why: redact(outcome.why), sources: outcome.sources } } : {}),
      ...(outcome.kind === 'none' ? { noSuggestion: outcome.reason } : {}),
    }));
    this.maybePrecedent(runId, approvalId, category, 'question', card.question, resolution);
    return { resolution };
  }

  /**
   * A tier-2 request no grant covers, decided at once in her name when he delegated its category (or let her decide
   * this kind on this ticket type): the decision, or null when it is his.
   */
  decideNow(a: ActionAsk): { decisionId: string } | null {
    if (a.gate) return null;
    const { setting, precedentId } = effectiveSetting(this.d.state(), a.category, a.runId, a.kind);
    if (setting === 'ask') return null;
    const decisionId = `dec-${ulid().toLowerCase()}`;
    const told = setting === 'decide_and_tell';
    const sources: SourceRef[] = precedentId ? [{ kind: 'precedent', ref: precedentId, label: 'your precedent' }] : [{ kind: 'setting', ref: a.category }];
    this.d.log.append('orchestrator', 'decision.made', {
      decisionId,
      requestId: `req-${ulid().toLowerCase()}`,
      runId: a.runId,
      requestKind: 'action',
      category: a.category,
      summary: redact(
        a.runId === ELFOQSY_RUN
          ? tr(a.action, `Tôi đã làm: “${a.action}”`)
          : tr(`Let ${this.who(a.runId)} ${lowerFirst(a.action)}`, `Cho ${this.who(a.runId)} làm: “${a.action}”`),
      ).slice(0, 300),
      answer: 'approved',
      sources,
      basis: precedentId ? 'precedent' : 'delegation',
      told,
      actionId: a.actionId,
      ...langField(),
    });
    if (told) {
      // The action is written in English where the proxy made it, so in Vietnamese it is quoted, not translated.
      const action = redact(a.action);
      const did = tr(
        a.runId === ELFOQSY_RUN ? `I ${lowerFirst(action)}` : `I let ${this.who(a.runId)} ${lowerFirst(action)}`,
        a.runId === ELFOQSY_RUN ? `Tôi đã làm: “${action}”` : `Tôi đã cho ${this.who(a.runId)} làm: “${action}”`,
      );
      const because = precedentId
        ? tr('you let me decide this kind', 'cậu để tôi quyết loại này')
        : tr(`you delegated ${categoryWords(a.category)} to me`, `cậu đã giao ${categoryWords(a.category)} cho tôi`);
      this.d.say(a.runId, `${did}: ${because}.`, [{ type: 'decision', ref: decisionId }], a.ticket);
    }
    return { decisionId };
  }

  /** A tier-2 request that is his: she looks into it and the card goes to him with her suggestion. wait as for questions. */
  async escalate(a: ActionAsk, wait: Wait = (p) => p): Promise<Resolution> {
    const requestId = `req-${ulid().toLowerCase()}`;
    const wasLive = this.live(a.runId);
    this.d.log.append('orchestrator', 'decision.considering', { requestId, runId: a.runId, requestKind: 'action', summary: redact(a.action).slice(0, 300) });
    // Her own request needs no second opinion of hers: it goes to him as asked.
    const outcome: ResponderOutcome =
      this.d.responder && a.runId !== ELFOQSY_RUN
        ? await this.d.responder.consider({ requestId, runId: a.runId, kind: 'action', action: { summary: a.action, reason: a.reason, category: a.category }, mayAnswer: false })
        : { kind: 'none', reason: '' };
    if (wasLive && !this.live(a.runId)) return { decision: 'denied', answer: CLOSED_ANSWERS.runEnded };
    const resolution = await wait(this.d.approvals.request({
      approvalId: a.approvalId,
      runId: a.runId,
      ticket: a.ticket,
      kind: a.approvalKind,
      question: a.question,
      action: a.action,
      tier: 2,
      category: a.category,
      requestId,
      ...(a.grantable ? { grantable: a.grantable } : {}),
      ...(NO_PRECEDENT.has(a.category) || a.gate ? {} : { precedentable: true as const }),
      ...(a.gate ? { gate: a.gate } : {}),
      ...(outcome.kind === 'escalate' ? { suggestion: { option: outcome.option, why: redact(outcome.why), sources: outcome.sources } } : {}),
      ...(outcome.kind === 'none' && outcome.reason ? { noSuggestion: outcome.reason } : {}),
    }));
    if (resolution.decision === 'approved') this.maybePrecedent(a.runId, a.approvalId, a.category, 'action', a.action, resolution, a.kind);
    return resolution;
  }

  /** "Let Elfoqsy decide this kind next time": stored for its category and the run's ticket type, his ticks only. */
  private maybePrecedent(runId: string, approvalId: string, category: DelegationCategory, requestKind: 'question' | 'action', question: string, r: Resolution, kind?: string): void {
    if (!r.precedent || r.test || r.withdrawn || unanswered(r) || NO_PRECEDENT.has(category)) return;
    this.d.log.append('orchestrator', 'precedent.saved', {
      precedentId: `prec-${ulid().toLowerCase()}`,
      category,
      ticketType: ticketTypeOf(this.d.state(), runId),
      approvalId,
      requestKind,
      question: redact(question).slice(0, 300),
      answer: redact(r.answer ?? r.decision).slice(0, 300),
      ...(kind ? { kind } : {}),
      by: 'you',
    });
  }

  /**
   * He (or the tester) picked another option for one of her answers: recorded, counted, and the agent told so it can
   * re-plan. Returns why not, when it cannot be changed.
   */
  change(decisionId: string, to: string, by: 'you' | 'tester'): { ok: true } | { error: string; message: string } {
    const decision = this.d.state().decisions[decisionId];
    if (!decision) return { error: 'unknown_decision', message: 'There is no such decision.' };
    if (decision.requestKind !== 'question') return { error: 'not_a_question', message: 'Only an answer can be changed; undo an action from its change.' };
    const option = decision.options?.find((o) => o.toLowerCase() === to.trim().toLowerCase()) ?? to.trim();
    if (decision.options?.length && !decision.options.includes(option)) return { error: 'unknown_option', message: `Pick one of: ${decision.options.join(', ')}.` };
    const current = decision.changed?.to ?? decision.answer;
    if (sameOption(current, option)) return { error: 'unchanged', message: 'That is already the answer.' };
    this.d.log.append('orchestrator', 'decision.changed', { decisionId, by, how: 'changed', to: option });
    const from = by === 'tester' ? 'tester' : 'alex';
    this.d.tell?.(
      decision.runId,
      `${from === 'tester' ? 'The tester' : 'alex'} changed Elfoqsy's answer to your question "${decision.question ?? decision.summary}": it is now "${option}", not "${current}". If that changes your work, begin a new step and say so.`,
      from,
    );
    return { ok: true };
  }
}

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
