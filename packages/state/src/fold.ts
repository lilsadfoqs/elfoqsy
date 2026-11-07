// Both screens are pure functions of the event stream: this fold is the only place state is built.
// fold(state, event) never mutates its input, so replaying the log from seq 0 always lands on the
// same state as having watched it live. Events it does not know (from older logs) are skipped.
import type {
  AbilityFinder,
  AbilityStepStatus,
  AbilityStepView,
  AbilityTool,
  Actor,
  AnyEnvelope,
  AssumptionFlag,
  Attachment,
  BriefSection,
  CheckStatus,
  DelegationCategory,
  DelegationSetting,
  Layout,
  DeliverableKind,
  Effort,
  Finding,
  MessageBlock,
  Mood,
  PayloadOf,
  PlanCheck,
  Progress,
  ProxyName,
  PullRequest,
  QuestionCard,
  RunMode,
  RunState,
  SourceRef,
  Step,
  StepOutcome,
  SubagentOutcome,
  TaskSpec,
  Ticket,
  Tier,
  JiraFieldRole,
  JiraTransition,
  JiraCreateField,
} from '@elfoqsy/contracts';
import { applyDetail, type TicketDetailView } from './jira';

export interface Note {
  at: number;
  text: string;
}

/** One tool call in a transcript: the agent's own, or a sub-agent's. */
export interface ToolLine {
  toolUseId?: string;
  tool: string;
  /** The call in plain words: the command, the file, the pattern. */
  title: string;
  /** The repository folder it ran in, when known. */
  where?: string;
  at: number;
  allowed: boolean;
  finishedAt?: number;
  ok?: boolean;
  /** A short note on the call's own line ("+2 −1"). */
  stats?: string;
  output?: string;
  /** The run ended before the call reported back. */
  unfinished?: boolean;
  /** A call through one of the orchestrator's proxies (or a push): its tier and what was decided. */
  action?: { actionId: string; kind: string; tier: Tier; decision: PayloadOf<'action.classified'>['decision']; environment?: string };
  /** What it changed, recorded before it ran: Undo puts it back, when it can. */
  change?: { recordId: string; target: string; before: string; undo?: string; noUndo?: string; undone?: { by: Actor; at: number } };
  /** Where in the log it was called: thoughts and calls interleave by it. */
  seq?: number;
  /** An Edit's hunks with their line numbers. */
  diff?: { hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> };
  /** As the run reported it, when it did. */
  durationMs?: number;
}

/** The agent's own reasoning, as it wrote it between tool calls. */
export interface Thought {
  at: number;
  seq: number;
  text: string;
}

/** One of Elfoqsy's actions in a conversation, for her thinking indicator. */
export interface ActivityView {
  activityId: string;
  tool: string;
  text: string;
  state: PayloadOf<'elfoqsy.activity'>['state'];
  at: number;
  seq: number;
  finishedAt?: number;
}

/** An agent's request through a proxy, as classified, and how it ended. */
export interface ActionView {
  actionId: string;
  runId: string;
  toolUseId?: string;
  proxy: ProxyName;
  kind: string;
  tier: Tier;
  environment?: string;
  summary: string;
  decision: PayloadOf<'action.classified'>['decision'];
  reason: string;
  grantId?: string;
  approvalId?: string;
  /** Elfoqsy's decision that let it run. */
  decisionId?: string;
  at: number;
  finished?: { ok: boolean; outputSummary: string; durationMs?: number; at: number };
  recordId?: string;
}

/** A change recorded before a write, and whether it was undone. */
export interface ChangeView {
  recordId: string;
  actionId: string;
  runId: string;
  environment?: string;
  target: string;
  before: string;
  /** What Undo does; absent when it cannot be undone here (noUndo says why). */
  undo?: string;
  noUndo?: string;
  at: number;
  undone?: { by: Actor; at: number; actionId: string };
}

/** "Allow for this ticket": the same kind of action on the same ticket and environment runs without asking. */
export interface GrantView {
  grantId: string;
  ticket: string;
  runId: string;
  kind: string;
  environment?: string;
  expiresAt: number;
  by: Actor;
  approvalId: string;
  at: number;
  ended?: { reason: PayloadOf<'grant.ended'>['reason']; at: number };
}

/** A grant still in force at `now`. */
export const isGrantLive = (g: GrantView, now: number): boolean => !g.ended && g.expiresAt > now;

/** A sub-agent record, kept for good: it can be inspected after it ends, whatever the end. */
export interface SubagentView {
  subagentId: string;
  runId: string;
  parentToolUseId?: string;
  model: string;
  effort: Effort;
  task: string;
  /** Order in which the run spawned it. */
  index: number;
  startedAt: number;
  finishedAt?: number;
  outcome?: SubagentOutcome;
  by?: Actor;
  reason?: string;
  result?: string;
  tokens?: number;
  toolCalls: number;
  durationMs?: number;
  tools: ToolLine[];
  /** Its own reasoning, between its tool calls. */
  thoughts?: Thought[];
}

/** A step the agent formed as it went. The current one has no end yet. */
export interface StepView {
  index: number;
  name: Step;
  why: string;
  beganAt: number;
  /** The run.step_begun event, which Elfoqsy acknowledges. */
  seq?: number;
  endedAt?: number;
  outcome?: StepOutcome;
  note?: string;
}

export interface CheckView extends PlanCheck {
  status: CheckStatus;
  evidence?: string;
}

export interface HeartbeatView {
  seq: number;
  at: number;
  step: Step;
  sinceLast: string;
  next: string;
  progress: Progress;
  risks: string[];
  tokens: number;
  workingSeconds: number;
}

export interface FlagView {
  at: number;
  kind: PayloadOf<'run.flag'>['kind'];
  detail: string;
}

export interface RunView {
  runId: string;
  ticket: string;
  agentNumber: number;
  worktree: string;
  branch: string;
  model: string;
  effort: Effort;
  briefId?: string;
  conversationId?: string;
  budget?: { tokens: number; minutes: number };
  /** The repositories it works in (runs since milestone 11). */
  repos?: string[];
  /** Started at the tester's request. */
  test?: boolean;
  /** The ended run whose kept work it starts from. */
  startedFrom?: string;
  /** The agent's goal and done-when checks, from its latest declaration. */
  goal?: string;
  goalRevision: number;
  checks: CheckView[];
  /** Steps formed so far, oldest first. There are no future steps. */
  steps: StepView[];
  /** The name of the step in progress, if one is. */
  step: Step | null;
  state: RunState;
  reason?: string;
  createdAt: number;
  stateAt: number;
  /** Position on /right. The lowest free slot at creation; freed when the run ends. */
  slot: number;
  notes: Note[];
  /** The agent's own tool calls, newest last. Sub-agents keep theirs in their own record. */
  transcript: ToolLine[];
  subagents: SubagentView[];
  spawned: number;
  /** When a sub-agent of this run last finished with a failure. */
  lastFailureAt?: number;
  heartbeats: HeartbeatView[];
  /** Report seqs Elfoqsy has acknowledged. */
  acked: number[];
  flags: FlagView[];
  paused?: { by: Actor; since: number; reason?: string };
  /** The agent's own reasoning between its tool calls (runs since v1.2). */
  thoughts?: Thought[];
  /** Its verdict on the ticket, before it changes code, as last reported. */
  verdict?: VerdictView;
  /** The handoff it works from, and how it works: normal, read-only, hotfix or remediation. */
  handoffId?: string;
  mode?: RunMode;
  /** Each repository's base branch, when not its default (a hotfix's release branch). */
  bases?: Record<string, string>;
  /** The input classes it declared before its first code change. */
  inputs?: string[];
  /** The causes it tested, oldest first, as each last stood. */
  hypotheses?: HypothesisView[];
  /** Different defects it found, each with a proposed split ticket. */
  splitFindings?: SplitFindingView[];
  /** The team-dev snapshot it follows. */
  skill?: { hash: string; files: number };
  /** A failed run that was acknowledged: no longer broken or active, still failed in history. */
  dismissed?: { by: Actor; at: number; reason?: string };
  /** Its run folder is gone, and why it could go. */
  folderRemoved?: { at: number; reason: string };
  /** seq: where in the log it was given, to tell what came after it within the same millisecond. */
  guidance: { at: number; seq: number; text: string; by: Actor }[];
  /** What the workspace reminded it of: a heartbeat owed, or its next step after guidance. */
  reminders: { at: number; about: 'heartbeat' | 'replan'; text: string }[];
  usage?: { tokens: number; workingSeconds: number; at: number };
  budgetExceeded?: PayloadOf<'budget.exceeded'>;
  /** A task agent: work not tied to a ticket; its ticket is task:<id>, and screens show the task's name. */
  task?: TaskSpec;
  /** What it decided itself and recorded, oldest first: "Decisions I made". */
  assumptions?: AssumptionView[];
  /** A task agent's results, oldest first. */
  deliverables?: string[];
  /** What it reported for the ticket narrative, "What we know" (N1), and what the orchestrator saw itself. */
  narrative?: NarrativeRecords;
}

