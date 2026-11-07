// The simulated world of the agreed v1 screens: agents 3, 4 and 5 at work,
// the conversations in Elfoqsy's sidebar, a planning conversation that ends in a brief, and the records behind the
// terminals. Times are minutes before the simulator starts. Data only; simulator.ts turns it into events.
import type { Effort, Finding, MessageBlock, PlanCheck, Progress, StepOutcome, Verdict } from '@elfoqsy/contracts';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A tool call the agent made itself, for its transcript. No finish: still running (or waiting on an approval). */
export interface SimToolCall {
  at: number;
  tool: string;
  title: string;
  where?: string;
  finish?: { after: number; ok: boolean; output: string; stats?: string; diff?: { hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> } };
}

export interface SimSubagent {
  model: string;
  effort: Effort;
  task: string;
  start: number;
  /** Minutes it ran; absent while it still runs. */
  ran?: number;
  tokens: number;
  outcome?: 'done' | 'failed' | 'cancelled';
  cancelledBy?: 'agent' | 'you' | 'orchestrator';
  reason?: string;
  result: string;
  tools: { tool: string; input: string; output: string; ok?: boolean }[];
}

export interface SimStep {
  name: string;
  why: string;
  at: number;
  end?: { at: number; outcome: StepOutcome; note?: string };
}

export interface SimHeartbeat {
  at: number;
  sinceLast: string;
  next: string;
  progress: Progress;
  risks: string[];
}

export interface SimAgent {
  agentNumber: number;
  ticket: string;
  /** Minutes before the start of the simulation. */
  startedAt: number;
  handoffId?: string;
  /** How a started agent works: normal, or read-only ("check KEY"). */
  runMode?: 'normal' | 'read_only';
  conversationId?: string;
  goal: string;
  checks: PlanCheck[];
  passed: { checkId: string; at: number; evidence: string }[];
  steps: SimStep[];
  tools: SimToolCall[];
  subagents: SimSubagent[];
  heartbeats: SimHeartbeat[];
  tokens: number;
  workingMinutes: number;
  /**
   * Its hand-back, from this time: pushed and the draft PR opened and linked in Jira at once (tier 1), then waiting
   * since for alex to approve marking the PR ready for review (tier 2).
   */
  handBack?: { at: number; repo: string; pr: number; commits: number; conversationId: string };
  intervention?: { at: number; reason: string; guidance: string };
  /** Its reasoning between tool calls, as terminal v2 shows it. */
  thoughts?: Array<{ at: number; text: string }>;
  /** Its verdict on the ticket, before it changed code. */
  verdict?: { at: number; verdict: Verdict; reproduced: boolean; summary: string };
}

export interface SimMessage {
  at: number;
  /** A fixed id, for a message a handoff quotes. */
  messageId?: string;
  role: 'you' | 'elfoqsy';
  text: string;
  blocks?: MessageBlock[];
}

export interface SimConversation {
  conversationId: string;
  title: string;
  /** The title it had before Elfoqsy proposed a better one. */
  firstTitle?: string;
  ticket?: string;
  messages: SimMessage[];
}

const API = 'acme/shop-api';
const WORKER = 'acme/shop-worker';

// Agent 4 started about 21 hours ago, yesterday afternoon; it handed back 24 minutes later (pushed, opened its draft PR
// and linked it, all at once) and has waited since for alex to mark the PR ready for review.
const A4 = (DAY - 2.7 * HOUR) / MINUTE;

