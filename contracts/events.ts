// Event contract between the Elfoqsy daemon and the workspace UI.
// The event log stores these envelopes; both screens rebuild state by folding them in seq order.
// Every string field is redacted before the event is written.

export type Source = 'orchestrator' | 'jira' | 'github' | 'agent' | 'elfoqsy' | 'simulator';

export interface EventEnvelope<T extends ElfEvent['type'] = ElfEvent['type']> {
  seq: number;        // monotonically increasing, assigned by the event log
  id: string;         // ULID
  ts: string;         // ISO 8601, UTC
  source: Source;
  type: T;
  payload: Extract<ElfEvent, { type: T }>['payload'];
}

export type TicketType = 'Story' | 'Task' | 'Bug' | 'Epic' | 'Sub-task';
export type TicketStatus = 'To do' | 'In progress' | 'Blocked' | 'Done' | 'Released' | 'Cancelled';
export type Priority = 'Blocker' | 'Critical' | 'Major' | 'Minor';
// A step is the agent's own short name for a stretch of work, formed as it goes (begin_step): from investigating to changing
// code, from changing to verifying, from local to waiting on CI. There is no plan of steps up front and no total.
export type Step = string;
export type StepOutcome = 'done' | 'abandoned' | 'failed';
// Models and efforts: model is a Claude model id (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5).
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Elfoqsy's state, most urgent first: broken, needs you, done (2 minutes after a run succeeds), thinking
// (an investigation runs or she writes a brief), working (any run active), quiet.
export type Mood = 'broken' | 'needs' | 'done' | 'thinking' | 'working' | 'quiet';
// Who acted: alex ('you'), the tester (never him), Elfoqsy, the ticket agent itself, or the orchestrator.
export type Actor = 'you' | 'tester' | 'elfoqsy' | 'agent' | 'orchestrator';

// The five panes (P1) and how the two screens are arranged (P2). A screen is a row of columns, each a stack of panes from
// top to bottom; the layout holds both screens, left then right, with no pane twice; a pane on neither has been removed from
// the screens. No layout saved (null in the event) is today's arrangement: Sprint, Elfoqsy and the conversation on the left,
// the agent map and the terminals on the right.
export type PaneId = 'sprint' | 'elfoqsy' | 'conversation' | 'map' | 'terminals';
export type ScreenLayout = PaneId[][];
export type Layout = [ScreenLayout, ScreenLayout];

export type WorkspaceSettingKey = 'maxAgents';
export type Progress = 'none' | 'some' | 'most' | 'nearly';
export type SubagentOutcome = 'done' | 'failed' | 'cancelled';
// A check is a done-when condition the agent declares with its goal (declare_goal) and may change later.
// How a check proves the ticket is done. command: that exact command passed in the run folder. ci: CI passed on the
// named repo's branch head, once pushed (read per commit; no PR needed). approval: Alex approved it. Evidence holds only
// while the run's code is as it was when the check passed (a fingerprint of its files), except for an approval scoped
// 'external' (a Confluence page, a decision), which code changes do not touch.
export interface PlanCheck {
  id: string;
  description: string;
  proof: 'command' | 'ci' | 'approval';
  command?: string;      // proof 'command' only
  repo?: string;         // proof 'ci' only: owner/name, one of the run's repositories
  scope?: 'code' | 'external'; // proof 'approval' only; 'code' when left out
}
export type CheckStatus = 'pending' | 'passed' | 'failed';
// stopped: the run ended without finishing (blocked, no plan, or a check without evidence of passing); the reason says which.
export type RunState = 'queued' | 'running' | 'waiting_for_you' | 'failed' | 'succeeded' | 'stopped' | 'cancelled';
// Approval kinds: push and pr are the run's branch and PR; github is a CI rerun or a named workflow run; command is a
// command heavier than the repo's unit tests (other test tiers, docker); check is evidence for a plan check only Alex can
// give; question is the agent asking Alex. action is a tier-2 request through one of the orchestrator's
// proxies, and outside_worktree a file written outside the run folder; push, pr, github, command, jira_write and
// network stay only for logs from before v1.2.

// Permission tiers: 0 free, done at once and logged; 1 done at once, Elfoqsy reports it
// in one line, undoable where the inverse is not tier 3; 2 asked first, once per batch, or covered by a grant for the same
// kind, ticket and environment; 3 never, refused and handed to alex.
export type Tier = 0 | 1 | 2 | 3;

// Abilities: skills Elfoqsy and her agents learn from real work, kept in data/skills.
/** The tool a skill is about: its card's logo and filter. `elfoqsy` is her own workspace (its runs, events and sprint: her fox); `other` only what an older log holds. */
export type AbilityTool = 'kubernetes' | 'coralogix' | 'github' | 'aws' | 'jira' | 'confluence' | 'docker' | 'test' | 'teams' | 'outlook' | 'sharepoint' | 'onedrive' | 'elfoqsy' | 'other';
// What an activity line of Elfoqsy's reached, which picks its tile: every name has an official icon or a generic one for its kind in
// the web app's registry (ui/toolIcons.ts), checked by a test.
export type ActivityTool = 'jira' | 'github' | 'confluence' | 'code' | 'logs' | 'agent' | 'memory' | 'workspace' | 'kube' | 'aws' | 'outlook' | 'teams' | 'sharepoint' | 'microsoft365';
/** Who found it: Elfoqsy (from past work, or a session of hers), or an agent in a run. */
// alex: an ability he asked for, credited to him, his own picture on its card.
export type AbilityFinder = { by: 'elfoqsy'; session?: string } | { by: 'agent'; agentNumber: number; runId: string; ticket?: string } | { by: 'alex' };
/** One step as a card shows it: one short line, and the sample it runs when there is one. read: run through the proxies to verify it. */
export interface AbilityStepView {
  text: string;
  code?: string;
  kind: 'read' | 'effect' | 'note';
}
export type AbilityStepStatus = 'ok' | 'failed' | 'unverified';
// The orchestrator tool an agent's remote action went through. git: a push of the run branch; file: a file written
// outside the run folder.
// 'web' is Elfoqsy's own WebSearch and WebFetch: logged as actions, never a tool of an
// agent's proxies.
export type ProxyName = 'git' | 'gh' | 'kube' | 'aws' | 'jira' | 'confluence' | 'logs' | 'file' | 'docker' | 'shop' | 'web';

