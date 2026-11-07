// Jira news in Elfoqsy's digest : when alex comes back after being away, what happened in
// Jira meanwhile. One search covers it: tickets he is assigned to or reported, and comments that mention him
// (comment ~ currentUser, which Jira supports), with their changelogs. Only what others did is news: transitions,
// changes and comments on his tickets, and mentions of him anywhere. One row each: who, what, the ticket, the time.
// Also when he opens the digest himself: since his last digest or news, and said in one line when there is none.
import type { JiraNewsItem } from '@elfoqsy/contracts';
import { jiraTime } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';
import { tr } from '../elfoqsy/voice';
import { redact } from '../redact';
import { ulid } from '../ulid';

export interface NewsIssue {
  key: string;
  fields: Record<string, unknown>;
  changelog?: { histories?: Array<{ created: string; author?: { accountId?: string; displayName?: string }; items?: Array<Record<string, unknown>> }> };
}

export interface JiraNewsDeps {
  log: EventLog;
  reader: { news(jql: string, max: number): Promise<NewsIssue[]>; myself(): Promise<{ accountId: string }> };
  now?: () => number;
  max?: number;
}

const NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const words = (n: number): string => NUMBERS[n] ?? String(n);
const NUMBERS_VI = ['Không', 'Một', 'Hai', 'Ba', 'Bốn', 'Năm', 'Sáu', 'Bảy', 'Tám', 'Chín', 'Mười'];
const wordsVi = (n: number): string => NUMBERS_VI[n] ?? String(n);

/** Whether a comment's body mentions this account. */
const mentions = (body: unknown, accountId: string): boolean => JSON.stringify(body ?? null).includes(`"id":"${accountId}"`) && JSON.stringify(body).includes('"type":"mention"');

export class JiraNews {
  constructor(private readonly d: JiraNewsDeps) {}

  /** What changed since then, as rows; no Jira read happens unless he was away. */
  async items(since: number): Promise<JiraNewsItem[]> {
    const now = this.d.now?.() ?? Date.now();
    const minutes = Math.max(1, Math.ceil((now - since) / 60_000) + 1);
    const jql = `(assignee = currentUser() OR reporter = currentUser() OR comment ~ currentUser()) AND updated >= -${minutes}m ORDER BY updated DESC`;
    const [issues, me] = await Promise.all([this.d.reader.news(jql, 50), this.d.reader.myself()]);
    const items: JiraNewsItem[] = [];
    for (const i of issues) {
      const f = i.fields;
      const mine = (f.assignee as { accountId?: string } | null)?.accountId === me.accountId || (f.reporter as { accountId?: string } | null)?.accountId === me.accountId;
      for (const h of i.changelog?.histories ?? []) {
        if (jiraTime(h.created) <= since || h.author?.accountId === me.accountId || !mine) continue;
        for (const it of h.items ?? []) {
          const who = h.author?.displayName ?? 'Someone';
          const field = typeof it.field === 'string' ? it.field : '';
          const to = typeof it.toString === 'string' ? it.toString : '';
          if (field === 'status') items.push({ kind: 'transition', who, what: `moved to ${to}`.trim(), key: i.key, at: h.created });
          else if (field) items.push({ kind: 'change', who, what: `changed ${field}${to ? ` to ${to}` : ''} on`, key: i.key, at: h.created });
        }
      }
      const comments = ((f.comment as { comments?: Array<{ created: string; author?: { accountId?: string; displayName?: string }; body?: unknown }> } | undefined)?.comments ?? []);
      for (const c of comments) {
        if (jiraTime(c.created) <= since || c.author?.accountId === me.accountId) continue;
        const who = c.author?.displayName ?? 'Someone';
        if (mentions(c.body, me.accountId)) items.push({ kind: 'mention', who, what: 'mentioned you in', key: i.key, at: c.created });
        else if (mine) items.push({ kind: 'comment', who, what: 'commented on', key: i.key, at: c.created });
      }
    }
    return items.sort((a, b) => jiraTime(b.at) - jiraTime(a.at)).slice(0, this.d.max ?? 12);
  }

  /** He came back: Elfoqsy's line and the news block, in the conversation he came back to. Nothing when nothing happened. */
  async onBack(since: number, conversationId: string): Promise<void> {
    const items = await this.items(since);
    if (items.length) this.post(items, since, conversationId, { prefix: tr('Welcome back. ', 'Chào mừng cậu quay lại. ') });
  }

  /** He opened the digest: the news since then, or one line saying there is none, or that Jira could not be read. */
  async onAsked(since: number, conversationId: string): Promise<void> {
    let items: JiraNewsItem[];
    try {
      items = await this.items(since);
    } catch (error) {
      const why = redact(error instanceof Error ? error.message : String(error)).slice(0, 200);
      this.say(conversationId, tr(`I could not read Jira just now, so its news is missing here: ${why}`, `Tôi không đọc được Jira lúc này nên tin từ Jira bị thiếu ở đây: ${why}`));
      return;
    }
    if (items.length) this.post(items, since, conversationId, { when: tr(` since ${hhmm(since)}`, ` từ ${hhmm(since)}`) });
    else this.say(conversationId, tr(`Nothing happened in Jira since ${hhmm(since)}: no changes on your tickets, and no mentions of you.`, `Không có gì xảy ra ở Jira từ ${hhmm(since)}: không có thay đổi nào ở ticket của cậu, và không ai nhắc tới cậu.`));
  }

  /** "Welcome back. Four things happened in Jira; one mentions you." or "Two things happened in Jira since 09:12." */
  private post(items: JiraNewsItem[], since: number, conversationId: string, o: { prefix?: string; when?: string }): void {
    const newsId = `news-${ulid().toLowerCase()}`;
    this.d.log.append('jira', 'jira.news', { newsId, since: new Date(since).toISOString(), conversationId, items });
    const mentioned = items.filter((i) => i.kind === 'mention').length;
    const things = tr(`${words(items.length)} thing${items.length === 1 ? '' : 's'} happened in Jira`, `Có ${wordsVi(items.length).toLowerCase()} việc xảy ra ở Jira`);
    const tail = mentioned
      ? tr(`; ${mentioned === 1 ? 'one mentions' : `${words(mentioned).toLowerCase()} mention`} you`, `; ${wordsVi(mentioned).toLowerCase()} việc nhắc tới cậu`)
      : '';
    this.d.log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text: `${o.prefix ?? ''}${things}${o.when ?? ''}${tail}.`, conversationId, blocks: [{ type: 'jira_news', ref: newsId }] });
  }

  private say(conversationId: string, text: string): void {
    this.d.log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, conversationId });
  }
}

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