/** Agent 3 on SHOP-2091: 18 minutes in, at its third step, two sub-agents running, its unit tests running. */
const agent3: SimAgent = {
  agentNumber: 3,
  ticket: 'SHOP-2091',
  startedAt: 18,
  goal: "With cart.split_bundles = false, the bundle discount reduces only the bundle's own items, not the whole cart.",
  checks: [
    { id: 'unit', description: 'The unit tests pass', proof: 'command', command: 'npm run test:unit' },
    { id: 'repro', description: 'A cart with a bundle and one other line discounts only the bundle', proof: 'command', command: 'npx vitest run test/pricing/bundle-discount.spec.ts' },
    { id: 'ci', description: 'CI passes on shop-api', proof: 'ci', repo: API },
  ],
  passed: [{ checkId: 'repro', at: 6.5, evidence: '`npx vitest run test/pricing/bundle-discount.spec.ts` passed at {time}.' }],
  steps: [
    { name: 'Reproduce', why: 'Find out why the whole cart is discounted.', at: 17.8, end: { at: 13.4, outcome: 'done', note: 'Reproduced with a bundle and one other line' } },
    { name: 'Fix the discount', why: 'Guidance from alex: fix the pricing rule itself and leave src/generated alone.', at: 13.4, end: { at: 5, outcome: 'done', note: 'applyBundleDiscount now discounts only the bundle lines when split_bundles is false' } },
    { name: 'Unit tests', why: 'The fix is in; prove it with the unit suite.', at: 5 },
  ],
  tools: [
    { at: 17.2, tool: 'Read', title: 'src/pricing/bundles.ts', where: 'shop-api', finish: { after: 0.05, ok: true, output: '212 lines' } },
    {
      at: 12.1,
      tool: 'Edit',
      title: 'src/pricing/bundles.ts',
      where: 'shop-api',
      finish: {
        after: 0.05,
        ok: true,
        stats: '+2 −1',
        output: '-   const lines = splitBundles ? splitLines(cart, bundle) : cart.lines;\n+   const lines = splitBundles ? splitLines(cart, bundle) : bundleLines(cart, bundle);',
        diff: {
          hunks: [
            {
              oldStart: 86,
              newStart: 86,
              lines: [
                ' export function applyBundleDiscount(cart: Cart, bundle: Bundle, splitBundles: boolean): Cart {',
                '-  const lines = splitBundles ? splitLines(cart, bundle) : cart.lines;',
                '+  const lines = splitBundles ? splitLines(cart, bundle) : bundleLines(cart, bundle);',
                '+  if (lines.length === 0) return cart;',
                '   return withTotals(discountLines(cart, lines, bundle.discount));',
              ],
            },
          ],
        },
      },
    },
    { at: 10.4, tool: 'Bash', title: 'npm run test:unit', where: 'shop-api', finish: { after: 1.6, ok: false, output: 'PASS  test/pricing/bundles.spec.ts  (14)\nFAIL  test/pricing/cart-total.spec.ts › bundle discount when split_bundles=false' } },
    { at: 7.2, tool: 'Bash', title: 'npx vitest run test/pricing/bundle-discount.spec.ts', where: 'shop-api', finish: { after: 0.7, ok: true, output: '✓ discounts only the bundle items: discount 9.00 of 240.00' } },
    {
      at: 6,
      tool: 'Edit',
      title: 'test/pricing/cart-total.spec.ts',
      where: 'shop-api',
      finish: {
        after: 0.05,
        ok: true,
        stats: '+3 −3',
        output: '',
        diff: {
          hunks: [
            {
              oldStart: 41,
              newStart: 41,
              lines: [
                "   it('discounts the bundle when split_bundles is false', async () => {",
                "-    const cart = await price(bundlePlusOne, { splitBundles: false });",
                "-    expect(cart.discount).toBe(24);",
                "-    expect(cart.total).toBe(216);",
                "+    const cart = await price(bundlePlusOne, { splitBundles: false });",
                "+    expect(cart.discount).toBe(9);",
                "+    expect(cart.total).toBe(231);",
                '   });',
              ],
            },
          ],
        },
      },
    },
    { at: 1.2, tool: 'Bash', title: 'npm run test:unit', where: 'shop-api' },
  ],
  subagents: [
    { model: HAIKU, effort: 'low', task: 'Search the pricing code for split_bundles', start: 17.7, ran: 0.9, tokens: 9_000, outcome: 'done', result: '2 places in src/pricing/bundles.ts', tools: [ { tool: 'Grep', input: '"split_bundles" in src/', output: 'src/pricing/bundles.ts:41, :88' }, { tool: 'Read', input: 'src/pricing/bundles.ts', output: '212 lines' } ] },
    { model: SONNET, effort: 'medium', task: 'Reproduce with a bundle and one other line', start: 17.3, ran: 4.1, tokens: 64_000, outcome: 'done', result: 'Reproduced: the whole cart is discounted', tools: [ { tool: 'Write', input: 'test/pricing/bundle-discount.spec.ts', output: '' }, { tool: 'Bash', input: 'npx vitest run test/pricing/bundle-discount.spec.ts', output: 'expected discount 9.00, received 24.00' } ] },
    { model: HAIKU, effort: 'low', task: 'Find other callers of applyBundleDiscount', start: 15.8, ran: 0.9, tokens: 18_000, outcome: 'done', result: '3 callers, none affected', tools: [ { tool: 'Grep', input: '"applyBundleDiscount" in src/', output: '3 matches in src/pricing, src/checkout' } ] },
    { model: HAIKU, effort: 'medium', task: 'Try the integration suite', start: 9, ran: 1.3, tokens: 22_000, outcome: 'cancelled', cancelledBy: 'agent', reason: 'Needs services this host does not have', result: 'Cancelled by Agent 3: needs services this host does not have', tools: [ { tool: 'Bash', input: 'npm run test:integration', output: 'ECONNREFUSED 127.0.0.1:6379', ok: false } ] },
    { model: SONNET, effort: 'medium', task: 'Review the diff', start: 2.5, tokens: 31_000, result: 'Reviewing 2 files', tools: [ { tool: 'Bash', input: 'git diff --stat', output: '2 files changed, 5 insertions(+), 4 deletions(-)' }, { tool: 'Read', input: 'src/pricing/bundles.ts', output: '213 lines' } ] },
    { model: HAIKU, effort: 'low', task: 'Run the unit tests', start: 1.2, tokens: 6_000, result: 'Running npm run test:unit', tools: [ { tool: 'Bash', input: 'npm run test:unit', output: 'running' } ] },
  ],
  heartbeats: [
    { at: 13, sinceLast: 'Reproduced the bug with a bundle and one other line; the whole cart is discounted.', next: 'Limit the discount to the bundle lines in applyBundleDiscount.', progress: 'some', risks: [] },
    { at: 8, sinceLast: 'Fixed the pricing rule; one cart-total spec fails on the old expectation.', next: 'Update the spec and rerun the unit tests.', progress: 'most', risks: ['The integration suite needs Redis, which this host does not have'] },
    { at: 3, sinceLast: 'Updated the cart-total spec; a sub-agent is reviewing the diff.', next: 'Unit tests, then push.', progress: 'nearly', risks: [] },
  ],
  tokens: 412_000,
  workingMinutes: 18,
  intervention: { at: 13.6, reason: 'It was about to edit generated code', guidance: 'Leave src/generated alone; it is rebuilt from the OpenAPI spec. Fix the pricing rule itself.' },
  thoughts: [
    { at: 17.9, text: 'Starting on SHOP-2091. Elfoqsy handed over the ticket and our conversation, with no plan, so I begin by reading the bundle pricing.' },
    { at: 17.15, text: 'When `split_bundles` is false, `applyBundleDiscount()` discounts `cart.lines`, every line of the cart, not only the bundle\'s. I need to see whether that is meant before I call it a bug.' },
    { at: 13.45, text: 'Reproduced with a bundle of 90.00 and one other line of 150.00: the 10% discount comes to 24.00 instead of 9.00. The ticket expects only the bundle\'s items to be discounted, so this is a bug, not intended.' },
    { at: 12.15, text: 'Fixing it in the pricing rule itself, as alex asked, and leaving src/generated alone: the discount takes only the bundle lines.' },
    { at: 10.2, text: 'One cart-total spec still expects the old behaviour, a discount on the whole cart. Updating it to what the ticket asks for.' },
    { at: 2.7, text: 'The fix and the spec are in. A sub-agent reviews the diff while the unit tests run.' },
  ],
  verdict: { at: 13.42, verdict: 'VALID', reproduced: true, summary: "applyBundleDiscount() discounts every cart line when split_bundles is false; the ticket expects only the bundle's items." },
};

