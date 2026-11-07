// Elfoqsy reports what her tools returned, never a cause she made up (alex's rule after probe P1). Her session runs
// on the fake SDK; her tools run for real through her in-process MCP server. A reply that gives a cause no tool returned,
// for something a tool dropped, rejected or changed, goes back to her once before anything is posted.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EventType, PayloadOf } from '@elfoqsy/contracts';
import { UsageState } from '../src/claude/usage';
import { REPO_ROOT } from '../src/config';
import { cannotLookUp, correction, inventedCauses, lookupCorrection, outcomesOf } from '../src/elfoqsy/fidelity';
import { LiveState } from '../src/elfoqsy/liveState';
import type { Lookups } from '../src/elfoqsy/lookups';
import { ElfoqsySession } from '../src/elfoqsy/session';
import { orchestratorServer } from '../src/elfoqsy/tools';
import { EventLog } from '../src/eventLog';
import { ManualClock, fakeSdk, result, runTool, text, tick } from './helpers/fakeSdk';

const T0 = Date.parse('2026-10-11T16:00:00Z');
let log: EventLog;
let live: LiveState;
let usage: UsageState;
let clock: ManualClock;
let sdk: ReturnType<typeof fakeSdk>;
let session: ElfoqsySession;

const payloads = <T extends EventType>(type: T) => log.readFrom(0, 100_000, [type]).map((e) => e.payload as PayloadOf<T>);
const hers = () => payloads('elfoqsy.message').filter((m) => m.role === 'elfoqsy').map((m) => m.text);

/** A Jira search that leaves a ticket out of its answer and gives no reason. */
const lookups = {
  jira: async () => ({ issues: [{ key: 'SHOP-1164', status: 'To do' }], dropped: [{ text: 'SHOP-2091' }] }),
} as unknown as Lookups;

beforeEach(() => {
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  live = new LiveState(log);
  usage = new UsageState(log, clock, () => clock.now);
  sdk = fakeSdk();
  log.append('jira', 'ticket.synced', {
    ticket: { key: 'SHOP-1164', board: 'SHOP', summary: 's', type: 'Bug', status: 'To do', priority: 'Major', storyPoints: 3, sprint: 'SHOP Sprint 52', sprintsCarried: 9, epic: null, reporter: 'r', created: '2026-01-01', updated: '2026-01-01', labels: [], linked: [], description: '' },
  });
  session = new ElfoqsySession({
    conversationId: 'c1',
    log,
    usage,
    state: () => live.get(),
    systemPrompt: 'You are Elfoqsy.',
    mcpServer: (context) => orchestratorServer({ log, state: () => live.get(), lookups, session: context }),
    cwd: '/tmp',
    env: {},
    ticketKey: /SHOP-\d+/i,
    queryFn: sdk.queryFn,
    clock,
    now: () => clock.now,
  });
});

afterEach(() => {
  session.close();
  usage.close();
  live.close();
  log.close();
});

/** He asks; the fake SDK is her session. */
async function asks(textSaid: string) {
  log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'you', text: textSaid, conversationId: 'c1' });
  session.say(textSaid);
  await tick(20);
  return sdk.sessions[0]!;
}

describe('a tool that silently drops part of a request', () => {
  it('sends back a reply that invents a cause, with what the tool returned, and posts only the reply that says it does not know why', async () => {
    const her = await asks('Which of my SHOP tickets are open?');
    // Her tool call, run for real: the search leaves SHOP-2091 out and says nothing about why.
    expect(JSON.parse(await runTool(her.options as Options, 'lookup_jira', { jql: 'project = SHOP AND statusCategory != Done' }, 'orchestrator'))).toMatchObject({ dropped: [{ text: 'SHOP-2091' }] });
    her.emit(text('One is open, SHOP-1164. The search left out SHOP-2091 because it is closed.'), result());
    await tick(20);
    // Nothing is posted; the reply goes back to her with what the tool returned.
    expect(hers()).toEqual([]);
    expect(payloads('elfoqsy.reply_corrected')).toEqual([{ conversationId: 'c1', invented: ['The search left out SHOP-2091 because it is closed.'] }]);
    expect(her.sent.at(-1)).toBe(
      [
        '[From the workspace, not alex] Your reply gives a cause that no tool returned:',
        '> The search left out SHOP-2091 because it is closed.',
        '',
        'What the tools returned:',
        '- lookup_jira dropped SHOP-2091: no reason given',
        '',
        'Write your reply again. Say what the tools returned, in their words; where a tool gave no reason, say you do not know why. Nothing has been posted yet.',
      ].join('\n'),
    );
    her.emit(text('One is open, SHOP-1164. The search also left out SHOP-2091 and gave no reason; I do not know why.'), result());
    await tick(20);
    expect(hers()).toEqual(['One is open, SHOP-1164. The search also left out SHOP-2091 and gave no reason; I do not know why.']);
    expect(payloads('elfoqsy.reply_corrected')).toHaveLength(1); // once
  });
});

