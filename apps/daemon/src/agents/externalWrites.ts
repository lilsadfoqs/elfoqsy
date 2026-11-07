// The writes other people read (QA, the lead, the manager): a PR's title and body, a PR comment or review, a Jira comment,
// its bug fields, a new ticket or its description, a Confluence page. Each follows alex's writing rules
// (team-dev references/writing.md), and every claim in it points to its evidence.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ProxyName } from '@elfoqsy/contracts';
import { jiraRootCause, jiraSolution, prDescription, type Narrative } from '@elfoqsy/state';

export interface ExternalWrite {
  what: 'PR' | 'Jira' | 'Confluence';
  /** The text people will read. */
  text: string;
}

const flagValue = (args: string[], ...names: string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
};

/** A --body-file's text, read from the run folder or one of its clones; empty when it cannot be found there. */
function bodyFile(path: string, dirs: string[]): string {
  if (path === '-') return '';
  for (const d of dirs) {
    const full = isAbsolute(path) ? path : join(d, path);
    if (full.startsWith(dirs[0]!) && existsSync(full)) return readFileSync(full, 'utf8');
  }
  return '';
}

/** The text of a write other people read, or null when the request is not one. dirs: the run folder first, then its clones. */
export function externalWrite(proxy: ProxyName, input: unknown, dirs: string[]): ExternalWrite | null {
  const o = (input ?? {}) as Record<string, unknown>;
  if (proxy === 'gh') {
    const args = Array.isArray(o.args) ? o.args.map(String) : [];
    const words = args.filter((a) => !a.startsWith('-'));
    if (words[0] !== 'pr' || !['create', 'edit', 'comment', 'review'].includes(words[1] ?? '')) return null;
    if (words[1] === 'review' && args.some((a) => a === '--approve' || a === '-a')) return null;
    const file = flagValue(args, '--body-file', '-F');
    const body = flagValue(args, '--body', '-b') ?? (file ? bodyFile(file, dirs) : '');
    const title = flagValue(args, '--title', '-t') ?? '';
    return { what: 'PR', text: [title, body].filter(Boolean).join('\n') };
  }
  if (proxy === 'jira') {
    switch (o.action) {
      case 'comment':
        return { what: 'Jira', text: String(o.text ?? '') };
      case 'fill':
        return { what: 'Jira', text: [o.rootCause, o.solution, o.ac].filter((x) => typeof x === 'string' && x.trim()).join('\n') };
      case 'create':
        return { what: 'Jira', text: `${String(o.summary ?? '')}\n${String(o.description ?? '')}` };
      case 'edit_description':
        return { what: 'Jira', text: String(o.description ?? '') };
      default:
        return null;
    }
  }
  if (proxy === 'confluence' && (o.action === 'create' || o.action === 'edit')) return { what: 'Confluence', text: String(o.body ?? '') };
  return null;
}

/**
 * Whether a text points to evidence: a link, a file and line, a ticket or PR, a commit, a log query or an id in
 * backticks. A claim without any of these is a claim nobody can check.
 */
export const hasEvidence = (text: string): boolean =>
  /https?:\/\/\S+|\b[\w.-]+(?:\/[\w.-]+)*\.[a-z]{1,5}:\d+\b|\b[A-Z][A-Z0-9]+-\d+\b|(?:^|\s)#\d+\b|\b[0-9a-f]{7,40}\b|`[^`\n]+`/.test(text);

/**
 * The PR description's "Decisions I made": when the run recorded decisions of its own, `gh pr create` (and an
 * edit of the body) must list them there, one point each. Why not, or null when it does or the request is not one.
 */
