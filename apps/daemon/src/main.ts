import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Git, discoverClones } from './agents/git';
import { Voice } from './elfoqsy/voice';
import { Mirrors } from './agents/mirrors';
import { Orchestrator } from './agents/orchestrator';
import { loadRepoPolicies } from './agents/repoPolicy';
import { assertSubscriptionBilling, claudeLoggedIn, sessionEnv } from './claude/login';
import { UsageState } from './claude/usage';
import { ConfigError, ELFOQSY_REPLY_EFFORT, REPO_ROOT, TICKET_AGENT, elfoqsyModel, loadConfig, type Config, type Mode } from './config';
import { LiveState } from './elfoqsy/liveState';
import { LookWatcher } from './elfoqsy/look';
import { Notifier } from './elfoqsy/notifier';
import { readHerPrompt } from './elfoqsy/prompts';
import { Investigators } from './agents/investigator';
import { Elfoqsy } from './elfoqsy/brain';
import { CodeReader } from './elfoqsy/code';
import { Lookups } from './elfoqsy/lookups';
import { WeeklyReview } from './elfoqsy/review';
import { Conversations } from './elfoqsy/routing';
import { TesterImages } from './elfoqsy/testerImages';
import { orchestratorServer } from './elfoqsy/tools';
import type { Actor, Attachment, JiraChange } from '@elfoqsy/contracts';
import { acceptanceCriteriaText, applyDetail, narrativeRead } from '@elfoqsy/state';
import { toDetail } from './jira/detail';
import { EventLog } from './eventLog';
import { GhReadOnly } from './github/gh';
import { AttachmentStore } from './attachments';
import { Intake } from './intake';
import { redact, type OutboundContext } from './redact';
import { Responder } from './decisions/responder';
import { realClock } from './clock';
import { ulid } from './ulid';
import { JiraClient } from './jira/client';
import { AtlassianConfluence, AtlassianJira } from './jira/atlassian';
import { AwsSession } from './permissions/awsSession';
import { coralogixQuery, liveBackends, proxyEnv } from './permissions/backends';
import { loadEnvironments, runContexts } from './permissions/environments';
import { Kubeconfigs } from './permissions/kubeconfig';
import { startServer } from './server';
import { loadMock } from './sim/mock';
import { SimControl } from './sim/control';
import { simBackends } from './sim/backends';
import { Approvals } from './agents/approvals';
import { createProxies } from './permissions';
import { Grants } from './permissions/grants';
import { Simulator } from './sim/simulator';
import type { RunControl } from './agents/control';
import { Poller } from './sync/poller';
import { syncCodeHost, syncTracker } from './sync/sources';
import { GitHubHost, JiraTracker } from './adapters';
import { SyncTracker } from './sync/tracker';
import { FakeJira, issueFromTicket } from './jira/fake';
import { startTickets, type Tickets } from './jira/tickets';
import { AtlassianWriter } from './jira/writer';
import { AbilityEngine } from './abilities/engine';
import { AbilityStore } from './abilities/store';
import { setTelemetryEndpoint } from './telemetry/env';
import { watchOutcomes } from './telemetry/outcomes';
import { startReceiver } from './telemetry/receiver';
import { TelemetryStore } from './telemetry/store';

const POLL_MS = 60_000;

interface Running {
  log: EventLog;
  file: string;
  /** Pause, resume and guidance from a pane. */
  control: RunControl;
  /** Undo from a pane. */
  undo?: (recordId: string, by: Actor) => Promise<unknown>;
  /** He changes one of Elfoqsy's answers. */
  changeDecision?: (decisionId: string, to: string, by: 'you' | 'tester') => { ok: true } | { error: string; message: string };
  /** He opens the digest. */
  openDigest?: (conversationId: string | undefined, by: 'you' | 'tester') => void;
  /** Tickets in full on the screens. */
  tickets?: Tickets;
  /** The narrative's gate (N1): whether he has read it, and marking a run's draft PR ready from it. */
  narrativeRead?: (runId: string) => boolean;
  markReady?: (runId: string, by: 'you' | 'tester') => Promise<{ ok: true } | { ok: false; message: string }>;
  stop: () => void | Promise<void>;
}

