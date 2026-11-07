import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentReviews, foldAll, statusItems, mood } from '@elfoqsy/state';
import { ReviewBlock } from '../src/left/chat/ReviewBlock';
import { PrLine } from '../src/left/sprint/PrLine';
import { statusLine, transcriptLines } from '../src/right/terminals/lines';
import { eventFactory, time } from './helpers';

describe('a CI failure dismissed', () => {
  const world = (dismissed: boolean) => {
    const e = eventFactory();
    return foldAll([
      e('pr.synced', { pr: { repo: 'acme/shop-worker', number: 217, state: 'open', ticket: 'SHOP-2091', url: 'https://github.com/x', checks: 'failure' } }),
      e('ci.status', { repo: 'acme/shop-worker', pr: 217, sha: 'abc', status: 'failure', url: '' }),
      ...(dismissed ? [e('ci.dismissed', { repo: 'acme/shop-worker', pr: 217, sha: 'abc', by: 'you' })] : []),
    ]);
  };

  it('stops counting as broken and stops the red badge, while the PR stays red in the ticket', () => {
    const before = world(false);
    expect(statusItems(before)[0]).toMatchObject({ kind: 'broken', sentence: 'CI failed on 1 pull request' });
    expect(mood(before, time(10))).toBe('broken');
    const pr = before.prs['acme/shop-worker#217']!;
    expect(renderToStaticMarkup(<PrLine state={before} pr={pr} onDismiss={() => {}} />)).toContain('>Dismiss</button>');

    const after = world(true);
    expect(statusItems(after)).toEqual([]);
    expect(mood(after, time(10))).toBe('quiet');
    const html = renderToStaticMarkup(<PrLine state={after} pr={pr} onDismiss={() => {}} />);
    expect(html).toContain('data-state-icon="ci-failed"'); // GitHub's own failed-check icon, in red
    expect(html).toContain('data-state-icon="pr-open"');
    expect(html).toContain('CI failed');
    expect(html).toContain('dismissed until its next CI result');
    expect(html).not.toContain('Dismiss</button>');
  });
});

describe('the weekly review block', () => {
  it('shows the week’s numbers and its suggestions', () => {
    const e = eventFactory();
    const s = foldAll([
      e('review.weekly', {
        weekOf: '2026-10-05',
        conversationId: 'review-2026-10-05',
        metrics: { periodStart: new Date(2026, 9, 3).getTime(), periodEnd: new Date(2026, 9, 10).getTime(), runs: 4, succeeded: 1, failed: 1, cancelled: 2, tokens: 3_200_000, interventions: 1 },
        suggestions: ['Use Sonnet medium for test runs: Haiku failed 3 of 10.'],
      }),
    ]);
    const html = renderToStaticMarkup(<ReviewBlock state={s} reviewId="2026-10-05" />);
    expect(html).toContain('Weekly review, 3 October to 10 October');
    expect(html).toContain('<dt>Runs</dt><dd>4: 1 succeeded, 1 failed, 0 stopped, 2 cancelled</dd>');
    expect(html).toContain('<dt>Tokens</dt><dd>3.2M</dd>');
    expect(html).toContain('<li>Use Sonnet medium for test runs: Haiku failed 3 of 10.</li>');
    expect(renderToStaticMarkup(<ReviewBlock state={s} reviewId="2026-09-28" />)).toContain('not in the workspace any more');
  });

  it('keeps a superseded review as it was and says so; the correction shows its numbers and what it withdrew', () => {
    const e = eventFactory();
    const period = { periodStart: new Date(2026, 9, 3).getTime(), periodEnd: new Date(2026, 9, 10).getTime() };
    const s = foldAll([
      e('review.weekly', {
        weekOf: '2026-10-05',
        conversationId: 'review-2026-10-05',
        metrics: { ...period, runs: 4, workingMinutes: 0, waitingMinutes: 1335 },
        suggestions: ['Answer approvals sooner: runs waited 1335 min.', 'Write checks a run can prove: 2 had no evidence.'],
      }),
      e('review.corrected', {
        weekOf: '2026-10-05',
        revision: 2,
        metrics: { ...period, runs: 4, workingMinutes: 49, waitingMinutes: 30 },
        suggestions: ['Write checks a run can prove: 2 had no evidence.'],
        withdrawn: ['Answer approvals sooner: runs waited 1335 min.'],
      }),
    ]);
    const old = renderToStaticMarkup(<ReviewBlock state={s} reviewId="2026-10-05" />);
    expect(old).toContain('block--superseded');
    expect(old).toContain('<dd>0 min working, 1335 waiting for you, 0 paused</dd>');
    expect(old).toContain('Superseded by a correction on');
    const corrected = renderToStaticMarkup(<ReviewBlock state={s} reviewId="2026-10-05/r2" />);
    expect(corrected).toContain('Weekly review, 3 October to 10 October, corrected');
    expect(corrected).toContain('<dd>49 min working, 30 waiting for you, 0 paused</dd>');
    expect(corrected).toContain('<li>Write checks a run can prove: 2 had no evidence.</li>');
    expect(corrected).toContain('Withdrawn: Answer approvals sooner: runs waited 1335 min.');
    expect(corrected).not.toContain('Superseded');
    expect(currentReviews(s).map((r) => r.ref)).toEqual(['2026-10-05/r2']);
  });
});

