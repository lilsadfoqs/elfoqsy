import { describe, expect, it, vi } from 'vitest';
import { adfToText } from '../src/jira/adf';
import { JiraClient, JiraError, sprintJql } from '../src/jira/client';
import { formatDate, mapIssue, mapPriority, mapStatus, mapType, type JiraIssue } from '../src/jira/map';

const FIELDS = { storyPointsField: 'customfield_16486', sprintField: 'customfield_10521' };

// Synthetic; assembled at run time so no key-shaped literal lives in the repo.
const fakeKey = Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');

const adf = (...paragraphs: string[]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

function issue(overrides: Partial<Record<string, unknown>> = {}, key = 'CORE-18891'): JiraIssue {
  return {
    key,
    fields: {
      summary: 'Raise the payment API rate limit',
      issuetype: { name: 'Task', subtask: false },
      status: { name: 'Open', statusCategory: { key: 'new' } },
      priority: { name: 'Major' },
      project: { key: 'CORE' },
      reporter: { displayName: 'Quinn Bauer' },
      created: '2026-10-08T09:12:00.000+0700',
      updated: '2026-10-08T10:00:00.000+0700',
      labels: ['shop', 'payments'],
      issuelinks: [{ outwardIssue: { key: 'SHOP-3546' } }, { inwardIssue: { key: 'CORE-18161' } }],
      description: adf('shop-api calls the payment provider with its own key.', `apikey: ${fakeKey}`),
      parent: null,
      customfield_16486: null,
      customfield_10521: [
        { id: 1, name: 'Platform 2026-09', state: 'closed' },
        { id: 2, name: 'Platform 2026-10', state: 'active' },
      ],
      ...overrides,
    },
  };
}

describe('status mapping: names first, then the category', () => {
  it.each([
    ['OPEN', 'new', 'To do'],
    ['Open', 'new', 'To do'],
    ['IN PROGRESS', 'indeterminate', 'In progress'],
    ['BLOCKED', 'indeterminate', 'Blocked'],
    ['WORK-DONE', 'done', 'Done'],
    ['RELEASED', 'done', 'Released'],
    ['CLOSE - CANCELLED', 'done', 'Cancelled'],
    ["Won't Do", 'done', 'Cancelled'],
    ['Rejected', 'done', 'Cancelled'],
    ['Code review', 'indeterminate', 'In progress'],
  ])('%s (%s) is %s', (name, category, expected) => {
    expect(mapStatus(name, category)).toBe(expected);
  });

  it('maps priorities and types', () => {
    expect(['Blocker', 'Critical', 'Major', 'Minor', 'Highest', 'Medium', 'Trivial'].map(mapPriority)).toEqual([
      'Blocker',
      'Critical',
      'Major',
      'Minor',
      'Blocker',
      'Major',
      'Minor',
    ]);
    expect([mapType('Bug', false), mapType('Story', false), mapType('Task', false), mapType('Spike', false), mapType('Sub-task', true)]).toEqual([
      'Bug',
      'Story',
      'Task',
      'Task',
      'Sub-task',
    ]);
  });
});

describe('mapIssue', () => {
  it('fills every Ticket field from the Jira issue', () => {
    const t = mapIssue(issue(), FIELDS);
    expect(t).toMatchObject({
      key: 'CORE-18891',
      board: 'CORE',
      type: 'Task',
      status: 'To do',
      priority: 'Major',
      storyPoints: null,
      sprint: 'Platform 2026-10',
      sprintsCarried: 2,
      epic: null,
      reporter: 'Quinn Bauer',
      created: '8 Oct 2026',
      labels: ['shop', 'payments'],
      linked: ['SHOP-3546', 'CORE-18161'],
    });
    expect(t.description).toContain('shop-api calls the payment provider');
  });

  it('names the epic from the parent, and reads story points', () => {
    const t = mapIssue(
      issue({
        parent: { key: 'SHOP-805', fields: { summary: 'Enhance Security Compliance', issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
        customfield_16486: 2,
      }),
      FIELDS,
    );
    expect(t.epic).toBe('Enhance Security Compliance (SHOP-805)');
    expect(t.storyPoints).toBe(2);
  });

  it('writes dates the way Jira shows them', () => {
    expect(formatDate('2025-09-12T10:00:00.000+0000')).toBe('12 Sep 2025');
    expect(formatDate(undefined)).toBe('');
  });

  it('does not call a non-epic parent an epic', () => {
    expect(mapIssue(issue({ parent: { key: 'SHOP-1', fields: { summary: 'Story', issuetype: { name: 'Story' } } } }), FIELDS).epic).toBeNull();
  });

  it('counts sprints the ticket has been in, ignoring future ones', () => {
    const sprints = [
      { name: 'S50', state: 'closed' },
      { name: 'S51', state: 'closed' },
      { name: 'S52', state: 'active' },
      { name: 'S53', state: 'future' },
    ];
    expect(mapIssue(issue({ customfield_10521: sprints }), FIELDS)).toMatchObject({ sprint: 'S52', sprintsCarried: 3 });
    expect(mapIssue(issue({ customfield_10521: null }), FIELDS)).toMatchObject({ sprint: '', sprintsCarried: 1 });
  });
});

describe('adfToText', () => {
  it('keeps paragraphs, lists, code and mentions, and drops media', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Fix' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'lift error_code' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Quinn Bauer' } }] }] },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'retried: 0' }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
      ],
    };
    expect(adfToText(doc)).toBe('Fix\n\n- lift error_code\n- @Quinn Bauer\n\nretried: 0\n\na\nb');
  });

  it('passes plain strings through and treats null as empty', () => {
    expect(adfToText('plain')).toBe('plain');
    expect(adfToText(null)).toBe('');
  });
});