/** Agent 4 on SHOP-3546: finished its fix yesterday, handed it back, and has waited since for alex to approve marking its PR ready. */
const agent4: SimAgent = {
  agentNumber: 4,
  ticket: 'SHOP-3546',
  startedAt: A4,
  conversationId: 'sim-conv-429',
  goal: 'Payment provider errors reach checkout with their error_code instead of being dropped.',
  checks: [
    { id: 'unit', description: 'The payments unit tests pass', proof: 'command', command: 'npx vitest run test/payments' },
    { id: 'ci', description: 'CI passes on shop-api', proof: 'ci', repo: API },
  ],
  passed: [{ checkId: 'unit', at: A4 - 21, evidence: '`npx vitest run test/payments` passed at {time}.' }],
  steps: [
    { name: 'Read the client', why: 'Find where PaymentClient drops the 429.', at: A4 - 0.2, end: { at: A4 - 6, outcome: 'done', note: 'error_code is nested inside details' } },
    { name: 'Lift error_code', why: 'Read error_code and error_details from details when the top level has none.', at: A4 - 6, end: { at: A4 - 13, outcome: 'done' } },
    { name: 'Fallback', why: 'The same fallback in the webhook handler, with a generic error when details has no error_code either.', at: A4 - 13, end: { at: A4 - 18, outcome: 'done' } },
    { name: 'Unit tests', why: 'Prove both paths with the 429 payload.', at: A4 - 18, end: { at: A4 - 23, outcome: 'done', note: '41 passed' } },
    { name: 'Hand back', why: 'The fix is committed: push, open the draft PR, link it, and ask for review.', at: A4 - 23 },
  ],
  tools: [
    { at: A4 - 9, tool: 'Edit', title: 'src/payments/client.ts', where: 'shop-api', finish: { after: 0.05, ok: true, stats: '+18 −3', output: '' } },
    { at: A4 - 15, tool: 'Edit', title: 'src/payments/webhook.ts', where: 'shop-api', finish: { after: 0.05, ok: true, stats: '+9 −1', output: '' } },
    { at: A4 - 19.5, tool: 'Bash', title: 'npx vitest run test/payments', where: 'shop-api', finish: { after: 1.5, ok: true, output: '41 passed' } },
    { at: A4 - 22.5, tool: 'Bash', title: 'git commit -m "SHOP-3546 surface payment provider errors"', where: 'shop-api', finish: { after: 0.05, ok: true, output: '' } },
    { at: A4 - 23.5, tool: 'Bash', title: 'git push origin feature/SHOP-3546', where: 'shop-api', finish: { after: 0.03, ok: true, output: 'The orchestrator pushed feature/SHOP-3546 to acme/shop-api at once (tier 1; Elfoqsy told alex).' } },
  ],
  subagents: [
    { model: HAIKU, effort: 'low', task: 'Search PaymentClient for error_code', start: A4 - 0.5, ran: 1.5, tokens: 11_000, outcome: 'done', result: 'error_code is nested inside details', tools: [ { tool: 'Grep', input: '"error_code" in src/payments', output: 'src/payments/client.ts:132' } ] },
    { model: HAIKU, effort: 'low', task: 'Read the 429 payload from integration', start: A4 - 1, ran: 1.2, tokens: 7_000, outcome: 'done', result: 'Payload saved to test/fixtures/provider-429.json', tools: [ { tool: 'Read', input: 'logs/integration/payments.log', output: '1820 lines' } ] },
    { model: SONNET, effort: 'medium', task: 'Check the refunds client for the same pattern', start: A4 - 8, ran: 3, tokens: 41_000, outcome: 'failed', result: 'Failed: timed out searching the refunds module', tools: [ { tool: 'Grep', input: '"error_code" in src/', output: 'timed out after 120s', ok: false } ] },
    { model: SONNET, effort: 'high', task: 'Write tests with the 429 payload', start: A4 - 12, ran: 7.5, tokens: 58_000, outcome: 'done', result: '6 tests added, all passing', tools: [ { tool: 'Write', input: 'test/payments/client.429.spec.ts', output: '' }, { tool: 'Bash', input: 'npx vitest run test/payments/client.429.spec.ts', output: '6 passed' } ] },
  ],
  heartbeats: [
    { at: A4 - 5, sinceLast: 'Found that PaymentClient reads error_code only at the top level.', next: 'Lift error_code and error_details from details.', progress: 'some', risks: [] },
    { at: A4 - 10, sinceLast: 'error_code is lifted; tests for the 429 payload are being written.', next: 'The same fallback in the webhook handler.', progress: 'some', risks: [] },
    { at: A4 - 15, sinceLast: 'Fallback in place in the webhook handler.', next: 'Payments unit tests.', progress: 'most', risks: [] },
    { at: A4 - 20, sinceLast: '41 payments unit tests pass.', next: 'Commit and push for CI.', progress: 'nearly', risks: ['CI has not run on this change yet'] },
  ],
  tokens: 1_100_000,
  workingMinutes: 26,
  handBack: { at: A4 - 23.5, repo: API, pr: 214, commits: 1, conversationId: 'sim-conv-429' },
  thoughts: [
    { at: A4 - 0.1, text: 'Starting on SHOP-3546. Elfoqsy handed over the ticket and our conversation; I begin with PaymentClient and the 429 payload from integration.' },
    { at: A4 - 2.6, text: 'PaymentClient reads `error_code` only at the top level, and a 429 nests it inside `details`, so the error is dropped and checkout sees `payment_info { retried: 0 }`. A bug: the ticket shows both payloads.' },
    { at: A4 - 8.8, text: 'Lifting `error_code` and `error_details` from `details` when the top level has none, so both payload shapes work.' },
    { at: A4 - 23, text: 'The 41 payments unit tests pass, the six new ones with the 429 payload among them. Handing back: push, a draft PR and its Jira link, then the review request.' },
  ],
  verdict: { at: A4 - 2.7, verdict: 'VALID', reproduced: true, summary: 'A 429 nests error_code inside details; PaymentClient reads only the top level, so the error never reaches checkout.' },
};