export interface Ticket {
  key: string;                 // e.g. SHOP-3546
  board: string;               // e.g. SHOP
  summary: string;
  type: TicketType;
  status: TicketStatus;        // mapped from the Jira status category; BLOCKED keeps its own value
  priority: Priority;
  storyPoints: number | null;
  sprint: string;
  sprintsCarried: number;      // how many sprints the ticket has been in
  epic: string | null;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  linked: string[];            // keys of linked tickets
  description: string;         // redacted plain text
  // The ticket's own workflow status (OPEN, IN ANALYZE, WORK-DONE) and Jira's category for it, which picks the chip's
  // colour. `status` above stays for the story-point bar and the workspace's own rules.
  workflowStatus?: WorkflowStatus;
  assignee?: string;           // display name; the sprint's tickets are alex's
  updatedAt?: string;          // Jira's updated, exactly: any change on the ticket (a comment too) shows here
}

// Jira's status categories: new (To Do), indeterminate (In Progress), done.
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';
export interface WorkflowStatus {
  name: string;
  category: JiraStatusCategory;
}

// A ticket as Jira holds it, for the full ticket view and Elfoqsy's reading of it. Values are Jira's own JSON
// (rich text as Atlassian Document Format), redacted like everything else in the log, and never executed.
export interface JiraUser {
  accountId?: string;
  displayName: string;
}
export interface JiraFieldSchema {
  type: string;
  items?: string;
  custom?: string;
  system?: string;
}
// Whether and how a field can be edited on this ticket (Jira's editmeta), trimmed to what the editors use.
export interface JiraEditMeta {
  required: boolean;
  operations: string[];
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
}
export interface JiraComment {
  id: string;
  author?: JiraUser;
  created: string;
  updated?: string;
  body: unknown;               // ADF
}
export interface JiraChangeItem {
  field: string;
  fieldId?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}
export interface JiraHistory {
  id: string;
  author?: JiraUser;
  created: string;
  items: JiraChangeItem[];
}
// Remote links on the ticket: Confluence pages that mention it, PR links, anything else.
export interface JiraRemoteLink {
  id: string;
  url: string;
  title: string;
  application?: string;        // "com.atlassian.confluence" for a page
  relationship?: string;       // "mentioned in"
}
// What someone other than alex changed since the ticket was last read: shown on the field for a few seconds.
export interface JiraFieldChange {
  fieldId: string;
  name: string;
  by: string;
  at: string;
}
// A ticket drafted by Elfoqsy or an agent: it waits for alex, who alone creates tickets. description is
// Markdown; links are from the new ticket ("relates to SHOP-3538").
export interface TicketDraft {
  project: string;
  type: string;
  summary: string;
  description?: string;
  priority?: string;
  storyPoints?: number;
  sprint?: { id: number; name: string };
  labels?: string[];
  links?: Array<{ linkType: string; direction: 'inward' | 'outward'; other: string }>;
  parent?: string;
}
// A field of Jira's create screen for a project and issue type.
export interface JiraCreateField {
  id: string;
  name: string;
  required: boolean;
  schema?: JiraFieldSchema;
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
}
// One line of Jira news: who did what on which ticket, when.
export interface JiraNewsItem {
  kind: 'mention' | 'transition' | 'comment' | 'change';
  who: string;
  what: string;
  key: string;
  at: string;
}
// A workflow transition Jira offers on a ticket now, with the fields its screen asks for.
export interface JiraTransition {
  id: string;
  name: string;
  to: WorkflowStatus;
  fields: Array<{ id: string; name: string; required: boolean; schema?: JiraFieldSchema; allowedValues?: Array<{ id?: string; name?: string; value?: string }> }>;
}
// One of his edits as the left screen sends it. base: the value (or comment body) the editor started from, as the
// screens hold it; the daemon refuses to save over a different one.
export type JiraChange =
  | { op: 'field'; fieldId: string; value: unknown; base: unknown }
  | { op: 'transition'; transitionId: string; fields?: Record<string, unknown> }
  | { op: 'comment_add'; body: unknown }
  | { op: 'comment_edit'; commentId: string; body: unknown; base: unknown }
  | { op: 'comment_delete'; commentId: string }
  | { op: 'link_add'; linkType: string; direction: 'inward' | 'outward'; other: string }
  | { op: 'link_remove'; linkId: string };
// The layout's fields by role: their Jira names and ids on this site, checked at start-up.
export type JiraFieldRole =
  | 'storyPoints'
  | 'acceptanceCriteria'
  | 'solution'
  | 'impact'
  | 'design'
  | 'rootCause'
  | 'failedAc'
  | 'sprint'
  | 'qaAssignee'
  | 'reviewer'
  | 'qaPoints'
  | 'flagged'
  | 'development';

// Where a finding or a fact comes from. code: path:line in a repository; ticket, pr: a key or owner/name#n; log: a log
// query; doc: a Confluence page; url: anything else. what Elfoqsy's decisions rest on: memory (a factId),
// decision (an earlier answer of alex's, by approvalId), precedent (a precedentId), setting (a delegation category).
export interface SourceRef {
  kind: 'code' | 'ticket' | 'pr' | 'log' | 'doc' | 'url' | 'memory' | 'decision' | 'precedent' | 'setting';
  ref: string;
  label?: string;
}

// Delegation: every agent question and tier-2 request goes to Elfoqsy first. Each category is decided by her,
// decided and told, or asked of alex. The orchestrator works out the category; no model is involved in that.
// run_folder: a file or path ask whose paths all resolve inside the run folder; sourced_answer: a question she answers
// from a source she cites; ci_rerun: rerunning a CI run; harness_kube: set image, restart or scale of the test harness
// on dev or integration; harness_image: the harness image pushed to the dev or integration ECR; unsourced: a question
// with no source or precedent; notify_people: anything other people are notified of (ready for review, PR or Jira
// comments, transitions, issues, pages); staging_write; read_secret; prod_logs; irreversible: what cannot be undone;
// other: any other tier-2 request. jira_fill: filling an empty field of a ticket assigned to alex.
export type DelegationCategory =
  | 'run_folder'
  | 'sourced_answer'
  | 'ci_rerun'
  | 'harness_kube'
  | 'harness_image'
  | 'unsourced'
  | 'notify_people'
  | 'staging_write'
  | 'read_secret'
  | 'prod_logs'
  | 'irreversible'
  | 'jira_fill'
  | 'other';
