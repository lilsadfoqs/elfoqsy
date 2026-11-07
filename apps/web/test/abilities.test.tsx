// The Abilities view and its cards (brief-abilities part B), as markup from the folded ability.* events: what each card
// shows (logo, level ring, title, finder, re-check dot), the view's header, filters and detail with where the ability came from in one
// line, and her notice in the conversation as its small cards. The browser tests (e2e, "A real use") check them on screen.
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayloadOf } from '@elfoqsy/contracts';
import { ABILITY_LEVELS, ORIGIN_BUDGET, abilityList, abilityOrigin, abilityOriginFull, abilityProgress, abilityTools, foldAll, stepsSavedThisMonth, workedPercent } from '@elfoqsy/state';
import { AbilitiesView } from '../src/abilities/AbilitiesView';
import { AbilityCard, LevelRing } from '../src/ui/AbilityCard';
import { abilitiesView } from '../src/ui/abilitiesView';
import { eventFactory, time } from './helpers';

const learned = (name: string, tool: PayloadOf<'ability.learned'>['tool'], over: Partial<PayloadOf<'ability.learned'>> = {}): PayloadOf<'ability.learned'> => ({
  name,
  version: 1,
  title: `Do ${name}`,
  titleVi: `làm ${name}`,
  tool,
  steps: [
    { text: 'Search the environment for the id', code: "wildfind '<requestId>'", kind: 'read' },
    { text: 'Note the first error', kind: 'note' },
  ],
  finder: { by: 'elfoqsy', session: 'friction analysis' },
  baselineSteps: 5,
  baselineFailed: 1,
  baselineQuestions: 1,
  source: 'friction analysis',
  ...over,
});
const used = (name: string, worked: boolean, steps = 2): PayloadOf<'ability.used'> => ({ name, runId: `r-${Math.random()}`, worked, steps, baselineSteps: 5, failedCalls: 0, baselineFailed: 1, questions: 0, baselineQuestions: 1 });

function world() {
  const e = eventFactory();
  const events = [
    e('ability.learned', learned('find-request-logs', 'coralogix', { baselineQuestions: 0.33, source: 'friction analysis of 30 of his sessions and 10 runs, 2026-10-20' }), 1),
    e('ability.origin', { name: 'find-request-logs', version: 1, foundAt: '2026-10-20T16:30:00.000Z', cases: 24, from: 'episodes of this task in 30 of his sessions and 10 runs before 2026-10-20' }, 1),
    e('ability.learned', learned('find-service-pod', 'kubernetes'), 2),
    e('ability.learned', learned('checkout-e2e', 'test', { finder: { by: 'agent', agentNumber: 5, runId: 'run-5', ticket: 'SHOP-3567' }, baselineSteps: 4, baselineQuestions: 0, source: 'SHOP-3567, Agent 5' }), 3),
    e('ability.origin', { name: 'checkout-e2e', version: 1, foundAt: '2026-10-21T04:00:00.000Z', cases: 2, from: 'runs in the log before the skill' }, 3),
    e('elfoqsy.message', { messageId: 'm1', role: 'elfoqsy', text: 'Two things I worked out from the last runs, written down for next time.', conversationId: 'c1', blocks: [{ type: 'ability', ref: 'find-request-logs' }, { type: 'ability', ref: 'find-service-pod' }] }, 4),
    e('elfoqsy.message', { messageId: 'm2', role: 'elfoqsy', text: 'Agent 5 vừa chỉ cho tôi cách làm checkout-e2e, tôi ghi lại rồi.', conversationId: 'c1', blocks: [{ type: 'ability', ref: 'checkout-e2e' }] }, 5),
    ...Array.from({ length: 4 }, (_, i) => e('ability.used', used('find-request-logs', i < 3), 10 + i)),
    e('ability.needs_recheck', { name: 'find-service-pod', version: 1, step: 0, reason: 'NotFound' }, 20),
  ];
  return foldAll(events);
}

