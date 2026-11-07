import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Approvals } from '../src/agents/approvals';
import { AttachmentStore } from '../src/attachments';
import { UsageState } from '../src/claude/usage';
import { Elfoqsy } from '../src/elfoqsy/brain';
import { language } from '../src/elfoqsy/voice';
import { LiveState } from '../src/elfoqsy/liveState';
import { Conversations } from '../src/elfoqsy/routing';
import { TesterImages } from '../src/elfoqsy/testerImages';
import { EventLog } from '../src/eventLog';
import { ManualClock, fakeSdk, result, text, tick } from './helpers/fakeSdk';

const T0 = new Date(2026, 9, 9, 14, 0).getTime();
const AGREED = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
let dir: string;
let log: EventLog;
let live: LiveState;
let clock: ManualClock;
let usage: UsageState;
let sdk: ReturnType<typeof fakeSdk>;
let store: AttachmentStore;
let brain: Elfoqsy;
let conversations: Conversations;

const ofType = (type: string) => log.readFrom(0, 10_000, [type]).map((e) => e.payload as Record<string, unknown>);
const conversationOf = (i: number) => (sdk.sessions[i]!.sent[0]!.match(/This conversation: "([^"]*)"/) ?? [])[1];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elfoqsy-brain-'));
  clock = new ManualClock(T0);
  log = new EventLog(':memory:', () => new Date(clock.now));
  live = new LiveState(log);
  usage = new UsageState(log, clock, () => clock.now);
  sdk = fakeSdk();
  store = new AttachmentStore(join(dir, 'attachments'));
  conversations = new Conversations(log, () => live.get(), () => clock.now);
  brain = new Elfoqsy({
    log,
    usage,
    state: () => live.get(),
    systemPrompt: 'You are Elfoqsy.',
    tools: () => ({ type: 'sdk', name: 'orchestrator', instance: {} }) as never,
    conversations,
    attachments: store,
    cwd: dir,
    env: {},
    model: 'claude-opus-5-5',
    effort: 'medium',
    ticketKey: /\b(?:SHOP|CORE)-\d+\b/i,
    queryFn: sdk.queryFn,
    clock,
    now: () => clock.now,
    pdfText: async () => 'Page one. apikey: 0123456789abcdef0123456789abcdef01',
    events: live,
    testerImages: new TesterImages([join(dir, 'screenshots'), join(dir, 'fixtures')]),
  });
  // One of the repository's own pictures, as assets/ would hold.
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  writeFileSync(join(dir, 'screenshots', '01-left.png'), AGREED);
  log.append('orchestrator', 'conversation.created', { conversationId: 'c1', title: 'Plan the SHOP-1164 stall fix', ticket: 'SHOP-1164' });
  log.append('orchestrator', 'conversation.created', { conversationId: 'c2', title: 'Sprint 52 check-in' });
});

