// The orchestrator: plain TypeScript, no model. It decides whether a run may start, prepares its clones and its own
// kubeconfig, starts exactly one agent per ticket, enforces the caps, holds the capability proxies and their tiers
// (grants, batched approvals, records and Undo), and ends runs. a run starts from Elfoqsy's handoff, in the
// mode chosen there, holds its ticket folder (~/tickets/<KEY>/.elfoqsy-run) while it works, and follows a read-only
// copy of alex's team-dev skill; its verdict is posted in chat, and a verdict that stops it comes with a default.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AnyEnvelope, DeliverableKind, Effort, MessageBlock, PayloadOf, ProxyName, SourceRef, TaskSpec, Ticket, TicketDraft } from '@elfoqsy/contracts';
import type { Actor } from '@elfoqsy/contracts';
import { activeRuns, briefMarkdown, buildNarrative, DEFAULT_MAX_AGENTS, handoffMarkdown, isOpen, narrativeRead, prKey, reviewedCriteria, rulesFor, todayConversation, verdictWords, type FactView, type HandoffView, type MessageView, type RunView, type WorkspaceState } from '@elfoqsy/state';
import { writeReviewPack } from './reviewPack';
import { readManifest, seedEnvironmentFacts, skillChange, skillChangeText, snapshotSkill } from '../skill/teamSkill';
import { ABILITIES, copyAbilities, type Abilities } from '../skill/abilities';
import type { AbilityEngine } from '../abilities/engine';
import { STOPPING } from './workflow';
import { caseMarkdown, qaNotes, runsOf, solutionPage } from './closeOut';
import { realClock, type Clock } from '../clock';
import type { UsageSnapshot, UsageState } from '../claude/usage';
import type { Config } from '../config';
import type { LiveState } from '../elfoqsy/liveState';
import type { QueryFn } from '../elfoqsy/session';
import type { EventLog } from '../eventLog';
import type { GateContext } from '../gate/policy';
import type { CiLog, CommitCi } from '../github/gh';
import type { AwsSession } from '../permissions/awsSession';
import type { Environments } from '../permissions/environments';
import { Grants } from '../permissions/grants';
import { createProxies, type ProxyBackends } from '../permissions';
import type { Kubeconfigs } from '../permissions/kubeconfig';
import type { Proxies, ProxyAnswer } from '../permissions/proxy';
import type { RunRef } from '../permissions/types';
import { redact } from '../redact';
import { ulid } from '../ulid';
import { Approvals, CLOSED_ANSWERS } from './approvals';
import { agentRunEnded, hasChanges, localBranchBusy, prepareDependency, prepareTarget, remoteBranchSha, unpushedCommits, unpushedLog, type Git, type LocalClone, type PreparedRepo } from './git';
import type { Mirrors } from './mirrors';
import { EMPTY_POLICY, repoDir, type RepoPolicy } from './repoPolicy';
import { tr } from '../elfoqsy/voice';
import { AgentRun, MAX_TMPDIR, ensureAgentCache, runTmp, type ControlResult, type EndState, type RunDeps, type RunOutcome, type RunSpec } from './run';
import type { Conversations } from '../elfoqsy/routing';
import { Digests } from '../decisions/digest';
import { ELFOQSY_RUN, FirstResponder } from '../decisions/firstResponder';
import type { Responder } from '../decisions/responder';
import type { OutboundContext } from '../redact';
import type { RunControl } from './control';
import { INVESTIGATOR_MODELS } from './investigator';

export type SpawnResult =
  // notice: information for alex that came with starting (the plan's usage is high); nothing to confirm.
  | { runId: string; agentNumber: number; notice?: SpawnNotice }
  | { warning: 'manual_session'; message: string }
  | { error: SpawnError; message: string };

export interface SpawnNotice {
  kind: 'usage_high';
  message: string;
}

type SpawnError =
  | 'unknown_ticket'
  | 'ticket_closed'
  | 'unknown_brief'
  | 'wrong_brief'
  | 'unknown_handoff'
  | 'wrong_handoff'
  | 'stale_handoff'
  | 'already_running'
  | 'cap_reached'
  | 'paused'
  | 'repo_needed'
  | 'unknown_repo'
  | 'repo_missing'
  | 'branch_busy'
  | 'setup_failed'
  // Starting from kept work (fromRun):
  | 'unknown_run'
  | 'wrong_run'
  | 'not_ended'
  | 'no_kept_work'
  // Task agents:
  | 'bad_task';

/** <KEY>-<six characters of the run id>: short, because each run's TMPDIR (and the sandbox's sockets) live inside. */
export function runFolder(root: string, key: string, runId: string): string {
  for (const n of [6, 10, 26]) {
    const path = join(root, `${key}-${runId.slice(-n).toLowerCase()}`);
    if (!existsSync(path)) return path;
  }
  return join(root, `${key}-${runId.toLowerCase()}`);
}

/**
 * A task agent's folder name, shortened to fit: the sandbox's sockets sit in the run's temp folder (root/<name>-<six
 * characters>/.tmp), which may be MAX_TMPDIR characters at most, so a long task name shortens its folder instead of
 * refusing to start the task. The branch and everything shown keep the whole name.
 */
export function taskFolderKey(root: string, slug: string): string {
  const room = MAX_TMPDIR - (root.length + 1 + 1 + 6 + '/.tmp'.length); // the root, '/', '-', the six id characters, '/.tmp'
  const key = `task-${slug}`.slice(0, Math.max(room, 4)).replace(/-+$/, '');
  return key || 'task';
}

export interface SpawnArgs {
  ticketKey: string;
  goal?: string;
  repos?: string[];
  /** The brief it works from and the conversation it was agreed in, when Elfoqsy started it from one (older runs). */
  briefId?: string;
  /** The handoff it works from: its mode and bases come with it. */
  handoffId?: string;
  conversationId?: string;
  /** alex said go although he seems to be working on the ticket himself (a fresh case.md, uncommitted work in /code). */
  confirmManual?: boolean;
  /** Started at the tester's request: its folder is kept only for commits GitHub lacks. */
  test?: boolean;
  /** An ended run of the same ticket whose kept folder's branch it starts from, instead of GitHub. */
  fromRun?: string;
}

export interface OrchestratorDeps {
  /** A ticket edited through the Jira proxy is read back for the screens. */
  refreshTicket?: (key: string) => void;
  /** A ticket drafted by Elfoqsy or an agent, waiting for him: its draftId. */
  draftTicket?: (o: { by: 'elfoqsy' | 'agent'; runId?: string; conversationId?: string; draft: TicketDraft }) => string;
  /** The ticket's Acceptance criteria field as text, read from Jira or the log (undefined: not read or empty); for the reviewer's pack. */
  acceptanceOf?: (key: string) => Promise<string | undefined>;
  /** Jira news since then, when he comes back after being away or (asked) opens the digest himself. */
  jiraNews?: (since: number, conversationId: string, asked?: boolean) => void;
  /** Where a run's questions are asked; without it, the conversation the run was started from. */
  conversations?: Conversations;
  log: EventLog;
  live: LiveState;
  usage: UsageState;
  git: Git;
  queryFn: QueryFn;
  /** Where agents may reach through the proxies (config/environments.yaml). */
  environments: Environments;
  /** How the proxies reach Jira, GitHub, the clusters, AWS and Coralogix with alex's credentials. */
  backends: ProxyBackends;
  /** Each run's own kubeconfig; without it, a run has none and the kube proxy finds no contexts. */
  kubeconfigs?: Kubeconfigs;
  /** alex's AWS session: calls that need it wait while it is not fresh. */
  aws?: AwsSession;
  config: Pick<
    Config,
    | 'GITHUB_REPOS'
    | 'MAX_PARALLEL_AGENTS'
    | 'AGENT_MAX_MINUTES'
    | 'AGENT_MAX_TOKENS'
    | 'AGENT_HEARTBEAT_MINUTES'
    | 'TICKET_AGENT_MODEL'
    | 'TICKET_AGENT_EFFORT'
    | 'SUBAGENT_MODELS'
    | 'SUBAGENT_EFFORTS'
    | 'MAX_PARALLEL_SUBAGENTS'
    | 'USAGE_WARN_FIVE_HOUR'
    | 'USAGE_WARN_SEVEN_DAY'
    | 'worktreesRoot'
    | 'agentCacheDir'
  >;
  policies: Record<string, RepoPolicy>;
  clones: Map<string, LocalClone>;
  /** The mirrors run clones are made from, not his clones: they share object files with their source. */
  mirrors: Mirrors;
  baseEnv: Record<string, string>;
  hosts: GateContext['hosts'];
  protectedPaths: string[];
  /** alex's home, for the gate; the real one unless a test says. */
  home?: string;
  /** Plan usage right now, if it can be read (Elfoqsy's live session); else the last rate-limit event counts. */
  usageProbe?: () => Promise<UsageSnapshot | undefined>;
  /** What CI says about a commit (a read with Alex's gh): evidence for ci checks. */
  commitCi?: (repo: string, sha: string) => Promise<CommitCi>;
  /** The failed steps' log of a failed CI run at a commit (a read with Alex's gh), for flow 3. */
  ciLog?: (repo: string, sha: string) => Promise<CiLog | null>;
  /**
   * alex's ticket folders (~/tickets) and his own workspace (/code): a run holds its ticket's folder while it works,
   * and a ticket he seems to be working on himself is asked about first. Absent: runs have no ticket folder.
   */
  tickets?: { root: string; codeRoot?: string; /** Where a tester's runs keep theirs, never in his folders. */ testRoot?: string };
  /** Bot-review rounds on one PR, read from its reviews with alex's gh. */
  prReviewRounds?: (repo: string, number: number) => Promise<number>;
  /** The team-dev skill, the adapter that goes after it, and the version the adapter was written for. Absent: no skill. */
  skill?: { dir: string; adapterFile: string; manifestFile: string };
  /** Where the Abilities skills live (data/skills): each run gets its own read-only copy as a local plugin. Absent: no skills. */
  abilitiesDir?: string;
  /** The abilities engine: told when a run ends, for its uses of skills and the review of its friction. */
  abilities?: Pick<AbilityEngine, 'runEnded'>;
  /** Elfoqsy's responder session, for agents' questions and escalations; absent, they go straight to alex. */
  responder?: Responder;
  /** What the redactor checks a web request against; absent, agents have no web. */
  outbound?: OutboundContext;
  clock?: Clock;
  now?: () => number;
}

const branchFor = (key: string): string => `feature/${key}`;

/** Elfoqsy's own kubeconfig is built again after this long, so a context he added shows up without a restart. */
export const KUBECONFIG_RENEW_MS = 5 * 60_000;

/** The ticket folder's marker: the run that holds it, while it works (the team-dev skill reads it too). */
export const RUN_MARKER = '.elfoqsy-run';
/** How long a run's start waits for the ticket's Acceptance criteria from Jira, for the reviewer's pack. */
const REVIEW_PACK_WAIT_MS = 8000;
/** A case.md changed this recently, with no run holding the folder, means alex is working on the ticket himself. */
export const MANUAL_FRESH_MS = 24 * 3600_000;