describe('what the cards are read from', () => {
  it('lists the abilities as learned and the tools with their counts', () => {
    const s = world();
    expect(abilityList(s).map((a) => a.name)).toEqual(['find-request-logs', 'find-service-pod', 'checkout-e2e']);
    expect(abilityTools(s)).toEqual([
      { tool: 'coralogix', count: 1 },
      { tool: 'kubernetes', count: 1 },
      { tool: 'test', count: 1 },
    ]);
  });

  it('says where each came from in one line, from what part A keeps: who and when, how often and where, what it cost', () => {
    const s = world();
    // Found in the friction analysis: how many cases, in which sessions, and what each cost (a failed call, a question only from half a one).
    expect(abilityOrigin(s.abilities['find-request-logs']!)).toBe('Found by Elfoqsy, 20 Oct · 24 times in 30 sessions and 10 runs');
    expect(abilityOriginFull(s.abilities['find-request-logs']!)).toBe('Found by Elfoqsy, 20 Oct · 24 times in 30 sessions and 10 runs · 5 calls, 1 failed');
    // Found by an agent on a ticket, in the runs before the skill.
    expect(abilityOrigin(s.abilities['checkout-e2e']!)).toBe('Found by Agent 5 on SHOP-3567, 21 Oct · 2 earlier runs');
    expect(abilityOriginFull(s.abilities['checkout-e2e']!)).toBe('Found by Agent 5 on SHOP-3567, 21 Oct · 2 earlier runs · 4 calls, 1 failed');
    // Not backfilled yet: only what the log has, never a guess.
    expect(abilityOrigin(s.abilities['find-service-pod']!)).toMatch(/^Found by Elfoqsy, \d+ [A-Z][a-z]{2} · 5 calls, 1 failed, 1 question$/);
    const e = eventFactory();
    // Her own: the conversation she found it in, once, and what she wrote of it, whole (the view cuts a line at its width).
    const hers = foldAll([
      e('ability.learned', learned('aws-token-time-left', 'aws', { finder: { by: 'elfoqsy', session: 'c1' }, baselineSteps: 11, source: 'Teams and Outlook summary, Elfoqsy' }), 1),
      e('ability.origin', { name: 'aws-token-time-left', version: 1, foundAt: '2026-10-21T03:33:06.848Z', cases: 1, from: "her own work: No read shows a session's expiry directly; took 11 calls to find issue time via CloudTrail (us-east-1 empty)." }, 2),
    ]);
    const dated = foldAll([
      e('ability.learned', learned('delegate-exec', 'kubernetes', { finder: { by: 'elfoqsy', session: 'today-2026-10-21' }, baselineSteps: 2, baselineFailed: 2, baselineQuestions: 0, source: 'Today, 21 October, Elfoqsy' }), 1),
      e('ability.origin', { name: 'delegate-exec', version: 1, foundAt: '2026-10-21T03:30:00.000Z', cases: 1, from: 'her own work: an exec refused at tier 2, then a task agent that did not start (21 October)' }, 2),
    ]);
    // What she wrote is too long for a line, so the line says what the friction cost; the date she wrote at its end is not said twice in the tip.
    expect(abilityOrigin(dated.abilities['delegate-exec']!)).toBe('Found by Elfoqsy, 21 Oct · once · 2 calls, 2 failed');
    expect(abilityOriginFull(dated.abilities['delegate-exec']!)).toBe('Found by Elfoqsy, 21 Oct · once · an exec refused at tier 2, then a task agent that did not start');
    // The conversation she found it in is worth more than what it cost: the cost is left out when both do not fit.
    expect(abilityOrigin(hers.abilities['aws-token-time-left']!)).toBe('Found by Elfoqsy in “Teams and Outlook summary”, 21 Oct · once');
    expect(abilityOriginFull(hers.abilities['aws-token-time-left']!)).toBe('Found by Elfoqsy in “Teams and Outlook summary”, 21 Oct · once · No read shows a session\'s expiry directly; took 11 calls to find issue time via CloudTrail (us-east-1 empty).');
    // A short one of hers is said whole.
    const short = foldAll([
      e('ability.learned', learned('short-one', 'kubernetes', { finder: { by: 'elfoqsy', session: 'today-2026-10-21' }, source: 'Today, 21 October, Elfoqsy' }), 1),
      e('ability.origin', { name: 'short-one', version: 1, foundAt: '2026-10-21T03:30:00.000Z', cases: 1, from: 'her own work: four empty id searches (21 October)' }, 2),
    ]);
    expect(abilityOrigin(short.abilities['short-one']!)).toBe('Found by Elfoqsy, 21 Oct · once · four empty id searches');
  });

  it('one he asked for is credited to him: asked for by you, his badge on the card (the person icon until he gives his picture)', () => {
    const e = eventFactory();
    const s = foldAll([
      e('ability.learned', learned('football-questions', 'elfoqsy', { finder: { by: 'alex' }, baselineSteps: 0, baselineFailed: 0, baselineQuestions: 0, source: 'alex asked for it, 22 October' }), 1),
      e('ability.origin', { name: 'football-questions', version: 1, foundAt: '2026-10-22T00:00:00.000Z', cases: 0, from: 'not measured yet' }, 2),
    ]);
    const a = s.abilities['football-questions']!;
    expect(a.finder).toEqual({ by: 'alex' });
    // Nothing measured before it existed: no "0 calls".
    expect(abilityOrigin(a)).toBe('Asked for by you, 22 Oct');
    expect(abilityOriginFull(a)).toBe('Asked for by you, 22 Oct');
    const html = renderToStaticMarkup(<AbilityCard ability={a} size="grid" />);
    expect(html).toContain('data-tip="You asked for it"');
    expect(html).toContain('ability-finder--you');
    expect(html).toMatch(/class="ability-finder-icon" style="mask-image:url\(&quot;[^"]*lucide-user/);
    expect(html).not.toContain('Found by Elfoqsy');
  });

  it('never makes a line longer than the budget, whatever the data: what does not fit is left out whole, the who and when stay', () => {
    const e = eventFactory();
    const long = 'a conversation with a very long name that nobody would write on one line of a card';
    const s = foldAll([
      e('ability.learned', learned('long-one', 'jira', { finder: { by: 'agent', agentNumber: 12, runId: 'r', ticket: 'SHOP-123456' }, baselineSteps: 123.4, baselineFailed: 45.6, baselineQuestions: 7.8, source: 'SHOP-123456, Agent 12' }), 1),
      e('ability.origin', { name: 'long-one', version: 1, foundAt: '2026-10-21T03:30:00.000Z', cases: 1234, from: 'x' }, 2),
      e('ability.learned', learned('long-two', 'aws', { finder: { by: 'elfoqsy', session: 'c9' }, source: `${long}, Elfoqsy` }), 3),
      e('ability.origin', { name: 'long-two', version: 1, foundAt: '2026-10-21T03:30:00.000Z', cases: 12, from: `her own work: ${long} (21 October)` }, 4),
    ]);
    for (const a of abilityList(s)) {
      const line = abilityOrigin(a);
      expect(line.length, line).toBeLessThanOrEqual(ORIGIN_BUDGET);
      expect(line).toMatch(/^Found by (Elfoqsy|Agent 12 on SHOP-123456)(?: in “[^”]*”)?, 21 Oct/);
    }
  });

  it('counts this month’s steps saved, the share that worked, and how far a ring has come toward the next level', () => {
    const s = world();
    // Three uses worked, each 3 steps under the median and 1 failed call under the mean.
    expect(s.abilities['find-request-logs']).toMatchObject({ uses: 4, worked: 3, stepsSaved: 12, questionsAvoided: 3, level: 2 });
    expect(stepsSavedThisMonth(s, time(30))).toBe(12);
    expect(stepsSavedThisMonth(s, time(30) + 40 * 86_400_000)).toBe(0);
    expect(workedPercent(s.abilities['find-request-logs']!)).toBe(75);
    expect(workedPercent(s.abilities['checkout-e2e']!)).toBeNull();
    expect(ABILITY_LEVELS).toEqual([1, 3, 8, 15, 30]);
    // Empty when new (level 1, nothing worked yet), then toward level 2 at 3, and so on; full at level 5.
    expect([0, 1, 2, 3, 5, 8, 30, 50].map(abilityProgress).map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0.333, 0.667, 0, 0.4, 0, 1, 1]);
  });
});