afterEach(() => {
  language.current = 'en';
  brain.close();
  usage.close();
  live.close();
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Elfoqsy, one session per conversation', () => {
  it('answers each conversation in its own session', async () => {
    await brain.say({ text: 'hello', from: 'owner', conversationId: 'c1' });
    await brain.say({ text: 'and here', from: 'owner', conversationId: 'c2' });
    await brain.say({ text: 'back to c1', from: 'owner', conversationId: 'c1' });
    await tick();
    expect(sdk.queryFn).toHaveBeenCalledTimes(2);
    expect([conversationOf(0), conversationOf(1)]).toEqual(['Plan the SHOP-1164 stall fix', 'Sprint 52 check-in']);
    expect(sdk.sessions[0]!.sent.at(-1)).toBe('back to c1');
    sdk.sessions[1]!.emit(text('All quiet.'), result());
    await tick();
    expect(ofType('elfoqsy.message').at(-1)).toMatchObject({ role: 'elfoqsy', conversationId: 'c2', text: 'All quiet.' });
  });

  it('sends workspace updates to the conversation of their ticket or run, else to the day’s Today conversation', async () => {
    log.append('orchestrator', 'run.created', { runId: 'r5', ticket: 'SHOP-2091', worktree: '', branch: '', agentNumber: 5, conversationId: 'c2' });
    brain.notify([
      { id: '1', text: 'SHOP-1164 is now Blocked. It is Major.', ticket: 'SHOP-1164' },
      { id: '2', text: 'Agent 5 on SHOP-2091 finished.', ticket: 'SHOP-2091', runId: 'r5' },
      { id: '3', text: 'CI failed on o/r #7 (SHOP-3546).', ticket: 'SHOP-3546' },
      { id: '4', text: 'SHOP-3049 is now Blocked. It is Critical.', ticket: 'SHOP-3049' },
    ]);
    await tick();
    expect(sdk.sessions.map((_, i) => conversationOf(i))).toEqual(['Plan the SHOP-1164 stall fix', 'Sprint 52 check-in', 'Today, 9 October']);
    expect(sdk.sessions[2]!.sent[0]).toContain('[Workspace update]\n- CI failed on o/r #7 (SHOP-3546).\n- SHOP-3049 is now Blocked. It is Critical.');
    expect(ofType('conversation.created').at(-1)).toEqual({ conversationId: 'today-2026-10-09', title: 'Today, 9 October' });
    // One Today conversation per day.
    brain.notify([{ id: '5', text: 'SHOP-9 is now Blocked.', ticket: 'SHOP-9' }]);
    expect(ofType('conversation.created').filter((c) => c.conversationId === 'today-2026-10-09')).toHaveLength(1);
  });

  it('asks a run’s question in its ticket’s conversation when the run has none', () => {
    const approvals = new Approvals(log, (runId, ticket) => conversations.for(ticket, runId));
    log.append('orchestrator', 'run.created', { runId: 'r6', ticket: 'SHOP-1164', worktree: '', branch: '', agentNumber: 6 });
    void approvals.request({ runId: 'r6', ticket: 'SHOP-1164', kind: 'push', question: 'Agent 6 wants to push feature/SHOP-1164.' });
    expect(ofType('elfoqsy.message').at(-1)).toMatchObject({ conversationId: 'c1', blocks: [{ type: 'approval' }] });
    approvals.close();
  });

  it('keeps at most three sessions open, closing the least recently used idle one, and closes idle ones after 20 minutes', async () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) log.append('orchestrator', 'conversation.created', { conversationId: id, title: id });
    await brain.say({ text: 'one', from: 'owner', conversationId: 'c1' });
    for (const s of ['c2', 'c3']) {
      clock.advance(1000);
      await brain.say({ text: 'x', from: 'owner', conversationId: s });
    }
    await tick();
    sdk.sessions[0]!.emit(result());
    sdk.sessions[2]!.emit(result());
    await tick();
    clock.advance(1000);
    await brain.say({ text: 'four', from: 'owner', conversationId: 'c4' });
    await tick();
    // c1 had finished its turn longest ago: it closed; c2 is still busy and stays.
    expect(sdk.sessions[0]!.ended).toBe(true);
    expect(sdk.sessions[1]!.ended).toBe(false);
    sdk.sessions[1]!.emit(result());
    sdk.sessions[3]!.emit(result());
    await tick();
    clock.advance(21 * 60_000);
    await tick();
    expect(sdk.sessions.slice(1).every((s) => s.ended)).toBe(true);
  });

  it('brings an investigator’s findings back to the conversation that asked', async () => {
    brain.investigationFinished({
      investigationId: 'inv-1',
      conversationId: 'c1',
      question: 'Why does the export never finish?',
      title: "What's actually happening",
      findings: [{ text: 'Cached export steps never start the Redis timeout.', sources: [{ kind: 'code', ref: 'shop-worker/src/export/cache.ts:58' }] }],
    });
    await tick();
    expect(sdk.sessions[0]!.sent[0]).toContain(
      `[Investigation finished] inv-1, on "Why does the export never finish?": What's actually happening\n1. Cached export steps never start the Redis timeout. (shop-worker/src/export/cache.ts:58)\nShow it with a findings block (ref inv-1)`,
    );
    brain.investigationFinished({ investigationId: 'inv-2', conversationId: 'c1', question: 'q', title: 'No answer', findings: [], stopped: 'It ran out of time (10 minutes).' });
    await tick();
    expect(sdk.sessions[0]!.sent.at(-1)).toBe('[Investigation stopped] inv-2, on "q": It ran out of time (10 minutes). Tell them in one line, and what you would do next.');
  });

  it('hands her what the abilities engine learned, to say in her own words and in his language, never as a line made here', async () => {
    const learned = {
      name: 'aws-session-left',
      title: 'How long the AWS sessions have left',
      titleVi: 'xem phiên AWS còn bao lâu',
      tool: 'aws' as const,
      whenToUse: 'He asks how long an AWS session has left.',
      finder: { by: 'agent' as const, agentNumber: 7, runId: 'run-7', ticket: 'SHOP-3488' },
      source: 'SHOP-3488, Agent 7',
    };
    language.current = 'vi';
    brain.announceAbilities({ conversationId: 'c1', updated: false, abilities: [learned] });
    await tick();
    const turn = sdk.sessions[0]!.sent.at(-1)!;
    expect(turn).toContain('[Abilities learned] You just learned an ability:');
    expect(turn).toContain('- aws-session-left: "How long the AWS sessions have left" (Vietnamese: "xem phiên AWS còn bao lâu"); about aws; when to use it: He asks how long an AWS session has left.; Agent 7 found it on SHOP-3488.');
    // The words are hers: she is told what to write and in which language, with no sentence to fill in, and to show the cards.
    expect(turn).toContain('He is writing to you in Vietnamese now: write in Vietnamese, tôi for yourself and cậu for him');
    expect(turn).toContain('never an ability\'s title put after "I learned how to"');
    expect(turn).toContain('show each ability as a card with show (a block of type ability, its name as ref)');
    expect(turn).not.toMatch(/Tôi vừa học được|I just learned how to/);
    language.current = 'en';
    brain.announceAbilities({ conversationId: 'c1', updated: true, abilities: [learned, { ...learned, name: 'two', title: 'Another' }] });
    await tick();
    const next = sdk.sessions[0]!.sent.at(-1)!;
    expect(next).toContain('[Abilities updated] A new version of what you already had:');
    expect(next).toContain('He is writing to you in English now: write in English');
  });

  it('hands her the abilities to shorten: each whole as stored, why, to be sent again quiet, with the reads as they are, and one line from her at the end', async () => {
    const ability = {
      name: 'short-kube-output',
      version: 1,
      title: 'Read kube lists short',
      titleVi: 'đọc danh sách kube ngắn',
      tool: 'kubernetes' as const,
      whenToUse: 'He asks for pods or deployments.',
      steps: [{ text: 'Pods: name, ready and restarts', code: 'get pods -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready', read: { proxy: 'kube' as const, input: { args: ['get', 'pods'] } } }],
      doneWhen: 'The list is short.',
      finder: { by: 'elfoqsy' as const },
      source: 'Today, Elfoqsy',
      createdAt: '2026-10-21T03:30:00.000Z',
      baseline: { steps: 4, failed: 0, questions: 0, cases: 1, from: 'her own work: x' },
      track: { tools: ['kube'] },
    };
    language.current = 'vi';
    expect(brain.reviseAbilities({ conversationId: 'c1', abilities: [{ ability, long: ['step 1: 30 + 90 characters'] }] })).toBe(true);
    await tick();
    const turn = sdk.sessions[0]!.sent.at(-1)!;
    expect(turn).toContain('[Abilities to shorten] A card shows each step of an ability on one line');
    expect(turn).toContain('about 450 px: about 6.5 px for each character of the text and 7.8 for each of the sample');
    expect(turn).toContain('This ability has a sample too long:');
    expect(turn).toContain('- short-kube-output ("Read kube lists short"): step 1: 30 + 90 characters (text + sample).');
    // Whole, as stored (an update is sent whole): the read of the step is in it, the credit and the baseline (the engine keeps) are not.
    expect(turn).toContain('"read":{"proxy":"kube","input":{"args":["get","pods"]}}');
    expect(turn).not.toContain('"baseline"');
    expect(turn).toContain('send it again with write_ability, update: true and quiet: true');
    expect(turn).toContain('the full commands with their flags and what explains them in references');
    expect(turn).toContain('every read step exactly as it is');
    expect(turn).toContain('Vietnamese now: write in Vietnamese, tôi for yourself and cậu for him');
    language.current = 'en';
    brain.reviseAbilities({ conversationId: 'c1', abilities: [{ ability, long: ['step 1: 30 + 90 characters'] }, { ability: { ...ability, name: 'two' }, long: ['step 1: 31 + 91 characters'] }] });
    await tick();
    const next = sdk.sessions[0]!.sent.at(-1)!;
    expect(next).toContain('These 2 abilities have a sample too long:');
    expect(next).toContain('English now: write in English');
  });

  it('shows her the images he attaches, names the tester’s, and gives PDFs and text as redacted text', async () => {
    const png = store.save('freeze.png', 'image/png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    const pdf = store.save('spec.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    const log1 = store.save('export.log', 'text/plain', Buffer.from('timeout after 30s'));
    await brain.say({ text: 'here', from: 'owner', conversationId: 'c1', attachments: [png, pdf, log1] });
    await tick();
    const sent = sdk.sessions[0]!.sent[0]!;
    expect(sent).toContain('here\n[Attached image freeze.png]\n[image]\n[Attached PDF spec.pdf, as text]\nPage one. apikey: [redacted secret]\n[Attached export.log (text/plain)]\ntimeout after 30s');
    // From the tester, only the repository's own pictures are shown, compared byte for byte.
    await brain.say({ text: 'look', from: 'tester', conversationId: 'c1', attachments: [png] });
    await tick();
    expect(sdk.sessions[0]!.sent.at(-1)).toBe(
      "[From the tester] look\n[The tester attached the image freeze.png (image/png); from the tester you are shown only the repository's own pictures (assets, prototypes)]",
    );
    const agreed = store.save('anything-at-all.png', 'image/png', AGREED);
    await brain.say({ text: 'the agreed screen', from: 'tester', conversationId: 'c1', attachments: [agreed] });
    await tick();
    expect(sdk.sessions[0]!.sent.at(-1)).toBe("[From the tester] the agreed screen\n[The tester attached image anything-at-all.png, one of the repository's own pictures]\n[image]");
    // The log keeps a reference, never the image.
    expect(JSON.stringify(log.readFrom(0, 10_000))).not.toContain(Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64'));
  });
});

