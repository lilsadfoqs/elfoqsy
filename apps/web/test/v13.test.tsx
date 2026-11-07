// v1.3 on screen: terminal v3's feed (prose, light lines, groups of three or more, the verdict line, Elfoqsy's answers,
// a question at the end), where a new agent's pane goes, the question card, the digest and a task's result, the
// delegation sheet, the new folds, and the design rule that no coloured stripe sits beside a card, block or row.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DELEGATION, foldAll, runLabel } from '@elfoqsy/state';
import { groupNoun, paneEntries, resultSummary, webDomain } from '../src/right/terminals/feed';
import { layout, leaf, placeRun, type PaneNode } from '../src/right/terminals/tree';
import { eventFactory, time } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { QuestionCard } = await import('../src/ui/QuestionCard');
const { DigestBlock, DeliverableBlock } = await import('../src/left/chat/DecisionBlocks');
const { DelegationSheet } = await import('../src/left/DelegationSheet');
const { Feed } = await import('../src/right/terminals/Cards');

const e = eventFactory();
const call = (id: string, tool: string, title: string, at: number, out: { ok?: boolean; output?: string; finishedAt?: number } = {}) => [
  e('tool.called', { runId: 'r2', toolUseId: id, tool, title, inputSummary: '{}', allowed: true }, at),
  ...(out.finishedAt !== undefined ? [e('tool.finished', { runId: 'r2', toolUseId: id, ok: out.ok ?? true, outputSummary: out.output ?? '', durationMs: 800 }, out.finishedAt)] : []),
];
const world = foldAll([
  e('ticket.synced', { ticket: { key: 'SHOP-2091', board: 'SHOP', summary: 'Bundle discount', type: 'Bug', status: 'In progress', priority: 'Major', storyPoints: 3, sprint: 'S52', sprintsCarried: 0, epic: null, reporter: 'r', created: '', updated: '', labels: [], linked: [], description: '' } }, 0),
  e('run.created', { runId: 'r2', ticket: 'SHOP-2091', worktree: '/w', branch: 'feature/SHOP-2091', agentNumber: 2, budget: { tokens: 3_000_000, minutes: 45 } }, 0),
  e('run.step_begun', { runId: 'r2', stepIndex: 0, name: 'Understand', why: 'w' }, 1),
  e('run.thought', { runId: 'r2', text: "The ticket says the bundle discount reaches the whole cart. I'll find where the discount is applied." }, 2),
  ...call('c1', 'mcp__run__jira', 'get SHOP-2091', 3, { finishedAt: 4, output: 'Bug, Minor, no comments, no linked PRs' }),
  ...call('c2', 'Grep', '"split_bundles" in shop-api/src', 5, { finishedAt: 6, output: '4 matches' }),
  ...call('c3', 'Read', 'src/pricing/bundles.ts', 7, { finishedAt: 8, output: '212 lines' }),
  ...call('c4', 'mcp__run__begin_step', 'Locate', 9, { finishedAt: 9 }),
  ...call('c5', 'Read', 'src/a.ts', 10, { finishedAt: 11, output: '40 lines' }),
  e('run.thought', { runId: 'r2', text: 'The discount is in `bundles.ts`.' }, 12),
  ...call('c6', 'Bash', 'npm test', 13, { finishedAt: 14, ok: false, output: 'FAIL test/a.spec.ts\n1 failed' }),
  ...call('c7', 'Bash', 'npm test', 15, { finishedAt: 16, output: 'PASS\n89 passed' }),
  e('run.verdict', { runId: 'r2', verdict: 'VALID', reproduced: true, summary: 's', findings: [{ text: 'New spec fails on the current code', sources: [] }] }, 17),
  e('decision.made', { decisionId: 'd1', requestId: 'q1', runId: 'r2', requestKind: 'question', category: 'sourced_answer', summary: 'Answered', question: 'Bundle discount on bundle items only?', options: ['Yes', 'No'], answer: 'Yes', sources: [{ kind: 'ticket', ref: 'SHOP-1201', label: "the ticket's AC" }], basis: 'sources', told: false }, 18),
  ...call('c8', 'WebFetch', 'https://www.npmjs.com/package/protobufjs', 19, { finishedAt: 20, output: 'protobufjs 7.4.0' }),
  ...call('c9', 'mcp__run__kube', '--context dev get pods', 21),
  e('approval.requested', { approvalId: 'a1', runId: 'r2', kind: 'question', question: 'Agent 2 on SHOP-2091 asks: Change v1 too?', card: { question: 'Change v1 too, or leave it?', why: ['v1 is a visible contract'], options: [{ label: 'Leave v1', consequence: 'Fix ships now' }, { label: 'Change v1 too', consequence: 'Wider review' }], recommendation: 'Leave v1', sources: [{ kind: 'ticket', ref: 'SHOP-2091' }] }, category: 'unsourced', suggestion: { option: 'Leave v1', why: 'The ticket names v2 only.', sources: [] }, precedentable: true }, 22),
]);
const run = world.runs.r2!;

