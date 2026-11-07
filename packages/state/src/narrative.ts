// The ticket narrative, "What we know" (N1): seven sections written from what the ticket's agent reported, in order, each with
// its source. A pure function of the folded state: the same log gives the same text, no model is asked, and nothing is
// said that no record backs. A section with no record behind it says what it waits for. What is only a hypothesis is
// called one. The PR description and Jira's Root cause and Solution are produced from the same sections, so they can
// never say what the narrative does not.
import type { ChainLink, PullRequest, SourceRef } from '@elfoqsy/contracts';
import { prKey, type ApprovalView, type NarrativeRecords, type RunView, type WorkspaceState } from './fold';
import { verdictWords } from './elfoqsy';

export type NarrativeKey = 'understanding' | 'verdict' | 'reproduction' | 'root_cause' | 'fix' | 'verification' | 'hand_back';

/** The seven sections in order, and what each waits for. */
export const NARRATIVE_SECTIONS: ReadonlyArray<{ n: number; key: NarrativeKey; title: string; waits: string }> = [
  { n: 1, key: 'understanding', title: 'Understanding', waits: 'After the agent has read the ticket' },
  { n: 2, key: 'verdict', title: 'Verdict', waits: 'After understanding' },
  { n: 3, key: 'reproduction', title: 'Reproduction', waits: 'After the verdict' },
  { n: 4, key: 'root_cause', title: 'Root cause', waits: 'After reproduction' },
  { n: 5, key: 'fix', title: 'Fix', waits: 'After the root cause' },
  { n: 6, key: 'verification', title: 'Verification', waits: 'After the fix' },
  { n: 7, key: 'hand_back', title: 'Hand-back', waits: 'After verification' },
];

/** done: its records are in (or it does not apply); current: the stage the agent is at; waiting: not reached yet. */
export type NarrativeStage = 'done' | 'current' | 'waiting';

/** A narrative's text: inline `code` and **bold** in md, as the one Markdown renderer reads them. */
export type NarrativeBlock =
  | { kind: 'p'; md: string }
  | { kind: 'list'; ordered?: boolean; items: NarrativeItem[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string };
export interface NarrativeItem {
  md: string;
  children?: NarrativeItem[];
}

export interface NarrativeSection {
  n: number;
  key: NarrativeKey;
  title: string;
  stage: NarrativeStage;
  /** What it waits for ("After verification"); only while nothing is in it yet. */
  waitsFor?: string;
  /** What the section says. Empty until the agent has reported something for it. */
  blocks: NarrativeBlock[];
  /** The same as Markdown, for "Copy as Markdown". */
  markdown: string;
  /** "Agent 4 · verdict, 14:12 · client.ts:89": the agent, the event and time, what it rests on. */
  source?: string;
  /** Plain lines for a place that is not Markdown (the PR description, Jira's fields). */
  text: string;
}

/** What the hand-back card needs: the PRs, what waits for him, and the gate. */
export interface NarrativeHandBack {
  prs: PullRequest[];
  /** The draft PRs still to be marked ready for review. */
  drafts: PullRequest[];
  /** The agent's own ask to mark one ready, still unanswered. */
  readyAsk?: ApprovalView;
  /** He ticked "I've read the narrative" and nothing in it has changed since. */
  read: boolean;
  /** He ticked once, and the narrative changed after. */
  changedSinceRead: boolean;
  /** The tester ticked (it opens nothing in a real run). */
  testerRead: boolean;
  /** The agent handed back (its turn ended with a PR open, or it ended). */
  handedBack: boolean;
}

export interface Narrative {
  runId: string;
  ticket: string;
  agentNumber: number;
  /** The run was the tester's. */
  test: boolean;
  /** The run has ended (succeeded, stopped, cancelled, failed). */
  ended: boolean;
  sections: NarrativeSection[];
  handBack: NarrativeHandBack;
  /**
   * The acceptance criteria the review called NOT MET that the agent explained after it (why they cannot be met here): what the PR
   * description says under "Not verified here". The ones it has not explained are for him in Verification, not for the team on GitHub.
   */
  explainedUnmet: Array<{ n: number; text: string; why: string }>;
}

const ENDED = new Set(['succeeded', 'failed', 'stopped', 'cancelled']);

const hhmm = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortSha = (sha: string): string => sha.slice(0, 7);
const repoName = (repo: string): string => repo.split('/').at(-1) ?? repo;

/** A source as the narrative names it: code and logs in code, tickets and PRs as they are, a label when there is one. */
function ref(s: SourceRef): string {
  const text = s.label ? `${s.label} (${s.ref})` : s.ref;
  return s.kind === 'code' || s.kind === 'log' ? code(s.ref) + (s.label ? ` (${s.label})` : '') : text;
}
const refs = (list: SourceRef[] | undefined): string => (list ?? []).map(ref).join(', ');
/** The short form of a source for a source line: the file and line without its folders. */
const brief = (s: SourceRef): string => (s.kind === 'code' ? (s.ref.split('/').at(-1) ?? s.ref) : s.ref);

const P = (md: string): NarrativeBlock => ({ kind: 'p', md });
const UL = (...items: NarrativeItem[]): NarrativeBlock => ({ kind: 'list', items });
const OL = (...items: NarrativeItem[]): NarrativeBlock => ({ kind: 'list', ordered: true, items });
const LI = (md: string, ...children: NarrativeItem[]): NarrativeItem => (children.length ? { md, children } : { md });

/** The blocks as Markdown. */
export function blocksMarkdown(blocks: NarrativeBlock[]): string {
  const item = (i: NarrativeItem, depth: number, mark: string): string[] => [`${'  '.repeat(depth)}${mark} ${i.md}`, ...(i.children ?? []).flatMap((c) => item(c, depth + 1, '-'))];
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'p':
          return b.md;
        case 'list':
          return b.items.flatMap((i, n) => item(i, 0, b.ordered ? `${n + 1}.` : '-')).join('\n');
        case 'code':
          return `\`\`\`\n${b.text}\n\`\`\``;
        case 'quote':
          return b.text.split('\n').map((l) => `> ${l}`).join('\n');
      }
    })
    .join('\n\n');
}