const ago = (ms: number): string => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} minutes ago` : `${Math.round(ms / 3600_000)} hours ago`);

/** What Elfoqsy proposes when a verdict stops a run. */
const DEFAULTS: Partial<Record<PayloadOf<'run.verdict'>['verdict'], (key: string) => { en: string; vi: string }>> = {
  'EXPECTED_BEHAVIOR/INVALID': (key) => ({ en: `update ${key} to say it is the expected behaviour`, vi: `cập nhật ${key} để ghi rằng đây là hành vi mong đợi` }),
  ALREADY_FIXED: (key) => ({ en: `say on ${key} that it is already fixed`, vi: `ghi trên ${key} rằng nó đã được sửa` }),
  'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED': (key) => ({ en: `put the open question to the reporter of ${key}`, vi: `đặt câu hỏi còn mở cho người báo ${key}` }),
};

/** A verdict in her words: the skill's own labels, with "reproduced" said in Vietnamese when she is writing it. */
const verdictLine = (v: Parameters<typeof verdictWords>[0]): string => tr(verdictWords(v), v.verdict === 'VALID' ? `VALID, ${v.reproduced ? 'đã tái hiện được' : 'chưa tái hiện được'}` : v.verdict);

const ENDED = new Set(['succeeded', 'stopped', 'failed', 'cancelled']);

/** The facts that offer a run's kept work: its own, or the first kind (saved under a fresh id, by its label). */
export function keptFacts(s: WorkspaceState, runId: string): FactView[] {
  const run = s.runs[runId];
  if (!run) return [];
  const label = `Agent ${run.agentNumber}'s kept run folder`;
  return Object.values(s.memory).filter(
    (f) => f.factId === `kept-${runId}` || (f.origin === 'run' && f.sources.some((x) => x.kind === 'ticket' && x.ref === run.ticket && x.label === label)),
  );
}

const tilde = (path: string): string => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** What a kept run folder holds that GitHub lacks, per repository: commits on the run's branch (newest first), uncommitted changes. */
type KeptWork = { repo: string; commits: Array<{ sha: string; subject: string }>; changes: boolean };

/** What closes an ended run: dismissing its failure, or its ticket's PR merged or closed. A cancellation closes it as it ends. */
type Closure = 'dismissed' | 'cancelled' | { pr: string; state: 'merged' | 'closed' };

const closureText = (how: Closure): string => (typeof how === 'object' ? `${how.pr} was ${how.state}` : how === 'dismissed' ? 'Dismissed' : 'Cancelled');

/** "32532f6 "subject" on feature/X", or "3 commits, the latest …", per repository with commits. */
function keptText(run: RunView, kept: KeptWork[]): string {
  return kept
    .filter((k) => k.commits.length)
    .map(({ repo, commits }) => {
      const latest = `${commits[0]!.sha} "${commits[0]!.subject}"`;
      return `${commits.length === 1 ? latest : `${commits.length} commits, the latest ${latest}`} on ${run.branch}${kept.length > 1 ? ` in ${repo}` : ''}`;
    })
    .join('; ');
}

/** keptText, in Vietnamese, for her line to him. */
function keptTextVi(run: RunView, kept: KeptWork[]): string {
  return kept
    .filter((k) => k.commits.length)
    .map(({ repo, commits }) => {
      const latest = `${commits[0]!.sha} "${commits[0]!.subject}"`;
      return `${commits.length === 1 ? latest : `${commits.length} commit, mới nhất là ${latest}`} trên ${run.branch}${kept.length > 1 ? ` trong ${repo}` : ''}`;
    })
    .join('; ');
}

/** changesText, in Vietnamese. */
function changesTextVi(kept: KeptWork[]): string {
  const changed = kept.filter((k) => k.changes);
  if (!changed.length) return '';
  return `các thay đổi chưa commit${kept.length > 1 ? ` trong ${changed.map((k) => k.repo).join(' và ')}` : ''}`;
}

/** "uncommitted changes", naming the repositories when there are several; "" when there are none. */
function changesText(kept: KeptWork[]): string {
  const changed = kept.filter((k) => k.changes);
  if (!changed.length) return '';
  return `uncommitted changes${kept.length > 1 ? ` in ${changed.map((k) => k.repo).join(' and ')}` : ''}`;
}

/** What a task agent is started with. */
export interface TaskArgs {
  name: string;
  goal: string;
  deliverable: DeliverableKind;
  /** Picked by Elfoqsy for the task: Haiku for lookups, Sonnet for drafting, Opus for deep code work. */
  model: string;
  effort: Effort;
  repos?: string[];
  conversationId?: string;
  test?: boolean;
}

const TASK_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];

