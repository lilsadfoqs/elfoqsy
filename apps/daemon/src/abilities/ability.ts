// An ability: a short procedure Elfoqsy or an agent learned from real work, in the Claude Agent
// SDK's skills format. Each lives in data/skills/<name>/: ability.json, what the engine keeps (its steps with the reads
// that verify them, who found it, the baseline it is measured against), and SKILL.md, rendered from it for the SDK to
// load progressively (its name and when to use it up front, the rest when invoked). SKILL.md is only ever written from
// here, so it never carries allowed-tools, hooks or anything else that could grant a permission.
import { ABILITY_TOOLS, type AbilityFinder, type AbilityStepView, type AbilityTool, type ProxyName } from '@elfoqsy/contracts';
import { TOOL_NAMES } from '../elfoqsy/tools';
import { READ_PROXIES } from '../permissions/proxy';
import { redact } from '../redact';
import { ENV_OR_PROCESS, isQuestion, type Call } from './friction';

export interface AbilityStep {
  /** One short line. */
  text: string;
  /** The sample it runs, shown beside the line: a command, a query, the arguments of a run tool. */
  code?: string;
  /** For a read: the tier-0 request that verifies it, through the proxies (Elfoqsy's own reads). */
  read?: { proxy: ProxyName; input: Record<string, unknown> };
  /** It changes something: never run to verify it, so it stays unverified. */
  effect?: true;
}

export interface Ability {
  name: string;
  version: number;
  /** What the card says, in work English, and the same as a Vietnamese phrase for her notice ("tìm log của một request"). */
  title: string;
  titleVi: string;
  tool: AbilityTool;
  /** When to use it: the SKILL.md description, so the model knows from the listing alone. */
  whenToUse: string;
  steps: AbilityStep[];
  /**
   * The longer detail the steps' short samples point to (full commands with their flags, an example, why): markdown, kept in the
   * skill's own folder as references/steps.md, which an agent reads when a sample is not enough. A card shows only the samples.
   */
  references?: string;
  doneWhen: string;
  finder: AbilityFinder;
  /** Where it was found: the friction analysis, or a run's ticket. */
  source: string;
  createdAt: string;
  /**
   * What the same kind of task took before the skill existed, over how many cases, and from what: the median steps, and
   * the mean failed calls and questions to alex (means: most cases have none, so their median says nothing).
   */
  baseline: { steps: number; failed: number; questions: number; cases: number; from: string };
  /**
   * What counts as this kind of task in a run's tool calls, for tracking: the run tools it covers, and optionally a
   * pattern their calls match (for a run tool, the call's arguments as one line).
   */
  track: { tools: string[]; match?: string };
}

export const ABILITY_FILE = 'ability.json';
/** The skill's references, beside SKILL.md. */
export const REFERENCES_FILE = 'references/steps.md';
export const MAX_STEPS = 8;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOLS: readonly AbilityTool[] = ABILITY_TOOLS;

/** The tool each of her reading tools is about; her other tools (runs, events, the sprint, tickets, agents) are her own workspace. */
const TOOL_OF_READ: Readonly<Record<string, AbilityTool>> = { kube: 'kubernetes', aws: 'aws', gh: 'github', logs: 'coralogix', lookup_github: 'github', lookup_jira: 'jira', jira_write: 'jira', lookup_confluence: 'confluence' };

/**
 * What a skill is about, told from the run tools it tracks, for one that was written without a tool of its own: the first tool
 * that is a service's, else her own workspace when it tracks her tools, else `other` (no logo, only for a track nobody can place).
 */
export function toolOfTrack(tools: readonly string[]): AbilityTool {
  for (const t of tools) if (TOOL_OF_READ[t]) return TOOL_OF_READ[t]!;
  return tools.some((t) => (TOOL_NAMES as readonly string[]).includes(t)) ? 'elfoqsy' : 'other';
}

/** What is wrong with an ability as written, or an empty list. A skill with a secret in it is refused, not cleaned. */
/** Who it is credited to, in words: an agent, Elfoqsy, or alex for one he asked for. */
export function finderName(f: AbilityFinder): string {
  return f.by === 'agent' ? `Agent ${f.agentNumber}` : f.by === 'alex' ? 'alex' : 'Elfoqsy';
}
const finderLine = (f: AbilityFinder): string => (f.by === 'alex' ? 'Asked for by alex' : `Found by ${finderName(f)}`);