/** The run whose reports the ticket's narrative is written from: its latest, a real one before the tester's. */
export function narrativeRun(state: WorkspaceState, ticket: string): RunView | undefined {
  const runs = Object.values(state.runs)
    .filter((r) => r.ticket === ticket && !r.task)
    .sort((a, b) => b.createdAt - a.createdAt);
  return runs.find((r) => !r.test) ?? runs[0];
}

/** Whether a run has anything to say yet: the narrative shows once its agent has reported a first thing. */
export const hasNarrative = (run: RunView): boolean => !!run.narrative?.understanding || !!run.verdict || !!run.narrative?.reproduction;

/** A command with its spaces collapsed, so the same one typed twice counts once. */
const commandKey = (c: string): string => c.replace(/\s+/g, ' ').trim();

/** A test command that runs the whole suite: no file, test name or filter narrows it. */
function isFullSuite(command: string): boolean {
  const c = commandKey(command);
  if (/\s(-t|-k|-m|--filter|--grep|--testNamePattern|--testPathPattern|-run|--run|--test|--tests)\b/.test(c)) return false;
  const args = c.split(' ').slice(1).filter((a) => !a.startsWith('-'));
  return !args.some((a) => /[/\\]|\.(test|spec)\.|_test\.|\.[cm]?[jt]sx?$|\.py$|\.go$|::/.test(a));
}

function countsOf(t: { passed?: number; failed?: number }): string {
  const parts = [t.failed ? `${t.failed} failed` : '', t.passed !== undefined ? `${t.passed} passed` : ''].filter(Boolean);
  return parts.join(', ');
}

/** One acceptance criterion as the latest review judged it, and the agent's reason when it said why a NOT MET cannot be met here. */
export interface ReviewedCriterion {
  n: number;
  status: 'met' | 'not_met' | 'cannot_tell';
  text: string;
  why: string;
  agentWhy?: string;
}

/**
 * The acceptance criteria as the latest review judged them; undefined before any review. The agent's reasons count only when
 * said after that review: a new review is a new judgment, and an old reason is not an answer to it.
 */
export function reviewedCriteria(run: RunView): ReviewedCriterion[] | undefined {
  const review = run.narrative?.criteriaReview;
  if (!review) return undefined;
  const reported = run.narrative?.reported;
  const said = reported && reported.seq > review.seq ? (reported.unmet ?? []) : [];
  return review.criteria.map((c) => {
    const why = c.status === 'not_met' ? said.find((u) => u.n === c.n)?.why : undefined;
    return { ...c, ...(why ? { agentWhy: why } : {}) };
  });
}

/** The criteria the review called NOT MET that the agent has not said why it cannot meet: what holds the hand-back. */
export const unexplainedUnmet = (run: RunView): ReviewedCriterion[] => (reviewedCriteria(run) ?? []).filter((c) => c.status === 'not_met' && !c.agentWhy);

/** The newest change to what the narrative says: what a tick has to be newer than to count (N1's gate). */
function changedSeq(run: RunView): number {
  const n = run.narrative;
  const seqs = [run.verdict?.seq, n?.understanding?.seq, n?.reproduction?.seq, n?.rootCause?.seq, n?.approach?.seq, n?.reported?.seq, n?.criteriaReview?.seq, n?.handedBack?.seq, ...(n?.pushes.map((p) => p.seq) ?? [])];
  return Math.max(0, ...seqs.filter((x): x is number => typeof x === 'number'));
}

