// Milestone 13 on screen: a tier-2 approval offers "Allow for this ticket", a batch can be approved at once, and a
// recorded change carries Undo in the pane.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldAll, isGrantLive } from '@elfoqsy/state';
import { transcriptLines } from '../src/right/terminals/lines';
import { eventFactory, time } from './helpers';

// The blocks and the pane import the workspace's socket store, which reads the page's address when it loads.
vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { ApprovalBatch, Block } = await import('../src/left/chat/Blocks');
const { UndoButton } = await import('../src/right/terminals/Pane');

const SHOP_API = 'acme/shop-api';
const actions = { openTicket: () => {}, openBrief: () => {}, openHandoff: () => {}, editDraft: () => {}, openNarrative: () => {} };

function world(extra: (e: ReturnType<typeof eventFactory>) => ReturnType<ReturnType<typeof eventFactory>>[] = () => []) {
  const e = eventFactory();
  return foldAll([
    e('run.created', { runId: 'r7', ticket: 'SHOP-3492', worktree: '/runs/x', branch: 'feature/SHOP-3492', agentNumber: 7 }),
    e('approval.requested', { approvalId: 'a1', runId: 'r7', kind: 'action', tier: 2, question: `Agent 7 on SHOP-3492 wants to run \`gh pr ready 812 --repo ${SHOP_API}\`.`, action: `gh pr ready 812 --repo ${SHOP_API}`, grantable: { kind: 'gh.pr.ready' }, batchId: 'b1' }),
    e('approval.requested', { approvalId: 'a2', runId: 'r7', kind: 'action', tier: 2, question: 'Agent 7 wants to comment.', action: `gh pr comment 812 --repo ${SHOP_API}`, grantable: { kind: 'gh.pr.comment' }, batchId: 'b1' }),
    ...extra(e),
  ]);
}

