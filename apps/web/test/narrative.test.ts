// The ticket narrative, "What we know" (N1): written from what the agent reported, with a source on each section, and nothing
// without one; the PR description and Jira's Root cause and Solution come from it; his tick counts only while it is current.
import { describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { buildNarrative, foldAll, jiraRootCause, jiraSolution, narrativeMarkdown, narrativeRead, narrativeRun, prDescription, type Narrative } from '@elfoqsy/state';
import { eventFactory, mockSprint } from './helpers';

const { open } = mockSprint();
const ticket = open.find((t) => t.key === 'SHOP-3546')!;
const RUN = 'r4';

/** The events of one agent's run up to a given stage, in the order the agent reports them. */
function run(upTo: 'created' | 'understood' | 'verdict' | 'reproduced' | 'cause' | 'fixed' | 'verified' | 'handed_back', extra: AnyEnvelope[] = []): AnyEnvelope[] {
  const e = eventFactory();
  const stages = ['created', 'understood', 'verdict', 'reproduced', 'cause', 'fixed', 'verified', 'handed_back'] as const;
  const upto = stages.indexOf(upTo);
  const events: AnyEnvelope[] = [
    e('ticket.synced', { ticket }, 0),
    e('run.created', { runId: RUN, ticket: ticket.key, worktree: '/w', branch: 'feature/SHOP-3546', agentNumber: 4, repos: ['o/shop-api'] }, 1),
    e('run.state_changed', { runId: RUN, state: 'running' }, 1),
  ];
  if (upto >= 1) events.push(e('run.understanding', { runId: RUN, claim: 'Errors are dropped when the provider replies 7', input: 'a payment_response with error_code 7', actual: 'the reply is dropped', expected: 'a TIMEOUT result for that order_id', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }, 60));
  if (upto >= 2) {
    events.push(
      e('run.verdict', {
        runId: RUN,
        verdict: 'VALID',
        reproduced: false,
        summary: 'Replies with an error and no scan result are dropped.',
        symptom: 'Errors are dropped',
        sibling: 'The warning path lifts it.',
        siblingAt: { kind: 'code', ref: 'shop-api/src/map.ts:31', label: 'the warning path' },
        chain: [
          { ref: 'shop-api/src/handle.ts:12', role: 'entry' },
          { ref: 'shop-api/src/map.ts:44', role: 'fault', note: 'drops the error' },
        ],
        findings: [{ text: 'map.ts drops it', sources: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] }],
        evidence: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }],
      }, 120),
    );
  }
  if (upto >= 3) {
    events.push(
      e('run.test_run', { runId: RUN, toolUseId: 't1', command: 'npx jest test/map.test.ts', ok: false, summary: 'FAIL test/map.test.ts\n  ✕ lifts error_code', passed: 3, failed: 1, failedNames: ['lifts error_code'] }, 180),
      e('run.reproduction', { runId: RUN, how: 'A unit test sends an error result through the real mapper.', environment: 'local, jest', test: { path: 'shop-api/test/map.test.ts', name: 'lifts error_code' }, command: 'npx jest test/map.test.ts', requestIds: ['req-1'] }, 185),
      e('run.verdict', { runId: RUN, verdict: 'VALID', reproduced: true, summary: 'Reproduced.', symptom: 'Errors are dropped', sibling: 'The warning path lifts it.', findings: [{ text: 'f', sources: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] }] }, 186),
    );
  }
  if (upto >= 4) events.push(e('run.root_cause', { runId: RUN, text: 'map.ts keeps error_code nested on the error path.', lines: [{ kind: 'code', ref: 'shop-api/src/map.ts:44' }] }, 240));
  if (upto >= 5) {
    events.push(
      e('run.assumption', { runId: RUN, assumptionId: 'as1', text: 'Return 422 for a bad error_code.', evidence: [{ kind: 'ticket', ref: 'SHOP-3546' }], flag: 'contract', by: 'agent' }, 250),
      e('run.approach', { runId: RUN, approach: 'Lift error_code on the error path too.', alternatives: [{ option: 'Strip it on load', rejectedBecause: 'Other readers expect it there.' }] }, 255),
      e('run.pushed', { runId: RUN, repos: [{ repo: 'o/shop-api', branch: 'feature/SHOP-3546', head: '3f2a1c9aa', commits: [{ sha: '3f2a1c9', subject: 'SHOP-3546: lift error_code' }], files: [{ path: 'src/map.ts', added: 4, removed: 1 }] } ] }, 300),
    );
  }
  if (upto >= 6) {
    events.push(
      e('run.test_run', { runId: RUN, toolUseId: 't2', command: 'npx jest test/map.test.ts', ok: true, summary: 'Tests: 4 passed', passed: 4 }, 320),
      e('run.test_run', { runId: RUN, toolUseId: 't3', command: 'npm run test:unit', ok: true, summary: 'Tests: 212 passed', passed: 212 }, 330),
      e('pr.synced', { pr: { repo: 'o/shop-api', number: 140, state: 'draft', ticket: ticket.key, url: 'https://github.com/o/shop-api/pull/140', checks: 'success', title: 'feature/SHOP-3546: lift error_code', review: 'none' } }, 340),
      e('ci.status', { repo: 'o/shop-api', pr: 140, sha: 'abc1234def', status: 'success', url: '' }, 345),
      e('run.reported', { runId: RUN, result: 'succeeded', summary: 'Fixed.', notVerified: ['A real provider on dev'], waitingOnYou: ['Mark the PR ready'] }, 350),
    );
  }
  if (upto >= 7) events.push(e('run.handed_back', { runId: RUN, message: 'The fix is on the PR.' }, 360));
  return [...events, ...extra];
}