export class Orchestrator implements RunControl {
  readonly approvals: Approvals;
  readonly grants: Grants;
  readonly proxies: Proxies;
  /** Elfoqsy as first responder for agents' questions and tier-2 requests. */
  readonly firstResponder: FirstResponder;
  private readonly digests: Digests | undefined;
  private readonly runs = new Map<string, AgentRun>();
  /** Runs whose folder is being closed, so a dismissal and the sweep at start never both act on one. */
  private readonly closing = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly d: OrchestratorDeps) {
    const route = d.conversations ? (runId: string, ticket: string) => d.conversations!.for(ticket, runId) : undefined;
    this.approvals = new Approvals(d.log, route, d.clock);
    this.grants = new Grants(d.log, { ...(d.clock ? { clock: d.clock } : {}), ...(d.now ? { now: d.now } : {}) });
    this.proxies = createProxies({
      log: d.log,
      approvals: this.approvals,
      grants: this.grants,
      environments: d.environments,
      backends: d.backends,
      repos: d.config.GITHUB_REPOS,
      ...(d.aws ? { aws: d.aws } : {}),
      // Elfoqsy's one line, in the run's conversation (its own, its ticket's, or Today's), from the orchestrator.
      say: (run, text) => {
        const conversationId = route ? route(run.runId, run.ticket) : this.d.live.get().runs[run.runId]?.conversationId;
        this.d.log.append('orchestrator', 'elfoqsy.message', {
          messageId: ulid(),
          role: 'elfoqsy',
          text,
          ...(conversationId ? { conversationId } : {}),
          refs: { tickets: [run.ticket], runId: run.runId },
        });
      },
      endedRun: (runId, ticket) => this.endedRun(runId, ticket),
      firstResponder: () => this.firstResponder,
      // A Jira write by Elfoqsy or an agent: logged as an edit of the ticket, which is read back at once.
      afterWrite: (w) => {
        this.d.log.append('orchestrator', 'jira.edited', {
          key: w.target.key,
          by: w.run.actor === 'elfoqsy' ? 'elfoqsy' : 'agent',
          what: w.target.what,
          ...(w.target.fieldId ? { fieldId: w.target.fieldId } : {}),
          ok: w.ok,
          ...(w.ok ? {} : { error: redact(w.output).slice(0, 300) }),
          actionId: w.actionId,
          ...(w.recordId ? { recordId: w.recordId } : {}),
          runId: w.run.runId,
        });
        if (w.ok) this.d.refreshTicket?.(w.target.key);
      },
      ...(d.now ? { now: d.now } : {}),
    });
    this.firstResponder = new FirstResponder({
      log: d.log,
      state: () => d.live.get(),
      approvals: this.approvals,
      ...(d.responder ? { responder: d.responder } : {}),
      say: (runId, text, blocks, ticket) => this.say(ticket ?? d.live.get().runs[runId]?.ticket ?? '', runId, text, blocks),
      tell: (runId, text, from) => void this.tell(runId, text, from),
    });
    // What she decided while he was away, listed when he comes back; only where conversations are routed.
    this.digests = d.conversations ? new Digests({ log: d.log, state: () => d.live.get(), today: () => d.conversations!.today(), ...(d.jiraNews ? { onBack: (since: number, c: string) => d.jiraNews!(since, c), onAsked: (since: number, c: string) => d.jiraNews!(since, c, true) } : {}) }) : undefined;
    this.unsubscribe = d.live.onEvent((prev, event, next) => this.onEvent(prev, event, next));
  }

  /**
   * A ticket or task agent that could not start because the most agents were working. Studying never
   * runs while one waits: it pauses until a place frees, and resumes on its own.
   */
  private wanted: { what: string; at: number } | undefined;
  private readonly capacityListeners = new Set<() => void>();

  private capacityWanted(what: string): void {
    this.wanted = { what, at: this.d.now?.() ?? Date.now() };
    for (const l of this.capacityListeners) l();
  }

  /** Whether an agent is waiting for a place: it was refused one, and every place is still taken. */
  capacityWaiting(): { waiting: boolean; detail?: string } {
    if (!this.wanted) return { waiting: false };
    const active = [...this.runs.values()].filter((r) => r.isActive).length;
    if (active < this.maxAgents) {
      this.wanted = undefined;
      return { waiting: false };
    }
    return { waiting: true, detail: `An agent for ${this.wanted.what} is waiting: ${active} agents are working, the most allowed (${this.maxAgents}).` };
  }

  /** Called when an agent is refused a place, so studying can stop its step at once. */
  onCapacityWanted(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => this.capacityListeners.delete(listener);
  }

  /** How many agents may work at once: his setting, else the configured default. */
  get maxAgents(): number {
    return this.d.live.get().settings.maxAgents ?? this.d.config.MAX_PARALLEL_AGENTS ?? DEFAULT_MAX_AGENTS;
  }

  /**
   * A ticket drafted by Elfoqsy or an agent: a card that waits for him. Nothing is created: only his Create in
   * Jira (or his own form) creates a ticket. An agent's draft comes with her line in its run's conversation.
   */
  draftTicket(o: { by: 'elfoqsy' | 'agent'; runId?: string; conversationId?: string; draft: TicketDraft; line?: string }): { draftId: string } | { error: string; message: string } {
    if (!this.d.draftTicket) return { error: 'not_set_up', message: 'Drafting tickets is not set up here.' };
    const run = o.runId ? this.d.live.get().runs[o.runId] : undefined;
    const conversationId = o.conversationId ?? run?.conversationId;
    const draftId = this.d.draftTicket({ by: o.by, ...(o.runId ? { runId: o.runId } : {}), ...(conversationId ? { conversationId } : {}), draft: o.draft });
    if (o.line) this.say(run?.ticket ?? o.draft.links?.[0]?.other ?? '', o.runId ?? ELFOQSY_RUN, o.line, [{ type: 'draft', ref: draftId }]);
    return { draftId };
  }

  /** Elfoqsy's own Jira edits go through the proxies under this stand-in run. */
  private elfoqsyRef(ticket: string): RunRef {
    return { runId: ELFOQSY_RUN, ticket, agentNumber: 0, branch: '', targets: [], kubeconfig: join(this.d.config.worktreesRoot, '.no-kubeconfig'), actor: 'elfoqsy', label: ticket };
  }

  /**
   * Elfoqsy's edit of a Jira ticket, through the Jira proxy and his delegation: what he delegated runs at once
   * and she tells him; what he keeps (comments, transitions, writing over text) is asked. Her turn does not wait on his
   * answer: after waitMs she hears that it was asked, and it runs if he approves.
   */
  async elfoqsyJira(input: Record<string, unknown>, waitMs = 3000): Promise<{ ok: boolean; text: string; asked?: true }> {
    const key = typeof input.key === 'string' ? input.key : '';
    const request = this.proxies.request(this.elfoqsyRef(key), 'jira', input);
    const asked = new Promise<'asked'>((done) => {
      const t = setTimeout(() => done('asked'), waitMs);
      t.unref?.();
    });
    const first = await Promise.race([request, asked]);
    if (first !== 'asked') return { ok: first.ok, text: first.text };
    void request.then((r) => {
      if (!r.ok) return;
      const what = redact(r.text.split('\n')[0] ?? '').slice(0, 200);
      this.say(key, ELFOQSY_RUN, tr(`Done, as you approved: ${what}`, `Xong rồi, như cậu đã duyệt: ${what}`));
    });
    return { ok: true, asked: true, text: `Asked alex: it runs when he approves. Do not ask again.` };
  }

  /**
   * Elfoqsy's own read of an environment (kube, aws, gh, logs), through the proxies under her stand-in run: the tier-0
   * operations only, with the same per-environment tiers, redaction and log as an agent's. Her kubeconfig is her own,
   * built like a run's (the configured non-prod contexts, no current context) and renewed every few minutes; reads
   * running together share it.
   */
  async elfoqsyRead(proxy: ProxyName, input: Record<string, unknown>): Promise<ProxyAnswer> {
    const kubeconfig = proxy === 'kube' ? await this.elfoqsyKubeconfig() : join(this.d.config.worktreesRoot, '.no-kubeconfig');
    return this.proxies.read({ ...this.elfoqsyRef(''), kubeconfig }, proxy, input);
  }

  private elfoqsyKube: { path: string; at: number } | undefined;
  private elfoqsyKubeBuilding: Promise<string> | undefined;

  private async elfoqsyKubeconfig(): Promise<string> {
    const none = join(this.d.config.worktreesRoot, '.no-kubeconfig');
    const kubeconfigs = this.d.kubeconfigs;
    if (!kubeconfigs) return none;
    const now = (this.d.now ?? Date.now)();
    if (this.elfoqsyKube && now - this.elfoqsyKube.at < KUBECONFIG_RENEW_MS) return this.elfoqsyKube.path;
    this.elfoqsyKubeBuilding ??= kubeconfigs
      .create(ELFOQSY_RUN, { renew: true })
      .then(({ path }) => {
        this.elfoqsyKube = { path, at: now };
        return path;
      })
      .catch(() => this.elfoqsyKube?.path ?? none)
      .finally(() => {
        this.elfoqsyKubeBuilding = undefined;
      });
    return this.elfoqsyKubeBuilding;
  }

  /** He changes one of Elfoqsy's answers. */
  changeDecision(decisionId: string, to: string, by: 'you' | 'tester') {
    return this.firstResponder.change(decisionId, to, by);
  }

  /** He (or the tester) opens the digest of what Elfoqsy decided since his last one. */
  openDigest(conversationId: string | undefined, by: 'you' | 'tester'): void {
    this.digests?.open(conversationId, by);
  }

  /** Whether he has read the run's narrative as it stands (N1); the tester's tick counts in the tester's own run only. */
  narrativeRead(runId: string): boolean {
    const run = this.d.live.get().runs[runId];
    if (!run) return false;
    const r = narrativeRead(run);
    return r.read || (!!run.test && r.testerRead);
  }

  /** "Mark ready for review" from the narrative, when the run's agent has not asked for it (N1). */
  async markReady(runId: string, by: 'you' | 'tester'): Promise<{ ok: true } | { ok: false; message: string }> {
    const state = this.d.live.get();
    const view = state.runs[runId];
    const run = this.runs.get(runId);
    if (!view || !run) return { ok: false, message: tr('That run is not running any more, so I cannot mark its PR ready from here.', 'Run đó không còn chạy nữa nên tôi không đánh dấu PR của nó là sẵn sàng từ đây được.') };
    if (by === 'tester' && !view.test) return { ok: false, message: tr('Only alex marks a real run\'s PR ready.', 'Chỉ alex mới đánh dấu PR của một run thật là sẵn sàng.') };
    const drafts = Object.values(state.prs).filter((p) => p.ticket === view.ticket && p.state === 'draft');
    if (!drafts.length) return { ok: false, message: tr(`${view.ticket} has no draft PR to mark ready.`, `${view.ticket} không có PR draft nào để đánh dấu sẵn sàng.`) };
    const done = await run.markReady(drafts, by);
    if (done.ok) {
      const prs = drafts.map((p) => `${p.repo.split('/').at(-1)}#${p.number}`).join(', ');
      this.say(view.ticket, runId, tr(`Marked ${prs} ready for review, after you read what we know.`, `Tôi đã đánh dấu ${prs} sẵn sàng để review, sau khi cậu đọc “What we know”.`));
    }
    return done;
  }

  /** Undo from a pane: the recorded change goes back through the same proxy and tier rules. */
  undo(recordId: string, by: Actor): Promise<{ ok: true } | { error: string; message: string }> {
    return this.proxies.undo(recordId, by);
  }

  /** An ended run as the proxies need it for an undo, with a kubeconfig made for the occasion. */
  private async endedRun(runId: string, ticket?: string): Promise<{ run: RunRef; dispose: () => void } | null> {
    // Elfoqsy's own Jira edits are undone under her stand-in run, on the ticket they changed.
    if (runId === ELFOQSY_RUN && ticket) return { run: this.elfoqsyRef(ticket), dispose: () => undefined };
    const view = this.d.live.get().runs[runId];
    if (!view) return null;
    const id = `undo-${ulid().toLowerCase()}`;
    const kube = this.d.kubeconfigs ? await this.d.kubeconfigs.create(id) : undefined;
    return {
      run: {
        runId,
        ticket: view.ticket,
        agentNumber: view.agentNumber,
        branch: view.branch,
        targets: (view.repos ?? []).map((repo) => ({ repo, base: this.d.clones.get(repo)?.defaultBranch ?? 'master' })),
        kubeconfig: kube?.path ?? join(this.d.config.worktreesRoot, '.no-kubeconfig'),
      },
      dispose: () => this.d.kubeconfigs?.remove(id),
    };
  }

  /** Runs the log still shows as active belong to a daemon that stopped: close them, and their questions. */
  recoverStaleRuns(): void {
    const s = this.d.live.get();
    const open = new Set(Object.values(s.approvals).filter((a) => !a.resolution).map((a) => a.approvalId));
    for (const run of activeRuns(s)) {
      if (run.state === 'failed') continue; // already ended; failing it again would only repeat the record
      for (const a of Object.values(s.approvals)) {
        if (a.runId === run.runId && open.has(a.approvalId)) {
          this.d.log.append('orchestrator', 'approval.resolved', { approvalId: a.approvalId, decision: 'denied', answer: CLOSED_ANSWERS.restarted });
        }
      }
      this.d.log.append('orchestrator', 'run.state_changed', {
        runId: run.runId,
        state: 'failed',
        reason: `The daemon restarted and the agent stopped. Its clones are kept in ${run.worktree}.`,
      });
      if (run.worktree) agentRunEnded(run.worktree); // later commits there are alex's
      this.d.kubeconfigs?.remove(run.runId);
    }
  }

  async spawn(args: SpawnArgs): Promise<SpawnResult> {
    const s = this.d.live.get();
    const key = args.ticketKey.trim().toUpperCase();
    const ticket = s.tickets[key];
    if (!ticket) return { error: 'unknown_ticket', message: `${key} is not in alex's open sprints.` };
    if (!isOpen(ticket)) return { error: 'ticket_closed', message: `${key} is ${ticket.status}.` };
    const brief = args.briefId ? s.briefs[args.briefId] : undefined;
    if (args.briefId && !brief) return { error: 'unknown_brief', message: `There is no brief ${args.briefId}.` };
    if (brief && brief.ticket !== key) return { error: 'wrong_brief', message: `That brief is for ${brief.ticket}, not ${key}.` };
    const handoff = args.handoffId ? s.handoffs[args.handoffId] : undefined;
    if (args.handoffId && !handoff) return { error: 'unknown_handoff', message: `There is no handoff ${args.handoffId}.` };
    if (handoff && handoff.ticket !== key) return { error: 'wrong_handoff', message: `That handoff is for ${handoff.ticket}, not ${key}.` };
    // A handoff is his words up to when it was written; anything he wrote since could change them (probe P1 started an
    // agent from one written before the tester's later messages). Elfoqsy writes a fresh one; nothing is appended.
    const since = handoff ? writtenSince(s, handoff) : [];
    if (handoff && since.length) {
      const who = since.some((m) => m.role === 'you') ? 'alex has' : 'the tester has';
      return {
        error: 'stale_handoff',
        message: `${who} written ${since.length === 1 ? 'a message' : `${since.length} messages`} in this conversation since handoff ${handoff.handoffId} was written. Write a fresh handoff with write_handoff, from the whole conversation, and start the agent with that one.`,
      };
    }
    const mode = handoff?.mode ?? 'normal';
    // Exactly one agent per ticket.
    if (activeRuns(s).some((r) => r.ticket === key) || [...this.runs.values()].some((r) => r.spec.ticket.key === key)) {
      return { error: 'already_running', message: `An agent is already on ${key}.` };
    }
    if (this.d.usage.isPaused) return { error: 'paused', message: 'Claude is paused for the usage limit; no new runs until it resets.' };
    const active = [...this.runs.values()].filter((r) => r.isActive).length;
    if (active >= this.maxAgents) {
      this.capacityWanted(key);
      return { error: 'cap_reached', message: `${active} agents are working, the most allowed (${this.maxAgents}).` };
    }

    const repos = this.reposFor(key, args.repos, s);
    if ('error' in repos) return repos;
    if (!args.confirmManual) {
      const manual = await this.manualSession(key);
      if (manual) return { warning: 'manual_session', message: manual };
    }

    const branch = branchFor(key);
    const needed = [...new Set(repos.flatMap((r) => (this.d.policies[r] ?? EMPTY_POLICY).needs))].filter((r) => !repos.includes(r));
    for (const repo of [...repos, ...needed]) {
      if (!this.d.clones.has(repo)) return { error: 'repo_missing', message: `There is no clone of ${repo} under REPOS_ROOT.` };
    }
    for (const repo of repos) {
      const clone = this.d.clones.get(repo)!;
      const remote = await remoteBranchSha(this.d.git, clone.url, branch).catch(() => null);
      const busy = await localBranchBusy(this.d.git, clone, branch, remote);
      if (busy) return { error: 'branch_busy', message: busy };
    }
    const kept = args.fromRun ? this.keptBranch(s, args.fromRun, key, repos, branch) : { seeds: {} as Record<string, string> };
    if ('error' in kept) return kept;

    const runId = `run-${ulid().toLowerCase()}`;
    const agentNumber = Math.max(0, ...Object.values(s.runs).map((r) => r.agentNumber)) + 1;
    const runRoot = runFolder(this.d.config.worktreesRoot, key, runId);
    if (runTmp(runRoot).length > MAX_TMPDIR) {
      return { error: 'setup_failed', message: `The run folder ${runRoot} is too long for the sandbox's sockets; set a shorter WORKTREES_ROOT.` };
    }
    this.d.log.append('orchestrator', 'run.created', {
      runId,
      ticket: key,
      worktree: runRoot,
      branch,
      agentNumber,
      model: this.d.config.TICKET_AGENT_MODEL,
      effort: this.d.config.TICKET_AGENT_EFFORT,
      ...(args.briefId ? { briefId: args.briefId } : {}),
      ...(args.handoffId ? { handoffId: args.handoffId } : {}),
      mode,
      ...(handoff?.bases && Object.keys(handoff.bases).length ? { bases: handoff.bases } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      budget: { tokens: this.d.config.AGENT_MAX_TOKENS, minutes: this.d.config.AGENT_MAX_MINUTES },
      repos,
      ...(args.test ? { test: true as const } : {}),
      ...(args.fromRun ? { startedFrom: args.fromRun } : {}),
    });
    if (args.briefId) this.d.log.append('orchestrator', 'brief.handed_off', { briefId: args.briefId, runId });
    if (args.handoffId) this.d.log.append('orchestrator', 'handoff.handed_off', { handoffId: args.handoffId, runId });
    this.d.log.append('orchestrator', 'run.state_changed', { runId, state: 'queued' });

    let prepared: PreparedRepo[];
    try {
      mkdirSync(runTmp(runRoot), { recursive: true });
      ensureAgentCache(this.d.config.agentCacheDir);
      prepared = [];
      for (const repo of repos) {
        const clone = this.d.clones.get(repo)!;
        // From the mirror, never from his clone: the run clone shares its object files with what it is made from.
        prepared.push(await prepareTarget(this.d.git, await this.d.mirrors.source(clone), runRoot, branch, kept.seeds[repo], handoff?.bases?.[repo] ?? clone.defaultBranch));
      }
      for (const repo of needed) prepared.push(await prepareDependency(this.d.git, await this.d.mirrors.source(this.d.clones.get(repo)!), runRoot));
    } catch (error) {
      rmSync(runRoot, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.d.log.append('orchestrator', 'run.state_changed', { runId, state: 'failed', reason: `Could not prepare the clones: ${message}` });
      return { error: 'setup_failed', message };
    }

    // Its own kubeconfig, outside its sandbox: only the configured non-prod contexts, and no current context.
    const kube = this.d.kubeconfigs ? await this.d.kubeconfigs.create(runId).catch(() => undefined) : undefined;
    // Its ticket folder, held while it works (a tester's run keeps its own, out of his folders); and its read-only copy of
    // the team-dev skill.
    const ticketDir = this.holdTicketFolder(key, runId, !!args.test);
    const skill = this.snapshotSkill(runId, runRoot);
    const abilities = this.abilities(runRoot);
    const reviewDir = mode === 'read_only' ? undefined : await this.reviewPack(runRoot, ticket, handoff ? handoffMarkdown(handoff) : undefined);

    const identity = this.d.clones.get(repos[0]!)!.identity;
    const madeBy = (committedAt: number, email: string) => this.madeBy(key, committedAt, email, identity);
    // What a branch started from kept work begins with, and who made it; that offer of kept work is taken.
    const inherited: Array<{ repo: string; commits: Array<{ sha: string; subject: string; by: string }> }> = [];
    for (const repo of prepared.filter((r) => r.seededFrom)) {
      const log = await unpushedLog(this.d.git, repo, branch).catch(() => []);
      inherited.push({ repo: repo.repo, commits: log.map((c) => ({ sha: c.sha, subject: c.subject, by: madeBy(c.committedAt, c.email) })) });
    }
    if (args.fromRun) for (const fact of keptFacts(s, args.fromRun)) this.d.log.append('orchestrator', 'memory.forgotten', { factId: fact.factId, by: 'orchestrator' });

    const linked = ticket.linked.map((k) => s.tickets[k]).filter((t): t is Ticket => t !== undefined);
    const run = new AgentRun(
      {
        runId,
        agentNumber,
        ticket,
        linked,
        ...(args.goal ? { goal: args.goal } : {}),
        ...(brief ? { brief: briefMarkdown(brief) } : {}),
        ...(handoff ? { handoff: handoffMarkdown(handoff) } : {}),
        ...(reviewDir ? { reviewDir } : {}),
        mode,
        ...(ticketDir ? { ticketDir } : {}),
        ...(skill ? { skill } : {}),
        ...(abilities ? { abilities } : {}),
        rules: rulesFor(s, repos).map((r) => r.statement),
        branch,
        runRoot,
        repos: prepared,
        identity,
        createdAt: this.d.live.get().runs[runId]?.createdAt ?? (this.d.now ?? Date.now)(),
        ...(args.test ? { test: true } : {}),
        ...(inherited.length ? { inherited } : {}),
        ...(kube ? { kubeconfig: kube.path } : {}),
      },
      this.runDeps(key, runId, madeBy, { model: this.d.config.TICKET_AGENT_MODEL, effort: this.d.config.TICKET_AGENT_EFFORT }),
      (ended, outcome) => {
        this.runs.delete(ended.runId);
        this.d.kubeconfigs?.remove(ended.runId);
        this.checkMirrors(ended);
        this.releaseTicketFolder(ended.spec.ticket.key, ended.runId, !!ended.spec.test);
        if (outcome.state === 'stopped') this.proposeDefault(ended);
        void this.d.abilities?.runEnded({ runId: ended.runId, agentNumber: ended.spec.agentNumber, ticket: key, state: outcome.state, ...(ended.spec.test ? { test: true } : {}) }).catch((error: unknown) => console.warn(`Abilities after ${ended.runId}: ${error instanceof Error ? error.message : String(error)}`));
        // Kept and noted once: a tester's run with commits GitHub lacks, as Agent 5 was, or a closed run with work.
        if (!outcome.folderRemoved && (ended.spec.test || ended.closed)) void this.noteKeptWork(ended.runId, outcome.state).catch(() => undefined);
      },
    );
    this.runs.set(runId, run);
    run.start();
    const notice = this.usageNotice();
    return { runId, agentNumber, ...(notice ? { notice } : {}) };
  }

  /**
   * A task agent: work alex asked for that is not tied to a ticket, such as a PR review, a solution page,
   * release notes, an environment comparison, a log analysis or Black Duck triage. Its own run folder and clones, the
   * same gate, tiers, proxies and delegation as a ticket agent, the model and effort Elfoqsy picked; no pushes. Its
   * result comes back into the conversation as a deliverable. Its ticket is a stand-in, task:<id>.
   */
  async spawnTask(args: TaskArgs): Promise<SpawnResult> {
    const s = this.d.live.get();
    const name = args.name.trim().replace(/\s+/g, ' ');
    const goal = args.goal.trim();
    if (!name || name.length > 40) return { error: 'bad_task', message: 'Give the task a short name, at most 40 characters.' };
    if (!goal) return { error: 'bad_task', message: 'Say the goal and what to deliver.' };
    const asked = args.model.trim().toLowerCase();
    const model = INVESTIGATOR_MODELS.find((m) => m === asked || m.split('-')[1] === asked);
    if (!model) return { error: 'bad_task', message: `Pick Haiku, Sonnet or Opus 5.5 for the task, not ${args.model}.` };
    if (!TASK_EFFORTS.includes(args.effort)) return { error: 'bad_task', message: `Effort is one of ${TASK_EFFORTS.join(', ')}.` };
    if (this.d.usage.isPaused) return { error: 'paused', message: 'Claude is paused for the usage limit; no new runs until it resets.' };
    const active = [...this.runs.values()].filter((r) => r.isActive).length;
    if (active >= this.maxAgents) {
      this.capacityWanted(`task "${name}"`);
      return { error: 'cap_reached', message: `${active} agents are working, the most allowed (${this.maxAgents}).` };
    }
    const repos = args.repos?.length ? this.reposFor('', args.repos, s) : [];
    if ('error' in repos) return repos;
    const needed = [...new Set(repos.flatMap((r) => (this.d.policies[r] ?? EMPTY_POLICY).needs))].filter((r) => !repos.includes(r));
    for (const repo of [...repos, ...needed]) {
      if (!this.d.clones.has(repo)) return { error: 'repo_missing', message: `There is no clone of ${repo} under REPOS_ROOT.` };
    }

    const runId = `run-${ulid().toLowerCase()}`;
    const id = runId.slice(-6);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
    const key = `task:${id}`;
    const branch = `elfoqsy-task/${slug}-${id}`;
    const runRoot = runFolder(this.d.config.worktreesRoot, taskFolderKey(this.d.config.worktreesRoot, slug), runId);
    if (runTmp(runRoot).length > MAX_TMPDIR) return { error: 'setup_failed', message: `The run folder ${runRoot} is too long for the sandbox's sockets.` };
    const agentNumber = Math.max(0, ...Object.values(s.runs).map((r) => r.agentNumber)) + 1;
    const task: TaskSpec = { name, goal, deliverable: args.deliverable };
    this.d.log.append('orchestrator', 'run.created', {
      runId,
      ticket: key,
      worktree: runRoot,
      branch,
      agentNumber,
      model,
      effort: args.effort,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      budget: { tokens: this.d.config.AGENT_MAX_TOKENS, minutes: this.d.config.AGENT_MAX_MINUTES },
      ...(repos.length ? { repos } : {}),
      ...(args.test ? { test: true as const } : {}),
      task,
    });
    this.d.log.append('orchestrator', 'run.state_changed', { runId, state: 'queued' });

    let prepared: PreparedRepo[];
    try {
      mkdirSync(runTmp(runRoot), { recursive: true });
      ensureAgentCache(this.d.config.agentCacheDir);
      prepared = [];
      for (const repo of repos) prepared.push(await prepareTarget(this.d.git, await this.d.mirrors.source(this.d.clones.get(repo)!), runRoot, branch));
      for (const repo of needed) prepared.push(await prepareDependency(this.d.git, await this.d.mirrors.source(this.d.clones.get(repo)!), runRoot));
    } catch (error) {
      rmSync(runRoot, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.d.log.append('orchestrator', 'run.state_changed', { runId, state: 'failed', reason: `Could not prepare the clones: ${message}` });
      return { error: 'setup_failed', message };
    }
    const kube = this.d.kubeconfigs ? await this.d.kubeconfigs.create(runId).catch(() => undefined) : undefined;
    const abilities = this.abilities(runRoot);
    const now = (this.d.now ?? Date.now)();
    const stamp = new Date(now).toISOString();
    const ticket: Ticket = { key, board: '', summary: name, type: 'Task', status: 'In progress', priority: 'Minor', storyPoints: null, sprint: '', sprintsCarried: 0, epic: null, reporter: 'alex', created: stamp, updated: stamp, labels: [], linked: [], description: goal };
    const identity = repos.length ? this.d.clones.get(repos[0]!)!.identity : null;
    const madeBy = (committedAt: number, email: string) => this.madeBy(key, committedAt, email, identity);
    const run = new AgentRun(
      {
        runId,
        agentNumber,
        ticket,
        linked: [],
        mode: 'normal',
        ...(abilities ? { abilities } : {}),
        rules: rulesFor(s, repos).map((r) => r.statement),
        branch,
        runRoot,
        repos: prepared,
        identity,
        createdAt: this.d.live.get().runs[runId]?.createdAt ?? now,
        ...(args.test ? { test: true } : {}),
        ...(kube ? { kubeconfig: kube.path } : {}),
        task,
      },
      this.runDeps(key, runId, madeBy, { model, effort: args.effort }),
      (ended, outcome) => {
        this.runs.delete(ended.runId);
        this.d.kubeconfigs?.remove(ended.runId);
        this.checkMirrors(ended);
        void this.d.abilities?.runEnded({ runId: ended.runId, agentNumber: ended.spec.agentNumber, state: outcome.state, ...(ended.spec.test ? { test: true } : {}) }).catch((error: unknown) => console.warn(`Abilities after ${ended.runId}: ${error instanceof Error ? error.message : String(error)}`));
        if (!outcome.folderRemoved && (ended.spec.test || ended.closed)) void this.noteKeptWork(ended.runId, outcome.state).catch(() => undefined);
      },
    );
    this.runs.set(runId, run);
    run.start();
    const notice = this.usageNotice();
    return { runId, agentNumber, ...(notice ? { notice } : {}) };
  }

  /** What a run needs from the orchestrator: the log, approvals, proxies, limits, Elfoqsy and the web check. */
  private runDeps(key: string, runId: string, madeBy: (committedAt: number, email: string) => string, agent: { model: string; effort: Effort }): RunDeps {
    return {
      log: this.d.log,
      usage: this.d.usage,
      approvals: this.approvals,
      git: this.d.git,
      proxies: this.proxies,
      environments: this.d.environments,
      queryFn: this.d.queryFn,
      policies: this.d.policies,
      baseEnv: this.d.baseEnv,
      hosts: this.d.hosts,
      protectedPaths: this.d.protectedPaths,
      ...(this.d.home ? { home: this.d.home } : {}),
      cacheDir: this.d.config.agentCacheDir,
      limits: {
        maxMinutes: this.d.config.AGENT_MAX_MINUTES,
        maxTokens: this.d.config.AGENT_MAX_TOKENS,
        heartbeatMinutes: this.d.config.AGENT_HEARTBEAT_MINUTES,
        maxSubagents: this.d.config.MAX_PARALLEL_SUBAGENTS,
        models: this.d.config.SUBAGENT_MODELS,
        efforts: this.d.config.SUBAGENT_EFFORTS as never,
      },
      ticketAgent: agent,
      madeBy,
      hasOpenPr: (ticketKey, reposOfRun) => this.hasOpenPr(ticketKey, reposOfRun),
      ...(this.d.commitCi ? { commitCi: this.d.commitCi } : {}),
      say: (text, blocks) => this.say(key, runId, text, blocks),
      draftTicket: (o) => this.draftTicket(o),
      firstResponder: () => this.firstResponder,
      ...(this.d.outbound ? { outbound: this.d.outbound } : {}),
      ...(this.d.prReviewRounds ? { reviewRounds: (t: string, rs: string[]) => this.reviewRounds(t, rs) } : {}),
      ...(this.d.backends.jira ? { ticketText: (k: string) => this.d.backends.jira!.get(k).then((f) => f.text) } : {}),
      narrative: () => buildNarrative(this.d.live.get(), runId),
      ...(this.d.clock ? { clock: this.d.clock } : {}),
      ...(this.d.now ? { now: this.d.now } : {}),
    };
  }

  /** Pause, resume and guidance from a pane or through Elfoqsy (RunControl). */
  pause(runId: string, by: Actor, reason?: string): ControlResult {
    const run = this.runs.get(runId);
    return run ? run.pause(by, reason) : { error: 'unknown_run', message: 'That agent is not running.' };
  }

  resume(runId: string, by: Actor, reason?: string): ControlResult {
    const run = this.runs.get(runId);
    return run ? run.resume(by, reason) : { error: 'unknown_run', message: 'That agent is not running.' };
  }

  guide(runId: string, text: string, by: Actor): ControlResult {
    const run = this.runs.get(runId);
    return run ? run.guide(text, by) : { error: 'unknown_run', message: 'That agent is not running.' };
  }

  /** A message from alex (or the tester) through Elfoqsy, for example an objection to the plan. */
  tell(runId: string, text: string, from: 'alex' | 'tester'): { ok: true } | { error: 'unknown_run'; message: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: 'unknown_run', message: `${runId} is not running.` };
    run.forward(`[${from === 'tester' ? 'The tester (not alex)' : 'alex'}, through Elfoqsy] ${text}`);
    return { ok: true };
  }

  /** Elfoqsy's line about a run, in its conversation (its own, its ticket's, or Today's), from the orchestrator. */
  private say(ticket: string, runId: string, text: string, blocks?: MessageBlock[]): void {
    const conversationId = this.d.conversations ? this.d.conversations.for(ticket, runId) : this.d.live.get().runs[runId]?.conversationId;
    this.d.log.append('orchestrator', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      text,
      ...(conversationId ? { conversationId } : {}),
      refs: { tickets: [ticket], runId },
      ...(blocks?.length ? { blocks } : {}),
    });
  }

  private readonly mirrorChecks = new Set<Promise<void>>();

  /**
   * After a run: git fsck on the mirror of each repository it had a clone of, made again if a run damaged it (a run clone shares object
   * files with the mirror, so what a shell does to its own can reach it, and never his clone). Not waited for: it can take a minute.
   */
  private checkMirrors(run: AgentRun): void {
    const repos = [...new Set(run.spec.repos.map((r) => r.repo))];
    const work = (async () => {
      for (const repo of repos) {
        const clone = this.d.clones.get(repo);
        if (!clone) continue;
        const result = await this.d.mirrors.check(clone).catch((error: unknown) => ({ repo, ok: false, recreated: false, ms: 0, problem: error instanceof Error ? error.message : String(error) }));
        this.d.log.append('orchestrator', 'mirror.checked', { repo, runId: run.runId, ok: result.ok, ...(result.recreated ? { recreated: true as const } : {}), ms: result.ms, ...(result.problem ? { problem: redact(result.problem).slice(0, 400) } : {}) });
        if (result.ok) continue;
        const name = repo.split('/').at(-1) ?? repo;
        const who = run.spec.agentNumber ? `Agent ${run.spec.agentNumber}` : run.spec.ticket.key;
        this.say(
          run.spec.ticket.key,
          run.runId,
          result.recreated
            ? tr(`The mirror of ${name} was damaged after ${who}'s run, and I made it again. Your own clone was not touched.`, `Mirror của ${name} bị hỏng sau lượt chạy của ${who}, tôi đã dựng lại. Clone của cậu không bị đụng tới.`)
            : tr(`I could not check or rebuild the mirror of ${name} after ${who}'s run: ${firstSentence(result.problem ?? 'no reason given')}. Your own clone was not touched.`, `Tôi không kiểm tra hay dựng lại được mirror của ${name} sau lượt chạy của ${who}: ${firstSentence(result.problem ?? 'không có lý do')}. Clone của cậu không bị đụng tới.`),
        );
      }
    })()
      .catch(() => undefined)
      .finally(() => this.mirrorChecks.delete(work));
    this.mirrorChecks.add(work);
  }

  /**
   * Whether alex seems to be working on the ticket himself: its case.md changed in the last day with no run holding
   * the folder, or a /code worktree on the ticket's branch has uncommitted changes. The question for him, or null.
   */
  private async manualSession(key: string): Promise<string | null> {
    if (!this.d.tickets) return null;
    const now = (this.d.now ?? Date.now)();
    const reasons: string[] = [];
    const dir = join(this.d.tickets.root, key);
    const casePath = join(dir, 'case.md');
    const marker = join(dir, RUN_MARKER);
    if (existsSync(marker)) {
      // A marker no live run holds was left by a daemon that stopped: it no longer holds the folder.
      const holder = readFileSync(marker, 'utf8').trim();
      if (!this.runs.has(holder)) rmSync(marker, { force: true });
    }
    if (existsSync(casePath) && !existsSync(marker)) {
      const age = now - statSync(casePath).mtimeMs;
      if (age < MANUAL_FRESH_MS) reasons.push(`~/tickets/${key}/case.md changed ${ago(age)}`);
    }
    const num = key.split('-')[1] ?? key;
    const code = this.d.tickets.codeRoot;
    if (code && existsSync(code)) {
      for (const name of readdirSync(code).sort()) {
        const path = join(code, name);
        if (!existsSync(join(path, '.git'))) continue;
        const branch = (await this.d.git.tryRun(['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])) ?? '';
        if (!branch.toUpperCase().includes(key) && !new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(basename(path))) continue;
        const dirty = await this.d.git.tryRun(['-C', path, 'status', '--porcelain']);
        if (dirty?.trim()) reasons.push(`${path} (${branch || 'detached'}) has uncommitted changes`);
      }
    }
    if (!reasons.length) return null;
    return `alex may be working on ${key} himself: ${reasons.join('; ')}. Ask him before starting an agent on it, and call spawn_agent again with confirmManual: true only when he says go.`;
  }

  /** The most bot-review rounds of the ticket's open PRs in these repositories. */
  private async reviewRounds(ticket: string, repos: string[]): Promise<number> {
    const wanted = new Set(repos.map((r) => r.toLowerCase()));
    const prs = Object.values(this.d.live.get().prs).filter((p) => p.ticket === ticket && (p.state === 'open' || p.state === 'draft') && wanted.has(p.repo.toLowerCase()));
    const rounds = await Promise.all(prs.map((p) => this.d.prReviewRounds!(p.repo, p.number).catch(() => 0)));
    return Math.max(0, ...rounds);
  }

  /** Where a run keeps its ticket folder: his ~/tickets, or for a tester's run its own root. */
  private ticketsRoot(test: boolean): string | undefined {
    if (!this.d.tickets) return undefined;
    return test && this.d.tickets.testRoot ? this.d.tickets.testRoot : this.d.tickets.root;
  }

  /** The ticket folder, held by this run while it works (its id in .elfoqsy-run). Undefined without ticket folders. */
  private holdTicketFolder(key: string, runId: string, test: boolean): string | undefined {
    const root = this.ticketsRoot(test);
    if (!root) return undefined;
    const dir = join(root, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUN_MARKER), `${runId}\n`);
    return dir;
  }

  /** The run ended: the folder is no longer held, unless another run holds it now. */
  private releaseTicketFolder(key: string, runId: string, test: boolean): void {
    const root = this.ticketsRoot(test);
    if (!root) return;
    const marker = join(root, key, RUN_MARKER);
    try {
      if (readFileSync(marker, 'utf8').trim() === runId) rmSync(marker, { force: true });
    } catch {
      /* already gone */
    }
  }

  /** The run's read-only copy of the Abilities skills, beside its team-dev copy. Undefined when there are none. */
  private abilities(runRoot: string): Abilities | undefined {
    return this.d.abilitiesDir ? (copyAbilities(this.d.abilitiesDir, join(runRoot, '.elfoqsy', ABILITIES)) ?? undefined) : undefined;
  }

  /**
   * The run's read-only copy of the team-dev skill, logged by its version; the adapter goes with it once it exists
   * (prompts/skill-adapter.md, after alex approved the table). Undefined without the skill.
   */
  private snapshotSkill(runId: string, runRoot: string): RunSpec['skill'] {
    const sk = this.d.skill;
    if (!sk || !existsSync(join(sk.dir, 'SKILL.md'))) return undefined;
    this.checkSkill();
    const snap = snapshotSkill(sk.dir, join(runRoot, '.elfoqsy', 'team-dev'));
    this.d.log.append('orchestrator', 'run.skill_snapshot', { runId, hash: snap.hash, files: snap.files });
    const adapter = existsSync(sk.adapterFile) ? readFileSync(sk.adapterFile, 'utf8') : undefined;
    return { dir: snap.dir, hash: snap.hash, skillMd: snap.skillMd, ...(adapter ? { adapter } : {}) };
  }

  /**
   * What the reviewer reads besides the diff: the ticket's handoff and acceptance criteria, written into the run folder as they are now
   * (reviewPack.ts). Not for a read-only run: it pushes nothing, so it has no review. Undefined when it could not be written: the run
   * goes on without it, and the reviewer's instructions then do not mention it.
   */
  private async reviewPack(runRoot: string, ticket: Ticket, handoff: string | undefined): Promise<string | undefined> {
    try {
      // Jira can be slow or down: the run does not wait for more than a few seconds for one field (the file then says it was not read).
      const clock = this.d.clock ?? realClock;
      let timer: unknown;
      const acceptance = await Promise.race([
        this.d.acceptanceOf?.(ticket.key).catch(() => undefined) ?? Promise.resolve(undefined),
        new Promise<undefined>((resolve) => {
          timer = clock.setTimeout(() => resolve(undefined), REVIEW_PACK_WAIT_MS);
        }),
      ]);
      clock.clearTimeout(timer);
      return writeReviewPack(runRoot, { ticket, ...(acceptance ? { acceptance } : {}), ...(handoff ? { handoff } : {}) }).dir;
    } catch (error) {
      console.warn(`The reviewer's pack for ${ticket.key} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Whether the skill changed since the adapter's version: Elfoqsy says once which sections changed. */
  checkSkill(): boolean {
    const sk = this.d.skill;
    if (!sk) return false;
    const change = skillChange(sk.dir, readManifest(sk.manifestFile), this.d.live.get());
    if (!change) return false;
    this.d.log.append('orchestrator', 'skill.changed', change);
    const today = todayConversation((this.d.now ?? Date.now)());
    this.d.log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: skillChangeText(change), conversationId: today.conversationId });
    return true;
  }

  /** The facts in the skill's references/environments.md, in Elfoqsy's memory with the skill as their source. */
  seedSkillFacts(): number {
    const sk = this.d.skill;
    if (!sk || !existsSync(sk.dir)) return 0;
    const events = seedEnvironmentFacts(sk.dir, this.d.live.get(), (this.d.now ?? Date.now)());
    for (const e of events) {
      if (e.type === 'memory.saved') this.d.log.append('orchestrator', 'memory.saved', e.payload);
      else this.d.log.append('orchestrator', 'memory.forgotten', e.payload);
    }
    return events.length;
  }

  /**
   * A verdict stopped the run: Elfoqsy says so in one line and proposes the default, the agent's comment for the ticket,
   * as a Jira comment through the proxy (tier 2: alex approves it, or not; a tester's run only logs it).
   */
  private proposeDefault(run: AgentRun): void {
    const v = run.workflow.verdict;
    if (!v || !STOPPING.has(v.verdict)) return;
    const key = run.spec.ticket.key;
    const what = DEFAULTS[v.verdict]?.(key) ?? { en: `comment on ${key}`, vi: `comment trên ${key}` };
    this.say(
      key,
      run.runId,
      tr(
        `Agent ${run.spec.agentNumber} stopped after its verdict on ${key}: ${verdictLine(v)}. I propose to ${what.en}, with the comment it wrote; approve it to post it, or not.`,
        `Agent ${run.spec.agentNumber} đã dừng sau khi có kết luận về ${key}: ${verdictLine(v)}. Tôi đề nghị ${what.vi}, kèm comment nó đã viết; cậu duyệt để đăng, hoặc không.`,
      ),
      [{ type: 'verdict', ref: run.runId }],
    );
    if (!v.ticketComment) return;
    const ref: RunRef = {
      runId: run.runId,
      ticket: key,
      agentNumber: run.spec.agentNumber,
      branch: run.spec.branch,
      targets: run.spec.repos.filter((r) => r.role === 'target').map((r) => ({ repo: r.repo, base: r.base })),
      kubeconfig: join(this.d.config.worktreesRoot, '.no-kubeconfig'),
      ...(run.spec.test ? { test: true } : {}),
    };
    void this.proxies.request(ref, 'jira', { action: 'comment', key, text: v.ticketComment }).catch(() => undefined);
  }

  /**
   * The close-out after merge and QA: case.md regenerated from the log (the run's own last one kept under
   * evidence/), the QA testing notes and the solution page's draft, in the ticket folder; Elfoqsy says so in one line.
   * Publishing the page is asked (tier 2), under the release page when the run's base names the release; otherwise he
   * is asked where it goes. qa: how QA passed, in his words or from Jira.
   */
  async closeOut(key: string, qa: string): Promise<{ ok: true; files: string[]; pageRequested: boolean } | { error: string; message: string }> {
    if (!this.d.tickets) return { error: 'no_ticket_folders', message: 'There are no ticket folders here.' };
    const s = this.d.live.get();
    // A tester's runs are no part of his ticket's record.
    const runs = runsOf(s, key).filter((r) => !r.test);
    if (!runs.length) return { error: 'no_runs', message: `No agent worked on ${key}; there is nothing of the workspace's to close out.` };
    if (runs.some((r) => !ENDED.has(r.state))) return { error: 'still_working', message: `An agent is still on ${key}.` };
    if (!Object.values(s.prs).some((p) => p.ticket === key && p.state === 'merged')) return { error: 'not_merged', message: `No PR of ${key} is merged yet.` };
    const now = (this.d.now ?? Date.now)();
    const dir = join(this.d.tickets.root, key);
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    const casePath = join(dir, 'case.md');
    if (existsSync(casePath)) {
      const kept = join(dir, 'evidence', `case-before-close-out-${new Date(now).toISOString().slice(0, 10)}.md`);
      if (!existsSync(kept)) writeFileSync(kept, readFileSync(casePath));
    }
    const page = solutionPage(s, key);
    writeFileSync(casePath, caseMarkdown(s, key, now, qa));
    writeFileSync(join(dir, 'qa-notes.md'), qaNotes(s, key));
    writeFileSync(join(dir, 'solution-page.md'), `# ${page.title}\n\n${page.text}`);
    const files = ['case.md', 'qa-notes.md', 'solution-page.md'];
    // Under the release page, when a run's base names the release (release/2.22.0 -> "Release/2.22.0").
    const release = runs.flatMap((r) => Object.values(r.bases ?? {})).find((b) => b.startsWith('release/'))?.slice('release/'.length);
    const last = runs.at(-1)!;
    let parentId: string | undefined;
    if (release && this.d.backends.confluence) {
      const found = await this.d.backends.confluence.search(`space = SHOP and title = "Release/${release}"`, 1).catch(() => '');
      parentId = /^(\d+)\s/.exec(found)?.[1];
    }
    this.d.log.append('orchestrator', 'ticket.closed_out', { ticket: key, qa, files, ...(parentId ? { pageRequested: true as const } : {}) });
    this.say(
      key,
      last.runId,
      tr(
        `${key} is merged and QA passed. I regenerated case.md from the log and drafted the QA notes and the solution page in ~/tickets/${key}/.${parentId ? ` Publishing the page under Release/${release} is yours to approve.` : ' Tell me the release page and I will ask to publish the page under it.'}`,
        `${key} đã được merge và QA đã qua. Tôi đã dựng lại case.md từ log, và soạn ghi chú QA cùng trang giải pháp trong ~/tickets/${key}/.${parentId ? ` Cậu duyệt thì tôi mới đăng trang đó dưới Release/${release}.` : ' Cậu cho tôi biết trang release, tôi sẽ xin phép đăng trang giải pháp dưới đó.'}`,
      ),
    );
    if (parentId) {
      const ref: RunRef = { runId: last.runId, ticket: key, agentNumber: last.agentNumber, branch: last.branch, targets: [], kubeconfig: join(this.d.config.worktreesRoot, '.no-kubeconfig'), ...(last.test ? { test: true } : {}) };
      void this.proxies.request(ref, 'confluence', { action: 'create', space: 'SHOP', title: page.title, body: page.text, parentId }).catch(() => undefined);
    }
    return { ok: true, files, pageRequested: !!parentId };
  }

  /** Stops a run and says exactly what is left of it: branch, commits, changes, folder. */
  async cancel(runId: string, reason: string): Promise<({ ok: true } & RunOutcome) | { error: 'unknown_run'; message: string }> {
    const run = this.runs.get(runId);
    if (!run) return { error: 'unknown_run', message: `${runId} is not running.` };
    return { ok: true, ...(await run.cancel(reason || 'Cancelled.')) };
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await Promise.all([...this.runs.values()].map((run) => run.end('cancelled', 'The daemon stopped.')));
    await Promise.allSettled([...this.mirrorChecks]); // a check that is still running writes to the log
    this.firstResponder.close();
    this.digests?.close();
    this.approvals.close();
    this.grants.close();
    this.proxies.close();
  }

  /** Which repositories a run works in: those named, else those of the ticket's open PRs. */
  private reposFor(key: string, named: string[] | undefined, s: WorkspaceState): string[] | Extract<SpawnResult, { error: string }> {
    const allowed = new Map(this.d.config.GITHUB_REPOS.map((r) => [r.toLowerCase(), r]));
    if (named?.length) {
      const out: string[] = [];
      for (const r of named) {
        const repo = allowed.get(r.toLowerCase());
        if (!repo) return { error: 'unknown_repo', message: `${r} is not in GITHUB_REPOS: ${this.d.config.GITHUB_REPOS.join(', ')}.` };
        out.push(repo);
      }
      return [...new Set(out)];
    }
    const fromPrs = [...new Set(Object.values(s.prs).filter((p) => p.ticket === key && (p.state === 'open' || p.state === 'draft')).map((p) => p.repo))];
    if (fromPrs.length) return fromPrs.map((r) => allowed.get(r.toLowerCase()) ?? r);
    return {
      error: 'repo_needed',
      message: `Which repositories does ${key} need? Pass repos from: ${this.d.config.GITHUB_REPOS.join(', ')}. Ask alex if unsure.`,
    };
  }

  /**
   * The plan's usage when it is high, as information that comes with a run starting, never a question and never a wait
   *: it reads the last figure it has, and asks Claude for a fresh one in the background for next time. A usage
   * limit that is reached still pauses a run by itself.
   */
  private usageNotice(): SpawnNotice | undefined {
    void this.d.usageProbe?.().then((probed) => probed && this.d.usage.record(probed)).catch(() => undefined);
    const snap = this.d.usage.latest;
    if (!snap) return undefined;
    const five = snap.fiveHour?.utilization ?? null;
    const seven = snap.sevenDay?.utilization ?? null;
    const parts: string[] = [];
    if (five !== null && five >= this.d.config.USAGE_WARN_FIVE_HOUR) parts.push(`${Math.round(five)}% of the 5-hour limit`);
    if (seven !== null && seven >= this.d.config.USAGE_WARN_SEVEN_DAY) parts.push(`${Math.round(seven)}% of the weekly limit`);
    if (!parts.length && snap.status === 'allowed_warning') parts.push('close to a usage limit');
    if (!parts.length) return undefined;
    return { kind: 'usage_high', message: `alex's Claude plan is at ${parts.join(' and ')}. The agent has started; if the limit is reached it pauses and goes on by itself after the reset.` };
  }

  private hasOpenPr(ticket: string, repos: string[]): boolean {
    const wanted = new Set(repos.map((r) => r.toLowerCase()));
    return Object.values(this.d.live.get().prs).some(
      (p) => p.ticket === ticket && (p.state === 'open' || p.state === 'draft') && wanted.has(p.repo.toLowerCase()),
    );
  }

  /**
   * The kept clones a new run on `ticket` may start from: an ended run of the same ticket whose folder is still
   * there with a clone of the repositories. Its branch is fetched from there, never pushed from there.
   */
  private keptBranch(s: WorkspaceState, fromRun: string, ticket: string, repos: string[], branch: string): { seeds: Record<string, string> } | { error: SpawnError; message: string } {
    const from = s.runs[fromRun];
    if (!from) return { error: 'unknown_run', message: `There is no run ${fromRun}.` };
    const agent = `Agent ${from.agentNumber}`;
    if (from.ticket !== ticket || from.branch !== branch) return { error: 'wrong_run', message: `${agent} worked on ${from.ticket}, not ${ticket}.` };
    if (!ENDED.has(from.state)) return { error: 'not_ended', message: `${agent} has not ended; stop it first.` };
    if (!from.worktree || !existsSync(from.worktree)) return { error: 'no_kept_work', message: `${agent}'s run folder is gone; there is nothing to start from.` };
    const seeds: Record<string, string> = {};
    for (const repo of repos) {
      const path = join(from.worktree, repoDir(repo));
      if (existsSync(join(path, '.git'))) seeds[repo] = path;
    }
    if (!Object.keys(seeds).length) return { error: 'no_kept_work', message: `${agent}'s run folder has no clone of ${repos.join(', ')}.` };
    return { seeds };
  }

  /**
   * Who made a commit on a ticket's branch: the agent whose run on that ticket was working when it was
   * committed, else alex when it carries his identity, else its author. Agents commit as him, so time
   * tells them apart.
   */
  private madeBy(ticket: string, committedAt: number, email: string, identity: { email: string } | null): string {
    const now = (this.d.now ?? Date.now)();
    // Commit times are whole seconds.
    const run = Object.values(this.d.live.get().runs).find(
      (r) => r.ticket === ticket && r.createdAt - 1000 <= committedAt && committedAt <= (ENDED.has(r.state) ? r.stateAt : now) + 1000,
    );
    if (run) return `Agent ${run.agentNumber}`;
    return identity && email.toLowerCase() === identity.email.toLowerCase() ? 'alex' : email || 'unknown';
  }

  /**
   * The clones in a run's folder of the repositories it changes: those it names, or for runs from before
   * milestone 11, those with GitHub as their remote. Read-only siblings have no remote and are left out.
   */
  private async folderClones(run: RunView): Promise<Array<{ repo: string; path: string; base: string }>> {
    const out: Array<{ repo: string; path: string; base: string }> = [];
    for (const repo of run.repos ?? [...this.d.clones.keys()]) {
      const clone = this.d.clones.get(repo);
      const path = join(run.worktree, repoDir(repo));
      if (!clone || !existsSync(join(path, '.git'))) continue;
      if (!run.repos && !(await this.d.git.tryRun(['-C', path, 'remote', 'get-url', 'origin']))) continue;
      out.push({ repo, path, base: clone.defaultBranch });
    }
    return out;
  }

  /** What is left in an ended run's folder, per repository; null where it could not be checked. */
  private async leftIn(run: RunView): Promise<Array<{ repo: string; commits: KeptWork['commits'] | null; changes: boolean | null }>> {
    if (!run.worktree || !existsSync(run.worktree)) return [];
    const left: Array<{ repo: string; commits: KeptWork['commits'] | null; changes: boolean | null }> = [];
    for (const { repo, path, base } of await this.folderClones(run)) {
      const commits = await unpushedCommits(this.d.git, path, run.branch, base).catch(() => null);
      const changes = await hasChanges(this.d.git, path).catch(() => null);
      left.push({ repo, commits, changes });
    }
    return left;
  }

  /** What an ended run's kept folder holds that GitHub lacks: commits, newest first, and uncommitted changes, per repository. */
  private async keptWork(run: RunView): Promise<KeptWork[]> {
    return (await this.leftIn(run))
      .map((l) => ({ repo: l.repo, commits: l.commits ?? [], changes: l.changes === true }))
      .filter((k) => k.commits.length || k.changes);
  }

  /** The fact Elfoqsy offers kept work from, or (uncommitted changes only) knows where it is. */
  private keptFact(run: RunView, kept: KeptWork[]): PayloadOf<'memory.saved'> {
    const agent = `Agent ${run.agentNumber}`;
    const changes = changesText(kept);
    return {
      factId: `kept-${run.runId}`,
      statement: kept.some((k) => k.commits.length)
        ? `${agent}'s work on ${run.ticket} is kept in ${tilde(run.worktree)}: ${keptText(run, kept)}, not on GitHub${changes ? `, and ${changes}` : ''}. Offer it as the starting point of the next run on ${run.ticket}: spawn_agent with fromRun ${run.runId}. Its push then lists these commits and who made them.`
        : `${agent}'s folder on ${run.ticket} is kept in ${tilde(run.worktree)} for its ${changes}. It holds no commits GitHub lacks, so it is no starting point for a new run; mention it if alex asks about that work.`,
      sources: [{ kind: 'ticket', ref: run.ticket, label: `${agent}'s kept run folder` }],
      freshUntil: new Date((this.d.now ?? Date.now)() + 30 * 24 * 3600_000).toISOString(),
      origin: 'run',
      kind: 'fact',
    };
  }

  /**
   * An ended run's work that GitHub lacks, when its folder was kept: said once in its ticket's conversation, in
   * Elfoqsy's voice, and remembered, so she can offer its commits as the starting point of the next run on the
   * ticket. For a closed run (cancelled, dismissed, its PR merged or closed), and for a tester's run that ends
   * with commits. Nothing is moved or pushed.
   */
  async noteKeptWork(runId: string, how: EndState | Closure = 'dismissed'): Promise<boolean> {
    const s = this.d.live.get();
    const run = s.runs[runId];
    if (!run || keptFacts(s, runId).length) return false;
    const kept = await this.keptWork(run);
    if (!kept.length) return false;
    const agent = `Agent ${run.agentNumber}`;
    const ended = tr(
      typeof how === 'object'
        ? `is closed: ${how.pr} was ${how.state}`
        : { dismissed: 'is dismissed', succeeded: 'has ended', stopped: 'has stopped', failed: 'has failed', cancelled: 'was cancelled' }[how],
      typeof how === 'object'
        ? `đã đóng: ${how.pr} ${how.state === 'merged' ? 'đã được merge' : 'đã bị đóng'}`
        : { dismissed: 'đã bị bỏ qua', succeeded: 'đã kết thúc', stopped: 'đã dừng', failed: 'đã thất bại', cancelled: 'đã bị hủy' }[how],
    );
    const changes = changesText(kept);
    const changesVi = changesTextVi(kept);
    const where = tilde(run.worktree);
    this.d.log.append('orchestrator', 'elfoqsy.message', {
      messageId: ulid(),
      role: 'elfoqsy',
      ...(this.d.conversations ? { conversationId: this.d.conversations.for(run.ticket, runId) } : {}),
      text: kept.some((k) => k.commits.length)
        ? tr(
            `${agent} ${ended}, and its work is kept for the next run on ${run.ticket}: ${keptText(run, kept)}, not on GitHub${changes ? `, and ${changes}` : ''}, in ${where}. A new run can start from it; its push will list these commits for you.${changes ? ' The uncommitted changes stay only in that folder.' : ''}`,
            `${agent} ${ended}, và công việc của nó được giữ lại cho lượt chạy tiếp theo trên ${run.ticket}: ${keptTextVi(run, kept)}, chưa có trên GitHub${changesVi ? `, và ${changesVi}` : ''}, trong ${where}. Một run mới có thể bắt đầu từ đó; khi push, nó sẽ liệt kê các commit này cho cậu.${changesVi ? ' Các thay đổi chưa commit chỉ nằm trong thư mục đó.' : ''}`,
          )
        : tr(
            `${agent} ${ended}, and its folder is kept for its ${changes}, in ${where}. It holds no commits GitHub lacks, so a new run on ${run.ticket} starts from GitHub.`,
            `${agent} ${ended}, và thư mục của nó được giữ lại vì còn ${changesVi}, trong ${where}. Nó không có commit nào mà GitHub chưa có, nên run mới trên ${run.ticket} sẽ bắt đầu từ GitHub.`,
          ),
      refs: { tickets: [run.ticket], runId },
    });
    this.d.log.append('orchestrator', 'memory.saved', this.keptFact(run, kept));
    return true;
  }

  /**
   * At start: each fact about kept work made true again. The folder or its commits gone, the fact is forgotten;
   * otherwise it is said the current way, under the run's own fact id.
   */
  async refreshKeptWork(): Promise<number> {
    const s = this.d.live.get();
    let changed = 0;
    for (const run of Object.values(s.runs)) {
      const facts = keptFacts(s, run.runId);
      if (!facts.length) continue;
      const kept = await this.keptWork(run);
      const fresh = kept.length ? this.keptFact(run, kept) : undefined;
      for (const f of facts) {
        if (fresh && f.factId === fresh.factId && f.statement === fresh.statement) continue;
        if (!fresh || f.factId !== fresh.factId) {
          this.d.log.append('orchestrator', 'memory.forgotten', { factId: f.factId, by: 'orchestrator' });
          changed++;
        }
      }
      const current = facts.find((f) => f.factId === fresh?.factId);
      if (fresh && current?.statement !== fresh.statement) {
        this.d.log.append('orchestrator', 'memory.saved', fresh);
        changed++;
      }
    }
    return changed;
  }

  /**
   * A real run's folder once the run is closed (dismissed, cancelled, or its ticket's PR merged or closed):
   * removed when nothing in it is uncommitted or missing from GitHub, otherwise kept and noted once. A run
   * still at work, a tester's run and a folder already gone are left alone.
   */
  async closeFolder(runId: string, how: Closure): Promise<'removed' | 'noted' | 'kept' | 'none'> {
    const run = this.d.live.get().runs[runId];
    if (!run || run.test || !ENDED.has(run.state) || this.runs.has(runId) || this.closing.has(runId)) return 'none';
    if (!run.worktree || !existsSync(run.worktree)) return 'none';
    this.closing.add(runId);
    try {
      const left = await this.leftIn(run);
      if (left.every((l) => l.commits?.length === 0 && l.changes === false)) {
        rmSync(run.worktree, { recursive: true, force: true });
        this.d.log.append('orchestrator', 'run.folder_removed', {
          runId,
          folder: run.worktree,
          reason: `${closureText(how)}, with nothing uncommitted and nothing missing from GitHub.`,
        });
        return 'removed';
      }
      return (await this.noteKeptWork(runId, how)) ? 'noted' : 'kept';
    } finally {
      this.closing.delete(runId);
    }
  }

  /** At start: the folders of runs that were closed before (dismissed or cancelled) and are still there. */
  async closeEndedFolders(): Promise<{ removed: number; noted: number }> {
    const done = { removed: 0, noted: 0 };
    for (const run of Object.values(this.d.live.get().runs)) {
      const how = run.dismissed ? 'dismissed' : run.state === 'cancelled' ? 'cancelled' : undefined;
      if (!how) continue;
      const result = await this.closeFolder(run.runId, how);
      if (result === 'removed' || result === 'noted') done[result]++;
    }
    return done;
  }

  /**
   * PRs merged or closed end their run, and close runs on their ticket that had already ended; CI failing on a
   * run's PR goes back to its agent (flow 3). A dismissed failure closes its run.
   */
  private onEvent(prev: WorkspaceState, event: AnyEnvelope, next: WorkspaceState): void {
    const runFor = (ticket: string) => [...this.runs.values()].find((r) => r.spec.ticket.key === ticket && r.phase !== 'ended');
    if (event.type === 'ticket.synced') {
      // Jira moved a merged ticket an agent worked on to Done or Released: QA passed, so it is closed out, once.
      const t = event.payload.ticket;
      const was = prev.tickets[t.key]?.status;
      if ((t.status === 'Done' || t.status === 'Released') && was && was !== 'Done' && was !== 'Released' && !next.closedOut[t.key]) {
        void this.closeOut(t.key, `Jira moved it to ${t.status}.`).catch(() => undefined);
      }
      return;
    }
    if (event.type === 'run.verdict') {
      // In chat the moment it is reported; a verdict that stops the run is said once it has stopped, with the default.
      const p = event.payload;
      const run = next.runs[p.runId];
      if (run && !STOPPING.has(p.verdict)) {
        const confirm = p.example ? tr(' Its expected behaviour goes on as a flagged decision, for you to decide at review.', ' Hành vi mong đợi của nó được đưa vào như một quyết định có gắn cờ, để cậu quyết lúc review.') : '';
        if (prev.runs[p.runId]?.verdict) {
          // A later report of the same verdict (reproduced, say): one plain line.
          this.say(run.ticket, run.runId, tr(`Agent ${run.agentNumber}'s verdict on ${run.ticket}: ${verdictLine(p)}.${confirm}`, `Kết luận của Agent ${run.agentNumber} về ${run.ticket}: ${verdictLine(p)}.${confirm}`));
        } else {
          // The first one (N1): one line with a link that opens the ticket at its verdict, in the narrative. Nothing waits.
          this.say(
            run.ticket,
            run.runId,
            tr(
              `Agent ${run.agentNumber} reached its verdict on ${run.ticket}: ${verdictLine(p)}. ${firstSentence(p.summary)}${confirm || ' Nothing waits for you.'}`,
              `Agent ${run.agentNumber} đã có kết luận về ${run.ticket}: ${verdictLine(p)}. ${firstSentence(p.summary)}${confirm || ' Không có gì đang chờ cậu.'}`,
            ),
            [{ type: 'narrative' as const, ref: run.runId, section: 2 as const }],
          );
        }
      }
      return;
    }
    if (event.type === 'run.handed_back') {
      // The hand-back (N1): one line with a link to the narrative, where "Ready for review waits for you".
      const run = next.runs[event.payload.runId];
      if (!run || run.task) return;
      const pr = Object.values(next.prs).filter((x) => x.ticket === run.ticket && (x.state === 'draft' || x.state === 'open')).sort((a, b) => b.number - a.number)[0];
      const ci = pr ? next.ci[prKey(pr)]?.status : undefined;
      const what = pr ? `${pr.state === 'draft' ? 'draft ' : ''}PR ${pr.repo.split('/').at(-1)}#${pr.number}${ci ? `, CI ${ci === 'success' ? 'green' : ci === 'failure' ? 'red' : ci}` : ''}` : 'its work';
      // What the review called NOT MET goes with it, since it is his to decide before the PR is ready (it is in Verification).
      const unmet = (reviewedCriteria(run) ?? []).filter((c) => c.status === 'not_met').map((c) => c.n);
      const unmetEn = unmet.length ? ` ${unmet.length === 1 ? 'One acceptance criterion is' : `${unmet.length} acceptance criteria are`} NOT MET (${unmet.join(', ')}): they are in Verification, for you to decide.` : '';
      const unmetVi = unmet.length ? ` ${unmet.length} tiêu chí nghiệm thu chưa đạt, NOT MET (${unmet.join(', ')}): cậu xem ở phần Verification rồi quyết định.` : '';
      const whatVi = pr ? `${pr.state === 'draft' ? 'PR draft' : 'PR'} ${pr.repo.split('/').at(-1)}#${pr.number}${ci ? `, CI ${ci === 'success' ? 'xanh' : ci === 'failure' ? 'đỏ' : ci}` : ''}` : 'công việc của nó';
      this.say(
        run.ticket,
        run.runId,
        tr(
          `Agent ${run.agentNumber} handed back ${run.ticket} with ${what}.${unmetEn} Read what we know${pr?.state === 'draft' ? ', then mark it ready' : ''}.`,
          `Agent ${run.agentNumber} đã bàn giao lại ${run.ticket} kèm ${whatVi}.${unmetVi} Cậu đọc “What we know”${pr?.state === 'draft' ? ', rồi đánh dấu sẵn sàng' : ''}.`,
        ),
        [{ type: 'narrative' as const, ref: run.runId, section: 7 as const }],
      );
      return;
    }
    if (event.type === 'run.dismissed') {
      const runId = event.payload.runId;
      void (next.runs[runId]?.test ? this.noteKeptWork(runId, 'dismissed') : this.closeFolder(runId, 'dismissed')).catch(() => undefined);
      return;
    }
    if (event.type === 'pr.synced') {
      const pr = event.payload.pr;
      if (pr.state !== 'merged' && pr.state !== 'closed') return;
      const was = prev.prs[prKey(pr)]?.state;
      if (was !== 'merged' && was !== 'closed') this.closeEndedRuns(next, { ...pr, state: pr.state });
      const run = runFor(pr.ticket);
      if (!run) return;
      if (!this.hasOpenPr(pr.ticket, run.spec.repos.filter((r) => r.role === 'target').map((r) => r.repo))) {
        void run.prFinished({ repo: pr.repo, number: pr.number, state: pr.state });
      }
    } else if (event.type === 'ci.status') {
      const pr = next.prs[prKey({ repo: event.payload.repo, number: event.payload.pr })];
      const run = pr ? runFor(pr.ticket) : undefined;
      if (!run) return;
      void run.refreshCi(); // CI changed for its PR: read its ci checks' commits now
      if (event.payload.status === 'failure') void this.forwardCiFailure(run, event.payload);
    }
  }

  /** A PR just merged or closed closes the ended runs of its ticket in its repository, once none of their PRs is open. */
  private closeEndedRuns(s: WorkspaceState, pr: { repo: string; number: number; ticket: string; state: 'merged' | 'closed' }): void {
    for (const run of Object.values(s.runs)) {
      if (run.ticket !== pr.ticket || !ENDED.has(run.state) || this.runs.has(run.runId)) continue;
      const repos = run.repos ?? [pr.repo];
      if (!repos.some((r) => r.toLowerCase() === pr.repo.toLowerCase()) || this.hasOpenPr(run.ticket, repos)) continue;
      void this.closeFolder(run.runId, { pr: `${pr.repo} #${pr.number}`, state: pr.state }).catch(() => undefined);
    }
  }

  /** Flow 3: the agent gets the failure with the failed steps' log, which it cannot fetch itself. */
  private async forwardCiFailure(run: AgentRun, ci: PayloadOf<'ci.status'>): Promise<void> {
    const head = `CI failed on ${ci.repo} #${ci.pr} at ${ci.sha.slice(0, 7)}`;
    const next = 'Find the cause, fix it, and push again; your plan decides how you prove it.';
    let text: string;
    try {
      const found = this.d.ciLog ? await this.d.ciLog(ci.repo, ci.sha) : undefined;
      text =
        found === undefined
          ? `${head}: ${ci.url}. The orchestrator cannot fetch CI logs here. ${next}`
          : found === null
            ? `${head}: ${ci.url}. No GitHub Actions run failed at that commit, so the failing check comes from elsewhere; there is no log to give you. ${next}`
            : `${head} (${found.workflow}: ${found.url}). The failed steps' log, redacted, last lines:\n\n\`\`\`\n${found.log}\n\`\`\`\n\n${next}`;
    } catch (error) {
      text = `${head}: ${ci.url}. The orchestrator could not fetch the log (${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}). ${next} If you need the log, ask alex with ask_user.`;
    }
    run.forward(text);
  }
}

/** The first sentence of a text, cut at a word near 160 characters: one line in chat. */
function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?=\s|$)/.exec(t)?.index;
  const one = end !== undefined && end < 200 ? t.slice(0, end + 1) : t.length > 160 ? `${t.slice(0, t.lastIndexOf(' ', 160) > 60 ? t.lastIndexOf(' ', 160) : 160)}…` : t;
  return /[.!?…]$/.test(one) ? one : `${one}.`;
}

/** His (or the tester's) messages in a handoff's conversation after the last one it copied. */
function writtenSince(s: WorkspaceState, handoff: HandoffView): MessageView[] {
  const copied = new Set(handoff.context.map((c) => c.messageId));
  const his = s.messages.filter((m) => m.conversationId === handoff.conversationId && (m.role === 'you' || m.role === 'test'));
  let last = -1;
  his.forEach((m, i) => {
    if (copied.has(m.messageId)) last = i;
  });
  return his.slice(last + 1);
}
