import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodeError, CodeReader, globToRegExp } from '../src/elfoqsy/code';
import { Lookups, storageToText } from '../src/elfoqsy/lookups';
import { fieldIdsOf } from '@elfoqsy/state';
import { FakeJira } from '../src/jira/fake';
import { IssueStore } from '../src/jira/issues';
import { assertReadOnly, type GhReadOnly } from '../src/github/gh';

const base = mkdtempSync(join(tmpdir(), 'elfoqsy-code-'));
const clone = join(base, 'shop-api');
const outside = join(base, 'outside.txt');
mkdirSync(join(clone, 'src', 'deep'), { recursive: true });
mkdirSync(join(clone, 'node_modules', 'x'), { recursive: true });
mkdirSync(join(clone, '.git'), { recursive: true });
writeFileSync(join(clone, 'src', 'handler.ts'), 'export function handle() {\n  return dispatchExport(job);\n}\n');
writeFileSync(join(clone, 'src', 'deep', 'wait.go'), 'func wait() { dispatchExport() }\n');
writeFileSync(join(clone, '.env'), 'TOKEN=dispatchExport\n');
writeFileSync(join(clone, 'node_modules', 'x', 'i.js'), 'dispatchExport()\n');
writeFileSync(join(clone, '.git', 'config'), 'dispatchExport\n');
writeFileSync(join(clone, 'blob.bin'), Buffer.from([0, 1, 2, 100, 105, 115]));
writeFileSync(join(clone, 'long.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
writeFileSync(outside, 'dispatchExport outside\n');
symlinkSync(outside, join(clone, 'src', 'link.ts'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const reader = new CodeReader(new Map([['acme/shop-api', clone]]));

describe('reading the clones', () => {
  it('greps text in files only: no .git, node_modules, .env, binaries or links', () => {
    const found = reader.grep({ repo: 'ACME/shop-api', text: 'dispatchExport' });
    expect(found.matches).toEqual([
      { path: 'src/deep/wait.go', line: 1, text: 'func wait() { dispatchExport() }' },
      { path: 'src/handler.ts', line: 2, text: 'return dispatchExport(job);' },
    ]);
    expect(reader.grep({ repo: 'acme/shop-api', text: 'DISPATCHEXPORT', ignoreCase: true, glob: '*.go' }).matches.map((m) => m.path)).toEqual(['src/deep/wait.go']);
  });

  it('searches for the text as written, never as a pattern', () => {
    expect(reader.grep({ repo: 'acme/shop-api', text: '(a+)+$' }).matches).toEqual([]);
  });

  it('reads part of a file, capped', () => {
    const part = reader.read({ repo: 'acme/shop-api', path: 'long.txt', from: 10, lines: 3 });
    expect(part).toMatchObject({ path: 'long.txt', from: 10, to: 12, totalLines: 1000, text: 'line 10\nline 11\nline 12' });
    expect(reader.read({ repo: 'acme/shop-api', path: 'long.txt', lines: 5000 }).to).toBe(400);
  });

  it('refuses anything outside the clone, through .. or a link, and files that hold secrets', () => {
    expect(() => reader.read({ repo: 'acme/shop-api', path: '../outside.txt' })).toThrow(CodeError);
    expect(() => reader.read({ repo: 'acme/shop-api', path: 'src/link.ts' })).toThrow(/outside/);
    expect(() => reader.read({ repo: 'acme/shop-api', path: '.env' })).toThrow(/not readable/);
    expect(() => reader.read({ repo: 'acme/shop-api', path: '.git/config' })).toThrow(/not readable/);
    expect(() => reader.read({ repo: 'acme/shop-api', path: 'blob.bin' })).toThrow(/not text/);
    expect(() => reader.grep({ repo: 'acme/other', text: 'x' })).toThrow(/not one of the repositories/);
    expect(reader.grep({ repo: 'shop-api', text: 'dispatchExport' }).matches).toHaveLength(2);
  });

  it('matches globs like a shell does', () => {
    expect(globToRegExp('*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('lookups', () => {
  it('reads one Jira ticket in full, from the store the ticket view reads (v1.4)', async () => {
    const jira = new FakeJira();
    jira.add({
      issue: {
        id: '1',
        key: 'SHOP-3049',
        fields: {
          summary: 'Exports stall',
          status: { name: 'BLOCKED', statusCategory: { key: 'indeterminate' } },
          priority: { name: 'Critical' },
          issuetype: { name: 'Bug' },
          assignee: { displayName: 'Someone' },
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(50_000) }] }] },
          comment: { comments: Array.from({ length: 25 }, (_, i) => ({ id: String(i), author: { displayName: 'A' }, created: '2026-10-01T10:00:00.000+0700', body: `comment ${i}` })) },
          issuelinks: [{ type: { outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'CORE-1', fields: { summary: 'Other', status: { name: 'OPEN' }, priority: { name: 'Minor' } } } }],
        },
        names: { summary: 'Summary', assignee: 'Assignee' },
        changelog: { histories: [{ id: '7', created: '2026-10-02T10:00:00.000+0700', author: { displayName: 'B' }, items: [{ field: 'status', fromString: 'OPEN', toString: 'BLOCKED' }] }] },
      },
      remoteLinks: [],
    });
    const out = (await new Lookups({ tickets: { store: new IssueStore(jira), ids: () => fieldIdsOf() }, site: 'https://x.atlassian.net' }).jira({ key: 'shop-3049' })) as { key: string; url: string; status: string; text: string };
    expect(out).toMatchObject({ key: 'SHOP-3049', status: 'BLOCKED', url: 'https://x.atlassian.net/browse/SHOP-3049' });
    expect(out.text).toContain('- blocks CORE-1 (OPEN, Minor): Other');
    expect(out.text).toContain('## Comments (25)');
    expect(out.text).toContain('B: status OPEN → BLOCKED');
    // The long Description is cut on its own; the links, comments and history still reach her.
    expect(out.text).toContain('x [cut]');
    expect(out.text.length).toBeLessThan(15_000);
  });

  it('searches code on GitHub only in the repo asked for', async () => {
    const calls: string[][] = [];
    const gh = { json: async (args: string[]) => (calls.push(args), { total_count: 1, items: [{ path: 'a.ts', html_url: 'u', text_matches: [{ fragment: 'f' }] }] }) } as unknown as GhReadOnly;
    const out = await new Lookups({ gh, site: '' }).github({ repo: 'acme/shop-api', what: 'search', query: 'dispatchExport repo:evil/x' });
    expect(out).toEqual({ total: 1, files: [{ path: 'a.ts', url: 'u', fragments: ['f'] }] });
    const endpoint = calls[0]!.at(-1)!;
    expect(decodeURIComponent(endpoint)).toBe('search/code?q=dispatchExport repo:acme/shop-api&per_page=20');
    expect(() => assertReadOnly(calls[0]!, ['acme/shop-api'])).not.toThrow();
  });

  it('allows code search only on polled repositories', () => {
    const search = (q: string) => ['api', `search/code?q=${encodeURIComponent(q)}`];
    expect(() => assertReadOnly(search('x repo:acme/shop-api'), ['acme/shop-api'])).not.toThrow();
    expect(() => assertReadOnly(search('x repo:someone/else'), ['acme/shop-api'])).toThrow(/polled/);
    expect(() => assertReadOnly(search('x'), ['acme/shop-api'])).toThrow(/polled/);
    expect(() => assertReadOnly(search('x repo:acme/shop-api org:acme'), ['acme/shop-api'])).toThrow(/polled/);
    expect(() => assertReadOnly(['api', '-X', 'POST', search('x repo:acme/shop-api')[1]!], ['acme/shop-api'])).toThrow(/GET only/);
  });

  it('turns a Confluence page into text', () => {
    expect(storageToText('<h2>Setup</h2><p>Run &lt;make&gt; &amp; wait.</p><ul><li>one</li><li>two</li></ul>')).toBe('Setup\nRun <make> & wait.\n- one\n- two');
  });

  it('says what is not set up instead of failing', async () => {
    const l = new Lookups({ site: '' });
    expect(await l.logs({ query: 'limit 5' })).toEqual({ error: 'not_configured', message: 'Coralogix is not set up here.' });
    expect(await l.jira({ key: 'SHOP-1' })).toMatchObject({ error: 'not_configured' });
    expect(l.code({ repo: 'x', text: 'y' })).toMatchObject({ error: 'not_configured' });
  });
});