/** Simulate mode keeps its own log and starts it fresh every time, so it never mixes with real events. */
async function startSimulation(config: Config): Promise<Running> {
  const file = join(config.dataDir, 'sim.sqlite');
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  // The simulator writes its history at the times it happened, so the log's clock can be pinned for a moment.
  let pinned: number | null = null;
  const log = new EventLog(file, () => new Date(pinned ?? Date.now()));
  const live = new LiveState(log);
  // The real tier policy over simulated backends: grants, batching, records, Undo and Elfoqsy's lines, reaching nothing.
  const approvals = new Approvals(log);
  const grants = new Grants(log);
  const proxies = createProxies({
    log,
    approvals,
    grants,
    environments: loadEnvironments(join(REPO_ROOT, 'config', 'environments.yaml')),
    backends: simBackends(log),
    repos: ['acme/shop-api', 'acme/shop-shared', 'acme/shop-worker'],
    say: (run, text) => {
      const conversationId = live.get().runs[run.runId]?.conversationId;
      log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, ...(conversationId ? { conversationId } : {}), refs: { tickets: [run.ticket], runId: run.runId } });
    },
    // Undo of a simulated agent's change, from history or after it ended.
    endedRun: async (runId) => {
      const view = live.get().runs[runId];
      if (!view) return null;
      const targets = (view.repos ?? ['acme/shop-api']).map((repo) => ({ repo, base: 'master' }));
      return { run: { runId, ticket: view.ticket, agentNumber: view.agentNumber, branch: view.branch, targets, kubeconfig: join(config.worktreesRoot, '.sim', 'kubeconfig') }, dispose: () => undefined };
    },
  });
  const simulator = new Simulator(log, loadMock(config.mockDir), {
    worktreesRoot: config.worktreesRoot,
    agents: config.SIM_AGENTS,
    setTime: (ms) => {
      pinned = ms;
    },
    proxies,
    grants,
  });
  simulator.start();
  // Tickets in full: the captured fixtures, and the simulated tickets built as Jira would give them.
  const fakeJira = FakeJira.fromFixtures(join(REPO_ROOT, 'apps', 'daemon', 'test', 'fixtures', 'jira'));
  fakeJira.fallback = (key) => {
    const t = live.get().tickets[key];
    return t ? issueFromTicket(t) : undefined;
  };
  const tickets = await startTickets({ log, reader: fakeJira, writer: fakeJira, site: config.JIRA_SITE, fieldsFile: join(REPO_ROOT, 'config', 'jira-fields.json') });
  return {
    log,
    file,
    control: new SimControl(log, () => live.get()),
    undo: (recordId, by) => proxies.undo(recordId, by),
    narrativeRead: (runId) => {
      const run = live.get().runs[runId];
      if (!run) return false;
      const r = narrativeRead(run);
      return r.read || (!!run.test && r.testerRead);
    },
    tickets,
    stop: () => {
      tickets.stop();
      simulator.stop();
      proxies.close();
      grants.close();
      approvals.close();
      live.close();
    },
  };
}