describe('a tool that drops part of a request and says why', () => {
  const handoff = async () => {
    const her = await asks('Start an agent on SHOP-1164. Keep export-step-timeout as it is.');
    const answer = JSON.parse(
      await runTool(
        her.options as Options,
        'write_handoff',
        { ticket: 'SHOP-1164', mode: 'normal', constraints: [{ text: 'Keep export-step-timeout as it is' }, { text: 'use a per-step timeout' }], facts: [] },
        'orchestrator',
      ),
    ) as { dropped: Array<{ text: string; reason: string }> };
    expect(answer.dropped).toEqual([{ text: 'use a per-step timeout', reason: 'not his words: a constraint is quoted from one of his messages in this conversation, as he wrote it' }]);
    return her;
  };

  it('posts a reply that gives the reason the tool gave', async () => {
    const her = await handoff();
    her.emit(text('The handoff left out "use a per-step timeout": the tool says it is not your words, since a constraint is quoted from one of your messages as you wrote it.'), result());
    await tick(20);
    expect(hers()).toHaveLength(1);
    expect(payloads('elfoqsy.reply_corrected')).toEqual([]);
  });

  it('sends back a reply that swaps the tool’s reason for one it made up', async () => {
    const her = await handoff();
    her.emit(text('The handoff dropped the per-step constraint because the tester is not alex.'), result());
    await tick(20);
    expect(hers()).toEqual([]);
    expect(her.sent.at(-1)).toContain('- write_handoff dropped use a per-step timeout: not his words: a constraint is quoted from one of his messages in this conversation, as he wrote it');
  });
});

describe('a reply that says she cannot look something up', () => {
  it('goes back to her once, unposted, when no tool said no: she has the web for the world and her reads and agents for the work', async () => {
    const her = await asks('năm nay có nghệ sĩ violin nào đáng nghe, cô thích ai nhất?');
    her.emit(text('Tôi không có công cụ nào đọc được web, nên không tra nghệ sĩ violin năm nay được. Cậu dán giúp tôi danh sách nhé.'), result());
    await tick(20);
    expect(hers()).toEqual([]);
    expect(payloads('elfoqsy.reply_corrected')).toEqual([{ conversationId: 'c1', invented: ['Tôi không có công cụ nào đọc được web, nên không tra nghệ sĩ violin năm nay được.'] }]);
    expect(her.sent.at(-1)).toBe(lookupCorrection(['Tôi không có công cụ nào đọc được web, nên không tra nghệ sĩ violin năm nay được.'], false));
    her.emit(text('Để tôi tra đã. Năm nay tôi thích Ray Chen.'), result());
    await tick(20);
    expect(hers()).toEqual(['Để tôi tra đã. Năm nay tôi thích Ray Chen.']);
    expect(payloads('elfoqsy.reply_corrected')).toHaveLength(1); // once
  });

  it('is told about the web only when she has it', () => {
    const said = ['I cannot look that up.'];
    expect(lookupCorrection(said, true)).toContain('WebSearch and WebFetch read the public web, for a fact about the world (a score, a line-up, a release, the news).');
    expect(lookupCorrection(said, false)).not.toContain('WebSearch');
    for (const text of [lookupCorrection(said, true), lookupCorrection(said, false)]) {
      expect(text).toContain('Never say you have no way to look something up while a tool or an agent could.');
      expect(text).toContain('If a lookup you just ran failed or was refused, say what it returned, in its words.');
      expect(text.endsWith('Nothing has been posted yet.')).toBe(true);
    }
  });

  it('finds it in English and in Vietnamese, as she said it in her first real conversation', () => {
    for (const reply of [
      'Tôi không có công cụ nào đọc được web, chỉ đọc được Jira, GitHub, Confluence, code và các môi trường của mình, nên không tra nghệ sĩ violin năm nay được.',
      'Tôi không thể truy cập web để xem đội hình.',
      'Tôi không có cách nào tra kết quả trận đó.',
      'Tôi không có quyền truy cập internet.',
      'Xin lỗi, tôi không tra được.',
      "I can't look that up, I have no web tool.",
      'I cannot search the web from here.',
      "I don't have a way to check that online.",
      'I have no access to browse.',
      "I'm unable to look it up.",
    ]) expect(cannotLookUp(reply, []), reply).toHaveLength(1);
  });

  it('leaves alone what is not that: a refusal a tool gave, a job that is an agent’s, a lookup she did, her tastes', () => {
    for (const reply of [
      'Tôi đã tra rồi: năm nay tôi thích Ray Chen.',
      'Tôi không có công cụ để sửa code, agent làm việc đó.',
      'Tôi không thể xem prod, agent sẽ xin cậu.',
      'Tôi không chắc, để tôi xem đã.',
      'Thua thì tôi cay đến sáng hôm sau.',
      'Có chứ. Đội đá dở là tôi cũng cay như cậu thôi.',
      'I looked it up: Ray Chen.',
      "I can't write that comment in Vietnamese: Jira is English.",
      'The agent can search the code for that.',
      '',
    ]) expect(cannotLookUp(reply, []), reply).toEqual([]);
  });

  it('is not said of a tool that did say no: a lookup that failed or was refused is the honest reason', () => {
    const refused = [{ tool: 'lookup_jira', what: 'the request', how: 'rejected' as const, reason: 'Jira answered 503' }];
    expect(cannotLookUp('Tôi không tra được lúc này, Jira báo 503.', refused)).toEqual([]);
    expect(cannotLookUp("I can't look that up right now.", refused)).toEqual([]);
  });
});