type Said<K extends 'run.understanding' | 'run.reproduction' | 'run.root_cause' | 'run.approach' | 'run.reported' | 'run.criteria_reviewed' | 'run.handed_back' | 'run.pushed' | 'run.test_run'> = Omit<PayloadOf<K>, 'runId'> & { at: number; seq: number };

/**
 * The records the narrative is written from (N1): the latest of each thing the agent said, every push, the test
 * runs the orchestrator saw (the newest 60), and who ticked "I've read the narrative", and when.
 */
export interface NarrativeRecords {
  understanding?: Said<'run.understanding'>;
  reproduction?: Said<'run.reproduction'>;
  rootCause?: Said<'run.root_cause'>;
  approach?: Said<'run.approach'>;
  reported?: Said<'run.reported'>;
  /** The latest fresh-context review's verdict on each acceptance criterion of the ticket. */
  criteriaReview?: Said<'run.criteria_reviewed'>;
  handedBack?: Said<'run.handed_back'>;
  pushes: Array<Said<'run.pushed'>>;
  tests: Array<Said<'run.test_run'>>;
  reads: Array<{ by: Actor; at: number; seq: number }>;
}

const TEST_RUNS_KEPT = 60;
const emptyNarrative = (): NarrativeRecords => ({ pushes: [], tests: [], reads: [] });

export interface AssumptionView {
  assumptionId: string;
  text: string;
  evidence: SourceRef[];
  flag?: AssumptionFlag;
  by: 'agent' | 'review';
  at: number;
}

/** A task agent's result: a document, a table or code. */
export interface DeliverableView {
  deliverableId: string;
  runId: string;
  kind: DeliverableKind;
  title: string;
  content: string;
  language?: string;
  at: number;
}

/** One of Elfoqsy's decisions as first responder, and whether alex changed it since. */
export type DecisionView = PayloadOf<'decision.made'> & { at: number; changed?: { by: Actor; how: 'changed' | 'undone'; to?: string; at: number } };

/** What Elfoqsy decided while he was away, listed for him when he came back. */
export interface DigestView {
  digestId: string;
  conversationId: string;
  decisionIds: string[];
  /** When he went away; for a digest he opened himself, when his last digest was. */
  awaySince: number;
  /** He opened it himself, rather than coming back after being away. */
  asked?: true;
  /** The tester opened it: his own digests still list its decisions. */
  test?: true;
  /** Written in Vietnamese, as the language of his latest message was; absent for English. */
  lang?: 'vi';
  at: number;
}

/** "Let Elfoqsy decide this kind next time", as he stored it. */
export type PrecedentView = PayloadOf<'precedent.saved'> & { at: number };

/** The defaults he set for each category (plan v1.3, item 7); his delegation.set events override them. */
export const DEFAULT_DELEGATION: Record<DelegationCategory, DelegationSetting> = {
  run_folder: 'decide',
  sourced_answer: 'decide',
  ci_rerun: 'decide',
  harness_kube: 'decide_and_tell',
  harness_image: 'decide_and_tell',
  unsourced: 'ask',
  notify_people: 'ask',
  staging_write: 'ask',
  read_secret: 'ask',
  prod_logs: 'ask',
  irreversible: 'ask',
  jira_fill: 'decide_and_tell',
  other: 'ask',
};

/** The categories in the order the settings sheet lists them, with their names in plain words. */
export const DELEGATION_CATEGORIES: Array<{ category: DelegationCategory; label: string }> = [
  { category: 'run_folder', label: 'Path and file asks inside the run folder' },
  { category: 'sourced_answer', label: 'Questions answerable from cited sources' },
  { category: 'ci_rerun', label: 'Rerunning CI' },
  { category: 'harness_kube', label: 'kubectl writes to the dev and integration test harness' },
  { category: 'harness_image', label: 'ECR pushes of the harness image' },
  { category: 'unsourced', label: 'Decisions with no source or precedent' },
  { category: 'notify_people', label: 'Anything that notifies people' },
  { category: 'staging_write', label: 'Staging writes' },
  { category: 'read_secret', label: 'Reading secrets' },
  { category: 'prod_logs', label: 'Prod logs' },
  { category: 'irreversible', label: 'Anything irreversible' },
  { category: 'jira_fill', label: 'Filling empty fields of your Jira tickets' },
  { category: 'other', label: 'Any other request' },
];

/** The agents-at-once limit when no setting says otherwise. */
export const DEFAULT_MAX_AGENTS = 6;

/** What screens show for a run where a ticket key would be: its ticket, or a task agent's name. */
export const runLabel = (run: { ticket: string; task?: TaskSpec }): string => run.task?.name ?? run.ticket;

/** Whether an answer ("Per API key: matches the 429s") is this option: the whole of it, or it and its note. */
export const sameOption = (answer: string, option: string): boolean => {
  const a = answer.toLowerCase();
  const o = option.toLowerCase();
  return a === o || a.startsWith(`${o}: `);
};

export type VerdictView = Omit<PayloadOf<'run.verdict'>, 'runId'> & { at: number; seq?: number };

export interface HypothesisView {
  hypothesisId: string;
  text: string;
  status: PayloadOf<'run.hypothesis'>['status'];
  evidence?: SourceRef[];
  at: number;
}

export type SplitFindingView = Omit<PayloadOf<'run.finding'>, 'runId'> & { at: number };

/** What Elfoqsy handed a ticket agent: his words, his constraints, sourced facts; no diagnosis, no plan. */
export type HandoffView = PayloadOf<'handoff.created'> & { at: number; runIds: string[] };

export interface ApprovalView {
  approvalId: string;
  runId: string;
  kind: PayloadOf<'approval.requested'>['kind'];
  question: string;
  action?: string;
  options?: string[];
  requestedAt: number;
  /** 2 for a request through a proxy. */
  tier?: Tier;
  /** "Allow for this ticket" is offered, for this kind of action in this environment. */
  grantable?: { kind: string; environment?: string };
  /** Asked together with the others of its batch, in one message. */
  batchId?: string;
  /** test: answered while testing the system, not by Alex. scope ticket: allowed for the rest of the ticket. */
  resolution?: { decision: PayloadOf<'approval.resolved'>['decision']; answer?: string; test?: true; scope?: 'once' | 'ticket'; withdrawn?: true; precedent?: true; at: number };
  /** An agent's structured question. */
  card?: QuestionCard;
  /** Its delegation category, Elfoqsy's suggestion or why she has none, and whether a precedent may be stored. */
  category?: DelegationCategory;
  suggestion?: PayloadOf<'approval.requested'>['suggestion'];
  noSuggestion?: string;
  precedentable?: true;
  requestId?: string;
  /** Marking ready for review (N1): it cannot be approved until he has ticked the run's narrative. */
  gate?: 'narrative';
}

export interface MessageView {
  messageId: string;
  /** test: typed while testing the system, never Alex. */
  role: PayloadOf<'elfoqsy.message'>['role'];
  text: string;
  /** Absent only for messages from before conversations existed. */
  conversationId?: string;
  blocks: MessageBlock[];
  attachments: Attachment[];
  refs?: PayloadOf<'elfoqsy.message'>['refs'];
  at: number;
}

export interface ConversationView {
  conversationId: string;
  title: string;
  ticket?: string;
  createdAt: number;
  /** When its last message arrived; the list is ordered by it. */
  lastAt: number;
  messageCount: number;
}

export interface InvestigationView {
  investigationId: string;
  conversationId: string;
  question: string;
  model: string;
  effort: Effort;
  startedAt: number;
  finishedAt?: number;
  title?: string;
  findings: Finding[];
  filesRead?: number;
  tokens?: number;
  durationMs?: number;
}

export interface BriefView {
  briefId: string;
  conversationId: string;
  ticket: string;
  title: string;
  sections: BriefSection[];
  at: number;
  /** Runs started from it, oldest first. */
  runIds: string[];
}

export interface FactView {
  factId: string;
  statement: string;
  sources: SourceRef[];
  freshUntil: number;
  origin: PayloadOf<'memory.saved'>['origin'];
  at: number;
  /** A rule confirmed from guidance, given to later runs in its repos (all repos without them). */
  kind: 'fact' | 'rule';
  repos?: string[];
}

