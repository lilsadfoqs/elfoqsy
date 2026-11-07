// Her lines in the language of his latest message (alex): the digest and the one-line notices are in English, or in
// Vietnamese with "tôi" for her and "cậu" for him, as her identity says. The language is the latest of his messages that says one;
// the tester's do not count. Every backend is a fake; nothing leaves the test.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf, QuestionCard } from '@elfoqsy/contracts';
import { Approvals, BATCH_MS } from '../src/agents/approvals';
import { UsageState } from '../src/claude/usage';
import { categoryWords, CATEGORY_WORDS, CATEGORY_WORDS_VI } from '../src/decisions/categories';
import { AWAY_MS, Digests } from '../src/decisions/digest';
import { FirstResponder } from '../src/decisions/firstResponder';
import type { Responder } from '../src/decisions/responder';
import { inLanguage, langField, language, languageOf, tr, Voice } from '../src/elfoqsy/voice';
import { LiveState } from '../src/elfoqsy/liveState';
import { correctionText } from '../src/elfoqsy/review';
import { EventLog } from '../src/eventLog';
import { createProxies } from '../src/permissions';
import { Grants } from '../src/permissions/grants';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import { skillChangeText } from '../src/skill/teamSkill';
import { ManualClock } from './helpers/fakeSdk';
import { deploymentJson, environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const INTEGRATION = '--context integration';
const T0 = Date.parse('2026-10-12T17:00:00Z');

afterEach(() => {
  language.current = 'en';
});

const CARD: QuestionCard = {
  question: 'Keep the old retry count?',
  why: ['The ticket names v2 only'],
  options: [
    { label: 'Yes', consequence: 'The old count stays' },
    { label: 'No', consequence: 'The count is dropped' },
  ],
  recommendation: 'Yes',
  sources: [{ kind: 'ticket', ref: 'SHOP-2091' }],
};

describe('the language of a message', () => {
  const cases: Array<[string, 'vi' | 'en' | undefined]> = [
    ['Cậu ơi, ticket này sao rồi?', 'vi'],
    ['đang chạy', 'vi'],
    ['Làm giúp tôi cái này', 'vi'], // only accents French has, but Vietnamese words
    ['toi muon xem ticket nay', 'vi'], // no accents, but three of the words only Vietnamese has
    ['What is blocked right now?', 'en'],
    ["I'd like Agent 2 to stop", 'en'],
    ['stop it', 'en'],
    // Says nothing: what is there before it stays.
    ['ok', undefined],
    ['Yes', undefined],
    ['42', undefined],
    ['👍', undefined],
    ['SHOP-3546', undefined],
    ['https://github.com/acme/shop-api/pull/812', undefined],
    ['/status SHOP --verbose', undefined],
    ['`kubectl get pods` -n shop', undefined],
    ['', undefined],
  ];
  for (const [text, lang] of cases) {
    it(`reads ${JSON.stringify(text)} as ${lang ?? 'nothing'}`, () => expect(languageOf(text)).toBe(lang));
  }

  it('reads a Vietnamese message with an English ticket key and command as Vietnamese', () => {
    expect(languageOf('Xem giúp tôi SHOP-3546 rồi chạy `pnpm test` nhé')).toBe('vi');
  });

  it('reads the decomposed spelling too', () => {
    expect(languageOf('Cậu ơ i')).toBe('vi'); // "Cậu ơ i" typed with combining marks
  });
});

describe('tr and inLanguage', () => {
  it('picks the English wording until he writes Vietnamese', () => {
    expect(tr('Done.', 'Xong.')).toBe('Done.');
    language.current = 'vi';
    expect(tr('Done.', 'Xong.')).toBe('Xong.');
    expect(langField()).toEqual({ lang: 'vi' });
    language.current = 'en';
    expect(langField()).toEqual({});
  });

  it('writes one line in another language and puts the language back, even when the work throws', () => {
    expect(inLanguage('vi', () => tr('a', 'b'))).toBe('b');
    expect(language.current).toBe('en');
    expect(() =>
      inLanguage('vi', () => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(language.current).toBe('en');
  });
});

describe('Voice follows his messages in the log', () => {
  let log: EventLog;
  beforeEach(() => {
    log = new EventLog(':memory:');
  });
  afterEach(() => log.close());

  const say = (role: 'you' | 'test' | 'elfoqsy', text: string) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role, text, conversationId: 'c1' });

  it('is English until he writes, then the language of his latest message that says one', () => {
    const voice = new Voice(log);
    expect(language.current).toBe('en');
    say('you', 'Cậu xem giúp tôi ticket này nhé');
    expect(language.current).toBe('vi');
    say('you', 'ok'); // says nothing
    expect(language.current).toBe('vi');
    say('you', 'SHOP-3546');
    expect(language.current).toBe('vi');
    say('you', 'Please look at shop-api first');
    expect(language.current).toBe('en');
    voice.close();
    say('you', 'Cậu ơi');
    expect(language.current).toBe('en'); // closed: no longer listening
  });

  it('does not count the tester’s messages, nor her own', () => {
    const voice = new Voice(log);
    say('you', 'Cậu xem giúp tôi ticket này nhé');
    say('test', 'Please look at shop-api first');
    say('elfoqsy', 'Tôi sẽ xem ngay');
    expect(language.current).toBe('vi');
    say('elfoqsy', 'I am on it, and this is English');
    expect(language.current).toBe('vi');
    voice.close();
  });

  it('starts from what he last wrote before the daemon started', () => {
    say('you', 'Please look at shop-api first');
    say('you', 'Cậu xem giúp tôi ticket này nhé');
    say('test', 'And this is the tester in English');
    const voice = new Voice(log);
    expect(language.current).toBe('vi');
    voice.close();
  });
});

describe('her lines in Vietnamese', () => {
  let clock: ManualClock;
  let log: EventLog;
  let live: LiveState;
  let usage: UsageState;
  let approvals: Approvals;
  let grants: Grants;
  let backends: FakeBackends;
  let proxies: Proxies;
  let first: FirstResponder;
  let answerFor: { current: ReturnType<Responder['consider']> | undefined };

  const run: ProxyRun = {
    runId: 'run-2',
    ticket: 'SHOP-2091',
    agentNumber: 2,
    branch: 'feature/SHOP-2091',
    targets: [{ repo: SHOP_API, base: 'master' }],
    kubeconfig: '/data/runs/run-2/kubeconfig',
  };

  const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
  const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
  const said = () => payloads('elfoqsy.message').filter((m) => m.role === 'elfoqsy').map((m) => m.text);
  const his = (text: string, role: 'you' | 'test' = 'you') => log.append('orchestrator', 'elfoqsy.message', { messageId: `y-${log.headSeq()}`, role, text, conversationId: 'c1' });
  const restart = () => kubeRequest(`${INTEGRATION} -n shop-integration set image deployment/shop-integration-test shop-integration-test=it:2.22.0`);
  const kubeRequest = (args: string) => proxies.request(run, 'kube', { args: args.split(' ') });

  beforeEach(() => {
    clock = new ManualClock(T0);
    log = new EventLog(':memory:', () => new Date(clock.now));
    log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'SHOP-2091', ticket: 'SHOP-2091' });
    log.append('orchestrator', 'run.created', { runId: run.runId, ticket: run.ticket, worktree: '/runs/x', branch: run.branch, agentNumber: 2, conversationId: 'c1' });
    live = new LiveState(log);
    usage = new UsageState(log, clock, () => clock.now);
    backends = fakeBackends();
    backends.kubeAnswers.set('get deployment/shop-integration-test -o json', deploymentJson('shop-integration-test', 'it:2.21.3', { replicas: 1, namespace: 'shop-integration' }));
    approvals = new Approvals(log, undefined, clock);
    grants = new Grants(log, { clock, now: () => clock.now });
    answerFor = { current: undefined };
    const responder = { consider: () => answerFor.current ?? Promise.resolve({ kind: 'none', reason: 'nothing' }) } as unknown as Responder;
    first = new FirstResponder({
      log,
      state: () => live.get(),
      approvals,
      responder,
      say: (runId, t, blocks) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text: t, conversationId: 'c1', refs: { runId }, ...(blocks ? { blocks } : {}) }),
    });
    proxies = createProxies({
      log,
      approvals,
      grants,
      environments,
      backends,
      repos: [SHOP_API],
      say: (r, t) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text: t, refs: { runId: r.runId } }),
      endedRun: async () => ({ run, dispose: () => undefined }),
      firstResponder: () => first,
      now: () => clock.now,
    });
    proxies.register(run);
  });
  afterEach(() => {
    first.close();
    proxies.close();
    grants.close();
    approvals.close();
    live.close();
    log.close();
  });

  describe('what she decided and told him', () => {
    it('is English while his latest message is, and says what he delegated', async () => {
      await restart();
      expect(said().at(-1)).toMatch(/^I let Agent 2 on SHOP-2091 kubectl .*set image deployment\/shop-integration-test.*: you delegated a test-harness change to me\.$/);
      expect(payloads('decision.made')[0]).not.toHaveProperty('lang');
    });

    it('says it with tôi and cậu when his latest message is in Vietnamese, and marks the decision for the web', async () => {
      language.current = 'vi';
      await restart();
      expect(said().at(-1)).toMatch(/^Tôi đã cho Agent 2 trên SHOP-2091 làm: “kubectl .*set image deployment\/shop-integration-test.*”: cậu đã giao việc thay đổi test harness cho tôi\.$/s);
      const [made] = payloads('decision.made');
      expect(made).toMatchObject({ category: 'harness_kube', told: true, lang: 'vi' });
      expect(made!.summary).toMatch(/^Cho Agent 2 trên SHOP-2091 làm: “kubectl /);
      expect(said().at(-1)).not.toMatch(/\b(you|your|delegated)\b/i);
    });

    it('words a category in the language of his latest message', () => {
      expect(categoryWords('staging_write')).toBe('a staging write');
      language.current = 'vi';
      expect(categoryWords('staging_write')).toBe('việc ghi vào staging');
    });

    it('has Vietnamese words for every category, as it has English ones', () => {
      expect(Object.keys(CATEGORY_WORDS_VI).sort()).toEqual(Object.keys(CATEGORY_WORDS).sort());
      for (const [category, words] of Object.entries(CATEGORY_WORDS_VI)) expect(words, category).toMatch(/\S/);
    });
  });

  describe('an answer she gave an agent', () => {
    const card = CARD;
    const answer = () => {
      answerFor.current = Promise.resolve({ kind: 'answer', option: 'Yes', note: 'the ticket says so', sources: [{ kind: 'ticket', ref: 'SHOP-2091', label: 'SHOP-2091 AC' }] }) as never;
    };

    it('is told in her words, in his language, when he asked to be told', async () => {
      log.append('orchestrator', 'delegation.set', { category: 'sourced_answer', setting: 'decide_and_tell', by: 'you' });
      answer();
      await first.question(run.runId, card);
      expect(said().at(-1)).toBe('I answered Agent 2 on SHOP-2091: Yes: the ticket says so. From SHOP-2091 AC (SHOP-2091).');

      language.current = 'vi';
      answer();
      await first.question(run.runId, card);
      expect(said().at(-1)).toBe('Tôi đã trả lời Agent 2 trên SHOP-2091: Yes: the ticket says so. Dựa vào SHOP-2091 AC (SHOP-2091).');
      expect(payloads('decision.made').at(-1)).toMatchObject({ lang: 'vi', summary: expect.stringMatching(/^Đã trả lời "Keep the old retry count\?": Yes/) });
    });
  });

  describe('the card that goes to him', () => {
    it('keeps its own text in English in Vietnamese too: it is the interface and the record, not her line', async () => {
      const card = CARD;
      language.current = 'vi';
      const asked = first.question(run.runId, card);
      for (let i = 0; i < 100 && !payloads('approval.requested').length; i++) await new Promise((r) => setTimeout(r, 5));
      const [card1] = payloads('approval.requested');
      expect(card1!.question).toBe('Agent 2 on SHOP-2091 asks: Keep the old retry count?');
      log.append('orchestrator', 'approval.resolved', { approvalId: card1!.approvalId, decision: 'answered', answer: 'Yes' });
      expect((await asked).resolution.answer).toBe('Yes');
    });
  });

  describe('the digest', () => {
    let digests: Digests;
    beforeEach(() => {
      digests = new Digests({ log, state: () => live.get(), today: () => 'c-today' });
    });
    afterEach(() => digests.close());

    it('is in Vietnamese when the message that brings him back is, whichever listener of the log saw it first', async () => {
      his('Để đó đến sáng nhé.');
      clock.advance(40 * 60_000);
      await restart();
      clock.advance(8 * 3600_000);
      // No Voice here: the digest reads the language of the message that woke it.
      expect(language.current).toBe('en');
      his('Chào buổi sáng, cậu có gì cho tôi không?');
      expect(payloads('decisions.digested')).toEqual([expect.objectContaining({ conversationId: 'c1', lang: 'vi' })]);
      expect(said().at(-1)).toBe('Không run nào chạy tiếp trong lúc cậu vắng mặt; không có gì đang chờ cậu.');
      expect(language.current).toBe('en'); // put back: the language is the Voice's to move
    });

    it('is English when the message that brings him back is English', async () => {
      his('Leave them overnight.');
      clock.advance(40 * 60_000);
      await restart();
      clock.advance(8 * 3600_000);
      language.current = 'vi'; // what he wrote before
      his('Morning, anything for me?');
      expect(payloads('decisions.digested')[0]).not.toHaveProperty('lang');
      expect(said().at(-1)).toBe('Nothing moved on while you were away; nothing is waiting for you.');
    });

    it('keeps the language of his latest message when it says nothing ("ok")', async () => {
      language.current = 'vi';
      his('Để đó đến sáng nhé.');
      clock.advance(40 * 60_000);
      await restart();
      clock.advance(8 * 3600_000);
      his('ok');
      expect(payloads('decisions.digested')[0]).toMatchObject({ lang: 'vi' });
    });

    it('opened by him: nothing yet, nothing since, and a listing, in Vietnamese', async () => {
      language.current = 'vi';
      digests.open('c1', 'you');
      expect(said().at(-1)).toBe('Tôi chưa quyết gì thay cậu cả.');
      await restart();
      clock.advance(60_000);
      digests.open('c1', 'you');
      expect(payloads('decisions.digested').at(-1)).toMatchObject({ asked: true, lang: 'vi' });
      expect(said().at(-1)).toBe('Không run nào chạy tiếp từ lúc đó; không có gì đang chờ cậu.');
      clock.advance(60_000);
      digests.open('c1', 'you');
      const at = new Date(Date.parse(events('decisions.digested').at(-1)!.ts)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      expect(said().at(-1)).toBe(`Từ digest lần trước của cậu, lúc ${at}, tôi chưa quyết gì.`);
    });

    it('counts runs and questions in Vietnamese, with no plural', async () => {
      language.current = 'vi';
      await restart();
      log.append('orchestrator', 'run.step_begun', { runId: run.runId, stepIndex: 0, name: 'reproduce', why: 'x' });
      void kubeRequest('--context staging-shop rollout restart deployment/shop-integration-test');
      for (let i = 0; i < 20 && !payloads('approval.requested').length; i++) await new Promise((r) => setTimeout(r, 5));
      clock.advance(60_000);
      digests.open('c1', 'you');
      expect(said().at(-1)).toBe('1 run đã chạy tiếp từ lúc đó; 1 câu hỏi đang chờ cậu.');
    });

    it('lists the same decisions in English after he writes in English again', async () => {
      language.current = 'vi';
      await restart();
      language.current = 'en';
      clock.advance(60_000);
      digests.open('c1', 'you');
      expect(payloads('decisions.digested').at(-1)).not.toHaveProperty('lang');
      expect(said().at(-1)).toBe('Nothing moved on since then; nothing is waiting for you.');
    });
  });

  describe('a request that waits for him', () => {
    it('says who needs his approval, in his language', async () => {
      language.current = 'vi';
      void kubeRequest('--context staging-shop rollout restart deployment/shop-integration-test');
      await new Promise((r) => setTimeout(r, 20));
      clock.advance(BATCH_MS);
      expect(said().at(-1)).toBe('Agent 2 cần cậu duyệt.');
    });

    it('says it for several actions asked within a few seconds', async () => {
      language.current = 'vi';
      void proxies.request(run, 'gh', { args: ['pr', 'ready', '812', '--repo', SHOP_API] });
      void proxies.request(run, 'gh', { args: ['pr', 'comment', '812', '--body', 'Ready.', '--repo', SHOP_API] });
      void kubeRequest('--context staging-shop rollout restart deployment/shop-integration-test');
      await new Promise((r) => setTimeout(r, 20));
      clock.advance(BATCH_MS);
      expect(said().at(-1)).toBe('Agent 2 cần cậu duyệt 3 việc.');
    });

    it('says it in English when he writes English', async () => {
      void kubeRequest('--context staging-shop rollout restart deployment/shop-integration-test');
      await new Promise((r) => setTimeout(r, 20));
      clock.advance(BATCH_MS);
      expect(said().at(-1)).toBe('Agent 2 needs your approval.');
    });
  });

  describe('a usage limit or a login that stopped working', () => {
    it('says so in his language', () => {
      language.current = 'vi';
      usage.limit('login', 'login');
      expect(said().at(-1)).toBe('Đăng nhập Claude của tôi không còn hoạt động. Cậu chạy `claude auth login`, rồi nhắn cho tôi.');
    });

    it('says when she goes on, or that she waits for him, in Vietnamese', () => {
      language.current = 'vi';
      usage.limit('limit', 'five_hour');
      expect(said().at(-1)).toBe('Tôi đã chạm giới hạn dùng Claude. Tôi sẽ tạm dừng cho tới khi cậu nhắn cho tôi.');
    });
  });
});

