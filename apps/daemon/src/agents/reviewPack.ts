// What the reviewer reads besides the diff (alex, 19 October): the ticket's handoff and its acceptance criteria. The reviewer is offered
// file reads and nothing else, so a file is how it is given anything; and these two are written by the orchestrator when the run starts, from
// the ticket and the handoff as they were then, and are read-only to the run, so what it is held to is the ticket's and his, not what the ticket
// agent says they are. (The diff is the ticket agent's own file: it is what changed, not what was asked.)
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '@elfoqsy/contracts';
import { redact } from '../redact';

export const HANDOFF_FILE = 'handoff.md';
export const ACCEPTANCE_FILE = 'acceptance-criteria.md';

/** Where the pack is, in a run folder. */
export const reviewPackDir = (runRoot: string): string => join(runRoot, '.elfoqsy', 'review');

/** The handoff as the reviewer reads it: his words and constraints, which bind the change, and facts that are leads, not conclusions. */
export function handoffText(ticket: Ticket, handoff?: string): string {
  if (!handoff?.trim()) {
    return `# No handoff for ${ticket.key}\n\nThis run was started without one: nothing was said about it beyond the ticket. ${ACCEPTANCE_FILE} is all there is to hold the change to.\n`;
  }
  return [
    `# The handoff for ${ticket.key}`,
    '',
    "Elfoqsy wrote this from her conversation with alex: his own words, his constraints, and facts with their sources. His constraints bind the change: a diff that breaks one is a finding. The facts are leads, not conclusions, and there is no diagnosis or plan in it on purpose: do not hold the diff to a cause the handoff does not state.",
    '',
    handoff.trim(),
    '',
  ].join('\n');
}

/**
 * The ticket's acceptance criteria: the Jira field of that name when it was read and has text, and the ticket's description (where a bug
 * states its criteria after "AC:"), each under its own heading, so the reviewer can tell which said what.
 */
export function acceptanceText(ticket: Ticket, field?: string): string {
  return [
    `# Acceptance criteria for ${ticket.key}: ${ticket.summary}`,
    '',
    "## The ticket's Acceptance criteria field",
    '',
    field?.trim() ? field.trim() : '(empty, or not read: the description below is then the only statement of what the ticket asks for)',
    '',
    "## The ticket's description",
    '',
    ticket.description.trim() || '(no description)',
    '',
  ].join('\n');
}

/**
 * Writes the pack into the run folder: the two files, mode 0444 (folders stay writable so the run folder can be removed, as with the
 * skill's copy); the gate refuses the file tools any write under it and the sandbox makes it read-only to a shell. Redacted like the
 * prompt: a ticket's description can hold a live key.
 */
export function writeReviewPack(runRoot: string, input: { ticket: Ticket; acceptance?: string; handoff?: string }): { dir: string; files: string[] } {
  const dir = reviewPackDir(runRoot);
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string]> = [
    [HANDOFF_FILE, handoffText(input.ticket, input.handoff)],
    [ACCEPTANCE_FILE, acceptanceText(input.ticket, input.acceptance)],
  ];
  for (const [name, text] of files) {
    const path = join(dir, name);
    // Written again over a read-only file: removed first.
    rmSync(path, { force: true });
    writeFileSync(path, redact(text));
    chmodSync(path, 0o444);
  }
  return { dir, files: files.map(([name]) => name) };
}