/** Agent 5 on SHOP-1164: started eight minutes ago from the brief, still investigating. */
const agent5: SimAgent = {
  agentNumber: 5,
  ticket: 'SHOP-1164',
  startedAt: 8,
  handoffId: 'sim-handoff-1164',
  conversationId: 'sim-conv-plan',
  goal: 'An order export always completes, even when the image resizer stalls.',
  checks: [
    { id: 'freeze-test', description: 'A test stalls the image resizer and the export completes with a failure for it', proof: 'command', command: 'npx vitest run test/export/resizer-stall.spec.ts' },
    { id: 'result-tests', description: 'The export tests pass', proof: 'command', command: 'npx vitest run test/export' },
    { id: 'ci', description: 'CI passes on shop-worker', proof: 'ci', repo: WORKER },
  ],
  passed: [],
  steps: [{ name: 'Investigate', why: 'Find where export steps are dispatched and where the export waits.', at: 7.6 }],
  tools: [
    { at: 7.4, tool: 'Read', title: 'src/export/cache.ts', where: 'shop-worker', finish: { after: 0.05, ok: true, output: '140 lines' } },
    { at: 6.8, tool: 'Read', title: 'src/export/wait.ts', where: 'shop-worker', finish: { after: 0.05, ok: true, output: '188 lines' } },
    { at: 1.1, tool: 'Grep', title: '"dispatchStep" in src/', where: 'shop-worker' },
  ],
  subagents: [
    { model: HAIKU, effort: 'low', task: 'Find where export steps are dispatched', start: 3.2, tokens: 14_000, result: 'Searching src/export', tools: [ { tool: 'Grep', input: '"dispatchStep" in src/', output: '5 matches' } ] },
  ],
  heartbeats: [{ at: 2.6, sinceLast: "Read the step cache and the export wait; both match the handoff's facts.", next: 'Find where export steps are dispatched.', progress: 'some', risks: [] }],
  tokens: 285_000,
  workingMinutes: 8,
  thoughts: [
    { at: 7.7, text: "Starting on SHOP-1164 from the handoff. Its facts name the step cache and the export wait; they are leads, so I read both before anything else." },
    { at: 6.6, text: 'The cache and the wait are as the handoff says. Next I need where export steps are dispatched, to see what completes an export when the resizer stalls.' },
  ],
};

