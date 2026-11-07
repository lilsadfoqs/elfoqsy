import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyEnvelope, Ticket } from '@elfoqsy/contracts';
import { EventLog } from '../src/eventLog';
import { GhReadOnly, type Exec } from '../src/github/gh';
import type { GhPullRequest } from '../src/github/prs';
import { JiraClient } from '../src/jira/client';
import { FAILURES_BEFORE_UNREACHABLE, Poller } from '../src/sync/poller';
import { syncCodeHost, syncTracker } from '../src/sync/sources';
import { GitHubHost, JiraTracker, type TrackerAdapter } from '../src/adapters';
import { SyncTracker } from '../src/sync/tracker';

let dir: string;
let file: string;
let log: EventLog;
let tracker: SyncTracker;

const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elfoqsy-sync-'));
  file = join(dir, 'events.sqlite');
  log = new EventLog(file);
  tracker = new SyncTracker(log);
});

afterEach(() => {
  tracker.close();
  log.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  // A console spy left in place is the same spy for the next test, with its calls: counts would carry over.
  vi.restoreAllMocks();
});

const ticket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  board: key.split('-')[0]!,
  summary: `Summary of ${key}`,
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 2,
  sprint: 'SHOP Sprint 52',
  sprintsCarried: 1,
  epic: null,
  reporter: 'Quinn Bauer',
  created: '8 Oct 2026',
  updated: '8 Oct 2026',
  labels: [],
  linked: [],
  description: 'text',
  ...overrides,
});

describe('SyncTracker: only changes reach the log', () => {
  it('emits new tickets once, then nothing for the same data', () => {
    expect(tracker.applyTickets([ticket('SHOP-1'), ticket('SHOP-2')])).toEqual({ changed: 2, removed: 0 });
    expect(tracker.applyTickets([ticket('SHOP-2'), ticket('SHOP-1')])).toEqual({ changed: 0, removed: 0 });
    expect(events('ticket.synced')).toHaveLength(2);
  });

  it('emits a changed ticket, and removes one that left the sprint', () => {
    tracker.applyTickets([ticket('SHOP-1'), ticket('SHOP-2')]);
    expect(tracker.applyTickets([ticket('SHOP-1', { status: 'Blocked' })])).toEqual({ changed: 1, removed: 1 });
    expect(events().slice(-2).map((e) => e.type)).toEqual(['ticket.synced', 'ticket.removed']);
  });

  it('does not re-emit after a restart', () => {
    tracker.applyTickets([ticket('SHOP-1')]);
    tracker.applyPrs([{ repo: 'o/r', number: 1, state: 'open', ticket: 'SHOP-1', url: '', checks: 'none' }]);
    tracker.close();
    log.close();
    log = new EventLog(file);
    tracker = new SyncTracker(log);
    expect(tracker.applyTickets([ticket('SHOP-1')])).toEqual({ changed: 0, removed: 0 });
    expect(tracker.applyPrs([{ repo: 'o/r', number: 1, state: 'open', ticket: 'SHOP-1', url: '', checks: 'none' }])).toBe(0);
  });

  it('compares what is stored, so a description with a secret does not re-emit every poll', () => {
    const key = Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(i * 5 + 1) % 16]).join('');
    const withSecret = ticket('CORE-18891', { description: `apikey: ${key}` });
    tracker.applyTickets([withSecret]);
    expect(tracker.applyTickets([withSecret]).changed).toBe(0);
    const raw = new Database(file, { readonly: true }).prepare("SELECT payload FROM events WHERE type = 'ticket.synced'").get() as {
      payload: string;
    };
    expect(raw.payload).not.toContain(key);
  });
});

const ghPr = (number: number, overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number,
  title: `PR ${number}`,
  headRefName: `feature/SHOP-3472-${number}`,
  headRefOid: `sha${number}`,
  isDraft: false,
  url: `https://github.com/acme/shop-shared/pull/${number}`,
  state: 'OPEN',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...overrides,
});