describe('a card', () => {
  it('shows its tool’s logo faded behind it, its level in a ring, its title and who found it', () => {
    const s = world();
    const html = renderToStaticMarkup(<AbilityCard ability={s.abilities['find-request-logs']!} size="grid" selected onOpen={() => undefined} />);
    expect(html).toContain('ability-card--grid');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('coralogix-green-icon.svg');
    expect(html).toContain('aria-label="Level 2"');
    expect(html).toContain('Do find-request-logs');
    expect(html).toContain('alt="Found by Elfoqsy"');
    expect(html).not.toContain('ability-recheck');
  });

  it('has the agent’s number when an agent found it, and a red dot when it needs a re-check', () => {
    const s = world();
    expect(renderToStaticMarkup(<AbilityCard ability={s.abilities['checkout-e2e']!} size="grid" onOpen={() => undefined} />)).toMatch(/aria-label="Found by Agent 5 on SHOP-3567"[^>]*>5</);
    expect(renderToStaticMarkup(<AbilityCard ability={s.abilities['find-service-pod']!} size="grid" onOpen={() => undefined} />)).toContain('aria-label="Needs re-check"');
  });

  it('is small in a notice: no title, its ring and finder kept', () => {
    const s = world();
    const html = renderToStaticMarkup(<AbilityCard ability={s.abilities['find-request-logs']!} size="mini" onOpen={() => undefined} />);
    expect(html).toContain('ability-card--mini');
    expect(html).not.toContain('ability-title');
    expect(html).toContain('ability-ring--mini');
  });

  it('fills its ring by the progress toward the next level, never by level ÷ 5', () => {
    const twoOfThree = renderToStaticMarkup(<LevelRing ability={{ level: 1, worked: 2 }} size="grid" />);
    // Radius 19: the circumference is 119.4; two uses of the three that take a new ability to level 2 is 79.6 of it.
    expect(twoOfThree).toContain('stroke-dasharray="79.6 119.4"');
    expect(renderToStaticMarkup(<LevelRing ability={{ level: 1, worked: 0 }} size="grid" />)).not.toContain('ability-ring-fill');
  });
});