export const AGENTS: SimAgent[] = [agent3, agent4, agent5];

/** Runs that ended before the screens' moment: they explain agent numbers 1 and 2. */
export const ENDED_RUNS = [
  { agentNumber: 1, ticket: 'SHOP-3490', startedAt: 2 * DAY / MINUTE, minutes: 34, state: 'succeeded' as const, reason: 'shop-shared #157 was merged. All 2 checks have passing evidence.' },
  { agentNumber: 2, ticket: 'SHOP-2753', startedAt: 1.6 * DAY / MINUTE, minutes: 22, state: 'succeeded' as const, reason: 'shop-api #96 was merged. All 2 checks have passing evidence.' },
];

export const INVESTIGATION = {
  investigationId: 'sim-inv-1164',
  conversationId: 'sim-conv-plan',
  question: 'Why does the order export never complete on SHOP-1164?',
  model: SONNET,
  effort: 'high' as Effort,
  startedAt: 14,
  minutes: 3 + 40 / 60,
  filesRead: 14,
  tokens: 88_000,
  title: "What's actually happening",
  findings: [
    { text: 'Export steps that finish early are cached, so the Redis timeout never starts for the export.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }] },
    { text: 'When the image resizer stalls, nothing else completes the export, so it waits forever for the thumbnails.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/wait.ts:112' }] },
    { text: 'Deleting export-step-timeout reproduces it every time.', sources: [{ kind: 'ticket', ref: 'SHOP-1164' }] },
  ] satisfies Finding[],
};

