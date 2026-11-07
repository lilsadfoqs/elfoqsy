// What Elfoqsy decided for alex as first responder : one decision as a row (a check, what
// she decided, its ticket and what it rests on, and View, Undo or Change), the digest of what she decided while he was
// away, and a task agent's result. Status is an icon, never a stripe.
import { useState } from 'react';
import type { SourceRef } from '@elfoqsy/contracts';
import { runLabel, sameOption, type DecisionView, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { CodeBlock, Markdown } from '../../ui/Markdown';
import { sourceText } from '../../ui/QuestionCard';

/** The language her wording was written in: Vietnamese when his latest message was, as the event says; English otherwise. Buttons stay as they are. */
type Lang = 'vi' | undefined;
const pick = (lang: Lang, en: string, vi: string): string => (lang === 'vi' ? vi : en);

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** A time as the digest says it: 09:12 today, "12 Oct, 09:12" another day ("12 thg 10, 09:12" in Vietnamese). */
const since = (ms: number, now: number, lang?: Lang): string => {
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return hhmm(ms);
  const d = new Date(ms);
  return lang === 'vi' ? `${d.getDate()} thg ${d.getMonth() + 1}, ${hhmm(ms)}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hhmm(ms)}`;
};

/** A delegated category as the digest says it. */
const DELEGATED: Record<DecisionView['category'], string> = {
  run_folder: 'inside the run folder',
  sourced_answer: 'answered from its sources',
  ci_rerun: 'rerunning CI is delegated',
  harness_kube: 'the test harness is delegated',
  harness_image: "the harness image is delegated",
  unsourced: 'you let me decide these',
  notify_people: 'you let me decide these',
  staging_write: 'staging writes are delegated',
  read_secret: 'reading secrets is delegated',
  prod_logs: 'prod logs are delegated',
  irreversible: 'you let me decide these',
  jira_fill: 'filling empty fields of your tickets is delegated',
  other: 'you let me decide these',
};

/** The same, in Vietnamese. */
const DELEGATED_VI: Record<DecisionView['category'], string> = {
  run_folder: 'trong thư mục của lượt chạy',
  sourced_answer: 'trả lời từ nguồn',
  ci_rerun: 'chạy lại CI đã được giao',
  harness_kube: 'test harness đã được giao',
  harness_image: 'image của harness đã được giao',
  unsourced: 'cậu để tôi quyết những việc này',
  notify_people: 'cậu để tôi quyết những việc này',
  staging_write: 'ghi vào staging đã được giao',
  read_secret: 'đọc secret đã được giao',
  prod_logs: 'log prod đã được giao',
  irreversible: 'cậu để tôi quyết những việc này',
  jira_fill: 'điền các trường trống của ticket của cậu đã được giao',
  other: 'cậu để tôi quyết những việc này',
};

/** A source as her line says it, in her language: the label she gave it, else what it is. */
const sourceIn = (lang: Lang, s: SourceRef): string =>
  lang === 'vi' && !s.label && s.kind === 'setting' ? `cài đặt của cậu cho ${s.ref.replace(/_/g, ' ')}` : sourceText(s);

/** What a decision rests on, as the digest says it: the source's own label where it has one. */
export function basisText(d: DecisionView): string {
  if (d.basis === 'precedent') return d.sources.find((x) => x.label)?.label ?? pick(d.lang, 'your precedent for this kind', 'tiền lệ của cậu cho loại này');
  if (d.basis === 'delegation') return (d.lang === 'vi' ? DELEGATED_VI : DELEGATED)[d.category];
  return d.sources.map((x) => sourceIn(d.lang, x)).join(', ');
}

/** The change an action decision let run, if it can be undone. */
const changeOf = (state: WorkspaceState, d: DecisionView) => (d.actionId ? Object.values(state.changes).find((c) => c.actionId === d.actionId) : undefined);

/** Whether a decision can be put back: an answer can be changed, an action undone when its change was recorded. */
export function reversible(state: WorkspaceState, d: DecisionView): boolean {
  if (d.requestKind === 'question') return true;
  const c = changeOf(state, d);
  return !!c?.undo && !c.undone;
}

export function DecisionRow({ state, decision: d }: { state: WorkspaceState; decision: DecisionView }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const run = state.runs[d.runId];
  const change = changeOf(state, d);
  const current = d.changed?.to ?? d.answer;
  const others = (d.options ?? []).filter((o) => !sameOption(current, o));
  const undone = d.changed?.how === 'undone' || !!change?.undone;
  let action;
  if (d.requestKind === 'question' && others.length) {
    action = (
      <button type="button" className="button-outline button-outline--small" aria-expanded={changing} onClick={() => setChanging(!changing)}>
        Change
      </button>
    );
  } else if (change?.undo && !undone) {
    action = (
      <button type="button" className="button-outline button-outline--small" data-tip={change.undo} onClick={() => stream.undo(change.recordId)}>
        Undo
      </button>
    );
  } else {
    action = (
      <button type="button" className="button-outline button-outline--small" aria-expanded={open} onClick={() => setOpen(!open)}>
        View
      </button>
    );
  }
  return (
    <li className="decision-row">
      <svg className="decision-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={undone ? 'undone' : 'decided'}>
        {undone ? <path d="M6 12h12" /> : <path d="m5 12 4.5 4.5L19 7" />}
      </svg>
      <span className="decision-text">
        <span className="decision-summary">{d.summary}</span>
        <span className="decision-meta">
          {run ? runLabel(run) : d.runId} · {basisText(d)}
          {d.changed ? ` · ${d.changed.how === 'undone' ? pick(d.lang, 'undone', 'đã hoàn tác') : pick(d.lang, `you changed it to “${d.changed.to}”`, `cậu đã đổi thành “${d.changed.to}”`)}` : ''}
        </span>
        {open && (
          <span className="decision-detail">
            {d.question ? `${d.question} ` : ''}
            {hhmm(d.at)}
            {d.sources.length ? `; ${d.sources.map((x) => sourceIn(d.lang, x)).join('; ')}` : ''}
          </span>
        )}
        {changing && (
          <span className="decision-options">
            {others.map((o) => (
              <button
                key={o}
                type="button"
                className="button-outline button-outline--small"
                onClick={() => {
                  if (stream.changeDecision(d.decisionId, o)) setChanging(false);
                }}
              >
                {o}
              </button>
            ))}
          </span>
        )}
      </span>
      {action}
    </li>
  );
}

/** "I decided N things while you were away". */
export function DigestBlock({ state, digestId }: { state: WorkspaceState; digestId: string }) {
  const g = state.digests[digestId];
  if (!g) return <div className="block block--missing">That digest is not in the workspace any more.</div>;
  const decisions = g.decisionIds.map((id) => state.decisions[id]).filter((d): d is DecisionView => !!d);
  const all = decisions.every((d) => reversible(state, d));
  return (
    <div className="block digest">
      <div className="digest-head">
        <b>
          {g.lang === 'vi'
            ? `Tôi đã quyết ${decisions.length} việc ${g.asked ? `từ ${since(g.awaySince, g.at, 'vi')}` : 'trong lúc cậu vắng mặt'}`
            : `I decided ${decisions.length} thing${decisions.length === 1 ? '' : 's'} ${g.asked ? `since ${since(g.awaySince, g.at)}` : 'while you were away'}`}
        </b>
        {all && <span className="digest-note">{pick(g.lang, 'all reversible', 'tất cả đều hoàn tác được')}</span>}
        {g.test && <span className="digest-note">{pick(g.lang, 'opened by the tester', 'do người test mở')}</span>}
      </div>
      <ul className="decision-list">
        {decisions.map((d) => (
          <DecisionRow key={d.decisionId} state={state} decision={d} />
        ))}
      </ul>
    </div>
  );
}

/** One decision, posted with her line when he asked to be told. */
export function DecisionBlock({ state, decisionId }: { state: WorkspaceState; decisionId: string }) {
  const d = state.decisions[decisionId];
  if (!d) return <div className="block block--missing">That decision is not in the workspace any more.</div>;
  return (
    <div className="block digest">
      <ul className="decision-list">
        <DecisionRow state={state} decision={d} />
      </ul>
    </div>
  );
}

/** A task agent's result: a document, a table or code, with Copy. */
export function DeliverableBlock({ state, deliverableId }: { state: WorkspaceState; deliverableId: string }) {
  const [copied, setCopied] = useState(false);
  const d = state.deliverables[deliverableId];
  if (!d) return <div className="block block--missing">That result is not in the workspace any more.</div>;
  const run = state.runs[d.runId];
  const copy = () => {
    void navigator.clipboard?.writeText(d.content).then(() => setCopied(true));
  };
  return (
    <div className="block deliverable">
      <div className="deliverable-head">
        <b>{d.title}</b>
        <span className="deliverable-meta">
          {run ? `Agent ${run.agentNumber}, ${runLabel(run)}` : ''} · {d.kind}
        </span>
        {d.kind !== 'code' && (
          <button type="button" className="button-outline button-outline--small" onClick={copy}>
            {copied ? 'Copied' : 'Copy as Markdown'}
          </button>
        )}
      </div>
      {d.kind === 'code' ? <CodeBlock code={d.content} info={d.language ? { language: d.language } : {}} /> : <Markdown text={d.content} className="deliverable-body" />}
    </div>
  );
}