export interface ReviewView {
  weekOf: string;
  /** 1 as recorded, then one more for each correction. */
  revision: number;
  /** What a review block names it by: the weekOf for the first revision, weekOf/r2 and on for corrections. */
  ref: string;
  conversationId: string;
  metrics: Record<string, number>;
  suggestions: string[];
  /** Suggestions a correction withdrew: they rested on a number that changed. */
  withdrawn?: string[];
  at: number;
  /** A later revision replaced it: it stays in history, and nothing counts it any more. */
  supersededAt?: number;
}

export const reviewRef = (weekOf: string, revision: number): string => (revision === 1 ? weekOf : `${weekOf}/r${revision}`);

/** The reviews that count: each week's latest revision. */
export const currentReviews = (s: WorkspaceState): ReviewView[] => s.reviews.filter((r) => r.supersededAt === undefined);

export const reviewByRef = (s: WorkspaceState, ref: string): ReviewView | undefined => s.reviews.find((r) => r.ref === ref);

/** Verified successful uses that take an ability to levels 2 to 5 and, with level 1 held from the start, 1 to 5. */
export const ABILITY_LEVELS = [1, 3, 8, 15, 30] as const;
/** A new ability is level 1 (it was written and verified); the thresholds below take it to 2, 3, 4 and 5 (the brief's 1, 3, 8, 15, 30 uses that worked, with level 1 held from the start). */
export const abilityLevel = (worked: number): number => Math.max(1, ABILITY_LEVELS.filter((n) => worked >= n).length);

export interface AbilityView {
  name: string;
  version: number;
  title: string;
  titleVi: string;
  tool: AbilityTool;
  steps: AbilityStepView[];
  finder: AbilityFinder;
  source: string;
  baselineSteps: number;
  baselineFailed: number;
  baselineQuestions: number;
  learnedAt: number;
  /** Where it came from (ability.origin, from what part A keeps): null for one logged before that existed and not yet backfilled. */
  origin: { foundAt: number; cases: number; from: string } | null;
  /** The last verification of the current version: each step ok, failed or unverified (a step with effects is never run). */
  verification: { steps: Array<{ status: AbilityStepStatus; note?: string }>; at: number } | null;
  uses: number;
  /** Uses that worked; these are the verified successful uses its level counts. */
  worked: number;
  /**
   * Steps saved by the uses that worked, against the skill's baselines: the steps under the median, and the failed calls
   * under the mean, in all and by month (YYYY-MM).
   */
  stepsSaved: number;
  savedByMonth: Record<string, number>;
  /** Questions to alex the uses that worked avoided, against the mean before the skill; shown when above zero. */
  questionsAvoided: number;
  /** Tasks it covers that were done without it. */
  missed: number;
  level: number;
  /** A step started failing: shown as "needs re-check" until a verification of the current version passes. */
  needsRecheck: { step: number; reason: string; at: number } | null;
}

export interface WorkspaceState {
  seq: number;
  tickets: Record<string, Ticket>;
  /** Keyed by `${repo}#${number}`. */
  prs: Record<string, PullRequest>;
  runs: Record<string, RunView>;
  /** Run ids in creation order. */
  runOrder: string[];
  approvals: Record<string, ApprovalView>;
  messages: MessageView[];
  conversations: Record<string, ConversationView>;
  investigations: Record<string, InvestigationView>;
  briefs: Record<string, BriefView>;
  handoffs: Record<string, HandoffView>;
  /** Tickets closed out after merge and QA, by key. */
  closedOut: Record<string, { at: number; qa: string; files: string[]; pageRequested?: boolean }>;
  /** alex's team-dev skill as last seen changed, and what changed. */
  skill: { name: string; hash: string; previous?: string; sections: string[]; at: number } | null;
  /** The abilities (data/skills) by name: what each is, how it was verified, and how its uses went. */
  abilities: Record<string, AbilityView>;
  /** Briefs Elfoqsy has started writing and not finished, by briefId: when she started. */
  briefsInProgress: Record<string, number>;
  /** Her current look, as the daemon picked it when her state last changed; and her last pick per state. */
  look: { mood: Mood; variant: number; at: number } | null;
  lastVariant: Partial<Record<Mood, number>>;
  memory: Record<string, FactView>;
  reviews: ReviewView[];
  /** Latest CI status per `${repo}#${pr}`. */
  ci: Record<string, { status: PayloadOf<'ci.status'>['status']; at: number; sha?: string }>;
  /** CI failures acknowledged until the next CI result on the PR, by `${repo}#${pr}`. */
  ciDismissed: Record<string, { sha: string; by: Actor; at: number; reason?: string }>;
  /** Jira and GitHub reachability, as the daemon last reported it. */
  sources: Partial<Record<PayloadOf<'sync.status'>['source'], { state: PayloadOf<'sync.status'>['state']; since: number }>>;
  /** Claude refused work (usage or rate limit, or login): paused since, and until when it is known. */
  claude: { state: PayloadOf<'usage.limit'>['state']; since: number; until?: number; reason?: string };
  /** Claude usage of Alex's plan, as last reported. */
  usage: { fiveHourPct: number; sevenDayPct: number; resetsAt?: number; sevenDayResetsAt?: number; at: number } | null;
  /** Agents' requests through the proxies, by actionId. */
  actions: Record<string, ActionView>;
  /** Changes recorded before writes, by recordId. */
  changes: Record<string, ChangeView>;
  /** Per-ticket grants, by grantId. */
  grants: Record<string, GrantView>;
  /** alex's AWS session, as the daemon last read it. */
  /** alex's AWS session: the last one reported, and each environment's (from v1.2.1 on). */
  aws: { state: PayloadOf<'aws.session'>['state']; expiresAt?: number; at: number; environments?: Record<string, PayloadOf<'aws.session'>['state']> } | null;
  /** Elfoqsy's latest actions per conversation, for her thinking indicator. */
  activities: Record<string, ActivityView[]>;
  /** What reached Elfoqsy first and is still with her, by requestId. */
  considering: Record<string, { requestId: string; runId: string; requestKind: 'question' | 'action'; summary: string; at: number }>;
  /** Her decisions as first responder, by decisionId. */
  decisions: Record<string, DecisionView>;
  /** What she listed for him when he came back, by digestId. */
  digests: Record<string, DigestView>;
  /** His delegation setting per category, the defaults included. */
  delegation: Record<DelegationCategory, DelegationSetting>;
  /** His precedents, by precedentId; removed ones are gone. */
  precedents: Record<string, PrecedentView>;
  /** Workspace settings he changed. */
  settings: { maxAgents?: number; studyPauseFiveHour?: number; studyPauseSevenDay?: number; studyBatchTokens?: number };
  /** Task agents' results, by deliverableId. */
  deliverables: Record<string, DeliverableView>;
  /** Tickets read in full from Jira, by key: the sprint's and any other opened by key. */
  ticketDetails: Record<string, TicketDetailView>;
  /** Tickets Jira would not give, by key, with why. */
  unreadable: Record<string, { reason: string; at: number }>;
  /** The layout's fields on this site, as checked at start-up. */
  jiraFields: Partial<Record<JiraFieldRole, { name: string; id: string }>>;
  /** His pickers' options by project. */
  jiraOptions: Record<string, PayloadOf<'jira.options'>>;
  /** The transitions Jira offered on a ticket when its status menu last opened. */
  transitions: Record<string, JiraTransition[]>;
  /** The latest ticket search. */
  ticketSearch: PayloadOf<'ticket.search'> | null;
  /** How the two screens are arranged (P2); null is no layout saved: today's arrangement. */
  layout: Layout | null;
  /** How each of his edits ended, by the screen's editId: saved, refused with why, or theirs came back. */
  jiraEdits: Record<string, { key: string; ok?: boolean; error?: string; conflict?: { theirs: unknown; by?: string; at?: string }; at: number }>;
  /** The latest edit of each field by key, from the workspace: who, when, and the recorded change for Undo. */
  fieldEdits: Record<string, Record<string, { by: Actor; at: number; recordId?: string }>>;
  /** Tickets drafted by Elfoqsy or an agent, waiting for him, and how each was closed. */
  drafts: Record<string, PayloadOf<'ticket.drafted'> & { at: number; closed?: { how: 'created' | 'discarded'; key?: string; by: Actor; at: number } }>;
  /** Jira's create screen by project: its types, and the fields of the types read so far. */
  createMeta: Record<string, { types: Array<{ id: string; name: string; subtask: boolean }>; fields: Record<string, JiraCreateField[]> }>;
  /** How each of his creates ended, by the screen's createId. */
  created: Record<string, { key?: string; error?: string; checks?: { links?: boolean; sprint?: boolean; parent?: boolean }; at: number }>;
  /** What happened in Jira while he was away, by newsId. */
  jiraNews: Record<string, PayloadOf<'jira.news'> & { at: number }>;
}