/** What Elfoqsy handed Agent 5: his words, his constraint and the investigator's findings as facts; no plan. */
export const HANDOFF = {
  handoffId: 'sim-handoff-1164',
  conversationId: 'sim-conv-plan',
  ticket: 'SHOP-1164',
  at: 8,
  mode: 'normal' as const,
  context: [
    { messageId: 'sim-msg-plan-1', role: 'you' as const, text: "SHOP-1164 has slipped 9 sprints. Let's plan a real fix before an agent touches it." },
    { messageId: 'sim-msg-plan-3', role: 'you' as const, text: 'ok, start an agent on it. keep export-step-timeout as it is.' },
  ],
  constraints: [{ text: 'keep export-step-timeout as it is', messageId: 'sim-msg-plan-3' }],
  facts: [
    { text: 'Export steps that finish early are cached, and the per-export Redis timeout does not start for them.', sources: [{ kind: 'code' as const, ref: 'shop-worker/src/export/cache.ts:58' }] },
    { text: 'With the image resizer stalled, the order export stays open.', sources: [{ kind: 'code' as const, ref: 'shop-worker/src/export/wait.ts:112' }] },
    { text: 'The reporter sees it every time with export-step-timeout deleted.', sources: [{ kind: 'ticket' as const, ref: 'SHOP-1164' }] },
  ],
  dropped: [{ text: 'The fix is a timeout per step instead of per export.', reason: 'it reads as a diagnosis or a plan; the handoff says what was observed, and the agent decides the rest' }],
};

export const FACTS = [
  { factId: 'sim-fact-cache', statement: 'Export steps that finish early are cached, so the per-export Redis timeout never starts.', ref: 'shop-worker/src/export/cache.ts:58' },
  { factId: 'sim-fact-wait', statement: 'A stalled image resizer leaves an order export open forever.', ref: 'shop-worker/src/export/wait.ts:112' },
];