describe('JiraClient', () => {
  const page = (issues: JiraIssue[], nextPageToken?: string) =>
    new Response(JSON.stringify({ issues, ...(nextPageToken ? { nextPageToken } : { isLast: true }) }), { status: 200 });

  it('pages through /rest/api/3/search/jql with nextPageToken, with Basic auth', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(page([issue({}, 'SHOP-1')], 'tok-2'))
      .mockResolvedValueOnce(page([issue({}, 'SHOP-2')]));
    const client = new JiraClient({ site: 'https://acme.atlassian.net/', email: 'n@example.com', token: 'not-a-real-token', fetch });
    const issues = await client.search('project = SHOP', ['summary', 'status']);
    expect(issues.map((i) => i.key)).toEqual(['SHOP-1', 'SHOP-2']);
    const [first, second] = fetch.mock.calls.map(([url]) => new URL(String(url)));
    expect(first!.pathname).toBe('/rest/api/3/search/jql');
    expect(first!.searchParams.get('jql')).toBe('project = SHOP');
    expect(first!.searchParams.get('fields')).toBe('summary,status');
    expect(second!.searchParams.get('nextPageToken')).toBe('tok-2');
    const init = fetch.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('n@example.com:not-a-real-token').toString('base64')}`);
  });

  it('turns HTTP errors into JiraError with the status and Retry-After, never the credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(`Rate limited; Authorization: Basic ${Buffer.from('n@example.com:not-a-real-token').toString('base64')}`, {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );
    const client = new JiraClient({ site: 'https://acme.atlassian.net', email: 'n@example.com', token: 'not-a-real-token', fetch });
    const error = (await client.search('x', []).catch((e: unknown) => e)) as JiraError;
    expect(error).toBeInstanceOf(JiraError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(error.message).toMatch(/^HTTP 429/);
    expect(error.message).not.toContain(Buffer.from('n@example.com:not-a-real-token').toString('base64'));
  });

  it('reports network failures as JiraError', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = new JiraClient({ site: 'https://acme.atlassian.net', email: 'n', token: 't', fetch });
    await expect(client.search('x', [])).rejects.toThrow(/Jira request failed: fetch failed/);
  });

  it('builds the sprint query from validated project keys only', () => {
    expect(sprintJql(['SHOP', 'CORE'])).toBe(
      'project in (SHOP, CORE) AND sprint in openSprints() AND assignee = currentUser() ORDER BY key',
    );
    expect(() => sprintJql(['SHOP) OR (1=1'])).toThrow(JiraError);
  });
});
