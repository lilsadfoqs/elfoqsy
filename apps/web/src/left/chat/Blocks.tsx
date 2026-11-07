// Her messages are short text plus typed blocks that name data by id; each block is filled from the state,
// so it can never show a wrong number. Reading text stays monochrome; colour is on dots, badges and bars.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageBlock, SourceRef } from '@elfoqsy/contracts';
import { agentLabel, carriedOver, CARRIED_OVER_WARNING, durationLabel, isOpen, modelLabel, runLabel, storyPoints, verdictWords } from '@elfoqsy/state';
import type { ApprovalView, RunView, WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { CodeBlock, inline, type CodeInfo } from '../../ui/Markdown';
import { AgentBadge, PointsChip, PriorityChip, StatusChip, TicketChip, TypeIcon } from '../../ui/TicketBits';
import { agentOn, hhmm, pointsLeft } from '../model';
import { PointsBar } from '../sprint/SprintColumn';
import { ReviewBlock } from './ReviewBlock';
import { DecisionBlock, DeliverableBlock, DigestBlock } from './DecisionBlocks';
import { DraftBlock, JiraNewsBlock } from './JiraBlocks';
import { QuestionCard } from '../../ui/QuestionCard';
import { AbilityCard } from '../../ui/AbilityCard';
import { abilitiesView } from '../../ui/abilitiesView';
import { LinkIcon, ToolMark } from '../../ui/Icons';
import type { TileName } from '../../ui/toolIcons';

export interface BlockActions {
  openTicket: (key: string) => void;
  openBrief: (briefId: string) => void;
  openHandoff: (handoffId: string) => void;
  /** His create form, filled from a draft ("Edit first"). */
  editDraft: (draftId: string) => void;
  /** The ticket of a run, open at a section of its narrative (N1): the verdict, or the hand-back. */
  openNarrative: (runId: string, section: 2 | 7) => void;
}

export function Block({ block, state, actions }: { block: MessageBlock; state: WorkspaceState; actions: BlockActions }) {
  switch (block.type) {
    case 'ticket':
      return <TicketBlock state={state} ticketKey={block.ref} actions={actions} />;
    case 'findings':
      return <FindingsBlock state={state} investigationId={block.ref} actions={actions} />;
    case 'progress':
      return <ProgressBlock state={state} runId={block.ref} actions={actions} />;
    case 'sprint':
      return <SprintBlock state={state} sprint={block.ref} actions={actions} />;
    case 'approval':
      return <ApprovalBlock state={state} approvalId={block.ref} />;
    case 'brief':
      return <BriefBlock state={state} briefId={block.ref} actions={actions} />;
    case 'handoff':
      return <HandoffBlock state={state} handoffId={block.ref} actions={actions} />;
    case 'verdict':
      return <VerdictBlock state={state} runId={block.ref} actions={actions} />;
    case 'review':
      return <ReviewBlock state={state} reviewId={block.ref} />;
    case 'code':
      return <CodeMessageBlock block={block} />;
    case 'decision':
      return <DecisionBlock state={state} decisionId={block.ref} />;
    case 'digest':
      return <DigestBlock state={state} digestId={block.ref} />;
    case 'deliverable':
      return <DeliverableBlock state={state} deliverableId={block.ref} />;
    case 'draft':
      return <DraftBlock state={state} draftId={block.ref} actions={actions} />;
    case 'jira_news':
      return <JiraNewsBlock state={state} newsId={block.ref} actions={actions} />;
    case 'narrative':
      return <NarrativeLink state={state} runId={block.ref} section={block.section} actions={actions} />;
    case 'ability': {
      const ability = state.abilities[block.ref];
      return ability ? <AbilityCard ability={ability} size="mini" onOpen={() => abilitiesView.open(ability.name)} /> : null;
    }
  }
}

/**
 * Several approvals asked together (one batch): approve them all at once, or each by its own buttons below. Only once:
 * a grant for the whole ticket is given one action at a time.
 */
export function ApprovalBatch({ state, blocks }: { state: WorkspaceState; blocks: MessageBlock[] }) {
  const open = blocks.flatMap((b) => (b.type === 'approval' ? [state.approvals[b.ref]] : [])).filter((a): a is ApprovalView => !!a && !a.resolution && a.kind !== 'question');
  if (open.length < 2) return null;
  return (
    <div className="approval-batch">
      <span>{open.length} actions wait for you</span>
      <button type="button" className="button-outline button-outline--strong" onClick={() => open.forEach((a) => stream.answer(a.approvalId, 'approved', undefined, a.grantable ? 'once' : undefined))}>
        Approve all once
      </button>
    </div>
  );
}

function Missing({ what }: { what: string }) {
  return <div className="block block--missing">{what} is not in the workspace any more.</div>;
}

function TicketBlock({ state, ticketKey, actions }: { state: WorkspaceState; ticketKey: string; actions: BlockActions }) {
  const t = state.tickets[ticketKey];
  if (!t) return <Missing what={ticketKey} />;
  const run = agentOn(state, t.key);
  return (
    <button type="button" className="block block--ticket" onClick={() => actions.openTicket(t.key)} data-tip="Open in the sprint column">
      <span className="block-ticket-head">
        <TypeIcon type={t.type} size={22} />
        <b>{t.key}</b>
        <StatusChip status={t.status} />
        <PriorityChip priority={t.priority} />
        <PointsChip points={t.storyPoints} />
        {run && <AgentBadge run={run} />}
      </span>
      <span className="block-ticket-title">{t.summary}</span>
    </button>
  );
}

/** What a source is, as its icon says: a ticket or a page by its tool, a pull request or code by GitHub, a log by Coralogix. */
function SourceMark({ source }: { source: SourceRef }) {
  if (source.kind === 'url') return <LinkIcon url={source.ref} />;
  const name: TileName | null = source.kind === 'pr' || source.kind === 'code' ? 'github' : source.kind === 'log' ? 'coralogix' : source.kind === 'doc' ? 'confluence' : source.kind === 'memory' || source.kind === 'decision' || source.kind === 'precedent' || source.kind === 'setting' ? 'result' : null;
  return name ? <ToolMark name={name} /> : null;
}

function Source({ source, state, actions }: { source: SourceRef; state: WorkspaceState; actions: BlockActions }) {
  if (source.kind === 'ticket') return <TicketChip ticket={state.tickets[source.ref]} keyText={source.ref} onOpen={() => actions.openTicket(source.ref)} />;
  if (source.kind === 'url' && /^https?:\/\//.test(source.ref)) {
    return (
      <a href={source.ref} target="_blank" rel="noreferrer">
        <LinkIcon url={source.ref} />
        {source.label ?? source.ref}
      </a>
    );
  }
  return (
    <code className="source">
      <SourceMark source={source} />
      {source.label ?? source.ref}
    </code>
  );
}

function FindingsBlock({ state, investigationId, actions }: { state: WorkspaceState; investigationId: string; actions: BlockActions }) {
  const inv = state.investigations[investigationId];
  if (!inv) return <Missing what="That investigation" />;
  const who = `Investigator, ${modelLabel(inv.model)} ${inv.effort}`;
  const done = inv.finishedAt !== undefined;
  const meta = done
    ? [who, durationLabel(inv.durationMs ?? 0), inv.filesRead !== undefined ? `${inv.filesRead} files read` : null].filter(Boolean).join(', ')
    : `${who}, looking into: ${inv.question}`;
  return (
    <div className="block">
      <div className="block-meta">
        <span className={`dot ${done ? 'dot--agent' : 'dot--running'}`} />
        {meta}
      </div>
      {inv.title && <span className="block-title">{inv.title}</span>}
      {inv.findings.length > 0 && (
        <ol className="findings">
          {inv.findings.map((f, i) => (
            <li key={i}>
              {inline(f.text)}
              <span className="finding-sources">
                {f.sources.map((s, j) => (
                  <Source key={j} source={s} state={state} actions={actions} />
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const CHECK_DOT = { passed: 'done', failed: 'failed', pending: 'cancelled' } as const;

function ProgressBlock({ state, runId, actions }: { state: WorkspaceState; runId: string; actions: BlockActions }) {
  const run = state.runs[runId];
  if (!run) return <Missing what="That agent" />;
  return (
    <div className="block">
      <AgentLine run={run} actions={actions} />
      {run.steps.length > 0 && (
        <div className="agent-work-steps">
          {run.steps.map((s, i) => (
            <span key={i} className={`step-tag step-tag--${s.endedAt === undefined ? (run.state === 'waiting_for_you' ? 'waiting' : 'current') : s.outcome === 'done' ? 'done' : 'other'}`}>
              {s.name}
            </span>
          ))}
        </div>
      )}
      {run.checks.length > 0 && (
        <ul className="checks">
          {run.checks.map((c) => (
            <li key={c.id}>
              <span className={`dot dot--${CHECK_DOT[c.status]}`} />
              <span>
                {c.description}
                {c.evidence && <span className="check-evidence">{c.evidence.replace(/`/g, '')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentLine({ run, actions }: { run: RunView; actions: BlockActions }) {
  return (
    <div className="block-agent">
      <AgentBadge run={run} size={26} />
      <span>
        Agent {run.agentNumber} on{' '}
        {run.task ? (
          runLabel(run)
        ) : (
          <button type="button" className="link-button" onClick={() => actions.openTicket(run.ticket)}>
            {run.ticket}
          </button>
        )}
      </span>
      <span className="block-agent-model">{agentLabel(run.model, run.effort)}</span>
    </div>
  );
}

function SprintBlock({ state, sprint, actions }: { state: WorkspaceState; sprint: string; actions: BlockActions }) {
  const open = Object.values(state.tickets).filter(isOpen);
  const blocked = open.filter((t) => t.status === 'Blocked');
  const slipping = open.filter((t) => carriedOver(t) >= CARRIED_OVER_WARNING && t.status !== 'Blocked');
  const chips = (title: string, list: typeof open) =>
    list.length > 0 && (
      <div className="sprint-list">
        <span className="sprint-list-name">{title}</span>
        {list.map((t) => (
          <TicketChip key={t.key} ticket={t} keyText={t.key} onOpen={() => actions.openTicket(t.key)} />
        ))}
      </div>
    );
  return (
    <div className="block">
      <span className="block-title">
        {sprint}: {pointsLeft(state)} points left
      </span>
      <PointsBar points={storyPoints(state)} />
      {chips('Blocked', blocked)}
      {chips('Slipping', slipping)}
    </div>
  );
}

const DECISION: Record<NonNullable<ApprovalView['resolution']>['decision'], string> = { approved: 'Approved', denied: 'Denied', answered: 'Answered' };

/** An approval in the thread: who asks, for what, and Approve or Deny (or a typed answer to a question). */
function ApprovalBlock({ state, approvalId }: { state: WorkspaceState; approvalId: string }) {
  const a = state.approvals[approvalId];
  if (!a) return <Missing what="That approval" />;
  // every question and request reaches him as a card, through Elfoqsy .
  if (a.card || a.category) {
    return (
      <div className="block block--card">
        <QuestionCard approval={a} state={state} />
      </div>
    );
  }
  return <OlderApproval state={state} a={a} />;
}

/** An approval from before v1.3, as it was asked then. */
function OlderApproval({ state, a }: { state: WorkspaceState; a: ApprovalView }) {
  const [answer, setAnswer] = useState('');
  const run = state.runs[a.runId];
  const send = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && answer.trim() && stream.answer(a.approvalId, 'answered', answer.trim())) setAnswer('');
  };
  let footer: ReactNode;
  if (a.resolution) {
    const grant = a.resolution.scope === 'ticket' ? Object.values(state.grants).find((g) => g.approvalId === a.approvalId) : undefined;
    footer = (
      <span className="approval-done">
        {DECISION[a.resolution.decision]}
        {a.resolution.scope === 'ticket' && !a.resolution.test ? ' for this ticket' : ''}
        {a.resolution.test ? ' by the tester' : ''}, {hhmm(a.resolution.at)}
        {a.resolution.answer && a.resolution.decision === 'answered' ? `: ${a.resolution.answer}` : ''}
        {grant ? (grant.ended ? `; the grant has ended (${grant.ended.reason === 'expired' ? 'expired' : 'the run ended'})` : `; until ${hhmm(grant.expiresAt)} or the run's end`) : ''}
        {a.resolution.scope === 'ticket' && a.resolution.test ? '; this request only: only alex can allow it for the ticket' : ''}
      </span>
    );
  } else if (a.kind === 'question') {
    footer = (
      <input className="approval-answer" type="text" aria-label="Your answer" placeholder="Type your answer and press Enter" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={send} />
    );
  } else {
    footer = (
      <span className="approval-buttons">
        <button type="button" className="button-outline button-outline--strong" onClick={() => stream.answer(a.approvalId, 'approved', undefined, a.grantable ? 'once' : undefined)}>
          {a.grantable ? 'Approve once' : 'Approve'}
        </button>
        {a.grantable && (
          <button
            type="button"
            className="button-outline"
            data-tip={`The same kind of action on ${run?.ticket ?? 'this ticket'}${a.grantable.environment ? ` in ${a.grantable.environment}` : ''} runs without asking for 8 hours, or until the run ends`}
            onClick={() => stream.answer(a.approvalId, 'approved', undefined, 'ticket')}
          >
            Allow for this ticket
          </button>
        )}
        <button type="button" className="button-outline" onClick={() => stream.answer(a.approvalId, 'denied')}>
          Deny
        </button>
      </span>
    );
  }
  return (
    <div className="block block--approval">
      {run && (
        <div className="block-agent">
          <AgentBadge run={run} size={26} />
          <span>{a.question}</span>
        </div>
      )}
      {!run && <span>{a.question}</span>}
      {a.action && <code className="approval-action">{a.action}</code>}
      {footer}
    </div>
  );
}

/**
 * A link into the ticket's narrative (N1): after the verdict, "Read the verdict" (nothing waits); at hand-back, a yellow dot,
 * "What we know, then ready for review". It opens the ticket and scrolls to the section.
 */
function NarrativeLink({ state, runId, section, actions }: { state: WorkspaceState; runId: string; section: 2 | 7; actions: BlockActions }) {
  if (!state.runs[runId]) return <Missing what="That run" />;
  return (
    <div className="block block--link">
      <button type="button" className="button-outline" onClick={() => actions.openNarrative(runId, section)}>
        {section === 7 && <span className="dot dot--needs-you" aria-hidden="true" />}
        {section === 2 ? 'Read the verdict' : 'What we know, then ready for review'}
      </button>
    </div>
  );
}

function BriefBlock({ state, briefId, actions }: { state: WorkspaceState; briefId: string; actions: BlockActions }) {
  const b = state.briefs[briefId];
  if (!b) return <Missing what="That brief" />;
  const runs = b.runIds.map((id) => state.runs[id]).filter((r): r is RunView => !!r);
  return (
    <div className="block">
      <div className="brief-card">
        <span className="brief-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" />
            <path d="M9 10h6M9 14h6M9 18h4" />
          </svg>
        </span>
        <span className="brief-card-text">
          <span className="brief-card-title">{b.title}</span>
          <span className="brief-card-meta">Brief, {b.sections.length} sections</span>
        </span>
        <button type="button" className="button-outline button-outline--strong" onClick={() => actions.openBrief(b.briefId)}>
          Open
        </button>
      </div>
      {runs.map((run) => (
        <div key={run.runId} className="brief-run">
          <AgentBadge run={run} size={26} />
          <span>Agent {run.agentNumber} started from this brief</span>
          <span className="block-agent-model">{agentLabel(run.model, run.effort)}</span>
        </div>
      ))}
    </div>
  );
}

const MODE_WORDS = { normal: 'normal', read_only: 'read-only', hotfix: 'hotfix', remediation: 'remediation' } as const;
const count = (n: number, one: string, many = `${one}s`) => `${n === 0 ? 'no' : n} ${n === 1 ? one : many}`;

/** The handoff card: what was handed over (his messages, his constraints, sourced facts), the mode, Open. */
function HandoffBlock({ state, handoffId, actions }: { state: WorkspaceState; handoffId: string; actions: BlockActions }) {
  const h = state.handoffs[handoffId];
  if (!h) return <Missing what="That handoff" />;
  const runs = h.runIds.map((id) => state.runs[id]).filter((r): r is RunView => !!r);
  return (
    <div className="block">
      <div className="brief-card">
        <span className="brief-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" />
            <path d="M9 10h6M9 14h6M9 18h4" />
          </svg>
        </span>
        <span className="brief-card-text">
          <span className="brief-card-title">Handoff: {h.ticket}</span>
          <span className="brief-card-meta">
            {MODE_WORDS[h.mode]}, {count(h.context.length, 'message')} of his, {count(h.constraints.length, 'constraint')}, {count(h.facts.length, 'fact')}
            {h.dropped?.length ? `, ${h.dropped.length} left out` : ''}
          </span>
        </span>
        <button type="button" className="button-outline button-outline--strong" onClick={() => actions.openHandoff(h.handoffId)}>
          Open
        </button>
      </div>
      {runs.map((run) => (
        <div key={run.runId} className="brief-run">
          <AgentBadge run={run} size={26} />
          <span>Agent {run.agentNumber} started from this handoff</span>
          <span className="block-agent-model">{agentLabel(run.model, run.effort)}</span>
        </div>
      ))}
    </div>
  );
}

const VERDICT_DOT: Record<string, string> = {
  VALID: 'failed',
  VALID_FINDING: 'failed',
  NEW_BEHAVIOR: 'running',
  'EXPECTED_BEHAVIOR/INVALID': 'done',
  ALREADY_FIXED: 'done',
  'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED': 'waiting',
};

/** An agent's verdict: what it is, the reported symptom, the working case it compared, its example, and the evidence with sources. */
function VerdictBlock({ state, runId, actions }: { state: WorkspaceState; runId: string; actions: BlockActions }) {
  const run = state.runs[runId];
  const v = run?.verdict;
  if (!run || !v) return <Missing what="That verdict" />;
  const example = v.example ? Object.values(state.approvals).find((a) => a.runId === runId && a.kind === 'example' && a.requestedAt >= v.at - 1000) : undefined;
  const confirmed = example?.resolution ? (example.resolution.decision === 'approved' ? (example.resolution.test ? 'confirmed by the tester' : 'confirmed by you') : 'not confirmed') : example ? 'waiting for you' : undefined;
  return (
    <div className="block verdict">
      <div className="block-meta">
        <span className={`dot dot--${VERDICT_DOT[v.verdict] ?? 'agent'}`} />
        Agent {run.agentNumber}'s verdict on {run.ticket}, {hhmm(v.at)}
      </div>
      <span className="block-title">Verdict: {verdictWords(v)}</span>
      <p className="verdict-summary">{inline(v.summary)}</p>
      <dl className="verdict-facts">
        {v.symptom && (
          <div>
            <dt>Reported</dt>
            <dd>“{v.symptom}”</dd>
          </div>
        )}
        {v.sibling && (
          <div>
            <dt>Compared with</dt>
            <dd>{inline(v.sibling)}</dd>
          </div>
        )}
        {v.example && (
          <div>
            <dt>Example</dt>
            <dd>
              {inline(`\`${v.example.input}\` → \`${v.example.output}\``)}
              {confirmed ? <span className="verdict-confirm"> ({confirmed})</span> : null}
            </dd>
          </div>
        )}
        {v.ticketComment && (
          <div>
            <dt>Proposed comment</dt>
            <dd>{inline(v.ticketComment)}</dd>
          </div>
        )}
      </dl>
      {v.findings?.length ? (
        <ol className="findings">
          {v.findings.map((f, i) => (
            <li key={i}>
              {inline(f.text)}
              <span className="finding-sources">
                {f.sources.map((s, j) => (
                  <Source key={j} source={s} state={state} actions={actions} />
                ))}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Code in her reply, through the one renderer: the file and line range, Copy, numbered and highlighted lines. */
function CodeMessageBlock({ block }: { block: Extract<MessageBlock, { type: 'code' }> }) {
  const info: CodeInfo = {
    ...(block.language ? { language: block.language } : {}),
    ...(block.path ? { path: block.path } : {}),
    ...(block.startLine ? { startLine: block.startLine } : {}),
    ...(block.highlight?.length ? { highlight: block.highlight } : {}),
  };
  return (
    <div className="block block--code">
      <CodeBlock code={block.content} info={info} {...(block.diff ? { diff: true } : {})} />
    </div>
  );
}
