import { describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@elfoqsy/contracts';
import { foldAll } from '@elfoqsy/state';
import { renderToStaticMarkup } from 'react-dom/server';
import { EARLIER, briefMarkdown, conversationTime, elfoqsyLine, messageTime, threadOf, ticketOrder, waitsInThread } from '../src/left/model';
import { Markdown, blocks } from '../src/ui/Markdown';
import { eventFactory, mockSprint, time } from './helpers';

const { open, closed } = mockSprint();

describe('left screen: tickets', () => {
  it('steps through tickets from Critical to Minor, the biggest first, so SHOP-2091 is 7 of 7', () => {
    const e = eventFactory();
    const s = foldAll([...open, ...closed].map((t) => e('ticket.synced', { ticket: t })));
    expect(ticketOrder(s).map((t) => t.key)).toEqual(['SHOP-3049', 'SHOP-3472', 'SHOP-3546', 'SHOP-1164', 'CORE-18891', 'SHOP-3533', 'SHOP-2091']);
  });
});

describe('left screen: conversations', () => {
  it('times a conversation by day: 14:16 today and yesterday, the weekday this week, the date before', () => {
    const now = new Date(2026, 9, 8, 14, 24).getTime();
    expect(conversationTime(new Date(2026, 9, 8, 14, 16).getTime(), now)).toBe('14:16');
    expect(conversationTime(new Date(2026, 9, 7, 17, 42).getTime(), now)).toBe('17:42');
    expect(conversationTime(new Date(2026, 9, 5, 9, 0).getTime(), now)).toBe('Mon');
    expect(conversationTime(new Date(2026, 9, 1, 9, 0).getTime(), now)).toBe('Oct 1');
    expect(messageTime(new Date(2026, 9, 7, 16, 7).getTime(), now)).toBe('Yesterday 16:07');
    expect(messageTime(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('Oct 1, 09:05');
  });

  it('keeps messages written outside any conversation together, and finds a waiting approval in a thread', () => {
    const e = eventFactory();
    const events: AnyEnvelope[] = [
      e('elfoqsy.message', { messageId: 'old', role: 'you', text: 'from before conversations' }),
      e('conversation.created', { conversationId: 'c1', title: '429' }),
      e('approval.requested', { approvalId: 'a4', runId: 'r4', kind: 'push', question: 'Push?' }),
      e('elfoqsy.message', { messageId: 'm1', role: 'elfoqsy', text: 'Agent 4 wants to push.', conversationId: 'c1', blocks: [{ type: 'approval', ref: 'a4' }] }),
    ];
    const s = foldAll(events);
    expect(threadOf(s, EARLIER).map((m) => m.messageId)).toEqual(['old']);
    expect(threadOf(s, 'c1').map((m) => m.messageId)).toEqual(['m1']);
    expect(waitsInThread(s, threadOf(s, 'c1'))).toBe(true);
    const answered = foldAll([e('approval.resolved', { approvalId: 'a4', decision: 'approved', test: true })], s);
    expect(waitsInThread(answered, threadOf(answered, 'c1'))).toBe(false);
  });

  it('says how many agents she runs', () => {
    const e = eventFactory();
    const s = foldAll([1, 2].map((n) => e('run.created', { runId: `r${n}`, ticket: `K-${n}`, worktree: '', branch: '', agentNumber: n })));
    expect(elfoqsyLine(s)).toBe('Running 2 agents for you');
    expect(elfoqsyLine(foldAll([]))).toBe('No agents running');
    const failed = foldAll([e('run.state_changed', { runId: 'r2', state: 'failed', reason: 'x' })], s);
    expect(elfoqsyLine(failed)).toBe('Running 1 agent for you');
  });
});

describe('left screen: briefs and Markdown', () => {
  it('copies a brief as Markdown, every section under its heading', () => {
    const md = briefMarkdown({ briefId: 'b', conversationId: 'c', ticket: 'K-1', title: 'Per-step timeout', sections: [{ heading: 'Goal', markdown: 'Always a result.' }, { heading: 'Change', markdown: '1. One\n2. Two' }], at: time(0), runIds: [] });
    expect(md).toBe('# Per-step timeout\n\n## Goal\n\nAlways a result.\n\n## Change\n\n1. One\n2. Two\n');
  });

  it('renders lists, code, bold and links, and never HTML in the text', () => {
    expect(blocks('- a\n- b\n\n1. c\n\nplain\ntext').map((b) => b.kind)).toEqual(['ul', 'ol', 'p']);
    const html = renderToStaticMarkup(<Markdown text={'Keep `export-step-timeout`, **always**. [Jira](https://acme.atlassian.net) <img src=x onerror=alert(1)> [x](javascript:alert(1))'} />);
    expect(html).toContain('<code>export-step-timeout</code>');
    expect(html).toContain('<b>always</b>');
    expect(html).toContain('href="https://acme.atlassian.net"');
    // The raw HTML in the text stays text (an <img src=x onerror=...> is escaped); the only image is the Jira link's own icon.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toMatch(/<a href="https:\/\/acme\.atlassian\.net"[^>]*><span class="link-icon"><span class="tile tile--16 tile--img"/);
    expect(html).not.toContain('href="javascript');
  });
});