export function decisionsMissing(proxy: ProxyName, input: unknown, dirs: string[], decisions: string[]): string | null {
  if (proxy !== 'gh' || !decisions.length) return null;
  const args = Array.isArray((input as { args?: unknown })?.args) ? ((input as { args: unknown[] }).args.map(String)) : [];
  const words = args.filter((a) => !a.startsWith('-'));
  if (words[0] !== 'pr' || (words[1] !== 'create' && words[1] !== 'edit')) return null;
  const file = flagValue(args, '--body-file', '-F');
  const given = flagValue(args, '--body', '-b');
  if (given === undefined && !file && words[1] === 'edit') return null; // a title or label edit
  const body = given ?? (file ? bodyFile(file, dirs) : '');
  const section = /(?:^|\n)\s*(?:#{1,6}\s*)?\**Decisions I made\**:?[ \t]*\n([\s\S]*)/i.exec(body);
  const list = `\n${decisions.map((d) => `- ${d}`).join('\n')}`;
  if (!section) return `Not sent: the PR description lists what you decided yourself under a "Decisions I made" heading, one point each, flagged ones first:${list}`;
  // Its own points only: the section ends at the next heading or bold heading line ("## Testing", "**Risks**").
  const lines = section[1]!.split('\n');
  const end = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(l));
  const points = (end < 0 ? lines : lines.slice(0, end)).filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
  if (points < decisions.length) return `Not sent: "Decisions I made" has ${points} point${points === 1 ? '' : 's'}; it lists all ${decisions.length}:${list}`;
  return null;
}

/** gh's flags that carry a PR's body, whole or as a file, with the value that follows. */
const BODY_FLAGS = ['--body', '-b', '--body-file', '-F'];

/** The request without any body the agent wrote: a PR's description is the narrative's (N1). */
function withoutBody(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (BODY_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (BODY_FLAGS.some((f) => a.startsWith(`${f}=`))) continue;
    out.push(a);
  }
  return out;
}

export type Produced = { input: unknown; note?: string } | { refusal: string };

/**
 * What the narrative writes in the places other people read (N1): a PR's description (on `gh pr create`, and on an edit that
 * sets the body) and Jira's Root cause and Solution (on `fill`). The agent's own text for those is replaced, so they say only
 * what its reports say; when a report is missing, the request is refused with the one it owes. Other writes pass through.
 */
export function fromNarrative(proxy: ProxyName, input: unknown, narrative: Narrative | undefined): Produced {
  const o = (input ?? {}) as Record<string, unknown>;
  if (proxy === 'gh') {
    const args = Array.isArray(o.args) ? o.args.map(String) : [];
    const words = args.filter((a) => !a.startsWith('-'));
    if (words[0] !== 'pr' || (words[1] !== 'create' && words[1] !== 'edit')) return { input };
    const sets = args.some((a) => BODY_FLAGS.includes(a) || BODY_FLAGS.some((f) => a.startsWith(`${f}=`)));
    if (words[1] === 'edit' && !sets) return { input }; // a title or label edit
    if (!narrative) return { refusal: 'Not sent: the PR description is written from your reports (the ticket narrative), and none has been made for this run yet.' };
    const made = prDescription(narrative);
    if (!made.ok) return { refusal: `Not sent: the PR description is written from your reports, and one is missing: ${made.missing}. Report it, then send the request again.` };
    return { input: { ...o, args: [...withoutBody(args), '--body', made.text] }, note: `The PR description is the ticket narrative's, from your reports; yours was not used:\n\n${made.text}` };
  }
  if (proxy === 'jira' && o.action === 'fill') {
    const named = (['rootCause', 'solution'] as const).filter((f) => o[f] !== undefined);
    if (!named.length) return { input };
    if (!narrative) return { refusal: 'Not sent: Root cause and Solution are written from your reports (the ticket narrative), and none has been made for this run yet.' };
    const next: Record<string, unknown> = { ...o };
    for (const f of named) {
      const made = f === 'rootCause' ? jiraRootCause(narrative) : jiraSolution(narrative);
      if (!made.ok) return { refusal: `Not sent: ${f === 'rootCause' ? 'Root cause' : 'Solution'} is written from your reports, and one is missing: ${made.missing}. Report it, then send the request again.` };
      next[f] = made.text;
    }
    return { input: next, note: 'Root cause and Solution are the ticket narrative\'s, from your reports; the text you gave was not used.' };
  }
  return { input };
}