describe('the Abilities view', () => {
  beforeEach(() => abilitiesView.reset());

  it('shows the steps saved this month, the tools to filter by, the cards, the chosen card’s numbers and steps, and where it came from', () => {
    const s = world();
    abilitiesView.open('find-request-logs');
    const html = renderToStaticMarkup(<AbilitiesView state={s} now={time(30)} />);
    expect(html).toContain('<h1>Abilities</h1>');
    expect(html).toMatch(/<b>12<\/b><span>steps saved this month<\/span>/);
    expect(html).toContain('aria-label="All, 3"');
    expect(html).toContain('aria-label="Coralogix, 1"');
    expect(html.match(/ability-card--grid/g)).toHaveLength(3);
    expect(html).toContain('<span class="abilities-number-value">4</span><span class="abilities-number-label">uses</span>');
    expect(html).toContain('<span class="abilities-number-value">75%</span><span class="abilities-number-label">worked</span>');
    expect(html).toContain('<span class="abilities-number-value">~12</span><span class="abilities-number-label">steps saved</span>');
    // The prototype's three numbers, and a fourth only because this one has avoided questions (three worked uses, one question each).
    expect(html).toContain('<span class="abilities-number-value">~3</span><span class="abilities-number-label">questions avoided</span>');
    expect(html.match(/class="abilities-number"/g)).toHaveLength(4);
    // A step is its text and, right after it in the same line, its command.
    expect(html).toContain('<span class="abilities-step-line"><span class="abilities-step-text">Search the environment for the id</span><wbr/><code>wildfind &#x27;&lt;requestId&gt;&#x27;</code></span>');
    // The notice is a message in the conversation, not part of the view: nothing of it here, and the ability's origin in one line instead.
    expect(html).not.toContain('abilities-notice');
    expect(html).not.toContain('Agent 5 vừa chỉ cho tôi');
    // One line that fits, and the whole of the origin in its tip when the line leaves something out.
    expect(html).toContain('<p class="abilities-origin" data-tip="Found by Elfoqsy, 20 Oct · 24 times in 30 sessions and 10 runs · 5 calls, 1 failed">Found by Elfoqsy, 20 Oct · 24 times in 30 sessions and 10 runs</p>');
  });

  it('shows only one tool’s cards when filtered, and a single "New" instead of zeros while the chosen one has no use', () => {
    const s = world();
    abilitiesView.open('checkout-e2e');
    abilitiesView.filter('kubernetes');
    const html = renderToStaticMarkup(<AbilitiesView state={s} now={time(30)} />);
    expect(html.match(/ability-card--grid/g)).toHaveLength(1);
    expect(html).toContain('data-ability="find-service-pod"');
    expect(html).toContain('aria-pressed="true" aria-label="Kubernetes, 1"');
    // The chosen card stays in the detail although the filter hides it from the grid.
    expect(html).toContain('<div class="abilities-numbers"><div class="abilities-number"><span class="abilities-number-value">New</span></div></div>');
    // Nothing else is said of it until it has a use: no zeros, no dash, no 0%.
    expect(html).not.toMatch(/>(uses|use|worked|steps saved)</);
    expect(html).not.toContain('<span>–</span>');
    expect(html).not.toMatch(/~0|>0</);
    expect(html).toContain('aria-label="Level 1"'); // new, so level 1
  });

  it('shows the questions avoided only above zero, to one decimal while few (never "~0" for some), whole when many', () => {
    const e = eventFactory();
    const asked = (baselineQuestions: number) =>
      foldAll([
        e('ability.learned', learned('q', 'kubernetes'), 1),
        e('ability.used', { ...used('q', true), questions: 0, baselineQuestions }, 2),
      ]);
    const numbers = (baselineQuestions: number): string[] => {
      abilitiesView.open('q');
      const html = renderToStaticMarkup(<AbilitiesView state={asked(baselineQuestions)} now={time(30)} />);
      return [...html.matchAll(/<span class="abilities-number-value">([^<]*)<\/span>(?:<span class="abilities-number-label">([^<]*)<\/span>)?/g)].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());
    };
    expect(numbers(0)).toEqual(['1 use', '100% worked', '~4 steps saved']);
    expect(numbers(0.33)).toEqual(['1 use', '100% worked', '~4 steps saved', '~0.3 questions avoided']);
    expect(numbers(3)).toEqual(['1 use', '100% worked', '~4 steps saved', '~3 questions avoided']);
    expect(numbers(12.4)).toEqual(['1 use', '100% worked', '~4 steps saved', '~12 questions avoided']);
  });

  it('closes with the design system’s icon button, not a button of its own', () => {
    abilitiesView.open();
    const html = renderToStaticMarkup(<AbilitiesView state={world()} now={time(30)} />);
    expect(html).toContain('class="icon-button abilities-close" aria-label="Close Abilities"');
    expect(html).toContain('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)"');
  });

  it('says so when there is nothing yet', () => {
    abilitiesView.open();
    expect(renderToStaticMarkup(<AbilitiesView state={foldAll([])} now={time(30)} />)).toContain('No abilities yet.');
  });
});