// Conversations, newest last within each. Times are minutes before now.
export const CONVERSATIONS: SimConversation[] = [
  {
    conversationId: 'sim-conv-header',
    title: 'Where the webhook header is built',
    messages: [
      { at: 2.2, role: 'you', text: 'show me where the header is built' },
      {
        at: 2.1,
        role: 'elfoqsy',
        text: [
          'Here, in shop-api. Line 27 adds the scheme a second time, and the setting already starts with `Basic` in dev.',
          '',
          '```ts path=shop-api/src/webhook/auth.ts start=24 highlight=27',
          'export function buildHeaders(config: WebhookConfig) {',
          '  const headers: Record<string, string> = {};',
          '  const token = config.token.trim();',
          '  headers.Authorization = `Basic ${token}`;',
          '  return headers;',
          '}',
          '```',
          '',
          '| Environment | Value starts with "Basic" | Set in |',
          '| --- | --- | --- |',
          '| dev | 🔴 Yes | `configmap shop-api-config` |',
          '| staging | 🟢 No | `Secrets Manager` |',
          '| prod | 🟢 No | `Secrets Manager` |',
        ].join('\n'),
      },
    ],
  },
  {
    conversationId: 'sim-conv-review',
    title: 'Weekly review',
    messages: [
      {
        at: 10 * DAY / MINUTE,
        role: 'elfoqsy',
        text: 'Last week: 6 runs, 4 succeeded, 1 stopped without evidence, 1 cancelled. Haiku sub-agents running tests failed 3 times in 10; Sonnet medium did not fail once.',
      },
    ],
  },
  {
    conversationId: 'sim-conv-blackduck',
    title: 'Black Duck findings for 2.22.0',
    ticket: 'SHOP-3472',
    messages: [
      { at: 7 * DAY / MINUTE + 30, role: 'you', text: 'what does Black Duck say about 2.22.0?' },
      {
        at: 7 * DAY / MINUTE + 28,
        role: 'elfoqsy',
        text: 'Two medium findings, both in protobufjs; pinning it to the version in #159 clears them.',
        blocks: [
          { type: 'ticket', ref: 'SHOP-3472' },
          { type: 'code', language: 'json', diff: true, content: '-    "protobufjs": "^7.2.4",\n+    "protobufjs": "7.2.6",' },
        ],
      },
    ],
  },
  {
    conversationId: 'sim-conv-bench',
    title: 'Benchmark v2 pages in Confluence',
    ticket: 'SHOP-3533',
    messages: [
      { at: 3 * DAY / MINUTE + 50, role: 'you', text: 'where should the benchmark v2 pages go?' },
      { at: 3 * DAY / MINUTE + 48, role: 'elfoqsy', text: 'Nothing is decided yet; the ticket still lists both. My suggestion: the SHOP space, under Checkout Benchmark, published by a service account of its own such as svc-shop-bench.', blocks: [{ type: 'ticket', ref: 'SHOP-3533' }] },
    ],
  },
  {
    conversationId: 'sim-conv-keys',
    title: 'Rotate the keys found in tickets',
    messages: [
      { at: DAY / MINUTE + 3.3 * 60 + 2, role: 'you', text: 'which tickets have keys in them?' },
      { at: DAY / MINUTE + 3.3 * 60, role: 'elfoqsy', text: "CORE-18891 has an API key in its description. I won't repeat it; it should be rotated.", blocks: [{ type: 'ticket', ref: 'CORE-18891' }] },
    ],
  },
  {
    conversationId: 'sim-conv-429',
    title: 'Why does checkout drop 429 errors?',
    ticket: 'SHOP-3546',
    messages: [
      { at: A4 + 4, role: 'you', text: 'why does checkout drop 429 errors from the payment provider?' },
      { at: A4 + 3, role: 'elfoqsy', text: 'PaymentClient reads error_code only at the top level, and a 429 nests it inside details, so the error is dropped and checkout sees payment_info { retried: 0 }.', blocks: [{ type: 'ticket', ref: 'SHOP-3546' }] },
      { at: A4 + 1, role: 'you', text: 'fix it' },
      { at: A4 + 0.5, role: 'elfoqsy', text: 'Agent 4 is on it.', blocks: [{ type: 'progress', ref: 'sim-run-4' }] },
    ],
  },
  {
    conversationId: 'sim-conv-checkin',
    title: 'Sprint 52 check-in',
    messages: [
      { at: 5 * 60 + 16, role: 'you', text: "how's the sprint looking?" },
      { at: 5 * 60 + 14, role: 'elfoqsy', text: '7 of 22 points are done. SHOP-3049 is blocked, and SHOP-2091 has slipped 12 sprints; Agent 3 can take it.', blocks: [{ type: 'sprint', ref: 'SHOP Sprint 52' }] },
    ],
  },
  {
    conversationId: 'sim-conv-plan',
    title: 'Plan the SHOP-1164 stall fix',
    firstTitle: 'SHOP-1164 has slipped 9 sprints',
    ticket: 'SHOP-1164',
    messages: [
      { at: 14, messageId: 'sim-msg-plan-1', role: 'you', text: "SHOP-1164 has slipped 9 sprints. Let's plan a real fix before an agent touches it." },
      { at: 13.9, role: 'elfoqsy', text: 'On it. I sent an investigator into the export worker first.', blocks: [{ type: 'findings', ref: 'sim-inv-1164' }] },
      { at: 9.2, role: 'elfoqsy', text: 'Hypothesis: a timeout per step would close it. The agent decides that from the code, not me.' },
      { at: 9, messageId: 'sim-msg-plan-3', role: 'you', text: 'ok, start an agent on it. keep export-step-timeout as it is.' },
      { at: 8, role: 'elfoqsy', text: "Agent 5 is on it, from the handoff: your words, your constraint, and the investigator's findings as facts. Say stop and I'll stop it.", blocks: [{ type: 'handoff', ref: 'sim-handoff-1164' }] },
    ],
  },
];

