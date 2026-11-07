// The ticket workflow a run follows (v1.2.1 from alex's team-dev
// retrospective): a verdict before any code, in the skill's own validity labels, and a gate that depends on it, on the
// ticket's type and on the run's mode. A bug is VALID once the reported symptom (quoted from the ticket, not the agent's
// own idea) is reproduced and a similar working case compared; a story is NEW_BEHAVIOR with one input -> output example;
// a remediation is VALID_FINDING once the finding is reproduced from the scanner's inputs; read-only mode allows no edits
// at all. Before the first code change the agent has the repo's CI ruleset and rules in front of it and declares every
// input class the change will see. The first push waits for one fresh-context review, which checks for contract changes
// and cache bypasses. agents ask far less: an example and what the review finds no longer stop the run; they
// go on as flagged assumptions, under "Decisions I made", and alex decides them at review. A task agent has
// no verdict and never pushes. After three bot-review rounds Elfoqsy asks him. Three disproved hypotheses and she flags it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ChainLink, Finding, RunMode, SourceRef, TicketType, Verdict } from '@elfoqsy/contracts';
import { verdictWords } from '@elfoqsy/state';
import { codeRefProblem } from './narrativeReports';

export type TicketKind = 'bug' | 'story' | 'remediation' | 'task';

/** What the gate asks of a ticket: a bug's symptom, a story's behaviour, a finding from the scanner's inputs; a task nothing. */
export const ticketKind = (type: TicketType, mode: RunMode, task = false): TicketKind =>
  task ? 'task' : mode === 'remediation' ? 'remediation' : type === 'Bug' ? 'bug' : 'story';

/** Verdicts that stop the run when its turn ends. */
export const STOPPING: ReadonlySet<Verdict> = new Set<Verdict>(['ALREADY_FIXED', 'EXPECTED_BEHAVIOR/INVALID', 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED']);

/** The label each kind of ticket gets when it needs a change. */
export const CHANGE_LABEL: Record<Exclude<TicketKind, 'task'>, Verdict> = { bug: 'VALID', story: 'NEW_BEHAVIOR', remediation: 'VALID_FINDING' };

/** Tests, by the usual folder and file names: a failing test may be written before the bug is reproduced. */
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs|e2e|integration_test)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|ts|js)$|(^|\/)test_[^/]+\.py$/;
export const isTestPath = (rel: string): boolean => TEST_PATH.test(rel.replace(/\\/g, '/'));

/** After this many disproved hypotheses, Elfoqsy flags it and suggests diffing a similar working case. */
export const HYPOTHESIS_BUDGET = 3;
/** Bot-review rounds on the PR (read from its reviews) before Elfoqsy asks alex about another. */
export const REVIEW_ROUNDS = 3;
/** The sub-agent that reviews before the first push: fresh context, the diff and the repo's ruleset. */
export const REVIEWER = 'reviewer';


export interface VerdictReport {
  verdict: Verdict;
  reproduced: boolean;
  summary: string;
  symptom?: string;
  sibling?: string;
  example?: { input: string; output: string };
  ticketComment?: string;
  findings: Finding[];
  /** The path from the entry to the fault, in order (a bug's narrative, N1), and the working case it was compared with. */
  chain?: ChainLink[];
  siblingAt?: SourceRef;
}

/** Lower case, one space, no quotes or trailing punctuation: how a quote is matched against the ticket. */
const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[“”"'`‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?…]+$/, '');

/** Whether the symptom is quoted from the ticket's own text, word for word. */
export function quotedFrom(symptom: string, ticketText: string): boolean {
  const q = norm(symptom);
  return q.length >= 12 && norm(ticketText).includes(q);
}

/**
 * What the review before the first push says about a contract change and a cache bypass: the last "CONTRACT:" and
 * "CACHE_BYPASS:" lines of its final message, null for "none"; undefined when it did not say.
 */
export function reviewFindings(text: string): { contract: string | null | undefined; cacheBypass: string | null | undefined } {
  const line = (label: string): string | null | undefined => {
    const found = [...text.matchAll(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, 'gim'))].at(-1)?.[1];
    if (found === undefined) return undefined;
    return /^(none|no|n\/a)\b/i.test(found.trim()) ? null : found.trim();
  };
  return { contract: line('CONTRACT'), cacheBypass: line('CACHE_BYPASS') };
}