export type DelegationSetting = 'decide' | 'decide_and_tell' | 'ask';

// A question from an agent, as it must be asked: one line, at most three reasons, two to four options each with
// its consequence, the agent's recommended option, and its sources.
export interface QuestionCard {
  question: string;
  why: string[];
  options: Array<{ label: string; consequence: string }>;
  recommendation: string;
  sources: SourceRef[];
}

// A task agent: work alex asked for that is not tied to a ticket. Its result comes back into the
// conversation as a document, a table or code.
export type DeliverableKind = 'document' | 'table' | 'code';
export interface TaskSpec {
  name: string;          // short, shown where a ticket key would be
  goal: string;
  deliverable: DeliverableKind;
}

// What an agent decided itself and recorded, listed under "Decisions I made". A flag marks what alex
// decides at review: a visible contract change, a cache bypass, teammates' code in a hotfix, an ambiguous ticket's
// expected behaviour.
export type AssumptionFlag = 'contract' | 'cache_bypass' | 'teammate_code' | 'expected_behaviour';

export interface Finding {
  text: string;
  sources: SourceRef[];
}

// The ticket narrative, "What we know" (N1): what an agent reports at the stage where it knows it. A chain is the path
// from the entry to the fault, each link a path:line; an alternative is a fix the agent weighed and why it did not take it.
export interface ChainLink {
  ref: string;
  role: 'entry' | 'hop' | 'fault';
  note?: string;
}
export interface Alternative {
  option: string;
  rejectedBecause: string;
}
// Per repository, what one push carried: computed by the orchestrator from git, never reported by a model.
export interface PushedRepo {
  repo: string;
  branch: string;
  head: string;
  commits: Array<{ sha: string; subject: string }>;
  files: Array<{ path: string; added: number; removed: number }>;
}

// Elfoqsy's messages are a short text plus typed blocks. A block references state by id and the screen fills it in, so it
// can never show a wrong number; only code is inline.
export type MessageBlock =
  | { type: 'ticket'; ref: string }          // ticket key
  | { type: 'findings'; ref: string }        // investigationId
  | { type: 'progress'; ref: string }        // runId
  | { type: 'sprint'; ref: string }          // sprint name
  | { type: 'approval'; ref: string }        // approvalId
  | { type: 'brief'; ref: string }           // briefId (older logs)
  | { type: 'handoff'; ref: string }         // handoffId
  | { type: 'verdict'; ref: string }         // runId: the run's latest verdict
  | { type: 'review'; ref: string }          // weekOf of a weekly review
  | { type: 'decision'; ref: string }        // decisionId: one of Elfoqsy's decisions, with View, Undo or Change
  | { type: 'digest'; ref: string }          // digestId: what she decided while alex was away
  | { type: 'deliverable'; ref: string }     // deliverableId: a task agent's result
  | { type: 'draft'; ref: string }           // draftId: a ticket Elfoqsy or an agent drafted, waiting for alex
  | { type: 'jira_news'; ref: string }       // newsId: what happened in Jira while he was away
  | { type: 'narrative'; ref: string; section: 2 | 7 } // runId: a link into the ticket's narrative, to its verdict or its hand-back (N1)
  | { type: 'ability'; ref: string }         // an ability's name: its small card, opening the Abilities view on it
  // path, startLine and highlight: a header with the file and line range, numbered lines, highlighted lines.
  | { type: 'code'; content: string; language?: string; diff?: boolean; path?: string; startLine?: number; highlight?: number[] };

// How a ticket agent works, chosen at handoff: normal; read_only (no edits at all); hotfix (on a
// release/<version> branch); remediation (a Black Duck or Sonar finding, reproduced from the scanner's inputs).
export type RunMode = 'normal' | 'read_only' | 'hotfix' | 'remediation';

// The verdict before any code changes, in the team-dev skill's own validity labels (one vocabulary, alex's call
// of 11 October): VALID (a bug: the reported symptom, reproduced or not yet), ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID,
// INSUFFICIENT_EVIDENCE/NOT_REPRODUCED; and NEW_BEHAVIOR for a story (its expected behaviour, confirmed by him),
// VALID_FINDING for a remediation (reproduced from the scanner's inputs). The three in the middle stop the run.
export type Verdict = 'VALID' | 'ALREADY_FIXED' | 'EXPECTED_BEHAVIOR/INVALID' | 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED' | 'NEW_BEHAVIOR' | 'VALID_FINDING';

// A brief's section: a heading and Markdown (paragraphs, lists, inline code, bold).
export interface BriefSection {
  heading: string;
  markdown: string;
}

export interface Attachment {
  attachmentId: string;
  name: string;
  mediaType: string;
  bytes: number;
}

export interface PullRequest {
  repo: string;
  number: number;
  state: 'open' | 'draft' | 'merged' | 'closed';
  ticket: string;              // every PR belongs to a ticket
  url: string;
  checks: 'none' | 'pending' | 'success' | 'failure';
  // The PR's title, and where its review stands as GitHub says it (N1: the narrative's hand-back shows both).
  title?: string;
  review?: 'none' | 'approved' | 'changes_requested' | 'review_required';
}

