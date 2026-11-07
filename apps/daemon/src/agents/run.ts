// One ticket agent: one Claude Code session (Opus 5.5, xhigh) in its own run folder, with its sub-agents,
// the shell gate on every tool call, hooks that turn its work into events, and its budgets. It holds no credentials:
// everything remote goes through the orchestrator's capability proxies (kube, aws, gh, jira, confluence, logs) and
// their four tiers, and the orchestrator pushes the run branch itself (tier 1, done at once and reported).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createSdkMcpServer,
  tool,
  type CanUseTool,
  type HookCallback,
  type HookInput,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Actor, CheckStatus, DelegationCategory, MessageBlock, PayloadOf, PlanCheck, ProxyName, QuestionCard, RunMode, SourceRef, Step, StepOutcome, TaskSpec, Ticket, TicketDraft } from '@elfoqsy/contracts';
import { verdictWords, type Narrative } from '@elfoqsy/state';
import { realClock, type Clock } from '../clock';
import type { UsageState } from '../claude/usage';
import { TICKET_AGENT, type Effort } from '../config';
import { handleLimitSignal, TurnInput, type QueryFn } from '../elfoqsy/session';
import type { EventLog } from '../eventLog';
import type { FirstResponder } from '../decisions/firstResponder';
import { decide, type GateContext } from '../gate/policy';
import type { CommitCi } from '../github/gh';
import type { Environments } from '../permissions/environments';
import type { Proxies, ProxyRun } from '../permissions/proxy';
import { PROXY_TOOLS, proxyTools } from '../permissions/tools';
import type { Classified } from '../permissions/types';
import { tr } from '../elfoqsy/voice';
import { checkOutbound, checkOutboundResolved, redact, redactDeep, type OutboundContext } from '../redact';
import { ulid } from '../ulid';
import { answeredBy, CLOSED_ANSWERS, unanswered, type Approvals, type ApprovalKind, type Resolution } from './approvals';
import { TRAILER, agentGitEnv, agentRunEnded, commitTree, fixCoAuthors, isDirty, pushBranch, remoteBranchSha, treeFingerprint, unpushedCount, unpushedLog, wrongCoAuthors, type AgentMade, type Git, type PreparedRepo } from './git';
import { runPrompt } from './prompt';
import { type RepoPolicy } from './repoPolicy';
import { decisionsMissing, externalWrite, fromNarrative, hasEvidence } from './externalWrites';
import { codeRefProblem, isTestCommand, parseTestOutput, pushedFacts, testExcerpt } from './narrativeReports';
import { REVIEWER_TOOLS, subagentDefinitions, WORKER_TOOLS } from './subagents';
import { quotedFrom, REVIEWER, rulesetText, STOPPING as STOPPING_VERDICTS, ticketKind, TicketWorkflow, type VerdictReport } from './workflow';
import { taskPrompt } from './taskPrompt';
import { questionCard } from './questionCard';
import { createHash } from 'node:crypto';
import { summarizeToolResult, toolTitle, whereIn } from './toolText';
import { skillOptions, skillRefusal, SKILL_SETTINGS, type Abilities } from '../skill/abilities';
import { telemetryEnv } from '../telemetry/env';

export const RUN_TOOLS = 'run';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const BUDGET_CHECK_MS = 15_000;
/** How many times a turn that ends with an acceptance criterion NOT MET and unexplained is sent back to the agent before it is handed back as it is. */
const UNMET_HOLDS = 2;
/** How long an agent waits for alex's answer before its question is withdrawn and the run pauses. */
export const ASK_DEADLINE_MS = 72 * 3600_000;
/** The SDK's limit on one call of the run's own tools: just past the deadline, so the orchestrator's comes first. */
export const RUN_TOOL_TIMEOUT_MS = ASK_DEADLINE_MS + 10 * 60_000;

/** Token counts as an assistant message or a streaming event reports them (the API's nullable fields included). */
type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null };
/** How often an agent reports a heartbeat, in minutes of working time, unless the run's limits say otherwise. */
const HEARTBEAT_MINUTES = 5;
/** The same command this many times with no code change in between is a loop. */
const LOOP_REPEATS = 3;
/** A budget is nearly spent at this share of its tokens or minutes. */
const BUDGET_NEARLY = 0.8;
/** After guidance, the agent's own tool calls before it is reminded to re-plan, and before it is flagged. */
const REPLAN_REMIND = 3;
const REPLAN_FLAG = 8;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A thought longer than this is cut: the pane shows reasoning, not documents. */
const THOUGHT_MAX = 4000;

/** Who stepped in, as the agent is told: never alex for what the tester did. */
const whoFor = (by: Actor): string => (by === 'tester' ? 'The tester (not alex)' : by === 'elfoqsy' ? 'Elfoqsy, for alex' : 'alex');

export type ControlResult = { ok: true } | { error: string; message: string };
/** Package registries and public GitHub downloads: the only hosts an agent's shell can reach. */
const SANDBOX_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'nodejs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
];
/**
 * What the SDK asks canUseTool when a sandboxed command reaches a host off SANDBOX_DOMAINS (input { host }). With
 * strictAllowlist the sandbox refuses those itself; were it ever asked, the gate refuses it too, for every agent.
 */
export const SANDBOX_NETWORK = 'SandboxNetworkAccess';

export interface RunSpec {
  runId: string;
  agentNumber: number;
  ticket: Ticket;
  linked: Ticket[];
  goal?: string;
  /** The brief it was started from, as Markdown (older runs). */
  brief?: string;
  /** The handoff it was started from, as Markdown: his words, his constraints, sourced facts. Its first instruction. */
  handoff?: string;
  /**
   * The reviewer's pack (reviewPack.ts): the ticket's handoff and acceptance criteria as read-only files, written when the run started. The
   * ticket agent names this folder to the reviewer; nothing in it may change.
   */
  reviewDir?: string;
  /** How it works, chosen at handoff: normal, read-only (no edits at all), hotfix or remediation. */
  mode?: RunMode;
  /** The ticket folder (~/tickets/<KEY>): case.md and evidence, which it reads and writes as its own (not in read-only mode). */
  ticketDir?: string;
  /**
   * The read-only copy of alex's team-dev skill, taken at its start (its writing rules go with every external
   * write). The skill and the adapter after it go into the first instruction once the adapter is approved (adapter set).
   */
  skill?: { dir: string; hash: string; skillMd: string; adapter?: string };
  /** Its read-only copy of the Abilities skills (data/skills), loaded natively by the SDK. Absent: no skills at all. */
  abilities?: Abilities;
  /** Rules alex confirmed for its repositories. */
  rules?: string[];
  branch: string;
  runRoot: string;
  repos: PreparedRepo[];
  identity: { name: string; email: string } | null;
  /** Started at the tester's request: its folder is kept only for commits GitHub lacks. */
  test?: boolean;
  /** When run.created was logged; commits from before then were made by someone else. */
  createdAt?: number;
  /** Commits its branch starts with from a kept run folder, and who made each, for its first instruction. */
  inherited?: Array<{ repo: string; commits: Array<{ sha: string; subject: string; by: string }> }>;
  /**
   * Its own kubeconfig, outside its sandbox (DATA_DIR/runs/<runId>/kubeconfig): the kube proxy uses it, and the agent's
   * KUBECONFIG and AWS CLI files point into its folder, which the agent cannot read, so nothing it runs can change
   * alex's global kube context or AWS profile.
   */
  kubeconfig?: string;
  /** A task agent: work alex asked for that is not tied to a ticket. Its ticket is a stand-in. */
  task?: TaskSpec;
}

export interface RunDeps {
  log: EventLog;
  usage: UsageState;
  approvals: Approvals;
  git: Git;
  /** The capability proxies and their tier policy. */
  proxies: Proxies;
  /** Environments, for the proxy tools' descriptions. */
  environments: Environments;
  queryFn: QueryFn;
  policies: Record<string, RepoPolicy>;
  /** The Claude Code environment without credentials (sessionEnv); git settings are added per run. */
  baseEnv: Record<string, string>;
  hosts: GateContext['hosts'];
  protectedPaths: string[];
  /** alex's home, which agents read outside their run folder only when he agrees; the real one unless a test says. */
  home?: string;
  /** Elfoqsy's own package caches, shared by every run (agentCacheDir): writable, and where npm, pnpm and the XDG caches point. */
  cacheDir?: string;
  limits: { maxMinutes: number; maxTokens: number; maxSubagents: number; models: string[]; efforts: Effort[]; heartbeatMinutes?: number };
  /** The ticket agent's model and effort; Opus 5.5 at xhigh unless a probe sets otherwise. */
  ticketAgent?: { model: string; effort: Effort };
  /** Who made a commit on this ticket's branch, from when it was committed and its author: "Agent 5", "alex" or the author's email. */
  madeBy?: (committedAt: number, email: string) => string;
  /** Does the ticket have an open PR on one of the run's repositories? */
  hasOpenPr: (ticket: string, repos: string[]) => boolean;
  /** What CI says about one commit (check runs and statuses), read with alex's gh. Absent: no CI evidence. */
  commitCi?: (repo: string, sha: string) => Promise<CommitCi>;
  /** Elfoqsy's line in the run's conversation, from the orchestrator (no Claude turn), with blocks. */
  say?: (text: string, blocks?: MessageBlock[]) => void;
  /** A ticket the agent proposes, drafted for him: only he creates it. */
  draftTicket?: (o: { by: 'agent'; runId: string; draft: TicketDraft; line: string }) => { draftId: string } | { error: string; message: string };
  /** The ticket's own words (summary, description, comments) as Jira has them now, for quoting the reported symptom. */
  ticketText?: (key: string) => Promise<string>;
  /** This run's narrative as the log stands (N1): what its PR description and Jira's Root cause and Solution are written from. */
  narrative?: () => Narrative | undefined;
  /** Bot-review rounds on the ticket's open PRs in these repositories, read from their reviews (the most of any PR). */
  reviewRounds?: (ticket: string, repos: string[]) => Promise<number>;
  /** Elfoqsy, first responder for its questions; without her they go straight to alex. */
  firstResponder?: () => FirstResponder | undefined;
  /** What the redactor needs to check a web request before it leaves; without it, the web is refused. */
  outbound?: OutboundContext;
  clock?: Clock;
  now?: () => number;
}

type Gate = { behavior: 'allow'; note?: string } | { behavior: 'deny'; reason: string } | { behavior: 'ask'; kind: ApprovalKind; action: string; reason: string };

/** How often CI is read for ci checks that have no passing evidence yet. */
const CI_POLL_MS = 60_000;

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Whether a Bash command ran a check's command exactly, so its exit status is that command's: the same
 * words, optionally after `cd <folder> &&`. Pipes, extra arguments or later commands would change what passed.
 */
