// What the Abilities view and the notice's card show, read from the ability.* events folded in
// fold.ts: the cards in the order they were learned, the tools to filter by with their counts, the steps saved this
// month, a card's numbers, how far its ring has come toward its next level, and where each came from in one line.
import type { AbilityTool } from '@elfoqsy/contracts';
import { ABILITY_LEVELS, abilityLevel, type AbilityView, type WorkspaceState } from './fold';

/** Every ability, in the order it was learned. */
export const abilityList = (s: WorkspaceState): AbilityView[] => Object.values(s.abilities).sort((a, b) => a.learnedAt - b.learnedAt || a.name.localeCompare(b.name));

/** The tools the abilities are about, each with how many, in the order they first appear. */
export function abilityTools(s: WorkspaceState): Array<{ tool: AbilityTool; count: number }> {
  const counts = new Map<AbilityTool, number>();
  for (const a of abilityList(s)) counts.set(a.tool, (counts.get(a.tool) ?? 0) + 1);
  return [...counts].map(([tool, count]) => ({ tool, count }));
}

/** Steps saved by every ability in the month of `now` (UTC, as the fold keys them). */
export const stepsSavedThisMonth = (s: WorkspaceState, now: number): number => {
  const month = new Date(now).toISOString().slice(0, 7);
  return Object.values(s.abilities).reduce((n, a) => n + (a.savedByMonth[month] ?? 0), 0);
};

/** How far a ring has come toward the next level, 0 to 1: empty when it is new (level 1, no use that worked), full at level 5. */
export function abilityProgress(worked: number): number {
  const level = abilityLevel(worked);
  if (level >= ABILITY_LEVELS.length) return 1;
  // Level 1 is held from the start, so its stretch runs from nothing to the threshold of level 2; each later level from its own threshold.
  const from = level === 1 ? 0 : ABILITY_LEVELS[level - 1]!;
  const to = ABILITY_LEVELS[level]!;
  return Math.max(0, Math.min(1, (worked - from) / (to - from)));
}

/** The share of uses that worked, as a whole percent; null before the first use. */
export const workedPercent = (a: Pick<AbilityView, 'uses' | 'worked'>): number | null => (a.uses ? Math.round((a.worked / a.uses) * 100) : null);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** A date as the Abilities view says it: "20 Oct" (UTC, as the fold keys the months). */
const shortDate = (ms: number): string => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;
const count = (n: number): string => String(Math.round(n * 10) / 10);
const TIMES = ['', 'once', 'twice'];

/** The most characters of the origin line: it is one line at 15 px in the 520 px column, so what does not fit is left out whole, never cut. */
export const ORIGIN_BUDGET = 70;

type OriginFacts = Pick<AbilityView, 'finder' | 'source' | 'origin' | 'learnedAt' | 'baselineSteps' | 'baselineFailed' | 'baselineQuestions'>;

/** What part A keeps of where an ability came from, in the pieces the line is made of. A part the data does not have is left out, never guessed. */
function originParts(a: OriginFacts) {
  // What she wrote of her own work, without the date she put at its end (the line says when already).
  const own = a.origin?.from.startsWith('her own work: ') ? a.origin.from.slice('her own work: '.length).replace(/\s*\(\d{1,2} [A-Za-z]+(?: \d{4})?\)\.?$/, '').trim() : '';
  // Who, where it was found, and when: an agent on its ticket, Elfoqsy in the conversation she wrote it from (a friction analysis is not
  // one, and Today's conversation is named by the date the line already says).
  const analysis = /^friction analysis of (.+?)(?:,\s*\d{4}-\d{2}-\d{2})?$/.exec(a.source);
  const conversation = a.finder.by === 'elfoqsy' && !analysis ? /^(.*), Elfoqsy$/.exec(a.source)?.[1] : undefined;
  const named = conversation && !/^Today, /.test(conversation) ? conversation : undefined;
  const found = a.finder.by === 'agent' ? `Agent ${a.finder.agentNumber}${a.finder.ticket ? ` on ${a.finder.ticket}` : ''}` : a.finder.by === 'alex' ? 'you' : 'Elfoqsy';
  // One he asked for: asked for, not found; and no friction to tell before it was measured.
  const verb = a.finder.by === 'alex' ? 'Asked for by' : 'Found by';
  const measured = !(a.finder.by === 'alex' && !a.origin?.cases);
  const when = shortDate(a.origin?.foundAt ?? a.learnedAt);
  // How often, and where.
  const cases = a.origin?.cases;
  const times = cases === undefined ? '' : cases >= 1 && cases <= 2 ? TIMES[Math.round(cases)]! : `${Math.round(cases)} times`;
  const scope = analysis ? `in ${analysis[1]!.replace(/\b(?:of )?his\b ?/g, '').replace(/\s+/g, ' ')}` : '';
  // An agent's baseline is the runs before the skill that made such calls: one case each.
  const often = a.finder.by === 'agent' ? (cases === undefined ? '' : `${Math.round(cases)} earlier run${Math.round(cases) === 1 ? '' : 's'}`) : [times, scope].filter(Boolean).join(' ');
  // What it cost: the numbers measured.
  const calls = `${count(a.baselineSteps)} call${a.baselineSteps === 1 ? '' : 's'}`;
  const numbers = [calls, a.baselineFailed >= 0.5 ? `${count(a.baselineFailed)} failed` : '', a.baselineQuestions >= 0.5 ? `${count(a.baselineQuestions)} question${a.baselineQuestions === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  return { verb, found, named, when, often: measured ? often : '', own, numbers: measured ? numbers : '' };
}

/**
 * Where an ability came from, in one line that fits (ORIGIN_BUDGET): who found it and when, then how often and where, then what the
 * friction was or cost. "Found by Elfoqsy, 20 Oct · 24 times in 30 sessions and 10 runs". What is too long to say in the line is left out,
 * the least important first (what the friction cost or was, then the conversation's name, then how often), never cut in the middle:
 * abilityOriginFull has all of it, for the tip.
 */
export function abilityOrigin(a: OriginFacts): string {
  const p = originParts(a);
  const head = (conversation: boolean) => `${p.verb} ${p.found}${conversation && p.named ? ` in “${p.named}”` : ''}, ${p.when}`;
  const line = (conversation: boolean, what: string) => [head(conversation), p.often, what].filter(Boolean).join(' · ');
  // Richest first: the conversation she found it in matters more than what the friction cost.
  const tries = [p.own && line(true, p.own), line(true, p.numbers), p.own && line(false, p.own), line(true, ''), line(false, p.numbers), line(false, ''), head(false)];
  return tries.find((l) => l && l.length <= ORIGIN_BUDGET) || head(false);
}

/** All of an origin, as the tip says it: what the line leaves out when it is too long for one line. */
export function abilityOriginFull(a: OriginFacts): string {
  const p = originParts(a);
  return [`${p.verb} ${p.found}${p.named ? ` in “${p.named}”` : ''}, ${p.when}`, p.often, p.own || p.numbers].filter(Boolean).join(' · ');
}