/** Live mode: the persistent log, read-only polling of Jira and GitHub, Elfoqsy, and agent runs. */
async function startLive(config: Config, attachments: AttachmentStore): Promise<Running> {
  const gh = new GhReadOnly(config.GITHUB_REPOS);
  if (!(await gh.authenticated())) throw new ConfigError('The gh CLI is not installed or not logged in. Run `gh auth login`.');
  if (!(await claudeLoggedIn())) throw new ConfigError('The claude CLI is not logged in. Run `claude auth login`.');

  const file = join(config.dataDir, 'elfoqsy.sqlite');
  const log = new EventLog(file);
  // First, so the time the daemon was off never counts as an agent waiting or working.
  log.append('orchestrator', 'daemon.started', { mode: 'live' });
  const tracker = new SyncTracker(log);
  const jira = new JiraClient({ site: config.JIRA_SITE, email: config.JIRA_EMAIL!, token: config.JIRA_API_TOKEN! });
  const fields = { storyPointsField: config.JIRA_STORY_POINTS_FIELD, sprintField: config.JIRA_SPRINT_FIELD };
  const trackerAdapter = new JiraTracker(jira, config.JIRA_PROJECTS, fields);
  const codeHost = new GitHubHost(gh);
  const pollers = [
    // The sync goes through the adapter interfaces (adapters/types.ts): another tracker or code host is another adapter here.
    new Poller({ source: 'jira', intervalMs: POLL_MS, log, tracker, sync: () => syncTracker(trackerAdapter, tracker) }),
    new Poller({ source: 'github', intervalMs: POLL_MS, log, tracker, sync: () => syncCodeHost(codeHost, config.GITHUB_REPOS, trackerAdapter.projects, tracker) }),
  ];
  // Tickets in full: the field map checked, one store for the view, Elfoqsy and the agents, and live reads.
  // His own edits go straight to Jira with his credentials.
  const writer = new AtlassianWriter({ site: config.JIRA_SITE, email: config.JIRA_EMAIL!, token: config.JIRA_API_TOKEN!, bugFields: {} });
  const tickets = await startTickets({ log, reader: jira, writer, site: config.JIRA_SITE, fieldsFile: join(REPO_ROOT, 'config', 'jira-fields.json') });
  const elfoqsy = await startElfoqsy(config, log, gh, jira, attachments, tickets);
  for (const poller of pollers) void poller.start();
  return {
    log,
    file,
    control: elfoqsy.control,
    undo: elfoqsy.undo,
    changeDecision: elfoqsy.changeDecision,
    openDigest: elfoqsy.openDigest,
    narrativeRead: elfoqsy.narrativeRead,
    markReady: elfoqsy.markReady,
    tickets,
    stop: async () => {
      tickets.stop();
      pollers.forEach((p) => p.stop());
      tracker.close();
      await elfoqsy.stop();
    },
  };
}

/**
 * Elfoqsy (a session per conversation), her read-only lookups and investigators, and the orchestrator
 * behind her tools, all on alex's Claude Code login. Sessions start on first need; only events
 * from now on count, history is context, not a trigger.
 */
