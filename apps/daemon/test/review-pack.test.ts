// The reviewer's pack (alex, 19 October): the ticket's handoff and its acceptance criteria, as files in the run folder, beside the diff.
// The text of each file, the Acceptance criteria field read from Jira's detail, and the writing of the pack. Starting a run, the gate, the
// sandbox and the real reviewer reading it are in m15-workflow, v13-agents, sandbox-proof and reviewer-tools.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '@elfoqsy/contracts';
import { acceptanceCriteriaText, fieldIdsOf, type TicketDetailView } from '@elfoqsy/state';
import { acceptanceText, handoffText, reviewPackDir, writeReviewPack } from '../src/agents/reviewPack';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  key: 'SHOP-3546',
  board: 'SHOP',
  summary: 'Payment provider errors are dropped',
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 2,
  sprint: 's',
  sprintsCarried: 0,
  epic: null,
  reporter: 'r',
  created: '',
  updated: '',
  labels: [],
  linked: [],
  description: 'AC: a 429 result has error_code at the top.',
  ...overrides,
});

const ids = fieldIdsOf();
const detail = (fields: Record<string, unknown>): TicketDetailView =>
  ({ key: 'SHOP-3546', id: '1', fields, names: {}, schema: { [ids.acceptanceCriteria]: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } }, editmeta: {}, comments: [], history: [], remoteLinks: [], confluence: {}, locked: [], changes: [], updated: '', fetchedAt: 0 }) as unknown as TicketDetailView;

describe('the Acceptance criteria field as text', () => {
  const doc = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }] }] });

  it('is the field’s rich text as Markdown', () => {
    expect(acceptanceCriteriaText(detail({ [ids.acceptanceCriteria]: doc('error_code is at the top') }), ids)).toBe('- error_code is at the top');
  });

  it('is plain text as it is', () => {
    expect(acceptanceCriteriaText(detail({ [ids.acceptanceCriteria]: 'A success result is unchanged.' }), ids)).toBe('A success result is unchanged.');
  });

  it('is undefined when the ticket was not read, the field is not there or is empty', () => {
    expect(acceptanceCriteriaText(undefined, ids)).toBeUndefined();
    expect(acceptanceCriteriaText(detail({}), ids)).toBeUndefined();
    expect(acceptanceCriteriaText(detail({ [ids.acceptanceCriteria]: null }), ids)).toBeUndefined();
    expect(acceptanceCriteriaText(detail({ [ids.acceptanceCriteria]: { type: 'doc', version: 1, content: [] } }), ids)).toBeUndefined();
    expect(acceptanceCriteriaText(detail({ [ids.acceptanceCriteria]: '   ' }), ids)).toBeUndefined();
  });

  it('follows the site’s field map: another id is another field', () => {
    const other = fieldIdsOf({ acceptanceCriteria: { id: 'customfield_99999' } });
    expect(acceptanceCriteriaText(detail({ customfield_99999: 'From the mapped field.', [ids.acceptanceCriteria]: 'From the default.' }), other)).toBe('From the mapped field.');
  });
});

describe('the two files', () => {
  it('the handoff says what binds and what does not, and carries his words as they are', () => {
    const text = handoffText(ticket(), '## What he said\n\n> keep the v1 path\n\n## Constraints\n\n- keep the v1 path\n');
    expect(text.startsWith('# The handoff for SHOP-3546\n')).toBe(true);
    expect(text).toContain('His constraints bind the change: a diff that breaks one is a finding.');
    expect(text).toContain('The facts are leads, not conclusions');
    expect(text).toContain('> keep the v1 path');
  });

  it('says there is none when there is no handoff, and where the ticket’s own words are', () => {
    for (const none of [undefined, '', '  \n']) expect(handoffText(ticket(), none)).toBe('# No handoff for SHOP-3546\n\nThis run was started without one: nothing was said about it beyond the ticket. acceptance-criteria.md is all there is to hold the change to.\n');
  });

  it('the criteria carry the field and the description under their own headings, so which said what is plain', () => {
    expect(acceptanceText(ticket(), '- A 429 result has error_code at the top.')).toBe(
      [
        '# Acceptance criteria for SHOP-3546: Payment provider errors are dropped',
        '',
        "## The ticket's Acceptance criteria field",
        '',
        '- A 429 result has error_code at the top.',
        '',
        "## The ticket's description",
        '',
        'AC: a 429 result has error_code at the top.',
        '',
      ].join('\n'),
    );
  });

  it('says when the field is empty or was not read, and when there is no description', () => {
    const text = acceptanceText(ticket({ description: '' }));
    expect(text).toContain('(empty, or not read: the description below is then the only statement of what the ticket asks for)');
    expect(text).toContain('(no description)');
  });
});

describe('writing the pack', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'elfoqsy-pack-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('puts two read-only files in .elfoqsy/review of the run folder', () => {
    const { dir, files } = writeReviewPack(root, { ticket: ticket(), acceptance: 'AC.', handoff: 'H.' });
    expect(dir).toBe(reviewPackDir(root));
    expect(dir).toBe(join(root, '.elfoqsy', 'review'));
    expect(files).toEqual(['handoff.md', 'acceptance-criteria.md']);
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o444);
  });

  it('can be written again over its own read-only files', () => {
    writeReviewPack(root, { ticket: ticket(), acceptance: 'First.' });
    writeReviewPack(root, { ticket: ticket(), acceptance: 'Second.' });
    expect(readFileSync(join(reviewPackDir(root), 'acceptance-criteria.md'), 'utf8')).toContain('Second.');
  });

  it('redacts a key that sits in the description or the handoff', () => {
    writeReviewPack(root, { ticket: ticket({ description: 'The key AKIAIOSFODNN7EXAMPLE is in the logs.' }), handoff: 'He said: use AKIAIOSFODNN7EXAMPLE.' });
    for (const f of ['handoff.md', 'acceptance-criteria.md']) expect(readFileSync(join(reviewPackDir(root), f), 'utf8'), f).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
