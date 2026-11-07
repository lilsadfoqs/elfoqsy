// Milestone 14 on screen: terminal v2 (thoughts, tool cards, diffs, the verdict, Latest), the same cards for sub-agents,
// Elfoqsy's thinking indicator, the one Markdown renderer, and real tool icons.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldAll } from '@elfoqsy/state';
import { Markdown, blocks, diffRows, parseInfo } from '../src/ui/Markdown';
import { toolIdentity } from '../src/ui/toolIcons';
import { ToolTile } from '../src/ui/ToolTile';
import { THINKING_GIVES_UP_MS, thinkingOf } from '../src/left/model';
import { agentFeed, cardDuration, diffRange, subagentFeed, verdictLabel, type CallEntry } from '../src/right/terminals/feed';
import { eventFactory, time } from './helpers';

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173', search: '' });
const { CallLine, atBottomOf } = await import('../src/right/terminals/Cards');
const { Thinking } = await import('../src/left/chat/Conversation');

describe('the one Markdown renderer', () => {
  const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

  it('draws code with its file, line range and Copy, numbered lines, and the referenced line highlighted', () => {
    const out = html(['Here:', '', '```ts path=shop-api/src/webhook/auth.ts start=24 highlight=27', 'a', 'b', 'c', 'headers.Authorization = `Basic ${token}`;', 'e', '```'].join('\n'));
    expect(out).toContain('<span class="code-path">shop-api/src/webhook/auth.ts</span><span class="code-range">line 27</span>');
    expect(out).toContain('>Copy</button>');
    expect(out).toContain('<span class="code-n">24</span>');
    expect(out).toContain('<div class="code-row code-row--hl"><span class="code-n">27</span><span class="code-text">headers.Authorization = `Basic ${token}`;</span></div>');
    expect(out.match(/code-row--hl/g)).toHaveLength(1);
  });

  it('reads a fence’s info string, and a range when nothing is highlighted', () => {
    expect(parseInfo('ts path=a/b.ts start=24 highlight=27,29-30')).toEqual({ language: 'ts', path: 'a/b.ts', startLine: 24, highlight: [27, 29, 30] });
    expect(parseInfo('lines=10-12')).toEqual({ startLine: 10 });
    expect(html('```js start=10\nx\ny\n```')).toContain('<span class="code-range">lines 10–11</span>');
  });

  it('draws tables with a header row, and a coloured dot for a cell that starts with one', () => {
    const out = html('| Environment | Value starts with "Basic" | Set in |\n| --- | --- | --- |\n| dev | 🔴 Yes | `configmap shop-api-config` |\n| staging | 🟢 No | `Secrets Manager` |');
    expect(out).toContain('<th>Environment</th>');
    expect(out).toContain('<td><span class="dot dot--failed"></span>Yes</td>');
    expect(out).toContain('<td><span class="dot dot--done"></span>No</td>');
    expect(out).toContain('<td><code>configmap shop-api-config</code></td>');
  });

  it('draws a diff fence in the terminal’s diff style, numbered from start', () => {
    const out = html('```diff start=26\n const token = x;\n-a\n+b\n```');
    expect(out).toContain('diff-row diff-row--del"><span class="diff-n">27</span><span class="diff-sign">−</span><span class="diff-text">a</span>');
    expect(out).toContain('diff-row diff-row--add"><span class="diff-n">27</span><span class="diff-sign">+</span><span class="diff-text">b</span>');
    expect(diffRows([' x', '-a', '+b', '+c', ' y'], { old: 10, new: 10 }).map((r) => `${r.n}${r.sign}`)).toEqual(['10 ', '11-', '11+', '12+', '13 ']);
  });

  it('keeps lists, headings and paragraphs, and never runs HTML in the text', () => {
    expect(blocks('# Title\n\n- a\n- b\n\ntext').map((b) => b.kind)).toEqual(['h', 'ul', 'p']);
    const out = html('<script>alert(1)</script>\n\n```\n<img src=x onerror=alert(1)>\n```\n\n| a |\n| --- |\n| <b>x</b> |');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>x</b>');
  });
});

