// Milestone 15 on screen: the handoff card and its document (his words quoted, his constraints, sourced facts, what was
// left out and why), the verdict block with its evidence, and the weekly review against the team-dev baseline.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldAll, handoffMarkdown } from '@elfoqsy/state';
import { eventFactory } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { Block } = await import('../src/left/chat/Blocks');
const { SprintColumn } = await import('../src/left/sprint/SprintColumn');
const { ReviewBlock } = await import('../src/left/chat/ReviewBlock');

const opened: string[] = [];
const actions = { openTicket: () => {}, openBrief: () => {}, openHandoff: (id: string) => void opened.push(id), editDraft: () => {}, openNarrative: () => {} };

function world() {
  const e = eventFactory();
  return foldAll([
    e('conversation.created', { conversationId: 'c1', title: 'SHOP-3546 errors', ticket: 'SHOP-3546' }),
    e('handoff.created', {
      handoffId: 'h1',
      conversationId: 'c1',
      ticket: 'SHOP-3546',
      mode: 'hotfix',
      bases: { 'acme/shop-worker': 'release/2.22.0' },
      context: [{ messageId: 'm1', role: 'you', text: 'start it. keep the **v1** path as it is.' }],
      constraints: [{ text: 'keep the v1 path as it is', messageId: 'm1' }],
      facts: [{ text: 'The ticket says error_code stays in details.', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }],
      dropped: [{ text: 'The root cause is the mapper.', reason: 'it reads as a diagnosis or a plan' }],
    }),
    e('run.created', { runId: 'r7', ticket: 'SHOP-3546', worktree: '/runs/x', branch: 'feature/SHOP-3546', agentNumber: 7, handoffId: 'h1', mode: 'hotfix' }),
    e('handoff.handed_off', { handoffId: 'h1', runId: 'r7' }),
    e('run.verdict', {
      runId: 'r7',
      verdict: 'VALID',
      reproduced: true,
      summary: 'error_code stays nested in `details`.',
      symptom: 'error_code stays in details',
      sibling: 'The warning path lifts it.',
      findings: [{ text: 'A new test fails.', sources: [{ kind: 'code', ref: 'shop-worker/test/map.test.ts:12' }] }],
    }),
  ]);
}

describe('the handoff', () => {
  it('shows as a card in chat: the mode, what it carries, what was left out, and the agent working from it', () => {
    const html = renderToStaticMarkup(<Block block={{ type: 'handoff', ref: 'h1' }} state={world()} actions={actions} />);
    expect(html).toContain('Handoff: SHOP-3546');
    expect(html).toContain('hotfix, 1 message of his, 1 constraint, 1 fact, 1 left out');
    expect(html).toContain('Agent 7 started from this handoff');
    expect(html).toContain('>Open</button>');
  });

  it('opens as a document: Ticket, Conversation in his words, Constraints, Known facts with sources, and what the workspace left out', () => {
    const s = world();
    const html = renderToStaticMarkup(
      <SprintColumn state={s} view={{ kind: 'handoff', handoffId: 'h1' }} onView={() => {}} items={[]} now={Date.now()} statusLines={[]} jiraSite="https://acme.atlassian.net" open onToggle={() => {}} lastOpen={false} onFind={() => {}} />,
    );
    expect(html).toContain('aria-label="Handoff"');
    expect(html).toContain('Hotfix, on release/2.22.0 in acme/shop-worker.');
    expect(html).toContain('<span class="handoff-who">alex</span>');
    expect(html).toContain('<b>v1</b>'); // his words through the one Markdown renderer
    expect(html).toContain('<li>keep the v1 path as it is</li>');
    expect(html).toContain('The ticket says error_code stays in details.<span class="handoff-sources">SHOP-3546</span>');
    expect(html).toContain('Left out by the workspace');
    expect(html).toContain('The root cause is the mapper.<span class="handoff-sources">it reads as a diagnosis or a plan</span>');
    expect(html).toContain('Copy as Markdown');
    // What the agent read, and Copy as Markdown gives: nothing of what was left out.
    expect(handoffMarkdown(s.handoffs.h1!)).not.toContain('mapper');
  });
});