/** His tick on a run: current when nothing the narrative says has changed since. */
export function narrativeRead(run: RunView): { read: boolean; changedSinceRead: boolean; testerRead: boolean } {
  const reads = run.narrative?.reads ?? [];
  const latest = (by: 'you' | 'tester') => Math.max(0, ...reads.filter((r) => r.by === by).map((r) => r.seq));
  const mine = latest('you');
  const changed = changedSeq(run);
  return { read: mine > 0 && mine > changed, changedSinceRead: mine > 0 && mine <= changed, testerRead: latest('tester') > changed };
}

/** The ticket's kind of work, from its verdict: a bug to fix, a new behaviour, a finding, or a stop. */
type Shape = 'fix' | 'behaviour' | 'finding' | 'stopped' | 'unknown';
function shapeOf(run: RunView): Shape {
  switch (run.verdict?.verdict) {
    case 'VALID':
      return 'fix';
    case 'NEW_BEHAVIOR':
      return 'behaviour';
    case 'VALID_FINDING':
      return 'finding';
    case undefined:
      return 'unknown';
    default:
      return 'stopped';
  }
}

interface Built {
  blocks: NarrativeBlock[];
  source?: string;
  done: boolean;
  /** Plain lines for the PR description and Jira. */
  text?: string[];
}

const empty = (): Built => ({ blocks: [], done: false });
const notApplicable = (why: string): Built => ({ blocks: [P(`Not applicable: ${why}`)], done: true });