export function problemsOf(a: Ability): string[] {
  const out: string[] = [];
  if (!NAME.test(a.name)) out.push(`name "${a.name}" is not lowercase words joined by hyphens (64 characters at most)`);
  if (!a.title.trim() || a.title.length > 60) out.push('title is empty or longer than 60 characters');
  if (!a.titleVi.trim() || a.titleVi.length > 90) out.push('titleVi is empty or longer than 90 characters');
  if (!TOOLS.includes(a.tool)) out.push(`tool "${a.tool}" is not one of ${TOOLS.join(', ')}`);
  if (!a.whenToUse.trim() || a.whenToUse.length > 300) out.push('whenToUse is empty or longer than 300 characters');
  if (!a.doneWhen.trim() || a.doneWhen.length > 200) out.push('doneWhen is empty or longer than 200 characters');
  if (a.references !== undefined && (!a.references.trim() || a.references.length > 4000)) out.push('references is empty or longer than 4000 characters');
  if (!a.steps.length || a.steps.length > MAX_STEPS) out.push(`it has ${a.steps.length} steps; 1 to ${MAX_STEPS}`);
  a.steps.forEach((s, i) => {
    if (!s.text.trim() || s.text.length > 80 || /\n/.test(s.text)) out.push(`step ${i + 1} is not one short line (80 characters at most)`);
    if (s.code !== undefined && (s.code.length > 200 || /\n/.test(s.code))) out.push(`step ${i + 1}'s sample is not one line of 200 characters at most`);
    if (s.read && s.effect) out.push(`step ${i + 1} is both a read and an effect`);
    if (s.read && !READ_PROXIES.includes(s.read.proxy)) out.push(`step ${i + 1} reads through ${s.read.proxy}, which is not one of ${READ_PROXIES.join(', ')}`);
  });
  if (![a.baseline.steps, a.baseline.failed, a.baseline.questions, a.baseline.cases].every((x) => typeof x === 'number' && x >= 0)) out.push('baseline is not counts');
  if (!a.track.tools.length) out.push('track names no tool');
  if (a.track.match !== undefined) {
    try {
      new RegExp(a.track.match, 'i');
    } catch {
      out.push('track.match is not a regular expression');
    }
  }
  const text = JSON.stringify(a);
  if (redact(text) !== text) out.push('it holds something the redactor removes (a token, a key, a signed URL): never in a skill');
  return out;
}

/**
 * What a card's column holds of one step: 450 px beside its number, for the text (about 6.5 px a character at 15 px) and the sample
 * (about 7.8 at 13 px in mono). A sample over it does not fit the text's line, and goes under it.
 */
export const LINE_PX = 450;
const stepPx = (s: AbilityStep): number => 6.5 * s.text.length + (s.code ? 7.8 * s.code.length : 0);

/** The steps whose text and sample do not fit one line of a card, as "step 2: 43 + 123 characters" (text + sample). */
export const longSteps = (a: Pick<Ability, 'steps'>): string[] =>
  a.steps.flatMap((s, i) => (s.code && stepPx(s) > LINE_PX ? [`step ${i + 1}: ${s.text.length} + ${s.code.length} characters`] : []));

/** The steps as a card shows them. */
export const stepViews = (a: Pick<Ability, 'steps'>): AbilityStepView[] =>
  a.steps.map((s) => ({ text: s.text, ...(s.code ? { code: s.code } : {}), kind: s.read ? 'read' : s.effect ? 'effect' : 'note' }));

const yamlString = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** SKILL.md: the SDK's format, with only the frontmatter keys that describe it. */
export function renderSkill(a: Ability): string {
  const steps = a.steps.map((s, i) => `${i + 1}. ${s.text}${s.code ? `: \`${s.code.replace(/`/g, "'")}\`` : ''}${s.effect ? ' (changes something: only when the task asks for it)' : ''}`);
  return [
    '---',
    `name: ${a.name}`,
    `description: ${yamlString(`${a.title}. ${a.whenToUse}`)}`,
    '---',
    '',
    `# ${a.title}`,
    '',
    '## When to use',
    '',
    a.whenToUse,
    '',
    '## Steps',
    '',
    ...steps,
    '',
    ...(a.references ? ['The samples above are the short form. The full commands and the detail behind them are in `references/steps.md`, in this skill\'s folder: read it when a sample is not enough.', ''] : []),
    '## Done when',
    '',
    a.doneWhen,
    '',
    `${finderLine(a.finder)} (${a.source}). Every step still goes through the proxies and tiers: this skill grants nothing.`,
    '',
  ].join('\n');
}

/** Whether a run's tool call is this kind of task: one of its tools, and its pattern when it has one. */
export function tracks(a: Pick<Ability, 'track'>, call: { tool: string; text: string }): boolean {
  // A run tool (mcp__run__kube) and her own read (mcp__orchestrator__kube) are the same kind of call.
  const tool = call.tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
  if (!a.track.tools.includes(tool)) return false;
  return a.track.match ? new RegExp(a.track.match, 'i').test(call.text) : true;
}

export interface Episode {
  steps: number;
  failed: number;
  questions: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return !s.length ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);

/**
 * What this kind of task took before a skill: in each session, the calls it covers grouped into episodes (a gap of more
 * than `gap` other calls starts a new one). Per episode its steps, its failed calls, and the questions to alex
 * about environments or process asked while it went on. The median steps, the mean failed calls and questions.
 */
export function baselineOf(track: Ability['track'], sessions: Array<{ calls: Call[] }>, gap = 15): { steps: number; failed: number; questions: number; cases: number; episodes: Episode[] } {
  const episodes: Episode[] = [];
  for (const s of sessions) {
    let e: Episode | undefined;
    let since = Infinity;
    for (const c of s.calls) {
      if (tracks({ track }, c)) {
        if (since > gap && e) {
          episodes.push(e);
          e = undefined;
        }
        e ??= { steps: 0, failed: 0, questions: 0 };
        e.steps++;
        if (c.failed) e.failed++;
        since = 0;
      } else {
        since++;
        if (e && since <= gap && isQuestion(c) && ENV_OR_PROCESS.test(c.text)) e.questions++;
      }
    }
    if (e) episodes.push(e);
  }
  return { steps: median(episodes.map((e) => e.steps)), failed: mean(episodes.map((e) => e.failed)), questions: mean(episodes.map((e) => e.questions)), cases: episodes.length, episodes };
}