describe('terminal v3: the feed (item 2)', () => {
  const entries = paneEntries(run, world, time(30));
  const shape = entries.map((x) =>
    x.kind === 'prose' ? 'prose' : x.kind === 'call' ? `call:${x.call.identity.name}` : x.kind === 'group' ? `group:${x.noun}` : x.kind === 'answer' ? `answer:${x.decision.answer}` : x.kind === 'verdict' ? `verdict:${x.label} ${x.detail}` : x.kind,
  );

  it('puts prose first, groups three or more calls in a row, keeps a failed one and a running one apart, and hides the run’s own reports', () => {
    expect(shape).toEqual([
      'prose',
      'group:4 reads and searches',
      'prose',
      'call:npm',
      'call:npm',
      'verdict:VALID reproduced',
      'answer:Yes',
      'call:WebFetch',
      'call:kubectl',
      'question',
    ]);
    const group = entries[1] as Extract<(typeof entries)[number], { kind: 'group' }>;
    expect(group.calls.map((c) => c.summary)).toEqual(['Bug, Minor, no comments, no linked PRs', '4 matches', '212 lines', '40 lines']);
  });

  it('says when Elfoqsy is looking into its question, before it becomes his', () => {
    const w = foldAll([e('decision.considering', { requestId: 'q9', runId: 'r2', requestKind: 'question', summary: 'Keep the retry count?' }, 26)], world);
    expect(paneEntries(w.runs.r2!, w, time(30)).at(-2)).toEqual({ kind: 'note', key: 'elf-q9', text: 'Elfoqsy is looking into its question: Keep the retry count?', reminder: true });
    const decided = foldAll([e('decision.made', { decisionId: 'd9', requestId: 'q9', runId: 'r2', requestKind: 'question', category: 'sourced_answer', summary: 's', answer: 'Yes', sources: [], basis: 'sources', told: false }, 27)], w);
    expect(paneEntries(decided.runs.r2!, decided, time(30)).some((x) => x.key === 'elf-q9')).toBe(false);
  });

  it('shows a web read’s domain and a command’s last line, and says when it was not allowed', () => {
    const web = entries.find((x) => x.kind === 'call' && x.call.line.tool === 'WebFetch') as Extract<(typeof entries)[number], { kind: 'call' }>;
    expect(web.domain).toBe('npmjs.com');
    expect(webDomain({ tool: 'WebSearch', title: 'protobufjs peer' })).toBeUndefined();
    expect(resultSummary(run.transcript.find((l) => l.toolUseId === 'c7')!)).toBe('89 passed');
    expect(resultSummary(run.transcript.find((l) => l.toolUseId === 'c6')!)).toBe('FAIL test/a.spec.ts');
    expect(groupNoun([{ tool: 'Bash', title: 'x' }, { tool: 'mcp__run__kube', title: 'y' }, { tool: 'mcp__run__docker', title: 'z' }])).toBe('3 commands');
    expect(groupNoun([{ tool: 'Bash', title: 'x' }, { tool: 'Read', title: 'y' }, { tool: 'Edit', title: 'z' }])).toBe('3 tool calls');
  });

  it('draws no card backgrounds or guide lines: light lines, a chip, the verdict line, her answer with Change, and the question card', () => {
    const html = renderToStaticMarkup(<Feed entries={entries} state={world} label="Agent 2" />);
    expect(html).not.toMatch(/class="(card|thought)\b/);
    expect(html).toContain('4 reads and searches');
    expect(html).toContain('<b>VALID</b><span class="vl-detail">reproduced</span>');
    expect(html).toContain('<b>Elfoqsy answered for you</b><span class="ans-from"> · from the ticket&#x27;s AC, SHOP-1201</span>');
    expect(html).toContain('>Change</button>');
    expect(html).toContain('<span class="ln3-domain">npmjs.com</span>/package/protobufjs');
    expect(html).toContain('needs you');
    expect(html).toContain('Leave v1<span class="qcard-suggests"> · Elfoqsy suggests</span>');
  });
});

describe('where a new agent’s pane goes (item 1)', () => {
  const box = (tree: PaneNode, w = 1200, h = 900) => layout(tree, 0, 0, w, h).tiles;
  it('is the pane already showing it, else an empty pane, else a split beside the focused one, else the least recently focused', () => {
    const a = leaf('r1');
    let tree: PaneNode = a;
    expect(placeRun(tree, box(tree), 'r1', a.id, {})).toEqual({ tree, leafId: a.id });
    const placed = placeRun(tree, box(tree), 'r2', a.id, {});
    expect(placed.tree).not.toBe(tree);
    expect(box(placed.tree).map((t) => t.leaf.runId)).toEqual(['r1', 'r2']);
    // No room to split: the pane focused least recently takes it over, never the focused one.
    tree = placed.tree;
    const tiles = box(tree, 640, 380);
    const [first, second] = tiles;
    const lru = placeRun(tree, tiles, 'r3', second!.leaf.id, { [first!.leaf.id]: 1, [second!.leaf.id]: 2 });
    expect(lru.leafId).toBe(first!.leaf.id);
    expect(box(lru.tree, 640, 380).map((t) => t.leaf.runId)).toEqual(['r3', 'r2']);
    // An empty pane is used first.
    const empty = leaf(null);
    expect(placeRun(empty, box(empty), 'r4', empty.id, {}).leafId).toBe(empty.id);
  });

  it("takes over a finished agent's pane before a working one's, and one waiting for him last", () => {
    let tree: PaneNode = leaf('r1');
    for (const runId of ['r2', 'r3']) tree = placeRun(tree, box(tree), runId, box(tree).at(-1)!.leaf.id, {}).tree;
    const tiles = box(tree, 640, 380);
    expect(tiles.map((t) => t.leaf.runId)).toEqual(['r1', 'r2', 'r3']);
    const id = (runId: string) => tiles.find((t) => t.leaf.runId === runId)!.leaf.id;
    const focusedAt = { [id('r1')]: 1, [id('r2')]: 2, [id('r3')]: 3 };
    const keep = (l: { runId: string | null }) => ({ r1: 2, r2: 0, r3: 1 })[l.runId as 'r1'] ?? 0;
    // r1 was focused longest ago but waits for him; r2 has finished.
    const placed = placeRun(tree, tiles, 'r4', id('r3'), focusedAt, keep);
    expect(placed).toMatchObject({ leafId: id('r2'), tookOver: true });
    expect(box(placed.tree, 640, 380).map((t) => t.leaf.runId)).toEqual(['r1', 'r4', 'r3']);
  });

  it('keeps a map click while the terminals are hidden, asks for them to open, and focuses it once they are back', async () => {
    const { focusRun } = await import('../src/right/focus');
    let opened = 0;
    const off = focusRun.onHidden(() => opened++);
    focusRun.request('r9');
    expect(opened).toBe(1);
    const got: string[] = [];
    const unsubscribe = focusRun.subscribe((runId) => got.push(runId));
    expect(got).toEqual(['r9']);
    focusRun.request('r1');
    expect(got).toEqual(['r9', 'r1']);
    expect(opened).toBe(1);
    unsubscribe();
    off();
  });
});

describe('the question card (item 3)', () => {
  it('shows the options as buttons with her suggestion marked, the sources collapsed, and the precedent tick', () => {
    const html = renderToStaticMarkup(<QuestionCard approval={world.approvals.a1!} state={world} />);
    expect(html).toContain('<span class="qcard-who">Agent 2 · SHOP-2091</span>');
    expect(html).toContain('<b class="qcard-q">Change v1 too, or leave it?</b>');
    expect(html).toContain('<li>v1 is a visible contract</li>');
    expect(html).toContain('class="qcard-option qcard-option--suggested"');
    expect(html).toContain('<span class="qcard-option-consequence">Fix ships now</span>');
    expect(html).toContain('aria-expanded="false">1 source</button>');
    expect(html).toContain('Let Elfoqsy decide this kind next time');
    const compact = renderToStaticMarkup(<QuestionCard approval={world.approvals.a1!} state={world} compact />);
    expect(compact).not.toContain('qcard-precedent');
    expect(compact).not.toContain('qcard-why');
  });

  it('offers Approve, Allow for this ticket and Deny for a request, and says how one was answered', () => {
    const w = foldAll(
      [
        e('approval.requested', { approvalId: 'a2', runId: 'r2', kind: 'action', question: 'Agent 2 on SHOP-2091 wants to comment on SHOP-2091.', action: 'Comment on SHOP-2091', tier: 2, grantable: { kind: 'jira.comment' }, category: 'notify_people', precedentable: true }, 23),
      ],
      world,
    );
    const html = renderToStaticMarkup(<QuestionCard approval={w.approvals.a2!} state={w} />);
    expect([...html.matchAll(/<span class="qcard-option-label">([^<]+)/g)].map((m) => m[1])).toEqual(['Approve', 'Allow for this ticket', 'Deny']);
    const done = foldAll([e('approval.resolved', { approvalId: 'a2', decision: 'approved', precedent: true }, 24)], w);
    expect(renderToStaticMarkup(<QuestionCard approval={done.approvals.a2!} state={done} />)).toContain('Approved, ');
    expect(renderToStaticMarkup(<QuestionCard approval={done.approvals.a2!} state={done} />)).toContain('; Elfoqsy decides this kind from now on');
  });
});

describe('what she decided while he was away, and a task’s result (items 6 and 9)', () => {
  const w = foldAll(
    [
      e('action.classified', { actionId: 'x1', runId: 'r2', proxy: 'kube', kind: 'kube.rollout_restart', tier: 2, environment: 'integration', summary: 'kubectl rollout restart', decision: 'elfoqsy', reason: 'r', decisionId: 'd2' }, 25),
      e('decision.made', { decisionId: 'd2', requestId: 'q2', runId: 'r2', requestKind: 'action', category: 'harness_kube', summary: 'Restarted the integration harness with the fix image', answer: 'approved', sources: [{ kind: 'setting', ref: 'harness_kube' }], basis: 'delegation', told: true, actionId: 'x1' }, 25),
      e('change.recorded', { recordId: 'rec1', actionId: 'x1', runId: 'r2', environment: 'integration', target: 'deployment/shop-integration-test', before: 'it:1', undo: { proxy: 'kube', summary: 'Set it back', request: {} } }, 25),
      e('decisions.digested', { digestId: 'g1', conversationId: 'c1', decisionIds: ['d1', 'd2'], awaySince: new Date(time(0)).toISOString() }, 30),
      e('run.created', { runId: 't1', ticket: 'task:abc123', worktree: '/w2', branch: 'b', agentNumber: 3, task: { name: 'Integration vs staging', goal: 'Compare', deliverable: 'table' } }, 31),
      e('task.delivered', { runId: 't1', deliverableId: 'dl1', kind: 'table', title: 'Images', content: '| service | integration | staging |\n|---|---|---|\n| shop-api | 2.22.0 | 2.21.3 |' }, 32),
    ],
    world,
  );

  it('lists the decisions with what each rests on, and Change or Undo where it can be put back', () => {
    const html = renderToStaticMarkup(<DigestBlock state={w} digestId="g1" />);
    expect(html).toContain('<b>I decided 2 things while you were away</b><span class="digest-note">all reversible</span>');
    expect(html).toContain('SHOP-2091 · the ticket&#x27;s AC, SHOP-1201');
    expect(html).toContain('SHOP-2091 · the test harness is delegated');
    expect([...html.matchAll(/class="button-outline button-outline--small"[^>]*>(\w+)</g)].map((m) => m[1])).toEqual(['Change', 'Undo']);
  });

  it('says since when for a digest he opened himself, and marks one the tester opened (v1.3.1)', () => {
    const since = time(0);
    const hhmm = new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const opened = foldAll(
      [
        e('decisions.digested', { digestId: 'g2', conversationId: 'c1', decisionIds: ['d2'], awaySince: new Date(since).toISOString(), asked: true }, 40),
        e('decisions.digested', { digestId: 'g3', conversationId: 'c1', decisionIds: ['d2'], awaySince: new Date(since).toISOString(), asked: true, test: true }, 41),
      ],
      w,
    );
    expect(renderToStaticMarkup(<DigestBlock state={opened} digestId="g2" />)).toContain(`<b>I decided 1 thing since ${hhmm}</b>`);
    expect(renderToStaticMarkup(<DigestBlock state={opened} digestId="g3" />)).toContain('<span class="digest-note">opened by the tester</span>');
  });

  it('words the digest in Vietnamese, with tôi and cậu, when she wrote it in Vietnamese; its buttons stay as they are', () => {
    const since = time(0);
    const hhmm = new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const vi = foldAll(
      [
        e('decision.made', { decisionId: 'd3', requestId: 'q3', runId: 'r2', requestKind: 'action', category: 'harness_kube', summary: 'Cho Agent 2 trên SHOP-2091 làm: “kubectl rollout restart”', answer: 'approved', sources: [{ kind: 'setting', ref: 'harness_kube' }], basis: 'delegation', told: true, actionId: 'x1', lang: 'vi' }, 42),
        e('decisions.digested', { digestId: 'g4', conversationId: 'c1', decisionIds: ['d3'], awaySince: new Date(since).toISOString(), lang: 'vi' }, 43),
        e('decisions.digested', { digestId: 'g5', conversationId: 'c1', decisionIds: ['d3'], awaySince: new Date(since).toISOString(), asked: true, test: true, lang: 'vi' }, 44),
      ],
      w,
    );
    const html = renderToStaticMarkup(<DigestBlock state={vi} digestId="g4" />);
    expect(html).toContain('<b>Tôi đã quyết 1 việc trong lúc cậu vắng mặt</b><span class="digest-note">tất cả đều hoàn tác được</span>');
    expect(html).toContain('Cho Agent 2 trên SHOP-2091 làm: “kubectl rollout restart”');
    expect(html).toContain('SHOP-2091 · test harness đã được giao');
    expect([...html.matchAll(/class="button-outline button-outline--small"[^>]*>(\w+)</g)].map((m) => m[1])).toEqual(['Undo']);
    const asked = renderToStaticMarkup(<DigestBlock state={vi} digestId="g5" />);
    expect(asked).toContain(`<b>Tôi đã quyết 1 việc từ ${hhmm}</b>`);
    expect(asked).toContain('<span class="digest-note">do người test mở</span>');
    // The English digest of the same state is as it was.
    expect(renderToStaticMarkup(<DigestBlock state={vi} digestId="g1" />)).toContain('<b>I decided 2 things while you were away</b>');
  });

  it('says what a changed or undone decision of hers rests on in Vietnamese too', () => {
    const changed = foldAll(
      [
        e('decision.made', { decisionId: 'd4', requestId: 'q4', runId: 'r2', requestKind: 'question', category: 'sourced_answer', summary: 'Đã trả lời "Giữ lại không?": Có', question: 'Giữ lại không?', options: ['Có', 'Không'], answer: 'Có', sources: [{ kind: 'setting', ref: 'sourced_answer' }], basis: 'precedent', told: false, lang: 'vi' }, 45),
        e('decision.changed', { decisionId: 'd4', by: 'you', how: 'changed', to: 'Không' }, 46),
        e('decisions.digested', { digestId: 'g6', conversationId: 'c1', decisionIds: ['d4'], awaySince: new Date(time(0)).toISOString(), lang: 'vi' }, 47),
      ],
      w,
    );
    const html = renderToStaticMarkup(<DigestBlock state={changed} digestId="g6" />);
    expect(html).toContain('tiền lệ của cậu cho loại này');
    expect(html).toContain('cậu đã đổi thành “Không”');
  });

  it('shows a task agent by its name and its table as a table', () => {
    expect(runLabel(w.runs.t1!)).toBe('Integration vs staging');
    const html = renderToStaticMarkup(<DeliverableBlock state={w} deliverableId="dl1" />);
    expect(html).toContain('<b>Images</b>');
    expect(html).toContain('Agent 3, Integration vs staging');
    expect(html).toContain('<table');
  });
});

describe('the delegation sheet (item 7)', () => {
  it('shows each category’s setting, his precedents and the agents-at-once limit', () => {
    const w = foldAll(
      [
        e('delegation.set', { category: 'staging_write', setting: 'decide_and_tell', by: 'you' }, 40),
        e('precedent.saved', { precedentId: 'p1', category: 'notify_people', ticketType: 'Bug', approvalId: 'a9', requestKind: 'action', question: 'Comment on SHOP-2091', answer: 'approved', by: 'you' }, 41),
        e('workspace.setting', { key: 'maxAgents', value: 4, by: 'you' }, 42),
      ],
      world,
    );
    expect(w.delegation).toEqual({ ...DEFAULT_DELEGATION, staging_write: 'decide_and_tell' });
    // Open, as a floating layer (v1.4.1).
    const layer = { id: 'sheet', kind: 'menu' as const, open: true, show: () => {}, hide: () => {}, toggle: () => {}, anchor: { current: null }, floating: { current: null } };
    const html = renderToStaticMarkup(<DelegationSheet state={w} layer={layer} />);
    expect(html).toContain('aria-label="Staging writes"><button type="button" role="radio" aria-checked="false">Decide</button><button type="button" role="radio" aria-checked="true">Decide and tell me</button>');
    expect(html).toContain('Anything that notifies people, Bug tickets');
    expect(html).toContain('<span aria-live="polite">4</span>');
    expect(html).toContain('1 made, 0 changed by you');
    const removed = foldAll([e('precedent.removed', { precedentId: 'p1', by: 'you' }, 43)], w);
    expect(removed.precedents).toEqual({});
  });
});

/** Every file under a folder with one of these endings. */
function files(dir: string, ends: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ends) : ends.some((x) => name.endsWith(x)) ? [path] : [];
  });
}