export const initialState: WorkspaceState = {
  seq: 0,
  tickets: {},
  prs: {},
  runs: {},
  runOrder: [],
  approvals: {},
  messages: [],
  conversations: {},
  investigations: {},
  briefs: {},
  handoffs: {},
  closedOut: {},
  skill: null,
  abilities: {},
  briefsInProgress: {},
  look: null,
  lastVariant: {},
  memory: {},
  reviews: [],
  ci: {},
  ciDismissed: {},
  sources: {},
  claude: { state: 'ok', since: 0 },
  usage: null,
  actions: {},
  changes: {},
  grants: {},
  aws: null,
  activities: {},
  considering: {},
  decisions: {},
  digests: {},
  delegation: { ...DEFAULT_DELEGATION },
  precedents: {},
  settings: {},
  deliverables: {},
  ticketDetails: {},
  unreadable: {},
  jiraFields: {},
  jiraOptions: {},
  transitions: {},
  ticketSearch: null,
  layout: null,
  jiraEdits: {},
  fieldEdits: {},
  drafts: {},
  createMeta: {},
  created: {},
  jiraNews: {},
};
/** Thoughts kept per agent and per sub-agent, and actions per conversation; the log keeps them all. */
const THOUGHTS_KEPT = 200;
const ACTIVITIES_KEPT = 40;

/** The ticket agent, unless a run says otherwise (runs from before v1 do not). */
export const TICKET_AGENT_MODEL = 'claude-opus-5-5';
export const TICKET_AGENT_EFFORT: Effort = 'xhigh';
/** Transcript lines kept per agent and per sub-agent; the event log keeps them all. */
export const TRANSCRIPT_KEPT = 300;
const MAX_NOTES = 50;
const HEARTBEATS_KEPT = 24;
const ACKS_KEPT = 200;

export const prKey = (pr: { repo: string; number: number }): string => `${pr.repo}#${pr.number}`;
/** Still the workspace's concern: not ended, and not a failure that has been dismissed. */
export const isRunActive = (run: RunView): boolean => run.state !== 'succeeded' && run.state !== 'stopped' && run.state !== 'cancelled' && !run.dismissed;

export function fold(state: WorkspaceState, event: AnyEnvelope): WorkspaceState {
  if (event.seq <= state.seq) return state; // already applied
  const at = Date.parse(event.ts);
  const next = applyEvent(state, event, at);
  return next === state ? { ...state, seq: event.seq } : { ...next, seq: event.seq };
}

export function foldAll(events: readonly AnyEnvelope[], state: WorkspaceState = initialState): WorkspaceState {
  return events.reduce(fold, state);
}