describe('other one-line notices', () => {
  it('words the skill change in Vietnamese', () => {
    const change = { skill: 'team-dev', previous: 'abc', hash: 'def', sections: ['Setup', 'Verdicts'] } as PayloadOf<'skill.changed'>;
    expect(skillChangeText(change)).toBe('Your team-dev skill changed (abc → def): Setup; Verdicts. The adapter (docs/skill-adapter.md) was written for the earlier version and needs a review; runs follow the new version meanwhile.');
    language.current = 'vi';
    expect(skillChangeText(change)).toBe('Skill team-dev của cậu đã thay đổi (abc → def): Setup; Verdicts. Adapter (docs/skill-adapter.md) được viết cho phiên bản trước và cần được xem lại; trong lúc đó các run theo phiên bản mới.');
  });

  it('words the correction of a review in Vietnamese', () => {
    const review = { weekOf: '2026-10-05', revision: 0, metrics: { runs: 4, failed: 1 }, suggestions: [], withdrawn: [] } as never;
    expect(correctionText(review, { runs: 5, failed: 1 }, ['runs'], [])).toBe('A correction to this review: the right figures are 5 runs (not 4). The suggestions still stand; the corrected review is below.');
    language.current = 'vi';
    expect(correctionText(review, { runs: 5, failed: 1 }, ['runs'], [])).toBe('Một điều chỉnh cho bản review này: các con số đúng là 5 run (không phải 4). Các gợi ý vẫn đúng; bản review đã sửa nằm bên dưới.');
    expect(correctionText(review, { runs: 5, failed: 2 }, ['runs', 'failed'], [0, 2])).toBe(
      'Một điều chỉnh cho bản review này: các con số đúng là 5 run (không phải 4) và 2 thất bại (không phải 1). Tôi đã rút gợi ý đầu tiên và thứ ba của mình, vì nó dựa trên các số cũ; bản review đã sửa nằm bên dưới.',
    );
  });
});

describe('every outcome of the proxies has its Vietnamese', () => {
  it('gives each `done:` a `doneVi:` beside it, so no tier-1 line is left in English by a new proxy', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'permissions');
    const lacking: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bok: true\b.*\bdone:/.test(line) && !/\bdoneVi:/.test(line)) lacking.push(`${file}:${i + 1}`);
        });
    }
    expect(lacking).toEqual([]);
  });
});
