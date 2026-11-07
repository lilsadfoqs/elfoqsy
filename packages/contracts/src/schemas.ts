// Zod schemas for every event payload in contracts/events.ts.
// contracts/events.ts stays the source of truth; check.ts fails the typecheck if these drift from it.
import { z } from 'zod';
import type { AbilityTool, ActivityTool, ElfEvent, EventEnvelope } from '../../../contracts/events';

export const sourceSchema = z.enum(['orchestrator', 'jira', 'github', 'agent', 'elfoqsy', 'simulator']);
export const ticketTypeSchema = z.enum(['Story', 'Task', 'Bug', 'Epic', 'Sub-task']);
export const ticketStatusSchema = z.enum(['To do', 'In progress', 'Blocked', 'Done', 'Released', 'Cancelled']);
export const jiraStatusCategorySchema = z.enum(['new', 'indeterminate', 'done']);
export const workflowStatusSchema = z.object({ name: z.string().min(1), category: jiraStatusCategorySchema });
export const jiraFieldRoleSchema = z.enum(['storyPoints', 'acceptanceCriteria', 'solution', 'impact', 'design', 'rootCause', 'failedAc', 'sprint', 'qaAssignee', 'reviewer', 'qaPoints', 'flagged', 'development']);
export const ABILITY_TOOLS = ['kubernetes', 'coralogix', 'github', 'aws', 'jira', 'confluence', 'docker', 'test', 'teams', 'outlook', 'sharepoint', 'onedrive', 'elfoqsy', 'other'] as const satisfies readonly AbilityTool[];
/** The tools an ability can be written about now: `other` is only what an older log holds (a card for no tool has no logo to show). */
export const WRITABLE_ABILITY_TOOLS = ABILITY_TOOLS.filter((t): t is Exclude<AbilityTool, 'other'> => t !== 'other') as unknown as readonly [Exclude<AbilityTool, 'other'>, ...Array<Exclude<AbilityTool, 'other'>>];
const abilityToolSchema = z.enum(ABILITY_TOOLS);
/** What an activity line of Elfoqsy's can reach: the names her tiles are picked by (the wire keeps a plain string, so an older log replays). */
export const ACTIVITY_TOOLS = ['jira', 'github', 'confluence', 'code', 'logs', 'agent', 'memory', 'workspace', 'kube', 'aws', 'outlook', 'teams', 'sharepoint', 'microsoft365'] as const satisfies readonly ActivityTool[];
const abilityStepSchema = z.object({ text: z.string().min(1), code: z.string().optional(), kind: z.enum(['read', 'effect', 'note']) });
const abilityFinderSchema = z.union([
  z.object({ by: z.literal('elfoqsy'), session: z.string().optional() }),
  z.object({ by: z.literal('agent'), agentNumber: z.number().int().min(1), runId: z.string().min(1), ticket: z.string().optional() }),
  z.object({ by: z.literal('alex') }),
]);
const jiraUserSchema = z.object({ accountId: z.string().optional(), displayName: z.string() });
const jiraFieldSchemaSchema = z.object({ type: z.string(), items: z.string().optional(), custom: z.string().optional(), system: z.string().optional() });
const jiraEditMetaSchema = z.object({
  required: z.boolean(),
  operations: z.array(z.string()),
  allowedValues: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), value: z.string().optional() })).optional(),
});
const jiraCommentSchema = z.object({ id: z.string().min(1), author: jiraUserSchema.optional(), created: z.string(), updated: z.string().optional(), body: z.unknown() });
const jiraChangeItemSchema = z.object({
  field: z.string(),
  fieldId: z.string().optional(),
  from: z.string().nullable().optional(),
  fromString: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
});
const jiraHistorySchema = z.object({ id: z.string().min(1), author: jiraUserSchema.optional(), created: z.string(), items: z.array(jiraChangeItemSchema) });
const jiraRemoteLinkSchema = z.object({ id: z.string().min(1), url: z.string(), title: z.string(), application: z.string().optional(), relationship: z.string().optional() });
const jiraFieldChangeSchema = z.object({ fieldId: z.string().min(1), name: z.string(), by: z.string(), at: z.string() });
const allowedValueSchema = z.object({ id: z.string().optional(), name: z.string().optional(), value: z.string().optional() });
export const jiraTransitionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  to: workflowStatusSchema,
  fields: z.array(z.object({ id: z.string().min(1), name: z.string(), required: z.boolean(), schema: jiraFieldSchemaSchema.optional(), allowedValues: z.array(allowedValueSchema).optional() })),
});
const linkSpecSchema = z.object({ linkType: z.string().min(1).max(80), direction: z.enum(['inward', 'outward']), other: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) });
export const ticketDraftSchema = z.object({
  project: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  type: z.string().min(1).max(60),
  summary: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional(),
  priority: z.string().max(40).optional(),
  storyPoints: z.number().nonnegative().optional(),
  sprint: z.object({ id: z.number().int(), name: z.string() }).optional(),
  labels: z.array(z.string().min(1).max(100)).max(20).optional(),
  links: z.array(linkSpecSchema).max(10).optional(),
  parent: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/).optional(),
});
export const jiraCreateFieldSchema = z.object({ id: z.string().min(1), name: z.string(), required: z.boolean(), schema: jiraFieldSchemaSchema.optional(), allowedValues: z.array(allowedValueSchema).optional() });
export const jiraChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('field'), fieldId: z.string().min(1).max(64), value: z.unknown(), base: z.unknown() }),
  z.object({ op: z.literal('transition'), transitionId: z.string().min(1).max(32), fields: z.record(z.string(), z.unknown()).optional() }),
  z.object({ op: z.literal('comment_add'), body: z.unknown() }),
  z.object({ op: z.literal('comment_edit'), commentId: z.string().min(1).max(32), body: z.unknown(), base: z.unknown() }),
  z.object({ op: z.literal('comment_delete'), commentId: z.string().min(1).max(32) }),
  z.object({ op: z.literal('link_add'), linkType: z.string().min(1).max(80), direction: z.enum(['inward', 'outward']), other: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) }),
  z.object({ op: z.literal('link_remove'), linkId: z.string().regex(/^\d+$/) }),
]);
export const prioritySchema = z.enum(['Blocker', 'Critical', 'Major', 'Minor']);
export const stepSchema = z.string().min(1).max(32);
export const planCheckSchema = z.object({
  id: z.string().min(1).max(32),
  description: z.string().min(1).max(160),
  proof: z.enum(['command', 'ci', 'approval']),
  command: z.string().min(1).max(300).optional(),
  repo: z.string().min(1).optional(),
  scope: z.enum(['code', 'external']).optional(),
});
export const checkStatusSchema = z.enum(['pending', 'passed', 'failed']);
export const stepOutcomeSchema = z.enum(['done', 'abandoned', 'failed']);
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const moodSchema = z.enum(['broken', 'needs', 'done', 'thinking', 'working', 'quiet']);
export const actorSchema = z.enum(['you', 'tester', 'elfoqsy', 'agent', 'orchestrator']);