export function runsExactly(command: string, declared: string): boolean {
  const norm = (c: string) => c.trim().replace(/\s+/g, ' ');
  const got = norm(command);
  const want = norm(declared);
  if (!want) return false;
  return got === want || got.replace(/^cd [^;&|<>`$()]+ && /, '') === want;
}

/** A check as noted on the run when the agent changes its checks. */
function describeCheck(c: PlanCheck): string {
  if (c.proof === 'command') return `${c.description} (\`${c.command}\`)`;
  return `${c.description} (${c.proof === 'ci' ? `CI on ${c.repo}` : c.scope === 'external' ? 'your approval, outside the code' : 'your approval'})`;
}

/** What the agent reads back from alex's answer, or the tester's, or nobody's. */
function answerText(r: Resolution): string {
  if (r.withdrawn) return 'Withdrawn after 72 hours without an answer; the run is paused until alex resumes it.';
  if (unanswered(r)) return `Nobody answered; the question was closed (${r.answer}).`;
  if (r.answer) return r.test ? `[Answered by the tester, not alex] ${r.answer}` : r.answer;
  return r.decision === 'denied' ? 'Nobody answered; the question was closed.' : 'No answer.';
}

const firstLine = (text: string, max = 160): string => {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What is left after a run ends, per repository it changed. null: it could not be checked. */
export interface RepoOutcome {
  repo: string;
  branch: string;
  branchOnGitHub: boolean | null;
  unpushedCommits: number | null;
  uncommittedChanges: boolean | null;
}

export type EndState = 'succeeded' | 'failed' | 'stopped' | 'cancelled';

/** What the agent says happened, through report_result. */
export interface AgentReport {
  result: 'succeeded' | 'failed' | 'blocked';
  summary: string;
  /** What it did not verify, and what waits for alex (N1: the narrative's verification and hand-back). */
  notVerified?: string[];
  waitingOnYou?: string[];
  /** For each acceptance criterion the review called NOT MET: why the agent says it cannot be met here, by the criterion's number. */
  unmet?: Array<{ n: number; why: string }>;
}

/**
 * A declared check and the evidence seen for it. fingerprint: the code the evidence is about when it passed (the
 * whole run's files, or for a ci check its repo's); evidence is stale as soon as that code is different.
 */
export interface CheckState {
  check: PlanCheck;
  status: CheckStatus;
  evidence?: string;
  fingerprint?: string | null;
}

/**
 * How a run ends: the agent's own failure or block stands; success needs passing evidence for every check
 * of its plan (a command that ran and passed, a CI result, or Alex's approval). The system never decides
 * what done means for a ticket, only that it is proven.
 */
export function endStateFor(checks: CheckState[] | undefined, report: AgentReport | undefined, lead: string, unmet: string[] = []): { state: EndState; reason: string } {
  if (report?.result === 'failed') return { state: 'failed', reason: sentence(report.summary) };
  if (report?.result === 'blocked') return { state: 'stopped', reason: sentence(report.summary) };
  const opening = sentence(report?.summary ?? lead);
  const prefix = opening ? `${opening} ` : '';
  if (!checks) return { state: 'stopped', reason: `${prefix}No plan was declared, so nothing proves the ticket done.` };
  const missing = checks.filter((c) => c.status !== 'passed');
  if (missing.length) {
    const list = missing.map((c) => `"${c.check.description}" (${c.status === 'failed' ? 'failed' : 'no evidence yet'})`).join(', ');
    return { state: 'stopped', reason: `${prefix}Not counted as succeeded: ${list}.` };
  }
  // An acceptance criterion the review called NOT MET and the agent did not explain is not a success either.
  if (unmet.length) return { state: 'stopped', reason: `${prefix}Not counted as succeeded: the review found ${unmet.join(', ')} NOT MET, and the agent did not say why it cannot be met.` };
  return { state: 'succeeded', reason: `${prefix}All ${plural(checks.length, 'check')} have passing evidence.` };
}

/**
 * How a task agent ends: its own failure or block stands; success needs its deliverable delivered, and passing
 * evidence for any checks it chose to declare.
 */
export function taskEndState(checks: CheckState[] | undefined, delivered: number, report: AgentReport | undefined, lead: string): { state: EndState; reason: string } {
  if (report?.result === 'failed' || report?.result === 'blocked') return endStateFor(checks, report, lead);
  const opening = sentence(report?.summary ?? lead);
  const prefix = opening ? `${opening} ` : '';
  if (!delivered) return { state: 'stopped', reason: `${prefix}Nothing was delivered, so the task is not done.` };
  if (checks?.some((c) => c.status !== 'passed')) return endStateFor(checks, report, lead);
  return { state: 'succeeded', reason: `${prefix}Delivered${checks?.length ? `, and all ${plural(checks.length, 'check')} have passing evidence` : ''}.` };
}

/** Ends with a full stop unless it already ends a sentence (an ellipsis counts). */
const sentence = (text: string): string => {
  const t = text.trim();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
};

export interface RunOutcome {
  state: EndState;
  folder: string;
  folderRemoved: boolean;
  repos: RepoOutcome[];
  /** The facts above in one or two sentences; Elfoqsy reports this and nothing more. */
  summary: string;
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** untilClosed: a clean folder of a run that is not closed yet, kept until it is. */
export function describeOutcome(folder: string, folderRemoved: boolean, repos: RepoOutcome[], untilClosed = false): string {
  const sentences = repos.map((r) => {
    const branch = repos.length > 1 ? `${r.branch} in ${r.repo}` : r.branch;
    const where =
      r.branchOnGitHub === null
        ? `It could not be checked whether ${branch} is on GitHub`
        : r.branchOnGitHub
          ? `${branch} is on GitHub`
          : folderRemoved
            ? `${branch} was never pushed, so it is gone with the run folder`
            : `${branch} is not on GitHub, only in the run folder`;
    const left: string[] = [];
    if (r.unpushedCommits === null) left.push('commits that could not be checked');
    else if (r.unpushedCommits > 0) left.push(`${plural(r.unpushedCommits, 'commit')} not on GitHub`);
    if (r.uncommittedChanges === null) left.push('changes that could not be checked');
    else if (r.uncommittedChanges) left.push(folderRemoved ? 'uncommitted changes, removed with the folder' : 'uncommitted changes');
    return `${where}${left.length ? `; ${left.join(' and ')}` : '; no unpushed commits or uncommitted changes'}.`;
  });
  sentences.push(folderRemoved ? 'The run folder was removed.' : `The run folder was kept at ${folder}${untilClosed ? ' until the run is closed' : ''}.`);
  return sentences.join(' ');
}

/**
 * Where agents' package caches live, one folder for every run: Elfoqsy's own, next to the run folders (the same disk, so pnpm
 * can hard-link out of its store), and never his ~/.npm or ~/.cache.
 */
export const agentCacheDir = (worktreesRoot: string): string => join(dirname(worktreesRoot), 'cache');

/** A file Elfoqsy puts in the cache folder to say it is hers: a folder that holds anything else is never taken over. */
export const AGENT_CACHE_MARKER = '.elfoqsy-agent-cache';

/**
 * The cache folder exists and is Elfoqsy's own. Every agent's shell reads and writes all of it, so it must not be a folder that
 * already holds something (WORKTREES_ROOT set to ~/runs would make it ~/cache): that is refused, and AGENT_CACHE_DIR names another.
 */
export function ensureAgentCache(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, AGENT_CACHE_MARKER);
  if (existsSync(marker)) return;
  if (readdirSync(dir).length) {
    throw new Error(`${dir} is where Elfoqsy would keep her agents' package caches, but it already holds something else, and every agent could read and write all of it. Move it, or set AGENT_CACHE_DIR to a folder of its own.`);
  }
  writeFileSync(marker, "Elfoqsy's package caches for her agents, shared by their runs. Nothing else belongs in this folder.\n");
}

/** The environment that points the package managers at that folder. */
export function cacheEnv(cacheDir: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(cacheDir, 'xdg'),
    npm_config_cache: join(cacheDir, 'npm'),
    // pnpm keeps its store under PNPM_HOME; a store-dir set through an npm_config_ variable makes npm 11 warn on every command.
    // Only the cache variable of the XDG family: the session's own Claude Code process reads the environment too, and its
    // data and state folders are not ours to move.
    PNPM_HOME: join(cacheDir, 'pnpm-home'),
    YARN_CACHE_FOLDER: join(cacheDir, 'yarn'),
    COREPACK_HOME: join(cacheDir, 'corepack'),
    BUN_INSTALL_CACHE_DIR: join(cacheDir, 'bun'),
    GOMODCACHE: join(cacheDir, 'gomod'),
  };
}

/**
 * Where the toolchains a run executes live in the home: nvm's node and the npm and pnpm in it, a Go SDK, cargo's binaries,
 * the version managers. Readable, as the rest of the home is not. Narrow on purpose: ~/.cargo itself holds
 * credentials.toml, ~/.dotnet holds certificate stores, so only what runs is named. What is not on this machine is not listed.
 */
const TOOLCHAINS = ['.nvm', '.fnm', '.volta/bin', '.volta/tools', '.asdf', '.pyenv', '.rbenv', '.sdkman/candidates', '.rustup', '.cargo/bin', '.bun/bin', '.npm-global', '.local/bin', 'sdk', 'go/bin'];

const within = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function toolchainReads(home: string, exists: (path: string) => boolean = existsSync, node: string = process.execPath): string[] {
  const found = TOOLCHAINS.map((t) => join(home, t)).filter(exists);
  // The node that runs the daemon is the one the agents' PATH names: its own install folder, wherever in the home a manager put
  // it. Only a folder that is a node install (it has lib/node_modules) and sits at least two levels down: ~/.local/bin/node
  // would otherwise make all of ~/.local readable, and ~/.cargo/bin/node all of ~/.cargo, credentials included.
  const nodeHome = dirname(dirname(node));
  const depth = within(home, nodeHome) ? relative(home, nodeHome).split('/').length : 0;
  if (depth >= 2 && exists(join(nodeHome, 'lib', 'node_modules')) && !found.some((f) => within(f, nodeHome))) found.push(nodeHome);
  return found;
}

/** The parts of a clone's .git that decide what git runs, as they exist (a path that is not there is not bound). */
export function guardedGitPaths(gitDirs: string[], exists: (path: string) => boolean = existsSync): string[] {
  return gitDirs.flatMap((dir) => ['config', 'hooks', 'info', 'config.worktree', 'modules'].map((name) => join(dir, name))).filter(exists);
}

/**
 * The shell runs sandboxed or not at all: only the hosts above, no Unix sockets (no keyring, no SSH
 * agent), and the home unreadable by default: what a run needs of it is allowed back, which is
 * its own folder, its ticket folder, the caches that are Elfoqsy's own and the toolchains it runs; so every credential
 * there is unreadable without a list of their names to keep current. His clones and the workspace's data stay unreadable
 * wherever they are. The sandbox's own proxy checks each connection's host and resolves it outside the sandbox;
 * strictAllowlist makes it refuse any other host itself rather than ask.
 */
export function sandboxSettings(
  runRoot: string,
  protectedPaths: string[],
  home = homedir(),
  shared: string[] = [],
  more: { cacheDir?: string; toolchains?: string[]; gitDirs?: string[]; readOnlyDirs?: string[] } = {},
): NonNullable<Options['sandbox']> {
  const cache = more.cacheDir ? [more.cacheDir] : [];
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: SANDBOX_DOMAINS, strictAllowlist: true },
    filesystem: {
      // The run's own folder (its temp folder inside it), the ticket folder, and the shared caches: nothing else, /tmp included.
      allowWrite: [runRoot, ...shared, ...cache],
      // What the daemon's own git trusts in a run's clone: it runs git there, outside the sandbox, with its own environment, so
      // whatever a shell plants in these runs there (core.fsmonitor or a filter in the config, a hook such as pre-push or
      // reference-transaction). Found by a review: the SDK protects .git/config on its own, but not hooks or info.
      denyWrite: [...guardedGitPaths(more.gitDirs ?? []), ...(more.readOnlyDirs ?? [])],
      denyRead: [
        home,
        // Said again by name, so a later change to the home rule cannot quietly open them.
        join(home, '.ssh'),
        join(home, '.config', 'gh'),
        join(home, '.claude'),
        join(home, '.claude.json'),
        join(home, '.npmrc'),
        join(home, '.aws'),
        join(home, '.kube'),
        join(home, '.docker'),
        ...protectedPaths,
      ],
      allowRead: [runRoot, ...shared, ...cache, ...(more.toolchains ?? toolchainReads(home))],
    },
  };
}

/** Each run's temp folder, inside its run folder: commands and agents use it instead of /tmp. */
export const runTmp = (runRoot: string): string => join(runRoot, '.tmp');

/** The run's TMPDIR as a real path, read at each decision: a link put in its place cannot point it elsewhere unseen. */
function realTmp(runRoot: string): string {
  try {
    return realpathSync(runTmp(runRoot));
  } catch {
    return runTmp(runRoot);
  }
}

/** The longest TMPDIR whose claude-socks-<16 hex>.sock still fits a Unix socket path (107 characters). */
export const MAX_TMPDIR = 73;

export class AgentRun {
  phase: 'starting' | 'working' | 'idle' | 'ended' = 'starting';
  private ending: Promise<RunOutcome> | undefined;
  private q: Query | undefined;
  private readonly input = new TurnInput();
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly decisions = new Map<string, Gate>();
  private readonly running = new Set<string>(); // live sub-agents
  private readonly pendingTasks = new Map<string, { task: string; toolUseId: string }[]>(); // subagent_type -> Agent calls waiting to start
  private waiting = 0;
  private activeMs = 0;
  private activeSince: number | undefined;
  private timer: unknown;
  private step: Step | null = null;
  private lastNote = '';
  private finalText: string[] = [];
  /** When the run was made: commits on its branch from before then were made by someone else. */
  private readonly createdAt: number;
  private interrupted = false;
  /** An interrupt was sent and the turn it cut short has not ended yet: that turn's result is not the run's end. */
  private cutShort = false;
  private reported: AgentReport | undefined;
  /** "<repo> #<n> was merged" once its PR was merged or closed: with a cancellation, what closes a run, so its folder may go. */
  private prClosed: string | undefined;
  private closedAtEnd = false;
  /** The agent's goal and the checks that prove the ticket done, with their evidence. */
  private plan: { revision: number; goal: string; checks: CheckState[] } | undefined;
  /** Steps formed so far; the open one is the current step. */
  private readonly steps: { index: number; name: Step; open: boolean }[] = [];
  /** Live sub-agents: who started them, their model, when, and what they have used. */
  private readonly subRecords = new Map<string, { startedAt: number; parentToolUseId?: string; tokens: number; toolCalls: number; type?: string }>();
  /** Tokens so far (input, output, cache writes), from each assistant message; the result's total wins if larger. */
  private tokens = 0;
  /** Each API response's usage as counted so far, by message id; and the response each agent is streaming. */
  private readonly responses = new Map<string, { input: number; output: number; cache: number }>();
  private readonly streaming = new Map<string, string>();
  private lastUsage = { tokens: -1, seconds: -1 };
  private ciTimer: unknown;
  private readingCi = false;
  /** CI changed while it was being read: read it again straight after, instead of a minute later. */
  private ciAgain = false;
  private readonly unsubscribeUsage: () => void;
  // Reporting (milestone 11): heartbeats owed, loops, a budget nearly spent.
  private heartbeatAt = 0; // working minutes at the last heartbeat
  private heartbeatReminded = false;
  private heartbeatFlagged = false;
  private readonly commandRepeats = new Map<string, number>();
  private readonly loopFlagged = new Set<string>();
  private readonly beats: Array<{ tokens: number; steps: number; evidence: number }> = [];
  private tokenLoopFlagged = false;
  private budgetFlagged = false;
  private evidence = 0;
  // Intervention (milestone 12): paused by someone, guidance waiting for resume, a re-plan owed.
  private paused: { by: Actor; wasWorking: boolean } | undefined;
  private guidance: Array<{ text: string; by: Actor }> = [];
  private replan: { calls: number; reminded: boolean } | undefined;
  /** Calls held for something other than alex's answer (his AWS session): the working clock stops meanwhile. */
  private held = 0;
  /** Questions Elfoqsy is looking into before they reach alex: the clock stops, the run is not waiting. */
  private considering = 0;
  /** Its question was withdrawn after 72 hours and it paused: Resume says so. */
  private withdrawn = false;
  /** Paths a file ask touches that resolve inside the run folder, by tool call: Elfoqsy decides those. */
  private readonly insideAsks = new Set<string>();
  /** What it decided itself and recorded: its "Decisions I made". */
  private readonly assumptions: Array<{ assumptionId: string; text: string; flag?: string }> = [];
  /** A task agent's results. */
  private delivered = 0;
  /** Proxy calls by tool name, oldest first, so a tool's handler knows which call it serves. */
  private readonly proxyCalls = new Map<string, string[]>();
  /** The ticket workflow: the verdict gate, the mode, input classes, the review, rounds, hypotheses. */
  readonly workflow: TicketWorkflow;
  /** Paused for the plan's usage limit (shown paused by the workspace). */
  private limitPaused = false;
  /** Writes other people read that were held once with the writing rules, by request: the same request again is sent. */
  private readonly heldWrites = new Set<string>();

  constructor(
    readonly spec: RunSpec,
    private readonly deps: RunDeps,
    private readonly onEnd: (run: AgentRun, outcome: RunOutcome) => void,
  ) {
    this.clock = deps.clock ?? realClock;
    this.now = deps.now ?? Date.now;
    this.createdAt = spec.createdAt ?? this.now();
    this.workflow = new TicketWorkflow(ticketKind(spec.ticket.type, spec.mode ?? 'normal', !!spec.task), spec.mode ?? 'normal', spec.reviewDir);
    this.unsubscribeUsage = deps.usage.onChange((paused) => this.onUsage(paused));
  }

  get runId(): string {
    return this.spec.runId;
  }

  /** Counts against MAX_PARALLEL_AGENTS: working or waiting for Alex, not idle at CI or review. */
  get isActive(): boolean {
    return this.phase === 'starting' || this.phase === 'working';
  }

  start(): void {
    const s = this.spec;
    this.input.push(
      s.task
        ? taskPrompt({
            task: s.task,
            runRoot: s.runRoot,
            repos: s.repos,
            policies: this.deps.policies,
            subagents: Object.keys(subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts)),
            maxSubagents: this.deps.limits.maxSubagents,
            heartbeatMinutes: this.heartbeatEvery,
            environments: this.deps.environments,
            ...(s.rules?.length ? { rules: s.rules } : {}),
          })
        : runPrompt({
        ticket: s.ticket,
        linked: s.linked,
        ...(s.goal ? { goal: s.goal } : {}),
        ...(s.brief ? { brief: s.brief } : {}),
        ...(s.handoff ? { handoff: s.handoff } : {}),
        ...(s.reviewDir ? { reviewDir: s.reviewDir } : {}),
        mode: s.mode ?? 'normal',
        ...(s.ticketDir ? { ticketDir: s.ticketDir } : {}),
        ...(s.skill?.adapter ? { skill: { dir: s.skill.dir, hash: s.skill.hash, skillMd: s.skill.skillMd, adapter: s.skill.adapter } } : {}),
        ...(s.rules?.length ? { rules: s.rules } : {}),
        branch: s.branch,
        repos: s.repos,
        policies: this.deps.policies,
        subagents: Object.keys(subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts)),
        maxSubagents: this.deps.limits.maxSubagents,
        heartbeatMinutes: this.heartbeatEvery,
        ...(s.inherited?.length ? { inherited: s.inherited } : {}),
        environments: this.deps.environments,
      }),
    );
    this.deps.proxies.register(this.proxyRun);
    this.q = this.deps.queryFn({ prompt: this.input, options: this.options() });
    this.setWorking();
    this.timer = this.clock.setTimeout(() => this.checkBudget(), BUDGET_CHECK_MS);
    void this.consume(this.q);
  }

  /** A new turn for the agent: a CI failure, a message from alex through Elfoqsy, or the go-ahead after a usage limit. */
  forward(text: string): void {
    if (this.phase === 'ended') return;
    if (this.phase === 'idle') this.setWorking();
    this.reported = undefined; // a new turn needs a new result
    this.input.push(redact(text));
  }

  cancel(reason: string): Promise<RunOutcome> {
    return this.end('cancelled', reason);
  }

  /** It ended closed: cancelled, or its PR merged or closed. A failure closes once it is dismissed. */
  get closed(): boolean {
    return this.closedAtEnd;
  }

  /** The session options. Exported shape is tested: model, effort, isolation, sandbox, no credentials. */
  options(): Options {
    const home = homedir();
    return {
      model: (this.deps.ticketAgent ?? TICKET_AGENT).model,
      effort: (this.deps.ticketAgent ?? TICKET_AGENT).effort,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      // The web is on for the agent itself, checked before every request leaves; never for its sub-agents.
      agents: subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts),
      mcpServers: { [RUN_TOOLS]: this.runTools() },
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        // Evidence for command checks: a Bash command that exited 0, or one that failed.
        PostToolUse: [{ hooks: [this.postToolUse] }],
        PostToolUseFailure: [{ hooks: [this.postToolUse] }],
        SubagentStart: [{ hooks: [this.subagentStart] }],
        SubagentStop: [{ hooks: [this.subagentStop] }],
      },
      canUseTool: this.canUseTool,
      permissionMode: 'default',
      settingSources: [], // none of Alex's settings, and not the repo's: its hooks never run
      ...skillOptions(this.spec.abilities), // the Abilities skills, or none (not even Claude Code's own)
      strictMcpConfig: true,
      persistSession: false,
      includePartialMessages: true, // message_delta: the output tokens of a response while it streams, for the budget
      // Never alex's own Claude Code memory. No co-author line from Claude Code itself: the commit-msg hook
      // gives each commit exactly one, TRAILER, and the push check holds every commit to it.
      settings: { autoMemoryEnabled: false, attribution: { commit: '', pr: '', sessionUrl: false }, ...(this.spec.abilities ? SKILL_SETTINGS : {}) },
      cwd: this.spec.runRoot,
      env: {
        ...this.deps.baseEnv,
        // Its traces to the daemon's own receiver, tagged with the run (telemetry/env.ts); nothing leaves the machine.
        ...telemetryEnv({ kind: this.spec.task ? 'task' : 'ticket', runId: this.spec.runId, ticket: this.spec.ticket.key, agentNumber: this.spec.agentNumber }),
        ...agentGitEnv(this.spec.identity),
        GH_CONFIG_DIR: join(this.spec.runRoot, '.no-gh'), // gh finds no login here
        npm_config_update_notifier: 'false',
        // The run's own temp folder, which agents may read; /tmp itself stays behind the gate. Claude Code
        // creates the sandbox's socket files here too, hence MAX_TMPDIR.
        TMPDIR: runTmp(this.spec.runRoot),
        TMP: runTmp(this.spec.runRoot),
        TEMP: runTmp(this.spec.runRoot),
        // The package caches are Elfoqsy's own, shared between runs, and not his ~/.npm or ~/.cache.
        ...(this.deps.cacheDir ? cacheEnv(this.deps.cacheDir) : {}),
        // Its own kubeconfig and AWS files, in a folder its sandbox cannot read or write: nothing it runs (shop.sh,
        // aws configure) can change alex's global kube context or AWS profile.
        ...this.privateFiles(),
        // The team-dev skill reads both: which run holds the ticket folder, and the one co-author line its commits carry.
        ELFOQSY_RUN_ID: this.spec.runId,
        COAUTHOR_TRAILER: TRAILER,
      },
      taskBudget: { total: this.deps.limits.maxTokens },
      sandbox: sandboxSettings(this.spec.runRoot, this.deps.protectedPaths, home, this.spec.ticketDir && this.workflow.mode !== 'read_only' ? [this.spec.ticketDir] : [], {
        ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
        gitDirs: this.spec.repos.map((r) => join(r.path, '.git')),
        // The reviewer's pack: what it is held to is not the run's to rewrite from a shell.
        ...(this.spec.reviewDir ? { readOnlyDirs: [this.spec.reviewDir] } : {}),
      }),
    };
  }

  /** KUBECONFIG and the AWS CLI's files, in the run's private folder; without a kubeconfig, files that do not exist. */
  private privateFiles(): Record<string, string> {
    const dir = this.spec.kubeconfig ? join(this.spec.kubeconfig, '..') : join(this.spec.runRoot, '.no-cloud');
    return {
      KUBECONFIG: this.spec.kubeconfig ?? join(dir, 'kubeconfig'),
      AWS_CONFIG_FILE: join(dir, 'aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws-credentials'),
    };
  }

  /** The run as the proxies know it. */
  private get proxyRun(): ProxyRun {
    return {
      runId: this.spec.runId,
      ticket: this.spec.ticket.key,
      agentNumber: this.spec.agentNumber,
      branch: this.spec.branch,
      targets: this.spec.repos.filter((r) => r.role === 'target').map((r) => ({ repo: r.repo, base: r.base })),
      kubeconfig: this.privateFiles().KUBECONFIG!,
      ...(this.spec.test ? { test: true } : {}),
      root: this.spec.runRoot,
      clones: this.spec.repos.map((r) => ({ repo: r.repo, path: r.path })),
      hold: (reason, until) => this.hold(reason, until),
      asking: (answer) => this.waitForHim(answer),
    };
  }

  /**
   * The shell gate for this run: tests, edits and commits in the run folder are free; everything remote is a proxy's.
   * agentId: the sub-agent calling, whose role decides first; absent for the ticket agent itself.
   */
  gate(tool: string, input: Record<string, unknown>, cwd: string, agentId?: string): Gate {
    if (tool === SANDBOX_NETWORK) {
      const host = typeof input.host === 'string' ? input.host.slice(0, 200) : 'That host';
      return { behavior: 'deny', reason: `${host} is not one of the hosts commands may reach (${SANDBOX_DOMAINS.join(', ')}). Use the proxy tools for anything remote.` };
    }
    if (agentId) {
      const refused = this.roleProblem(agentId, tool, input);
      if (refused) return { behavior: 'deny', reason: refused };
    } else if (tool.startsWith(`mcp__${RUN_TOOLS}__`)) return { behavior: 'allow' };
    if (AGENT_TOOLS.has(tool)) return this.gateSubagent(input);
    if (tool === 'Skill') {
      const refused = skillRefusal(input, this.spec.abilities);
      return refused ? { behavior: 'deny', reason: refused } : { behavior: 'allow' };
    }
    if (WEB_TOOLS.has(tool)) return this.gateWeb(tool, input);
    const workflow = this.workflowGate(tool, input, cwd);
    if (workflow) return { behavior: 'deny', reason: workflow };
    const d = decide(tool, input, {
      worktree: this.spec.runRoot,
      branch: this.spec.branch,
      hosts: this.deps.hosts,
      cwd,
      protectedPaths: this.deps.protectedPaths,
      tmpDir: realTmp(this.spec.runRoot),
      ...(this.deps.home ? { home: this.deps.home } : {}),
      ...(this.spec.ticketDir || this.deps.cacheDir ? { shared: [...(this.spec.ticketDir ? [this.spec.ticketDir] : []), ...(this.deps.cacheDir ? [this.deps.cacheDir] : [])] } : {}),
    });
    // The sandbox cannot reach other hosts, so an approval would not help: say so instead of asking.
    if (d.behavior === 'ask' && d.kind === 'network') {
      return { behavior: 'deny', reason: `${d.reason} Agents cannot reach it from their sandbox: use the kube, aws, gh, jira, confluence or logs tool, or ask alex with ask_user.` };
    }
    // A sub-agent works inside the run folder only: a push, a file outside it, anything that would be asked, is
    // the ticket agent's.
    if (agentId && d.behavior === 'ask') {
      return { behavior: 'deny', reason: `${d.reason} A sub-agent works inside the run folder only; a push, or anything outside the folder, is the ticket agent's. Report it in your result.` };
    }
    return d;
  }

  /**
   * The ticket workflow's say on an edit or a commit: the verdict so far, the mode, the input classes. Scratch files in
   * .tmp are free; the skill's copy is never written. A reason to refuse, or null.
   */
  private workflowGate(tool: string, input: Record<string, unknown>, cwd: string): string | null {
    if (EDIT_TOOLS.has(tool)) {
      const raw = String(input.file_path ?? input.notebook_path ?? '');
      if (!raw) return null;
      const home = this.deps.home ?? homedir();
      const path = resolve(cwd, raw.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home));
      const under = (dir: string) => !relative(dir, path).startsWith('..') && !relative(dir, path).startsWith('/');
      if (this.spec.skill && under(this.spec.skill.dir)) return 'The team-dev skill here is a read-only copy; nothing in it may change.';
      if (this.spec.abilities && under(this.spec.abilities.dir)) return 'The skills here are a read-only copy; nothing in them may change.';
      if (this.spec.reviewDir && under(this.spec.reviewDir)) return "The reviewer's pack (the ticket's handoff and acceptance criteria) is read-only; nothing in it may change.";
      if (this.spec.ticketDir && under(this.spec.ticketDir)) return this.workflow.ticketFolderEdit();
      if (under(runTmp(this.spec.runRoot))) return null;
      const repo = this.spec.repos.find((r) => r.role === 'target' && under(r.path));
      if (repo) return this.workflow.repoEdit(relative(repo.path, path));
      if (this.workflow.mode === 'read_only' && under(this.spec.runRoot)) return 'Read-only mode: no edits at all.';
      return null;
    }
    if (tool === 'Bash' && /\bgit\b[^\n;&|]*\s(commit|merge|rebase|cherry-pick|revert|am)\b/.test(String(input.command ?? ''))) return this.workflow.commit();
    return null;
  }

  /** A sub-agent's role: the reviewer reads, workers read, edit and run commands. One the run does not know gets the strictest. */
  private roleOf(agentId: string): 'reviewer' | 'worker' {
    const type = this.subRecords.get(agentId)?.type;
    if (!type || type === REVIEWER) return 'reviewer';
    return Object.keys(subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts)).includes(type) ? 'worker' : 'reviewer';
  }

  /**
   * What a sub-agent may not do, checked on every call by who is calling: no run tools or proxies (gh
   * included), no web, no sub-agents of its own; the reviewer reads files and has no shell. Null when its role allows it.
   */
  private roleProblem(agentId: string, tool: string, input: Record<string, unknown>): string | null {
    const role = this.roleOf(agentId);
    const who = role === 'reviewer' ? 'The reviewer' : 'A worker';
    if (tool.startsWith('mcp__')) return `${who} has no run tools and no proxies (gh, jira, kube and the rest are the ticket agent's): report what is needed in your result instead.`;
    if (AGENT_TOOLS.has(tool)) return `${who} cannot start sub-agents.`;
    if (WEB_TOOLS.has(tool)) return `${who} has no web.`;
    if (tool === 'ToolSearch') return null;
    if (role === 'reviewer') {
      // By configuration the reviewer is not even offered a shell or a writer (subagents.ts); this is the second check, on every call.
      if (EDIT_TOOLS.has(tool)) return 'The reviewer reads only: no edits.';
      if (!REVIEWER_TOOLS.includes(tool)) return `The reviewer has no shell and nothing that writes: it may use ${REVIEWER_TOOLS.join(', ')} only.`;
      return null;
    }
    return WORKER_TOOLS.includes(tool) ? null : `A worker may use read, edit and shell tools only (${WORKER_TOOLS.join(', ')}).`;
  }

  /** WebSearch and WebFetch: free for the agent, once the redactor finds nothing in the request that must not leave. */
  private gateWeb(tool: string, input: Record<string, unknown>): Gate {
    if (!this.deps.outbound) return { behavior: 'deny', reason: 'The web is not set up here.' };
    const target = tool === 'WebFetch' ? { url: String(input.url ?? '') } : { query: String(input.query ?? '') };
    const verdict = checkOutbound(target, this.deps.outbound);
    return verdict.ok ? { behavior: 'allow' } : this.webRefused(verdict.reason);
  }

  private webRefused(reason: string): Gate {
    return { behavior: 'deny', reason: `Not sent: ${reason} Nothing of alex's (secrets, internal hosts, repository paths, code, encoded data) may leave through the web. Ask without it.` };
  }

  /** A fetch the gate let through, with its host looked up: a public name for a private address is refused. */
  private async resolvedWeb(input: Record<string, unknown>): Promise<Gate> {
    if (!this.deps.outbound?.resolve) return { behavior: 'allow' };
    const verdict = await checkOutboundResolved({ url: String(input.url ?? '') }, this.deps.outbound);
    return verdict.ok ? { behavior: 'allow' } : this.webRefused(verdict.reason);
  }

  /**
   * Whether every path a file tool names resolves, symlinks followed and from the call's own folder, inside the run
   * folder or its temp folder: such an ask is Elfoqsy's to decide. A shell command is never resolved here.
   */
  private insideRun(tool: string, input: Record<string, unknown>, cwd: string): boolean {
    if (tool !== 'Read' && tool !== 'Write' && tool !== 'Edit' && tool !== 'MultiEdit' && tool !== 'NotebookEdit' && tool !== 'Glob' && tool !== 'Grep' && tool !== 'LS') return false;
    const home = this.deps.home ?? homedir();
    const expand = (raw: string) => resolve(cwd, raw.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home));
    const paths = [input.file_path, input.notebook_path, input.path].filter((v): v is string => typeof v === 'string' && v.length > 0).map(expand);
    // A Glob's pattern can name a place of its own: an absolute one, or one that climbs out with "..", counts too.
    const pattern = tool === 'Glob' && typeof input.pattern === 'string' ? input.pattern : undefined;
    if (pattern && (pattern.startsWith('/') || pattern.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(pattern))) {
      const root = pattern.split('/').slice(0, pattern.split('/').findIndex((seg) => /[*?[{]/.test(seg))).join('/') || '/';
      paths.push(pattern.startsWith('/') || pattern.startsWith('~') ? expand(root) : resolve(paths[0] ?? cwd, root));
    }
    if (!paths.length) return false;
    const roots = [realpathSync(this.spec.runRoot), realTmp(this.spec.runRoot)];
    return paths.every((path) => {
      let real = path;
      try {
        real = realpathSync(path);
      } catch {
        try {
          real = join(realpathSync(resolve(path, '..')), path.split('/').pop() ?? '');
        } catch {
          return false;
        }
      }
      return roots.some((root) => real === root || real.startsWith(`${root}/`));
    });
  }

  private gateSubagent(input: Record<string, unknown>): Gate {
    const names = Object.keys(subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts));
    const type = typeof input.subagent_type === 'string' ? input.subagent_type : '';
    if (!names.includes(type)) return { behavior: 'deny', reason: `Use one of the run's sub-agents by name: ${names.join(', ')}.` };
    if (input.model !== undefined || input.effort !== undefined) {
      return { behavior: 'deny', reason: 'Pick the model and effort by choosing the sub-agent by name; do not override them.' };
    }
    if (input.isolation !== undefined) return { behavior: 'deny', reason: 'Sub-agents work in this run folder; isolation is not available.' };
    if (this.running.size >= this.deps.limits.maxSubagents) {
      return { behavior: 'deny', reason: `${this.running.size} sub-agents are already running, the most a run may have. Wait for one to finish.` };
    }
    return { behavior: 'allow' };
  }

  private readonly preToolUse: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    let d = this.gate(input.tool_name, toolInput, input.cwd || this.spec.runRoot, input.agent_id);
    if (d.behavior === 'allow' && input.tool_name === 'WebFetch') d = await this.resolvedWeb(toolInput);
    this.decisions.set(input.tool_use_id, d);
    if (d.behavior === 'ask' && d.kind === 'outside_worktree' && this.insideRun(input.tool_name, toolInput, input.cwd || this.spec.runRoot)) this.insideAsks.add(input.tool_use_id);
    const where = whereIn(this.spec.runRoot, input.cwd || this.spec.runRoot);
    this.deps.log.append('agent', 'tool.called', {
      runId: this.spec.runId,
      ...(input.agent_id ? { subagentId: input.agent_id } : {}),
      toolUseId: input.tool_use_id,
      tool: input.tool_name,
      title: toolTitle(input.tool_name, toolInput, this.spec.runRoot),
      ...(where ? { where } : {}),
      inputSummary: JSON.stringify(toolInput).slice(0, 200),
      allowed: d.behavior !== 'deny',
      ...(d.behavior === 'allow' && d.note ? { outside: redact(d.note) } : {}),
    });
    if (d.behavior !== 'deny') this.watchCall(input.tool_name, toolInput, input.agent_id);
    if (input.tool_name.startsWith(`mcp__${RUN_TOOLS}__`)) {
      const name = input.tool_name.slice(`mcp__${RUN_TOOLS}__`.length);
      if ((PROXY_TOOLS as string[]).includes(name)) this.proxyCalls.set(name, [...(this.proxyCalls.get(name) ?? []), input.tool_use_id]);
    }
    if (d.behavior === 'allow' && AGENT_TOOLS.has(input.tool_name)) {
      const type = String(toolInput.subagent_type);
      const task = String(toolInput.description ?? type);
      this.pendingTasks.set(type, [...(this.pendingTasks.get(type) ?? []), { task, toolUseId: input.tool_use_id }]);
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: d.behavior,
        ...(d.behavior !== 'allow' ? { permissionDecisionReason: d.reason } : {}),
      },
    };
  };

  /**
   * Evidence for command checks, from what Claude Code reports after each tool call: a Bash command that ran a
   * check's command exactly passed (exit 0) or failed. A pass records the fingerprint of the run's code.
   */
  private readonly postToolUse: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {};
    this.recordResult(input);
    this.recordTestRun(input);
    if (!this.plan || input.tool_name !== 'Bash') return {};
    const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? '');
    const matching = this.plan.checks.filter((c) => c.check.proof === 'command' && runsExactly(command, c.check.command ?? ''));
    if (!matching.length) return {};
    const at = hhmm(this.now());
    if (input.hook_event_name === 'PostToolUse') {
      const r = (input.tool_response ?? {}) as { interrupted?: boolean; backgroundTaskId?: string; timedOutAfterMs?: number };
      if (r.interrupted || r.backgroundTaskId || r.timedOutAfterMs) return {}; // it did not finish here: no evidence either way
      const fingerprint = await this.fingerprint();
      for (const c of matching) this.setCheck(c, 'passed', `\`${c.check.command}\` passed at ${at}.`, fingerprint);
    } else if (!input.is_interrupt) {
      for (const c of matching) this.setCheck(c, 'failed', `\`${c.check.command}\` failed at ${at}: ${firstLine(input.error, 80)}.`);
    }
    return {};
  };

  /**
   * A test-shaped Bash command and how it ended, seen by the orchestrator itself (N1): the narrative's failing and passing
   * evidence. Nothing a model says: the command, whether it exited cleanly, its last lines, and the counts a known runner prints.
   */
  private recordTestRun(input: Extract<HookInput, { hook_event_name: 'PostToolUse' | 'PostToolUseFailure' }>): void {
    if (input.tool_name !== 'Bash' || this.spec.task) return;
    const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? '').trim();
    if (!command || !isTestCommand(command)) return;
    const failed = input.hook_event_name === 'PostToolUseFailure';
    if (failed && input.is_interrupt) return;
    const r = (failed ? {} : ((input as { tool_response?: unknown }).tool_response ?? {})) as { stdout?: unknown; stderr?: unknown; interrupted?: boolean; backgroundTaskId?: string; timedOutAfterMs?: number };
    if (!failed && (r.interrupted || r.backgroundTaskId || r.timedOutAfterMs)) return; // it did not finish here
    const output = failed ? String((input as { error?: unknown }).error ?? '') : [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n');
    const parsed = parseTestOutput(output);
    const ok = !failed && !(parsed.failed && parsed.failed > 0); // a pipe can hide a failing exit; the runner's own count cannot
    this.deps.log.append('orchestrator', 'run.test_run', {
      runId: this.spec.runId,
      ...(input.agent_id ? { subagentId: input.agent_id } : {}),
      toolUseId: input.tool_use_id,
      command: redact(command).slice(0, 600),
      ok,
      ...(input.duration_ms !== undefined ? { durationMs: input.duration_ms } : {}),
      summary: redact(testExcerpt(output, ok)),
      ...(parsed.passed !== undefined ? { passed: parsed.passed } : {}),
      ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}),
      ...(parsed.failedNames?.length ? { failedNames: parsed.failedNames.map((n) => redact(n)) } : {}),
    });
  }

  /** How a tool call ended: in the agent's transcript, or in its sub-agent's record. */
  private recordResult(input: Extract<HookInput, { hook_event_name: 'PostToolUse' | 'PostToolUseFailure' }>): void {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const failed = input.hook_event_name === 'PostToolUseFailure';
    const { outputSummary, stats, diff } = summarizeToolResult(input.tool_name, failed ? { error: input.error } : { response: input.tool_response });
    const sub = input.agent_id ? this.subRecords.get(input.agent_id) : undefined;
    if (input.agent_id && sub) {
      sub.toolCalls += 1;
      this.deps.log.append('agent', 'subagent.tool_called', {
        runId: this.spec.runId,
        subagentId: input.agent_id,
        toolUseId: input.tool_use_id,
        tool: input.tool_name,
        inputSummary: toolTitle(input.tool_name, toolInput, this.spec.runRoot),
        outputSummary,
        ok: !failed,
        ...(stats ? { stats } : {}),
      });
      return;
    }
    this.deps.log.append('agent', 'tool.finished', {
      runId: this.spec.runId,
      toolUseId: input.tool_use_id,
      ok: !failed,
      outputSummary,
      ...(stats ? { stats } : {}),
      ...(input.duration_ms !== undefined ? { durationMs: input.duration_ms } : {}),
      ...(diff ? { diff } : {}),
    });
  }

  /** begin_step: the work changed nature. The open step ends first, done unless the agent says otherwise. */
  private beginStep(name: Step, why: string, previous?: { outcome: StepOutcome; note?: string }): void {
    this.endOpenStep(previous?.outcome ?? 'done', previous?.note);
    const index = this.steps.length;
    this.steps.push({ index, name, open: true });
    this.step = name;
    this.replan = undefined; // re-planned
    this.deps.log.append('agent', 'run.step_begun', { runId: this.spec.runId, stepIndex: index, name, why });
  }

  private endOpenStep(outcome: StepOutcome, note?: string): void {
    const open = this.steps.find((s) => s.open);
    if (!open) return;
    open.open = false;
    this.step = null;
    this.deps.log.append('agent', 'run.step_ended', { runId: this.spec.runId, stepIndex: open.index, outcome, ...(note ? { note } : {}) });
  }

  /** Tokens and working time for the run's meters, when either has moved. */
  private reportUsage(): void {
    const seconds = Math.round(this.activeMinutes() * 60);
    if (this.tokens === this.lastUsage.tokens && seconds === this.lastUsage.seconds) return;
    this.lastUsage = { tokens: this.tokens, seconds };
    this.deps.log.append('orchestrator', 'run.usage', { runId: this.spec.runId, tokens: this.tokens, workingSeconds: seconds });
  }

  /**
   * The run's code as one fingerprint: every repository's tracked and untracked files (repoFingerprints). null
   * when it cannot be read, which no evidence can match.
   */
  private async fingerprint(): Promise<string | null> {
    const parts = await this.repoFingerprints();
    return parts.some((p) => p.tree === null) ? null : parts.map((p) => `${p.repo}:${p.tree}`).join(' ');
  }

  private repoFingerprints(): Promise<Array<{ repo: string; tree: string | null }>> {
    return Promise.all(this.spec.repos.map(async (r) => ({ repo: r.repo, tree: await treeFingerprint(this.deps.git, r.path).catch(() => null) })));
  }

  /**
   * Evidence is used (at the end, in report_result, after a plan change): any check whose code has changed since
   * it passed goes back to pending, however the files changed.
   */
  private async freshen(): Promise<void> {
    // An external approval (a Confluence page, a decision) is not about the code: code changes leave it standing.
    const passed = this.plan?.checks.filter((c) => c.status === 'passed' && !(c.check.proof === 'approval' && c.check.scope === 'external')) ?? [];
    if (!passed.length) return;
    const whole = await this.fingerprint();
    const byRepo = new Map((await this.repoFingerprints()).map((p) => [p.repo, p.tree]));
    for (const c of passed) {
      const now = c.check.proof === 'ci' ? (byRepo.get(c.check.repo ?? '') ?? null) : whole;
      if (now === null || now !== c.fingerprint) this.setCheck(c, 'pending', 'Stale: the code changed after it passed, so it has to pass again.');
    }
  }

  /**
   * Evidence for ci checks, read per commit: the named repo's branch head, once it is on GitHub, and what CI says
   * about that commit (check runs and statuses). It counts only while the working tree is exactly that commit.
   */
  async refreshCi(): Promise<void> {
    const ciChecks = this.plan?.checks.filter((c) => c.check.proof === 'ci') ?? [];
    if (!ciChecks.length || !this.deps.commitCi || this.phase === 'ended') return;
    if (this.readingCi) {
      this.ciAgain = true;
      return;
    }
    this.readingCi = true;
    try {
      for (const c of ciChecks) {
        const target = this.spec.repos.find((r) => r.role === 'target' && r.repo === c.check.repo);
        if (!target?.url) continue;
        const head = await this.headOf(target);
        const remote = head ? await remoteBranchSha(this.deps.git, target.url, this.spec.branch).catch(() => null) : null;
        if (!head || remote !== head) {
          this.setCheck(c, 'pending', `Waiting for ${this.spec.branch}${head ? ` at ${head.slice(0, 7)}` : ''} to be on GitHub in ${target.repo}.`);
          continue;
        }
        const ci = await this.deps.commitCi(target.repo, head).catch(() => null);
        if (!ci) continue; // GitHub could not be read: no change either way
        const where = `${target.repo} at ${head.slice(0, 7)}`;
        if (ci.state === 'failure') this.setCheck(c, 'failed', `CI on ${where}: ${ci.summary}.`);
        else if (ci.state !== 'success') this.setCheck(c, 'pending', `CI on ${where}: ${ci.summary}.`);
        else {
          const tree = await treeFingerprint(this.deps.git, target.path).catch(() => null);
          if (tree && tree === (await commitTree(this.deps.git, target.path, head))) this.setCheck(c, 'passed', `CI on ${where}: ${ci.summary}.`, tree);
          else this.setCheck(c, 'pending', `CI passed on ${where}, but the files there have changed since that commit.`);
        }
      }
    } finally {
      this.readingCi = false;
      if (this.ciAgain) {
        this.ciAgain = false;
        void this.refreshCi();
      } else this.scheduleCi();
    }
  }

  /** Reads CI again in a minute while a ci check has no passing evidence. */
  private scheduleCi(): void {
    if (this.ciTimer !== undefined) this.clock.clearTimeout(this.ciTimer);
    this.ciTimer = undefined;
    const waiting = this.plan?.checks.some((c) => c.check.proof === 'ci' && c.status !== 'passed');
    if (waiting && this.deps.commitCi && this.phase !== 'ended') this.ciTimer = this.clock.setTimeout(() => void this.refreshCi(), CI_POLL_MS);
  }

  private headOf(repo: PreparedRepo): Promise<string | null> {
    return this.deps.git.tryRun(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${this.spec.branch}`]);
  }

  private setCheck(c: CheckState, status: CheckStatus, evidence: string, fingerprint?: string | null): void {
    if (status === 'passed') c.fingerprint = fingerprint ?? null;
    else delete c.fingerprint;
    if (c.status === status && c.evidence === evidence) return;
    c.status = status;
    c.evidence = evidence;
    if (status === 'passed') this.evidence++;
    this.deps.log.append('orchestrator', 'run.check_changed', { runId: this.spec.runId, checkId: c.check.id, status, evidence });
  }

  /** declare_goal: the agent's goal and done-when checks. A check that is unchanged keeps its evidence. */
  private declareGoal(goal: string, checks: PlanCheck[]): string | null {
    const targets = this.spec.repos.filter((r) => r.role === 'target').map((r) => r.repo);
    if (new Set(checks.map((c) => c.id)).size !== checks.length) return 'Each check needs a different id.';
    for (const c of checks) {
      if (c.proof === 'command' && !c.command) return `Check ${c.id} is proven by a command: give the command.`;
      if (c.proof !== 'command' && c.command) return `Check ${c.id} is proven by ${c.proof}, not by a command: leave out command.`;
      if (c.proof === 'ci' && !targets.includes(c.repo ?? '')) return `Check ${c.id} is proven by CI: name its repo, one of ${targets.join(', ')}.`;
      if (c.proof !== 'ci' && c.repo) return `Check ${c.id} is proven by ${c.proof}, not by CI: leave out repo.`;
      if (c.proof !== 'approval' && c.scope) return `Check ${c.id} is proven by ${c.proof}, not by approval: leave out scope.`;
    }
    const before = this.plan;
    const revision = (before?.revision ?? 0) + 1;
    this.plan = {
      revision,
      goal,
      checks: checks.map((check) => {
        const same = before?.checks.find((o) => o.check.id === check.id && o.check.proof === check.proof && o.check.command === check.command && o.check.repo === check.repo && o.check.scope === check.scope);
        return same ? { ...same, check } : { check, status: 'pending' };
      }),
    };
    this.deps.log.append('agent', 'run.goal_declared', { runId: this.spec.runId, revision, goal, checks });
    if (revision > 1) this.note(`Changed its checks (revision ${revision}): ${checks.map(describeCheck).join('; ')}.`);
    return null;
  }

  private readonly canUseTool: CanUseTool = async (tool, input, options): Promise<PermissionResult> => {
    const d = this.decisions.get(options.toolUseID) ?? this.gate(tool, input, this.spec.runRoot, options.agentID);
    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
    if (d.behavior === 'deny') return { behavior: 'deny', message: d.reason };
    if (d.kind === 'push') {
      if (options.agentID) return { behavior: 'deny', message: "A sub-agent never pushes: that is the ticket agent's." };
      const { result, pushed } = await this.pushNow(options.toolUseID);
      if (result.behavior === 'deny') this.endUnrun(tool, input, options, result.message, pushed);
      return result;
    }
    if (d.kind !== 'outside_worktree') return { behavior: 'deny', message: `${d.reason} Use the proxy tools for anything remote.` };
    if (options.agentID) return { behavior: 'deny', message: `${d.reason} A sub-agent works inside the run folder only.` };
    // A file outside the run folder (written, or read in alex's home): tier 2, decided by Elfoqsy when every path
    // resolves inside the run folder after all, else asked or covered by a grant.
    const c: Classified = { tier: 2, kind: 'file.outside', summary: d.action.slice(0, 300), reason: d.reason };
    const category: DelegationCategory | undefined = this.insideAsks.delete(options.toolUseID) ? 'run_folder' : undefined;
    const gate = await this.deps.proxies.gate(this.proxyRun, 'file', c, { toolUseId: options.toolUseID, approvalKind: 'outside_worktree', ...(category ? { category } : {}) });
    if (gate.allowed) return { behavior: 'allow', updatedInput: input };
    this.endUnrun(tool, input, options, gate.message, false);
    return { behavior: 'deny', message: gate.message };
  };

  /** A call asked about and then not run by the SDK: no hook reports its end, so the answer is its end. */
  private endUnrun(tool: string, input: Record<string, unknown>, options: { toolUseID: string; agentID?: string }, message: string, ok: boolean): void {
    const sub = options.agentID ? this.subRecords.get(options.agentID) : undefined;
    if (options.agentID && sub) {
      sub.toolCalls += 1;
      this.deps.log.append('agent', 'subagent.tool_called', {
        runId: this.spec.runId,
        subagentId: options.agentID,
        toolUseId: options.toolUseID,
        tool,
        inputSummary: toolTitle(tool, input, this.spec.runRoot),
        outputSummary: message,
        ok,
      });
      return;
    }
    this.deps.log.append('agent', 'tool.finished', { runId: this.spec.runId, toolUseId: options.toolUseID, ok, outputSummary: message });
  }

  /**
   * git push stops here and the orchestrator pushes the run branch itself, at once: tier 1, recorded, and reported by
   * Elfoqsy in one line. Its commits are checked first: every one an agent made carries exactly one co-author line.
   */
  private async pushNow(toolUseId: string): Promise<{ result: PermissionResult; pushed: boolean }> {
    const { git, proxies } = this.deps;
    const branch = this.spec.branch;
    const targets = this.spec.repos.filter((r) => r.role === 'target');
    const ahead: Array<{ repo: PreparedRepo; count: number }> = [];
    for (const repo of targets) {
      const count = await unpushedCount(git, repo, branch).catch(() => 0);
      if (count > 0) ahead.push({ repo, count });
    }
    if (!ahead.length) return { result: { behavior: 'deny', message: `Nothing to push: ${branch} has no commits that GitHub lacks.` }, pushed: false };
    const notYet = this.workflow.pushProblem();
    if (notYet) return { result: { behavior: 'deny', message: notYet }, pushed: false };
    const subjects = await this.wrongSubjects(ahead.map((a) => a.repo));
    if (subjects) return { result: { behavior: 'deny', message: subjects }, pushed: false };
    const refused = await this.coAuthorsFixed(ahead.map((a) => a.repo));
    if (refused) return { result: { behavior: 'deny', message: refused }, pushed: false };
    this.recordReviewFlags();
    const prOpen = this.deps.hasOpenPr(this.spec.ticket.key, targets.map((t) => t.repo));
    const rounds = prOpen && this.deps.reviewRounds ? await this.deps.reviewRounds(this.spec.ticket.key, targets.map((t) => t.repo)).catch(() => 0) : 0;
    if (this.workflow.roundNeedsApproval(rounds)) {
      const answer = await this.askAlex(
        'round',
        `Agent ${this.spec.agentNumber} on ${this.spec.ticket.key} has had ${rounds} bot-review rounds on its PR and wants to push for another. Another round, or stop the rounds here?`,
        'another bot-review round',
      );
      if (answer.decision !== 'approved' || (answer.test && !this.spec.test)) {
        return { result: { behavior: 'deny', message: `${answeredBy(answer)} stopped the bot-review rounds here${answer.answer ? `: ${answer.answer}` : '.'} Do not push again; list the review comments left in your summary.` }, pushed: false };
      }
      this.workflow.extraRounds++;
    }
    const names = ahead.map((a) => a.repo.repo.split('/')[1] ?? a.repo.repo);
    const commits = ahead.reduce((n, a) => n + a.count, 0);
    const c: Classified = {
      tier: 1,
      kind: 'git.push',
      summary: `git push origin ${branch} (${ahead.map((a) => `${a.repo.repo}, ${plural(a.count, 'commit')}`).join('; ')})`,
      reason: "Pushing the run's own branch is done at once and reported.",
    };
    const gate = await proxies.gate(this.proxyRun, 'git', c, { toolUseId });
    if (!gate.allowed) return { result: { behavior: 'deny', message: gate.message }, pushed: false };
    const before: string[] = [];
    for (const { repo } of ahead) {
      const url = await git.tryRun(['-C', repo.path, 'remote', 'get-url', 'origin']);
      const sha = url ? await remoteBranchSha(git, url, branch).catch(() => null) : null;
      before.push(`${repo.repo}: ${sha ? `at ${sha.slice(0, 7)}` : 'not on GitHub'}`);
    }
    const madeBefore = await this.madeBefore(ahead.map((a) => a.repo));
    // What this push carries, read from git before it goes (afterwards GitHub has the commits): the narrative's change per file.
    const carried = await pushedFacts(git, ahead.map((a) => a.repo), branch).catch(() => []);
    const outcome = await proxies.perform(
      this.proxyRun,
      c,
      gate.actionId,
      async () => {
        try {
          for (const { repo } of ahead) await pushBranch(git, repo, branch, this.agentMade);
        } catch (error) {
          return { ok: false, output: `The push failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        return { ok: true, output: `Pushed ${branch} to ${names.join(', ')}.`, done: `pushed ${branch} to ${names.join(', ')} (${plural(commits, 'commit')}${madeBefore.en ? `; ${madeBefore.en}` : ''})`, doneVi: `đã push ${branch} lên ${names.join(', ')} (${commits} commit${madeBefore.vi ? `; ${madeBefore.vi}` : ''})` };
      },
      {
        record: async () => ({
          target: `${branch} on GitHub`,
          before: before.join('; '),
          noUndo: 'Taking a push back would need a force-push, which only alex may do.',
        }),
      },
    );
    if (!outcome.ok) return { result: { behavior: 'deny', message: outcome.output }, pushed: false };
    this.workflow.pushed();
    if (carried.length && !outcome.notSent) this.deps.log.append('orchestrator', 'run.pushed', { runId: this.spec.runId, repos: carried });
    if (outcome.notSent) {
      this.note(`Would have pushed ${branch} to ${ahead.map((a) => a.repo.repo).join(', ')} (a tester's run: not sent).`);
      return { result: { behavior: 'deny', message: `Not pushed: this is a tester's run, where pushes are logged as they would be and not sent. Carry on as if ${branch} was pushed; no CI will run on it.` }, pushed: true };
    }
    this.note(`Pushed ${branch} to ${ahead.map((a) => a.repo.repo).join(', ')}.`);
    void this.refreshCi(); // the pushed commit is what ci checks now wait for
    return {
      result: {
        behavior: 'deny',
        message: `The orchestrator pushed ${branch} to ${ahead.map((a) => a.repo.repo).join(', ')} at once (tier 1; Elfoqsy told alex). Do not run git push again until you have new commits.`,
      },
      pushed: true,
    };
  }

  /**
   * What the review before the first push found (a contract change, a cache bypass) no longer stops the push: it
   * is recorded as a flagged assumption, listed under "Decisions I made", and alex decides it at review.
   */
  private recordReviewFlags(): void {
    for (const f of this.workflow.reviewFlags()) this.recordAssumption(f.text, [], f.flag, 'review');
  }

  /** The agent's commits whose subject does not start with the ticket key (his team's form), as the refusal; or null. */
  private async wrongSubjects(repos: PreparedRepo[]): Promise<string | null> {
    const key = this.spec.ticket.key;
    const wrong: string[] = [];
    for (const repo of repos) {
      const log = await unpushedLog(this.deps.git, repo, this.spec.branch).catch(() => []);
      for (const c of log) {
        if (c.subject.startsWith(`${key}: `) || !this.agentMade({ committedAt: c.committedAt, email: c.email })) continue;
        wrong.push(`${c.sha} "${c.subject}"${repos.length > 1 ? ` in ${repo.repo}` : ''}`);
      }
    }
    if (!wrong.length) return null;
    return `The push was refused: each of your commits starts with "${key}: ", then what it does in the imperative (one subject line, no body). These do not: ${wrong.join('; ')}. Reword them (git commit --amend -m for the last one, or git rebase with --exec), then run git push again.`;
  }

  /** An agent's commit, by the "who made it" timing rule; alex's own commits are pushed untouched. */
  private readonly agentMade: AgentMade = ({ committedAt, email }) => {
    const by = this.deps.madeBy?.(committedAt, email);
    return by === undefined || /^Agent \d+$/.test(by);
  };

  /**
   * Every commit an agent made has exactly one co-author line, TRAILER. Those that do not are rewritten in the
   * run's clone (their messages only) and the push is refused, so the next push is asked about as it will go.
   * alex's own commits are not checked and keep their messages. Returns the refusal for the agent, or null.
   */
  private async coAuthorsFixed(repos: PreparedRepo[]): Promise<string | null> {
    const { git } = this.deps;
    const branch = this.spec.branch;
    const fixed: string[] = [];
    for (const repo of repos) {
      const wrong = await wrongCoAuthors(git, repo, branch, this.agentMade);
      if (!wrong.length) continue;
      const list = wrong.map((w) => `${w.sha} "${w.subject}" (${w.problem})`).join('; ') + (repos.length > 1 ? ` in ${repo.repo}` : '');
      try {
        await fixCoAuthors(git, repo, branch, this.agentMade);
      } catch (error) {
        return `The push was refused: every commit you make must carry exactly one co-author line, ${TRAILER}, and these do not: ${list}. They could not be fixed (${error instanceof Error ? error.message : String(error)}); amend them yourself, then run git push again.`;
      }
      fixed.push(list);
    }
    if (!fixed.length) return null;
    this.note(`Refused a push: commits without exactly one co-author line, ${TRAILER}. Their messages were fixed in the run's clone.`);
    return `The push was refused: every commit you make must carry exactly one co-author line, ${TRAILER}, and these did not: ${fixed.join('; ')}. The orchestrator rewrote their messages in your clone; files, authors and dates are unchanged, so only the commit ids changed. Do not add Co-Authored-By lines yourself. Run git push again.`;
  }

  /**
   * The commits a push carries that this run did not make (it started from another run's kept work), every one with
   * who made it, for Elfoqsy's line about the push. Empty when there are none.
   */
  private async madeBefore(repos: PreparedRepo[]): Promise<{ en: string; vi: string }> {
    const lines: string[] = [];
    for (const repo of repos) {
      const log = await unpushedLog(this.deps.git, repo, this.spec.branch).catch(() => []);
      for (const c of log.filter((c) => c.committedAt < this.createdAt)) {
        const by = this.deps.madeBy?.(c.committedAt, c.email) ?? 'unknown';
        lines.push(`${c.sha} "${c.subject}" (${by}${repos.length > 1 ? `, ${repo.repo}` : ''})`);
      }
    }
    if (!lines.length) return { en: '', vi: '' };
    return { en: `${lines.length === 1 ? '1 of them' : `${lines.length} of them`} made before this run: ${lines.join('; ')}`, vi: `${lines.length} trong số đó được tạo trước lượt chạy này: ${lines.join('; ')}` };
  }

  /**
   * ask_user: the card goes to Elfoqsy first. Her answer comes with what it rests on; his, or the tester's,
   * as given. What the agent reads back says who answered.
   */
  private async ask(card: QuestionCard): Promise<string> {
    const responder = this.deps.firstResponder?.();
    const wait = <T>(p: Promise<T>): Promise<T> => this.waitForHim(p);
    if (!responder) {
      const r = await wait(this.deps.approvals.request({ runId: this.spec.runId, ticket: this.spec.ticket.key, kind: 'question', question: `Agent ${this.spec.agentNumber} on ${this.label} asks: ${card.question}`, card, precedentable: true }));
      return answerText(r);
    }
    const outcome = await this.whileConsidered(responder.question(this.spec.runId, card, wait));
    if (outcome.decision) {
      const d = outcome.decision;
      const from = d.sources.map((x) => (x.label ? `${x.label} (${x.ref})` : `${x.kind} ${x.ref}`)).join(', ');
      return `Elfoqsy answered for alex: ${d.option}${d.note ? `: ${d.note}` : ''}. From: ${from}. He can change it; you would be told.`;
    }
    return answerText(outcome.resolution);
  }

  /** A decision the agent made itself (or the review found), recorded with its evidence for "Decisions I made". */
  private recordAssumption(text: string, evidence: SourceRef[], flag: PayloadOf<'run.assumption'>['flag'], by: 'agent' | 'review'): string {
    const same = this.assumptions.find((a) => a.text === text);
    if (same) return same.assumptionId;
    const assumptionId = `as-${ulid().toLowerCase()}`;
    this.assumptions.push({ assumptionId, text, ...(flag ? { flag } : {}) });
    this.deps.log.append('agent', 'run.assumption', { runId: this.spec.runId, assumptionId, text: redact(text), evidence, ...(flag ? { flag } : {}), by });
    return assumptionId;
  }

  /** What screens and questions call this run: its ticket, or a task agent's name. */
  private get label(): string {
    return this.spec.task?.name ?? this.spec.ticket.key;
  }

  private askAlex(kind: ApprovalKind, question: string, action?: string): Promise<Resolution> {
    return this.waitForHim(this.deps.approvals.request({ runId: this.spec.runId, ticket: this.spec.ticket.key, kind, question, ...(action ? { action } : {}) }));
  }

  /**
   * "Mark ready for review" from the narrative (N1): his tick on it and his click are the approval, so the draft PRs of this
   * run's ticket are marked ready once, through the gh proxy, logged like any action. Stops at the first that fails.
   */
  async markReady(prs: Array<{ repo: string; number: number }>, by: 'you' | 'tester'): Promise<{ ok: true } | { ok: false; message: string }> {
    for (const pr of prs) {
      const answer = await this.deps.proxies.approvedRequest(this.proxyRun, 'gh', { args: ['pr', 'ready', String(pr.number), '--repo', pr.repo] }, `Marked ready for review from the narrative, asked by ${by === 'you' ? 'alex' : 'the tester'}.`);
      if (!answer.ok) return { ok: false, message: answer.text };
    }
    return { ok: true };
  }

  /** The tool call a proxy tool's handler serves: from the call's metadata when Claude Code sends it, else the oldest. */
  private proxyCallId(proxy: string, extra: unknown): string | undefined {
    const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const sent = typeof meta?.['claudecode/toolUseId'] === 'string' ? (meta['claudecode/toolUseId'] as string) : undefined;
    const queue = this.proxyCalls.get(proxy) ?? [];
    if (sent) {
      const i = queue.indexOf(sent);
      if (i >= 0) queue.splice(i, 1);
      return sent;
    }
    return queue.shift();
  }

  /** The ticket's words, as Jira has them now when it can be read, for the reported symptom. */
  private async ticketWords(): Promise<string> {
    const t = this.spec.ticket;
    const synced = `${t.summary}\n${t.description}`;
    const live = this.deps.ticketText ? await this.deps.ticketText(t.key).catch(() => '') : '';
    return `${synced}\n${live}`;
  }

  /**
   * report_verdict: checked against the gate's rules, logged, and the orchestrator posts it in chat. An example for an
   * unclear ticket or a story is put to alex at once; the answer is the agent's. When the verdict first lets it
   * change code, the repo's CI ruleset and rules come with the answer.
   */
  private async reportVerdict(v: VerdictReport): Promise<{ text: string } | { error: string }> {
    const problem = this.workflow.verdictProblem(v, await this.ticketWords());
    if (problem) return { error: problem };
    this.workflow.setVerdict(v);
    this.deps.log.append('agent', 'run.verdict', {
      runId: this.spec.runId,
      verdict: v.verdict,
      reproduced: v.reproduced,
      summary: v.summary,
      evidence: v.findings.flatMap((f) => f.sources).slice(0, 12),
      findings: v.findings,
      ...(v.symptom ? { symptom: v.symptom } : {}),
      ...(v.sibling ? { sibling: v.sibling } : {}),
      ...(v.siblingAt ? { siblingAt: v.siblingAt } : {}),
      ...(v.chain?.length ? { chain: v.chain } : {}),
      ...(v.example ? { example: v.example } : {}),
      ...(v.ticketComment ? { ticketComment: v.ticketComment } : {}),
    });
    const parts = [`Verdict recorded: ${verdictWords(v)}.`];
    // An ambiguous ticket's or a story's example no longer waits for his confirmation: it goes on, flagged.
    if (v.example && !STOPPING_VERDICTS.has(v.verdict)) {
      this.recordAssumption(`Expected behaviour: ${v.example.input} -> ${v.example.output}`, v.findings.flatMap((f) => f.sources).slice(0, 6), 'expected_behaviour', 'agent');
      parts.push('Your example is recorded under "Decisions I made", flagged for alex to decide at review; go on with it.');
    }
    const stopping = this.workflow.stopping;
    if (stopping) {
      parts.push('No code changes: the run stops when this turn ends. Note what you found in case.md if your mode allows, call report_result (blocked) with one sentence, and end your turn.');
    } else if (this.workflow.editsOpen && !this.workflow.rulesShown) {
      this.workflow.rulesShown = true;
      const targets = this.spec.repos.filter((r) => r.role === 'target').map((r) => ({ repo: r.repo, path: r.path }));
      const next = this.workflow.repoEdit('src/x.ts');
      parts.push(`${next ?? 'You may change code now.'}\n\nBefore your first code change, read the repo's CI review ruleset and rules below, then declare every input class the change will see (declare_inputs).\n\n${rulesetText(targets)}`);
    } else {
      parts.push(this.workflow.repoEdit('src/x.ts') ?? 'You may change code now.');
    }
    return { text: parts.join(' ') };
  }

  /**
   * A proxy request. Every write other people read (a PR, Jira, Confluence) comes back once, unsent, with alex's
   * writing rules from the skill's copy, as the skill says to re-read them right before every such write; the same
   * request again is sent, a corrected one is held the same way. Every such write must point to its evidence.
   */
  private async proxyRequest(proxy: ProxyName, asked: unknown, toolUseId?: string) {
    const targets = this.spec.repos.filter((r) => r.role === 'target').map((r) => r.path);
    // A PR's description and Jira's Root cause and Solution are the narrative's (N1): what the agent wrote there is replaced by
    // what its reports say, or the request is refused with the report it owes. Everything else is as the agent asked.
    const produced = this.spec.task || this.workflow.mode === 'read_only' ? { input: asked } : fromNarrative(proxy, asked, this.deps.narrative?.());
    if ('refusal' in produced) return { ok: false, text: produced.refusal };
    const input = produced.input;
    const write = externalWrite(proxy, input, [this.spec.runRoot, ...targets]);
    if (write && this.workflow.mode === 'read_only') return { ok: false, text: 'Read-only mode: nothing is written to GitHub, Jira or Confluence. Put it in your summary.' };
    // Its own decisions go into the PR description, flagged ones first.
    const mine = [...this.assumptions].sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0)).map((a) => `${a.flag ? `[${a.flag}] ` : ''}${a.text}`);
    const missing = decisionsMissing(proxy, input, [this.spec.runRoot, ...targets], mine);
    if (missing) return { ok: false, text: missing };
    if (write) {
      const rules = this.spec.skill ? join(this.spec.skill.dir, 'references', 'writing.md') : undefined;
      const key = createHash('sha256').update(`${proxy}\0${JSON.stringify(asked)}`).digest('hex');
      if (rules && existsSync(rules) && !this.heldWrites.has(key)) {
        this.heldWrites.add(key);
        return {
          ok: false,
          text: `Not sent yet. Every ${write.what} write follows alex's writing rules (team-dev references/writing.md, version ${this.spec.skill!.hash}), and each claim in it points to its evidence. Check this text against them now: send the same request again to send it, or a corrected one, which comes back the same way.${'note' in produced && produced.note ? `\n\n${produced.note}` : ''}\n\n${readFileSync(rules, 'utf8')}`,
        };
      }
      if (write.text.trim() && !hasEvidence(write.text)) {
        return { ok: false, text: `Not sent: every claim in a ${write.what} write points to its evidence, in the text: a link, a file and line, a ticket or PR, a commit, a log query or an id. Add it, then send the request again.` };
      }
    }
    const answer = await this.deps.proxies.request(this.proxyRun, proxy, input, toolUseId);
    return 'note' in produced && produced.note && answer.ok ? { ...answer, text: `${answer.text}\n\n${produced.note.split('\n')[0]}` } : answer;
  }

  /** Tools the agent uses to report and ask, and the orchestrator's capability proxies; in-process, scoped to this run. */
  private runTools() {
    const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });
    const key = this.spec.ticket.key;
    const who = `Agent ${this.spec.agentNumber} on ${key}`;
    const SOURCE = z.object({ kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']), ref: z.string().trim().min(1).max(500), label: z.string().max(120).optional() });
    const clean = (x: { kind: SourceRef['kind']; ref: string; label?: string | undefined }): SourceRef => ({ kind: x.kind, ref: x.ref, ...(x.label ? { label: x.label } : {}) });
    return createSdkMcpServer({
      name: RUN_TOOLS,
      version: '0.7.0',
      // Long enough for alex's answer: the orchestrator withdraws a question at 72 hours, before this ends it.
      timeout: RUN_TOOL_TIMEOUT_MS,
      tools: [
        tool(
          'declare_goal',
          'Declare your goal and the checks that will prove this ticket is done, early (once you understand the ticket) and again whenever the checks change. Each check is proven by a command (that exact command passes here), ci (CI passes on your branch head in the repo you name, once pushed) or approval (alex approves it, for what the orchestrator cannot see; scope code, the default, or external for things outside the code such as a Confluence page or a decision). Evidence holds only while the code is as it was when the check passed, except an external approval.',
          {
            goal: z.string().trim().min(1).max(300),
            checks: z
              .array(
                z.object({
                  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
                  description: z.string().trim().min(1).max(160),
                  proof: z.enum(['command', 'ci', 'approval']),
                  command: z.string().trim().min(1).max(300).optional(),
                  repo: z.string().trim().min(1).optional(),
                  scope: z.enum(['code', 'external']).optional(),
                }),
              )
              .min(1)
              .max(8),
          },
          async ({ goal, checks }) => {
            const problem = this.declareGoal(
              goal,
              checks.map((c) => ({
                id: c.id,
                description: c.description,
                proof: c.proof,
                ...(c.command ? { command: c.command } : {}),
                ...(c.repo ? { repo: c.repo } : {}),
                ...(c.scope ? { scope: c.scope } : c.proof === 'approval' ? { scope: 'code' as const } : {}),
              })),
            );
            if (problem) return { ...text(problem), isError: true };
            await this.freshen(); // evidence kept from the last declaration must still match the code
            void this.refreshCi();
            return text(`Goal and checks recorded (revision ${this.plan!.revision}).`);
          },
        ),
        tool(
          'begin_step',
          'Begin a step when the nature of your work changes: from investigating to changing code, from changing to verifying, from local work to waiting on CI, or when you take a new direction. Not for every tool call. It ends your previous step: done, unless you say it was abandoned or failed.',
          {
            name: z.string().trim().min(1).max(32),
            why: z.string().trim().min(1).max(300),
            previous: z.object({ outcome: z.enum(['done', 'abandoned', 'failed']), note: z.string().trim().max(300).optional() }).optional(),
          },
          async ({ name, why, previous }) => {
            this.beginStep(name, why, previous ? { outcome: previous.outcome, ...(previous.note ? { note: previous.note } : {}) } : undefined);
            return text(`Step ${this.steps.length}: ${name}.`);
          },
        ),
        tool(
          'heartbeat',
          `Report every ${plural(this.heartbeatEvery, 'minute')} of work: what you did since the last report, what comes next, how far you think you are, and any risks.`,
          {
            sinceLast: z.string().trim().min(1).max(500),
            next: z.string().trim().min(1).max(300),
            progress: z.enum(['none', 'some', 'most', 'nearly']),
            risks: z.array(z.string().trim().min(1).max(200)).max(6),
          },
          async ({ sinceLast, next, progress, risks }) => {
            this.deps.log.append('agent', 'run.heartbeat', {
              runId: this.spec.runId,
              step: this.step ?? 'Getting started',
              sinceLast,
              next,
              progress,
              risks,
              tokens: this.tokens,
              workingSeconds: Math.round(this.activeMinutes() * 60),
            });
            this.onHeartbeat();
            return text('Recorded.');
          },
        ),
        tool(
          'report_result',
          'Report how this turn ended, before it ends: succeeded, failed or blocked, and one sentence. The run counts as succeeded only when every check you declared has passing evidence. notVerified: everything you did not verify (a real environment you could not reach, a flow you could not run, a visual check still pending), each one line, or [] when nothing; waitingOnYou: what alex has to do next, each one line, or []. Both are shown to him in the ticket\'s narrative as you say them. unmet: when the review called an acceptance criterion NOT MET, its number and why it cannot be met here; succeeded is refused while one is NOT MET and has no reason here (meet it and run the review again, or say why), and every one is shown to alex in the narrative\'s Verification.',
          {
            result: z.enum(['succeeded', 'failed', 'blocked']),
            summary: z.string().trim().min(1).max(300),
            notVerified: z.array(z.string().trim().min(1).max(300)).max(10),
            waitingOnYou: z.array(z.string().trim().min(1).max(300)).max(10),
            unmet: z.array(z.object({ n: z.number().int().min(1), why: z.string().trim().min(12).max(400) })).max(20).optional(),
          },
          async (report) => {
            // A run is not reported succeeded while an acceptance criterion is NOT MET, unless the agent says why that one cannot be met here.
            const problem = this.workflow.reportProblem(report.result, report.unmet ?? []);
            if (problem) return { ...text(`Not recorded: ${problem}`), isError: true };
            this.reported = report;
            if (!this.spec.task) {
              this.deps.log.append('agent', 'run.reported', {
                runId: this.spec.runId,
                result: report.result,
                summary: report.summary,
                notVerified: report.notVerified,
                waitingOnYou: report.waitingOnYou,
                ...(report.unmet?.length ? { unmet: report.unmet } : {}),
              });
            }
            await this.freshen();
            const open = this.plan?.checks.filter((c) => c.status !== 'passed').map((c) => c.check.id) ?? [];
            const base = this.plan ? (open.length ? `Recorded. Checks without passing evidence: ${open.join(', ')}.` : 'Recorded. Every check has passing evidence.') : 'Recorded. You have not declared your goal and checks.';
            // Its reasons go into the PR description under "Not verified here", which is written from the narrative: an open PR has to be edited to say so.
            const said = report.unmet?.length && !this.spec.task && this.deps.hasOpenPr(this.spec.ticket.key, this.spec.repos.filter((r) => r.role === 'target').map((r) => r.repo));
            return text(said ? `${base} Your reasons for criterion ${report.unmet!.map((u) => u.n).join(', ')} go into the PR description under "Not verified here": edit the PR (gh pr edit with any body; it is written from your reports) so it says so.` : base);
          },
        ),
        tool(
          'request_check_approval',
          'Ask alex to approve an approval check of your plan, with the evidence he needs (what you did, where to see it). Only his approval counts.',
          { check: z.string().min(1), evidence: z.string().trim().min(1).max(1000) },
          async ({ check, evidence }) => {
            const c = this.plan?.checks.find((x) => x.check.id === check);
            if (!c) return { ...text(`No check ${check} in your plan.`), isError: true };
            if (c.check.proof !== 'approval') {
              return { ...text(`${check} is proven by ${c.check.proof === 'ci' ? 'CI' : 'its command'}, which the orchestrator sees itself.`), isError: true };
            }
            const answer = await this.askAlex('check', `${who} says "${c.check.description}" is done: ${evidence}`, `check ${c.check.id}`);
            if (answer.decision === 'approved' && !answer.test) {
              this.setCheck(c, 'passed', `alex approved it at ${hhmm(this.now())}.`, await this.fingerprint());
              return text('Approved; the check has passing evidence.');
            }
            if (answer.decision === 'approved') {
              this.setCheck(c, 'pending', 'The tester approved it, but only alex can.');
              return text('The tester approved it, which does not count: only alex can approve a check.');
            }
            this.setCheck(c, 'failed', `${answeredBy(answer)} declined it${answer.answer ? `: ${answer.answer}` : '.'}`);
            return text(`${answeredBy(answer)} declined it.`);
          },
        ),
        tool(
          'ask_user',
          "Ask only before an action that touches other people or a shared environment in a way your PR cannot undo. Decide everything else yourself and record it with record_assumption. The question reaches Elfoqsy first: she answers it from sources where she can, else hands it to alex with her recommendation. Ask it as a card: question (one line), why (at most three short points), options (two to four, each a label and its consequence), recommendation (one of the labels) and your sources. A free-form block of text is refused. Wait for the answer.",
          {
            question: z.string().optional(),
            why: z.array(z.string()).optional(),
            options: z.array(z.object({ label: z.string().optional(), consequence: z.string().optional() })).optional(),
            recommendation: z.string().optional(),
            sources: z.array(z.object({ kind: z.string().optional(), ref: z.string().optional(), label: z.string().optional() })).optional(),
          },
          async (input) => {
            const made = questionCard(input);
            if ('problems' in made) return { ...text(`Not asked: ${made.problems.join(' ')} Ask again as a card.`), isError: true };
            return text(await this.ask(made.card));
          },
        ),
        tool(
          'record_assumption',
          'Record a decision you made yourself instead of asking, with the evidence it rests on. It goes under "Decisions I made" in your hand-back and your PR description. Flag what alex decides at review: contract (a visible contract changes), cache_bypass, teammate_code (teammates\' code in a hotfix), expected_behaviour (your expected behaviour for an ambiguous ticket or a story).',
          {
            text: z.string().trim().min(1).max(400),
            evidence: z.array(z.object({ kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']), ref: z.string().trim().min(1).max(500), label: z.string().max(120).optional() })).max(6),
            flag: z.enum(['contract', 'cache_bypass', 'teammate_code', 'expected_behaviour']).optional(),
          },
          async ({ text: what, evidence, flag }) => {
            const id = this.recordAssumption(what, evidence.map((x) => ({ kind: x.kind, ref: x.ref, ...(x.label ? { label: x.label } : {}) })), flag, 'agent');
            return text(`Recorded (${id}). List it under "Decisions I made" in your hand-back${this.spec.task ? '' : ' and your PR description'}.${flag ? ' Flagged: alex decides it at review.' : ''}`);
          },
        ),
        ...(this.spec.task
          ? [
        tool(
          'deliver',
          "Hand back the task's result, into alex's conversation: a document (Markdown), a table (a Markdown table) or code, with a short title. The run counts as succeeded only once it is delivered. Deliver once; again only for a corrected version.",
          { kind: z.enum(['document', 'table', 'code']), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(60_000), language: z.string().trim().max(30).optional() },
          async ({ kind, title, content, language }) => {
            if (kind !== this.spec.task!.deliverable) return { ...text(`This task's deliverable is ${this.spec.task!.deliverable}, not ${kind}.`), isError: true };
            const deliverableId = `dl-${ulid().toLowerCase()}`;
            this.deps.log.append('agent', 'task.delivered', { runId: this.spec.runId, deliverableId, kind, title, content: redact(content), ...(language ? { language } : {}) });
            this.delivered++;
            this.deps.say?.(tr(`Agent ${this.spec.agentNumber} delivered ${this.spec.task!.name}: ${title}.`, `Agent ${this.spec.agentNumber} đã giao ${this.spec.task!.name}: ${title}.`), [{ type: 'deliverable', ref: deliverableId }]);
            return text('Delivered into the conversation. Call report_result, list "Decisions I made" if any, and end your turn.');
          },
        ),
            ]
          : [
        tool(
          'report_verdict',
          'Your verdict on the ticket, before any code change, in the team-dev validity labels, with what shows it; again whenever it changes (for example once the bug is reproduced). VALID (a bug): the reported symptom, quoted word for word from the ticket in symptom, reproduced or not yet, the path to the fault as chain (the calls from where the failing input enters to the fault, in order, each a path:line, the last with role fault), compared with a similar case that works (sibling and where it is, siblingAt; or "none: why"); for an ambiguous ticket add one example (input and output), which goes on as a flagged decision for alex to review. NEW_BEHAVIOR (a story or task): the expected behaviour as one example, recorded the same way. VALID_FINDING (remediation): the scanner finding, reproduced from its inputs. ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID and INSUFFICIENT_EVIDENCE/NOT_REPRODUCED stop the run; for those, ticketComment is what you propose to post on the ticket (for INSUFFICIENT_EVIDENCE, the open question). Every finding needs a source.',
          {
            verdict: z.enum(['VALID', 'ALREADY_FIXED', 'EXPECTED_BEHAVIOR/INVALID', 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED', 'NEW_BEHAVIOR', 'VALID_FINDING']),
            reproduced: z.boolean(),
            summary: z.string().trim().min(1).max(600),
            symptom: z.string().trim().max(600).optional(),
            sibling: z.string().trim().max(600).optional(),
            siblingAt: SOURCE.optional(),
            chain: z.array(z.object({ ref: z.string().trim().min(1).max(300), role: z.enum(['entry', 'hop', 'fault']), note: z.string().trim().max(200).optional() })).max(12).optional(),
            example: z.object({ input: z.string().trim().min(1).max(1000), output: z.string().trim().min(1).max(1000) }).optional(),
            ticketComment: z.string().trim().max(1500).optional(),
            findings: z
              .array(z.object({ text: z.string().trim().min(1).max(500), sources: z.array(z.object({ kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']), ref: z.string().trim().min(1).max(500), label: z.string().max(120).optional() })).min(1).max(6) }))
              .min(1)
              .max(10),
          },
          async (v) => {
            const report: VerdictReport = {
              verdict: v.verdict,
              reproduced: v.reproduced,
              summary: v.summary,
              findings: v.findings.map((f) => ({ text: f.text, sources: f.sources.map((x) => ({ kind: x.kind, ref: x.ref, ...(x.label ? { label: x.label } : {}) })) })),
              ...(v.symptom ? { symptom: v.symptom } : {}),
              ...(v.sibling ? { sibling: v.sibling } : {}),
              ...(v.siblingAt ? { siblingAt: { kind: v.siblingAt.kind, ref: v.siblingAt.ref, ...(v.siblingAt.label ? { label: v.siblingAt.label } : {}) } } : {}),
              ...(v.chain?.length ? { chain: v.chain.map((l) => ({ ref: l.ref, role: l.role, ...(l.note ? { note: l.note } : {}) })) } : {}),
              ...(v.example ? { example: v.example } : {}),
              ...(v.ticketComment ? { ticketComment: v.ticketComment } : {}),
            };
            const answer = await this.reportVerdict(report);
            return 'error' in answer ? { ...text(answer.error), isError: true } : text(answer.text);
          },
        ),
        tool(
          'report_understanding',
          'Before your verdict: what the ticket claims and what you understood of it. claim: what it says is wrong or wanted, quoted word for word from the ticket (summary, description or a comment); input: what goes in; actual: what comes out today; expected: what should come out. Each one or two sentences, with sources (the ticket and the fields or comments you read). It is shown to alex as section 1 of the ticket\'s narrative, as you say it.',
          {
            claim: z.string().trim().min(1).max(600),
            input: z.string().trim().min(1).max(600),
            actual: z.string().trim().min(1).max(600),
            expected: z.string().trim().min(1).max(600),
            sources: z.array(SOURCE).min(1).max(6),
          },
          async (u) => {
            const wrong = codeRefProblem(u.sources, 'sources');
            if (wrong) return { ...text(wrong), isError: true };
            if (!quotedFrom(u.claim, await this.ticketWords())) {
              return { ...text(`claim must be quoted from the ticket, word for word (its summary, description or a comment); "${u.claim.slice(0, 120)}" is not in it. Say what the ticket claims in its own words; what you conclude comes after, in your verdict.`), isError: true };
            }
            this.workflow.understood = true;
            this.deps.log.append('agent', 'run.understanding', { runId: this.spec.runId, claim: u.claim, input: u.input, actual: u.actual, expected: u.expected, sources: u.sources.map(clean) });
            return text('Recorded. Now your verdict (report_verdict), with the path to the fault if it is a bug.');
          },
        ),
        tool(
          'report_reproduction',
          'When you have reproduced the bug (or failed to): how and where. how: what you did; environment: where it ran (local with the runner, or dev, staging, integration, with the build or version); test: the failing test\'s file and name, if there is one; command: the exact command that fails, so the orchestrator\'s record of that run is its failing evidence; requestIds: request or trace ids from real logs. Shown in section 3 of the narrative.',
          {
            how: z.string().trim().min(1).max(500),
            environment: z.string().trim().min(1).max(200),
            test: z.object({ path: z.string().trim().min(1).max(300), name: z.string().trim().min(1).max(300) }).optional(),
            command: z.string().trim().min(1).max(300).optional(),
            requestIds: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
          },
          async (r) => {
            if (!this.workflow.verdict) return { ...text('Report your verdict first (report_verdict).'), isError: true };
            this.deps.log.append('agent', 'run.reproduction', { runId: this.spec.runId, how: r.how, environment: r.environment, ...(r.test ? { test: r.test } : {}), ...(r.command ? { command: r.command } : {}), ...(r.requestIds?.length ? { requestIds: r.requestIds } : {}) });
            return text('Recorded.');
          },
        ),
        tool(
          'report_root_cause',
          'The root cause, once you know it (not a hypothesis: report those with report_hypothesis). text: a short explanation; lines: the exact lines it rests on, each a code source path:line or path:line-line. Shown in section 4 of the narrative, and it is what Root cause in Jira and the PR description say.',
          { text: z.string().trim().min(1).max(600), lines: z.array(SOURCE).min(1).max(8) },
          async (c) => {
            if (!this.workflow.verdict) return { ...text('Report your verdict first (report_verdict).'), isError: true };
            const wrong = codeRefProblem(c.lines, 'lines');
            if (wrong) return { ...text(wrong), isError: true };
            if (!c.lines.some((l) => l.kind === 'code')) return { ...text('lines needs at least one code source, path:line: where the cause is.'), isError: true };
            this.deps.log.append('agent', 'run.root_cause', { runId: this.spec.runId, text: c.text, lines: c.lines.map(clean) });
            return text('Recorded.');
          },
        ),
        tool(
          'report_approach',
          'Your fix\'s approach, before you change code (and again if it changes): approach: what you will do and why it fixes the cause; alternatives: the other fixes you weighed, each with why you did not take it ([] when there were none). Shown in section 5 of the narrative, and it is what Solution in Jira and the PR description say.',
          {
            approach: z.string().trim().min(1).max(600),
            alternatives: z.array(z.object({ option: z.string().trim().min(1).max(300), rejectedBecause: z.string().trim().min(1).max(300) })).max(6),
          },
          async (a) => {
            if (!this.workflow.verdict) return { ...text('Report your verdict first (report_verdict).'), isError: true };
            this.deps.log.append('agent', 'run.approach', { runId: this.spec.runId, approach: a.approach, alternatives: a.alternatives });
            return text('Recorded.');
          },
        ),
        tool(
          'declare_inputs',
          'Before your first code change: every input class the change will see (message and config types, synthetic, retry and timeout results, log shapes), after reading the repo\'s CI ruleset and rules. Again if the list changes.',
          { classes: z.array(z.string().trim().min(1).max(200)).min(1).max(20) },
          async ({ classes }) => {
            if (!this.workflow.verdict) return { ...text('Report your verdict first (report_verdict).'), isError: true };
            this.workflow.inputs = classes;
            this.deps.log.append('agent', 'run.inputs_declared', { runId: this.spec.runId, classes });
            const next = this.workflow.repoEdit('src/x.ts');
            return text(`Recorded ${classes.length} input class${classes.length === 1 ? '' : 'es'}.${next ? ` ${next}` : ' You may change code now.'}`);
          },
        ),
        tool(
          'report_hypothesis',
          'A cause you are testing, and how it ended: open, confirmed or disproved, with what shows it. Give each its own id. After three disproved, Elfoqsy flags it: compare with a similar working case before the next one.',
          {
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
            text: z.string().trim().min(1).max(400),
            status: z.enum(['open', 'confirmed', 'disproved']),
            evidence: z.array(z.object({ kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']), ref: z.string().trim().min(1).max(500) })).max(6).optional(),
          },
          async ({ id, text: what, status, evidence }) => {
            this.deps.log.append('agent', 'run.hypothesis', { runId: this.spec.runId, hypothesisId: id, text: what, status, ...(evidence?.length ? { evidence } : {}) });
            if (!this.workflow.hypothesis(id, status)) return text('Recorded.');
            this.deps.say?.(tr(`Agent ${this.spec.agentNumber} on ${key} has disproved ${this.workflow.disproved} hypotheses. I have suggested it diff the failing path against a similar case that works before trying another.`, `Agent ${this.spec.agentNumber} trên ${key} đã bác bỏ ${this.workflow.disproved} giả thuyết. Tôi đã gợi ý nó đối chiếu đường chạy đang lỗi với một trường hợp tương tự đang chạy được, trước khi thử cách khác.`));
            return text(`Recorded. That is ${this.workflow.disproved} disproved: before the next hypothesis, find a similar case that works and diff the two paths. Elfoqsy told alex.`);
          },
        ),
        tool(
          'report_finding',
          'A different defect you found that this ticket does not cover: report it with a proposed split ticket, which becomes a draft alex creates or discards. Never fix it in this run.',
          {
            summary: z.string().trim().min(1).max(300),
            evidence: z.array(z.object({ kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url']), ref: z.string().trim().min(1).max(500) })).min(1).max(6),
            proposedTicket: z.object({ summary: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(3000) }),
          },
          async ({ summary, evidence, proposedTicket }) => {
            const findingId = `finding-${ulid().toLowerCase()}`;
            this.deps.log.append('agent', 'run.finding', { runId: this.spec.runId, findingId, summary, evidence, proposedTicket });
            // A draft card that waits for him: the agent creates nothing.
            const line = tr(`Agent ${this.spec.agentNumber} found a second defect while working ${key}. I drafted the ticket; it waits for you.`, `Agent ${this.spec.agentNumber} tìm thấy một lỗi thứ hai khi làm ${key}. Tôi đã soạn ticket; ticket đang chờ cậu.`);
            const draft: TicketDraft = {
              project: key.split('-')[0]!,
              type: 'Bug',
              summary: proposedTicket.summary,
              description: `${proposedTicket.description}\n\nFound by Agent ${this.spec.agentNumber} while working ${key}: ${summary}`,
              links: [{ linkType: 'Relates', direction: 'outward', other: key }],
            };
            const drafted = this.deps.draftTicket?.({ by: 'agent', runId: this.spec.runId, draft, line });
            if (!drafted || !('draftId' in drafted)) this.deps.say?.(tr(`Agent ${this.spec.agentNumber} found a separate defect while working on ${key}: ${summary} It proposes a split ticket, "${proposedTicket.summary}", and will not fix it in this run.`, `Agent ${this.spec.agentNumber} tìm thấy một lỗi riêng khi làm ${key}: ${summary} Nó đề xuất tách thành ticket "${proposedTicket.summary}" và sẽ không sửa lỗi này trong lượt chạy này.`));
            return text('Recorded, and drafted for alex as its own ticket; he decides whether to create it. Do not fix it in this run.');
          },
        ),
            ]),
        ...proxyTools(this.deps.environments, (proxy, input, extra) => this.proxyRequest(proxy, input, this.proxyCallId(proxy, extra))),
      ],
    });
  }


  private readonly subagentStart: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== 'SubagentStart') return {};
    this.running.add(input.agent_id);
    const call = this.pendingTasks.get(input.agent_type)?.shift();
    const definition = subagentDefinitions(this.deps.limits.models, this.deps.limits.efforts)[input.agent_type];
    this.subRecords.set(input.agent_id, { startedAt: this.now(), ...(call ? { parentToolUseId: call.toolUseId } : {}), tokens: 0, toolCalls: 0, type: input.agent_type });
    this.deps.log.append('agent', 'subagent.started', {
      runId: this.spec.runId,
      subagentId: input.agent_id,
      ...(call ? { parentToolUseId: call.toolUseId } : {}),
      model: String(definition?.model ?? input.agent_type),
      effort: (definition?.effort as Effort | undefined) ?? 'medium',
      task: call?.task ?? input.agent_type,
    });
    return {};
  };

  private readonly subagentStop: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== 'SubagentStop') return {};
    if (!this.running.delete(input.agent_id)) return {};
    const last = input.last_assistant_message ?? '';
    const verdict = /RESULT:\s*(success|failure)/i.exec(last)?.[1]?.toLowerCase();
    // The fresh review before the first push has happened, once it says what it found on contracts and cache bypasses.
    if (this.subRecords.get(input.agent_id)?.type === REVIEWER && verdict !== 'failure') {
      if (this.workflow.reviewDone(last)) this.recordCriteria();
      else this.note(`The review did not end with its CONTRACT: and CACHE_BYPASS: lines${this.spec.reviewDir ? ' and a CRITERION line for each acceptance criterion (or CRITERIA: none stated)' : ''}, so it does not count yet.`);
    }
    this.finishSubagent(input.agent_id, verdict === 'failure' ? 'failed' : 'done', firstLine(last.replace(/RESULT:.*$/is, '') || last));
    return {};
  };

  /** What the review said of each acceptance criterion, for the narrative: the latest review replaces the one before. */
  private recordCriteria(): void {
    const criteria = this.workflow.criteria;
    if (criteria) this.deps.log.append('orchestrator', 'run.criteria_reviewed', { runId: this.spec.runId, criteria });
  }

  /** The end of a sub-agent's record, whatever ended it. */
  private finishSubagent(agentId: string, outcome: 'done' | 'failed' | 'cancelled', result: string, cancelled?: { by: 'orchestrator' | 'agent' | 'you'; reason: string }): void {
    const record = this.subRecords.get(agentId);
    this.subRecords.delete(agentId);
    this.running.delete(agentId);
    this.deps.log.append('agent', 'subagent.finished', {
      runId: this.spec.runId,
      subagentId: agentId,
      outcome,
      ...(cancelled ? { by: cancelled.by, reason: cancelled.reason } : {}),
      result,
      tokens: record?.tokens ?? 0,
      toolCalls: record?.toolCalls ?? 0,
      durationMs: record ? Math.max(0, this.now() - record.startedAt) : 0,
    });
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const m of q) this.handle(m);
      if (this.phase !== 'ended') await this.end('failed', 'The agent session ended unexpectedly.');
    } catch (error) {
      await this.end('failed', `The agent session stopped: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
  }

  private handle(m: SDKMessage): void {
    if (handleLimitSignal(m, this.deps.usage)) return;
    if (m.type === 'stream_event') return this.countStream(m);
    if (m.type === 'assistant') this.countTokens(m);
    if (m.type === 'assistant' && m.parent_tool_use_id === null) {
      for (const block of m.message.content) {
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') this.finalText = [];
        else if (block.type === 'text' && block.text.trim()) {
          this.finalText.push(block.text.trim());
          this.note(firstLine(block.text));
          this.thought(block.text);
        }
      }
      return;
    }
    if (m.type === 'assistant' && m.parent_tool_use_id) {
      // A sub-agent's own reasoning, for its pane.
      const subagentId = [...this.subRecords].find(([, r]) => r.parentToolUseId === m.parent_tool_use_id)?.[0];
      if (subagentId) for (const block of m.message.content) if (block.type === 'text' && block.text.trim()) this.thought(block.text, subagentId);
    }
    if (m.type !== 'result') return;
    if (this.cutShort) {
      // The turn an interrupt cut short has ended. Guidance may have resumed the agent already; either way it goes on.
      this.cutShort = false;
      return;
    }
    if (this.interrupted || this.deps.usage.isPaused) return; // a paused turn, not a finished one
    const tokens = Object.values(m.modelUsage ?? {}).reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheCreationInputTokens, 0);
    this.tokens = Math.max(this.tokens, tokens);
    this.reportUsage();
    if (tokens > this.deps.limits.maxTokens) {
      void this.budget('tokens', tokens);
      return;
    }
    if (m.subtype !== 'success' || m.is_error) {
      void this.end('failed', firstLine(('errors' in m && m.errors[0]) || 'The agent stopped with an error.'));
      return;
    }
    // The prompt asks for a two-line summary as the agent's last message.
    const summary = this.finalText.at(-1) ?? '';
    this.finalText = [];
    // A verdict other than a bug to fix (or a change he confirmed) stops the run when its turn ends.
    const stop = this.workflow.stopping;
    if (stop) {
      void this.end('stopped', stop);
      return;
    }
    // A criterion the review called NOT MET holds the hand-back (and the report that the run succeeded) until the agent meets it, and runs
    // the review again, or says why it cannot be met here. It is told twice; after that it is handed back with what is unexplained said.
    const unmet = this.workflow.unmetOpen();
    const standing = this.reported?.result === 'failed' || this.reported?.result === 'blocked';
    if (unmet.length && !this.spec.task && !standing && this.workflow.holds < UNMET_HOLDS) {
      this.workflow.holds++;
      this.note(`Held: ${plural(unmet.length, 'acceptance criterion', 'acceptance criteria')} NOT MET, no reason given (${this.workflow.holds} of ${UNMET_HOLDS}).`);
      this.forward(
        `[From the workspace] Your turn cannot end as a hand-back yet: the review found ${plural(unmet.length, 'acceptance criterion', 'acceptance criteria')} NOT MET and you have not said why ${unmet.length === 1 ? 'it' : 'they'} cannot be met here.\n${unmet.map((c) => `- ${c.n}. ${c.text}${c.why ? `: ${c.why}` : ''}`).join('\n')}\nMeet ${unmet.length === 1 ? 'it' : 'them'} and run the review again, or call report_result with unmet: one entry for each, its number and why it cannot be met here. Every NOT MET is shown to alex in the narrative's Verification, with your reason, for him to decide before the PR is ready for review.`,
      );
      return;
    }
    const repos = this.spec.repos.filter((r) => r.role === 'target').map((r) => r.repo);
    if (!this.spec.task && this.deps.hasOpenPr(this.spec.ticket.key, repos)) {
      // Waiting on CI and review: the session stays, so a CI failure can be handed back to it.
      this.setIdle();
      if (summary) this.note(firstLine(summary));
      // The hand-back (N1): what it said last, labelled as the hand-back, in the narrative's section 7. With what the agent left unexplained.
      const left = unmet.length && !standing ? `\n\nHanded back with ${plural(unmet.length, 'acceptance criterion', 'acceptance criteria')} NOT MET and no reason from the agent: ${unmet.map((c) => `${c.n} (${c.text})`).join('; ')}.` : '';
      this.deps.log.append('orchestrator', 'run.handed_back', { runId: this.spec.runId, message: `${summary.trim() || this.reported?.summary || 'Handed back.'}${left}` });
      return;
    }
    void this.conclude(firstLine(summary));
  }

  /** Ends the run on its evidence: CI passes are checked against the branch as it is now. */
  private async conclude(lead: string, report = this.reported, unmet = this.workflow.unmetOpen()): Promise<RunOutcome> {
    await this.refreshCi();
    await this.freshen();
    const { state, reason } = this.spec.task
      ? taskEndState(this.plan?.checks, this.delivered, report, lead)
      : endStateFor(this.plan?.checks, report, lead, unmet.map((c) => `criterion ${c.n} (${c.text})`));
    return this.end(state, reason);
  }

  /** Its PR was merged or closed. A merge still counts as succeeded only with evidence for every check. */
  prFinished(pr: { repo: string; number: number; state: 'merged' | 'closed' }): Promise<RunOutcome> {
    this.prClosed = `${pr.repo} #${pr.number} was ${pr.state}`;
    const lead = `${this.prClosed}.`;
    // A merge is his decision, whatever the review said of a criterion: it does not count against the run.
    return pr.state === 'merged' ? this.conclude(lead, undefined, []) : this.end('cancelled', lead);
  }

  /**
   * The plan's usage limit: a working run is paused (shown paused by the workspace, its clock stopped) instead of
   * failing, and goes on by itself once the limit has reset.
   */
  private onUsage(paused: boolean): void {
    if (this.phase === 'ended') return;
    if (paused) {
      if (this.phase !== 'working' && this.phase !== 'starting') return;
      this.interruptTurn();
      if (!this.limitPaused) {
        this.limitPaused = true;
        const until = this.deps.usage.pausedUntil;
        this.deps.log.append('orchestrator', 'run.paused', {
          runId: this.spec.runId,
          by: 'orchestrator',
          reason: `Claude's usage limit${until !== undefined ? ` until ${hhmm(until)}` : ''}: it goes on by itself once the limit resets.`,
        });
      }
      return;
    }
    if (this.limitPaused) {
      this.limitPaused = false;
      this.deps.log.append('orchestrator', 'run.resumed', { runId: this.spec.runId, by: 'orchestrator', reason: "Claude's usage limit has reset." });
    }
    if (this.interrupted && !this.paused) {
      this.interrupted = false;
      this.setWorking();
      this.input.push('The Claude usage limit has reset. Continue where you left off.');
    }
  }

  /** Tokens of one assistant message, the agent's or a sub-agent's (its own record counts them too). */
  private countTokens(m: Extract<SDKMessage, { type: 'assistant' }>): void {
    const message = m.message as { id?: string; usage?: Usage };
    if (message.usage) this.countUsage(message.id, m.parent_tool_use_id, message.usage);
  }

  /**
   * One streaming event: the response it starts, and the output it has used so far. An assistant message's own
   * output_tokens is only the count at message_start (the SDK's cost-tracking guide); message_delta carries the real,
   * cumulative one. Each agent streams one response at a time, so a delta belongs to the last start of its stream.
   */
  private countStream(m: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const stream = m.parent_tool_use_id ?? '';
    if (m.event.type === 'message_start') {
      this.streaming.set(stream, m.event.message.id);
      this.countUsage(m.event.message.id, m.parent_tool_use_id, m.event.message.usage);
    } else if (m.event.type === 'message_delta') {
      const id = this.streaming.get(stream);
      if (id) this.countUsage(id, m.parent_tool_use_id, m.event.usage);
    }
  }

  /**
   * Counts an API response once: its assistant messages share its id and its usage (several of them when it uses tools
   * in parallel), and a later report of the same response only adds what grew. Input, output and cache writes count;
   * cache reads do not. A message without an id is counted as it comes.
   */
  private countUsage(id: string | undefined, parentToolUseId: string | null, u: Usage): void {
    const now = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache: u.cache_creation_input_tokens ?? 0 };
    let added = now.input + now.output + now.cache;
    if (id) {
      const seen = this.responses.get(id) ?? { input: 0, output: 0, cache: 0 };
      const next = { input: Math.max(seen.input, now.input), output: Math.max(seen.output, now.output), cache: Math.max(seen.cache, now.cache) };
      added = next.input + next.output + next.cache - (seen.input + seen.output + seen.cache);
      this.responses.set(id, next);
    }
    if (added <= 0) return;
    this.tokens += added;
    if (parentToolUseId) {
      for (const record of this.subRecords.values()) if (record.parentToolUseId === parentToolUseId) record.tokens += added;
    }
  }

  /** The agent's (or a sub-agent's) reasoning as it wrote it, for the pane's thoughts: redacted and capped. */
  private thought(text: string, subagentId?: string): void {
    const t = redact(text.trim());
    if (!t) return;
    this.deps.log.append('agent', 'run.thought', { runId: this.spec.runId, ...(subagentId ? { subagentId } : {}), text: t.length > THOUGHT_MAX ? `${t.slice(0, THOUGHT_MAX - 1)}…` : t });
  }

  private note(text: string): void {
    const t = text.trim();
    if (!t || t === this.lastNote) return;
    this.lastNote = t;
    this.deps.log.append('agent', 'run.note', { runId: this.spec.runId, text: t });
  }

  private setWorking(): void {
    if (this.phase !== 'working') {
      this.phase = 'working';
      this.deps.log.append('orchestrator', 'run.state_changed', { runId: this.spec.runId, state: 'running' });
    }
    if (this.waiting === 0 && this.held === 0 && this.considering === 0) this.activeSince ??= this.now();
  }

  /**
   * A call held for something other than alex's answer, such as a fresh AWS session: the run shows as paused by
   * the orchestrator, with why, and its working clock stops until the call goes on.
   */
  private async hold<T>(reason: string, until: Promise<T>): Promise<T> {
    this.held += 1;
    if (this.held === 1) {
      this.pauseClock();
      this.deps.log.append('orchestrator', 'run.paused', { runId: this.spec.runId, by: 'orchestrator', reason });
    }
    try {
      return await until;
    } finally {
      this.held -= 1;
      if (this.held === 0 && this.phase !== 'ended') {
        this.deps.log.append('orchestrator', 'run.resumed', { runId: this.spec.runId, by: 'orchestrator', reason: 'It can go on.' });
        if (this.phase === 'working' && this.waiting === 0 && this.considering === 0) this.activeSince = this.now();
      }
    }
  }

  /** Elfoqsy is looking into its question: its clock stops, but it is not waiting for alex, so it does not say so. */
  private async whileConsidered<T>(work: Promise<T>): Promise<T> {
    this.considering += 1;
    this.pauseClock();
    try {
      return await work;
    } finally {
      this.considering -= 1;
      if (this.considering === 0 && this.phase === 'working' && this.waiting === 0 && this.held === 0) this.activeSince = this.now();
    }
  }

  /**
   * Waits for alex's answer: the run shows as waiting for him and its clock stops. After 72 hours with no answer
   * the run pauses first, so the agent never goes on without his answer, and then the question leaves the screen,
   * withdrawn. On Resume the agent is told it was withdrawn and asks again if it still needs to.
   */
  private async waitForHim<T>(answer: Promise<T>): Promise<T> {
    this.setWaiting(true);
    let timer: unknown;
    try {
      const expired = new Promise<'expired'>((done) => {
        timer = this.clock.setTimeout(() => done('expired'), ASK_DEADLINE_MS);
      });
      const first = await Promise.race([answer, expired]);
      if (first !== 'expired') return first;
      this.pauseUnanswered();
      this.deps.approvals.withdraw(answer);
      return await answer;
    } finally {
      this.clock.clearTimeout(timer);
      this.setWaiting(false);
    }
  }

  /** Nobody answered in 72 hours: paused by the workspace, its turn interrupted, until alex resumes it. */
  private pauseUnanswered(): void {
    if (this.phase === 'ended' || this.paused) return;
    this.withdrawn = true;
    this.paused = { by: 'orchestrator', wasWorking: this.phase === 'working' };
    this.deps.log.append('orchestrator', 'run.paused', {
      runId: this.spec.runId,
      by: 'orchestrator',
      reason: 'Its question went unanswered for 72 hours: withdrawn, and the run paused until you resume it.',
    });
    if (this.phase === 'working') this.interruptTurn();
  }

  private setIdle(): void {
    this.pauseClock();
    this.phase = 'idle';
  }

  private setWaiting(on: boolean): void {
    this.waiting += on ? 1 : -1;
    if (this.phase === 'ended') return;
    if (on && this.waiting === 1) {
      this.pauseClock();
      this.deps.log.append('orchestrator', 'run.state_changed', { runId: this.spec.runId, state: 'waiting_for_you' });
    } else if (!on && this.waiting === 0) {
      this.deps.log.append('orchestrator', 'run.state_changed', { runId: this.spec.runId, state: 'running' });
      if (this.phase === 'working' && this.held === 0 && this.considering === 0) this.activeSince = this.now();
    }
  }

  private pauseClock(): void {
    if (this.activeSince !== undefined) this.activeMs += this.now() - this.activeSince;
    this.activeSince = undefined;
  }

  /** Working time only: time waiting for Alex, paused for usage, or idle at CI does not count. */
  activeMinutes(): number {
    return (this.activeMs + (this.activeSince !== undefined ? this.now() - this.activeSince : 0)) / 60_000;
  }

  private checkBudget(): void {
    if (this.phase === 'ended') return;
    this.reportUsage();
    const minutes = this.activeMinutes();
    if (minutes > this.deps.limits.maxMinutes) {
      void this.budget('time', Math.round(minutes));
      return;
    }
    // Mid-turn too: one turn can be the whole run (probe P2 went past its tokens and on until its time ran out).
    if (this.tokens > this.deps.limits.maxTokens) {
      void this.budget('tokens', this.tokens);
      return;
    }
    this.checkHeartbeat(minutes);
    if (!this.budgetFlagged && (minutes >= BUDGET_NEARLY * this.deps.limits.maxMinutes || this.tokens >= BUDGET_NEARLY * this.deps.limits.maxTokens)) {
      this.budgetFlagged = true;
      this.flag('budget', `Its budget is nearly spent: ${Math.round(minutes)} of ${this.deps.limits.maxMinutes} working minutes, ${Math.round(this.tokens / 1000)}k of ${Math.round(this.deps.limits.maxTokens / 1000)}k tokens.`);
    }
    this.timer = this.clock.setTimeout(() => this.checkBudget(), BUDGET_CHECK_MS);
  }

  private get heartbeatEvery(): number {
    return this.deps.limits.heartbeatMinutes ?? HEARTBEAT_MINUTES;
  }

  /** Working time only counts, so a paused, idle or waiting agent never owes a heartbeat. */
  private checkHeartbeat(minutes: number): void {
    const since = minutes - this.heartbeatAt;
    if (since >= this.heartbeatEvery && !this.heartbeatReminded) {
      this.heartbeatReminded = true;
      this.remind('heartbeat', `It is ${plural(Math.floor(since), 'working minute')} since your last heartbeat. Call heartbeat now, then carry on.`);
    }
    if (since >= 2 * this.heartbeatEvery && !this.heartbeatFlagged) {
      this.heartbeatFlagged = true;
      this.flag('missed_heartbeats', `No heartbeat for ${plural(Math.floor(since), 'working minute')}; two are missed.`);
    }
  }

  private onHeartbeat(): void {
    this.heartbeatAt = this.activeMinutes();
    this.heartbeatReminded = false;
    this.heartbeatFlagged = false;
    // Tokens rising across two heartbeats with no new step and no new evidence is a loop too.
    this.beats.push({ tokens: this.tokens, steps: this.steps.length, evidence: this.evidence });
    const [a, b, c] = this.beats.slice(-3);
    if (!a || !b || !c) return;
    const stuck = b.tokens > a.tokens && c.tokens > b.tokens && a.steps === c.steps && a.evidence === c.evidence;
    if (stuck && !this.tokenLoopFlagged) {
      this.tokenLoopFlagged = true;
      this.flag('loop', `Tokens rose from ${Math.round(a.tokens / 1000)}k to ${Math.round(c.tokens / 1000)}k over two heartbeats with no new step and no new evidence.`);
    } else if (!stuck) this.tokenLoopFlagged = false;
  }

  /** Every call it makes: the same command again and again with no code change is a loop; after guidance, a re-plan is owed. */
  private watchCall(tool: string, input: Record<string, unknown>, subagentId: string | undefined): void {
    if (EDIT_TOOLS.has(tool)) {
      this.commandRepeats.clear();
      this.loopFlagged.clear();
    } else if (tool === 'Bash') {
      const command = String(input.command ?? '').replace(/\s+/g, ' ').trim();
      const key = `${subagentId ?? 'agent'}:${command}`;
      const n = (this.commandRepeats.get(key) ?? 0) + 1;
      this.commandRepeats.set(key, n);
      if (n >= LOOP_REPEATS && !this.loopFlagged.has(key)) {
        this.loopFlagged.add(key);
        const who = subagentId ? 'A sub-agent' : 'It';
        this.flag('loop', `${who} ran \`${command.slice(0, 120)}\` ${n} times with no change to the code in between.`);
      }
    }
    if (this.replan && !subagentId && !tool.startsWith(`mcp__${RUN_TOOLS}__`)) {
      this.replan.calls++;
      if (this.replan.calls >= REPLAN_REMIND && !this.replan.reminded) {
        this.replan.reminded = true;
        this.remind('replan', 'Before anything else, call begin_step with your next step after the guidance (and declare_goal again if your checks change).');
      }
      if (this.replan.calls >= REPLAN_FLAG) {
        this.replan = undefined;
        this.flag('replan', `It has not declared its next step after the guidance (${REPLAN_FLAG} tool calls).`);
      }
    }
  }

  /** A reminder, queued for the next point the agent can take it, and recorded. */
  private remind(about: 'heartbeat' | 'replan', text: string): void {
    this.input.push(text, 'next');
    this.deps.log.append('orchestrator', 'run.reminded', { runId: this.spec.runId, about, text });
  }

  private flag(kind: 'missed_heartbeats' | 'loop' | 'budget' | 'replan', detail: string): void {
    this.deps.log.append('orchestrator', 'run.flag', { runId: this.spec.runId, kind, detail });
  }

  /** Pause: the current turn is interrupted and the working clock stops; nothing runs until resume. */
  pause(by: Actor, reason?: string): ControlResult {
    if (this.phase === 'ended') return { error: 'ended', message: 'That run has ended.' };
    if (this.paused) return { error: 'already_paused', message: `Agent ${this.spec.agentNumber} is already paused.` };
    if (this.waiting > 0) return { error: 'waiting', message: `Agent ${this.spec.agentNumber} is waiting for an answer to its question; answer it first.` };
    const wasWorking = this.phase === 'working';
    this.paused = { by, wasWorking };
    this.deps.log.append('orchestrator', 'run.paused', { runId: this.spec.runId, by, ...(reason ? { reason } : {}) });
    if (wasWorking) this.interruptTurn();
    return { ok: true };
  }

  /** Stops the clock and interrupts the agent's turn, once for a usage limit and a pause together. */
  private interruptTurn(): void {
    this.pauseClock();
    if (this.interrupted) return;
    this.interrupted = true;
    this.cutShort = true;
    void this.q?.interrupt().catch(() => undefined);
  }

  /** Resume: any guidance given while paused goes with it, and the agent must re-declare its next step. */
  resume(by: Actor, reason?: string): ControlResult {
    if (this.phase === 'ended') return { error: 'ended', message: 'That run has ended.' };
    if (!this.paused) return { error: 'not_paused', message: `Agent ${this.spec.agentNumber} is not paused.` };
    const { wasWorking } = this.paused;
    this.paused = undefined;
    const guidance = this.guidance.splice(0);
    this.deps.log.append('orchestrator', 'run.resumed', { runId: this.spec.runId, by, ...(reason ? { reason } : {}) });
    if (this.deps.usage.isPaused) return { ok: true }; // the usage limit's own resume continues it
    const said = guidance.map((g) => `- ${whoFor(g.by)}: ${g.text}`).join('\n');
    const withdrawn = this.withdrawn;
    this.withdrawn = false;
    const message = guidance.length
      ? `[Guidance, given while you were paused]\n${said}\n\nContinue from here: first call begin_step with your next step, and declare_goal again if your checks change.`
      : withdrawn
        ? `Your question to alex went unanswered for 72 hours, so it was withdrawn and you were paused. ${whoFor(by)} has resumed you. If you still need the answer, ask again; otherwise continue where you left off.`
        : `${whoFor(by)} paused you and has resumed you. Continue where you left off.`;
    if (wasWorking) {
      this.interrupted = false;
      this.setWorking();
      this.activeSince ??= this.now();
      this.reported = undefined;
      this.input.push(redact(message));
    } else if (guidance.length) this.forward(message);
    if (guidance.length) this.replan = { calls: 0, reminded: false };
    return { ok: true };
  }

  /** Guidance from a pane, as one action: pause, give it, resume. Paused already, it goes with the resume. */
  guide(text: string, by: Actor): ControlResult {
    if (this.phase === 'ended') return { error: 'ended', message: 'That run has ended.' };
    const logGuidance = () => this.deps.log.append('orchestrator', 'run.guidance', { runId: this.spec.runId, text: redact(text), by });
    if (this.waiting > 0) {
      // Waiting for an answer: it reads the guidance once it can.
      logGuidance();
      this.forward(`[Guidance from ${whoFor(by)}]\n${text}\n\nWhen you continue, first call begin_step with your next step.`);
      this.replan = { calls: 0, reminded: false };
      return { ok: true };
    }
    if (!this.paused) {
      const paused = this.pause(by, 'To give guidance');
      if ('error' in paused) return paused;
    }
    logGuidance();
    this.guidance.push({ text, by });
    return this.resume(by);
  }

  get isPaused(): boolean {
    return this.paused !== undefined;
  }

  private async budget(limit: 'time' | 'tokens', value: number): Promise<void> {
    this.deps.log.append('orchestrator', 'budget.exceeded', { runId: this.spec.runId, limit, value });
    await this.end('failed', limit === 'time' ? `Stopped after ${value} minutes of work, over its budget.` : `Stopped after ${value} tokens, over its budget.`);
  }

  /** Ends the run once; every caller gets the same outcome. */
  end(state: EndState, reason: string): Promise<RunOutcome> {
    if (this.ending) return this.ending;
    this.phase = 'ended';
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    if (this.ciTimer !== undefined) this.clock.clearTimeout(this.ciTimer);
    this.unsubscribeUsage();
    this.deps.approvals.cancelRun(this.spec.runId, CLOSED_ANSWERS.runEnded);
    this.deps.proxies.unregister(this.spec.runId); // its grants end with it
    this.input.end();
    this.q?.close();
    this.ending = this.finish(state, reason);
    return this.ending;
  }

  /** What is left of the run, checked rather than assumed; the folder goes only when the run is closed and GitHub has everything. */
  private async finish(state: EndState, reason: string): Promise<RunOutcome> {
    for (const agentId of [...this.subRecords.keys()]) {
      this.finishSubagent(agentId, 'cancelled', '', { by: 'orchestrator', reason: 'The run ended.' });
    }
    this.endOpenStep(state === 'succeeded' ? 'done' : state === 'failed' ? 'failed' : 'abandoned');
    this.reportUsage();
    const { git } = this.deps;
    const { branch, runRoot } = this.spec;
    agentRunEnded(runRoot); // a commit in a kept folder from now on is alex's: the hook leaves it alone
    const repos: RepoOutcome[] = [];
    for (const repo of this.spec.repos.filter((r) => r.role === 'target')) {
      const onGitHub = repo.url ? await remoteBranchSha(git, repo.url, branch).then((sha) => sha !== null, () => null) : null;
      const unpushed = await unpushedCount(git, repo, branch).catch(() => null);
      const dirty = await isDirty(git, repo).catch(() => null);
      repos.push({ repo: repo.repo, branch, branchOnGitHub: onGitHub, unpushedCommits: unpushed, uncommittedChanges: dirty });
    }
    // Unknown counts as work to keep. A run's folder goes once the run is closed (cancelled, or its PR merged or
    // closed) with nothing uncommitted and nothing GitHub lacks; a failure waits to be dismissed. A tester's run
    // keeps its folder only for commits GitHub lacks.
    // A task agent's work is what it delivered: once it succeeds, the run is closed like a merged one.
    const closed = state === 'cancelled' || this.prClosed !== undefined || (this.spec.task !== undefined && state === 'succeeded');
    this.closedAtEnd = closed;
    const clean = repos.every((r) => r.unpushedCommits === 0 && (this.spec.test || r.uncommittedChanges === false));
    const folderRemoved = (this.spec.test || closed) && clean;
    if (folderRemoved) {
      rmSync(runRoot, { recursive: true, force: true });
      const why = this.spec.test
        ? "A tester's run, with no commits missing from GitHub."
        : `${this.prClosed ?? (this.spec.task && state === 'succeeded' ? 'Delivered' : 'Cancelled')}, with nothing uncommitted and nothing missing from GitHub.`;
      this.deps.log.append('orchestrator', 'run.folder_removed', { runId: this.spec.runId, folder: runRoot, reason: why });
    }
    const untilClosed = clean && !folderRemoved;
    const outcome: RunOutcome = { state, folder: runRoot, folderRemoved, repos, summary: describeOutcome(runRoot, folderRemoved, repos, untilClosed) };
    this.deps.log.append('orchestrator', 'run.state_changed', { runId: this.spec.runId, state, reason: `${sentence(reason)} ${outcome.summary}`.trim() });
    this.onEnd(this, outcome);
    return outcome;
  }
}