async function startElfoqsy(
  config: Config,
  log: EventLog,
  gh: GhReadOnly,
  jira: JiraClient,
  attachments: AttachmentStore,
  tickets: Tickets,
): Promise<{ control: RunControl; undo: Running['undo']; changeDecision: Running['changeDecision']; openDigest: Running['openDigest']; narrativeRead: Running['narrativeRead']; markReady: Running['markReady']; stop: () => Promise<void> }> {
  const live = new LiveState(log);
  // The language of his latest message, for every line she writes in her own voice (the digest, the one-line notices). Before anything
  // that listens to the log, so what they write is in the language of the message that woke them.
  const voice = new Voice(log);
  const usage = new UsageState(log);
  usage.restore(live.get().claude);
  // Every session's own OpenTelemetry (traces and log events of the Claude Code binary), to a receiver on 127.0.0.1 and into
  // data/telemetry.sqlite, redacted; each run's outcome beside it. Before any session starts, so each one is tagged.
  const telemetry = config.ELFOQSY_TELEMETRY === 'on' ? await startTelemetry(join(config.dataDir, 'telemetry.sqlite'), live, gh).catch((error: unknown) => {
    console.warn(`Telemetry is off: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }) : undefined;

  // Alex's clones are only read: each run gets its own clones under WORKTREES_ROOT.
  const git = new Git();
  // The mirrors run clones are made from (Elfoqsy's own, beside the run folders): never his clones, whose object files a run clone would share.
  const mirrors = new Mirrors(git, config.agentMirrorsDir, { runsRoot: config.worktreesRoot });
  const policies = loadRepoPolicies(join(REPO_ROOT, 'config', 'agent-repos.json'));
  const wanted = [...new Set([...config.GITHUB_REPOS, ...config.GITHUB_REPOS.flatMap((r) => policies[r]?.needs ?? [])])];
  const clones = await discoverClones(git, config.REPOS_ROOT!, wanted);
  const missing = wanted.filter((r) => !clones.has(r));
  console.log(`Clones under ${config.REPOS_ROOT}: ${[...clones.values()].map((c) => `${c.repo} -> ${c.path}`).join(', ')}${missing.length ? `; none for ${missing.join(', ')}` : ''}`);

  const home = homedir();
  const agentEnv = sessionEnv(process.env);
  // No keyring and no session bus for agents (defence in depth; the sandbox also blocks Unix sockets).
  delete agentEnv.DBUS_SESSION_BUS_ADDRESS;
  delete agentEnv.XDG_RUNTIME_DIR;
  const dataFiles = ['elfoqsy.sqlite', 'sim.sqlite'].flatMap((f) => ['', '-wal', '-shm'].map((x) => join(config.dataDir, f + x)));
  mkdirSync(config.worktreesRoot, { recursive: true });

  const conversations = new Conversations(log, () => live.get());
  usage.conversation = () => conversations.today();

  // The capability proxies: everything an agent does remotely, under the four tiers, with alex's credentials.
  const environments = loadEnvironments(join(REPO_ROOT, 'config', 'environments.yaml'));
  const backends = liveBackends(process.env);
  const atlassian = {
    site: config.JIRA_SITE,
    email: config.JIRA_EMAIL!,
    token: config.JIRA_API_TOKEN!,
    tickets: { store: tickets.store, ids: tickets.ids },
    bugFields: {
      ...(config.JIRA_ROOT_CAUSE_FIELD ? { rootCause: config.JIRA_ROOT_CAUSE_FIELD } : {}),
      ...(config.JIRA_SOLUTION_FIELD ? { solution: config.JIRA_SOLUTION_FIELD } : {}),
      ...(config.JIRA_AC_FIELD ? { ac: config.JIRA_AC_FIELD } : {}),
    },
  };
  const runsData = join(config.dataDir, 'runs'); // each run's kubeconfig: outside every sandbox
  const kubeconfigs = new Kubeconfigs(runsData, backends.kubeconfig, runContexts(environments));
  const aws = new AwsSession({
    log,
    profiles: environments.list.flatMap((e) => (e.awsProfile ? [{ environment: e.name, profile: e.awsProfile }] : [])),
    probe: backends.awsProbe,
    ask: (text) => log.append('orchestrator', 'elfoqsy.message', { messageId: ulid(), role: 'elfoqsy', text, conversationId: conversations.today() }),
  });
  await aws.start();
  if (!config.CORALOGIX_API_KEY) console.log('Coralogix is not configured (CORALOGIX_API_KEY): log reads stay unavailable, and the logs tools say so.');

  // Read-only: lookups run here; investigators read the configured repositories and their declared
  // dependencies under REPOS_ROOT, and never the workspace's own secrets or data.
  const readable = new Map([...clones].map(([repo, c]) => [repo, c.path]));
  // Logs for Elfoqsy and investigators: non-prod only, read-only; without the key they say it is not set up.
  const lookups = new Lookups({
    jira,
    tickets: { store: tickets.store, ids: tickets.ids },
    gh,
    code: new CodeReader(readable),
    site: config.JIRA_SITE,
    logs: { envs: environments, ...(config.CORALOGIX_API_KEY ? { query: coralogixQuery(config.CORALOGIX_API_KEY, config.CORALOGIX_DOMAIN) } : {}) },
  });

  // The Abilities skills: each ticket run, task agent, investigator and conversation of hers gets its own read-only copy.
  const abilitiesDir = join(config.dataDir, 'skills');
  const abilityCopies = join(config.dataDir, 'abilities');
  // The engine over them: verifies read steps through her own tier-0 reads, tracks uses, reviews
  // each run's friction. Its reads go through the orchestrator, made below.
  const abilities = new AbilityEngine({
    log,
    state: () => live.get(),
    store: new AbilityStore(abilitiesDir),
    read: (proxy, input) => orchestrator.elfoqsyRead(proxy, input),
    queryFn: query,
    model: elfoqsyModel(config),
    cwd: join(config.dataDir, 'elfoqsy'),
    env: sessionEnv(process.env),
    // What she learns, she says herself, in his language: a turn of hers, never a line assembled here.
    announce: (a) => elfoqsy?.announceAbilities(a),
    ...(telemetry ? { telemetry: telemetry.store } : {}),
    // The samples too long for a card's line, handed to her to write shorter; false until she is up (then it is asked at the next start).
    revise: (r) => (elfoqsy ? elfoqsy.reviseAbilities(r) : false),
  });
  // Recurring failures in the traces, once a day: one that no ability covers goes to the review (telemetry).
  const discovering = telemetry ? setInterval(() => void abilities.discoverRecurring().catch((error: unknown) => console.warn(`Abilities from the traces: ${error instanceof Error ? error.message : String(error)}`)), 24 * 3600_000) : undefined;
  discovering?.unref();
  // Elfoqsy as first responder: one short session of hers per agent question or escalation, on her model.
  const cwd = join(config.dataDir, 'elfoqsy'); // empty on purpose: nothing for a session to pick up
  mkdirSync(cwd, { recursive: true });
  const responder = new Responder({
    state: () => live.get(),
    usage,
    queryFn: query,
    lookups,
    systemPrompt: readHerPrompt(REPO_ROOT, 'elfoqsy-responder.md'),
    model: elfoqsyModel(config),
    effort: 'medium',
    cwd,
    env: sessionEnv(process.env),
  });
  // What a web request must never carry or reach: his hosts, repositories and local paths.
  const outbound: OutboundContext = {
    internalHosts: [new URL(config.JIRA_SITE).hostname, `api.${config.CORALOGIX_DOMAIN.replace(/^api\./, '')}`, ...config.INTERNAL_HOSTS],
    repos: wanted,
    localRoots: [home, config.REPOS_ROOT!, config.worktreesRoot, config.agentMirrorsDir, config.dataDir, REPO_ROOT],
    inClones: (path) => [...clones.values()].some((c) => existsSync(join(c.path, path))),
    // At most 3 seconds: a name that does not resolve fails the fetch anyway.
    resolve: (host) =>
      Promise.race([
        lookup(host, { all: true }).then((all) => all.map((a) => a.address)),
        new Promise<string[]>((done) => setTimeout(() => done([]), 3000).unref()),
      ]),
  };

  let elfoqsy: Elfoqsy | undefined;
  const orchestrator = new Orchestrator({
    conversations,
    refreshTicket: (key) => void tickets.details.refresh(key),
    // The Acceptance criteria field for the reviewer's pack: from Jira (its cache is short), so a ticket nobody opened is read too.
    acceptanceOf: async (key) => {
      const bundle = await tickets.store.get(key, 30_000);
      return acceptanceCriteriaText(applyDetail(undefined, toDetail(bundle, tickets.ids()), bundle.fetchedAt), tickets.ids());
    },
    ...(tickets.creates ? { draftTicket: (o: Parameters<NonNullable<typeof tickets.creates>['draft']>[0]) => tickets.creates!.draft(o) } : {}),
    jiraNews: (since, conversationId, asked) => void (asked ? tickets.news.onAsked(since, conversationId) : tickets.news.onBack(since, conversationId)).catch((e: unknown) => console.warn(`Jira news: ${e instanceof Error ? e.message : String(e)}`)),
    log,
    live,
    usage,
    git,
    environments,
    backends: {
      kubectl: backends.kubectl,
      aws: backends.aws,
      gh: backends.gh,
      jira: new AtlassianJira(atlassian),
      confluence: new AtlassianConfluence(atlassian),
      ...(config.CORALOGIX_API_KEY ? { logs: coralogixQuery(config.CORALOGIX_API_KEY, config.CORALOGIX_DOMAIN) } : {}),
      docker: backends.docker,
      // shop.sh from his checkout, read only; the script gets only what it needs of the daemon's environment.
      shop: {
        backend: { script: backends.shopScript },
        ...(config.REPOS_ROOT ? { source: join(config.REPOS_ROOT, 'shop-local-deploy') } : {}),
        env: Object.fromEntries(Object.entries(proxyEnv(process.env)).filter((e): e is [string, string] => typeof e[1] === 'string')),
      },
    },
    kubeconfigs,
    aws,
    queryFn: query,
    config,
    policies,
    clones,
    mirrors,
    baseEnv: agentEnv,
    hosts: {
      jira: [new URL(config.JIRA_SITE).hostname],
      github: ['github.com', 'githubusercontent.com'],
      registry: ['registry.npmjs.org', 'registry.yarnpkg.com', 'nodejs.org'],
    },
    protectedPaths: [config.REPOS_ROOT!, config.agentMirrorsDir, join(REPO_ROOT, '.env'), join(config.dataDir, 'elfoqsy'), join(config.dataDir, 'attachments'), runsData, join(home, '.claude'), abilitiesDir, abilityCopies, ...dataFiles],
    usageProbe: () => elfoqsy?.usageSnapshot() ?? Promise.resolve(undefined),
    ciLog: (repo, sha) => gh.failedCiLog(repo, sha),
    commitCi: (repo, sha) => gh.commitCi(repo, sha),
    // ~/tickets/<KEY>: a run holds its ticket's folder while it works; his clones and worktrees show his own sessions.
    tickets: { root: join(home, 'tickets'), testRoot: join(config.dataDir, 'test-tickets'), ...(config.REPOS_ROOT ? { codeRoot: config.REPOS_ROOT } : {}) },
    prReviewRounds: (repo, number) => gh.botReviewRounds(repo, number),
    responder,
    outbound,
    skill: {
      dir: join(home, '.claude', 'skills', 'team-dev'),
      adapterFile: join(REPO_ROOT, 'prompts', 'skill-adapter.md'),
      manifestFile: join(REPO_ROOT, 'config', 'skill-adapter.json'),
    },
    abilitiesDir,
    abilities,
  });
  orchestrator.recoverStaleRuns();
  // Skills on disk the log does not know yet are learned; whatever is not verified yet is verified (in the background).
  void abilities.reconcile().then(
    (learned) => learned.length && console.log(`Abilities: ${learned.length} skill${learned.length === 1 ? '' : 's'} learned from data/skills: ${learned.join(', ')}.`),
    (error: unknown) => console.warn(`Abilities: ${error instanceof Error ? error.message : String(error)}`),
  );
  // The team-dev skill: its environment facts in Elfoqsy's memory, and a word to him if it changed since the adapter.
  const seeded = orchestrator.seedSkillFacts();
  if (seeded) console.log(`team-dev: ${seeded} memory change${seeded === 1 ? '' : 's'} for its environment facts.`);
  if (orchestrator.checkSkill()) console.log('team-dev changed since the adapter was written: Elfoqsy said so in Today.');
  const closed = await orchestrator.closeEndedFolders();
  if (closed.removed) console.log(`Run folders: ${closed.removed} of closed runs removed, with nothing uncommitted and nothing missing from GitHub.`);
  if (closed.noted) console.log(`Run folders: ${closed.noted} of closed runs kept for their work, and noted in their tickets' conversations.`);
  const keptChanged = await orchestrator.refreshKeptWork();
  if (keptChanged) console.log(`Kept work: ${keptChanged} fact${keptChanged === 1 ? '' : 's'} about kept run folders brought up to date.`);

  const investigators = new Investigators({
    log,
    usage,
    queryFn: query,
    lookups,
    clones: readable,
    baseEnv: agentEnv,
    root: join(config.dataDir, 'investigations'),
    abilitiesDir,
    abilityUses: (u) => void abilities.sessionUses(u).catch((error: unknown) => console.warn(`Abilities after ${u.id}: ${error instanceof Error ? error.message : String(error)}`)),
    protectedPaths: [
      config.agentMirrorsDir,
      join(REPO_ROOT, '.env'),
      join(config.dataDir, 'elfoqsy'),
      join(config.dataDir, 'attachments'),
      join(home, '.claude'),
      join(home, '.ssh'),
      join(home, '.config', 'gh'),
      abilitiesDir,
      abilityCopies,
      ...dataFiles,
    ],
    onFinished: (done) => elfoqsy?.investigationFinished(done),
    outbound,
  });


  const weekly = new WeeklyReview({ log, state: () => live.get(), ask: (conversationId, text) => elfoqsy?.inform(conversationId, text) });
  const brain = new Elfoqsy({
    log,
    usage,
    state: () => live.get(),
    systemPrompt: readHerPrompt(REPO_ROOT, 'elfoqsy-system-prompt.md'),
    tools: (session) => orchestratorServer({ log, state: () => live.get(), orchestrator, lookups, investigators, control: orchestrator, reviews: weekly, session, environments, abilities }),
    events: live,
    conversations,
    attachments,
    // The tester may show her only the repository's own pictures, compared byte for byte.
    testerImages: new TesterImages([join(REPO_ROOT, 'assets'), join(REPO_ROOT, 'prototypes')]),
    cwd,
    env: sessionEnv(process.env),
    // Opus 5.5 at high for her replies (alex's call, 2026-10-19; medium since 2026-10-10): deep work goes to investigators. And her
    // own web (WebSearch, WebFetch), with the same check on what leaves as the agents' web.
    model: elfoqsyModel(config),
    effort: ELFOQSY_REPLY_EFFORT,
    outbound,
    abilities: { dir: abilitiesDir, copies: abilityCopies },
    abilityUses: (u) => void abilities.sessionUses(u).catch((error: unknown) => console.warn(`Abilities after a turn in ${u.id}: ${error instanceof Error ? error.message : String(error)}`)),
    ticketKey: new RegExp(`\\b(?:${config.JIRA_PROJECTS.join('|')})-\\d+\\b`, 'i'),
    queryFn: query,
  });
  elfoqsy = brain;
  // Now she can be handed things: the abilities whose samples are too long for a card's line, once for each.
  void abilities.askShorter().then(
    (asked) => asked.length && console.log(`Abilities: Elfoqsy was asked to shorten the samples of ${asked.join(', ')}.`),
    (error: unknown) => console.warn(`Abilities: ${error instanceof Error ? error.message : String(error)}`),
  );
  const notifier = new Notifier(live, (notices) => {
    if (config.ELFOQSY_WORKSPACE_UPDATES === 'on') brain.notify(notices);
  });
  if (config.ELFOQSY_WORKSPACE_UPDATES === 'off') console.log('Workspace updates to Elfoqsy are off (ELFOQSY_WORKSPACE_UPDATES=off).');
  if (config.TICKET_AGENT_MODEL !== TICKET_AGENT.model || config.TICKET_AGENT_EFFORT !== TICKET_AGENT.effort) {
    console.log(`The ticket agent is ${config.TICKET_AGENT_MODEL} at ${config.TICKET_AGENT_EFFORT}, not Opus 5.5 at xhigh (TICKET_AGENT_MODEL, TICKET_AGENT_EFFORT): for a probe only.`);
  }
  if (config.AGENT_HEARTBEAT_MINUTES !== 5) {
    const every = config.AGENT_HEARTBEAT_MINUTES;
    console.log(`Agents report a heartbeat every ${every === 1 ? 'working minute' : `${every} working minutes`} (AGENT_HEARTBEAT_MINUTES).`);
  }
  // The weekly review: at the first start on or after Monday 09:00, once per Monday.
  if (config.ELFOQSY_WEEKLY_REVIEW === 'on') {
    for (const week of weekly.correctStale()) console.log(`The weekly review for ${week} was corrected: its numbers were computed again from the log.`);
    const due = weekly.runIfDue();
    if (due) console.log(`Weekly review for ${due} asked of Elfoqsy.`);
  } else console.log('The weekly review is off (ELFOQSY_WEEKLY_REVIEW=off).');
  // And every hour while the daemon runs, so Monday's review does not wait for a restart.
  const stopWeekly = config.ELFOQSY_WEEKLY_REVIEW === 'on' ? weekly.watch(realClock) : () => undefined;
  // His messages, and marked test messages; answers to an agent's question go to the orchestrator, not to her.
  const stopListening = live.onEvent((_previous, event) => {
    if (event.type === 'elfoqsy.message' && event.payload.role !== 'elfoqsy' && !event.payload.refs?.approvalId) {
      const p = event.payload;
      brain
        .say({ text: p.text, from: p.role === 'test' ? 'tester' : 'owner', ...(p.conversationId ? { conversationId: p.conversationId } : {}), attachments: p.attachments ?? ([] as Attachment[]) })
        .catch((error: unknown) => console.warn(`A message could not reach Elfoqsy: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`));
    }
  });
  return {
    control: orchestrator,
    undo: (recordId, by) => orchestrator.undo(recordId, by),
    changeDecision: (decisionId, to, by) => orchestrator.changeDecision(decisionId, to, by),
    openDigest: (conversationId, by) => orchestrator.openDigest(conversationId, by),
    narrativeRead: (runId) => orchestrator.narrativeRead(runId),
    markReady: (runId, by) => orchestrator.markReady(runId, by),
    stop: async () => {
      stopWeekly();
      stopListening();
      if (discovering) clearInterval(discovering);
      aws.stop();
      notifier.close();
      investigators.close();
      await orchestrator.close(); // runs log their end before the log closes
      brain.close();
      usage.close();
      // After the sessions: each one's binary flushes its last spans as it ends, to a receiver still listening.
      await telemetry?.stop();
      live.close();
      voice.close();
    },
  };
}

async function main(): Promise<void> {
  const mode: Mode = process.argv.includes('--simulate') ? 'simulate' : 'live';
  // Secrets may live in a .env at the repository root (gitignored); real environment variables win.
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // Claude runs on Alex's subscription login only; never let billing switch silently.
  assertSubscriptionBilling(process.env);
  const config = loadConfig(process.env, mode);
  mkdirSync(config.dataDir, { recursive: true });
  // Before any agent starts, so its sandbox can keep the folder out of reach.
  const attachments = new AttachmentStore(join(config.dataDir, 'attachments'));

  const running = mode === 'simulate' ? await startSimulation(config) : await startLive(config, attachments);
  const look = new LookWatcher(running.log);
  const intake = new Intake(running.log, {
    runs: running.control,
    attachments,
    ...(running.undo ? { undo: running.undo } : {}),
    ...(running.changeDecision ? { changeDecision: running.changeDecision } : {}),
    ...(running.openDigest ? { openDigest: running.openDigest } : {}),
    ...(running.narrativeRead ? { narrativeRead: running.narrativeRead } : {}),
    ...(running.markReady ? { markReady: running.markReady } : {}),
    ...(running.tickets ? { watchTicket: (key: string) => running.tickets!.watch(key) } : {}),
    ...(running.tickets?.edits
      ? {
          jiraEdit: (editId: string, key: string, change: JiraChange) => void running.tickets!.edits!.edit(editId, key, change),
          jiraTransitions: (key: string) => void running.tickets!.edits!.transitions(key).catch((e: unknown) => console.warn(`Transitions of ${key}: ${e instanceof Error ? e.message : String(e)}`)),
          searchTickets: (query: string) => void running.tickets!.edits!.search(query).catch((e: unknown) => console.warn(`Ticket search: ${e instanceof Error ? e.message : String(e)}`)),
        }
      : {}),
    ...(running.tickets?.creates
      ? {
          createMeta: (project: string, typeId?: string) => {
            void running.tickets!.creates!.meta(project, typeId).catch((e: unknown) => console.warn(`Create screen of ${project}: ${e instanceof Error ? e.message : String(e)}`));
            // His form's pickers: people, sprints, link types and labels, read at most once an hour.
            void running.tickets!.edits?.optionsForProject(project).catch((e: unknown) => console.warn(`Jira options for ${project}: ${e instanceof Error ? e.message : String(e)}`));
          },
          createTicket: (f: Parameters<NonNullable<typeof running.tickets.creates>['create']>[0]) => void running.tickets!.creates!.create(f),
          discardDraft: (draftId: string, by: 'you' | 'tester') => running.tickets!.creates!.discard(draftId, by),
        }
      : {}),
  });
  const server = await startServer({
    log: running.log,
    intake,
    mode,
    jiraSite: config.JIRA_SITE,
    port: config.DAEMON_PORT,
    attachments,
    ...(running.tickets ? { jiraAttachment: running.tickets.attachment } : {}),
  });

  console.log(`Elfoqsy daemon, ${mode} mode. Socket ${server.url.replace('http', 'ws')}/ws, log ${running.file}`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await running.stop();
    look.close();
    intake.close();
    await server.close();
    running.log.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error('The daemon port is in use. Is another daemon running? Set DAEMON_PORT to change it.');
  } else console.error(error);
  process.exit(1);
});

/** The receiver, the store and the outcomes watcher, pruned to 90 days once a day; how to stop them. */
async function startTelemetry(file: string, live: LiveState, gh: GhReadOnly): Promise<{ store: TelemetryStore; stop: () => Promise<void> }> {
  const store = new TelemetryStore(file, () => live.get());
  const receiver = await startReceiver(store, (message) => console.warn(message));
  setTelemetryEndpoint(receiver.url);
  const stopOutcomes = watchOutcomes({ store, state: () => live.get(), onEvent: (l) => live.onEvent(l), reviewRounds: (repo, number) => gh.botReviewRounds(repo, number) });
  const DAY = 24 * 3600_000;
  store.prune(Date.now() - 90 * DAY);
  const pruning = setInterval(() => store.prune(Date.now() - 90 * DAY), DAY);
  pruning.unref();
  console.log(`Telemetry: every session exports to ${receiver.url} (this machine only), kept in ${file}.`);
  return {
    store,
    stop: async () => {
      clearInterval(pruning);
      stopOutcomes();
      setTelemetryEndpoint(undefined);
      await receiver.drain();
      await receiver.close();
      store.close();
    },
  };
}

