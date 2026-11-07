// Who Elfoqsy is comes before everything else she is told. prompts/identity.md (v2, 19 October) is alex's own text; it is the
// first thing in the prompt of every session where she speaks as herself (her replies, a first responder's answer, the
// workspace updates she speaks first on, her reviews), before her tools and her rules, and it loosens none of them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const IDENTITY_FILE = 'identity.md';

/** The identity's own text with its "Test questions" section taken out: that section only, up to the next one or the end. */
export function withoutTestQuestions(text: string): string {
  const heading = /^##\s+test questions?\b.*$/im.exec(text);
  if (!heading) return text.trim();
  const after = text.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(after);
  return (text.slice(0, heading.index) + (next ? after.slice(next.index) : '')).trim();
}

/**
 * The identity as she gets it: the file without its "Test questions", which are for whoever changes a prompt ("ask these
 * after the change"), not something to put to her.
 */
export function readIdentity(root: string): string {
  return withoutTestQuestions(readFileSync(join(root, 'prompts', IDENTITY_FILE), 'utf8'));
}

/** One of her prompts, with the identity in front of it. */
export function readHerPrompt(root: string, name: string): string {
  return `${readIdentity(root)}\n\n---\n\n${readFileSync(join(root, 'prompts', name), 'utf8').trim()}\n`;
}