export const USAGE = { fiveHourPct: 42, sevenDayPct: 61, resetsInMinutes: 2.6 * 60 };

/** Agents beyond the three of the agreed screens, generated to test crowding (as the prototypes' count does). */
export function crowdAgents(count: number): (SimAgent & { mode: 'work' | 'failed' | 'silent' | 'spent' })[] {
  const models: [string, Effort][] = [[HAIKU, 'low'], [SONNET, 'medium'], [HAIKU, 'medium'], [SONNET, 'high'], [OPUS, 'high']];
  const names = ['Investigate', 'Find the cause', 'Fix', 'Unit tests', 'Push', 'Review'];
  const out: (SimAgent & { mode: 'work' | 'failed' | 'silent' | 'spent' })[] = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + (i % 5);
    const mode = i === 3 ? 'failed' : i === 5 ? 'silent' : i === 7 ? 'spent' : 'work';
    const started = 6 + (i * 7) % 40;
    const steps = names.slice(0, n).map((name, k) => ({
      name,
      why: k === 0 ? 'Start from the ticket and the linked issues.' : `On to ${name.toLowerCase()}.`,
      at: started - k * (started / (n + 1)),
      ...(k < n - 1 ? { end: { at: started - (k + 1) * (started / (n + 1)), outcome: 'done' as const } } : {}),
    }));
    const subs: SimSubagent[] = mode === 'work' || mode === 'spent'
      ? Array.from({ length: 1 + (i % 3) }, (_, j) => {
          const [model, effort] = models[(i + j) % models.length]!;
          return { model, effort, task: j === 0 ? 'Search for the handler' : 'Run the unit tests', start: Math.max(0.5, started / 3 - j), tokens: 8_000 + j * 5_000, result: 'Working', tools: [{ tool: 'Grep', input: `"${3601 + i}" in the repos`, output: '4 matches' }] };
        })
      : [];
    out.push({
      agentNumber: 6 + i,
      ticket: `SHOP-${3601 + i}`,
      startedAt: started,
      goal: 'Fix the ticket and prove it with the unit tests.',
      checks: [{ id: 'unit', description: 'The unit tests pass', proof: 'command', command: 'npm run test:unit' }],
      passed: [],
      steps,
      tools: [
        { at: started - 0.5, tool: 'Read', title: 'the ticket and linked issues', finish: { after: 0.05, ok: true, output: '' } },
        { at: started - 1, tool: 'Grep', title: `"${3601 + i}" in the repos`, finish: { after: 0.1, ok: true, output: '4 matches' } },
        mode === 'failed'
          ? { at: 2, tool: 'Bash', title: 'npm run test:unit', where: 'shop-api', finish: { after: 1, ok: false, output: 'FAIL  integration › upload' } }
          : { at: 1, tool: 'Bash', title: 'npm run test:unit', where: 'shop-api' },
      ],
      subagents: subs,
      heartbeats: [],
      tokens: 100_000 + (6 + i) * 37_000,
      workingMinutes: started,
      mode,
    });
  }
  return out;
}

/** An agent started live in simulate mode, when someone types "do SHOP-1234" into a pane or a conversation. */
export function startedAgent(agentNumber: number, ticket: string, conversationId: string): SimAgent {
  return {
    agentNumber,
    ticket,
    startedAt: 0.1,
    conversationId,
    goal: 'Fix the ticket and prove it with the unit tests.',
    checks: [{ id: 'unit', description: 'The unit tests pass', proof: 'command', command: 'npm run test:unit' }],
    passed: [],
    steps: [{ name: 'Investigate', why: 'Start from the ticket and the linked issues.', at: 0.08 }],
    tools: [{ at: 0.065, tool: 'Read', title: 'the ticket and linked issues', finish: { after: 0.005, ok: true, output: '' } }],
    subagents: [{ model: HAIKU, effort: 'low', task: 'Search for the handler', start: 0.07, tokens: 4_000, result: 'Searching', tools: [] }],
    heartbeats: [],
    tokens: 12_000,
    workingMinutes: 0,
  };
}