describe('her prompt', () => {
  it('tells her to report what a tool returned and to say she does not know why when it gave no reason', () => {
    const prompt = readFileSync(resolve(REPO_ROOT, 'prompts/elfoqsy-system-prompt.md'), 'utf8');
    expect(prompt).toContain("When a tool drops, rejects or changes part of what you asked, say what it returned, in its words. If it gave no reason, say you don't know why; never supply one yourself.");
  });
});

describe('the check on its own', () => {
  it('reads what a tool dropped, rejected or changed, with its reason or none', () => {
    expect(outcomesOf('write_handoff', { ok: true, dropped: [{ text: 'a', reason: 'no source' }, { text: 'b' }], changed: ['c'] })).toEqual([
      { tool: 'write_handoff', what: 'a', how: 'dropped', reason: 'no source' },
      { tool: 'write_handoff', what: 'b', how: 'dropped' },
      { tool: 'write_handoff', what: 'c', how: 'changed' },
    ]);
    expect(outcomesOf('spawn_agent', { error: 'repo_needed', message: 'Which repositories does it need?' })).toEqual([{ tool: 'spawn_agent', what: 'the request', how: 'rejected', reason: 'Which repositories does it need?' }]);
    expect(outcomesOf('list_sprint', { tickets: [] })).toEqual([]);
  });

  it('finds a cause no tool returned in a Vietnamese reply as well: she answers in the language he writes in', () => {
    const silent = [{ tool: 'write_handoff', what: 'SHOP-2091', how: 'dropped' as const }];
    const given = [{ tool: 'write_handoff', what: 'SHOP-2091', how: 'dropped' as const, reason: 'no source' }];
    // A cause the tool never gave.
    expect(inventedCauses('Tool đã bỏ SHOP-2091 vì nó chưa có nguồn.', silent)).toEqual(['Tool đã bỏ SHOP-2091 vì nó chưa có nguồn.']);
    expect(inventedCauses('Nó bị từ chối do ticket đã đóng.', silent)).toEqual(['Nó bị từ chối do ticket đã đóng.']);
    expect(inventedCauses('Họ loại SHOP-2091 bởi vì trùng lặp.', silent)).toHaveLength(1);
    expect(inventedCauses('Phần đó đã thay đổi cho nên mình bỏ qua.', silent)).toHaveLength(1);
    // The tool's own reason, quoted: grounded.
    expect(inventedCauses('Tool đã bỏ SHOP-2091 vì "no source".', given)).toEqual([]);
    // The right answer: she does not know why, or the tool gave none.
    expect(inventedCauses('Tool đã bỏ SHOP-2091 nhưng không rõ vì sao.', silent)).toEqual([]);
    expect(inventedCauses('Tool đã bỏ SHOP-2091; nó không đưa lý do.', silent)).toEqual([]);
    expect(inventedCauses('Nó bị từ chối, tôi chưa biết lý do.', silent)).toEqual([]);
    // About nothing a tool did, or no cause.
    expect(inventedCauses('SHOP-1164 chậm vì cache miss.', silent)).toEqual([]);
    expect(inventedCauses('Tool đã bỏ SHOP-2091.', silent)).toEqual([]);
    expect(inventedCauses('Tool đã bỏ SHOP-2091 vì nó chưa có nguồn.', [])).toEqual([]);
  });

  it('leaves alone a reply with no cause, or about nothing a tool did', () => {
    const silent = [{ tool: 'lookup_jira', what: 'SHOP-2091', how: 'dropped' as const }];
    expect(inventedCauses('The search left out SHOP-2091; it gave no reason.', silent)).toEqual([]);
    expect(inventedCauses('SHOP-1164 is slow because the cache misses.', silent)).toEqual([]); // nothing dropped in that sentence
    expect(inventedCauses('It was rejected since the tester is not him.', [])).toEqual([]); // no tool dropped anything
    expect(correction(['x'], silent)).toContain('- lookup_jira dropped SHOP-2091: no reason given');
  });
});