describe('a pane, during intervention', () => {
  it('shows guidance where it was given, marks reports Elfoqsy has seen, and says who paused it', () => {
    const e = eventFactory();
    let s = foldAll([
      e('run.created', { runId: 'r3', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 3 }, 0),
      e('tool.called', { runId: 'r3', toolUseId: 'h', tool: 'mcp__run__heartbeat', title: 'heartbeat', inputSummary: '{}', allowed: true }, 10),
      e('run.heartbeat', { runId: 'r3', step: 'Fix', sinceLast: 'x', next: 'y', progress: 'some', risks: [], tokens: 1, workingSeconds: 300 }, 10),
      e('tool.finished', { runId: 'r3', toolUseId: 'h', ok: true, outputSummary: 'Recorded.' }, 10),
      e('run.paused', { runId: 'r3', by: 'tester', reason: 'To give guidance' }, 20),
      e('run.guidance', { runId: 'r3', text: 'Skip the integration suite.', by: 'tester' }, 20),
      e('run.resumed', { runId: 'r3', by: 'tester' }, 20),
      e('tool.called', { runId: 'r3', toolUseId: 'b', tool: 'mcp__run__begin_step', title: 'begin_step', inputSummary: '{}', allowed: true }, 30),
      e('run.step_begun', { runId: 'r3', stepIndex: 0, name: 'Unit only', why: 'As told.' }, 30),
    ]);
    const lines = transcriptLines(s.runs.r3!, time(40));
    expect(lines.map((l) => [l.kind, l.tool ?? '', l.text, l.acked])).toEqual([
      ['call', 'heartbeat', 'heartbeat', false],
      ['out', '', '└ Recorded.', undefined],
      ['guidance', '', 'the tester: Skip the integration suite.', undefined],
      ['call', 'begin_step', 'begin_step', false],
      ['out', '', '└ running  10s', undefined],
    ]);
    const beat = s.runs.r3!.heartbeats[0]!.seq;
    s = foldAll([{ ...e('run.ack', { runId: 'r3', refEventSeq: beat }, 41), seq: s.seq + 1 }], s);
    expect(transcriptLines(s.runs.r3!, time(42))[0]).toMatchObject({ kind: 'call', acked: true });
    const paused = foldAll([{ ...e('run.paused', { runId: 'r3', by: 'tester' }, 50), seq: s.seq + 1 }], s);
    expect(statusLine(paused.runs.r3!)).toMatch(/paused by the tester$/);
  });
});
