// What Elfoqsy's brain derives from the state: where a workspace update belongs, the day's "Today"
// conversation, the facts a conversation starts with, and briefs as Markdown. Shared with the screens.
import type { BriefView, FactView, HandoffView, RunView, WorkspaceState } from './fold';

/** A brief as one Markdown document: what Copy as Markdown gives and what the ticket agent reads. */
export function briefMarkdown(b: BriefView | Pick<BriefView, 'title' | 'sections'>): string {
  return [`# ${b.title}`, '', ...b.sections.flatMap((s) => [`## ${s.heading}`, '', s.markdown.trim(), ''])].join('\n').trim() + '\n';
}

const MODE_WORDS: Record<HandoffView['mode'], string> = { normal: 'normal', read_only: 'read-only: no edits at all', hotfix: 'hotfix', remediation: 'remediation' };

/** A source as one line: `shop-api/src/auth.ts:27`, SHOP-3492, a query, a link. */
const sourceText = (s: { kind: string; ref: string; label?: string }): string => `${s.kind === 'code' || s.kind === 'log' ? `\`${s.ref}\`` : s.ref}${s.label ? ` (${s.label})` : ''}`;

/**
 * A handoff as one Markdown document: what Copy as Markdown gives and what the ticket agent reads first. His words are
 * quoted as he wrote them; each fact keeps its sources; nothing of a diagnosis or a plan.
 */
export function handoffMarkdown(h: Pick<HandoffView, 'ticket' | 'mode' | 'bases' | 'context' | 'constraints' | 'facts'>): string {
  const quote = (text: string) => text.trim().split('\n').map((l) => `> ${l}`).join('\n');
  const bases = Object.entries(h.bases ?? {});
  return [
    `# Handoff: ${h.ticket}`,
    '',
    '## Ticket',
    '',
    `${h.ticket}, mode ${MODE_WORDS[h.mode]}.${bases.length ? ` Base: ${bases.map(([repo, base]) => `${base} in ${repo}`).join(', ')}.` : ''}`,
    '',
    '## Conversation',
    '',
    ...(h.context.length ? h.context.flatMap((m) => [`${m.role === 'test' ? 'The tester' : 'alex'}:`, '', quote(m.text), '']) : ['(nothing beyond the ticket)', '']),
    '## Constraints',
    '',
    ...(h.constraints.length ? h.constraints.map((c) => `- ${c.text}`) : ['- none']),
    '',
    '## Known facts',
    '',
    ...(h.facts.length ? h.facts.map((f) => `- ${f.text} (${f.sources.map(sourceText).join('; ')})`) : ['- none beyond the ticket']),
  ].join('\n').trim() + '\n';
}

/** A verdict in words, in the team-dev skill's labels: "VALID, reproduced", "VALID, not reproduced yet", "EXPECTED_BEHAVIOR/INVALID". */
export function verdictWords(v: Pick<NonNullable<RunView['verdict']>, 'verdict' | 'reproduced'>): string {
  return v.verdict === 'VALID' ? `VALID, ${v.reproduced ? 'reproduced' : 'not reproduced yet'}` : v.verdict;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The day's conversation for updates that belong to no ticket's conversation: one per day, by its id. */
export function todayConversation(now: number): { conversationId: string; title: string } {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { conversationId: `today-${day}`, title: `Today, ${d.getDate()} ${MONTHS[d.getMonth()]}` };
}

/**
 * The conversation an update about a ticket goes to: the one its run was started from, else the
 * ticket's most recent conversation. Undefined when there is none: then it goes to Today's.
 */
export function conversationForTicket(s: WorkspaceState, ticket: string | undefined, runId?: string): string | undefined {
  const fromRun = runId ? s.runs[runId]?.conversationId : undefined;
  if (fromRun && s.conversations[fromRun]) return fromRun;
  if (!ticket) return undefined;
  const mine = Object.values(s.conversations).filter((c) => c.ticket === ticket && !c.conversationId.startsWith('today-'));
  return mine.sort((a, b) => b.lastAt - a.lastAt)[0]?.conversationId;
}

/**
 * The rules alex confirmed that apply to a run in these repositories: those for one of them, and
 * those for all repos. Rules the tester confirmed are kept but never given to a real run.
 */
export function rulesFor(s: WorkspaceState, repos: string[]): FactView[] {
  const mine = new Set(repos.map((r) => r.toLowerCase()));
  return Object.values(s.memory)
    .filter((f) => f.kind === 'rule' && f.origin === 'you' && (!f.repos?.length || f.repos.some((r) => mine.has(r.toLowerCase()))))
    .sort((a, b) => a.at - b.at);
}

/** Facts a conversation starts with: its ticket's first, then the newest; stale ones are marked so. */
export function factsFor(s: WorkspaceState, ticket: string | undefined, now: number, limit = 30): Array<FactView & { stale: boolean }> {
  const names = (f: FactView, key: string) => f.statement.includes(key) || f.sources.some((src) => src.ref === key || src.ref.includes(key));
  return Object.values(s.memory)
    .sort((a, b) => Number(ticket ? names(b, ticket) : 0) - Number(ticket ? names(a, ticket) : 0) || b.at - a.at)
    .slice(0, limit)
    .map((f) => ({ ...f, stale: f.freshUntil < now }));
}