describe('agent reports, given to her in batches and acknowledged', () => {
  it('opens her next turn in the run’s conversation with what its agent reported, and acknowledges each report', async () => {
    log.append('orchestrator', 'run.created', { runId: 'r3', ticket: 'SHOP-1164', worktree: '', branch: '', agentNumber: 3, conversationId: 'c1' });
    log.append('orchestrator', 'run.created', { runId: 'r4', ticket: 'SHOP-9', worktree: '', branch: '', agentNumber: 4, conversationId: 'c2' });
    const step = log.append('agent', 'run.step_begun', { runId: 'r3', stepIndex: 0, name: 'Reproduce', why: 'Stall the image resizer.' });
    const beat = log.append('agent', 'run.heartbeat', { runId: 'r3', step: 'Reproduce', sinceLast: 'Stalled it.', next: 'Fix.', progress: 'some', risks: [], tokens: 1000, workingSeconds: 300 });
    log.append('agent', 'run.step_begun', { runId: 'r4', stepIndex: 0, name: 'Other', why: 'Elsewhere.' });
    await brain.say({ text: 'how is it going?', from: 'owner', conversationId: 'c1' });
    await tick();
    const first = sdk.sessions[0]!.sent[0]!;
    expect(first).toContain(
      '[Agent reports since your last turn here]\n- Agent 3 (SHOP-1164) began step "Reproduce": Stall the image resizer.\n- Agent 3 (SHOP-1164) heartbeat on "Reproduce" (some done): Stalled it. Next: Fix.\n\nhow is it going?',
    );
    expect(first).not.toContain('Agent 4 (SHOP-9)');
    expect(ofType('run.ack')).toEqual([
      { runId: 'r3', refEventSeq: step.seq },
      { runId: 'r3', refEventSeq: beat.seq },
    ]);
    // Given once.
    await brain.say({ text: 'and now?', from: 'owner', conversationId: 'c1' });
    await tick();
    expect(sdk.sessions[0]!.sent.at(-1)).toBe('and now?');
  });

  it('tells her how a request was answered and by whom, but not a question the workspace closed', async () => {
    log.append('orchestrator', 'run.created', { runId: 'r5', ticket: 'SHOP-3546', worktree: '', branch: '', agentNumber: 5, conversationId: 'c1' });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a1', runId: 'r5', kind: 'push', question: 'Agent 5 on SHOP-3546 wants to push feature/SHOP-3546.' });
    const answer = log.append('orchestrator', 'approval.resolved', { approvalId: 'a1', decision: 'denied', answer: 'Keep the commit local.', test: true });
    log.append('orchestrator', 'approval.requested', { approvalId: 'a2', runId: 'r5', kind: 'command', question: 'Agent 5 wants to run make.' });
    log.append('orchestrator', 'approval.resolved', { approvalId: 'a2', decision: 'denied', answer: 'The run ended.' });
    await brain.say({ text: 'what happened?', from: 'owner', conversationId: 'c1' });
    await tick();
    expect(sdk.sessions[0]!.sent[0]).toContain(
      '[Agent reports since your last turn here]\n- The tester (not alex) declined Agent 5 (SHOP-3546)\'s request: Agent 5 on SHOP-3546 wants to push feature/SHOP-3546. Their note: "Keep the commit local."\n\nwhat happened?',
    );
    expect(ofType('run.ack')).toEqual([{ runId: 'r5', refEventSeq: answer.seq }]);
  });

  it('tells her when the workspace reminded an agent', async () => {
    log.append('orchestrator', 'run.created', { runId: 'r6', ticket: 'SHOP-3546', worktree: '', branch: '', agentNumber: 6, conversationId: 'c1' });
    log.append('orchestrator', 'run.reminded', { runId: 'r6', about: 'heartbeat', text: 'It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.' });
    await brain.say({ text: 'and agent 6?', from: 'owner', conversationId: 'c1' });
    await tick();
    expect(sdk.sessions[0]!.sent[0]).toContain(
      '- The workspace reminded Agent 6 (SHOP-3546): It is 1 working minute since your last heartbeat. Call heartbeat now, then carry on.',
    );
  });
});