function applyEvent(state: WorkspaceState, event: AnyEnvelope, at: number): WorkspaceState {
  switch (event.type) {
    case 'ticket.synced': {
      const { ticket } = event.payload;
      return { ...state, tickets: { ...state.tickets, [ticket.key]: ticket } };
    }
    case 'ticket.removed': {
      const { [event.payload.key]: _removed, ...tickets } = state.tickets;
      return { ...state, tickets };
    }
    case 'ticket.detail': {
      const p = event.payload;
      const { [p.key]: _readable, ...unreadable } = state.unreadable;
      return { ...state, ticketDetails: { ...state.ticketDetails, [p.key]: applyDetail(state.ticketDetails[p.key], p, at) }, unreadable };
    }
    case 'ticket.unreadable':
      return { ...state, unreadable: { ...state.unreadable, [event.payload.key]: { reason: event.payload.reason, at } } };
    case 'jira.fields':
      return { ...state, jiraFields: event.payload.fields };
    case 'jira.options':
      return { ...state, jiraOptions: { ...state.jiraOptions, [event.payload.project]: event.payload } };
    case 'ticket.transitions':
      return { ...state, transitions: { ...state.transitions, [event.payload.key]: event.payload.transitions } };
    case 'ticket.search':
      return { ...state, ticketSearch: event.payload };
    case 'jira.edited': {
      const p = event.payload;
      const jiraEdits = p.editId ? { ...state.jiraEdits, [p.editId]: { key: p.key, ok: p.ok, ...(p.error ? { error: p.error } : {}), at } } : state.jiraEdits;
      const fieldEdits =
        p.ok && p.fieldId
          ? { ...state.fieldEdits, [p.key]: { ...(state.fieldEdits[p.key] ?? {}), [p.fieldId]: { by: p.by, at, ...(p.recordId ? { recordId: p.recordId } : {}) } } }
          : state.fieldEdits;
      return { ...state, jiraEdits, fieldEdits };
    }
    case 'ticket.drafted':
      return { ...state, drafts: { ...state.drafts, [event.payload.draftId]: { ...event.payload, at } } };
    case 'ticket.draft_closed': {
      const p = event.payload;
      const d = state.drafts[p.draftId];
      return d ? { ...state, drafts: { ...state.drafts, [p.draftId]: { ...d, closed: { how: p.how, ...(p.key ? { key: p.key } : {}), by: p.by, at } } } } : state;
    }
    case 'ticket.createmeta': {
      const p = event.payload;
      const prev = state.createMeta[p.project];
      const fields = p.typeId && p.fields ? { ...(prev?.fields ?? {}), [p.typeId]: p.fields } : (prev?.fields ?? {});
      return { ...state, createMeta: { ...state.createMeta, [p.project]: { types: p.types, fields } } };
    }
    case 'ticket.created': {
      const p = event.payload;
      return { ...state, created: { ...state.created, [p.createId]: { key: p.key, checks: p.checks, at } } };
    }
    case 'ticket.create_failed':
      return { ...state, created: { ...state.created, [event.payload.createId]: { error: event.payload.error, at } } };
    case 'jira.news':
      return { ...state, jiraNews: { ...state.jiraNews, [event.payload.newsId]: { ...event.payload, at } } };
    case 'jira.edit_conflict': {
      const p = event.payload;
      return { ...state, jiraEdits: { ...state.jiraEdits, [p.editId]: { key: p.key, conflict: { theirs: p.theirs, ...(p.by ? { by: p.by } : {}), ...(p.at ? { at: p.at } : {}) }, at } } };
    }
    case 'pr.synced': {
      const { pr } = event.payload;
      return { ...state, prs: { ...state.prs, [prKey(pr)]: pr } };
    }
    case 'run.created': {
      const p = event.payload;
      if (state.runs[p.runId]) return state;
      const taken = new Set(Object.values(state.runs).filter(isRunActive).map((r) => r.slot));
      let slot = 0;
      while (taken.has(slot)) slot++;
      const run: RunView = {
        runId: p.runId,
        ticket: p.ticket,
        agentNumber: p.agentNumber,
        worktree: p.worktree,
        branch: p.branch,
        model: p.model ?? TICKET_AGENT_MODEL,
        effort: p.effort ?? TICKET_AGENT_EFFORT,
        ...(p.briefId ? { briefId: p.briefId } : {}),
        ...(p.handoffId ? { handoffId: p.handoffId } : {}),
        ...(p.mode ? { mode: p.mode } : {}),
        ...(p.bases && Object.keys(p.bases).length ? { bases: p.bases } : {}),
        ...(p.conversationId ? { conversationId: p.conversationId } : {}),
        ...(p.budget ? { budget: p.budget } : {}),
        ...(p.repos?.length ? { repos: p.repos } : {}),
        ...(p.test ? { test: true } : {}),
        ...(p.startedFrom ? { startedFrom: p.startedFrom } : {}),
        ...(p.task ? { task: p.task } : {}),
        goalRevision: 0,
        checks: [],
        steps: [],
        step: null,
        state: 'queued',
        createdAt: at,
        stateAt: at,
        slot,
        notes: [],
        transcript: [],
        subagents: [],
        spawned: 0,
        heartbeats: [],
        acked: [],
        flags: [],
        guidance: [],
        reminders: [],
      };
      const briefs = p.briefId && state.briefs[p.briefId] ? linkBrief(state.briefs, p.briefId, p.runId) : state.briefs;
      const handoffs = p.handoffId && state.handoffs[p.handoffId] ? linkHandoff(state.handoffs, p.handoffId, p.runId) : state.handoffs;
      return { ...state, runs: { ...state.runs, [p.runId]: run }, runOrder: [...state.runOrder, p.runId], briefs, handoffs };
    }
    case 'run.goal_declared': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({
        ...run,
        goal: p.goal,
        goalRevision: p.revision,
        // A check that is unchanged keeps its evidence; a new or changed one starts pending.
        checks: p.checks.map((c) => {
          const before = run.checks.find((o) => o.id === c.id && o.proof === c.proof && o.command === c.command && o.repo === c.repo && o.scope === c.scope);
          return before ? { ...c, status: before.status, ...(before.evidence ? { evidence: before.evidence } : {}) } : { ...c, status: 'pending' as const };
        }),
      }));
    }
    case 'run.step_begun': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => {
        // A step that is still open ends here, if the agent did not end it itself.
        const steps = run.steps.map((s) => (s.endedAt === undefined ? { ...s, endedAt: at, outcome: 'done' as const } : s));
        return { ...run, steps: [...steps, { index: p.stepIndex, name: p.name, why: p.why, beganAt: at, seq: event.seq }], step: p.name };
      });
    }
    case 'run.step_ended': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => {
        const steps = run.steps.map((s) =>
          s.index === p.stepIndex && s.endedAt === undefined ? { ...s, endedAt: at, outcome: p.outcome, ...(p.note ? { note: p.note } : {}) } : s,
        );
        const current = steps.find((s) => s.endedAt === undefined);
        return { ...run, steps, step: current ? current.name : null };
      });
    }
    case 'run.check_changed': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({
        ...run,
        checks: run.checks.map((c) => (c.id === p.checkId ? { ...c, status: p.status, evidence: p.evidence } : c)),
      }));
    }
    case 'run.heartbeat': {
      const p = event.payload;
      const beat: HeartbeatView = {
        seq: event.seq,
        at,
        step: p.step,
        sinceLast: p.sinceLast,
        next: p.next,
        progress: p.progress,
        risks: p.risks,
        tokens: p.tokens,
        workingSeconds: p.workingSeconds,
      };
      return updateRun(state, p.runId, (run) => ({ ...run, heartbeats: [...run.heartbeats, beat].slice(-HEARTBEATS_KEPT) }));
    }
    case 'run.ack':
      return updateRun(state, event.payload.runId, (run) => ({ ...run, acked: [...run.acked, event.payload.refEventSeq].slice(-ACKS_KEPT) }));
    case 'run.flag': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, flags: [...run.flags, { at, kind: p.kind, detail: p.detail }] }));
    }
    case 'run.dismissed': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) =>
        run.state === 'failed' && !run.dismissed ? { ...run, dismissed: { by: p.by, at, ...(p.reason ? { reason: p.reason } : {}) } } : run,
      );
    }
    case 'run.folder_removed': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, folderRemoved: { at, reason: p.reason } }));
    }
    case 'run.paused': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, paused: { by: p.by, since: at, ...(p.reason ? { reason: p.reason } : {}) } }));
    }
    case 'run.resumed':
      return updateRun(state, event.payload.runId, (run) => {
        const { paused: _was, ...rest } = run;
        return rest;
      });
    case 'run.guidance': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, guidance: [...run.guidance, { at, seq: event.seq, text: p.text, by: p.by }] }));
    }
    case 'run.reminded': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, reminders: [...(run.reminders ?? []), { at, about: p.about, text: p.text }] }));
    }
    case 'run.usage': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, usage: { tokens: p.tokens, workingSeconds: p.workingSeconds, at } }));
    }
    case 'run.state_changed': {
      const { state: runState, reason } = event.payload;
      const before = state.runs[event.payload.runId];
      // A run that stopped asks nothing more: what Elfoqsy was still looking into for it goes too.
      const stoppedNow = !!before && (runState === 'failed' || !isRunActive({ ...before, state: runState }));
      const considering = stoppedNow ? Object.fromEntries(Object.entries(state.considering).filter(([, c]) => c.runId !== event.payload.runId)) : state.considering;
      return updateRun({ ...state, considering }, event.payload.runId, (run) => {
        const { reason: _old, ...rest } = run;
        const ended = !isRunActive({ ...run, state: runState });
        // When a run ends, its open step ends with it.
        const steps = ended
          ? run.steps.map((s) => (s.endedAt === undefined ? { ...s, endedAt: at, outcome: runState === 'succeeded' ? ('done' as const) : ('abandoned' as const) } : s))
          : run.steps;
        // Calls that never reported back end with the agent; a failed run stays active until dismissed, but
        // its agent has stopped all the same.
        const stopped = ended || runState === 'failed';
        const transcript = stopped ? run.transcript.map((l) => (l.finishedAt === undefined ? { ...l, finishedAt: at, ok: false, unfinished: true } : l)) : run.transcript;
        return { ...rest, steps, transcript, step: ended ? null : run.step, state: runState, stateAt: at, ...(reason ? { reason } : {}) };
      });
    }
    case 'run.thought': {
      const p = event.payload;
      const thought: Thought = { at, seq: event.seq, text: p.text };
      if (p.subagentId) return updateSubagent(state, p.runId, p.subagentId, (s) => ({ ...s, thoughts: [...(s.thoughts ?? []), thought].slice(-THOUGHTS_KEPT) }));
      return updateRun(state, p.runId, (run) => ({ ...run, thoughts: [...(run.thoughts ?? []), thought].slice(-THOUGHTS_KEPT) }));
    }
    case 'run.verdict': {
      const { runId, ...verdict } = event.payload;
      return updateRun(state, runId, (run) => ({ ...run, verdict: { ...verdict, at, seq: event.seq } }));
    }
    case 'run.inputs_declared': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, inputs: p.classes }));
    }
    case 'run.hypothesis': {
      const { runId, ...h } = event.payload;
      return updateRun(state, runId, (run) => {
        const list = run.hypotheses ?? [];
        const view: HypothesisView = { ...h, at };
        const i = list.findIndex((x) => x.hypothesisId === h.hypothesisId);
        return { ...run, hypotheses: i < 0 ? [...list, view] : list.map((x, j) => (j === i ? view : x)) };
      });
    }
    case 'run.finding': {
      const { runId, ...f } = event.payload;
      return updateRun(state, runId, (run) => ({ ...run, splitFindings: [...(run.splitFindings ?? []), { ...f, at }] }));
    }
    case 'run.understanding':
    case 'run.reproduction':
    case 'run.root_cause':
    case 'run.approach':
    case 'run.reported':
    case 'run.criteria_reviewed':
    case 'run.handed_back': {
      const { runId, ...rest } = event.payload as { runId: string } & Record<string, unknown>;
      const key = { 'run.understanding': 'understanding', 'run.reproduction': 'reproduction', 'run.root_cause': 'rootCause', 'run.approach': 'approach', 'run.reported': 'reported', 'run.criteria_reviewed': 'criteriaReview', 'run.handed_back': 'handedBack' }[event.type];
      return updateRun(state, runId, (run) => ({ ...run, narrative: { ...(run.narrative ?? emptyNarrative()), [key]: { ...rest, at, seq: event.seq } } }));
    }
    case 'run.pushed': {
      const { runId, ...rest } = event.payload;
      return updateRun(state, runId, (run) => {
        const n = run.narrative ?? emptyNarrative();
        return { ...run, narrative: { ...n, pushes: [...n.pushes, { ...rest, at, seq: event.seq }] } };
      });
    }
    case 'run.test_run': {
      const { runId, ...rest } = event.payload;
      return updateRun(state, runId, (run) => {
        const n = run.narrative ?? emptyNarrative();
        return { ...run, narrative: { ...n, tests: [...n.tests, { ...rest, at, seq: event.seq }].slice(-TEST_RUNS_KEPT) } };
      });
    }
    case 'layout.changed':
      return { ...state, layout: event.payload.layout };
    case 'narrative.read': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => {
        const n = run.narrative ?? emptyNarrative();
        return { ...run, narrative: { ...n, reads: [...n.reads, { by: p.by, at, seq: event.seq }] } };
      });
    }
    case 'run.skill_snapshot': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({ ...run, skill: { hash: p.hash, files: p.files } }));
    }
    case 'elfoqsy.activity': {
      const p = event.payload;
      const list = state.activities[p.conversationId] ?? [];
      const found = list.find((a) => a.activityId === p.activityId);
      const next = found
        ? list.map((a) => (a.activityId === p.activityId ? { ...a, state: p.state, ...(p.state !== 'running' ? { finishedAt: at } : {}) } : a))
        : [...list, { activityId: p.activityId, tool: p.tool, text: p.text, state: p.state, at, seq: event.seq, ...(p.state !== 'running' ? { finishedAt: at } : {}) }].slice(-ACTIVITIES_KEPT);
      return { ...state, activities: { ...state.activities, [p.conversationId]: next } };
    }
    case 'run.note':
      return updateRun(state, event.payload.runId, (run) => ({
        ...run,
        notes: [...run.notes, { at, text: event.payload.text }].slice(-MAX_NOTES),
      }));
    case 'tool.called': {
      const p = event.payload;
      if (!p.runId) return state; // Elfoqsy's own calls
      if (p.subagentId) {
        // A sub-agent's call, running until its subagent.tool_called says how it ended.
        if (!p.allowed || !p.toolUseId) return state;
        const running: ToolLine = { toolUseId: p.toolUseId, tool: p.tool, title: p.title ?? p.inputSummary, at, seq: event.seq, allowed: true };
        return updateSubagent(state, p.runId, p.subagentId, (s) => ({ ...s, tools: [...s.tools, running].slice(-TRANSCRIPT_KEPT) }));
      }
      const line: ToolLine = {
        ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
        tool: p.tool,
        title: p.title ?? p.inputSummary,
        ...(p.where ? { where: p.where } : {}),
        at,
        seq: event.seq,
        allowed: p.allowed,
        // A call the gate denied never ran.
        ...(p.allowed ? {} : { finishedAt: at, ok: false }),
      };
      return updateRun(state, p.runId, (run) => ({ ...run, transcript: [...run.transcript, line].slice(-TRANSCRIPT_KEPT) }));
    }
    case 'tool.finished': {
      const p = event.payload;
      return updateRun(state, p.runId, (run) => ({
        ...run,
        transcript: run.transcript.map((l) =>
          l.toolUseId === p.toolUseId
            ? { ...l, finishedAt: at, ok: p.ok, output: p.outputSummary, ...(p.stats ? { stats: p.stats } : {}), ...(p.diff ? { diff: p.diff } : {}), ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}) }
            : l,
        ),
      }));
    }
    case 'subagent.started': {
      const p = withLegacyStart(event.payload);
      return updateRun(state, p.runId, (run) => ({
        ...run,
        spawned: run.spawned + 1,
        subagents: [
          ...run.subagents,
          {
            subagentId: p.subagentId,
            runId: p.runId,
            ...(p.parentToolUseId ? { parentToolUseId: p.parentToolUseId } : {}),
            model: p.model,
            effort: p.effort,
            task: p.task,
            index: run.spawned,
            startedAt: at,
            toolCalls: 0,
            tools: [],
          },
        ],
      }));
    }
    case 'subagent.tool_called': {
      const p = event.payload;
      const line: ToolLine = {
        ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
        tool: p.tool,
        title: p.inputSummary,
        at,
        seq: event.seq,
        allowed: true,
        finishedAt: at,
        ok: p.ok,
        output: p.outputSummary,
        ...(p.stats ? { stats: p.stats } : {}),
      };
      return updateSubagent(state, p.runId, p.subagentId, (s) => {
        const started = p.toolUseId ? s.tools.find((l) => l.toolUseId === p.toolUseId && l.finishedAt === undefined) : undefined;
        const tools = started ? s.tools.map((l) => (l === started ? { ...line, at: started.at, seq: started.seq ?? line.seq } : l)) : [...s.tools, line].slice(-TRANSCRIPT_KEPT);
        return { ...s, toolCalls: s.toolCalls + 1, tools };
      });
    }
    case 'subagent.finished': {
      const p = withLegacyFinish(event.payload);
      const next = updateSubagent(state, p.runId, p.subagentId, (s) => ({
        ...s,
        finishedAt: at,
        outcome: p.outcome,
        ...(p.by ? { by: p.by } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        result: p.result,
        tokens: p.tokens,
        toolCalls: Math.max(s.toolCalls, p.toolCalls),
        durationMs: p.durationMs,
        // A call that never reported back ended with its sub-agent.
        tools: s.tools.map((l) => (l.finishedAt === undefined ? { ...l, finishedAt: at, ok: false, unfinished: true } : l)),
      }));
      return p.outcome === 'failed' ? updateRun(next, p.runId, (run) => ({ ...run, lastFailureAt: at })) : next;
    }
    case 'approval.requested': {
      const p = event.payload;
      const approval: ApprovalView = {
        approvalId: p.approvalId,
        runId: p.runId,
        kind: p.kind,
        question: p.question,
        requestedAt: at,
        ...(p.action ? { action: p.action } : {}),
        ...(p.options ? { options: p.options } : {}),
        ...(p.tier !== undefined ? { tier: p.tier } : {}),
        ...(p.grantable ? { grantable: p.grantable } : {}),
        ...(p.batchId ? { batchId: p.batchId } : {}),
        ...(p.card ? { card: p.card } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(p.suggestion ? { suggestion: p.suggestion } : {}),
        ...(p.noSuggestion ? { noSuggestion: p.noSuggestion } : {}),
        ...(p.precedentable ? { precedentable: p.precedentable } : {}),
        ...(p.requestId ? { requestId: p.requestId } : {}),
        ...(p.gate ? { gate: p.gate } : {}),
      };
      // Escalated: it is his now, no longer with her.
      const { [p.requestId ?? '']: _escalated, ...considering } = state.considering;
      return { ...state, approvals: { ...state.approvals, [p.approvalId]: approval }, considering };
    }
    case 'approval.resolved': {
      const p = event.payload;
      const approval = state.approvals[p.approvalId];
      if (!approval || approval.resolution) return state;
      const resolution = {
        decision: p.decision,
        at,
        ...(p.answer ? { answer: p.answer } : {}),
        ...(p.test ? { test: p.test } : {}),
        ...(p.scope ? { scope: p.scope } : {}),
        ...(p.withdrawn ? { withdrawn: p.withdrawn } : {}),
        ...(p.precedent ? { precedent: p.precedent } : {}),
      };
      return { ...state, approvals: { ...state.approvals, [p.approvalId]: { ...approval, resolution } } };
    }
    case 'action.classified': {
      const p = event.payload;
      const action: ActionView = {
        actionId: p.actionId,
        runId: p.runId,
        ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
        proxy: p.proxy,
        kind: p.kind,
        tier: p.tier,
        ...(p.environment ? { environment: p.environment } : {}),
        summary: p.summary,
        decision: p.decision,
        reason: p.reason,
        ...(p.grantId ? { grantId: p.grantId } : {}),
        ...(p.approvalId ? { approvalId: p.approvalId } : {}),
        ...(p.decisionId ? { decisionId: p.decisionId } : {}),
        at,
      };
      const next = { ...state, actions: { ...state.actions, [p.actionId]: action } };
      if (!p.toolUseId) return next;
      const mark = { actionId: p.actionId, kind: p.kind, tier: p.tier, decision: p.decision, ...(p.environment ? { environment: p.environment } : {}) };
      return updateRun(next, p.runId, (run) => ({ ...run, transcript: run.transcript.map((l) => (l.toolUseId === p.toolUseId ? { ...l, action: mark } : l)) }));
    }
    case 'action.finished': {
      const p = event.payload;
      const action = state.actions[p.actionId];
      if (!action) return state;
      return { ...state, actions: { ...state.actions, [p.actionId]: { ...action, finished: { ok: p.ok, outputSummary: p.outputSummary, at, ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}) } } } };
    }
    case 'change.recorded': {
      const p = event.payload;
      const change: ChangeView = {
        recordId: p.recordId,
        actionId: p.actionId,
        runId: p.runId,
        ...(p.environment ? { environment: p.environment } : {}),
        target: p.target,
        before: p.before,
        ...(p.undo ? { undo: p.undo.summary } : {}),
        ...(p.noUndo ? { noUndo: p.noUndo } : {}),
        at,
      };
      const action = state.actions[p.actionId];
      const next = {
        ...state,
        changes: { ...state.changes, [p.recordId]: change },
        ...(action ? { actions: { ...state.actions, [p.actionId]: { ...action, recordId: p.recordId } } } : {}),
      };
      const line = { recordId: p.recordId, target: p.target, before: p.before, ...(p.undo ? { undo: p.undo.summary } : {}), ...(p.noUndo ? { noUndo: p.noUndo } : {}) };
      return updateRun(next, p.runId, (run) => ({ ...run, transcript: run.transcript.map((l) => (l.action?.actionId === p.actionId ? { ...l, change: line } : l)) }));
    }
    case 'change.undone': {
      const p = event.payload;
      const change = state.changes[p.recordId];
      if (!change || change.undone) return state;
      const undone = { by: p.by, at, actionId: p.actionId };
      const next = { ...state, changes: { ...state.changes, [p.recordId]: { ...change, undone } } };
      return updateRun(next, change.runId, (run) => ({
        ...run,
        transcript: run.transcript.map((l) => (l.change?.recordId === p.recordId ? { ...l, change: { ...l.change, undone: { by: p.by, at } } } : l)),
      }));
    }
    case 'grant.created': {
      const p = event.payload;
      const grant: GrantView = {
        grantId: p.grantId,
        ticket: p.ticket,
        runId: p.runId,
        kind: p.kind,
        ...(p.environment ? { environment: p.environment } : {}),
        expiresAt: Date.parse(p.expiresAt),
        by: p.by,
        approvalId: p.approvalId,
        at,
      };
      return { ...state, grants: { ...state.grants, [p.grantId]: grant } };
    }
    case 'grant.ended': {
      const p = event.payload;
      const grant = state.grants[p.grantId];
      if (!grant || grant.ended) return state;
      return { ...state, grants: { ...state.grants, [p.grantId]: { ...grant, ended: { reason: p.reason, at } } } };
    }
    case 'aws.session': {
      const p = event.payload;
      if (!p.environment) return { ...state, aws: { state: p.state, at, ...(p.expiresAt ? { expiresAt: Date.parse(p.expiresAt) } : {}) } };
      // Per environment: the session as a whole is expired while any environment's is.
      const environments = { ...state.aws?.environments, [p.environment]: p.state };
      const overall = Object.values(environments).includes('expired') ? 'expired' : p.state;
      return { ...state, aws: { state: overall, at, environments } };
    }
    case 'elfoqsy.message': {
      const p = event.payload;
      const message: MessageView = {
        messageId: p.messageId,
        role: p.role,
        text: p.text,
        ...(p.conversationId ? { conversationId: p.conversationId } : {}),
        blocks: p.blocks ?? [],
        attachments: p.attachments ?? [],
        at,
        ...(p.refs ? { refs: p.refs } : {}),
      };
      const conversation = p.conversationId ? state.conversations[p.conversationId] : undefined;
      const conversations = conversation
        ? { ...state.conversations, [conversation.conversationId]: { ...conversation, lastAt: at, messageCount: conversation.messageCount + 1 } }
        : state.conversations;
      return { ...state, messages: [...state.messages, message], conversations };
    }
    case 'elfoqsy.message_marked': {
      const p = event.payload;
      if (!state.messages.some((m) => m.messageId === p.messageId)) return state;
      return { ...state, messages: state.messages.map((m) => (m.messageId === p.messageId ? { ...m, role: p.role } : m)) };
    }
    case 'conversation.created': {
      const p = event.payload;
      if (state.conversations[p.conversationId]) return state;
      const conversation: ConversationView = { conversationId: p.conversationId, title: p.title, ...(p.ticket ? { ticket: p.ticket } : {}), createdAt: at, lastAt: at, messageCount: 0 };
      return { ...state, conversations: { ...state.conversations, [p.conversationId]: conversation } };
    }
    case 'conversation.renamed': {
      const p = event.payload;
      const conversation = state.conversations[p.conversationId];
      if (!conversation) return state;
      return { ...state, conversations: { ...state.conversations, [p.conversationId]: { ...conversation, title: p.title, ...(p.ticket ? { ticket: p.ticket } : {}) } } };
    }
    case 'investigation.started': {
      const p = event.payload;
      const investigation: InvestigationView = {
        investigationId: p.investigationId,
        conversationId: p.conversationId,
        question: p.question,
        model: p.model,
        effort: p.effort,
        startedAt: at,
        findings: [],
      };
      return { ...state, investigations: { ...state.investigations, [p.investigationId]: investigation } };
    }
    case 'investigation.finished': {
      const p = event.payload;
      const before = state.investigations[p.investigationId];
      if (!before) return state;
      const investigation: InvestigationView = {
        ...before,
        finishedAt: at,
        title: p.title,
        findings: p.findings,
        durationMs: p.durationMs,
        ...(p.filesRead !== undefined ? { filesRead: p.filesRead } : {}),
        ...(p.tokens !== undefined ? { tokens: p.tokens } : {}),
      };
      return { ...state, investigations: { ...state.investigations, [p.investigationId]: investigation } };
    }
    case 'memory.saved': {
      const p = event.payload;
      const fact: FactView = {
        factId: p.factId,
        statement: p.statement,
        sources: p.sources,
        freshUntil: Date.parse(p.freshUntil),
        origin: p.origin,
        at,
        kind: p.kind ?? 'fact',
        ...(p.repos?.length ? { repos: p.repos } : {}),
      };
      return { ...state, memory: { ...state.memory, [p.factId]: fact } };
    }
    case 'memory.forgotten': {
      const { [event.payload.factId]: _gone, ...memory } = state.memory;
      return { ...state, memory };
    }
    case 'ci.dismissed': {
      const p = event.payload;
      const key = prKey({ repo: p.repo, number: p.pr });
      return { ...state, ciDismissed: { ...state.ciDismissed, [key]: { sha: p.sha, by: p.by, at, ...(p.reason ? { reason: p.reason } : {}) } } };
    }
    case 'elfoqsy.look': {
      const { mood, variant } = event.payload;
      return { ...state, look: { mood, variant, at }, lastVariant: { ...state.lastVariant, [mood]: variant } };
    }
    case 'brief.started':
      return { ...state, briefsInProgress: { ...state.briefsInProgress, [event.payload.briefId]: at } };
    case 'brief.created': {
      const p = event.payload;
      // An agent may already have been started from it (events arrive in order, so this is rare).
      const runIds = state.runOrder.filter((id) => state.runs[id]?.briefId === p.briefId);
      const brief: BriefView = { briefId: p.briefId, conversationId: p.conversationId, ticket: p.ticket, title: p.title, sections: p.sections, at, runIds };
      const { [p.briefId]: _done, ...briefsInProgress } = state.briefsInProgress;
      return { ...state, briefs: { ...state.briefs, [p.briefId]: brief }, briefsInProgress };
    }
    case 'handoff.created': {
      const p = event.payload;
      const runIds = state.handoffs[p.handoffId]?.runIds ?? [];
      return { ...state, handoffs: { ...state.handoffs, [p.handoffId]: { ...p, at, runIds } } };
    }
    case 'handoff.handed_off': {
      const p = event.payload;
      if (!state.handoffs[p.handoffId]) return state;
      const handoffs = linkHandoff(state.handoffs, p.handoffId, p.runId);
      return updateRun({ ...state, handoffs }, p.runId, (run) => ({ ...run, handoffId: p.handoffId }));
    }
    case 'ticket.closed_out': {
      const p = event.payload;
      return { ...state, closedOut: { ...state.closedOut, [p.ticket]: { at, qa: p.qa, files: p.files, ...(p.pageRequested ? { pageRequested: true } : {}) } } };
    }
    case 'ability.learned': {
      const p = event.payload;
      const was = state.abilities[p.name];
      const view: AbilityView = {
        name: p.name,
        version: p.version,
        title: p.title,
        titleVi: p.titleVi,
        tool: p.tool,
        steps: p.steps,
        finder: was?.finder ?? p.finder,
        source: was?.source ?? p.source,
        baselineSteps: p.baselineSteps,
        baselineFailed: p.baselineFailed,
        baselineQuestions: p.baselineQuestions,
        learnedAt: was?.learnedAt ?? at,
        origin: was?.origin ?? null,
        verification: null,
        uses: was?.uses ?? 0,
        worked: was?.worked ?? 0,
        stepsSaved: was?.stepsSaved ?? 0,
        savedByMonth: was?.savedByMonth ?? {},
        questionsAvoided: was?.questionsAvoided ?? 0,
        missed: was?.missed ?? 0,
        level: was?.level ?? 1, // written and verified: level 1 from the start
        needsRecheck: was?.needsRecheck ?? null,
      };
      return { ...state, abilities: { ...state.abilities, [p.name]: view } };
    }
    case 'ability.repaired': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was) return state;
      return { ...state, abilities: { ...state.abilities, [p.name]: { ...was, version: p.version, steps: p.steps, verification: null } } };
    }
    case 'ability.origin': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was) return state;
      const foundAt = Date.parse(p.foundAt);
      return { ...state, abilities: { ...state.abilities, [p.name]: { ...was, origin: { foundAt: Number.isFinite(foundAt) ? foundAt : was.learnedAt, cases: p.cases, from: p.from } } } };
    }
    case 'ability.verified': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was || was.version !== p.version) return state;
      const passed = p.steps.every((s) => s.status !== 'failed');
      return { ...state, abilities: { ...state.abilities, [p.name]: { ...was, verification: { steps: p.steps, at }, ...(passed ? { needsRecheck: null } : {}) } } };
    }
    case 'ability.missed': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was) return state;
      return { ...state, abilities: { ...state.abilities, [p.name]: { ...was, missed: was.missed + 1 } } };
    }
    case 'ability.needs_recheck': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was) return state;
      return { ...state, abilities: { ...state.abilities, [p.name]: { ...was, needsRecheck: { step: p.step, reason: p.reason, at } } } };
    }
    case 'ability.used': {
      const p = event.payload;
      const was = state.abilities[p.name];
      if (!was) return state;
      const saved = p.worked ? Math.max(0, p.baselineSteps - p.steps) + Math.max(0, p.baselineFailed - p.failedCalls) : 0;
      const avoided = p.worked ? Math.max(0, p.baselineQuestions - p.questions) : 0;
      const month = new Date(at).toISOString().slice(0, 7);
      const worked = was.worked + (p.worked ? 1 : 0);
      return {
        ...state,
        abilities: {
          ...state.abilities,
          [p.name]: {
            ...was,
            uses: was.uses + 1,
            worked,
            stepsSaved: was.stepsSaved + saved,
            savedByMonth: { ...was.savedByMonth, [month]: (was.savedByMonth[month] ?? 0) + saved },
            questionsAvoided: was.questionsAvoided + avoided,
            level: abilityLevel(worked),
          },
        },
      };
    }
    case 'skill.changed': {
      const p = event.payload;
      return { ...state, skill: { name: p.skill, hash: p.hash, sections: p.sections, at, ...(p.previous ? { previous: p.previous } : {}) } };
    }
    case 'brief.handed_off': {
      const p = event.payload;
      if (!state.briefs[p.briefId]) return state;
      const briefs = linkBrief(state.briefs, p.briefId, p.runId);
      return updateRun({ ...state, briefs }, p.runId, (run) => ({ ...run, briefId: p.briefId }));
    }
    case 'review.weekly': {
      const p = event.payload;
      const review: ReviewView = { weekOf: p.weekOf, revision: 1, ref: p.weekOf, conversationId: p.conversationId, metrics: p.metrics, suggestions: p.suggestions, at };
      return { ...state, reviews: [...state.reviews, review] };
    }
    case 'review.corrected': {
      const p = event.payload;
      const current = currentReviews(state).find((r) => r.weekOf === p.weekOf);
      if (!current || p.revision <= current.revision) return state;
      const corrected: ReviewView = {
        weekOf: p.weekOf,
        revision: p.revision,
        ref: reviewRef(p.weekOf, p.revision),
        conversationId: current.conversationId,
        metrics: p.metrics,
        suggestions: p.suggestions,
        withdrawn: p.withdrawn,
        at,
      };
      return { ...state, reviews: [...state.reviews.map((r) => (r === current ? { ...r, supersededAt: at } : r)), corrected] };
    }
    case 'ci.status': {
      const p = event.payload;
      const key = prKey({ repo: p.repo, number: p.pr });
      // The next CI result ends an acknowledgement of the last one.
      const { [key]: _ended, ...ciDismissed } = state.ciDismissed;
      return { ...state, ci: { ...state.ci, [key]: { status: p.status, at, sha: p.sha } }, ciDismissed };
    }
    case 'sync.status': {
      const p = event.payload;
      return { ...state, sources: { ...state.sources, [p.source]: { state: p.state, since: Date.parse(p.since) } } };
    }
    case 'usage.limit': {
      const p = event.payload;
      const until = p.until ? Date.parse(p.until) : undefined;
      return {
        ...state,
        claude: { state: p.state, since: Date.parse(p.since), ...(until !== undefined ? { until } : {}), ...(p.reason ? { reason: p.reason } : {}) },
      };
    }
    case 'usage.status': {
      const p = event.payload;
      return {
        ...state,
        usage: {
          fiveHourPct: p.fiveHourPct,
          sevenDayPct: p.sevenDayPct,
          ...(p.resetsAt ? { resetsAt: Date.parse(p.resetsAt) } : {}),
          ...(p.sevenDayResetsAt ? { sevenDayResetsAt: Date.parse(p.sevenDayResetsAt) } : {}),
          at,
        },
      };
    }
    case 'budget.exceeded':
      return updateRun(state, event.payload.runId, (run) => ({ ...run, budgetExceeded: event.payload }));
    case 'decision.considering': {
      const p = event.payload;
      return { ...state, considering: { ...state.considering, [p.requestId]: { ...p, at } } };
    }
    case 'decision.made': {
      const p = event.payload;
      const { [p.requestId]: _decided, ...considering } = state.considering;
      return { ...state, decisions: { ...state.decisions, [p.decisionId]: { ...p, at } }, considering };
    }
    case 'decision.changed': {
      const p = event.payload;
      const decision = state.decisions[p.decisionId];
      if (!decision) return state;
      return { ...state, decisions: { ...state.decisions, [p.decisionId]: { ...decision, changed: { by: p.by, how: p.how, ...(p.to ? { to: p.to } : {}), at } } } };
    }
    case 'decisions.digested': {
      const p = event.payload;
      const view: DigestView = { digestId: p.digestId, conversationId: p.conversationId, decisionIds: p.decisionIds, awaySince: Date.parse(p.awaySince), ...(p.asked ? { asked: p.asked } : {}), ...(p.test ? { test: p.test } : {}), ...(p.lang ? { lang: p.lang } : {}), at };
      return { ...state, digests: { ...state.digests, [p.digestId]: view } };
    }
    case 'delegation.set': {
      const p = event.payload;
      return { ...state, delegation: { ...state.delegation, [p.category]: p.setting } };
    }
    case 'precedent.saved': {
      const p = event.payload;
      return { ...state, precedents: { ...state.precedents, [p.precedentId]: { ...p, at } } };
    }
    case 'precedent.removed': {
      const { [event.payload.precedentId]: _removed, ...precedents } = state.precedents;
      return { ...state, precedents };
    }
    case 'workspace.setting': {
      const p = event.payload;
      return { ...state, settings: { ...state.settings, [p.key]: p.value } };
    }
    case 'run.assumption': {
      const p = event.payload;
      const view: AssumptionView = { assumptionId: p.assumptionId, text: p.text, evidence: p.evidence, ...(p.flag ? { flag: p.flag } : {}), by: p.by, at };
      return updateRun(state, p.runId, (run) => ({ ...run, assumptions: [...(run.assumptions ?? []).filter((a) => a.assumptionId !== p.assumptionId), view] }));
    }
    case 'task.delivered': {
      const p = event.payload;
      const view: DeliverableView = { deliverableId: p.deliverableId, runId: p.runId, kind: p.kind, title: p.title, content: p.content, ...(p.language ? { language: p.language } : {}), at };
      const next = { ...state, deliverables: { ...state.deliverables, [p.deliverableId]: view } };
      return updateRun(next, p.runId, (run) => ({ ...run, deliverables: [...(run.deliverables ?? []), p.deliverableId] }));
    }
    default:
      // Event types from older logs (v0's run.step_changed and run.plan_declared): their runs have ended.
      return state;
  }
}