const build = (events: AnyEnvelope[]): Narrative => buildNarrative(foldAll(events), RUN)!;
const section = (n: Narrative, key: string) => n.sections.find((s) => s.key === key)!;

describe('the narrative: seven sections, each from a report, each with its source', () => {
  it('shows nothing it was not told: before any report every section waits for what comes before it', () => {
    const n = build(run('created'));
    expect(n.sections.map((s) => [s.title, s.stage, s.waitsFor])).toEqual([
      ['Understanding', 'current', 'After the agent has read the ticket'],
      ['Verdict', 'waiting', 'After understanding'],
      ['Reproduction', 'waiting', 'After the verdict'],
      ['Root cause', 'waiting', 'After reproduction'],
      ['Fix', 'waiting', 'After the root cause'],
      ['Verification', 'waiting', 'After the fix'],
      ['Hand-back', 'waiting', 'After verification'],
    ]);
    expect(n.sections.every((s) => s.blocks.length === 0 && !s.source && !s.text)).toBe(true);
  });

  it('writes understanding and the verdict with the chain to the fault and the working case, and says it is not reproduced yet', () => {
    const n = build(run('verdict'));
    expect(section(n, 'understanding')).toMatchObject({ stage: 'done', source: expect.stringMatching(/^Agent 4 · understanding, \d\d:\d\d · SHOP-3546$/) });
    expect(section(n, 'understanding').markdown).toContain('- Input: a payment_response with error_code 7');
    const verdict = section(n, 'verdict');
    expect(verdict.markdown).toContain('**VALID, not reproduced yet.** Replies with an error and no scan result are dropped.');
    expect(verdict.markdown).toContain('1. `shop-api/src/handle.ts:12`, where it enters');
    expect(verdict.markdown).toContain('2. `shop-api/src/map.ts:44`, **the fault**: drops the error');
    expect(verdict.markdown).toContain('Compared with a case that works: The warning path lifts it. (`shop-api/src/map.ts:31` (the warning path))');
    expect(verdict.source).toMatch(/^Agent 4 · verdict, \d\d:\d\d · map\.ts:44$/);
    // Reproduction is the current stage, and says what is known: not reproduced yet.
    expect(section(n, 'reproduction')).toMatchObject({ stage: 'current' });
    expect(section(n, 'reproduction').markdown).toBe('Not reproduced yet: the verdict says so, and the agent has not reported a reproduction.');
  });

  it('takes the failing evidence of a reproduction from the failing run the orchestrator saw, never from the agent', () => {
    const n = build(run('reproduced'));
    const r = section(n, 'reproduction');
    expect(r.stage).toBe('done');
    expect(r.markdown).toContain('- Test: `shop-api/test/map.test.ts`, "lifts error_code"');
    expect(r.markdown).toContain('- Request ids: `req-1`');
    expect(r.markdown).toContain('(1 failed, 3 passed):\n\n```\nFAIL test/map.test.ts\n  ✕ lifts error_code\n```');
    expect(r.source).toMatch(/· test run at \d\d:\d\d$/);
    // A command the orchestrator never saw failing has no evidence, and says so.
    const none = foldAll(run('created').concat(run('reproduced').filter((x) => x.type === 'run.verdict' || x.type === 'run.understanding' || x.type === 'run.reproduction')));
    void none;
  });

  it('calls a cause a hypothesis until the agent reports the root cause, and shows the exact lines after', () => {
    const e = eventFactory();
    const base = run('reproduced');
    const withHypothesis = [...base, e('run.hypothesis', { runId: RUN, hypothesisId: 'h1', text: 'The config merge adds the scheme.', status: 'open' }, 200), e('run.hypothesis', { runId: RUN, hypothesisId: 'h2', text: 'The cache hides it.', status: 'disproved' }, 201)].map((x, i) => ({ ...x, seq: i + 1 }));
    const pending = section(build(withHypothesis), 'root_cause');
    expect(pending).toMatchObject({ stage: 'current' });
    expect(pending.markdown).toContain('Not found yet. What the agent is testing, as hypotheses:');
    expect(pending.markdown).toContain('- Hypothesis (open): The config merge adds the scheme.');
    expect(pending.markdown).not.toContain('The cache hides it'); // disproved ones are not what we know
    const done = section(build(run('cause')), 'root_cause');
    expect(done).toMatchObject({ stage: 'done', markdown: 'map.ts keeps error_code nested on the error path.\n\nThe lines: `shop-api/src/map.ts:44`' });
  });

  it('writes the fix from the approach, what was rejected, the change per file from git, and the decisions it made', () => {
    const fix = section(build(run('fixed')), 'fix');
    expect(fix.stage).toBe('done');
    expect(fix.markdown).toContain('- Approach: Lift error_code on the error path too.');
    expect(fix.markdown).toContain('- Alternatives rejected:\n  - Strip it on load: Other readers expect it there.');
    expect(fix.markdown).toContain('  - `src/map.ts` +4 −1 (shop-api at 3f2a1c9)');
    expect(fix.markdown).toContain('- Decisions it made:\n  - [contract] Return 422 for a bad error_code. (SHOP-3546)');
    expect(fix.markdown).toContain('- Flags for you: contract.');
    expect(fix.source).toMatch(/^Agent 4 · fix, \d\d:\d\d · commit 3f2a1c9, 1 file$/);
  });

  it('says "none recorded" when the agent recorded no alternatives, and nothing pushed yet when nothing is', () => {
    const e = eventFactory();
    const events = [...run('cause'), e('run.approach', { runId: RUN, approach: 'Lift it.', alternatives: [] }, 255)].map((x, i) => ({ ...x, seq: i + 1 }));
    const fix = section(build(events), 'fix');
    expect(fix.stage).toBe('current'); // not done: nothing was pushed
    expect(fix.markdown).toContain('- Alternatives rejected: none recorded.');
    expect(fix.markdown).toContain('- Changes: nothing pushed yet.');
  });

  it('writes verification from the runs the orchestrator saw: failing before and passing after, the full suite, CI, and what was not verified', () => {
    const v = section(build(run('verified')), 'verification');
    expect(v.stage).toBe('done');
    expect(v.markdown).toMatch(/- Failing before, passing after:\n {2}- `npx jest test\/map\.test\.ts`: failed at \d\d:\d\d \(1 failed, 3 passed\), passed at \d\d:\d\d \(4 passed\)/);
    expect(v.markdown).toMatch(/- Also run:\n {2}- Full suite: `npm run test:unit`: passed at \d\d:\d\d \(212 passed\)/);
    expect(v.markdown).toMatch(/- CI on shop-api#140: passed at abc1234, \d\d:\d\d\./);
    expect(v.markdown).toContain('- Not verified:\n  - A real provider on dev');
    expect(v.source).toMatch(/^Agent 4 · verification, \d\d:\d\d · CI run on shop-api#140$/);
  });

  it('writes the hand-back: the PR with its title and review state, what waits for him, and the last message labelled', () => {
    const n = build(run('handed_back'));
    const h = section(n, 'hand_back');
    expect(h.stage).toBe('done');
    expect(h.markdown).toContain('- PR `shop-api#140` "feature/SHOP-3546: lift error_code": a draft, CI passed, no review yet.');
    expect(h.markdown).toContain('- Its report: succeeded. Fixed.');
    expect(h.markdown).toContain('- Waits for you:\n  - Mark the PR ready');
    expect(h.markdown).toContain('  - Decide at review: contract (Return 422 for a bad error_code.)');
    expect(h.markdown).toContain('  - Mark the PR ready for review, after reading this');
    expect(h.markdown).toContain('Its last message, as it ended its turn:\n\n> The fix is on the PR.');
    expect(h.source).toMatch(/^Agent 4 · hand-back, \d\d:\d\d · shop-api#140$/);
    expect(n.handBack).toMatchObject({ handedBack: true, read: false });
    expect(n.handBack.drafts.map((p) => p.number)).toEqual([140]);
  });

  it('a story has no reproduction or root cause, and a stopping verdict ends it at the verdict', () => {
    const e = eventFactory();
    const story = foldAll([
      e('ticket.synced', { ticket }, 0),
      e('run.created', { runId: RUN, ticket: ticket.key, worktree: '/w', branch: 'b', agentNumber: 4 }, 1),
      e('run.verdict', { runId: RUN, verdict: 'NEW_BEHAVIOR', reproduced: false, summary: 'The list is not shown yet.', example: { input: 'GET /shipping-options', output: '200 with the list' }, findings: [{ text: 't', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }] }, 2),
    ]);
    const n = buildNarrative(story, RUN)!;
    expect(section(n, 'reproduction').markdown).toBe('Not applicable: this is a new behaviour, not a failure to reproduce.');
    expect(section(n, 'root_cause').markdown).toBe('Not applicable: this is a new behaviour.');
    expect(section(n, 'verdict').markdown).toContain("Expected behaviour, the agent's own decision, flagged for you: GET /shipping-options → 200 with the list");
    const stopped = foldAll([
      e('ticket.synced', { ticket }, 0),
      e('run.created', { runId: RUN, ticket: ticket.key, worktree: '/w', branch: 'b', agentNumber: 4 }, 1),
      e('run.verdict', { runId: RUN, verdict: 'EXPECTED_BEHAVIOR/INVALID', reproduced: false, summary: 'By design.', ticketComment: 'This is by design.', findings: [{ text: 't', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }] }, 2),
      e('run.state_changed', { runId: RUN, state: 'stopped', reason: 'Its verdict.' }, 3),
    ]);
    const s = buildNarrative(stopped, RUN)!;
    expect(s.sections.slice(2, 6).every((x) => x.stage === 'done' && x.markdown === 'Not applicable: the run stopped at its verdict.')).toBe(true);
    expect(section(s, 'hand_back').markdown).toContain('Approve or change its comment on the ticket');
  });

  it('is the same text for the same log, and Markdown copies all seven sections with their sources', () => {
    const events = run('handed_back');
    expect(narrativeMarkdown(build(events))).toBe(narrativeMarkdown(build(events)));
    const md = narrativeMarkdown(build(events));
    for (const t of ['## 1. Understanding', '## 2. Verdict', '## 3. Reproduction', '## 4. Root cause', '## 5. Fix', '## 6. Verification', '## 7. Hand-back']) expect(md).toContain(t);
    expect(md).toContain('Kept by Elfoqsy from Agent 4\'s reports.');
    expect(md).toMatch(/_Agent 4 · fix, \d\d:\d\d · commit 3f2a1c9, 1 file_/);
  });

  it('picks the ticket’s latest real run, and the tester’s only when there is no other', () => {
    const e = eventFactory();
    const state = foldAll([
      e('ticket.synced', { ticket }, 0),
      e('run.created', { runId: 'old', ticket: ticket.key, worktree: '/w', branch: 'b', agentNumber: 1 }, 1),
      e('run.created', { runId: 'tester', ticket: ticket.key, worktree: '/w', branch: 'b', agentNumber: 2, test: true }, 5),
    ]);
    expect(narrativeRun(state, ticket.key)?.runId).toBe('old');
    expect(narrativeRun(foldAll([e('ticket.synced', { ticket }, 0), e('run.created', { runId: 'tester', ticket: ticket.key, worktree: '/w', branch: 'b', agentNumber: 2, test: true }, 5)]), ticket.key)?.runId).toBe('tester');
  });
});

describe('the gate: his tick counts only while the narrative is what he read', () => {
  const tick = (by: 'you' | 'tester', events: AnyEnvelope[]): AnyEnvelope[] => {
    const e = eventFactory();
    const all = [...events, e('narrative.read', { runId: RUN, ticket: ticket.key, by }, 400)].map((x, i) => ({ ...x, seq: i + 1 }));
    return all;
  };

  it('is not read until he ticks, and the tester’s tick is the tester’s', () => {
    const base = run('handed_back');
    expect(narrativeRead(foldAll(base).runs[RUN]!)).toEqual({ read: false, changedSinceRead: false, testerRead: false });
    expect(narrativeRead(foldAll(tick('you', base)).runs[RUN]!)).toEqual({ read: true, changedSinceRead: false, testerRead: false });
    expect(narrativeRead(foldAll(tick('tester', base)).runs[RUN]!)).toEqual({ read: false, changedSinceRead: false, testerRead: true });
  });

  it('un-reads itself when the agent says more afterwards', () => {
    const e = eventFactory();
    const ticked = tick('you', run('handed_back'));
    const more = [...ticked, e('run.root_cause', { runId: RUN, text: 'A different cause.', lines: [{ kind: 'code', ref: 'a.ts:1' }] }, 500)].map((x, i) => ({ ...x, seq: i + 1 }));
    const read = narrativeRead(foldAll(more).runs[RUN]!);
    expect(read).toEqual({ read: false, changedSinceRead: true, testerRead: false });
    expect(build(more).handBack).toMatchObject({ read: false, changedSinceRead: true });
  });
});

describe('what is written from the narrative: the PR description and Jira’s Root cause and Solution', () => {
  it('asks for the report that is missing, by name, instead of writing something', () => {
    expect(prDescription(build(run('verdict')))).toEqual({ ok: false, missing: 'report_root_cause: the PR description gives the root cause, from your report' });
    expect(prDescription(build(run('cause')))).toEqual({ ok: false, missing: 'report_approach: the PR description gives your approach, from your report' });
    expect(prDescription(build(run('created')))).toEqual({ ok: false, missing: 'report_understanding: the PR description starts from your reported understanding' });
    expect(jiraRootCause(build(run('reproduced')))).toEqual({ ok: false, missing: 'report_root_cause: Root cause is written from your reported root cause (its text and the exact lines)' });
    expect(jiraSolution(build(run('cause')))).toEqual({ ok: false, missing: 'report_approach: Solution is written from your reported approach' });
    // The approach alone is not a Solution: what it changed comes from the push.
    const e = eventFactory();
    const approachOnly = [...run('cause'), e('run.approach', { runId: RUN, approach: 'Lift it.', alternatives: [] }, 255)].map((x, i) => ({ ...x, seq: i + 1 }));
    expect(jiraSolution(build(approachOnly))).toEqual({ ok: false, missing: 'a push: Solution lists what the push carried, and nothing is pushed yet' });
  });

  it('writes only what the sections say, and the decisions under "Decisions I made", flagged ones first', () => {
    const pr = prDescription(build(run('verified')));
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    // Clock times differ with the zone the suite runs in.
    expect(pr.text.replace(/\d\d:\d\d/g, 'HH:MM')).toBe(
      [
        'SHOP-3546',
        '',
        '## Problem',
        '',
        '- The ticket says: Errors are dropped when the provider replies 7',
        '- Input: a payment_response with error_code 7',
        '- Actual: the reply is dropped',
        '- Expected: a TIMEOUT result for that order_id',
        '',
        '## Root cause',
        '',
        'map.ts keeps error_code nested on the error path.',
        'Lines: shop-api/src/map.ts:44',
        '',
        '## Fix',
        '',
        'Approach: Lift error_code on the error path too.',
        'Alternatives rejected:',
        '- Strip it on load: Other readers expect it there.',
        'Changes:',
        '- src/map.ts +4 -1 (shop-api at 3f2a1c9)',
        '',
        '## Verification',
        '',
        '- Failing before, passing after:',
        '  - npx jest test/map.test.ts: failed at HH:MM (1 failed, 3 passed), passed at HH:MM (4 passed)',
        '- Also run:',
        '  - Full suite: npm run test:unit: passed at HH:MM (212 passed)',
        '- CI on shop-api#140: passed at abc1234.',
        '- Not verified:',
        '  - A real provider on dev',
        '',
        '## Decisions I made',
        '',
        '- [contract] Return 422 for a bad error_code. (SHOP-3546)',
        '',
        'Jira: SHOP-3546',
        '',
      ].join('\n'),
    );
  });

  it('keeps the PR text free of anything the sections do not hold, and lists decisions one point each', () => {
    const pr = prDescription(build(run('verified')));
    if (!pr.ok) throw new Error(pr.missing);
    expect(pr.text).toContain('## Decisions I made\n\n- [contract] Return 422 for a bad error_code. (SHOP-3546)');
    expect(pr.text.endsWith('\nJira: SHOP-3546\n')).toBe(true);
    const cause = jiraRootCause(build(run('verified')));
    expect(cause).toEqual({ ok: true, text: 'map.ts keeps error_code nested on the error path.\nLines: shop-api/src/map.ts:44' });
    const solution = jiraSolution(build(run('verified')));
    expect(solution).toEqual({ ok: true, text: 'Approach: Lift error_code on the error path too.\nAlternatives rejected:\n- Strip it on load: Other readers expect it there.\nChanges:\n- src/map.ts +4 -1 (shop-api at 3f2a1c9)' });
  });
});

describe('the narrative shows what the review said of each acceptance criterion, every NOT MET for him to decide (19 October)', () => {
  const criteria = [
    { n: 1, status: 'met' as const, text: 'error_code is at the top', why: 'map.ts:44' },
    { n: 2, status: 'not_met' as const, text: 'a 429 keeps its details', why: 'map.ts:51 drops them' },
    { n: 3, status: 'cannot_tell' as const, text: 'a real provider answers', why: 'only a run on dev settles it' },
  ];
  /** The run at verification, then the extra events in the order given, numbered afresh so each follows the one before. */
  const narrativeWith = (...more: Array<(e: ReturnType<typeof eventFactory>) => AnyEnvelope>) => {
    const e = eventFactory();
    const all = [...run('verified'), ...more.map((m) => m(e))].map((x, i) => ({ ...x, seq: i + 1 }));
    return { events: all, narrative: buildNarrative(foldAll(all), RUN)!, state: foldAll(all) };
  };
  const reviewed = (list = criteria) => (e: ReturnType<typeof eventFactory>) => e('run.criteria_reviewed', { runId: RUN, criteria: list }, 355);
  const reportedWith = (unmet: Array<{ n: number; why: string }>) => (e: ReturnType<typeof eventFactory>) =>
    e('run.reported', { runId: RUN, result: 'succeeded', summary: 'Fixed.', notVerified: [], waitingOnYou: ['Mark the PR ready'], unmet }, 358);

  it('puts each NOT MET in Verification, with the one it could not tell and what was met, and says the agent gave no reason', () => {
    const v = section(narrativeWith(reviewed()).narrative, 'verification');
    expect(v.markdown).toContain('- Acceptance criteria, as the review judged them (1 met, 1 NOT MET, 1 it could not tell):');
    expect(v.markdown).toContain('  - **NOT MET** 2. a 429 keeps its details: map.ts:51 drops them. The agent gave no reason: for you to decide.');
    expect(v.markdown).toContain('  - Could not tell 3. a real provider answers: only a run on dev settles it.');
    expect(v.markdown).toContain('  - Met: 1.');
    // The blocks the screen draws are the same items.
    const list = v.blocks.find((b) => b.kind === 'list') as { items: Array<{ md: string; children?: Array<{ md: string }> }> };
    const head = list.items.find((i) => i.md.startsWith('Acceptance criteria'))!;
    expect(head.children!.map((c) => c.md)).toEqual([
      '**NOT MET** 2. a 429 keeps its details: map.ts:51 drops them. The agent gave no reason: for you to decide.',
      'Could not tell 3. a real provider answers: only a run on dev settles it.',
      'Met: 1.',
    ]);
  });

  it('shows the agent’s reason beside the NOT MET it explained after the review, and drops it when a later review judges again', () => {
    const why = 'The provider rate limit lives in a service this run cannot reach.';
    const explained = section(narrativeWith(reviewed(), reportedWith([{ n: 2, why }])).narrative, 'verification');
    expect(explained.markdown).toContain(`**NOT MET** 2. a 429 keeps its details: map.ts:51 drops them. The agent says it cannot be met here: ${why}`);
    expect(explained.markdown).not.toContain('The agent gave no reason');
    // Said before the review, or then judged again: no longer an answer.
    const before = narrativeWith((e) => reportedWith([{ n: 2, why }])(e), reviewed());
    expect(section(before.narrative, 'verification').markdown).toContain('The agent gave no reason: for you to decide.');
    const again = narrativeWith(reviewed(), reportedWith([{ n: 2, why }]), reviewed());
    expect(section(again.narrative, 'verification').markdown).toContain('The agent gave no reason: for you to decide.');
  });

  it('shows the latest review only, none stated when the ticket states none, and nothing before a review', () => {
    expect(section(narrativeWith().narrative, 'verification').markdown).not.toContain('Acceptance criteria');
    const met = criteria.map((c) => ({ ...c, status: 'met' as const }));
    const latest = section(narrativeWith(reviewed(), reviewed(met)).narrative, 'verification').markdown;
    expect(latest).toContain('(3 met, 0 NOT MET, 0 it could not tell)');
    expect(latest).not.toContain('**NOT MET**');
    expect(section(narrativeWith(reviewed([])).narrative, 'verification').markdown).toContain('Acceptance criteria: the review found none stated in the ticket.');
  });

  it('is not in the plain text of Verification, so Jira’s Solution never says it, and an unexplained NOT MET is not in the PR description: GitHub is the team’s, and that is his to decide', () => {
    const { narrative } = narrativeWith(reviewed());
    expect(section(narrative, 'verification').text).not.toMatch(/NOT MET|criteri/i);
    expect(narrative.explainedUnmet).toEqual([]);
    const pr = prDescription(narrative);
    expect(pr.ok).toBe(true);
    if (pr.ok) expect(pr.text).not.toMatch(/NOT MET|acceptance criteri|Not verified here/i);
    const solution = jiraSolution(narrative);
    if (solution.ok) expect(solution.text).not.toMatch(/NOT MET|acceptance criteri/i);
  });

  it('puts the NOT MET the agent explained in the PR description under "Not verified here", and only those', () => {
    const why = 'The provider rate limit lives in a service this run cannot reach.';
    // Two NOT MET, one explained after the review.
    const two = [...criteria, { n: 4, status: 'not_met' as const, text: 'the list is sorted', why: 'map.ts:60 does not sort' }];
    const { narrative } = narrativeWith(reviewed(two), reportedWith([{ n: 2, why }]));
    expect(narrative.explainedUnmet).toEqual([{ n: 2, text: 'a 429 keeps its details', why }]);
    const pr = prDescription(narrative);
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    expect(pr.text).toContain(`## Not verified here\n\n- Acceptance criterion: a 429 keeps its details. Not met here: ${why}\n`);
    // After Verification and before the decisions; the one he has not had explained, and the review's own words, are not in it.
    expect(pr.text.indexOf('## Verification')).toBeLessThan(pr.text.indexOf('## Not verified here'));
    expect(pr.text.indexOf('## Not verified here')).toBeLessThan(pr.text.indexOf('## Decisions I made'));
    expect(pr.text).not.toContain('the list is sorted');
    expect(pr.text).not.toContain('map.ts:51 drops them');
    expect(pr.text).not.toMatch(/NOT MET/);
  });

  it('says nothing under "Not verified here" when nothing was explained, and drops it when a later review judges again', () => {
    const why = 'The provider rate limit lives in a service this run cannot reach.';
    const none = prDescription(narrativeWith(reviewed()).narrative);
    expect(none.ok && none.text).not.toContain('Not verified here');
    const again = prDescription(narrativeWith(reviewed(), reportedWith([{ n: 2, why }]), reviewed()).narrative);
    expect(again.ok && again.text).not.toContain('Not verified here');
  });

  it('makes his tick stale: a review after he read it is something new to read before the PR is ready', () => {
    const e = eventFactory();
    const base = run('handed_back');
    const withTick = [...base, e('narrative.read', { runId: RUN, ticket: ticket.key, by: 'you' }, 400)].map((x, i) => ({ ...x, seq: i + 1 }));
    expect(narrativeRead(foldAll(withTick).runs[RUN]!)).toMatchObject({ read: true, changedSinceRead: false });
    const after = [...withTick, { ...reviewed()(e), seq: withTick.length + 1 }];
    expect(narrativeRead(foldAll(after).runs[RUN]!)).toMatchObject({ read: false, changedSinceRead: true });
  });
});