/** One acceptance criterion as the review judged it, from a CRITERION line of its final message. */
export interface Criterion {
  n: number;
  status: 'met' | 'not_met' | 'cannot_tell';
  text: string;
  why: string;
}

const STATUS: Record<string, Criterion['status']> = { MET: 'met', 'NOT MET': 'not_met', 'CANNOT TELL': 'cannot_tell' };

/**
 * What the review says of each acceptance criterion: its "CRITERION n: MET | NOT MET | CANNOT TELL | the criterion | why"
 * lines, or "CRITERIA: none stated" when the ticket states none (an empty list); undefined when it said neither. Tolerant of what a model
 * does to a line (a bullet, bold, a different dash), strict about the words that decide: a status it cannot read is not a criterion.
 */
export function reviewCriteria(text: string): Criterion[] | undefined {
  const found: Criterion[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*_`-]+/, '').replace(/\*\*|__/g, '');
    const m = /^CRITERION\s*#?(\d+)\s*[:.)]\s*(NOT[ _-]?MET|CANNOT[ _-]?TELL|MET)\b[\s|:.,-]*(.*)$/i.exec(line);
    if (!m) continue;
    const status = STATUS[m[2]!.toUpperCase().replace(/[_-]/g, ' ')];
    if (!status) continue;
    const [first, ...rest] = (m[3] ?? '').split('|').map((p) => p.trim());
    const criterion = first ?? '';
    const why = rest.join(' | ');
    const n = Number(m[1]);
    // The same number said twice: the later line wins.
    const at = found.findIndex((c) => c.n === n);
    const entry: Criterion = { n, status, text: criterion || `criterion ${n}`, why };
    if (at >= 0) found[at] = entry;
    else found.push(entry);
  }
  if (found.length) return found.sort((a, b) => a.n - b.n);
  return /^\W*CRITERIA\s*:\s*none\b/im.test(text) ? [] : undefined;
}

const sources = (v: VerdictReport): SourceRef[] => v.findings.flatMap((f) => f.sources);

export class TicketWorkflow {
  verdict?: VerdictReport;
  /** The ticket's understanding is reported (report_understanding), which the verdict comes after (N1). */
  understood = false;
  inputs?: string[];
  /** The repo's ruleset and rules have been put in front of the agent. */
  rulesShown = false;
  /** A fresh-context review finished during the run and said what it found on contracts and cache bypasses. */
  reviewed = false;
  /** What that review found: a contract change, a cache bypass; absent when none. Recorded as flagged assumptions. */
  review: { contract?: string; cacheBypass?: string } = {};
  /** The acceptance criteria as the latest review judged them; undefined before one that said. */
  criteria?: Criterion[];
  /** Why the agent says each NOT MET criterion cannot be met here, by number, as said after the latest review. */
  private readonly unmetReasons = new Map<number, string>();
  /** The hand-back was held this many times for a criterion that is NOT MET and unexplained. */
  holds = 0;
  pushes = 0;
  /** Rounds alex allowed beyond the first three. */
  extraRounds = 0;
  private readonly hypotheses = new Map<string, 'open' | 'confirmed' | 'disproved'>();
  private budgetFlagged = false;

  constructor(
    readonly kind: TicketKind,
    readonly mode: RunMode,
    /** The reviewer's pack: the ticket's handoff and acceptance criteria, written by the orchestrator (reviewPack.ts). */
    readonly reviewDir?: string,
  ) {}

  /** What is wrong with a verdict, or null when it can be recorded. */
  verdictProblem(v: VerdictReport, ticketText: string): string | null {
    if (this.kind === 'task') return 'A task has no verdict: do the work and deliver it.';
    if (!this.understood) return 'Report your understanding of the ticket first (report_understanding): what it claims, quoted, and the input, the actual output and the expected output. The verdict comes after it.';
    if (!v.findings.length || !sources(v).length) return 'A verdict needs its evidence: at least one finding with a source (code path:line, the ticket, a log query, a page).';
    const label = CHANGE_LABEL[this.kind];
    if (!STOPPING.has(v.verdict) && v.verdict !== label) {
      const what = { bug: 'A bug', story: 'A story or task', remediation: 'A remediation' }[this.kind];
      return `${what}'s verdict is ${label} when it needs a change, or ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID or INSUFFICIENT_EVIDENCE/NOT_REPRODUCED.`;
    }
    if (v.verdict === 'VALID' || v.verdict === 'VALID_FINDING') {
      if (!v.symptom?.trim()) {
        return v.verdict === 'VALID'
          ? 'Quote the reported symptom from the ticket in symptom, word for word: the reported symptom is what has to reproduce, not one you found yourself.'
          : 'Quote the finding as the scanner reported it, from the ticket, in symptom.';
      }
      if (!quotedFrom(v.symptom, ticketText)) {
        return `symptom must be quoted from the ticket, word for word (its summary, description or a comment); "${v.symptom.trim().slice(0, 120)}" is not in it. A different symptom you found is a new finding (report_finding), not the reported one.`;
      }
    }
    if (v.verdict === 'VALID' && (!v.sibling?.trim() || (/^none\b/i.test(v.sibling.trim()) && v.sibling.trim().length < 16))) {
      return 'Compare with a similar case that works (sibling): which one and how the two differ, with a source in findings; or "none: <why there is none>".';
    }
    if (v.verdict === 'VALID') {
      if (!v.chain?.length || !v.chain.some((l) => l.role === 'fault')) {
        return 'Give the path to the fault (chain): the calls from where the failing input enters to the fault, in order, each a path:line, the last with role "fault". It is shown to alex as it is.';
      }
      const bad = codeRefProblem(v.chain.map((l) => ({ kind: 'code' as const, ref: l.ref })), 'chain');
      if (bad) return bad;
      if (!/^none\b/i.test(v.sibling!.trim())) {
        if (!v.siblingAt) return 'Say where the working case you compared with is (siblingAt, a code source path:line).';
        const at = codeRefProblem([v.siblingAt], 'siblingAt');
        if (at) return at;
      }
    }
    const refs = codeRefProblem(v.findings.flatMap((f) => f.sources), 'findings');
    if (refs) return refs;
    if (v.verdict === 'VALID_FINDING' && !v.reproduced) {
      return "A finding is VALID_FINDING only once it reproduces from the scanner's inputs (a lockfile-only resolve and the audit that reports it). Reproduce it first.";
    }
    if ((v.verdict === 'VALID' || v.verdict === 'VALID_FINDING') && v.reproduced && !sources(v).some((s) => s.kind === 'code' || s.kind === 'log')) {
      return v.verdict === 'VALID'
        ? 'Reproduced needs what shows it: a failing test (a code source, path:line) or the logs (a log source).'
        : "Reproduced needs what shows it: the scanner's input (a code source: the lockfile) and the resolve or audit that reports it.";
    }
    if (v.verdict === 'NEW_BEHAVIOR' && !v.example) return 'NEW_BEHAVIOR needs the expected behaviour as one example (example: input and output); it is recorded as a flagged assumption for alex to review.';
    if (STOPPING.has(v.verdict) && !v.ticketComment?.trim()) {
      return 'Say what you propose to post on the ticket (ticketComment, 1-3 sentences, the evidence included): Elfoqsy proposes it to alex when the run stops.';
    }
    return null;
  }

  /** Records a verdict. Its example, if any, goes on as a flagged assumption; nobody is asked to confirm it. */
  setVerdict(v: VerdictReport): void {
    this.verdict = v;
  }

  /** Why the run stops when its turn ends, or undefined. */
  get stopping(): string | undefined {
    const v = this.verdict;
    return v && STOPPING.has(v.verdict) ? `Its verdict: ${verdictWords(v)}. ${v.summary}` : undefined;
  }

  /** Whether edits may begin to happen: some edit is allowed (tests at least). */
  get editsOpen(): boolean {
    return this.mode !== 'read_only' && this.repoEdit('test/x.test.ts') === null;
  }

  /** Whether an edit to a file of a target repository (its path inside the repository) may happen now; null when it may. */
  repoEdit(rel: string): string | null {
    if (this.mode === 'read_only') return 'Read-only mode: no edits at all. Put what you found in report_verdict and in your summary.';
    if (this.kind === 'task') return null;
    const v = this.verdict;
    if (!v) return 'Report your verdict first (report_verdict), before any code change. Scratch files in your .tmp folder and notes in the ticket folder are free.';
    if (STOPPING.has(v.verdict)) return `Your verdict is ${verdictWords(v)}: no code changes. The run stops when this turn ends.`;
    const test = isTestPath(rel);
    if (v.verdict === 'VALID' && !v.reproduced && !test) {
      return 'VALID, not reproduced yet: only test files until it is (write the failing test). Then report_verdict again with reproduced: true.';
    }
    if (!test && !this.inputs) {
      return "Before your first code change, declare every input class the change will see (declare_inputs): message and config types, synthetic, retry and timeout results, log shapes. Read the repo's CI ruleset and rules first; they were in report_verdict's answer.";
    }
    return null;
  }

  /** A commit in a target repository: allowed once some edit is. */
  commit(): string | null {
    return this.repoEdit('test/x.test.ts');
  }

  /** Notes in the ticket folder (case.md, evidence): free, except in read-only mode. */
  ticketFolderEdit(): string | null {
    return this.mode === 'read_only' ? 'Read-only mode: no edits at all, the ticket folder included. Elfoqsy writes case.md from the log when the run ends.' : null;
  }

  /**
   * The review's report, from its final message. False when it did not say what it found on contracts and caches, nor (when the run has
   * its pack of the ticket's criteria) what it found on each criterion. A criterion that is NOT MET does not make it false: that holds the
   * hand-back, never the push.
   */
  reviewDone(text: string): boolean {
    const found = reviewFindings(text);
    if (found.contract === undefined || found.cacheBypass === undefined) return false;
    const criteria = reviewCriteria(text);
    if (this.reviewDir && criteria === undefined) return false;
    this.reviewed = true;
    this.review = { ...(found.contract ? { contract: found.contract } : {}), ...(found.cacheBypass ? { cacheBypass: found.cacheBypass } : {}) };
    // A new review is a new judgment: what was said of the last one is not an answer to it.
    if (criteria) {
      this.criteria = criteria;
      this.unmetReasons.clear();
      this.holds = 0;
    }
    return true;
  }

  /** The criteria the latest review called NOT MET that the agent has not said why it cannot meet. */
  unmetOpen(): Criterion[] {
    return (this.criteria ?? []).filter((c) => c.status === 'not_met' && !this.unmetReasons.has(c.n));
  }

  /**
   * report_result: a run is not reported succeeded while a criterion is NOT MET, unless the agent says why that one cannot be met here
   * (its number and why). What the report says is checked against the review, and kept once it is accepted. A problem to hand back, or null.
   */
  reportProblem(result: 'succeeded' | 'failed' | 'blocked', unmet: Array<{ n: number; why: string }> = []): string | null {
    const open = (this.criteria ?? []).filter((c) => c.status === 'not_met');
    const stray = unmet.filter((u) => !open.some((c) => c.n === u.n));
    if (stray.length) return `unmet names ${stray.map((u) => u.n).join(', ')}, which the review did not call NOT MET (it called ${open.length ? open.map((c) => c.n).join(', ') : 'none'}).`;
    // A failure or a block stands as it is; what is said about a criterion is kept for the narrative all the same.
    if (result === 'succeeded') {
      const left = open.filter((c) => !unmet.some((u) => u.n === c.n) && !this.unmetReasons.has(c.n));
      if (left.length) {
        const list = left.map((c) => `${c.n} (${c.text}${c.why ? `: ${c.why}` : ''})`).join('; ');
        return `the review found ${left.length === 1 ? 'an acceptance criterion' : `${left.length} acceptance criteria`} NOT MET: ${list}. A run is not reported succeeded while one is NOT MET. Meet it and run the review again, or say in unmet why it cannot be met here (its number and why). Every one is shown to alex in the narrative's Verification.`;
      }
    }
    for (const u of unmet) this.unmetReasons.set(u.n, u.why);
    return null;
  }

  /** The first push waits for one fresh review that said what it found. */
  pushProblem(): string | null {
    if (this.mode === 'read_only') return 'Read-only mode: nothing is pushed.';
    if (this.kind === 'task') return "A task's result comes back into the conversation with deliver; nothing is pushed.";
    if (this.pushes === 0 && !this.reviewed) {
      return `Before the first push, run one fresh-context review: the Agent tool with subagent_type ${REVIEWER} (Sonnet 5.5, high). It has no shell: write the diff to a file in the run folder first (git diff <base>...HEAD > .tmp/review.diff, in the clone) and give it that path, the clone, the repo's CI ruleset and your input classes.${this.reviewDir ? ` The ticket's handoff and acceptance criteria are already in ${this.reviewDir} (read-only, not yours to change): name that folder too, and it holds the diff to them.` : ''} It ends with a CONTRACT: line and a CACHE_BYPASS: line (each "none" or what and where)${this.reviewDir ? ', and a CRITERION line for each acceptance criterion (MET, NOT MET or CANNOT TELL)' : ''}. Fix the Blocker and Major findings it confirms, then push. One pass; later findings come from the real CI review.`;
    }
    return null;
  }

  /** What the review found, as flagged assumptions: a contract change, a cache bypass. alex decides them at review. */
  reviewFlags(): Array<{ flag: 'contract' | 'cache_bypass'; text: string }> {
    const out: Array<{ flag: 'contract' | 'cache_bypass'; text: string }> = [];
    if (this.review.contract) out.push({ flag: 'contract', text: `The review found a visible contract change: ${this.review.contract}` });
    if (this.review.cacheBypass) out.push({ flag: 'cache_bypass', text: `The review found a cache or optimization bypassed: ${this.review.cacheBypass}` });
    return out;
  }

  /** Another bot-review round needs alex's yes: its PR has had three (as read from its reviews) and none more allowed. */
  roundNeedsApproval(rounds: number): boolean {
    return rounds >= REVIEW_ROUNDS + this.extraRounds;
  }

  pushed(): void {
    this.pushes++;
  }

  /** A hypothesis reported; true the first time disproved ones reach the budget. */
  hypothesis(id: string, status: 'open' | 'confirmed' | 'disproved'): boolean {
    this.hypotheses.set(id, status);
    const disproved = [...this.hypotheses.values()].filter((s) => s === 'disproved').length;
    if (disproved >= HYPOTHESIS_BUDGET && !this.budgetFlagged) {
      this.budgetFlagged = true;
      return true;
    }
    return false;
  }

  get disproved(): number {
    return [...this.hypotheses.values()].filter((s) => s === 'disproved').length;
  }
}

