// An agent's question, as alex wants to read it : one line, why in at most three short points,
// two to four options each with its consequence, the agent's recommended option, and its sources. A free-form block of
// text is refused with what to change, so the agent asks again in this shape.
import type { QuestionCard, SourceRef } from '@elfoqsy/contracts';

export const CARD_LIMITS = { question: 200, why: 3, whyChars: 140, optionsMin: 2, optionsMax: 4, label: 60, consequence: 140, sources: 6 } as const;
const SOURCE_KINDS = new Set(['code', 'ticket', 'pr', 'log', 'doc', 'url']);

/** What the tool receives: loose on purpose, so a wrong shape gets this module's words, not a schema error. */
export interface CardInput {
  question?: string;
  why?: string[];
  options?: Array<{ label?: string; consequence?: string }>;
  recommendation?: string;
  sources?: Array<{ kind?: string; ref?: string; label?: string }>;
}

const sentences = (t: string): number => (t.trim().match(/[.!?](\s|$)/g) ?? []).length;

/** The card, or every reason it cannot be asked as it is. */
export function questionCard(input: CardInput): { card: QuestionCard } | { problems: string[] } {
  const problems: string[] = [];
  const question = (input.question ?? '').trim();
  if (!question) problems.push('question: say it in one line.');
  else if (/\n/.test(question)) problems.push('question: one line, no line breaks; put the reasons in why and the choices in options.');
  else if (question.length > CARD_LIMITS.question) problems.push(`question: at most ${CARD_LIMITS.question} characters (it has ${question.length}); put the reasons in why.`);
  const why = (input.why ?? []).map((w) => w.trim()).filter(Boolean);
  if (why.length > CARD_LIMITS.why) problems.push(`why: at most ${CARD_LIMITS.why} points.`);
  why.forEach((w, i) => {
    if (/\n/.test(w) || w.length > CARD_LIMITS.whyChars || sentences(w) > 1) problems.push(`why ${i + 1}: one short point, at most ${CARD_LIMITS.whyChars} characters and one sentence.`);
  });
  const options = (input.options ?? []).map((o) => ({ label: (o.label ?? '').trim(), consequence: (o.consequence ?? '').trim() }));
  if (options.length < CARD_LIMITS.optionsMin || options.length > CARD_LIMITS.optionsMax) problems.push(`options: ${CARD_LIMITS.optionsMin} to ${CARD_LIMITS.optionsMax}, each a label and its consequence.`);
  options.forEach((o, i) => {
    if (!o.label || /\n/.test(o.label) || o.label.length > CARD_LIMITS.label) problems.push(`option ${i + 1}: a label of at most ${CARD_LIMITS.label} characters.`);
    if (!o.consequence || /\n/.test(o.consequence) || o.consequence.length > CARD_LIMITS.consequence) problems.push(`option ${i + 1}: its consequence in at most ${CARD_LIMITS.consequence} characters.`);
  });
  if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) problems.push('options: each label once.');
  const recommendation = options.find((o) => o.label.toLowerCase() === (input.recommendation ?? '').trim().toLowerCase())?.label;
  if (!recommendation) problems.push('recommendation: one of the option labels, as written.');
  const sources = (input.sources ?? []).map((x) => ({ kind: (x.kind ?? '').trim(), ref: (x.ref ?? '').trim(), ...(x.label?.trim() ? { label: x.label.trim() } : {}) }));
  if (sources.length > CARD_LIMITS.sources) problems.push(`sources: at most ${CARD_LIMITS.sources}.`);
  sources.forEach((x, i) => {
    if (!SOURCE_KINDS.has(x.kind) || !x.ref) problems.push(`source ${i + 1}: a kind (code, ticket, pr, log, doc or url) and a ref.`);
  });
  if (problems.length) return { problems };
  return { card: { question, why, options, recommendation: recommendation!, sources: sources as SourceRef[] } };
}