describe('syncCodeHost with the GitHub adapter', () => {
  const REPOS = ['acme/shop-shared'];

  function fakeGh(lists: GhPullRequest[][], views: Record<number, GhPullRequest> = {}) {
    let listCall = 0;
    const exec = vi.fn<Exec>(async (_file, args) => {
      if (args[1] === 'list') return { stdout: JSON.stringify(lists[Math.min(listCall++, lists.length - 1)]), stderr: '' };
      if (args[1] === 'view') return { stdout: JSON.stringify(views[Number(args[2])]), stderr: '' };
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    return { gh: new GhReadOnly(REPOS, exec, {}), exec };
  }

  it('emits keyed PRs and their CI once, skips unkeyed ones, and only re-emits on change', async () => {
    const { gh } = fakeGh([
      [ghPr(159), ghPr(160, { headRefName: 'chore/bump', title: 'Bump' })],
      [ghPr(159)],
      [ghPr(159, { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })],
    ]);
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker);
    expect(events('pr.synced').map((e) => e.type === 'pr.synced' && `${e.payload.pr.number}:${e.payload.pr.checks}`)).toEqual(['159:success']);
    expect(events('ci.status')).toHaveLength(1);
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker);
    expect(events()).toHaveLength(2);
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker);
    expect(events('pr.synced').at(-1)).toMatchObject({ payload: { pr: { checks: 'failure' } } });
    expect(events('ci.status').at(-1)).toMatchObject({ payload: { status: 'failure', sha: 'sha159' } });
  });

  it('looks up a PR that left the open list and records it merged', async () => {
    const { gh, exec } = fakeGh([[ghPr(159)], []], { 159: ghPr(159, { state: 'MERGED' }) });
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker);
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker);
    expect(events('pr.synced').at(-1)).toMatchObject({ payload: { pr: { number: 159, state: 'merged' } } });
    expect(exec.mock.calls.filter(([, args]) => args[1] === 'view')).toHaveLength(1);
    await syncCodeHost(new GitHubHost(gh), REPOS, ['SHOP'], tracker); // merged now, not looked up again
    expect(exec.mock.calls.filter(([, args]) => args[1] === 'view')).toHaveLength(1);
  });
});

describe('syncTracker with the Jira adapter', () => {
  it('maps the search result and emits only changes', async () => {
    const body = {
      isLast: true,
      issues: [
        {
          key: 'SHOP-3049',
          fields: {
            summary: 'Checkout fails when a coupon expires mid-session',
            issuetype: { name: 'Bug' },
            status: { name: 'BLOCKED', statusCategory: { key: 'indeterminate' } },
            priority: { name: 'Critical' },
            project: { key: 'SHOP' },
            customfield_16486: 5,
            customfield_10521: [{ name: 'SHOP Sprint 51', state: 'closed' }, { name: 'SHOP Sprint 52', state: 'active' }],
          },
        },
      ],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body)));
    const client = new JiraClient({ site: 'https://acme.atlassian.net', email: 'n', token: 't', fetch });
    const fields = { storyPointsField: 'customfield_16486', sprintField: 'customfield_10521' };
    await syncTracker(new JiraTracker(client, ['SHOP', 'CORE'], fields), tracker);
    await syncTracker(new JiraTracker(client, ['SHOP', 'CORE'], fields), tracker);
    const synced = events('ticket.synced');
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      source: 'jira',
      payload: { ticket: { key: 'SHOP-3049', status: 'Blocked', priority: 'Critical', storyPoints: 5, sprintsCarried: 2 } },
    });
  });
});

describe('Poller: unreachable after 3 failures in a row, ok on the next success', () => {
  it('emits sync.status only on the transitions, with the time of the first failure', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T14:49:00Z') });
    const firstFailure = Date.now();
    const outcomes = [false, false, false, false, true, true, false, true];
    let i = 0;
    const poller = new Poller({
      source: 'jira',
      intervalMs: 60_000,
      log,
      tracker,
      sync: async () => {
        if (!outcomes[i++]) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await poller.start();
    for (let n = 1; n < outcomes.length; n++) await vi.advanceTimersByTimeAsync(60_000);
    poller.stop();

    const statuses = events('sync.status').map((e) => e.type === 'sync.status' && e.payload);
    expect(statuses).toEqual([
      { source: 'jira', state: 'unreachable', since: new Date(firstFailure).toISOString(), reason: 'HTTP 503' },
      { source: 'jira', state: 'ok', since: new Date(firstFailure + 4 * 60_000).toISOString() },
    ]);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(FAILURES_BEFORE_UNREACHABLE).toBe(3);
  });

  it('waits as long as the source asks (Retry-After)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sync = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 429'), { retryAfterSeconds: 300 });
    });
    const poller = new Poller({ source: 'jira', intervalMs: 60_000, log, tracker, sync });
    await poller.start();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe('a tracker adapter of your own', () => {
  it('needs only currentTickets: the sync emits what it returns, and only changes', async () => {
    const tickets: Ticket[] = [
      { key: 'WEB-7', board: 'WEB', summary: 'Dark mode for the settings page', type: 'Story', status: 'In progress', priority: 'Major', storyPoints: 3, sprint: 'Cycle 12', sprintsCarried: 1, epic: null, reporter: 'Sam Lee', created: '2 Nov 2026', updated: '5 Nov 2026', labels: [], linked: [], description: '' },
    ];
    const linear: TrackerAdapter = { id: 'linear', projects: ['WEB'], currentTickets: async () => tickets };
    await syncTracker(linear, tracker);
    await syncTracker(linear, tracker);
    expect(events('ticket.synced').map((e) => e.type === 'ticket.synced' && e.payload.ticket.key)).toEqual(['WEB-7']);
  });
});