function updateRun(state: WorkspaceState, runId: string, update: (run: RunView) => RunView): WorkspaceState {
  const run = state.runs[runId];
  if (!run) return state;
  return { ...state, runs: { ...state.runs, [runId]: update(run) } };
}

function updateSubagent(state: WorkspaceState, runId: string, subagentId: string, update: (s: SubagentView) => SubagentView): WorkspaceState {
  return updateRun(state, runId, (run) => {
    if (!run.subagents.some((s) => s.subagentId === subagentId)) return run;
    return { ...run, subagents: run.subagents.map((s) => (s.subagentId === subagentId ? update(s) : s)) };
  });
}

function linkHandoff(handoffs: Record<string, HandoffView>, handoffId: string, runId: string): Record<string, HandoffView> {
  const handoff = handoffs[handoffId]!;
  if (handoff.runIds.includes(runId)) return handoffs;
  return { ...handoffs, [handoffId]: { ...handoff, runIds: [...handoff.runIds, runId] } };
}

function linkBrief(briefs: Record<string, BriefView>, briefId: string, runId: string): Record<string, BriefView> {
  const brief = briefs[briefId]!;
  if (brief.runIds.includes(runId)) return briefs;
  return { ...briefs, [briefId]: { ...brief, runIds: [...brief.runIds, runId] } };
}

/** Sub-agent events from before v1 carried a definition name ("sonnet-5.5-high") instead of model and effort. */
function withLegacyStart(p: PayloadOf<'subagent.started'>): PayloadOf<'subagent.started'> {
  if (p.model) return p;
  const name = (p as unknown as { name?: string }).name ?? '';
  const m = /^(haiku|sonnet|opus)-(\d+)\.(\d+)-(low|medium|high|xhigh|max)$/.exec(name);
  return m ? { ...p, model: `claude-${m[1]}-${m[2]}-${m[3]}`, effort: m[4] as Effort } : { ...p, model: 'unknown', effort: 'medium' };
}

/** Before v1 a sub-agent ended as success or failure with a summary. */
function withLegacyFinish(p: PayloadOf<'subagent.finished'>): PayloadOf<'subagent.finished'> {
  const legacy = p as unknown as { outcome: string; summary?: string };
  if (legacy.outcome !== 'success' && legacy.outcome !== 'failure') return p;
  return { ...p, outcome: legacy.outcome === 'success' ? 'done' : 'failed', result: legacy.summary ?? '', tokens: 0, toolCalls: 0, durationMs: 0 };
}