const MAX_RULE_FILE = 8000;
const MAX_RULES = 24_000;

/** Markdown files under a folder, in path order, a few levels down. */
function markdownFiles(dir: string, depth = 3): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...markdownFiles(path, depth - 1));
    else if (/\.mdc?$/i.test(name)) out.push(path);
  }
  return out;
}

/**
 * The repo's CI review ruleset and its rules, as text for the agent: .agents/skills/pr-review/RULESET.md and
 * .claude/rules/, in each target clone. Read as text only.
 */
export function rulesetText(repos: Array<{ repo: string; path: string }>): string {
  const parts: string[] = [];
  let total = 0;
  for (const r of repos) {
    const files = [join(r.path, '.agents', 'skills', 'pr-review', 'RULESET.md'), ...markdownFiles(join(r.path, '.claude', 'rules'))].filter((f) => existsSync(f));
    if (!files.length) {
      parts.push(`### ${r.repo}\nNo CI review ruleset (.agents/skills/pr-review/RULESET.md) and no .claude/rules/ in this repository.`);
      continue;
    }
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const body = text.length > MAX_RULE_FILE ? `${text.slice(0, MAX_RULE_FILE)}\n[truncated; read the rest in the file]` : text;
      if (total + body.length > MAX_RULES) {
        parts.push(`### ${r.repo}/${relative(r.path, f)}\n[not included: too long together; read it in the file]`);
        continue;
      }
      total += body.length;
      parts.push(`### ${r.repo}/${relative(r.path, f)}\n${body.trim()}`);
    }
  }
  return parts.join('\n\n');
}
