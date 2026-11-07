// The browser tests' event logs: one agent, a new agent on cue, and the scene of designs-terminal-v3 (four agents in a
// 2x2 grid as screenshot 01, Agent 2's pane as 03 and 04, the question card and the digest as 05). Made-up content in
// the shape the daemon writes; no secrets, nothing real.
export const T0 = Date.parse('2026-10-12T17:00:00Z');

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** A ticket as the daemon logs it (ticket.detail), from the captured fixtures (pnpm --filter @elfoqsy/daemon jira:details). */
export const detail = (key) => JSON.parse(readFileSync(join(fixtures, `${key}.detail.json`), 'utf8'));

export function scenario() {
  let seq = 0;
  const ev = (type, payload, sec) => ({ seq: ++seq, id: `E${seq}`, ts: new Date(T0 + sec * 1000).toISOString(), source: 'simulator', type, payload });
  const ticket = (key, summary, type = 'Bug') => ({
    key,
    board: key.split('-')[0],
    summary,
    type,
    status: 'In progress',
    priority: 'Major',
    storyPoints: 3,
    sprint: 'SHOP Sprint 52',
    sprintsCarried: 0,
    epic: null,
    reporter: 'r',
    created: '2026-10-01',
    updated: '2026-10-12',
    labels: [],
    linked: [],
    description: 'The bundle discount reaches the whole cart.',
  });
  const run = (runId, n, key, sec, conversationId) => [
    ev('run.created', { runId, ticket: key, worktree: `/runs/${runId}`, branch: `feature/${key}`, agentNumber: n, model: 'claude-opus-5-5', effort: 'xhigh', budget: { tokens: 3_000_000, minutes: 45 }, ...(conversationId ? { conversationId } : {}) }, sec),
    ev('run.state_changed', { runId, state: 'running' }, sec),
  ];
  const steps = (runId, names, sec) =>
    names.flatMap((name, i) => [
      ...(i ? [ev('run.step_ended', { runId, stepIndex: i - 1, outcome: 'done' }, sec + i)] : []),
      ev('run.step_begun', { runId, stepIndex: i, name, why: 'w' }, sec + i),
    ]);
  const call = (runId, id, tool, title, sec, out) => [
    ev('tool.called', { runId, toolUseId: id, tool, title, inputSummary: '{}', allowed: true }, sec),
    ...(out ? [ev('tool.finished', { runId, toolUseId: id, ok: out.ok ?? true, outputSummary: out.output ?? '', durationMs: out.ms ?? 800, ...(out.diff ? { diff: out.diff } : {}) }, sec + 1)] : []),
  ];
  const thought = (runId, text, sec) => ev('run.thought', { runId, text }, sec);

  // The sprint of screenshots 20 to 23 (brief-v1.4), with workflow statuses.
  const sprintTicket = (key, summary, type, status, workflow, category, priority, points) => ({
    ...ticket(key, summary, type),
    status,
    priority,
    storyPoints: points,
    workflowStatus: { name: workflow, category },
    assignee: 'Alex Rivera',
  });
  const sprint = [
    sprintTicket('SHOP-3538', '[Checkout V2] Inventory Sync Worker: commit the stock reservation after payment capture, then release the hold (P04)', 'Story', 'To do', 'OPEN', 'new', 'Blocker', 8),
    sprintTicket('SHOP-3049', 'Refund status change', 'Bug', 'Blocked', 'BLOCKED', 'indeterminate', 'Blocker', 5),
    sprintTicket('SHOP-3472', 'Black Duck High remediation', 'Story', 'In progress', 'IN PROGRESS', 'indeterminate', 'Major', 3),
    sprintTicket('SHOP-3546', '429 retry for provider errors', 'Bug', 'To do', 'OPEN', 'new', 'Major', 3),
    sprintTicket('CORE-18891', 'Payment API rate limit', 'Story', 'To do', 'Open', 'new', 'Major', 2),
    sprintTicket('SHOP-2091', 'Bundle discount on whole cart', 'Bug', 'To do', 'OPEN', 'new', 'Minor', 2),
    sprintTicket('SHOP-1164', 'Per-step timeout', 'Bug', 'To do', 'IN ANALYZE', 'indeterminate', 'Minor', 2),
    sprintTicket('SHOP-3533', 'Confluence page for 2.22', 'Task', 'Done', 'WORK-DONE', 'done', 'Minor', 1),
  ];

  return {
    /** The left screen with the sprint of screenshot 20 and SHOP-3538 read in full (milestone 17). */
    tickets() {
      seq = 0;
      return [
        ev('jira.fields', { fields: { storyPoints: { name: 'Story point estimate', id: 'customfield_16486' }, sprint: { name: 'Sprint', id: 'customfield_10521' } }, moved: [], missing: [] }, 0),
        ...sprint.map((t) => ev('ticket.synced', { ticket: t }, 0)),
        ev('conversation.created', { conversationId: 'c9', title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164' }, 1),
        ev('elfoqsy.message', { messageId: 'm1', role: 'elfoqsy', text: 'On it. I sent an investigator into the export job first.', conversationId: 'c9' }, 2),
        ev('elfoqsy.message', { messageId: 'm2', role: 'you', text: 'makes sense. timeout per step, not per job?', conversationId: 'c9' }, 3),
        ev('elfoqsy.message', { messageId: 'm3', role: 'elfoqsy', text: "Yes, per step. The brief is written and Agent 5 is already on it. Say stop and I'll stop it.", conversationId: 'c9' }, 4),
        ev('ticket.detail', detail('SHOP-3538'), 5),
        ev(
          'jira.options',
          {
            project: 'SHOP',
            me: { accountId: 'acc-me', displayName: 'Alex Rivera' },
            users: [
              { accountId: 'acc-1', displayName: 'Quinn Bauer' },
              { accountId: 'acc-2', displayName: 'Morgan Diaz' },
              { accountId: 'acc-3', displayName: 'Jordan Park' },
              { accountId: 'acc-me', displayName: 'Alex Rivera' },
            ],
            sprints: [
              { id: 33774, name: 'SHOP Sprint 52', state: 'active', goal: 'Release Manager: Morgan Diaz' },
              { id: 33901, name: 'SHOP Sprint 53', state: 'future' },
            ],
            linkTypes: [
              { id: '10402', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              { id: '10404', name: 'Relates', inward: 'Relates', outward: 'Relates' },
            ],
            labels: ['checkout-v2', 'checkout-v2.1', 'p04'],
            fetchedAt: new Date(T0).toISOString(),
          },
          6,
        ),
      ];
    },
    /**
     * The narrative (N1), "What we know", for Agent 4 on SHOP-3546: `mid` is the scene of screenshot 30 (understanding, the
     * verdict, a reproduction and a cause still a hypothesis); `end` is the agent's turn finishing with a draft PR open, the
     * scene of screenshot 31. Made-up content in the shape the daemon writes.
     */
    narrative() {
      const base = this.tickets();
      const repo = 'acme/shop-api';
      const runId = 'r4';
      const code = (ref, label) => ({ kind: 'code', ref, ...(label ? { label } : {}) });
      const mid = [
        ev('conversation.created', { conversationId: 'c46', title: 'Why does checkout drop 429 errors?', ticket: 'SHOP-3546' }, 90),
        ev('elfoqsy.message', { messageId: 'n1', role: 'you', text: 'Why does checkout drop 429 errors from the payment provider instead of retrying? SHOP-3546', conversationId: 'c46' }, 91),
        ev('elfoqsy.message', { messageId: 'n2', role: 'elfoqsy', text: 'I handed SHOP-3546 to an agent. I will tell you when it has a verdict.', conversationId: 'c46' }, 92),
        ...run(runId, 4, 'SHOP-3546', 100, 'c46'),
        ...steps(runId, ['Understand', 'Locate', 'Verdict', 'Reproduce'], 101),
        ev('run.understanding', { runId, claim: 'the payment client drops a 429 from the provider instead of retrying', input: 'a payment whose provider answer is 429 with a Retry-After header', actual: 'the 429 is mapped to "not a result" and dropped, so the payment never completes', expected: 'the client waits for Retry-After and retries, up to the configured budget', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }, { kind: 'doc', ref: 'AC: retry on 429' }] }, 160),
        ev('run.verdict', {
          runId,
          verdict: 'VALID',
          reproduced: false,
          summary: 'A 429 from the provider is dropped before the retry mapping runs.',
          symptom: 'the payment client drops a 429 from the provider',
          sibling: 'A 503 from the same client is retried; only the 429 branch returns early.',
          siblingAt: code('shop-api/src/payments/client.ts:88', 'the 503 retry'),
          chain: [
            { ref: 'shop-api/src/payments/client.ts:41', role: 'entry', note: 'sends the charge to the provider' },
            { ref: 'shop-api/src/payments/errors.ts:19', role: 'hop', note: 'maps the status to an outcome' },
            { ref: 'shop-api/src/payments/errors.ts:27', role: 'fault', note: 'returns "no result" for 429 before the retry check' },
          ],
          findings: [{ text: 'errors.ts returns early for 429.', sources: [code('shop-api/src/payments/errors.ts:27')] }],
          evidence: [code('shop-api/src/payments/errors.ts:27')],
        }, 220),
        ev('elfoqsy.message', { messageId: 'n3', role: 'elfoqsy', text: "Agent 4 reached its verdict on SHOP-3546: VALID, not reproduced yet. A 429 from the provider is dropped before the retry mapping runs. Nothing waits for you.", conversationId: 'c46', blocks: [{ type: 'narrative', ref: runId, section: 2 }], refs: { tickets: ['SHOP-3546'], runId } }, 221),
        ev('run.test_run', { runId, toolUseId: 'n-t1', command: 'npx jest test/payments/client.test.ts', ok: false, durationMs: 2300, summary: "FAIL test/payments/client.test.ts\n  ✕ retries after a 429 with Retry-After (14 ms)\n    Expected: 2 calls\n    Received: 1 call", passed: 11, failed: 1, failedNames: ['retries after a 429 with Retry-After'] }, 260),
        ev('run.reproduction', { runId, how: 'A unit test sends a 429 with Retry-After through the real client and counts the calls.', environment: 'local, jest, shop-api', test: { path: 'shop-api/test/payments/client.test.ts', name: 'retries after a 429 with Retry-After' }, command: 'npx jest test/payments/client.test.ts', requestIds: ['req-1c7a'] }, 265),
        ev('run.verdict', { runId, verdict: 'VALID', reproduced: true, summary: 'A 429 from the provider is dropped before the retry mapping runs; the new test fails on the current code.', symptom: 'the payment client drops a 429 from the provider', sibling: 'A 503 from the same client is retried; only the 429 branch returns early.', siblingAt: code('shop-api/src/payments/client.ts:88', 'the 503 retry'), chain: [
          { ref: 'shop-api/src/payments/client.ts:41', role: 'entry', note: 'sends the charge to the provider' },
          { ref: 'shop-api/src/payments/errors.ts:19', role: 'hop', note: 'maps the status to an outcome' },
          { ref: 'shop-api/src/payments/errors.ts:27', role: 'fault', note: 'returns "no result" for 429 before the retry check' },
        ], findings: [{ text: 'The new test fails.', sources: [code('shop-api/test/payments/client.test.ts:42')] }], evidence: [code('shop-api/test/payments/client.test.ts:42')] }, 266),
        ev('run.hypothesis', { runId, hypothesisId: 'h1', text: 'The retry budget is read after the early return, so it is never consulted for a 429.', status: 'open', evidence: [code('shop-api/src/payments/errors.ts:31')] }, 270),
      ];
      const end = [
        ev('run.hypothesis', { runId, hypothesisId: 'h1', text: 'The retry budget is read after the early return, so it is never consulted for a 429.', status: 'confirmed', evidence: [code('shop-api/src/payments/errors.ts:31')] }, 400),
        ev('run.root_cause', { runId, text: 'errors.ts returns "no result" for a 429 before the retry check, so a 429 is never retried and the payment never completes.', lines: [code('shop-api/src/payments/errors.ts:27'), code('shop-api/src/payments/errors.ts:31')] }, 405),
        ev('run.assumption', { runId, assumptionId: 'as1', text: 'Honour Retry-After up to 30 s; beyond that, fail the job with a timeout result.', evidence: [{ kind: 'ticket', ref: 'SHOP-3546' }], flag: 'contract', by: 'agent' }, 410),
        ev('run.approach', { runId, approach: 'Move the 429 case behind the retry check, so it uses the same budget as a 503.', alternatives: [{ option: 'Retry inside the HTTP client only', rejectedBecause: 'The payment client has its own retry budget, and a second one would double the wait.' }, { option: 'Treat 429 as a 503 at the mapping layer', rejectedBecause: 'It hides the Retry-After header the retry needs.' }] }, 415),
        ev('run.test_run', { runId, toolUseId: 'n-t2', command: 'npx jest test/payments/client.test.ts', ok: true, durationMs: 1800, summary: 'Tests: 12 passed, 12 total', passed: 12 }, 520),
        ev('run.test_run', { runId, toolUseId: 'n-t3', command: 'npm run test:unit', ok: true, durationMs: 41000, summary: 'Tests: 212 passed, 212 total', passed: 212 }, 540),
        ev('run.pushed', { runId, repos: [{ repo, branch: 'feature/SHOP-3546', head: '3f2a1c9d4', commits: [{ sha: '5b1e0d2', subject: 'SHOP-3546: add the failing 429 test' }, { sha: '3f2a1c9', subject: 'SHOP-3546: retry a 429 like a 503' }], files: [{ path: 'src/payments/errors.ts', added: 6, removed: 3 }, { path: 'test/payments/client.test.ts', added: 24, removed: 0 }] }] }, 560),
        ev('pr.synced', { pr: { repo, number: 140, state: 'draft', ticket: 'SHOP-3546', url: 'https://github.com/acme/shop-api/pull/140', checks: 'success', title: 'feature/SHOP-3546: retry a 429 like a 503', review: 'none' } }, 570),
        ev('ci.status', { repo, pr: 140, sha: '3f2a1c9d4', status: 'success', url: 'https://github.com/acme/shop-api/actions/runs/1' }, 600),
        ev('run.reported', { runId, result: 'succeeded', summary: 'A 429 is now retried like a 503; the suite and CI pass.', notVerified: ['A real provider replying 429 on dev'], waitingOnYou: ['Read what we know, then mark the PR ready for review'] }, 610),
        ev('run.handed_back', { runId, message: 'A 429 is now retried with the same budget as a 503. The new test and the unit suite pass, and CI is green on the draft PR. I could not reach a real provider sandbox on dev.\n\nWhat to do next: read what we know and mark the PR ready.\n\nDecisions I made: [contract] honour Retry-After up to 30 s.' }, 615),
        ev('elfoqsy.message', { messageId: 'n4', role: 'elfoqsy', text: 'Agent 4 handed back SHOP-3546 with draft PR shop-api#140, CI green. Read what we know, then mark it ready.', conversationId: 'c46', blocks: [{ type: 'narrative', ref: runId, section: 7 }], refs: { tickets: ['SHOP-3546'], runId } }, 616),
      ];
      return { base, mid, end, runId };
    },
    oneAgent() {
      seq = 0;
      return [ev('ticket.synced', { ticket: ticket('SHOP-2091', 'Bundle discount, whole cart') }, 0), ...run('r1', 1, 'SHOP-2091', 1), ...steps('r1', ['Understand'], 2), thought('r1', 'Reading the ticket.', 3)];
    },
    newAgent(runId, n, key) {
      return [ev('ticket.synced', { ticket: ticket(key, `Ticket ${key}`) }, 60 + n), ...run(runId, n, key, 60 + n), ...steps(runId, ['Understand'], 61 + n), thought(runId, `Starting on ${key}.`, 62 + n)];
    },
    design() {
      seq = 0;
      const out = [
        ev('ticket.synced', { ticket: ticket('SHOP-2091', 'Bundle discount applied to the whole cart') }, 0),
        ev('ticket.synced', { ticket: ticket('SHOP-3492', 'Basic auth header doubled') }, 0),
        ev('ticket.synced', { ticket: ticket('SHOP-1164', 'Order export stalls on the image resizer') }, 0),
        ev('ticket.synced', { ticket: ticket('CORE-18891', 'Client throttling limit', 'Story') }, 0),
        ev('conversation.created', { conversationId: 'c1', title: 'Overnight', ticket: 'SHOP-2091' }, 0),
        ev('elfoqsy.message', { messageId: 'm0', role: 'you', text: 'Leave them overnight; I will answer in the morning.', conversationId: 'c1' }, 1),
        // Agent 2 on SHOP-2091: screenshots 03 and 04.
        ...run('r2', 2, 'SHOP-2091', 2, 'c1'),
        ...steps('r2', ['Understand', 'Locate', 'Verdict', 'Fix'], 3),
        thought('r2', "The ticket says the bundle discount reaches the whole cart. I'll find where the discount is applied, then check whether that path skips the bundle check on purpose.", 10),
        ...call('r2', 'a1', 'mcp__run__jira', 'get SHOP-2091', 11, { output: 'Bug, Minor, no comments, no linked PRs' }),
        ...call('r2', 'a2', 'Grep', '"split_bundles" in shop-api/src', 13, { output: '4 matches in 2 files', ms: 200 }),
        ...call('r2', 'a3', 'Read', 'src/pricing/bundles.ts', 15, { output: '212 lines', ms: 100 }),
        ...call('r2', 'a4', 'Read', 'src/pricing/lines.ts', 17, { output: '88 lines', ms: 100 }),
        ...call('r2', 'a5', 'Grep', '"cart.lines" in src/pricing', 19, { output: '2 matches', ms: 200 }),
        ...call('r2', 'a6', 'Read', 'test/pricing/bundles.spec.ts', 21, { output: '140 lines', ms: 100 }),
        thought('r2', 'The discount is in `bundles.ts`: with `split_bundles: false` it takes `cart.lines`, so every line is discounted. Nothing in the docs or AC says that is intended.', 23),
        ev('run.verdict', { runId: 'r2', verdict: 'VALID', reproduced: true, summary: 'The whole cart is discounted.', findings: [{ text: 'New spec fails on the current code: the discount is 24.00, not 9.00', sources: [] }, { text: 'Same cart with `split_bundles: true` discounts only the bundle', sources: [] }] }, 24),
        ev('decision.made', { decisionId: 'd1', requestId: 'q1', runId: 'r2', requestKind: 'question', category: 'sourced_answer', summary: 'Confirmed the expected discount for a bundle', question: 'Does a bundle discount apply to the bundle items only?', options: ['Yes', 'No'], answer: 'Yes: the discount applies to the bundle items only.', sources: [{ kind: 'ticket', ref: 'SHOP-1201', label: "the ticket's AC and QA suite" }], basis: 'sources', told: false }, 25),
        ...call('r2', 'b1', 'mcp__run__kube', '--context dev get pods -n shop-dev', 26, { output: 'harness pod Pending: no node matches', ms: 1700 }),
        ...call('r2', 'b2', 'mcp__run__kube', '--context dev describe pod shop-integration-test-0', 28, { output: '0/3 nodes are available', ms: 1500 }),
        ...call('r2', 'b3', 'Bash', 'git -C shop-worker diff --stat', 30, { output: '1 file changed', ms: 300 }),
        ...call('r2', 'b4', 'Bash', 'npx jest --config jest.harness.config.js', 32, { output: 'Tests: 96 passed\n2 suites passed (89/89, 7/7)', ms: 1100 }),
        thought('r2', 'Fixing it so only the `false` path changes, as you asked: the discount now takes only the bundle lines, and a split bundle still works as before.', 34),
        ...call('r2', 'b5', 'Edit', 'src/pricing/bundles.ts', 35, { ms: 100, diff: { hunks: [{ oldStart: 86, newStart: 86, lines: ['-  const lines = splitBundles ? splitLines(cart, bundle) : cart.lines;', '+  const lines = splitBundles ? splitLines(cart, bundle) : bundleLines(cart, bundle);'] }] } }),
        ev('run.usage', { runId: 'r2', tokens: 302_000, workingSeconds: 1200 }, 36),
        // Agent 3 on SHOP-3492.
        ...run('r3', 3, 'SHOP-3492', 40),
        ...steps('r3', ['Understand', 'Verdict', 'Fix', 'Verify on dev'], 41),
        thought('r3', 'The fix strips an existing scheme before adding `Basic`. Checking that dev runs the new image before testing.', 46),
        ...call('r3', 'c1', 'mcp__run__kube', '--context dev get deploy shop-api -o image', 47, { output: 'shop-api:2.22.0-fix', ms: 1200 }),
        ...call('r3', 'c2', 'mcp__run__kube', '--context dev rollout status deploy/shop-api', 49, { output: 'successfully rolled out', ms: 3000 }),
        ...call('r3', 'c3', 'Bash', 'npm run test:unit -- webhook/auth', 52, { output: 'Tests: 52 passed', ms: 9000 }),
        ...call('r3', 'c4', 'mcp__run__aws', 'logs filter-log-events --filter "401"', 1790),
        ev('run.usage', { runId: 'r3', tokens: 441_000, workingSeconds: 1500 }, 60),
        // Agent 4 on SHOP-1164.
        ...run('r4', 4, 'SHOP-1164', 70),
        ...steps('r4', ['Understand', 'Locate'], 71),
        thought('r4', 'The stall shows up after resizing. Looking for the job that waits on the export.', 73),
        ...['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'].flatMap((id, i) => call('r4', id, i % 2 ? 'Read' : 'Grep', i % 2 ? `src/jobs/job${i}.ts` : `"export_timeout" in shop-worker`, 74 + i * 2, { output: i % 2 ? '120 lines' : '3 matches', ms: 300 })),
        ev('tool.called', { runId: 'r4', toolUseId: 'sa', tool: 'Agent', title: 'map every await on the export job', inputSummary: '{}', allowed: true }, 1770),
        ev('subagent.started', { runId: 'r4', subagentId: 's1', parentToolUseId: 'sa', model: 'claude-sonnet-5-5', effort: 'high', task: 'map every await on the export job' }, 1771),
        ev('run.usage', { runId: 'r4', tokens: 96_000, workingSeconds: 600 }, 100),
        // Agent 5 on CORE-18891: a question for him.
        ...run('r5', 5, 'CORE-18891', 110),
        ...steps('r5', ['Understand'], 111),
        thought('r5', 'The rate limit lives in the payment provider dashboard, not in our repos. I need one answer before going further.', 112),
        ev('approval.requested', { approvalId: 'a5', runId: 'r5', kind: 'question', question: 'Agent 5 on CORE-18891 asks: Which limit should the client respect?', card: { question: 'Which limit should the client respect?', why: ['The 429s in the ticket are per API key', 'The public docs describe a per-IP limit'], options: [{ label: 'Per API key', consequence: 'matches the 429s in the ticket' }, { label: 'Per IP', consequence: 'what the docs describe' }], recommendation: 'Per API key', sources: [{ kind: 'ticket', ref: 'CORE-18891' }] }, category: 'unsourced', precedentable: true, requestId: 'q5' }, 113),
        ev('run.state_changed', { runId: 'r5', state: 'waiting_for_you' }, 113),
        ev('run.usage', { runId: 'r5', tokens: 58_000, workingSeconds: 240 }, 114),
        // What she decided overnight, and the question that is his (screenshot 05).
        ev('action.classified', { actionId: 'act-push', runId: 'r2', proxy: 'gh', kind: 'gh.pr.create', tier: 2, summary: 'gh pr create --draft', decision: 'elfoqsy', reason: 'r', decisionId: 'd2' }, 200),
        ev('decision.made', { decisionId: 'd2', requestId: 'q2', runId: 'r2', requestKind: 'action', category: 'other', summary: 'Pushed the branch and opened a draft PR', answer: 'approved', sources: [{ kind: 'precedent', ref: 'p1', label: 'your standing rule for draft PRs' }], basis: 'precedent', told: true, actionId: 'act-push' }, 200),
        ev('change.recorded', { recordId: 'rec-pr', actionId: 'act-push', runId: 'r2', target: 'its draft PR', before: 'none', undo: { proxy: 'gh', summary: 'Close the draft PR', request: { args: ['pr', 'close'] } } }, 200),
        ev('action.classified', { actionId: 'act-harness', runId: 'r3', proxy: 'kube', kind: 'kube.set_image', tier: 2, environment: 'integration', summary: 'kubectl set image', decision: 'elfoqsy', reason: 'r', decisionId: 'd3' }, 300),
        ev('decision.made', { decisionId: 'd3', requestId: 'q3', runId: 'r3', requestKind: 'action', category: 'harness_kube', summary: 'Restarted the integration harness with the fix image', answer: 'approved', sources: [{ kind: 'setting', ref: 'harness_kube' }], basis: 'delegation', told: true, actionId: 'act-harness' }, 300),
        ev('change.recorded', { recordId: 'rec-h', actionId: 'act-harness', runId: 'r3', environment: 'integration', target: 'deployment/shop-integration-test', before: 'it:2.21.3', undo: { proxy: 'kube', summary: 'Set it back to it:2.21.3', request: { args: [] } } }, 300),
        ev('decision.made', { decisionId: 'd4', requestId: 'q4', runId: 'r3', requestKind: 'action', category: 'run_folder', summary: 'Let the agent read its own temp folder', answer: 'approved', sources: [{ kind: 'setting', ref: 'run_folder' }], basis: 'delegation', told: false }, 400),
        ev('decisions.digested', { digestId: 'g1', conversationId: 'c1', decisionIds: ['d1', 'd2', 'd3', 'd4'], awaySince: new Date(T0).toISOString() }, 1700),
        ev('elfoqsy.message', { messageId: 'm1', role: 'you', text: 'Morning.', conversationId: 'c1' }, 1700),
        ev('elfoqsy.message', { messageId: 'm2', role: 'elfoqsy', text: 'Two runs moved on while you were away; one question is yours.', conversationId: 'c1', blocks: [{ type: 'digest', ref: 'g1' }] }, 1700),
        ev('approval.requested', { approvalId: 'a2', runId: 'r2', kind: 'question', question: 'Agent 2 on SHOP-2091 asks: The fix changes what API v1 reports for these carts. Change v1 too, or leave it?', card: { question: 'The fix changes what API v1 reports for these carts. Change v1 too, or leave it?', why: ['v1 is a visible contract: clients read `discount_total`', 'The ticket only names v2'], options: [{ label: 'Leave v1', consequence: 'Fix ships now; v1 split into its own ticket' }, { label: 'Change v1 too', consequence: 'Wider review; touches a public result' }], recommendation: 'Leave v1', sources: [{ kind: 'ticket', ref: 'SHOP-2091' }, { kind: 'code', ref: 'shop-api/src/api/v1/cart.ts:40' }] }, category: 'unsourced', suggestion: { option: 'Leave v1', why: 'The ticket names v2 only, and v1 is read by clients.', sources: [{ kind: 'doc', ref: '7340041', label: 'API v1 cart page' }] }, precedentable: true, requestId: 'q6' }, 1701),
        ev('elfoqsy.message', { messageId: 'm3', role: 'elfoqsy', text: 'Agent 2 has a question for you.', conversationId: 'c1', blocks: [{ type: 'approval', ref: 'a2' }], refs: { runId: 'r2', approvalId: 'a2' } }, 1701),
      ];
      return out;
    },
  };
}