describe('a tier-2 approval', () => {
  it('offers Approve once, Allow for this ticket and Deny', () => {
    const html = renderToStaticMarkup(<Block block={{ type: 'approval', ref: 'a1' }} state={world()} actions={actions} />);
    expect(html).toContain('>Approve once</button>');
    expect(html).toContain('>Allow for this ticket</button>');
    expect(html).toContain('>Deny</button>');
    expect(html).toContain('runs without asking for 8 hours, or until the run ends');
  });

  it('says when it was allowed for the ticket, and until when', () => {
    const s = world((e) => [
      e('approval.resolved', { approvalId: 'a1', decision: 'approved', scope: 'ticket' }),
      e('grant.created', { grantId: 'g1', ticket: 'SHOP-3492', runId: 'r7', kind: 'gh.pr.ready', expiresAt: new Date(time(8 * 3600)).toISOString(), by: 'you', approvalId: 'a1' }),
    ]);
    const html = renderToStaticMarkup(<Block block={{ type: 'approval', ref: 'a1' }} state={s} actions={actions} />);
    expect(html).toMatch(/Approved for this ticket, \d\d:\d\d; until \d\d:\d\d or the run(&#x27;|')s end/);
    expect(isGrantLive(s.grants.g1!, time(60))).toBe(true);
    expect(isGrantLive(s.grants.g1!, time(9 * 3600))).toBe(false);
    const ended = world((e) => [
      e('approval.resolved', { approvalId: 'a1', decision: 'approved', scope: 'ticket' }),
      e('grant.created', { grantId: 'g1', ticket: 'SHOP-3492', runId: 'r7', kind: 'gh.pr.ready', expiresAt: new Date(time(8 * 3600)).toISOString(), by: 'you', approvalId: 'a1' }),
      e('grant.ended', { grantId: 'g1', reason: 'run_ended' }),
    ]);
    expect(renderToStaticMarkup(<Block block={{ type: 'approval', ref: 'a1' }} state={ended} actions={actions} />)).toContain('the grant has ended (the run ended)');
  });

  it('says the tester’s "Allow for this ticket" covered that request only', () => {
    const s = world((e) => [e('approval.resolved', { approvalId: 'a1', decision: 'approved', scope: 'ticket', test: true })]);
    const html = renderToStaticMarkup(<Block block={{ type: 'approval', ref: 'a1' }} state={s} actions={actions} />);
    expect(html).toMatch(/Approved by the tester, \d\d:\d\d; this request only: only alex can allow it for the ticket/);
    expect(html).not.toContain('for this ticket by');
  });

  it('keeps plain Approve for approvals that cannot be given for the ticket', () => {
    const e = eventFactory();
    const s = foldAll([e('approval.requested', { approvalId: 'c1', runId: 'r7', kind: 'check', question: 'Is the page done?' })]);
    const html = renderToStaticMarkup(<Block block={{ type: 'approval', ref: 'c1' }} state={s} actions={actions} />);
    expect(html).toContain('>Approve</button>');
    expect(html).not.toContain('Allow for this ticket');
  });
});

describe('a batch of approvals', () => {
  const blocks = [
    { type: 'approval' as const, ref: 'a1' },
    { type: 'approval' as const, ref: 'a2' },
  ];

  it('can be approved together while two or more are open', () => {
    const html = renderToStaticMarkup(<ApprovalBatch state={world()} blocks={blocks} />);
    expect(html).toContain('2 actions wait for you');
    expect(html).toContain('>Approve all once</button>');
    const one = world((e) => [e('approval.resolved', { approvalId: 'a1', decision: 'approved' })]);
    expect(renderToStaticMarkup(<ApprovalBatch state={one} blocks={blocks} />)).toBe('');
  });
});

describe('Undo in the pane', () => {
  const ran = (e: ReturnType<typeof eventFactory>) => [
    e('tool.called', { runId: 'r7', toolUseId: 't1', tool: 'mcp__run__kube', title: 'kubectl --context dev-shop set image deployment/shop-api shop-api=shop-api:2.22.0', inputSummary: '{}', allowed: true }),
    e('action.classified', { actionId: 'act1', runId: 'r7', toolUseId: 't1', proxy: 'kube', kind: 'kube.set_image', tier: 1, environment: 'dev', summary: 'kubectl …', decision: 'run', reason: 'Done at once.' }),
    e('change.recorded', { recordId: 'rec1', actionId: 'act1', runId: 'r7', environment: 'dev', target: 'deployment/shop-api on dev', before: 'container shop-api: image shop-api:2.21.3', undo: { proxy: 'kube', summary: 'Set shop-api back to shop-api:2.21.3', request: { args: [] } } }),
    e('tool.finished', { runId: 'r7', toolUseId: 't1', ok: true, outputSummary: 'deployment.apps/shop-api image updated' }),
  ];

  it('offers Undo on the call whose change was recorded, saying what it puts back, and says when it was undone', () => {
    const s = world((e) => ran(e));
    const [call] = transcriptLines(s.runs.r7!, time(100));
    expect(call).toMatchObject({ kind: 'call', tool: 'kube', tier: 1, change: { recordId: 'rec1', undo: 'Set shop-api back to shop-api:2.21.3', undone: false } });
    expect(renderToStaticMarkup(<UndoButton change={call!.change!} />)).toBe('<button type="button" class="ln-undo" data-tip="Set shop-api back to shop-api:2.21.3" aria-label="Undo: Set shop-api back to shop-api:2.21.3">Undo</button>');
    const undone = world((e) => [...ran(e), e('change.undone', { recordId: 'rec1', actionId: 'act2', by: 'you' })]);
    const [after] = transcriptLines(undone.runs.r7!, time(100));
    expect(renderToStaticMarkup(<UndoButton change={after!.change!} />)).toBe('<span class="ln-undone">undone</span>');
    expect(undone.changes.rec1!.undone).toMatchObject({ by: 'you', actionId: 'act2' });
  });

  it('offers nothing where a change cannot be undone here', () => {
    expect(renderToStaticMarkup(<UndoButton change={{ recordId: 'r', noUndo: 'Taking a push back would need a force-push.', undone: false }} />)).toBe('');
  });
});

describe('the AWS session on the status line', () => {
  it('says quietly when it is about to end or has ended, and nothing while it is fresh', async () => {
    const { statusLines } = await import('@elfoqsy/state');
    const e = eventFactory();
    const at = (state: 'ok' | 'expiring' | 'expired') => foldAll([e('aws.session', { state, expiresAt: new Date(time(600)).toISOString() })]);
    const end = new Date(time(600)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(statusLines(at('expiring'), null)).toEqual([`AWS session ends at ${end}`]);
    expect(statusLines(at('expired'), null)).toEqual([`AWS session ended at ${end}`]);
    expect(statusLines(at('ok'), null)).toEqual([]);
  });
});
