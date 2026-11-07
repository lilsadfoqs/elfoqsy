import { describe, expect, it } from 'vitest';
import type { ElfEvent, Ticket } from '../src';
import { EVENT_TYPES, clientFrameSchema, intentSchema, layoutSchema, parseEnvelope, parsePayload } from '../src';

const ticket: Ticket = {
  key: 'SHOP-3546',
  board: 'SHOP',
  summary: 'Payment provider errors are dropped',
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 2,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 1,
  epic: null,
  reporter: 'Quinn Bauer',
  created: '8 Oct 2026',
  updated: '8 Oct 2026',
  labels: ['payments'],
  linked: ['CORE-18891'],
  description: 'Lift error_code and error_details.',
};

// One valid example of every event type. Typed against ElfEvent, so it also keeps up with contracts/events.ts.
const examples: { [K in ElfEvent['type']]: Extract<ElfEvent, { type: K }>['payload'] } = {
  'ticket.synced': { ticket },
  'ticket.removed': { key: 'SHOP-3546' },
  'ticket.detail': {
    key: 'SHOP-3538',
    id: '2668210',
    full: true,
    fields: { summary: 'Inventory Sync Worker', priority: { name: 'Blocker', id: '1' } },
    names: { summary: 'Summary', priority: 'Priority' },
    schema: { summary: { type: 'string', system: 'summary' } },
    editmeta: { summary: { required: true, operations: ['set'] } },
    comments: [{ id: '1', author: { displayName: 'Quinn Bauer' }, created: '2026-10-08T10:00:00.000+0700', body: { type: 'doc', version: 1, content: [] } }],
    history: [{ id: '9', author: { displayName: 'Quinn Bauer' }, created: '2026-10-08T10:00:00.000+0700', items: [{ field: 'priority', fromString: 'Major', toString: 'Blocker' }] }],
    remoteLinks: [{ id: '5', url: 'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=1', title: 'Checkout V2 :: Planning', application: 'com.atlassian.confluence', relationship: 'mentioned in' }],
    confluence: { '7340041': 'Release/2.22.0' },
    locked: [],
    changes: [{ fieldId: 'priority', name: 'Priority', by: 'Quinn Bauer', at: '2026-10-08T10:00:00.000+0700' }],
    updated: '2026-10-12T19:01:25.426-0700',
    fetchedAt: '2026-10-14T07:00:00.000Z',
  },
  'ticket.unreadable': { key: 'SHOP-9999', reason: 'Jira says it does not exist or you cannot see it.' },
  'jira.fields': { fields: { storyPoints: { name: 'Story point estimate', id: 'customfield_16486' } }, moved: [], missing: [] },
  'jira.options': {
    project: 'SHOP',
    me: { accountId: 'acc-me', displayName: 'Alex Rivera' },
    users: [{ accountId: 'acc-1', displayName: 'Quinn Bauer' }],
    sprints: [{ id: 33774, name: 'SHOP Sprint 52', state: 'active', goal: 'Release Manager: Morgan Diaz' }],
    linkTypes: [{ id: '10402', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    labels: ['checkout-v2'],
    fetchedAt: '2026-10-14T07:00:00.000Z',
  },
  'ticket.transitions': { key: 'SHOP-3538', transitions: [{ id: '11', name: 'Start analysis', to: { name: 'IN ANALYZE', category: 'indeterminate' }, fields: [{ id: 'resolution', name: 'Resolution', required: true, allowedValues: [{ id: '1', name: 'Done' }] }] }] },
  'jira.edited': { editId: 'e1', key: 'SHOP-3538', by: 'you', what: 'field', fieldId: 'customfield_16727', ok: true },
  'jira.edit_conflict': { editId: 'e1', key: 'SHOP-3538', fieldId: 'customfield_16727', theirs: { type: 'doc', version: 1, content: [] }, by: 'Quinn Bauer', at: '2026-10-14T14:20:00.000+0700' },
  'ticket.drafted': { draftId: 'd1', by: 'agent', runId: 'r6', conversationId: 'c1', draft: { project: 'SHOP', type: 'Bug', summary: 'Inventory sync: reconcile job misses holds released mid-commit', description: 'When the worker dies between delete and ledger update, the reconcile job sees no leftover.', priority: 'Major', storyPoints: 3, sprint: { id: 33774, name: 'SHOP Sprint 52' }, labels: ['checkout-v2'], links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }] } },
  'ticket.draft_closed': { draftId: 'd1', how: 'created', key: 'SHOP-3601', by: 'you' },
  'ticket.createmeta': { project: 'SHOP', types: [{ id: '10004', name: 'Bug', subtask: false }], typeId: '10004', fields: [{ id: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } }] },
  'ticket.created': { createId: 'c1', key: 'SHOP-3601', draftId: 'd1', checks: { links: true, sprint: true } },
  'ticket.create_failed': { createId: 'c2', error: 'Summary is required.' },
  'jira.news': { newsId: 'n1', since: '2026-10-14T02:12:00.000Z', conversationId: 'c1', items: [{ kind: 'mention', who: 'Quinn Bauer', what: 'mentioned you in', key: 'SHOP-3559', at: '2026-10-14T10:41:00.000+0700' }] },
  'ticket.search': { query: 'temporary store', results: [{ key: 'SHOP-3537', summary: 'Initialize Acme Shop temporary file store', type: 'Story', status: { name: 'OPEN', category: 'new' }, inSprint: true, sprint: 'SHOP Sprint 52' }] },
  'pr.synced': {
    pr: { repo: 'shop-shared', number: 159, state: 'open', ticket: 'SHOP-3472', url: '', checks: 'none', title: 'feature/SHOP-3472: keep the header once', review: 'review_required' },
  },
  'run.created': {
    runId: 'r1',
    ticket: 'SHOP-3546',
    worktree: '/w/SHOP-3546-r1',
    branch: 'feature/SHOP-3546',
    agentNumber: 4,
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    briefId: 'b1',
    conversationId: 'c1',
    test: true,
    startedFrom: 'r0',
  },
  'run.goal_declared': {
    runId: 'r1',
    revision: 1,
    goal: 'Payment provider errors reach checkout with their error_code.',
    checks: [
      { id: 'unit', description: 'Unit tests pass', proof: 'command', command: 'npm run test:unit' },
      { id: 'ci', description: 'CI passes', proof: 'ci', repo: 'acme/shop-api' },
      { id: 'page', description: 'Confluence page updated', proof: 'approval', scope: 'external' },
    ],
  },
  'run.step_begun': { runId: 'r1', stepIndex: 2, name: 'Unit tests', why: 'The fix is in; now prove it.' },
  'run.step_ended': { runId: 'r1', stepIndex: 1, outcome: 'done', note: 'error_code lifted from details' },
  'run.check_changed': { runId: 'r1', checkId: 'unit', status: 'passed', evidence: '`npm run test:unit` passed at 14:32.' },
  'run.heartbeat': {
    runId: 'r1',
    step: 'Unit tests',
    sinceLast: 'Fixed two failing specs.',
    next: 'Run the whole unit suite.',
    progress: 'most',
    risks: ['The integration suite needs Redis'],
    tokens: 412_000,
    workingSeconds: 1080,
  },
  'run.ack': { runId: 'r1', refEventSeq: 42, note: 'Noted.' },
  'run.flag': { runId: 'r1', kind: 'loop', detail: '`npm run test:unit` ran 3 times with the same failure.' },
  'run.paused': { runId: 'r1', by: 'you', reason: 'Going the wrong way' },
  'run.resumed': { runId: 'r1', by: 'you' },
  'run.guidance': { runId: 'r1', text: 'Never touch the generated folder.', by: 'you' },
  'run.reminded': { runId: 'r1', about: 'heartbeat', text: 'It is 5 working minutes since your last heartbeat. Call heartbeat now, then carry on.' },
  'run.usage': { runId: 'r1', tokens: 412_000, workingSeconds: 1080 },
  'run.state_changed': { runId: 'r1', state: 'waiting_for_you', reason: 'needs a Confluence space' },
  'run.note': { runId: 'r1', text: 'Found where PaymentClient nests error_code inside details.' },
  'subagent.started': { runId: 'r1', subagentId: 's1', parentToolUseId: 'toolu_1', model: 'claude-haiku-5-5', effort: 'low', task: 'Search PaymentClient for error_code' },
  'subagent.tool_called': { runId: 'r1', subagentId: 's1', toolUseId: 'toolu_2', tool: 'Grep', inputSummary: 'error_code in src/payments', outputSummary: 'src/payments/client.ts:132', ok: true },
  'subagent.finished': { runId: 'r1', subagentId: 's1', outcome: 'cancelled', by: 'agent', reason: 'Needs services this host lacks', result: '', tokens: 22_000, toolCalls: 5, durationMs: 78_000 },
  'tool.called': { runId: 'r1', toolUseId: 'toolu_3', tool: 'Bash', title: 'pnpm test', inputSummary: '{"command":"pnpm test"}', allowed: true },
  'tool.finished': {
    runId: 'r1',
    toolUseId: 'toolu_3',
    ok: true,
    outputSummary: '41 passed',
    durationMs: 72_000,
    diff: { hunks: [{ oldStart: 26, newStart: 26, lines: [' const token = config.token.trim();', '-headers.Authorization = `Basic ${token}`;', '+const value = token.replace(/^Basic\\s+/i, "");'] }] },
  },
  'approval.requested': { approvalId: 'a1', runId: 'r1', kind: 'push', question: 'Push feature/SHOP-3546?', action: 'git push origin feature/SHOP-3546', gate: 'narrative' },
  'approval.resolved': { approvalId: 'a1', decision: 'approved', scope: 'ticket' },
  'action.classified': {
    actionId: 'act1',
    runId: 'r1',
    toolUseId: 'tu1',
    proxy: 'gh',
    kind: 'pr.ready',
    tier: 2,
    summary: 'gh pr ready 812 --repo acme/shop-api',
    decision: 'ask',
    reason: 'Marking a PR ready for review notifies its reviewers.',
    approvalId: 'a2',
  },
  'action.finished': { actionId: 'act1', runId: 'r1', ok: true, outputSummary: 'ready', durationMs: 900, notSent: true },
  'change.recorded': {
    recordId: 'rec1',
    actionId: 'act2',
    runId: 'r1',
    environment: 'dev',
    target: 'deployment/shop-api in shop-dev on dev',
    before: 'container shop-api: image shop-api:2.21.3',
    undo: { proxy: 'kube', summary: 'Set shop-api back to shop-api:2.21.3', request: { args: ['--context', 'dev-shop', 'set', 'image', 'deployment/shop-api', 'shop-api=shop-api:2.21.3'] } },
  },
  'change.undone': { recordId: 'rec1', actionId: 'act3', by: 'you' },
  'grant.created': {
    grantId: 'g1',
    ticket: 'SHOP-3492',
    runId: 'r1',
    kind: 'pr.ready',
    expiresAt: '2026-10-12T02:00:00.000Z',
    by: 'you',
    approvalId: 'a2',
  },
  'grant.ended': { grantId: 'g1', reason: 'run_ended' },
  'aws.session': { state: 'expiring', expiresAt: '2026-10-11T18:20:00.000Z' },
  'run.thought': { runId: 'r1', text: 'The config value already carries "Basic ", and auth.ts adds it again.' },
  'run.verdict': {
    runId: 'r1',
    verdict: 'VALID',
    reproduced: true,
    summary: 'auth.ts adds the scheme to a value that has it.',
    evidence: [{ kind: 'code', ref: 'shop-api/src/webhook/auth.ts:27' }],
    symptom: 'the webhook receives "Basic Basic dXNlcjpwYXNz"',
    sibling: 'The Bearer path in the same file sends one scheme.',
    findings: [{ text: 'A failing test sends "Basic Basic".', sources: [{ kind: 'code', ref: 'shop-api/test/auth.test.ts:12' }] }],
    chain: [
      { ref: 'shop-api/src/webhook/send.ts:20', role: 'entry' },
      { ref: 'shop-api/src/webhook/auth.ts:27', role: 'fault', note: 'adds the scheme again' },
    ],
    siblingAt: { kind: 'code', ref: 'shop-api/src/webhook/auth.ts:41', label: 'the Bearer path' },
  },
  'run.understanding': {
    runId: 'r1',
    claim: 'the webhook receives "Basic Basic dXNlcjpwYXNz"',
    input: 'a config value "Basic dXNlcjpwYXNz"',
    actual: 'the header is "Basic Basic dXNlcjpwYXNz"',
    expected: 'the header is "Basic dXNlcjpwYXNz"',
    sources: [{ kind: 'ticket', ref: 'SHOP-3546' }],
  },
  'run.reproduction': {
    runId: 'r1',
    how: 'A failing unit test sends the header through the real builder.',
    environment: 'local, vitest, shop-api',
    test: { path: 'shop-api/test/auth.test.ts', name: 'sends the scheme once' },
    command: 'npx vitest run test/auth.test.ts',
    requestIds: ['req-7f3a'],
  },
  'run.root_cause': { runId: 'r1', text: 'auth.ts adds the scheme to a value that has it.', lines: [{ kind: 'code', ref: 'shop-api/src/webhook/auth.ts:27' }] },
  'run.approach': { runId: 'r1', approach: 'Add the scheme only when the value lacks it.', alternatives: [{ option: 'Strip the scheme from the config on load', rejectedBecause: 'Other readers of the config expect it.' }] },
  'run.test_run': { runId: 'r1', toolUseId: 'tu1', command: 'npx vitest run test/auth.test.ts', ok: false, durationMs: 2300, summary: '1 failed | 3 passed', passed: 3, failed: 1, failedNames: ['sends the scheme once'] },
  'run.pushed': {
    runId: 'r1',
    repos: [{ repo: 'acme/shop-api', branch: 'feature/SHOP-3546', head: '3f2a1c9', commits: [{ sha: '3f2a1c9', subject: 'SHOP-3546: send the scheme once' }], files: [{ path: 'src/webhook/auth.ts', added: 4, removed: 1 }] }],
  },
  'run.reported': { runId: 'r1', result: 'succeeded', summary: 'Fixed; the suite and CI pass.', notVerified: ['A real provider on dev'], waitingOnYou: ['Mark the PR ready for review'], unmet: [{ n: 2, why: 'The rate limit is set in the provider dashboard: nothing here to call.' }] },
  'run.criteria_reviewed': { runId: 'r1', criteria: [{ n: 1, status: 'met', text: 'error_code is at the top', why: 'map.ts:44' }, { n: 2, status: 'not_met', text: 'a 429 keeps its details', why: 'map.ts:51 drops them' }, { n: 3, status: 'cannot_tell', text: 'a real provider answers', why: 'only a run on dev settles it' }] },
  'run.handed_back': { runId: 'r1', message: 'The fix is on the PR. Nothing else waits for you.' },
  'narrative.read': { runId: 'r1', ticket: 'SHOP-3546', by: 'you' },
  'layout.changed': { layout: [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]], by: 'you' },
  'run.inputs_declared': { runId: 'r1', classes: ['a header value with the scheme', 'a bare token', 'no auth configured'] },
  'run.hypothesis': { runId: 'r1', hypothesisId: 'h1', text: 'The config merge adds the scheme.', status: 'disproved', evidence: [{ kind: 'code', ref: 'shop-api/src/config.ts:40' }] },
  'run.finding': {
    runId: 'r1',
    findingId: 'f1',
    summary: 'Retries resend the old header.',
    evidence: [{ kind: 'log', ref: 'source logs | filter $d.msg ~ "retry"' }],
    proposedTicket: { summary: 'Webhook retries resend a stale Authorization header', description: 'Description: …' },
  },
  'run.skill_snapshot': { runId: 'r1', hash: '332293caec9e', files: 11 },
  'elfoqsy.activity': { conversationId: 'c1', activityId: 'act1', tool: 'jira', text: 'Read SHOP-3492 and its comments', state: 'done' },
  'ci.status': { repo: 'shop-worker', pr: 212, sha: 'abc123', status: 'failure', url: '' },
  'budget.exceeded': { runId: 'r1', limit: 'time', value: 46 },
  'sync.status': { source: 'jira', state: 'unreachable', since: '2026-10-09T14:49:00.000Z', reason: 'HTTP 503' },
  'usage.limit': { state: 'limited', since: '2026-10-09T14:49:00.000Z', until: '2026-10-09T18:00:00.000Z', reason: 'five_hour' },
  'usage.status': { fiveHourPct: 42, sevenDayPct: 61, resetsAt: '2026-10-09T18:00:00.000Z' },
  'elfoqsy.message': {
    messageId: 'm1',
    role: 'elfoqsy',
    text: 'Agent 4 wants to push.',
    conversationId: 'c1',
    blocks: [{ type: 'approval', ref: 'a1' }, { type: 'code', content: '- a\n+ b', diff: true }],
    attachments: [{ attachmentId: 'f1', name: 'screen.png', mediaType: 'image/png', bytes: 2048 }],
    refs: { approvalId: 'a1' },
  },
  'elfoqsy.message_marked': { messageId: 'm2', role: 'test', note: 'Typed by Claude Code during the M6 live check.' },
  'conversation.created': { conversationId: 'c1', title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164' },
  'conversation.renamed': { conversationId: 'c1', title: 'Per-step timeout for SHOP-1164' },
  'investigation.started': { investigationId: 'i1', conversationId: 'c1', question: 'Why does the job never complete?', model: 'claude-sonnet-5-5', effort: 'high' },
  'investigation.finished': {
    investigationId: 'i1',
    conversationId: 'c1',
    title: "What's actually happening",
    findings: [{ text: 'Steps that finish early are cached.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }] }],
    filesRead: 14,
    tokens: 88_000,
    durationMs: 220_000,
  },
  'memory.saved': {
    factId: 'f1',
    statement: 'Cached export steps never start the Redis timeout.',
    sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }],
    freshUntil: '2026-10-16T14:10:00.000Z',
    origin: 'investigator',
  },
  'elfoqsy.look': { mood: 'needs', variant: 1 },
  'memory.forgotten': { factId: 'f1', by: 'you' },
  'daemon.started': { mode: 'live' },
  'mirror.checked': { repo: 'acme/shop-api', runId: 'r1', ok: false, recreated: true, ms: 8400, problem: 'git fsck failed: error: object file is corrupt' },
  'ci.dismissed': { repo: 'acme/shop-worker', pr: 217, sha: 'abc123', by: 'you' },
  'run.dismissed': { runId: 'r3', by: 'you', reason: 'It failed when the daemon restarted.' },
  'run.folder_removed': { runId: 'r3', folder: '/home/alex/.local/share/elfoqsy/runs/SHOP-2091-0qcahb', reason: 'Dismissed, with nothing uncommitted and nothing missing from GitHub.' },
  'brief.started': { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-1164' },
  'brief.created': { briefId: 'b1', conversationId: 'c1', ticket: 'SHOP-1164', title: 'Per-step timeout for SHOP-1164', sections: [{ heading: 'Goal', markdown: 'The order export always finishes.' }] },
  'brief.handed_off': { briefId: 'b1', runId: 'r1' },
  'handoff.created': {
    handoffId: 'h1',
    conversationId: 'c1',
    ticket: 'SHOP-3546',
    mode: 'hotfix',
    bases: { 'acme/shop-worker': 'release/2.22.0' },
    context: [{ messageId: 'm1', role: 'you', text: 'Start on 3546; keep the v1 path as it is.' }],
    constraints: [{ text: 'keep the v1 path as it is', messageId: 'm1' }],
    facts: [{ text: 'The ticket says error_code is empty for timeouts.', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }],
    dropped: [{ text: 'The root cause is the mapper.', reason: 'no source' }],
  },
  'handoff.handed_off': { handoffId: 'h1', runId: 'r1' },
  'skill.changed': { skill: 'team-dev', hash: 'abc123def456', previous: '332293caec9e', sections: ['references/writing.md'] },
  'ability.learned': { name: 'find-request-logs', version: 1, title: "Find a request's logs", titleVi: 'tìm log của một request', tool: 'coralogix', steps: [{ text: 'Match the id anywhere', code: "filter $d ~~ '<requestId>'", kind: 'read' }], finder: { by: 'elfoqsy', session: 'friction analysis' }, baselineSteps: 3, baselineFailed: 1.2, baselineQuestions: 0.3, source: 'friction analysis, 2026-10-20' },
  'ability.shorten_asked': { names: ['find-request-logs', 'short-kube-output'] },
  'ability.origin': { name: 'find-request-logs', version: 1, foundAt: '2026-10-20T16:30:00.000Z', cases: 24, from: 'episodes of this task in 30 of his sessions and 10 runs before 2026-10-20' },
  'ability.verified': { name: 'find-request-logs', version: 1, steps: [{ status: 'ok' }, { status: 'unverified', note: 'has effects' }] },
  'ability.used': { name: 'find-request-logs', runId: 'run-1', worked: true, steps: 2, baselineSteps: 3, failedCalls: 0, baselineFailed: 1.2, questions: 0, baselineQuestions: 0.3 },
  'ability.missed': { name: 'find-request-logs', runId: 'today-2026-10-21', in: 'conversation', steps: 4 },
  'ability.needs_recheck': { name: 'find-request-logs', version: 1, step: 1, reason: 'Compilation errors' },
  'ability.repaired': { name: 'find-request-logs', version: 2, steps: [{ text: 'Match the id anywhere', code: "filter $d ~~ '<requestId>'", kind: 'read' }], reason: 'step 2 no longer compiled' },
  'elfoqsy.reply_corrected': { conversationId: 'c1', invented: ['I left out SHOP-2091 because it is closed.'] },
  'ticket.closed_out': { ticket: 'SHOP-3546', qa: 'QA passed on Integration.', files: ['case.md', 'qa-notes.md', 'solution-page.md'], pageRequested: true },
  'review.weekly': { weekOf: '2026-10-05', conversationId: 'c9', metrics: { runs: 6, succeeded: 4 }, suggestions: ['Use Sonnet medium for test runs.'] },
  'review.corrected': { weekOf: '2026-10-05', revision: 2, metrics: { runs: 6, succeeded: 4 }, suggestions: [], withdrawn: ['Answer approvals sooner.'] },
  'decision.considering': { requestId: 'q1', runId: 'run-1', requestKind: 'question', summary: 'Which limit should the client respect?' },
  'decision.made': {
    decisionId: 'd1',
    requestId: 'q1',
    runId: 'run-1',
    requestKind: 'question',
    category: 'sourced_answer',
    summary: 'Confirmed the expected discount for a bundle',
    question: 'Does a bundle discount apply to the bundle items only?',
    options: ['Yes', 'No'],
    answer: 'Yes',
    sources: [{ kind: 'ticket', ref: 'SHOP-1201', label: "the ticket's AC" }],
    basis: 'sources',
    told: false,
  },
  'decision.changed': { decisionId: 'd1', by: 'you', how: 'changed', to: 'No' },
  'decisions.digested': { digestId: 'g1', conversationId: 'c1', decisionIds: ['d1'], awaySince: '2026-10-12T17:00:00.000Z' },
  'delegation.set': { category: 'staging_write', setting: 'ask', by: 'you' },
  'precedent.saved': { precedentId: 'p1', category: 'notify_people', ticketType: 'Bug', approvalId: 'a1', requestKind: 'action', question: 'Comment on SHOP-2091?', answer: 'approved', kind: 'jira.comment', by: 'you' },
  'precedent.removed': { precedentId: 'p1', by: 'you' },
  'workspace.setting': { key: 'maxAgents', value: 6, by: 'you' },
  'run.assumption': { runId: 'run-1', assumptionId: 'as1', text: 'v1 stays as it is; only v2 changes.', evidence: [{ kind: 'ticket', ref: 'SHOP-2091' }], flag: 'contract', by: 'agent' },
  'task.delivered': { runId: 'run-2', deliverableId: 'dl1', kind: 'table', title: 'Integration and staging images', content: '| service | integration | staging |\n|---|---|---|' },
};

describe('payload schemas', () => {
  it('has an example for every event type', () => {
    expect(Object.keys(examples).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('accepts a valid %s payload', (type) => {
    expect(parsePayload(type, examples[type])).toEqual(examples[type]);
  });

  it('credits an ability to an agent, to Elfoqsy, or to alex when he asked for it; nobody else', () => {
    const base = examples['ability.learned'];
    for (const finder of [{ by: 'alex' }, { by: 'elfoqsy' }, { by: 'agent', agentNumber: 3, runId: 'r3' }]) expect(() => parsePayload('ability.learned', { ...base, finder })).not.toThrow();
    expect(() => parsePayload('ability.learned', { ...base, finder: { by: 'tester' } })).toThrow();
  });

  it('rejects a ticket with an unknown status', () => {
    expect(() => parsePayload('ticket.synced', { ticket: { ...ticket, status: 'Doing' } })).toThrow();
  });

  it('rejects a payload with a missing field', () => {
    expect(() => parsePayload('run.created', { runId: 'r1', ticket: 'SHOP-1' })).toThrow();
  });

  it('carries the language her words were written in on a decision and a digest: Vietnamese, or nothing for English', () => {
    expect(parsePayload('decision.made', { ...examples['decision.made'], lang: 'vi' })).toMatchObject({ lang: 'vi' });
    expect(parsePayload('decisions.digested', { ...examples['decisions.digested'], lang: 'vi' })).toMatchObject({ lang: 'vi' });
    expect(parsePayload('decisions.digested', examples['decisions.digested'])).not.toHaveProperty('lang');
    expect(() => parsePayload('decisions.digested', { ...examples['decisions.digested'], lang: 'fr' })).toThrow();
    expect(() => parsePayload('decision.made', { ...examples['decision.made'], lang: 'en' })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => parsePayload('run.note', { runId: '', text: 'x' })).toThrow();
  });

  it('strips unknown keys instead of storing them', () => {
    const parsed = parsePayload('run.note', { runId: 'r1', text: 'x', secret: 'nope' });
    expect(parsed).toEqual({ runId: 'r1', text: 'x' });
  });
});

describe('parseEnvelope', () => {
  const envelope = {
    seq: 1,
    id: '01JZ0000000000000000000000',
    ts: '2026-10-08T14:06:00.000Z',
    source: 'simulator',
    type: 'run.note',
    payload: { runId: 'r1', text: 'hello' },
  };

  it('accepts a valid envelope', () => {
    expect(parseEnvelope(envelope)).toEqual(envelope);
  });

  it('rejects an unknown type', () => {
    expect(() => parseEnvelope({ ...envelope, type: 'run.exploded' })).toThrow(/Unknown event type/);
  });

  it('rejects a payload that does not match its type', () => {
    expect(() => parseEnvelope({ ...envelope, type: 'run.step_changed' })).toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() => parseEnvelope({ ...envelope, source: 'slack' })).toThrow();
  });
});

describe('client frames', () => {
  it('accepts hello, say and answer', () => {
    expect(clientFrameSchema.parse({ t: 'hello', fromSeq: 0 })).toEqual({ t: 'hello', fromSeq: 0 });
    expect(clientFrameSchema.parse({ t: 'say', text: ' hi ' })).toEqual({ t: 'say', text: 'hi' });
    expect(clientFrameSchema.parse({ t: 'answer', approvalId: 'a1', decision: 'approved' })).toEqual({
      t: 'answer',
      approvalId: 'a1',
      decision: 'approved',
    });
  });

  it('takes "Allow for this ticket" as the answer\'s scope, and Undo by its record', () => {
    expect(clientFrameSchema.parse({ t: 'answer', approvalId: 'a1', decision: 'approved', scope: 'ticket' })).toMatchObject({ scope: 'ticket' });
    expect(() => clientFrameSchema.parse({ t: 'answer', approvalId: 'a1', decision: 'approved', scope: 'forever' })).toThrow();
    expect(clientFrameSchema.parse({ t: 'undo', recordId: 'rec1' })).toEqual({ t: 'undo', recordId: 'rec1' });
  });

  it('rejects blank messages and negative seq', () => {
    expect(() => clientFrameSchema.parse({ t: 'say', text: '   ' })).toThrow();
    expect(() => clientFrameSchema.parse({ t: 'hello', fromSeq: -1 })).toThrow();
  });
});

describe('the layout and what crosses windows (P2)', () => {
  const today = [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]];

  it('takes each pane at most once, in columns of stacks, on two screens, a pane left out, or null for no layout saved', () => {
    expect(layoutSchema.parse(today)).toEqual(today);
    expect(layoutSchema.parse([[], [['sprint'], ['elfoqsy', 'conversation'], ['map'], ['terminals']]])).toBeTruthy();
    // A pane removed from the screens is on neither; all five may be.
    expect(layoutSchema.parse([[['sprint'], ['elfoqsy']], [['map']]])).toBeTruthy();
    expect(layoutSchema.parse([[], []])).toEqual([[], []]);
    expect(clientFrameSchema.parse({ t: 'layout_set', layout: null })).toEqual({ t: 'layout_set', layout: null });
    expect(clientFrameSchema.parse({ t: 'layout_set', layout: today, test: true })).toMatchObject({ test: true });
  });

  it('refuses a pane twice, an empty column, an unknown pane and a third screen', () => {
    expect(() => layoutSchema.parse([[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals'], ['sprint']]])).toThrow(/twice sprint/);
    expect(() => layoutSchema.parse([[['sprint'], [], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]])).toThrow();
    expect(() => layoutSchema.parse([[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals', 'inbox']]])).toThrow();
    expect(() => layoutSchema.parse([...today, []])).toThrow();
    expect(() => clientFrameSchema.parse({ t: 'layout_set' })).toThrow();
  });

  it('passes intents to the other window, and nothing else', () => {
    expect(clientFrameSchema.parse({ t: 'relay', intent: { t: 'open_ticket', key: 'SHOP-3546', section: 2 } })).toMatchObject({ t: 'relay' });
    expect(intentSchema.parse({ t: 'select_conversation', id: null })).toEqual({ t: 'select_conversation', id: null });
    expect(intentSchema.parse({ t: 'focus_run', runId: 'r1' })).toEqual({ t: 'focus_run', runId: 'r1' });
    expect(intentSchema.parse({ t: 'sprint_view', view: { kind: 'ticket', key: 'SHOP-3546' } })).toMatchObject({ t: 'sprint_view' });
    expect(intentSchema.parse({ t: 'sprint_view', view: { kind: 'create' } })).toEqual({ t: 'sprint_view', view: { kind: 'create' } });
    expect(() => intentSchema.parse({ t: 'sprint_view', view: { kind: 'ticket' } })).toThrow();
    expect(() => intentSchema.parse({ t: 'sprint_view', view: { kind: 'settings' } })).toThrow();
    expect(() => intentSchema.parse({ t: 'open_ticket', key: 'x', section: 9 })).toThrow();
    expect(() => clientFrameSchema.parse({ t: 'relay', intent: { t: 'jira_edit' } })).toThrow();
  });
});