export function buildNarrative(state: WorkspaceState, runId: string): Narrative | undefined {
  const run = state.runs[runId];
  if (!run || run.task) return undefined;
  const n: NarrativeRecords = run.narrative ?? { pushes: [], tests: [], reads: [] };
  const shape = shapeOf(run);
  const who = `Agent ${run.agentNumber}`;
  const ended = ENDED.has(run.state);
  const prs = Object.values(state.prs)
    .filter((p) => p.ticket === run.ticket)
    .sort((a, b) => Number(b.state === 'open' || b.state === 'draft') - Number(a.state === 'open' || a.state === 'draft') || b.number - a.number);
  const src = (stage: string, at: number, what?: string): string => `${who} · ${stage}, ${hhmm(at)}${what ? ` · ${what}` : ''}`;

  // 1. Understanding
  const understanding = ((): Built => {
    const u = n.understanding;
    if (!u) return empty();
    const lines = [`The ticket says: ${oneLine(u.claim)}`, `Input: ${oneLine(u.input)}`, `Actual: ${oneLine(u.actual)}`, `Expected: ${oneLine(u.expected)}`];
    return { blocks: [UL(...lines.map((l) => LI(l)))], text: lines, done: true, source: src('understanding', u.at, u.sources.length ? u.sources.map(brief).join(', ') : "the ticket's own words") };
  })();

  // 2. Verdict
  const verdict = ((): Built => {
    const v = run.verdict;
    if (!v) return empty();
    const blocks: NarrativeBlock[] = [P(`**${verdictWords(v)}.** ${oneLine(v.summary)}`)];
    const text: string[] = [`${verdictWords(v)}. ${oneLine(v.summary)}`];
    if (v.chain?.length) {
      blocks.push(P('The path to the fault:'));
      blocks.push(
        OL(
          ...v.chain.map((l: ChainLink) =>
            LI(`${code(l.ref)}, ${l.role === 'fault' ? '**the fault**' : l.role === 'entry' ? 'where it enters' : 'on the way'}${l.note ? `: ${oneLine(l.note)}` : ''}`),
          ),
        ),
      );
      v.chain.forEach((l, i) => text.push(`${i + 1}. ${l.ref} (${l.role})${l.note ? `: ${oneLine(l.note)}` : ''}`));
    } else if (v.findings?.length) {
      blocks.push(P('What shows it, as the agent reported it (no path from entry to fault was reported):'));
      blocks.push(UL(...v.findings.map((f) => LI(`${oneLine(f.text)}${f.sources.length ? ` (${refs(f.sources)})` : ''}`))));
    }
    if (v.sibling) {
      blocks.push(P(`Compared with a case that works: ${oneLine(v.sibling)}${v.siblingAt ? ` (${ref(v.siblingAt)})` : ''}`));
      text.push(`Compared with a case that works: ${oneLine(v.sibling)}${v.siblingAt ? ` (${v.siblingAt.ref})` : ''}`);
    }
    if (v.example) {
      blocks.push(P(`Expected behaviour, the agent's own decision, flagged for you: ${oneLine(v.example.input)} → ${oneLine(v.example.output)}`));
      text.push(`Expected behaviour: ${oneLine(v.example.input)} → ${oneLine(v.example.output)}`);
    }
    if (shape === 'stopped' && v.ticketComment) blocks.push(P(`Its proposed comment on the ticket: "${oneLine(v.ticketComment)}"`));
    const rests = v.chain?.length ? v.chain.filter((l) => l.role === 'fault').map((l) => brief({ kind: 'code', ref: l.ref })) : (v.evidence ?? []).slice(0, 3).map(brief);
    return { blocks, text, done: true, source: src('verdict', v.at, rests.join(', ') || undefined) };
  })();

  // The latest failing test run of the command the reproduction names: its evidence.
  const failingOf = (command: string | undefined, before: number): NarrativeRecords['tests'][number] | undefined => {
    if (!command) return undefined;
    const key = commandKey(command);
    return [...n.tests].reverse().find((t) => !t.ok && commandKey(t.command) === key && t.seq <= before);
  };

  // 3. Reproduction
  const reproduction = ((): Built => {
    if (shape === 'behaviour') return notApplicable('this is a new behaviour, not a failure to reproduce.');
    if (shape === 'stopped') return notApplicable('the run stopped at its verdict.');
    const r = n.reproduction;
    if (!r) {
      if (run.verdict && !run.verdict.reproduced) return { blocks: [P('Not reproduced yet: the verdict says so, and the agent has not reported a reproduction.')], done: false };
      return empty();
    }
    const items = [LI(`How: ${oneLine(r.how)}`), LI(`Where: ${oneLine(r.environment)}`)];
    const text = [`How: ${oneLine(r.how)}`, `Where: ${oneLine(r.environment)}`];
    if (r.test) {
      items.push(LI(`Test: ${code(r.test.path)}, "${oneLine(r.test.name)}"`));
      text.push(`Test: ${r.test.path}, "${oneLine(r.test.name)}"`);
    }
    if (r.command) {
      items.push(LI(`Command: ${code(commandKey(r.command))}`));
      text.push(`Command: ${commandKey(r.command)}`);
    }
    if (r.requestIds?.length) {
      items.push(LI(`Request ids: ${r.requestIds.map(code).join(', ')}`));
      text.push(`Request ids: ${r.requestIds.join(', ')}`);
    }
    const blocks: NarrativeBlock[] = [UL(...items)];
    const failing = failingOf(r.command, r.seq);
    if (failing) {
      blocks.push(P(`Failing evidence, from the run at ${hhmm(failing.at)}${countsOf(failing) ? ` (${countsOf(failing)})` : ''}:`), { kind: 'code', text: failing.summary.trim() });
      text.push(`Failing evidence (${hhmm(failing.at)}): ${oneLine(failing.summary).slice(0, 300)}`);
    } else if (r.command) {
      blocks.push(P('Failing evidence: the orchestrator saw no failing run of that command.'));
    }
    return { blocks, text, done: true, source: src('reproduction', r.at, failing ? `test run at ${hhmm(failing.at)}` : r.test ? brief({ kind: 'code', ref: r.test.path }) : undefined) };
  })();

  // 4. Root cause
  const rootCause = ((): Built => {
    if (shape === 'behaviour') return notApplicable('this is a new behaviour.');
    if (shape === 'stopped') return notApplicable('the run stopped at its verdict.');
    const c = n.rootCause;
    if (!c) {
      const open = (run.hypotheses ?? []).filter((h) => h.status !== 'disproved');
      if (!open.length) return empty();
      return {
        blocks: [
          P('Not found yet. What the agent is testing, as hypotheses:'),
          UL(...open.map((h) => LI(`Hypothesis (${h.status === 'confirmed' ? 'confirmed by the agent, not yet reported as the cause' : 'open'}): ${oneLine(h.text)}${h.evidence?.length ? ` (${refs(h.evidence)})` : ''}`))),
        ],
        done: false,
        source: src('hypotheses', Math.max(...open.map((h) => h.at))),
      };
    }
    const blocks: NarrativeBlock[] = [P(oneLine(c.text))];
    if (c.lines.length) blocks.push(P(`The lines: ${c.lines.map(ref).join(', ')}`));
    const text = [oneLine(c.text), ...(c.lines.length ? [`Lines: ${c.lines.map((l) => l.ref).join(', ')}`] : [])];
    return { blocks, text, done: true, source: src('root cause', c.at, c.lines.map(brief).join(', ') || undefined) };
  })();

  // 5. Fix
  const fix = ((): Built => {
    if (shape === 'stopped') return notApplicable('the run stopped at its verdict.');
    const a = n.approach;
    if (!a && !n.pushes.length) return empty();
    const items: NarrativeItem[] = [];
    const text: string[] = [];
    if (a) {
      items.push(LI(`Approach: ${oneLine(a.approach)}`));
      text.push(`Approach: ${oneLine(a.approach)}`);
      if (a.alternatives.length) {
        items.push(LI('Alternatives rejected:', ...a.alternatives.map((alt) => LI(`${oneLine(alt.option)}: ${oneLine(alt.rejectedBecause)}`))));
        text.push('Alternatives rejected:', ...a.alternatives.map((alt) => `- ${oneLine(alt.option)}: ${oneLine(alt.rejectedBecause)}`));
      } else {
        items.push(LI('Alternatives rejected: none recorded.'));
        text.push('Alternatives rejected: none recorded.');
      }
    }
    if (n.pushes.length) {
      // Per repository, the branch's change as the latest push left it (each push lists the whole change against the base).
      const latest = new Map<string, { repo: string; head: string; files: Array<{ path: string; added: number; removed: number }> }>();
      for (const p of n.pushes) for (const r of p.repos) latest.set(r.repo, { repo: r.repo, head: r.head, files: r.files });
      const changes: NarrativeItem[] = [];
      const plain: string[] = [];
      for (const e of latest.values()) {
        for (const f of e.files) {
          changes.push(LI(`${code(f.path)} +${f.added} −${f.removed} (${repoName(e.repo)} at ${shortSha(e.head)})`));
          plain.push(`- ${f.path} +${f.added} -${f.removed} (${repoName(e.repo)} at ${shortSha(e.head)})`);
        }
        if (!e.files.length) {
          changes.push(LI(`${repoName(e.repo)} at ${shortSha(e.head)}: no file list`));
          plain.push(`- ${repoName(e.repo)} at ${shortSha(e.head)}`);
        }
      }
      items.push(LI('Changes:', ...changes));
      text.push('Changes:', ...plain);
    } else {
      items.push(LI('Changes: nothing pushed yet.'));
    }
    const decisions = [...(run.assumptions ?? [])].sort((x, y) => Number(!!y.flag) - Number(!!x.flag) || x.at - y.at);
    if (decisions.length) {
      items.push(LI('Decisions it made:', ...decisions.map((d) => LI(`${d.flag ? `[${d.flag}] ` : ''}${oneLine(d.text)}${d.evidence.length ? ` (${refs(d.evidence)})` : ''}`))));
      text.push('Decisions I made:', ...decisions.map((d) => `- ${d.flag ? `[${d.flag}] ` : ''}${oneLine(d.text)}${d.evidence.length ? ` (${d.evidence.map((e) => e.ref).join(', ')})` : ''}`));
      const flagged = decisions.filter((d) => d.flag);
      if (flagged.length) items.push(LI(`Flags for you: ${[...new Set(flagged.map((d) => d.flag))].join(', ')}.`));
    }
    const risks = run.heartbeats.at(-1)?.risks ?? [];
    if (risks.length) items.push(LI(`Risks it reported: ${risks.map(oneLine).join('; ')}.`));
    for (const q of Object.values(state.approvals).filter((x) => x.runId === run.runId && !x.resolution && (x.kind === 'question' || x.kind === 'decision'))) {
      items.push(LI(`Open question: ${oneLine(q.card?.question ?? q.question).slice(0, 240)}`));
    }
    const when = Math.max(a?.at ?? 0, ...n.pushes.map((p) => p.at));
    const head = n.pushes.at(-1)?.repos[0];
    const what = head ? `commit ${shortSha(head.head)}, ${plural(new Set(n.pushes.at(-1)!.repos.flatMap((r) => r.files.map((f) => f.path))).size, 'file')}` : undefined;
    return { blocks: [UL(...items)], text, done: !!a && n.pushes.length > 0, source: src('fix', when, what) };
  })();

  // 6. Verification
  const verification = ((): Built => {
    if (shape === 'stopped') return notApplicable('the run stopped at its verdict.');
    const items: NarrativeItem[] = [];
    const text: string[] = [];
    const byCommand = new Map<string, typeof n.tests>();
    for (const t of n.tests) byCommand.set(commandKey(t.command), [...(byCommand.get(commandKey(t.command)) ?? []), t]);
    const before: string[] = [];
    const only: string[] = [];
    const still: string[] = [];
    for (const [cmd, runs] of byCommand) {
      const firstFail = runs.find((t) => !t.ok);
      const last = runs.at(-1)!;
      const lastPass = [...runs].reverse().find((t) => t.ok);
      const label = isFullSuite(cmd) ? 'Full suite: ' : '';
      if (firstFail && lastPass && lastPass.seq > firstFail.seq && last.ok) {
        before.push(`${label}${code(cmd)}: failed at ${hhmm(firstFail.at)}${countsOf(firstFail) ? ` (${countsOf(firstFail)})` : ''}, passed at ${hhmm(lastPass.at)}${countsOf(lastPass) ? ` (${countsOf(lastPass)})` : ''}`);
      } else if (!last.ok) {
        still.push(`${label}${code(cmd)}: failing at ${hhmm(last.at)}${countsOf(last) ? ` (${countsOf(last)})` : ''}`);
      } else {
        only.push(`${label}${code(cmd)}: passed at ${hhmm(last.at)}${countsOf(last) ? ` (${countsOf(last)})` : ''}`);
      }
    }
    const group = (title: string, lines: string[]) => {
      if (!lines.length) return;
      items.push(LI(title, ...lines.map((l) => LI(l))));
      text.push(title, ...lines.map((l) => `- ${l.replace(/`/g, '')}`));
    };
    group('Failing before, passing after:', before);
    group('Still failing:', still);
    group('Also run:', only);
    if (run.checks.length) {
      const lines = run.checks.map((c) => `${oneLine(c.description)}: ${c.status}${c.evidence ? `. ${oneLine(c.evidence)}` : ''}`);
      items.push(LI('Its checks:', ...lines.map((l) => LI(l))));
      text.push('Checks:', ...lines.map((l) => `- ${l}`));
    }
    for (const p of prs) {
      const ci = state.ci[prKey(p)];
      if (!ci) continue;
      const word = { queued: 'queued', running: 'running', success: 'passed', failure: 'failed' }[ci.status];
      items.push(LI(`CI on ${repoName(p.repo)}#${p.number}: ${word}${ci.sha ? ` at ${shortSha(ci.sha)}` : ''}, ${hhmm(ci.at)}.`));
      text.push(`CI on ${repoName(p.repo)}#${p.number}: ${word}${ci.sha ? ` at ${shortSha(ci.sha)}` : ''}.`);
    }
    // What the review said of each acceptance criterion: every NOT MET is here for him to decide before ready for review. Not in
    // `text`: that feeds the PR description, which goes to GitHub, and what he decides about these is not for the team to read there.
    const criteria = reviewedCriteria(run);
    if (criteria) {
      const notMet = criteria.filter((c) => c.status === 'not_met');
      const cannot = criteria.filter((c) => c.status === 'cannot_tell');
      const met = criteria.filter((c) => c.status === 'met');
      // "the criterion: what the review found." as one sentence.
      const said = (c: { text: string; why: string }) => `${oneLine(c.text)}${c.why ? `: ${oneLine(c.why).replace(/\.+$/, '')}` : ''}.`;
      if (!criteria.length) items.push(LI('Acceptance criteria: the review found none stated in the ticket.'));
      else {
        const counts = `${met.length} met, ${notMet.length} NOT MET, ${cannot.length} it could not tell`;
        items.push(
          LI(
            `Acceptance criteria, as the review judged them (${counts}):`,
            ...notMet.map((c) => LI(`**NOT MET** ${c.n}. ${said(c)} ${c.agentWhy ? `The agent says it cannot be met here: ${oneLine(c.agentWhy)}` : 'The agent gave no reason: for you to decide.'}`)),
            ...cannot.map((c) => LI(`Could not tell ${c.n}. ${said(c)}`)),
            ...(met.length ? [LI(`Met: ${met.map((c) => c.n).join(', ')}.`)] : []),
          ),
        );
      }
    }
    const r = n.reported;
    if (r) {
      if (r.notVerified.length) {
        items.push(LI('Not verified:', ...r.notVerified.map((x) => LI(oneLine(x)))));
        text.push('Not verified:', ...r.notVerified.map((x) => `- ${oneLine(x)}`));
      } else {
        items.push(LI('Not verified: the agent reported nothing left unverified.'));
        text.push('Not verified: nothing reported.');
      }
    } else if (items.length) {
      items.push(LI('Not verified: not reported yet.'));
    }
    const open = run.checks.filter((c) => c.status !== 'passed');
    if (open.length && r) items.push(LI(`Checks without passing evidence: ${open.map((c) => oneLine(c.description)).join('; ')}.`));
    if (!items.length) return empty();
    const when = Math.max(r?.at ?? 0, n.criteriaReview?.at ?? 0, ...n.tests.map((t) => t.at), ...prs.map((p) => state.ci[prKey(p)]?.at ?? 0));
    const ciPr = prs.find((p) => state.ci[prKey(p)]);
    return { blocks: [UL(...items)], text, done: !!r, source: src('verification', when, ciPr ? `CI run on ${repoName(ciPr.repo)}#${ciPr.number}` : n.tests.length ? `${plural(n.tests.length, 'test run')} the orchestrator saw` : undefined) };
  })();

  // 7. Hand-back
  const read = narrativeRead(run);
  const readyAsk = Object.values(state.approvals).find((a) => a.runId === run.runId && !a.resolution && a.gate === 'narrative');
  const drafts = prs.filter((p) => p.state === 'draft');
  const handedBack = !!n.handedBack || (ended && shape !== 'unknown');
  const handBack = ((): Built => {
    const r = n.reported;
    const h = n.handedBack;
    if (!r && !h && shape !== 'stopped') return empty();
    const items: NarrativeItem[] = [];
    const text: string[] = [];
    if (prs.length) {
      for (const p of prs) {
        const review = p.review && p.review !== 'none' ? { approved: 'approved', changes_requested: 'changes requested', review_required: 'review required' }[p.review] : 'no review yet';
        const ci = state.ci[prKey(p)];
        const checks = ci ? { queued: 'CI queued', running: 'CI running', success: 'CI passed', failure: 'CI failed' }[ci.status] : { none: 'no CI yet', pending: 'CI pending', success: 'CI passed', failure: 'CI failed' }[p.checks];
        items.push(LI(`PR ${code(`${repoName(p.repo)}#${p.number}`)}${p.title ? ` "${oneLine(p.title)}"` : ''}: ${p.state === 'draft' ? 'a draft' : p.state}, ${checks}, ${review}.`));
        text.push(`PR ${repoName(p.repo)}#${p.number}: ${p.state}, ${checks}, ${review}`);
      }
    } else if (shape !== 'stopped') {
      items.push(LI('PR: none open.'));
    }
    if (r) {
      items.push(LI(`Its report: ${r.result}. ${oneLine(r.summary)}`));
      text.push(`Report: ${r.result}. ${oneLine(r.summary)}`);
    }
    const waiting: string[] = [];
    for (const w of r?.waitingOnYou ?? []) waiting.push(oneLine(w));
    for (const a of Object.values(state.approvals).filter((x) => x.runId === run.runId && !x.resolution)) waiting.push(`Answer: ${oneLine(a.card?.question ?? a.question).slice(0, 200)}`);
    for (const d of Object.values(state.drafts).filter((x) => x.runId === run.runId && !x.closed)) waiting.push(`A ticket it drafted: ${oneLine(d.draft.summary)}`);
    const flagged = (run.assumptions ?? []).filter((x) => x.flag);
    if (flagged.length) waiting.push(`Decide at review: ${flagged.map((x) => `${x.flag} (${oneLine(x.text).slice(0, 80)})`).join('; ')}`);
    if (shape === 'stopped' && run.verdict?.ticketComment) waiting.push('Approve or change its comment on the ticket');
    if (drafts.length) waiting.push('Mark the PR ready for review, after reading this');
    const uniq = [...new Set(waiting)];
    if (uniq.length) items.push(LI('Waits for you:', ...uniq.map((w) => LI(w))));
    else items.push(LI('Nothing else waits for you.'));
    const blocks: NarrativeBlock[] = [UL(...items)];
    if (h) blocks.push(P('Its last message, as it ended its turn:'), { kind: 'quote', text: h.message.trim().slice(0, 900) });
    const when = Math.max(h?.at ?? 0, r?.at ?? 0, run.verdict?.at ?? 0);
    const prWord = prs[0] ? `${repoName(prs[0].repo)}#${prs[0].number}` : undefined;
    return { blocks, text, done: handedBack, source: src('hand-back', when, prWord) };
  })();

  const built: Record<NarrativeKey, Built> = { understanding, verdict, reproduction, root_cause: rootCause, fix, verification, hand_back: handBack };
  const firstOpen = NARRATIVE_SECTIONS.find((s) => !built[s.key].done)?.key;
  const sections: NarrativeSection[] = NARRATIVE_SECTIONS.map((def) => {
    const b = built[def.key];
    const stage: NarrativeStage = b.done ? 'done' : !ended && firstOpen === def.key ? 'current' : 'waiting';
    const blank = b.blocks.length === 0;
    return {
      n: def.n,
      key: def.key,
      title: def.title,
      stage,
      ...(blank ? { waitsFor: ended ? `The run ended (${run.state})` : def.waits } : {}),
      blocks: b.blocks,
      markdown: blocksMarkdown(b.blocks),
      ...(b.source ? { source: b.source } : {}),
      text: (b.text ?? []).join('\n'),
    };
  });
  return {
    runId: run.runId,
    ticket: run.ticket,
    agentNumber: run.agentNumber,
    test: !!run.test,
    ended,
    sections,
    handBack: { prs, drafts, ...(readyAsk ? { readyAsk } : {}), ...read, handedBack },
    explainedUnmet: (reviewedCriteria(run) ?? []).flatMap((c) => (c.status === 'not_met' && c.agentWhy ? [{ n: c.n, text: c.text, why: c.agentWhy }] : [])),
  };
}

/** The narrative as Markdown, for "Copy as Markdown". */
export function narrativeMarkdown(narrative: Narrative): string {
  const out = [`# What we know: ${narrative.ticket}`, '', `Kept by Elfoqsy from Agent ${narrative.agentNumber}'s reports.`, ''];
  for (const s of narrative.sections) {
    out.push(`## ${s.n}. ${s.title}`, '');
    out.push(s.markdown || `Waiting: ${s.waitsFor ?? ''}`.trim(), '');
    if (s.source) out.push(`_${s.source}_`, '');
  }
  return `${out.join('\n').trim()}\n`;
}

/** What a field or a description needs from the narrative, or the report the agent still owes. */
export type Produced = { ok: true; text: string } | { ok: false; missing: string };

const section = (n: Narrative, key: NarrativeKey): NarrativeSection => n.sections.find((s) => s.key === key)!;
const isNotApplicable = (s: NarrativeSection): boolean => s.blocks.length === 1 && s.blocks[0]!.kind === 'p' && s.blocks[0]!.md.startsWith('Not applicable');

/** Jira's Root cause: section 4 as plain text. A story has none. */
export function jiraRootCause(n: Narrative): Produced {
  const s = section(n, 'root_cause');
  if (!s.text) return { ok: false, missing: 'report_root_cause: Root cause is written from your reported root cause (its text and the exact lines)' };
  return { ok: true, text: s.text };
}

/** Jira's Solution: the approach, its alternatives and the changes, from section 5 as plain text. */
export function jiraSolution(n: Narrative): Produced {
  const s = section(n, 'fix');
  if (!/^Approach:/m.test(s.text)) return { ok: false, missing: 'report_approach: Solution is written from your reported approach' };
  if (!/^Changes:/m.test(s.text)) return { ok: false, missing: 'a push: Solution lists what the push carried, and nothing is pushed yet' };
  // The decisions are the PR's; the Solution is the approach, what was rejected and the change.
  const lines = s.text.split('\n');
  const end = lines.findIndex((l) => l.startsWith('Decisions I made:'));
  return { ok: true, text: (end < 0 ? lines : lines.slice(0, end)).join('\n') };
}

/**
 * The PR description, from the narrative: the problem, the root cause, the fix, how it was verified and what was not,
 * and "Decisions I made" (which the PR check wants). Nothing here is the agent's free text.
 */
export function prDescription(n: Narrative): Produced {
  const u = section(n, 'understanding');
  const v = section(n, 'verdict');
  const rc = section(n, 'root_cause');
  const fix = section(n, 'fix');
  const ver = section(n, 'verification');
  if (!u.text) return { ok: false, missing: 'report_understanding: the PR description starts from your reported understanding' };
  if (!v.text) return { ok: false, missing: 'report_verdict: the PR description rests on your verdict' };
  const needsCause = !isNotApplicable(rc);
  if (needsCause && !rc.text) return { ok: false, missing: 'report_root_cause: the PR description gives the root cause, from your report' };
  if (!/^Approach:/m.test(fix.text)) return { ok: false, missing: 'report_approach: the PR description gives your approach, from your report' };
  const out: string[] = [];
  out.push(`${n.ticket}`, '', '## Problem', '', ...u.text.split('\n').map((l) => `- ${l}`));
  if (needsCause) out.push('', '## Root cause', '', rc.text);
  const fixLines = fix.text.split('\n');
  const decisionsAt = fixLines.findIndex((l) => l.startsWith('Decisions I made:'));
  out.push('', '## Fix', '', ...(decisionsAt < 0 ? fixLines : fixLines.slice(0, decisionsAt)));
  // A line ending in a colon is a heading of the lines that follow it with a dash: those hang under it.
  if (ver.text) out.push('', '## Verification', '', ...ver.text.split('\n').map((l) => (l.startsWith('- ') ? `  ${l}` : `- ${l}`)));
  // What the review called NOT MET and the agent says cannot be met here: the team reads it, so it is said where they look for gaps.
  if (n.explainedUnmet.length) out.push('', '## Not verified here', '', ...n.explainedUnmet.map((c) => `- Acceptance criterion: ${oneLine(c.text)}. Not met here: ${oneLine(c.why)}`));
  if (decisionsAt >= 0) {
    // Listed one point each, flagged ones first, as the PR check wants them.
    out.push('', '## Decisions I made', '', ...fixLines.slice(decisionsAt + 1).filter((l) => l.startsWith('- ')));
  }
  out.push('', `Jira: ${n.ticket}`);
  return { ok: true, text: `${out.join('\n')}\n` };
}