describe('tool cards: names, icons and status', () => {
  it('names a call by the program it runs or the proxy it goes through', () => {
    expect(toolIdentity('Bash', 'npm run test:unit -- webhook/auth')).toEqual({ name: 'npm', call: 'run test:unit -- webhook/auth', tile: 'npm' });
    expect(toolIdentity('Bash', 'cd shop-api && git clone x')).toMatchObject({ name: 'git', tile: 'git' });
    expect(toolIdentity('Bash', 'JEST_TIERS=unit npx jest a.spec.ts')).toMatchObject({ name: 'npx', tile: 'npm' });
    expect(toolIdentity('Bash', 'ls -la src')).toEqual({ name: 'ls', call: '-la src', tile: 'shell' });
    expect(toolIdentity('mcp__run__kube', '-n team-dev get configmap shop-api-config -o yaml')).toEqual({ name: 'kubectl', call: '-n team-dev get configmap shop-api-config -o yaml', tile: 'kubernetes' });
    expect(toolIdentity('mcp__run__jira', 'get SHOP-3492')).toEqual({ name: 'Jira', call: 'get SHOP-3492', tile: 'jira' });
    expect(toolIdentity('mcp__run__aws', 'logs filter-log-events --profile dev')).toMatchObject({ name: 'aws', tile: 'aws' });
    expect(toolIdentity('mcp__run__logs', 'dev: limit 5')).toMatchObject({ name: 'Coralogix', tile: 'coralogix' });
    expect(toolIdentity('Grep', '"Basic " in shop-api/src')).toMatchObject({ name: 'Grep', tile: 'grep' });
    expect(toolIdentity('Agent', 'Write a failing test')).toMatchObject({ name: 'Sub-agent', tile: 'agent' });
  });

  it('draws real icons: the vendor’s own file for Jira, Atlassian’s tile as it is, AWS whole, a generic icon where no official file exists, never a letter', () => {
    // Vite inlines the small originals as data URLs: the file's own markup shows which it is.
    const jira = renderToStaticMarkup(<ToolTile name="jira" />);
    expect(jira).toMatch(/^<span class="tile tile--24 tile--img" data-tile="jira" style="--tile-bg:transparent" aria-hidden="true"><img src="data:image\/svg\+xml/);
    expect(jira).toContain('%231868db'); // Atlassian's own blue tile, with its own white mark
    expect(jira).toContain('fill=&#x27;white&#x27;');
    const git = renderToStaticMarkup(<ToolTile name="git" />);
    expect(git).toMatch(/^<span class="tile tile--24" data-tile="git" style="--tile-bg:var\(--tile-git\);--tile-fg:var\(--tile-ink\)" aria-hidden="true"><span class="tile-logo" style="mask-image:url\(/);
    expect(git).toContain('%3ctitle%3eGit%3c/title%3e');
    const aws = renderToStaticMarkup(<ToolTile name="aws" />);
    expect(aws).toMatch(/tile--img.*<img src="[^"]+" alt=""\/>/);
    expect(aws).toContain('AWS-Cloud-logo_32'); // the AWS logo, not the AWS CLI service's icon
    // Black Duck has no official file: a generic shield, in a mask, and no text in the tile.
    const blackduck = renderToStaticMarkup(<ToolTile name="blackduck" size={20} />);
    expect(blackduck).toContain('class="tile-logo"');
    expect(blackduck).not.toMatch(/>[A-Za-z]+<\/span>/);
  });

  const e = eventFactory();
  const world = foldAll([
    e('run.created', { runId: 'r7', ticket: 'SHOP-3492', worktree: '/w', branch: 'feature/SHOP-3492', agentNumber: 7 }, 0),
    e('run.thought', { runId: 'r7', text: 'Starting on SHOP-3492.' }, 1),
    e('tool.called', { runId: 'r7', toolUseId: 't1', tool: 'mcp__run__jira', title: 'get SHOP-3492', inputSummary: '{}', allowed: true }, 2),
    e('tool.finished', { runId: 'r7', toolUseId: 't1', ok: true, outputSummary: 'SHOP-3492  Bug  To do', durationMs: 800 }, 3),
    e('run.thought', { runId: 'r7', text: 'The config value already carries "Basic ".' }, 4),
    e('tool.called', { runId: 'r7', toolUseId: 't2', tool: 'Bash', title: 'npm run test:unit -- webhook/auth', inputSummary: '{}', allowed: true }, 5),
    e('tool.finished', { runId: 'r7', toolUseId: 't2', ok: false, outputSummary: 'FAIL test/webhook/auth.spec.ts', durationMs: 12_000 }, 17),
    e('tool.called', { runId: 'r7', toolUseId: 't3', tool: 'Edit', title: 'src/webhook/auth.ts', inputSummary: '{}', allowed: true }, 18),
    e('tool.finished', { runId: 'r7', toolUseId: 't3', ok: true, outputSummary: '', stats: '+2 −1', diff: { hunks: [{ oldStart: 26, newStart: 26, lines: [' const token = config.token.trim();', '-headers.Authorization = `Basic ${token}`;', '+const value = token.replace(/^Basic\\s+/i, "");', '+headers.Authorization = `Basic ${value}`;', ' return headers;'] }] } }, 19),
    e('tool.called', { runId: 'r7', toolUseId: 't4', tool: 'Agent', title: 'write a failing test for the header', inputSummary: '{}', allowed: true }, 20),
    e('subagent.started', { runId: 'r7', subagentId: 'sa1', parentToolUseId: 't4', model: 'claude-haiku-5-5', effort: 'low', task: 'write a failing test for the header' }, 20),
    e('run.thought', { runId: 'r7', subagentId: 'sa1', text: 'Writing the test.' }, 21),
    e('tool.called', { runId: 'r7', subagentId: 'sa1', toolUseId: 's1', tool: 'Write', title: 'test/webhook/auth.spec.ts', inputSummary: '{}', allowed: true }, 22),
    e('tool.called', { runId: 'r7', toolUseId: 't5', tool: 'mcp__run__aws', title: 'logs filter-log-events --log-group /shop/dev/shop-api', inputSummary: '{}', allowed: true }, 30),
    e('run.verdict', { runId: 'r7', verdict: 'VALID', reproduced: true, summary: 'Doubled prefix.' }, 31),
  ]);
  const run = world.runs.r7!;
  const feed = agentFeed(run, time(38));
  const call = (id: string) => feed.find((x): x is CallEntry => x.kind === 'call' && x.line.toolUseId === id)!;

  it('interleaves thoughts and calls in the order they happened', () => {
    expect(feed.map((x) => (x.kind === 'thought' ? `thought: ${x.text}` : x.kind === 'call' ? `${x.identity.name}: ${x.status}` : x.kind))).toEqual([
      'thought: Starting on SHOP-3492.',
      'Jira: done',
      'thought: The config value already carries "Basic ".',
      'npm: failed',
      'Edit: done',
      'Sub-agent: running',
      'aws: running',
    ]);
    expect(call('t4').identity.call).toBe('Haiku 5.5, low: write a failing test for the header');
    expect(cardDuration(call('t1').durationMs)).toBe('0.8s');
    expect(cardDuration(call('t2').durationMs)).toBe('12s');
    expect(cardDuration(call('t5').durationMs)).toBe('8.0s');
    expect(cardDuration(72_000)).toBe('1m 12s');
  });

  it('draws a call as one light line with its result under it; a failed one says why (v1.3)', () => {
    const failed = renderToStaticMarkup(<CallLine entry={call('t2')} summary="FAIL test/webhook/auth.spec.ts" />);
    expect(failed).toContain('aria-label="failed"');
    expect(failed).toContain('<div class="ln3-summary">FAIL test/webhook/auth.spec.ts</div>');
    const done = renderToStaticMarkup(<CallLine entry={call('t1')} summary="Bug, Minor" />);
    expect(done).toContain('<b class="ln3-name">Jira</b>');
    expect(done).toContain('<div class="ln3-summary">Bug, Minor</div>');
    expect(done).not.toContain('card');
    expect(renderToStaticMarkup(<CallLine entry={call('t5')} />)).toContain('aria-label="running"');
  });

  it('shows an Edit as its file, line range and numbered diff', () => {
    expect(diffRange(call('t3').line)).toBe('27–28');
    const out = renderToStaticMarkup(<CallLine entry={call('t3')} />);
    expect(out).toContain('<span class="ln3-call">src/webhook/auth.ts</span>');
    expect(out).toContain('<span class="ln3-time">27–28</span>');
    expect(out).toContain('<span class="diff-n">27</span><span class="diff-sign">−</span>');
    expect(out).toContain('<span class="diff-n">28</span><span class="diff-sign">+</span>');
  });

  it('shows the verdict on the header line', () => {
    expect(verdictLabel(run)).toBe('Verdict: VALID, reproduced');
    expect(verdictLabel({ ...run, verdict: { verdict: 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED', reproduced: false, summary: 'x', at: 0 } })).toBe('Verdict: INSUFFICIENT_EVIDENCE/NOT_REPRODUCED');
  });

  it('gives a sub-agent’s pane the same thoughts and cards, its call running until it reports', () => {
    const sub = run.subagents[0]!;
    expect(subagentFeed(sub, time(38)).map((x) => (x.kind === 'call' ? `${x.identity.name}: ${x.status}` : x.kind))).toEqual(['thought', 'Write: running']);
    const after = foldAll([...[...Array(0)], ...[]]);
    void after;
    const e2 = eventFactory();
    const reported = foldAll([
      e2('run.created', { runId: 'r', ticket: 'K-1', worktree: '/w', branch: 'b', agentNumber: 1 }, 0),
      e2('subagent.started', { runId: 'r', subagentId: 's', model: 'claude-haiku-5-5', effort: 'low', task: 't' }, 1),
      e2('tool.called', { runId: 'r', subagentId: 's', toolUseId: 'x', tool: 'Bash', title: 'npm test', inputSummary: '{}', allowed: true }, 2),
      e2('subagent.tool_called', { runId: 'r', subagentId: 's', toolUseId: 'x', tool: 'Bash', inputSummary: 'npm test', outputSummary: '52 passed', ok: true }, 9),
    ]).runs.r!.subagents[0]!;
    expect(reported.tools).toEqual([expect.objectContaining({ toolUseId: 'x', at: time(2), finishedAt: time(9), ok: true, output: '52 passed' })]);
    expect(reported.toolCalls).toBe(1);
  });

  it('follows new entries at the bottom, and offers Latest once scrolled up', () => {
    expect(atBottomOf({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 490 })).toBe(true);
    expect(atBottomOf({ scrollHeight: 2000, scrollTop: 900, clientHeight: 490 })).toBe(false);
  });
});

describe('Elfoqsy’s thinking indicator', () => {
  const e = eventFactory();
  const base = [
    e('conversation.created', { conversationId: 'c1', title: 'Header' }, 0),
    e('elfoqsy.message', { messageId: 'm1', role: 'you', text: 'why only dev?', conversationId: 'c1' }, 10),
    e('elfoqsy.activity', { conversationId: 'c1', activityId: 'a1', tool: 'jira', text: 'Read SHOP-3492 and its comments', state: 'running' }, 10),
    e('elfoqsy.activity', { conversationId: 'c1', activityId: 'a1', tool: 'jira', text: 'Read SHOP-3492 and its comments', state: 'done' }, 11),
    e('elfoqsy.activity', { conversationId: 'c1', activityId: 'a2', tool: 'kube', text: 'Checking the dev and staging config', state: 'running' }, 12),
  ];
  const messages = (s: ReturnType<typeof foldAll>) => s.messages.filter((m) => m.conversationId === 'c1');

  it('shows as soon as his message is in, with what she has done and what she is doing', () => {
    const s = foldAll(base);
    const t = thinkingOf(s, 'c1', messages(s), time(18))!;
    expect(t.activities.map((a) => [a.text, a.state])).toEqual([
      ['Read SHOP-3492 and its comments', 'done'],
      ['Checking the dev and staging config', 'running'],
    ]);
    const out = renderToStaticMarkup(<Thinking since={t.since} activities={t.activities} opensTurn />);
    expect(out).toContain('role="status" aria-live="polite" aria-label="Elfoqsy is thinking"');
    expect(out).toContain('hers-thinking-badge');
    expect(out).toMatch(/aria-label="done".*Read SHOP-3492 and its comments/);
    expect(out).toMatch(/class="dots".*Checking the dev and staging config/);
    // Just sent, nothing done yet: still shows, thinking.
    const fresh = foldAll(base.slice(0, 2));
    expect(thinkingOf(fresh, 'c1', messages(fresh), time(10.2))).toEqual({ since: time(10), activities: [] });
    expect(renderToStaticMarkup(<Thinking since={time(10)} activities={[]} opensTurn />)).toContain('<span>Thinking</span>');
  });

  it('gives way to her reply, and does not show for an answer to an agent, while Claude is paused, or once it gave up', () => {
    const replied = foldAll([...base, e('elfoqsy.message', { messageId: 'm2', role: 'elfoqsy', text: 'Because only dev sets it with the prefix.', conversationId: 'c1' }, 20)]);
    expect(thinkingOf(replied, 'c1', messages(replied), time(21))).toBeNull();
    const answer = foldAll([e('elfoqsy.message', { messageId: 'm3', role: 'you', text: 'Use SHOP', conversationId: 'c1', refs: { approvalId: 'q1' } }, 30)]);
    expect(thinkingOf(answer, 'c1', messages(answer), time(31))).toBeNull();
    const paused = foldAll([...base, e('usage.limit', { state: 'limited', since: new Date(time(12)).toISOString() }, 13)]);
    expect(thinkingOf(paused, 'c1', messages(paused), time(14))).toBeNull();
    const s = foldAll(base);
    expect(thinkingOf(s, 'c1', messages(s), time(12) + THINKING_GIVES_UP_MS + 1000)).toBeNull();
  });
});