describe('no coloured stripe beside a card, block or row (item 4)', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
  // A hairline between columns in a neutral border colour is a divider, not a stripe; anything else on one side is.
  const NEUTRAL = /^1px solid var\(--(border-subtle|border-default|border-strong|bg-selected|line-structure)\)$/;

  it('has no side border, no inset side shadow and no narrow side bar in the stylesheet', () => {
    const stripes = rules.flatMap(({ selector, body }) => {
      const found: string[] = [];
      for (const m of body.matchAll(/border-(?:left|right|inline-start|inline-end)\s*:\s*([^;]+)/g)) if (!/^(0|none)\b/.test(m[1]!.trim()) && !NEUTRAL.test(m[1]!.trim())) found.push(`${selector}: a side border`);
      if (/border-(left|right|inline-start|inline-end)-(width|color)\s*:/.test(body)) found.push(`${selector}: a side border`);
      for (const m of body.matchAll(/box-shadow\s*:([^;]+)/g)) if (/inset\s+-?[1-9]\d*px\s+0(px)?\s+0/.test(m[1]!)) found.push(`${selector}: an inset side shadow`);
      if (/::?(before|after)/.test(selector) && /position\s*:\s*absolute/.test(body) && /width\s*:\s*[1-6]px/.test(body) && /(top|bottom)\s*:/.test(body)) found.push(`${selector}: a narrow bar`);
      return found;
    });
    expect(stripes).toEqual([]);
  });

  it('has none in the components’ inline styles either', () => {
    const src = files(join(import.meta.dirname, '..', 'src'), ['.tsx', '.ts']).map((f) => [f, readFileSync(f, 'utf8')] as const);
    const inline = src.filter(([, text]) => /borderLeft|borderRight|borderInlineStart|inset\s+[1-9]px\s+0\s+0/.test(text)).map(([f]) => f);
    expect(inline).toEqual([]);
  });

  it('highlights a code line with a lighter row and brighter text only', () => {
    const hl = rules.filter((r) => r.selector.startsWith('.code-row--hl'));
    expect(hl.map((r) => r.body.replace(/\s+/g, ' ').trim())).toEqual(['background: var(--bg-selected);', 'color: var(--text-primary);', 'color: var(--code-ink-bright);']);
  });
});