export const paneIdSchema = z.enum(['sprint', 'elfoqsy', 'conversation', 'map', 'terminals']);
/**
 * A column is a stack of at most five panes; a screen is a row of columns. No pane appears twice across both screens; one that
 * appears on neither has been removed from the screens, and comes back through a + beside a pane, an empty screen's buttons or
 * the screen menu.
 */
export const layoutSchema = z
  .tuple([z.array(z.array(paneIdSchema).min(1).max(5)).max(5), z.array(z.array(paneIdSchema).min(1).max(5)).max(5)])
  .superRefine((layout, ctx) => {
    const seen = layout.flat(2);
    const twice = seen.filter((p, i) => seen.indexOf(p) !== i);
    if (twice.length) ctx.addIssue({ code: 'custom', message: `no pane twice; twice ${[...new Set(twice)].join(', ')}` });
  });
export const progressSchema = z.enum(['none', 'some', 'most', 'nearly']);
export const subagentOutcomeSchema = z.enum(['done', 'failed', 'cancelled']);
export const sourceRefSchema = z.object({
  kind: z.enum(['code', 'ticket', 'pr', 'log', 'doc', 'url', 'memory', 'decision', 'precedent', 'setting']),
  ref: z.string().min(1),
  label: z.string().optional(),
});
export const findingSchema = z.object({ text: z.string().min(1), sources: z.array(sourceRefSchema) });
export const chainLinkSchema = z.object({ ref: z.string().min(1), role: z.enum(['entry', 'hop', 'fault']), note: z.string().optional() });
export const alternativeSchema = z.object({ option: z.string().min(1), rejectedBecause: z.string().min(1) });
export const pushedRepoSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  commits: z.array(z.object({ sha: z.string().min(1), subject: z.string() })),
  files: z.array(z.object({ path: z.string().min(1), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })),
});
export const messageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ticket'), ref: z.string().min(1) }),
  z.object({ type: z.literal('findings'), ref: z.string().min(1) }),
  z.object({ type: z.literal('progress'), ref: z.string().min(1) }),
  z.object({ type: z.literal('sprint'), ref: z.string().min(1) }),
  z.object({ type: z.literal('approval'), ref: z.string().min(1) }),
  z.object({ type: z.literal('brief'), ref: z.string().min(1) }),
  z.object({ type: z.literal('handoff'), ref: z.string().min(1) }),
  z.object({ type: z.literal('verdict'), ref: z.string().min(1) }),
  z.object({ type: z.literal('review'), ref: z.string().min(1) }),
  z.object({ type: z.literal('decision'), ref: z.string().min(1) }),
  z.object({ type: z.literal('digest'), ref: z.string().min(1) }),
  z.object({ type: z.literal('deliverable'), ref: z.string().min(1) }),
  z.object({ type: z.literal('draft'), ref: z.string().min(1) }),
  z.object({ type: z.literal('jira_news'), ref: z.string().min(1) }),
  z.object({ type: z.literal('narrative'), ref: z.string().min(1), section: z.union([z.literal(2), z.literal(7)]) }),
  z.object({ type: z.literal('ability'), ref: z.string().min(1) }),
  z.object({
    type: z.literal('code'),
    content: z.string(),
    language: z.string().optional(),
    diff: z.boolean().optional(),
    path: z.string().min(1).max(300).optional(),
    startLine: z.number().int().positive().optional(),
    highlight: z.array(z.number().int().positive()).max(200).optional(),
  }),
]);
export const briefSectionSchema = z.object({ heading: z.string().min(1), markdown: z.string() });
export const runModeSchema = z.enum(['normal', 'read_only', 'hotfix', 'remediation']);
export const verdictSchema = z.enum(['VALID', 'ALREADY_FIXED', 'EXPECTED_BEHAVIOR/INVALID', 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED', 'NEW_BEHAVIOR', 'VALID_FINDING']);
export const attachmentSchema = z.object({
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export const tierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const proxySchema = z.enum(['git', 'gh', 'kube', 'aws', 'jira', 'confluence', 'logs', 'file', 'docker', 'shop', 'web']);
export const runStateSchema = z.enum(['queued', 'running', 'waiting_for_you', 'failed', 'succeeded', 'stopped', 'cancelled']);
export const delegationCategorySchema = z.enum([
  'run_folder',
  'sourced_answer',
  'ci_rerun',
  'harness_kube',
  'harness_image',
  'unsourced',
  'notify_people',
  'staging_write',
  'read_secret',
  'prod_logs',
  'irreversible',
  'jira_fill',
  'other',
]);
export const delegationSettingSchema = z.enum(['decide', 'decide_and_tell', 'ask']);
export const questionCardSchema = z.object({
  question: z.string().min(1),
  why: z.array(z.string().min(1)),
  options: z.array(z.object({ label: z.string().min(1), consequence: z.string() })),
  recommendation: z.string().min(1),
  sources: z.array(sourceRefSchema),
});
export const deliverableKindSchema = z.enum(['document', 'table', 'code']);
export const taskSpecSchema = z.object({ name: z.string().min(1), goal: z.string().min(1), deliverable: deliverableKindSchema });
export const assumptionFlagSchema = z.enum(['contract', 'cache_bypass', 'teammate_code', 'expected_behaviour']);

const id = z.string().min(1);

export const ticketSchema = z.object({
  key: id,
  board: z.string(),
  summary: z.string(),
  type: ticketTypeSchema,
  status: ticketStatusSchema,
  priority: prioritySchema,
  storyPoints: z.number().nonnegative().nullable(),
  sprint: z.string(),
  sprintsCarried: z.number().int().nonnegative(),
  epic: z.string().nullable(),
  reporter: z.string(),
  created: z.string(),
  updated: z.string(),
  labels: z.array(z.string()),
  linked: z.array(z.string()),
  description: z.string(),
  workflowStatus: workflowStatusSchema.optional(),
  assignee: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const pullRequestSchema = z.object({
  repo: id,
  number: z.number().int().positive(),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  ticket: id,
  url: z.string(),
  checks: z.enum(['none', 'pending', 'success', 'failure']),
  title: z.string().optional(),
  review: z.enum(['none', 'approved', 'changes_requested', 'review_required']).optional(),
});

/** Each workspace setting's range: how many agents may work at once. */
export const SETTING_RANGES = { maxAgents: [1, 20] } as const;

export const payloadSchemas = {
  'ticket.synced': z.object({ ticket: ticketSchema }),
  'ticket.removed': z.object({ key: id }),
  'ticket.detail': z.object({
    key: id,
    id,
    full: z.literal(true).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    removed: z.array(z.string()).optional(),
    names: z.record(z.string(), z.string()).optional(),
    schema: z.record(z.string(), jiraFieldSchemaSchema).optional(),
    editmeta: z.record(z.string(), jiraEditMetaSchema).optional(),
    comments: z.array(jiraCommentSchema).optional(),
    history: z.array(jiraHistorySchema).optional(),
    remoteLinks: z.array(jiraRemoteLinkSchema).optional(),
    confluence: z.record(z.string(), z.string()).optional(),
    locked: z.array(z.string()).optional(),
    changes: z.array(jiraFieldChangeSchema).optional(),
    updated: z.string(),
    fetchedAt: z.iso.datetime(),
  }),
  'ticket.unreadable': z.object({ key: id, reason: z.string().min(1) }),
  'jira.options': z.object({
    project: id,
    me: jiraUserSchema,
    users: z.array(jiraUserSchema),
    sprints: z.array(z.object({ id: z.number().int(), name: z.string(), state: z.string(), goal: z.string().optional() })),
    linkTypes: z.array(z.object({ id: z.string(), name: z.string(), inward: z.string(), outward: z.string() })),
    labels: z.array(z.string()),
    fetchedAt: z.iso.datetime(),
  }),
  'ticket.transitions': z.object({ key: id, transitions: z.array(jiraTransitionSchema) }),
  'jira.edited': z.object({
    editId: z.string().optional(),
    key: id,
    by: actorSchema,
    what: z.enum(['field', 'transition', 'comment_add', 'comment_edit', 'comment_delete', 'link_add', 'link_remove']),
    fieldId: z.string().optional(),
    ok: z.boolean(),
    error: z.string().optional(),
    actionId: z.string().optional(),
    recordId: z.string().optional(),
    runId: z.string().optional(),
  }),
  'jira.edit_conflict': z.object({ editId: id, key: id, fieldId: id, theirs: z.unknown(), by: z.string().optional(), at: z.string().optional() }),
  'ticket.drafted': z.object({ draftId: id, by: actorSchema, runId: z.string().optional(), conversationId: z.string().optional(), draft: ticketDraftSchema }),
  'ticket.draft_closed': z.object({ draftId: id, how: z.enum(['created', 'discarded']), key: z.string().optional(), by: actorSchema }),
  'ticket.createmeta': z.object({ project: id, types: z.array(z.object({ id: id, name: z.string(), subtask: z.boolean() })), typeId: z.string().optional(), fields: z.array(jiraCreateFieldSchema).optional() }),
  'ticket.created': z.object({ createId: id, key: id, draftId: z.string().optional(), checks: z.object({ links: z.boolean().optional(), sprint: z.boolean().optional(), parent: z.boolean().optional() }) }),
  'ticket.create_failed': z.object({ createId: id, error: z.string().min(1) }),
  'jira.news': z.object({
    newsId: id,
    since: z.iso.datetime(),
    conversationId: id,
    items: z.array(z.object({ kind: z.enum(['mention', 'transition', 'comment', 'change']), who: z.string(), what: z.string(), key: id, at: z.string() })),
  }),
  'ticket.search': z.object({
    query: z.string(),
    results: z.array(z.object({ key: id, summary: z.string(), type: z.string(), status: workflowStatusSchema, inSprint: z.boolean(), sprint: z.string().optional() })),
  }),
  'jira.fields': z.object({
    fields: z.partialRecord(jiraFieldRoleSchema, z.object({ name: z.string(), id: z.string() })),
    moved: z.array(z.object({ role: jiraFieldRoleSchema, name: z.string(), from: z.string(), to: z.string() })),
    missing: z.array(z.object({ role: jiraFieldRoleSchema, name: z.string(), id: z.string() })),
  }),
  'pr.synced': z.object({ pr: pullRequestSchema }),
  'run.created': z.object({
    runId: id,
    ticket: id,
    worktree: z.string(),
    branch: z.string(),
    agentNumber: z.number().int().positive(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    briefId: id.optional(),
    handoffId: id.optional(),
    mode: runModeSchema.optional(),
    bases: z.record(z.string(), z.string().min(1)).optional(),
    conversationId: id.optional(),
    budget: z.object({ tokens: z.number().int().positive(), minutes: z.number().positive() }).optional(),
    // The repositories it works in, for rules scoped to a repo.
    repos: z.array(id).optional(),
    test: z.literal(true).optional(),
    startedFrom: id.optional(),
    task: taskSpecSchema.optional(),
  }),
  'run.goal_declared': z.object({ runId: id, revision: z.number().int().positive(), goal: z.string().min(1), checks: z.array(planCheckSchema) }),
  'run.step_begun': z.object({ runId: id, stepIndex: z.number().int().nonnegative(), name: stepSchema, why: z.string() }),
  'run.step_ended': z.object({ runId: id, stepIndex: z.number().int().nonnegative(), outcome: stepOutcomeSchema, note: z.string().optional() }),
  'run.check_changed': z.object({ runId: id, checkId: z.string().min(1), status: checkStatusSchema, evidence: z.string() }),
  'run.heartbeat': z.object({
    runId: id,
    step: stepSchema,
    sinceLast: z.string(),
    next: z.string(),
    progress: progressSchema,
    risks: z.array(z.string()),
    tokens: z.number().int().nonnegative(),
    workingSeconds: z.number().nonnegative(),
  }),
  'run.ack': z.object({ runId: id, refEventSeq: z.number().int().positive(), note: z.string().optional() }),
  'run.flag': z.object({ runId: id, kind: z.enum(['missed_heartbeats', 'loop', 'budget', 'replan']), detail: z.string() }),
  'run.paused': z.object({ runId: id, by: actorSchema, reason: z.string().optional() }),
  'run.resumed': z.object({ runId: id, by: actorSchema, reason: z.string().optional() }),
  'run.guidance': z.object({ runId: id, text: z.string().min(1), by: actorSchema }),
  'run.reminded': z.object({ runId: id, about: z.enum(['heartbeat', 'replan']), text: z.string().min(1) }),
  'run.dismissed': z.object({ runId: id, by: actorSchema, reason: z.string().max(300).optional() }),
  'run.folder_removed': z.object({ runId: id, folder: z.string().min(1), reason: z.string().min(1) }),
  'run.usage': z.object({ runId: id, tokens: z.number().int().nonnegative(), workingSeconds: z.number().nonnegative() }),
  'run.state_changed': z.object({ runId: id, state: runStateSchema, reason: z.string().optional() }),
  'run.note': z.object({ runId: id, text: z.string() }),
  'subagent.started': z.object({
    runId: id,
    subagentId: id,
    parentToolUseId: id.optional(),
    model: z.string().min(1),
    effort: effortSchema,
    task: z.string(),
  }),
  'subagent.tool_called': z.object({
    runId: id,
    subagentId: id,
    toolUseId: id.optional(),
    tool: z.string().min(1),
    inputSummary: z.string(),
    outputSummary: z.string(),
    ok: z.boolean(),
    stats: z.string().optional(),
  }),
  'subagent.finished': z.object({
    runId: id,
    subagentId: id,
    outcome: subagentOutcomeSchema,
    by: actorSchema.optional(),
    reason: z.string().optional(),
    result: z.string(),
    tokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
  'tool.called': z.object({
    runId: id.optional(),
    subagentId: id.optional(),
    toolUseId: id.optional(),
    tool: z.string(),
    title: z.string().optional(),
    where: z.string().optional(),
    inputSummary: z.string(),
    allowed: z.boolean(),
    outside: z.string().optional(),
  }),
  'tool.finished': z.object({
    runId: id,
    toolUseId: id,
    ok: z.boolean(),
    outputSummary: z.string(),
    stats: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    diff: z
      .object({ hunks: z.array(z.object({ oldStart: z.number().int().nonnegative(), newStart: z.number().int().nonnegative(), lines: z.array(z.string()) })).max(20) })
      .optional(),
  }),
  'run.thought': z.object({ runId: id, subagentId: id.optional(), text: z.string().min(1) }),
  'run.verdict': z.object({
    runId: id,
    verdict: verdictSchema,
    reproduced: z.boolean(),
    summary: z.string().min(1),
    evidence: z.array(sourceRefSchema).optional(),
    symptom: z.string().optional(),
    sibling: z.string().optional(),
    example: z.object({ input: z.string().min(1), output: z.string().min(1) }).optional(),
    ticketComment: z.string().optional(),
    findings: z.array(findingSchema).optional(),
    chain: z.array(chainLinkSchema).optional(),
    siblingAt: sourceRefSchema.optional(),
  }),
  'run.understanding': z.object({ runId: id, claim: z.string().min(1), input: z.string().min(1), actual: z.string().min(1), expected: z.string().min(1), sources: z.array(sourceRefSchema) }),
  'run.reproduction': z.object({
    runId: id,
    how: z.string().min(1),
    environment: z.string().min(1),
    test: z.object({ path: z.string().min(1), name: z.string().min(1) }).optional(),
    command: z.string().optional(),
    requestIds: z.array(z.string().min(1)).optional(),
  }),
  'run.root_cause': z.object({ runId: id, text: z.string().min(1), lines: z.array(sourceRefSchema) }),
  'run.approach': z.object({ runId: id, approach: z.string().min(1), alternatives: z.array(alternativeSchema) }),
  'run.test_run': z.object({
    runId: id,
    subagentId: id.optional(),
    toolUseId: id,
    command: z.string().min(1),
    ok: z.boolean(),
    durationMs: z.number().nonnegative().optional(),
    summary: z.string(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    failedNames: z.array(z.string()).optional(),
  }),
  'run.pushed': z.object({ runId: id, repos: z.array(pushedRepoSchema).min(1) }),
  'run.reported': z.object({
    runId: id,
    result: z.enum(['succeeded', 'failed', 'blocked']),
    summary: z.string().min(1),
    notVerified: z.array(z.string().min(1)),
    waitingOnYou: z.array(z.string().min(1)),
    unmet: z.array(z.object({ n: z.number().int().min(1), why: z.string().min(1) })).optional(),
  }),
  'run.criteria_reviewed': z.object({
    runId: id,
    criteria: z.array(z.object({ n: z.number().int().min(1), status: z.enum(['met', 'not_met', 'cannot_tell']), text: z.string().min(1), why: z.string() })),
  }),
  'run.handed_back': z.object({ runId: id, message: z.string().min(1) }),
  'narrative.read': z.object({ runId: id, ticket: id, by: actorSchema }),
  'layout.changed': z.object({ layout: layoutSchema.nullable(), by: actorSchema }),
  'run.inputs_declared': z.object({ runId: id, classes: z.array(z.string().min(1)).min(1) }),
  'run.hypothesis': z.object({ runId: id, hypothesisId: id, text: z.string().min(1), status: z.enum(['open', 'confirmed', 'disproved']), evidence: z.array(sourceRefSchema).optional() }),
  'run.finding': z.object({
    runId: id,
    findingId: id,
    summary: z.string().min(1),
    evidence: z.array(sourceRefSchema),
    proposedTicket: z.object({ summary: z.string().min(1), description: z.string() }),
  }),
  'run.skill_snapshot': z.object({ runId: id, hash: z.string().min(1), files: z.number().int().nonnegative() }),
  'elfoqsy.activity': z.object({ conversationId: id, activityId: id, tool: z.string().min(1), text: z.string().min(1), state: z.enum(['running', 'done', 'failed']) }),
  'approval.requested': z.object({
    approvalId: id,
    runId: id,
    kind: z.enum(['push', 'pr', 'github', 'command', 'check', 'jira_write', 'outside_worktree', 'network', 'question', 'action', 'example', 'decision', 'round']),
    question: z.string(),
    action: z.string().optional(),
    options: z.array(z.string()).optional(),
    tier: tierSchema.optional(),
    grantable: z.object({ kind: id, environment: id.optional() }).optional(),
    batchId: id.optional(),
    card: questionCardSchema.optional(),
    category: delegationCategorySchema.optional(),
    suggestion: z.object({ option: z.string().min(1), why: z.string(), sources: z.array(sourceRefSchema) }).optional(),
    noSuggestion: z.string().optional(),
    precedentable: z.literal(true).optional(),
    requestId: id.optional(),
    gate: z.literal('narrative').optional(),
  }),
  'approval.resolved': z.object({
    approvalId: id,
    decision: z.enum(['approved', 'denied', 'answered']),
    answer: z.string().optional(),
    test: z.literal(true).optional(),
    scope: z.enum(['once', 'ticket']).optional(),
    withdrawn: z.literal(true).optional(),
    precedent: z.literal(true).optional(),
  }),
  'decision.considering': z.object({ requestId: id, runId: id, requestKind: z.enum(['question', 'action']), summary: z.string().min(1) }),
  'decision.made': z.object({
    decisionId: id,
    requestId: id,
    runId: id,
    requestKind: z.enum(['question', 'action']),
    category: delegationCategorySchema,
    summary: z.string().min(1),
    question: z.string().optional(),
    options: z.array(z.string()).optional(),
    answer: z.string(),
    sources: z.array(sourceRefSchema),
    basis: z.enum(['sources', 'delegation', 'precedent']),
    told: z.boolean(),
    actionId: id.optional(),
    lang: z.literal('vi').optional(),
  }),
  'decision.changed': z.object({ decisionId: id, by: actorSchema, how: z.enum(['changed', 'undone']), to: z.string().optional() }),
  'decisions.digested': z.object({ digestId: id, conversationId: id, decisionIds: z.array(id).min(1), awaySince: z.iso.datetime(), asked: z.literal(true).optional(), test: z.literal(true).optional(), lang: z.literal('vi').optional() }),
  'delegation.set': z.object({ category: delegationCategorySchema, setting: delegationSettingSchema, by: actorSchema }),
  'precedent.saved': z.object({
    precedentId: id,
    category: delegationCategorySchema,
    ticketType: z.string().min(1),
    approvalId: id,
    requestKind: z.enum(['question', 'action']),
    question: z.string().min(1),
    answer: z.string(),
    kind: z.string().optional(),
    by: actorSchema,
  }),
  'precedent.removed': z.object({ precedentId: id, by: actorSchema }),
  'workspace.setting': z
    .object({ key: z.enum(['maxAgents']), value: z.number().int(), by: actorSchema })
    .superRefine((p, ctx) => {
      const [min, max] = SETTING_RANGES[p.key];
      if (p.value < min || p.value > max) ctx.addIssue({ code: 'custom', path: ['value'], message: `${p.key} is from ${min} to ${max}` });
    }),
  'run.assumption': z.object({ runId: id, assumptionId: id, text: z.string().min(1), evidence: z.array(sourceRefSchema), flag: assumptionFlagSchema.optional(), by: z.enum(['agent', 'review']) }),
  'task.delivered': z.object({ runId: id, deliverableId: id, kind: deliverableKindSchema, title: z.string().min(1), content: z.string(), language: z.string().optional() }),
  'action.classified': z.object({
    actionId: id,
    runId: id,
    toolUseId: id.optional(),
    proxy: proxySchema,
    kind: id,
    tier: tierSchema,
    environment: id.optional(),
    summary: z.string(),
    decision: z.enum(['run', 'grant', 'ask', 'refuse', 'elfoqsy']),
    reason: z.string(),
    grantId: id.optional(),
    approvalId: id.optional(),
    decisionId: id.optional(),
  }),
  'action.finished': z.object({ actionId: id, runId: id, ok: z.boolean(), outputSummary: z.string(), durationMs: z.number().nonnegative().optional(), notSent: z.literal(true).optional() }),
  'change.recorded': z.object({
    recordId: id,
    actionId: id,
    runId: id,
    environment: id.optional(),
    target: z.string().min(1),
    before: z.string(),
    undo: z.object({ proxy: proxySchema, summary: z.string().min(1), request: z.record(z.string(), z.unknown()) }).optional(),
    noUndo: z.string().optional(),
  }),
  'change.undone': z.object({ recordId: id, actionId: id, by: actorSchema }),
  'grant.created': z.object({
    grantId: id,
    ticket: id,
    runId: id,
    kind: id,
    environment: id.optional(),
    expiresAt: z.iso.datetime(),
    by: actorSchema,
    approvalId: id,
  }),
  'grant.ended': z.object({ grantId: id, reason: z.enum(['expired', 'run_ended']) }),
  'aws.session': z.object({ state: z.enum(['ok', 'expiring', 'expired', 'unknown']), expiresAt: z.iso.datetime().optional(), environment: id.optional(), profile: id.optional() }),
  'ci.status': z.object({
    repo: id,
    pr: z.number().int().positive(),
    sha: z.string(),
    status: z.enum(['queued', 'running', 'success', 'failure']),
    url: z.string(),
    runId: id.optional(),
  }),
  'budget.exceeded': z.object({ runId: id, limit: z.enum(['time', 'tokens', 'cost']), value: z.number() }),
  'usage.limit': z.object({
    state: z.enum(['limited', 'ok']),
    since: z.iso.datetime(),
    until: z.iso.datetime().optional(),
    reason: z.string().optional(),
  }),
  'sync.status': z.object({
    source: z.enum(['jira', 'github']),
    state: z.enum(['ok', 'unreachable']),
    since: z.iso.datetime(),
    reason: z.string().optional(),
  }),
  'usage.status': z.object({
    fiveHourPct: z.number().min(0).max(100),
    sevenDayPct: z.number().min(0).max(100),
    resetsAt: z.iso.datetime().optional(),
    sevenDayResetsAt: z.iso.datetime().optional(),
  }),
  'elfoqsy.message': z.object({
    messageId: id,
    role: z.enum(['elfoqsy', 'you', 'test']),
    text: z.string(),
    conversationId: id.optional(),
    blocks: z.array(messageBlockSchema).optional(),
    attachments: z.array(attachmentSchema).optional(),
    refs: z
      .object({
        tickets: z.array(z.string()).optional(),
        runId: id.optional(),
        approvalId: id.optional(),
      })
      .optional(),
  }),
  'elfoqsy.message_marked': z.object({ messageId: id, role: z.literal('test'), note: z.string().optional() }),
  'elfoqsy.look': z.object({ mood: moodSchema, variant: z.number().int().min(0).max(2) }),
  'conversation.created': z.object({ conversationId: id, title: z.string().min(1), ticket: id.optional() }),
  'conversation.renamed': z.object({ conversationId: id, title: z.string().min(1), ticket: id.optional() }),
  'investigation.started': z.object({ investigationId: id, conversationId: id, question: z.string().min(1), model: z.string().min(1), effort: effortSchema }),
  'investigation.finished': z.object({
    investigationId: id,
    conversationId: id,
    title: z.string().min(1),
    findings: z.array(findingSchema),
    filesRead: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
  }),
  'memory.saved': z.object({
    factId: id,
    statement: z.string().min(1),
    sources: z.array(sourceRefSchema),
    freshUntil: z.iso.datetime(),
    origin: z.enum(['lookup', 'investigator', 'run', 'you', 'tester']),
    kind: z.enum(['fact', 'rule']).optional(),
    repos: z.array(id).optional(),
  }),
  'memory.forgotten': z.object({ factId: id, by: actorSchema }),
  'brief.started': z.object({ briefId: id, conversationId: id, ticket: id }),
  'brief.created': z.object({ briefId: id, conversationId: id, ticket: id, title: z.string().min(1), sections: z.array(briefSectionSchema).min(1) }),
  'brief.handed_off': z.object({ briefId: id, runId: id }),
  'handoff.created': z.object({
    handoffId: id,
    conversationId: id,
    ticket: id,
    mode: runModeSchema,
    bases: z.record(z.string(), z.string().min(1)).optional(),
    context: z.array(z.object({ messageId: id, role: z.enum(['you', 'test']), text: z.string() })),
    constraints: z.array(z.object({ text: z.string().min(1), messageId: id })),
    facts: z.array(findingSchema),
    dropped: z.array(z.object({ text: z.string(), reason: z.string() })).optional(),
  }),
  'handoff.handed_off': z.object({ handoffId: id, runId: id }),
  'skill.changed': z.object({ skill: id, hash: id, previous: id.optional(), sections: z.array(z.string()) }),
  'ability.learned': z.object({ name: id, version: z.number().int().min(1), title: z.string().min(1), titleVi: z.string().min(1), tool: abilityToolSchema, steps: z.array(abilityStepSchema).min(1), finder: abilityFinderSchema, baselineSteps: z.number().min(0), baselineFailed: z.number().min(0), baselineQuestions: z.number().min(0), source: z.string() }),
  'ability.shorten_asked': z.object({ names: z.array(id).min(1) }),
  'ability.origin': z.object({ name: id, version: z.number().int().min(1), foundAt: z.string().min(1), cases: z.number().min(0), from: z.string() }),
  'ability.verified': z.object({ name: id, version: z.number().int().min(1), steps: z.array(z.object({ status: z.enum(['ok', 'failed', 'unverified']), note: z.string().optional() })) }),
  'ability.used': z.object({
    name: id,
    runId: id,
    in: z.enum(['conversation', 'investigation']).optional(),
    worked: z.boolean(),
    steps: z.number().int().min(0),
    baselineSteps: z.number().min(0),
    failedCalls: z.number().int().min(0),
    baselineFailed: z.number().min(0),
    questions: z.number().int().min(0),
    baselineQuestions: z.number().min(0),
    tokens: z.number().int().min(0).optional(),
    cacheRead: z.number().int().min(0).optional(),
    ms: z.number().int().min(0).optional(),
  }),
  'ability.missed': z.object({ name: id, runId: id, in: z.enum(['conversation', 'investigation']).optional(), steps: z.number().int().min(0) }),
  'ability.needs_recheck': z.object({ name: id, version: z.number().int().min(1), step: z.number().int().min(0), reason: z.string() }),
  'ability.repaired': z.object({ name: id, version: z.number().int().min(1), steps: z.array(abilityStepSchema).min(1), reason: z.string() }),
  'elfoqsy.reply_corrected': z.object({ conversationId: id, invented: z.array(z.string()) }),
  'ticket.closed_out': z.object({ ticket: id, qa: z.string(), files: z.array(z.string()), pageRequested: z.literal(true).optional() }),
  'daemon.started': z.object({ mode: z.literal('live') }),
  'mirror.checked': z.object({ repo: z.string().min(1), runId: id.optional(), ok: z.boolean(), recreated: z.literal(true).optional(), ms: z.number().nonnegative(), problem: z.string().optional() }),
  'ci.dismissed': z.object({ repo: id, pr: z.number().int().positive(), sha: z.string(), by: actorSchema, reason: z.string().max(300).optional() }),
  'review.weekly': z.object({ weekOf: z.string().min(1), conversationId: id, metrics: z.record(z.string(), z.number()), suggestions: z.array(z.string()) }),
  'review.corrected': z.object({
    weekOf: z.string().min(1),
    revision: z.number().int().min(2),
    metrics: z.record(z.string(), z.number()),
    suggestions: z.array(z.string()),
    withdrawn: z.array(z.string()),
  }),
} as const;

export type EventType = ElfEvent['type'];
export type PayloadOf<T extends EventType> = Extract<ElfEvent, { type: T }>['payload'];
/** EventEnvelope as a discriminated union: checking `type` narrows `payload`. */
export type AnyEnvelope = { [K in EventType]: EventEnvelope<K> }[EventType];

export const EVENT_TYPES = Object.keys(payloadSchemas) as EventType[];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(payloadSchemas, type);
}

/** Validates a payload for its event type. Unknown keys are stripped. Throws a ZodError when invalid. */
export function parsePayload<T extends EventType>(type: T, payload: unknown): PayloadOf<T> {
  return payloadSchemas[type].parse(payload) as PayloadOf<T>;
}

const envelopeBase = z.object({
  seq: z.number().int().positive(),
  id,
  ts: z.iso.datetime(),
  source: sourceSchema,
  type: z.string(),
  payload: z.unknown(),
});

/** Validates a whole envelope, including its payload against the schema for its type. */
export function parseEnvelope(value: unknown): EventEnvelope {
  const base = envelopeBase.parse(value);
  if (!isEventType(base.type)) throw new Error(`Unknown event type: ${base.type}`);
  return { ...base, type: base.type, payload: parsePayload(base.type, base.payload) } as EventEnvelope;
}