export type ElfEvent =
  | { type: 'ticket.synced'; payload: { ticket: Ticket } }
  | { type: 'ticket.removed'; payload: { key: string } }
  // A ticket read in full from Jira: first a snapshot (full), then only what changed since the last one the log
  // has. fields: set or changed values by field id; removed: fields now empty; names, schema, editmeta, comments,
  // remoteLinks and locked replace the whole list when present; history is appended (the newest 100 are kept);
  // confluence adds page titles by page id. locked: fields (and comment:<id>) the redactor changed, so they cannot be
  // written back. changes: what others changed since the last read. updated: Jira's, fetchedAt: when it was read.
  | {
      type: 'ticket.detail';
      payload: {
        key: string;
        id: string;
        full?: true;
        fields?: Record<string, unknown>;
        removed?: string[];
        names?: Record<string, string>;
        schema?: Record<string, JiraFieldSchema>;
        editmeta?: Record<string, JiraEditMeta>;
        comments?: JiraComment[];
        history?: JiraHistory[];
        remoteLinks?: JiraRemoteLink[];
        confluence?: Record<string, string>;
        locked?: string[];
        changes?: JiraFieldChange[];
        updated: string;
        fetchedAt: string;
      };
    }
  // A ticket could not be read (not found, no access, Jira unreachable): the open view says so.
  | { type: 'ticket.unreadable'; payload: { key: string; reason: string } }
  // What his pickers offer for a project, read once and again after an hour: who he is, the people tickets can be
  // assigned to (and mentioned), the board's open and next sprints, the link types and labels in use.
  | {
      type: 'jira.options';
      payload: {
        project: string;
        me: JiraUser;
        users: JiraUser[];
        sprints: Array<{ id: number; name: string; state: string; goal?: string }>;
        linkTypes: Array<{ id: string; name: string; inward: string; outward: string }>;
        labels: string[];
        fetchedAt: string;
      };
    }
  // The transitions Jira offers on a ticket now, read when he opens its status menu.
  | { type: 'ticket.transitions'; payload: { key: string; transitions: JiraTransition[] } }
  // An edit made in Jira from the workspace: his (straight to Jira), Elfoqsy's or an agent's (through the proxy).
  // editId: the screen's own id for his edit; recordId: the recorded change, for Undo.
  | {
      type: 'jira.edited';
      payload: {
        editId?: string;
        key: string;
        by: Actor;
        what: JiraChange['op'];
        fieldId?: string;
        ok: boolean;
        error?: string;
        actionId?: string;
        recordId?: string;
        runId?: string;
      };
    }
  // His save found the field changed by someone else since his editor opened: nothing was written; theirs comes back.
  | { type: 'jira.edit_conflict'; payload: { editId: string; key: string; fieldId: string; theirs: unknown; by?: string; at?: string } }
  // A ticket drafted by Elfoqsy or an agent, shown as a card that waits for him: only he creates tickets.
  | { type: 'ticket.drafted'; payload: { draftId: string; by: Actor; runId?: string; conversationId?: string; draft: TicketDraft } }
  // A draft created (by him, through the form) or discarded.
  | { type: 'ticket.draft_closed'; payload: { draftId: string; how: 'created' | 'discarded'; key?: string; by: Actor } }
  // Jira's create screen for a project: its issue types, and the fields of one type when asked.
  | { type: 'ticket.createmeta'; payload: { project: string; types: Array<{ id: string; name: string; subtask: boolean }>; typeId?: string; fields?: JiraCreateField[] } }
  // He created a ticket (his Create): its key, and whether its links, sprint and parent were read back as set.
  | { type: 'ticket.created'; payload: { createId: string; key: string; draftId?: string; checks: { links?: boolean; sprint?: boolean; parent?: boolean } } }
  | { type: 'ticket.create_failed'; payload: { createId: string; error: string } }
  // What happened in Jira while he was away: mentions of him, and changes, transitions and comments by others on
  // tickets he is assigned to or reported. Posted with Elfoqsy's line when he comes back.
  | { type: 'jira.news'; payload: { newsId: string; since: string; conversationId: string; items: JiraNewsItem[] } }
  // Tickets found by key or summary words, in the sprint or not (a tier-0 search).
  | {
      type: 'ticket.search';
      payload: { query: string; results: Array<{ key: string; summary: string; type: string; status: WorkflowStatus; inSprint: boolean; sprint?: string }> };
    }
  // The layout's fields on this site, checked against Jira's field list at start-up: moved ones were found under the
  // same name with another id; missing ones were not found (or found more than once).
  | {
      type: 'jira.fields';
      payload: {
        fields: Partial<Record<JiraFieldRole, { name: string; id: string }>>;
        moved: Array<{ role: JiraFieldRole; name: string; from: string; to: string }>;
        missing: Array<{ role: JiraFieldRole; name: string; id: string }>;
      };
    }
  | { type: 'pr.synced'; payload: { pr: PullRequest } }
  // The ticket agent is always Opus 5.5 at xhigh; model and effort are carried so the screens show what really runs.
  // briefId and conversationId: the brief it works from and the conversation it was agreed in, when there is one.
  // budget: what the run may spend before the orchestrator stops it (tokens without cache reads, working minutes).
  // handoffId and mode: the handoff it works from and how; bases: each repository's base branch when not its default.
  | { type: 'run.created'; payload: { runId: string; ticket: string; worktree: string; branch: string; agentNumber: number; model?: string; effort?: Effort; briefId?: string; handoffId?: string; mode?: RunMode; bases?: Record<string, string>; conversationId?: string; budget?: { tokens: number; minutes: number }; repos?: string[]; test?: true; startedFrom?: string; task?: TaskSpec } }
  // test: started at the tester's request (its folder is kept only for commits). startedFrom: the ended run
  // whose kept folder's branch it starts from, instead of GitHub. task: a task agent; its ticket is task:<id>
  // and screens show the task's name instead.
  // The agent's goal and its done-when checks, early (from the brief) and again whenever the checks change.
  | { type: 'run.goal_declared'; payload: { runId: string; revision: number; goal: string; checks: PlanCheck[] } }
  // A step forms when the nature of the work changes; beginning one ends the previous one (run.step_ended first).
  | { type: 'run.step_begun'; payload: { runId: string; stepIndex: number; name: Step; why: string } }
  | { type: 'run.step_ended'; payload: { runId: string; stepIndex: number; outcome: StepOutcome; note?: string } }
  // A check's evidence changed; evidence says what was seen (the command and when, the CI run, who approved).
  | { type: 'run.check_changed'; payload: { runId: string; checkId: string; status: CheckStatus; evidence: string } }
  // Every 5 minutes of working time: where the agent is, what it did, what comes next, how far it thinks it is.
  | { type: 'run.heartbeat'; payload: { runId: string; step: Step; sinceLast: string; next: string; progress: Progress; risks: string[]; tokens: number; workingSeconds: number } }
  // Elfoqsy acknowledges a report (a checkpoint or a heartbeat) by its seq, with a note when she has one.
  | { type: 'run.ack'; payload: { runId: string; refEventSeq: number; note?: string } }
  // Something Elfoqsy surfaces without being asked: two missed heartbeats, a loop, a budget nearly spent.
  | { type: 'run.flag'; payload: { runId: string; kind: 'missed_heartbeats' | 'loop' | 'budget' | 'replan'; detail: string } }
  | { type: 'run.paused'; payload: { runId: string; by: Actor; reason?: string } }
  | { type: 'run.resumed'; payload: { runId: string; by: Actor; reason?: string } }
  // Guidance typed into a paused agent's pane (or by Elfoqsy); the agent answers by declaring its next step.
  | { type: 'run.guidance'; payload: { runId: string; text: string; by: Actor } }
  // The workspace reminded an agent of what it owes: a heartbeat, or its next step after guidance.
  | { type: 'run.reminded'; payload: { runId: string; about: 'heartbeat' | 'replan'; text: string } }
  // A failed run alex (or the tester) has acknowledged: it stops counting as broken and as active,
  // and stays failed in history and analytics. by: who asked for it, from the run's pane or through Elfoqsy.
  | { type: 'run.dismissed'; payload: { runId: string; by: Actor; reason?: string } }
  // An ended run's folder was removed: it held nothing uncommitted and nothing GitHub lacked (a tester's run:
  // no commits GitHub lacked). reason: why it could go, such as the run being cancelled or dismissed.
  | { type: 'run.folder_removed'; payload: { runId: string; folder: string; reason: string } }
  // Tokens (input, output, cache writes; not cache reads) and working time so far, for the run's meters.
  | { type: 'run.usage'; payload: { runId: string; tokens: number; workingSeconds: number } }
  | { type: 'run.state_changed'; payload: { runId: string; state: RunState; reason?: string } }
  | { type: 'run.note'; payload: { runId: string; text: string } }          // the agent's own narration, one short line
  // A sub-agent record, kept for good: who started it (the Agent tool call), its model, effort and task; then everything it did.
  | { type: 'subagent.started'; payload: { runId: string; subagentId: string; parentToolUseId?: string; model: string; effort: Effort; task: string } }
  | { type: 'subagent.tool_called'; payload: { runId: string; subagentId: string; toolUseId?: string; tool: string; inputSummary: string; outputSummary: string; ok: boolean; stats?: string } }
  // outcome cancelled: by whom and why. result: what it returned to its agent.
  | { type: 'subagent.finished'; payload: { runId: string; subagentId: string; outcome: SubagentOutcome; by?: Actor; reason?: string; result: string; tokens: number; toolCalls: number; durationMs: number } }
  // A tool call, as the approval gate saw it. title: the call in plain words (the command, the file); where: the
  // repository folder it ran in. No runId: one of Elfoqsy's own calls.
  // outside: what the shell gate would have asked about, when a command touches a path outside the run folder or a shell
  // variable that could point there. It runs inside the sandbox, which decides what it may read or write, so it is logged, not asked.
  | { type: 'tool.called'; payload: { runId?: string; subagentId?: string; toolUseId?: string; tool: string; title?: string; where?: string; inputSummary: string; allowed: boolean; outside?: string } }
  // How an agent's own tool call ended, for its transcript. stats: a short note on the call's line ("+2 −1");
  // outputSummary: a few lines of output, redacted.
  // diff: an Edit's hunks with their line numbers, from Claude Code's structuredPatch, redacted and capped.
  | { type: 'tool.finished'; payload: { runId: string; toolUseId: string; ok: boolean; outputSummary: string; stats?: string; durationMs?: number; diff?: { hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> } } }
  // The agent's own reasoning, every text block it writes between tool calls (a sub-agent's with its id), redacted.
  | { type: 'run.thought'; payload: { runId: string; subagentId?: string; text: string } }
  // The ticket agent's verdict on its ticket, with what shows it: a bug (reproduced or not yet), intended behaviour, a bug
  // it cannot reproduce, or unclear. Before it changes any code.
  // symptom: the reported symptom, quoted from the ticket; sibling: the similar working case it was diffed against, or
  // why there is none; example: the input -> output it proposes for an ambiguous ticket or a story; ticketComment: what
  // it proposes to say on the ticket when the run stops; findings: what shows the verdict, each with sources.
  | {
      type: 'run.verdict';
      payload: {
        runId: string;
        verdict: Verdict;
        reproduced: boolean;
        summary: string;
        evidence?: SourceRef[];
        symptom?: string;
        sibling?: string;
        example?: { input: string; output: string };
        ticketComment?: string;
        findings?: Finding[];
        // N1: the path from the entry to the fault, in order, and the working case it was compared with, as path:line.
        chain?: ChainLink[];
        siblingAt?: SourceRef;
      };
    }
  // The narrative's records (N1), each said by the agent where it knows it. report_understanding comes before the verdict;
  // the rest follow the stage they belong to. The latest of each stands; the log keeps every one.
  | { type: 'run.understanding'; payload: { runId: string; claim: string; input: string; actual: string; expected: string; sources: SourceRef[] } }
  | { type: 'run.reproduction'; payload: { runId: string; how: string; environment: string; test?: { path: string; name: string }; command?: string; requestIds?: string[] } }
  | { type: 'run.root_cause'; payload: { runId: string; text: string; lines: SourceRef[] } }
  | { type: 'run.approach'; payload: { runId: string; approach: string; alternatives: Alternative[] } }
  // What the orchestrator saw itself (N1), so it cannot drift: a test-shaped command and how it ended, and what a push carried.
  | { type: 'run.test_run'; payload: { runId: string; subagentId?: string; toolUseId: string; command: string; ok: boolean; durationMs?: number; summary: string; passed?: number; failed?: number; failedNames?: string[] } }
  | { type: 'run.pushed'; payload: { runId: string; repos: PushedRepo[] } }
  // report_result, as an event (N1): how the turn ended, what was not verified, what waits for alex. handed_back: the
  // turn ended with a PR open, and what the agent said last, labelled as its hand-back.
  // unmet: for each acceptance criterion the review called NOT MET, by its number, why the agent says it cannot be met here (a run is
  // not reported succeeded while one is NOT MET and unexplained).
  | { type: 'run.reported'; payload: { runId: string; result: 'succeeded' | 'failed' | 'blocked'; summary: string; notVerified: string[]; waitingOnYou: string[]; unmet?: Array<{ n: number; why: string }> } }
  // The fresh-context review's verdict on each acceptance criterion of the ticket, from its CRITERION lines: met, not_met, or
  // cannot_tell from the diff and the files. The latest review replaces the one before. An empty list: the ticket states none.
  | { type: 'run.criteria_reviewed'; payload: { runId: string; criteria: Array<{ n: number; status: 'met' | 'not_met' | 'cannot_tell'; text: string; why: string }> } }
  | { type: 'run.handed_back'; payload: { runId: string; message: string } }
  // He ticked "I've read the narrative" for a run (N1); the tester's tick is recorded but never opens the gate.
  | { type: 'narrative.read'; payload: { runId: string; ticket: string; by: Actor } }
  // How the two screens are arranged (P2), saved here so both windows share it and a reload keeps it. layout null: no layout
  // saved, today's arrangement. The latest stands; the log keeps every one.
  | { type: 'layout.changed'; payload: { layout: Layout | null; by: Actor } }
  // Before its first code change: every input class the change will see (message and config types, retries, timeouts).
  | { type: 'run.inputs_declared'; payload: { runId: string; classes: string[] } }
  // A cause the agent is testing, and how it ended. Three disproved ones and Elfoqsy flags it.
  | { type: 'run.hypothesis'; payload: { runId: string; hypothesisId: string; text: string; status: 'open' | 'confirmed' | 'disproved'; evidence?: SourceRef[] } }
  // A different defect found during the run: reported with a proposed split ticket, never fixed in the same run.
  | { type: 'run.finding'; payload: { runId: string; findingId: string; summary: string; evidence: SourceRef[]; proposedTicket: { summary: string; description: string } } }
  // The read-only copy of alex's team-dev skill the run follows, by its hash.
  | { type: 'run.skill_snapshot'; payload: { runId: string; hash: string; files: number } }
  // One of Elfoqsy's own actions in a conversation, in a plain line ("Read SHOP-3492 and its comments"): running, then
  // done or failed. tool: what it reached, for its tile (jira, github, confluence, code, logs, agent, memory, workspace).
  | { type: 'elfoqsy.activity'; payload: { conversationId: string; activityId: string; tool: string; text: string; state: 'running' | 'done' | 'failed' } }
  // tier: 2 for a request through a proxy. grantable: "Allow for this ticket" is offered, for this kind and environment.
  // batchId: tier-2 requests made in the same conversation within a few seconds share one, and one message lists them.
  // kind example: an input -> output for an ambiguous ticket or a story, confirmed before any code; decision: a product
  // decision (a visible contract, a cache bypass, teammates' code in a hotfix); round: another bot-review round after three.
  // an approval is what Elfoqsy escalated to him: card is an agent's structured question; category its
  // delegation category; suggestion her recommended option, why and what it rests on; noSuggestion why she has none.
  // precedentable: "Let Elfoqsy decide this kind next time" is offered. requestId: what she was considering.
  | { type: 'approval.requested'; payload: { approvalId: string; runId: string; kind: 'push' | 'pr' | 'github' | 'command' | 'check' | 'jira_write' | 'outside_worktree' | 'network' | 'question' | 'action' | 'example' | 'decision' | 'round'; question: string; action?: string; options?: string[]; tier?: Tier; grantable?: { kind: string; environment?: string }; batchId?: string; card?: QuestionCard; category?: DelegationCategory; suggestion?: { option: string; why: string; sources: SourceRef[] }; noSuggestion?: string; precedentable?: true; requestId?: string; gate?: 'narrative' } }
  // test: answered by a developer or coding agent testing the system, not by Alex. scope ticket: "Allow for this
  // ticket", which also creates a grant; once, or left out: this request only. withdrawn: nobody answered in 72
  // hours; the question left the screen and the run paused. precedent: he ticked "Let Elfoqsy decide this kind
  // next time"; the orchestrator stores it as precedent.saved.
  | { type: 'approval.resolved'; payload: { approvalId: string; decision: 'approved' | 'denied' | 'answered'; answer?: string; test?: true; scope?: 'once' | 'ticket'; withdrawn?: true; precedent?: true } }
  // Elfoqsy as first responder. considering: a question or request reached her and she is looking at it. made:
  // she decided it, with what it rests on (sources she cited, the delegation setting, or one of his precedents); told
  // when she also said so at once ("decide and tell me"); actionId when it let a proxy action run (Undo comes from its
  // recorded change). changed: alex changed her answer (to) or undid the action. digested: the decisions listed
  // for him when he came back.
  | { type: 'decision.considering'; payload: { requestId: string; runId: string; requestKind: 'question' | 'action'; summary: string } }
  | { type: 'decision.made'; payload: { decisionId: string; requestId: string; runId: string; requestKind: 'question' | 'action'; category: DelegationCategory; summary: string; question?: string; options?: string[]; answer: string; sources: SourceRef[]; basis: 'sources' | 'delegation' | 'precedent'; told: boolean; actionId?: string; lang?: 'vi' } }
  | { type: 'decision.changed'; payload: { decisionId: string; by: Actor; how: 'changed' | 'undone'; to?: string } }
  // asked: he opened it himself, and awaySince is then when his last digest was; test: the tester opened it, so
  // his own digests still list those decisions.
  // lang: 'vi' when it was written in Vietnamese, as the language of his latest message was; absent for English.
  | { type: 'decisions.digested'; payload: { digestId: string; conversationId: string; decisionIds: string[]; awaySince: string; asked?: true; test?: true; lang?: 'vi' } }
  // His delegation settings and precedents. A precedent stores "Let Elfoqsy decide this kind next time": for an
  // action, that action's kind is decided on tickets of that type; for a question, his answer becomes a source she may cite.
  | { type: 'delegation.set'; payload: { category: DelegationCategory; setting: DelegationSetting; by: Actor } }
  | { type: 'precedent.saved'; payload: { precedentId: string; category: DelegationCategory; ticketType: string; approvalId: string; requestKind: 'question' | 'action'; question: string; answer: string; kind?: string; by: Actor } }
  | { type: 'precedent.removed'; payload: { precedentId: string; by: Actor } }
  // A workspace setting the user changed: maxAgents, how many agents may run at once.
  | { type: 'workspace.setting'; payload: { key: WorkspaceSettingKey; value: number; by: Actor } }
  // What an agent decided itself, with its evidence: listed under "Decisions I made"; flagged ones are his at review.
  | { type: 'run.assumption'; payload: { runId: string; assumptionId: string; text: string; evidence: SourceRef[]; flag?: AssumptionFlag; by: 'agent' | 'review' } }
  // A task agent's result: a document (Markdown), a table (Markdown table) or code.
  | { type: 'task.delivered'; payload: { runId: string; deliverableId: string; kind: DeliverableKind; title: string; content: string; language?: string } }
  // An agent's request through a proxy, classified: kind is the action ("pr.ready", "kube.set_image"), environment where it
  // lands (dev, staging, integration, local, prod). decision: run (tier 0 or 1), grant (tier 2 under grantId), ask (tier 2,
  // approvalId), refuse (tier 3, or a request that could not be classified). Logged with run, agent and tier, since every
  // remote action runs under alex's own identity and the log is what tells them apart.
  // elfoqsy: a tier-2 request Elfoqsy decided under his delegation setting or one of his precedents.
  | { type: 'action.classified'; payload: { actionId: string; runId: string; toolUseId?: string; proxy: ProxyName; kind: string; tier: Tier; environment?: string; summary: string; decision: 'run' | 'grant' | 'ask' | 'refuse' | 'elfoqsy'; reason: string; grantId?: string; approvalId?: string; decisionId?: string } }
  // notSent: a remote write in a tester's run, logged as it would be and not sent.
  | { type: 'action.finished'; payload: { actionId: string; runId: string; ok: boolean; outputSummary: string; durationMs?: number; notSent?: true } }
  // What a write will change, recorded before it runs: target in plain words, before its earlier state. undo: the request
  // that puts it back, replayed through the same proxy and tier rules; noUndo: why there is none (its inverse is tier 3).
  | { type: 'change.recorded'; payload: { recordId: string; actionId: string; runId: string; environment?: string; target: string; before: string; undo?: { proxy: ProxyName; summary: string; request: Record<string, unknown> }; noUndo?: string } }
  | { type: 'change.undone'; payload: { recordId: string; actionId: string; by: Actor } }
  // "Allow for this ticket": the same kind of action, on the same ticket and in the same environment, runs without asking
  // until expiresAt (8 hours) or until the run ends.
  | { type: 'grant.created'; payload: { grantId: string; ticket: string; runId: string; kind: string; environment?: string; expiresAt: string; by: Actor; approvalId: string } }
  | { type: 'grant.ended'; payload: { grantId: string; reason: 'expired' | 'run_ended' } }
  // alex's AWS session, as the AWS CLI's token caches say (expiresAt only, never a token). expiring: under 20
  // minutes left, Elfoqsy has asked once for a refresh and runs needing AWS wait. Emitted on change.
  // One environment's AWS session, from an hourly sts call or an ExpiredToken error (older logs: one session, by its end).
  | { type: 'aws.session'; payload: { state: 'ok' | 'expiring' | 'expired' | 'unknown'; expiresAt?: string; environment?: string; profile?: string } }
  | { type: 'ci.status'; payload: { repo: string; pr: number; sha: string; status: 'queued' | 'running' | 'success' | 'failure'; url: string; runId?: string } }
  | { type: 'budget.exceeded'; payload: { runId: string; limit: 'time' | 'tokens' | 'cost'; value: number } }
  // Emitted only on change: 'unreachable' after 3 failed polls in a row (since = the first failure), 'ok' on the next success.
  | { type: 'sync.status'; payload: { source: 'jira' | 'github'; state: 'ok' | 'unreachable'; since: string; reason?: string } }
  // Claude (Alex's subscription) refused work: a usage or rate limit, or the login stopped working. New work pauses
  // until `until` (when known) or until Alex writes again; 'ok' when it resumes. Emitted only on change.
  | { type: 'usage.limit'; payload: { state: 'limited' | 'ok'; since: string; until?: string; reason?: string } }
  // Claude usage of Alex's plan, as percentages; resetsAt is when the 5-hour window resets.
  | { type: 'usage.status'; payload: { fiveHourPct: number; sevenDayPct: number; resetsAt?: string; sevenDayResetsAt?: string } }
  // role 'test': typed by a developer or coding agent testing the system. Never shown or treated as Alex's.
  // conversationId: the thread it belongs to (absent only in logs from before v1). blocks: what renders under the text.
  | { type: 'elfoqsy.message'; payload: { messageId: string; role: 'elfoqsy' | 'you' | 'test'; text: string; conversationId?: string; blocks?: MessageBlock[]; attachments?: Attachment[]; refs?: { tickets?: string[]; runId?: string; approvalId?: string } } }
  | { type: 'conversation.created'; payload: { conversationId: string; title: string; ticket?: string } }
  | { type: 'conversation.renamed'; payload: { conversationId: string; title: string; ticket?: string } }
  // A read-only investigator Elfoqsy starts herself; findings come back with sources and are saved to memory.
  | { type: 'investigation.started'; payload: { investigationId: string; conversationId: string; question: string; model: string; effort: Effort } }
  | { type: 'investigation.finished'; payload: { investigationId: string; conversationId: string; title: string; findings: Finding[]; filesRead?: number; tokens?: number; durationMs: number } }
  // A fact Elfoqsy can reuse, with its sources and how long it stays fresh.
  // A fact, or a rule confirmed from guidance (kind rule): for the repos it names, or all repos without them.
  // origin tester: confirmed by the tester; such a rule is kept but never given to a real run.
  | { type: 'memory.saved'; payload: { factId: string; statement: string; sources: SourceRef[]; freshUntil: string; origin: 'lookup' | 'investigator' | 'run' | 'you' | 'tester'; kind?: 'fact' | 'rule'; repos?: string[] } }
  // "Forget that rule": it leaves her memory and later runs; the log keeps it.
  | { type: 'memory.forgotten'; payload: { factId: string; by: Actor } }
  // A brief Elfoqsy writes when a planning conversation reaches agreement: started when she begins writing it
  // (she shows as thinking until it is created), created when it is done; handed_off when an agent starts from it.
  | { type: 'brief.started'; payload: { briefId: string; conversationId: string; ticket: string } }
  | { type: 'brief.created'; payload: { briefId: string; conversationId: string; ticket: string; title: string; sections: BriefSection[] } }
  | { type: 'brief.handed_off'; payload: { briefId: string; runId: string } }
  // The handoff replaces the brief: the ticket; his own messages, copied verbatim; his constraints, each from one of
  // his messages; facts, each with a source the agent can check; the mode and each repository's base. dropped: the facts
  // and messages the orchestrator left out, and why (no source, a conclusion, not his words).
  | {
      type: 'handoff.created';
      payload: {
        handoffId: string;
        conversationId: string;
        ticket: string;
        mode: RunMode;
        bases?: Record<string, string>;
        context: Array<{ messageId: string; role: 'you' | 'test'; text: string }>;
        constraints: Array<{ text: string; messageId: string }>;
        facts: Finding[];
        dropped?: Array<{ text: string; reason: string }>;
      };
    }
  | { type: 'handoff.handed_off'; payload: { handoffId: string; runId: string } }
  // alex's team-dev skill changed since the last version seen: the sections that changed. Elfoqsy says once that
  // the adapter (docs/skill-adapter.md) needs a review.
  | { type: 'skill.changed'; payload: { skill: string; hash: string; previous?: string; sections: string[] } }
  // A skill learned (written to data/skills and committed there): active at once, no approval. Its baselines are what the
  // same kind of task took before the skill existed: the median steps, and the mean failed calls and questions to
  // alex; source says where it was found.
  | { type: 'ability.learned'; payload: { name: string; version: number; title: string; titleVi: string; tool: AbilityTool; steps: AbilityStepView[]; finder: AbilityFinder; baselineSteps: number; baselineFailed: number; baselineQuestions: number; source: string } }
  // Where it came from, as its ability.json keeps it (part A): when it was found, how many cases of the friction measured its baseline, and what
  // those were (the episodes it was found in, or what happened in her own work). Logged beside ability.learned, and for the abilities learned
  // before it existed; the Abilities view says it in one line.
  | { type: 'ability.origin'; payload: { name: string; version: number; foundAt: string; cases: number; from: string } }
  // She was handed the abilities whose steps have a sample too long for a card's line, to write shorter (once for each: not asked again).
  | { type: 'ability.shorten_asked'; payload: { names: string[] } }
  // Its read steps run through the proxies (tier 0 only); steps with effects are never run, and stay unverified.
  | { type: 'ability.verified'; payload: { name: string; version: number; steps: Array<{ status: AbilityStepStatus; note?: string }> } }
  // A use: in a run (runId), or in Elfoqsy's conversation or an investigation (runId is then its id). Whether it worked,
  // and the steps, failed calls and questions to alex it took, against the skill's baselines.
  // From the traces, when they are kept (telemetry): what the use cost in model tokens (input, output, cache writes), cache
  // reads, and milliseconds, from its Skill call to its end.
  | { type: 'ability.used'; payload: { name: string; runId: string; in?: 'conversation' | 'investigation'; worked: boolean; steps: number; baselineSteps: number; failedCalls: number; baselineFailed: number; questions: number; baselineQuestions: number; tokens?: number; cacheRead?: number; ms?: number } }
  // A task it covers was done without it (its kind of calls, two or more, and the skill never loaded): a missed use.
  | { type: 'ability.missed'; payload: { name: string; runId: string; in?: 'conversation' | 'investigation'; steps: number } }
  // A step started failing: the card shows "needs re-check" until Elfoqsy has re-verified or repaired it.
  | { type: 'ability.needs_recheck'; payload: { name: string; version: number; step: number; reason: string } }
  // Elfoqsy rewrote it after a step failed: the new version's steps, then verified again.
  | { type: 'ability.repaired'; payload: { name: string; version: number; steps: AbilityStepView[]; reason: string } }
  // A ticket closed out after merge and QA: case.md regenerated from the log, QA notes and the solution page's
  // draft written to its ticket folder; pageRequested when publishing the page was asked (tier 2).
  | { type: 'ticket.closed_out'; payload: { ticket: string; qa: string; files: string[]; pageRequested?: true } }
  // Monday's review of the past week, posted as its own conversation.
  | { type: 'review.weekly'; payload: { weekOf: string; conversationId: string; metrics: Record<string, number>; suggestions: string[] } }
  // A recorded review computed again from the log, with different numbers: this revision supersedes the
  // current one, which stays in the log. Suggestions that rested on a changed number are withdrawn.
  // The orchestrator posts it in Elfoqsy's voice; no Claude turn.
  | { type: 'review.corrected'; payload: { weekOf: string; revision: number; metrics: Record<string, number>; suggestions: string[]; withdrawn: string[] } }
  // The live daemon started: from its last event before this to this, it was off. Analytics leave that time out.
  | { type: 'daemon.started'; payload: { mode: 'live' } }
  // The mirror of a repository, which run clones are hard-linked from, was checked with git fsck after a run. recreated: it was damaged
  // (by what a run did to its own object files) and has been made again from his clone and GitHub. problem: the last lines fsck said.
  | { type: 'mirror.checked'; payload: { repo: string; runId?: string; ok: boolean; recreated?: true; ms: number; problem?: string } }
  // A CI failure on an open PR acknowledged until the next CI result on that PR: it stops counting as
  // broken; the PR stays red on the map and in the ticket. Nothing reaches GitHub.
  | { type: 'ci.dismissed'; payload: { repo: string; pr: number; sha: string; by: Actor; reason?: string } }
  // The log is append-only: this re-marks a message already in it as a test message, not Alex's.
  | { type: 'elfoqsy.message_marked'; payload: { messageId: string; role: 'test'; note?: string } }
  // Her reply gave a cause no tool returned for something a tool dropped, rejected or changed: it went back to her once,
  // with what the tools did return, before anything was posted.
  | { type: 'elfoqsy.reply_corrected'; payload: { conversationId: string; invented: string[] } }
  // Her state changed: which of its three portraits both screens show (never the one she had last time).
  | { type: 'elfoqsy.look'; payload: { mood: Mood; variant: number } };
