// The narrative on screen (N1): "What we know" in the ticket, the two notice links in chat, and the hand-back card that
// holds "Mark ready for review" until he has ticked that he read it.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { foldAll } from '@elfoqsy/state';
import { eventFactory, mockSprint } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { NarrativeView } = await import('../src/left/sprint/Narrative');
const { Block } = await import('../src/left/chat/Blocks');

const { open } = mockSprint();
const ticket = open.find((t) => t.key === 'SHOP-3546')!;
const actions = { openTicket: () => {}, openBrief: () => {}, openHandoff: () => {}, editDraft: () => {}, openNarrative: () => {} };

function events(stage: 'mid' | 'handed_back', ticks: Array<'you' | 'tester'> = []): AnyEnvelope[] {
  const e = eventFactory();
  const out: AnyEnvelope[] = [
    e('ticket.synced', { ticket }),
    e('run.created', { runId: 'r4', ticket: ticket.key, worktree: '/w', branch: 'feature/SHOP-3546', agentNumber: 4, repos: ['o/shop-api'] }),
    e('run.understanding', { runId: 'r4', claim: 'Errors are dropped', input: 'i', actual: 'a', expected: 'x', sources: [{ kind: 'ticket', ref: 'SHOP-3546' }] }),
    e('run.verdict', { runId: 'r4', verdict: 'VALID', reproduced: true, summary: 'Dropped.', symptom: 'Errors are dropped', sibling: 's', chain: [{ ref: 'a/b.ts:1', role: 'fault' }], findings: [{ text: 'f', sources: [{ kind: 'code', ref: 'a/b.ts:1' }] }] }),
  ];
  if (stage === 'handed_back') {
    out.push(
      e('run.root_cause', { runId: 'r4', text: 'The cause.', lines: [{ kind: 'code', ref: 'a/b.ts:1' }] }),
      e('run.approach', { runId: 'r4', approach: 'The fix.', alternatives: [] }),
      e('run.pushed', { runId: 'r4', repos: [{ repo: 'o/shop-api', branch: 'feature/SHOP-3546', head: 'abc1234', commits: [], files: [{ path: 'a/b.ts', added: 1, removed: 0 }] }] }),
      e('pr.synced', { pr: { repo: 'o/shop-api', number: 140, state: 'draft', ticket: ticket.key, url: 'https://github.com/o/shop-api/pull/140', checks: 'success' } }),
      e('run.reported', { runId: 'r4', result: 'succeeded', summary: 'Done.', notVerified: [], waitingOnYou: [] }),
      e('run.handed_back', { runId: 'r4', message: 'Done.' }),
    );
  }
  for (const by of ticks) out.push(e('narrative.read', { runId: 'r4', ticket: ticket.key, by }));
  return out;
}

const view = (evs: AnyEnvelope[]) => renderToStaticMarkup(<NarrativeView state={foldAll(evs)} runId="r4" />);

describe('"What we know" in the ticket', () => {
  it('has its heading, who keeps it, the row of seven stage markers, and the seven sections', () => {
    const html = view(events('mid'));
    expect(html).toContain('aria-label="What we know"');
    expect(html).toContain('What we know</h3>');
    expect(html).toContain("kept by Elfoqsy from Agent 4&#x27;s reports");
    expect(html).toContain('Copy as Markdown');
    const stages = [...html.matchAll(/data-stage="(\w+)"/g)].map((m) => m[1]);
    expect(stages).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting', 'waiting']);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(html).toContain(`data-section="${n}"`);
  });

  it('shows what a section not reached yet waits for, in place of text, and a source line under each section that has text', () => {
    const html = view(events('mid'));
    expect(html).toContain('After the verdict'); // reproduction
    expect(html).toContain('After verification'); // hand-back
    expect(html).toMatch(/Agent 4 · understanding, \d\d:\d\d · SHOP-3546/);
    expect(html).toMatch(/Agent 4 · verdict, \d\d:\d\d · b\.ts:1/);
    expect(html.match(/class="nv-source"/g)).toHaveLength(2); // understanding and verdict: a section with nothing in it has no source
  });

  it('holds "Mark ready for review" until the narrative is ticked as read, and says so in the card', () => {
    const html = view(events('handed_back'));
    expect(html).toContain('Ready for review waits for you');
    expect(html).toContain('Your name goes on this PR. Read sections 1 to 6, then mark it ready.');
    expect(html).toMatch(/<input type="checkbox"[^>]*>\s*I&#x27;ve read the narrative|I&#x27;ve read the narrative/);
    expect(html).toMatch(/<button type="button" class="button-solid" disabled="">Mark ready for review<\/button>/);
    expect(html).toContain('Open shop-api#140');
  });

  it('enables it once he has ticked, and leaves it disabled for the tester’s tick in a real run', () => {
    expect(view(events('handed_back', ['you']))).toMatch(/<button type="button" class="button-solid">Mark ready for review<\/button>/);
    const tester = view(events('handed_back', ['tester']));
    expect(tester).toMatch(/class="button-solid" disabled=""/);
    expect(tester).toContain("The tester&#x27;s tick opens nothing: only yours does.");
  });

  it('says the agent reported more after he read it, and asks again', () => {
    const e = eventFactory();
    const html = view([...events('handed_back', ['you']).map((x, i) => ({ ...x, seq: i + 1 })), { ...e('run.root_cause', { runId: 'r4', text: 'Another cause.', lines: [{ kind: 'code', ref: 'a/c.ts:2' }] }), seq: 100 }]);
    expect(html).toContain('The agent has reported more since you read it.');
    expect(html).toMatch(/class="button-solid" disabled=""/);
  });

  it('has no card before the hand-back, and none once the PR is no longer a draft', () => {
    expect(view(events('mid'))).not.toContain('Ready for review waits for you');
    const e = eventFactory();
    const ready = [...events('handed_back').map((x, i) => ({ ...x, seq: i + 1 })), { ...e('pr.synced', { pr: { repo: 'o/shop-api', number: 140, state: 'open', ticket: ticket.key, url: '', checks: 'success' } }), seq: 100 }];
    expect(view(ready)).not.toContain('Ready for review waits for you');
  });
});

describe('the notices in chat', () => {
  const state = foldAll(events('handed_back'));
  it('links the verdict line to section 2 and the hand-back line to section 7, with the yellow dot on the second', () => {
    const verdict = renderToStaticMarkup(<Block block={{ type: 'narrative', ref: 'r4', section: 2 }} state={state} actions={actions} />);
    expect(verdict).toContain('Read the verdict');
    expect(verdict).not.toContain('dot--needs-you');
    const handBack = renderToStaticMarkup(<Block block={{ type: 'narrative', ref: 'r4', section: 7 }} state={state} actions={actions} />);
    expect(handBack).toContain('What we know, then ready for review');
    expect(handBack).toContain('dot--needs-you');
  });
});