describe('the verdict', () => {
  it('shows what it is, the reported symptom, the working case it compared, and its evidence with sources', () => {
    const html = renderToStaticMarkup(<Block block={{ type: 'verdict', ref: 'r7' }} state={world()} actions={actions} />);
    expect(html).toContain("Agent 7&#x27;s verdict on SHOP-3546");
    expect(html).toContain('Verdict: VALID, reproduced');
    expect(html).toContain('error_code stays nested in <code>details</code>.');
    expect(html).toContain('<dt>Reported</dt><dd>“error_code stays in details”</dd>');
    expect(html).toContain('<dt>Compared with</dt><dd>The warning path lifts it.</dd>');
    expect(html).toContain('A new test fails.');
    expect(html).toContain('shop-worker/test/map.test.ts:12');
  });

  it('says whether alex confirmed the example of a story, and the comment a stopping verdict proposes', () => {
    const e = eventFactory();
    const s = foldAll([
      e('run.created', { runId: 'r8', ticket: 'SHOP-3600', worktree: '/runs/y', branch: 'feature/SHOP-3600', agentNumber: 8 }),
      e('run.verdict', { runId: 'r8', verdict: 'NEW_BEHAVIOR', reproduced: false, summary: 'Not built yet.', example: { input: 'GET /shipping-options', output: '200 with the list' }, findings: [{ text: 'No route.', sources: [{ kind: 'code', ref: 'a/routes.ts:3' }] }] }),
      e('approval.requested', { approvalId: 'x1', runId: 'r8', kind: 'example', question: 'Is that what the ticket wants?' }),
    ]);
    expect(renderToStaticMarkup(<Block block={{ type: 'verdict', ref: 'r8' }} state={s} actions={actions} />)).toContain('(waiting for you)');
    const confirmed = foldAll([e('approval.resolved', { approvalId: 'x1', decision: 'approved' })], s);
    expect(renderToStaticMarkup(<Block block={{ type: 'verdict', ref: 'r8' }} state={confirmed} actions={actions} />)).toContain('<code>GET /shipping-options</code> → <code>200 with the list</code><span class="verdict-confirm"> (confirmed by you)</span>');
    const stopped = foldAll([e('run.verdict', { runId: 'r8', verdict: 'EXPECTED_BEHAVIOR/INVALID', reproduced: false, summary: 'By design.', ticketComment: 'It is the documented behaviour (a/routes.ts:3).', findings: [{ text: 'Docs.', sources: [{ kind: 'url', ref: 'https://x.example/doc' }] }] })], confirmed);
    const html = renderToStaticMarkup(<Block block={{ type: 'verdict', ref: 'r8' }} state={stopped} actions={actions} />);
    expect(html).toContain('Verdict: EXPECTED_BEHAVIOR/INVALID');
    expect(html).toContain('<dt>Proposed comment</dt>');
  });
});

describe('the weekly review', () => {
  it('shows active hours and interventions per ticket against the team-dev baseline', () => {
    const e = eventFactory();
    const s = foldAll([
      e('conversation.created', { conversationId: 'rv', title: 'Weekly review' }),
      e('review.weekly', {
        weekOf: '2026-10-12',
        conversationId: 'rv',
        metrics: { runs: 2, ticketsWorked: 2, activeHoursPerTicket: 1.4, interventionsPerTicket: 6.5, baselineHoursPerTicket: 5.3, baselineInterventionsPerTicket: 18.4 },
        suggestions: [],
      }),
    ]);
    expect(renderToStaticMarkup(<ReviewBlock state={s} reviewId="2026-10-12" />)).toContain('<dt>Per ticket</dt><dd>1.4 active h, 6.5 interventions over 2 tickets; team-dev alone: 5.3 h, 18.4</dd>');
  });
});
