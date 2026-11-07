// Elfoqsy reads for herself (v1.5): the tier-0 operations of the kube, aws, gh and logs proxies, directly in her own
// session, with the tiers, redaction and log an agent's request has, and nothing for alex to approve. Every
// backend is a fake; nothing leaves the test.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { Approvals } from '../src/agents/approvals';
import { KUBECONFIG_RENEW_MS } from '../src/agents/orchestrator';
import { ELFOQSY_RUN } from '../src/decisions/firstResponder';
import { activityLine } from '../src/elfoqsy/activity';
import { LiveState } from '../src/elfoqsy/liveState';
import { language } from '../src/elfoqsy/voice';
import { ALLOWED_TOOLS, DESCRIPTIONS, orchestratorHandlers, orchestratorServer, readDescription, type SessionContext } from '../src/elfoqsy/tools';
import { REPO_ROOT } from '../src/config';
import { EventLog } from '../src/eventLog';
import { createProxies } from '../src/permissions';
import { AwsSession } from '../src/permissions/awsSession';
import { neverEnds } from '../src/permissions/endless';
import { runContexts } from '../src/permissions/environments';
import { Grants } from '../src/permissions/grants';
import { Kubeconfigs } from '../src/permissions/kubeconfig';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import { READ_PROXIES } from '../src/permissions/proxy';
import { ManualClock, runTool } from './helpers/fakeSdk';
import { SHOP_API, orchestratorWorld, type OrchestratorWorld } from './helpers/orchestratorWorld';
import { environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

const DEV = '--context dev';
const DEV_ARN = 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop';
const T0 = Date.parse('2026-10-18T08:00:00Z');

// A synthetic key in the shape of the real CORE-18891 description, assembled here so no token-shaped literal is in the repo.
const hex = (length: number, seed = 7): string => {
  let out = '';
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += ((x >>> 16) % 16).toString(16);
  }
  return out;
};

const herRef = (kubeconfig = '/data/runs/elfoqsy/kubeconfig'): ProxyRun => ({ runId: ELFOQSY_RUN, ticket: '', agentNumber: 0, branch: '', targets: [], kubeconfig, actor: 'elfoqsy', label: '' });

describe('her reads through the proxies', () => {
  let clock: ManualClock;
  let log: EventLog;
  let approvals: Approvals;
  let grants: Grants;
  let backends: FakeBackends;
  let proxies: Proxies;
  let aws: AwsSession | undefined;
  let probe: 'ok' | 'expired';

  const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
  const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
  const kube = (args: string) => proxies.read(herRef(), 'kube', { args: args.split(' ') });
  const awsRead = (args: string) => proxies.read(herRef(), 'aws', { args: args.split(' ') });
  const gh = (args: string) => proxies.read(herRef(), 'gh', { args: args.split(' ') });

  function build(withAws = false): void {
    approvals = new Approvals(log, undefined, clock);
    grants = new Grants(log, { clock, now: () => clock.now });
    if (withAws) {
      aws = new AwsSession({
        log,
        profiles: environments.list.flatMap((e) => (e.awsProfile ? [{ environment: e.name, profile: e.awsProfile }] : [])),
        probe: async () => probe,
        ask: (text) => log.append('orchestrator', 'elfoqsy.message', { messageId: `aws-${clock.now}`, role: 'elfoqsy', text }),
        clock,
      });
    }
    proxies = createProxies({
      log,
      approvals,
      grants,
      environments,
      backends,
      repos: [SHOP_API],
      ...(aws ? { aws } : {}),
      say: (run, text) => log.append('orchestrator', 'elfoqsy.message', { messageId: `m-${log.headSeq()}`, role: 'elfoqsy', text, refs: { runId: run.runId } }),
      now: () => clock.now,
    });
  }

  beforeEach(() => {
    clock = new ManualClock(T0);
    log = new EventLog(':memory:', () => new Date(clock.now));
    backends = fakeBackends();
    aws = undefined;
    probe = 'ok';
    build();
  });

  afterEach(() => {
    language.current = 'en';
    aws?.stop();
    proxies.close();
    grants.close();
    approvals.close();
    log.close();
  });

  it('reads only through kube, aws, gh and logs', async () => {
    expect(READ_PROXIES).toEqual(['kube', 'aws', 'gh', 'logs']);
    expect(await proxies.read(herRef(), 'docker', { args: ['ps'] })).toMatchObject({ ok: false });
    expect(await proxies.read(herRef(), 'jira', { action: 'get', key: 'SHOP-1' })).toMatchObject({ ok: false });
    expect(backends.calls.jira).toEqual([]);
  });

  it('runs a kube read as an agent’s read runs: the environment’s tiers, its namespace added, logged under her own run, nothing asked', async () => {
    backends.kubeAnswers.set('get deployments', { ok: true, stdout: 'shop-api   1/1', stderr: '' });
    const r = await kube(`${DEV} get deployments`);
    expect(r).toMatchObject({ ok: true, text: 'shop-api   1/1' });
    expect(backends.calls.kubectl).toEqual([{ args: ['--context', DEV_ARN, 'get', 'deployments', '-n', 'shop-dev'], kubeconfig: '/data/runs/elfoqsy/kubeconfig' }]);
    expect(payloads('action.classified')).toEqual([
      { actionId: r.actionId, runId: ELFOQSY_RUN, proxy: 'kube', kind: 'kube.get', tier: 0, environment: 'dev', summary: `kubectl ${DEV} get deployments`, decision: 'run', reason: 'A read.' },
    ]);
    expect(payloads('action.finished')).toEqual([{ actionId: r.actionId, runId: ELFOQSY_RUN, ok: true, outputSummary: 'shop-api   1/1', durationMs: 0 }]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(payloads('change.recorded')).toEqual([]);
    expect(payloads('elfoqsy.message')).toEqual([]);
  });

  it.each([
    ['describe', `${DEV} describe deployment shop-api`],
    ['logs', `${DEV} logs deployment/shop-api --tail=20`],
    ['events', `${DEV} get events`],
    ['top', `${DEV} top pods`],
  ])('runs kubectl %s', async (_verb, args) => {
    expect(await kube(args)).toMatchObject({ ok: true });
    expect(payloads('action.classified').at(-1)).toMatchObject({ tier: 0, decision: 'run', environment: 'dev' });
  });

  it('redacts what a read returns, in what she is given and in the log', async () => {
    const key = hex(40);
    backends.kubeAnswers.set('get deployments', { ok: true, stdout: `env: apikey: ${key}\nname: shop-api`, stderr: '' });
    const r = await kube(`${DEV} get deployments`);
    expect(r.text).not.toContain(key);
    expect(r.text).toContain('shop-api');
    expect(JSON.stringify(events())).not.toContain(key);
  });

  it('runs aws describe, list and get reads, by profile', async () => {
    backends.awsAnswers.set('ecr describe-images', { ok: true, stdout: '{"imageDetails":[]}', stderr: '' });
    const r = await awsRead('ecr describe-images --repository-name shop-api --profile dev-shop');
    expect(r).toMatchObject({ ok: true });
    expect(payloads('action.classified').at(-1)).toMatchObject({ proxy: 'aws', tier: 0, decision: 'run', runId: ELFOQSY_RUN });
    expect(await awsRead('eks list-clusters --profile dev-shop')).toMatchObject({ ok: true });
  });

  it('runs gh reads on any repository', async () => {
    backends.ghAnswers.set('pr view', { ok: true, stdout: 'title: x', stderr: '' });
    expect(await gh(`pr view 12 --repo ${SHOP_API}`)).toMatchObject({ ok: true, text: 'title: x' });
    expect(payloads('action.classified').at(-1)).toMatchObject({ proxy: 'gh', tier: 0, decision: 'run' });
  });

  it('reads the non-prod logs, and refuses prod, which an agent’s tool asks for', async () => {
    expect(await proxies.read(herRef(), 'logs', { query: 'filter $m.severity == ERROR | limit 5', environment: 'dev' })).toMatchObject({ ok: true });
    expect(backends.calls.logs).toHaveLength(1);
    const prod = await proxies.read(herRef(), 'logs', { query: 'limit 5', application: 'shop-prod' });
    expect(prod).toMatchObject({ ok: false });
    expect(backends.calls.logs).toHaveLength(1);
    expect(payloads('action.classified').at(-1)).toMatchObject({ proxy: 'logs', decision: 'refuse' });
  });

  describe('never anything but a free read', () => {
    const cases: Array<[string, () => Promise<{ ok: boolean; text: string }>, RegExp]> = [
      ['kube set image (tier 1 for an agent)', () => kube(`${DEV} set image deployment/shop-integration-test shop-integration-test=it:2.22.0`), /tier 1/],
      ['kube scale (tier 1 for an agent)', () => kube(`${DEV} scale deployment/shop-integration-test --replicas=0`), /tier 1/],
      ['kube get secret (tier 2)', () => kube(`${DEV} get secret db-password -o yaml`), /tier 2/],
      ['kube exec (tier 2)', () => kube(`${DEV} exec shop-api-0 -- ls`), /tier 2/],
      ['a context that is not ours (tier 2, reads included)', () => kube('--context automation-test get pods'), /tier 2/],
      ['kube apply (tier 3)', () => kube(`${DEV} apply -f x.yaml`), /alex's to do/],
      ['kube delete (tier 3)', () => kube(`${DEV} delete pod shop-api-0`), /alex's/],
      ['prod (tier 3)', () => kube('--context production-cluster get pods'), /prod/],
      ['a call without a context', () => kube('get pods'), /names its context/],
      ['aws secretsmanager (tier 2)', () => awsRead('secretsmanager get-secret-value --secret-id x --profile dev-shop'), /tier 2/],
      ['aws lambda get-function-configuration (environment variables, tier 2)', () => awsRead('lambda get-function-configuration --function-name f --profile dev-shop'), /Lambda function's environment variables[\s\S]*asked first/],
      ['aws lambda get-function (environment variables, tier 2)', () => awsRead('lambda get-function --function-name f --profile dev-shop'), /environment variables/],
      ['aws ssm get-parameter, any type (tier 2)', () => awsRead('ssm get-parameter --name /x --profile dev-shop'), /SSM parameter of any type/],
      ['aws cloudcontrol get-resource (a whole configuration, tier 2)', () => awsRead('cloudcontrol get-resource --type-name AWS::Lambda::Function --identifier f --profile dev-shop'), /whole configuration/],
      ['aws ssm get-parameter with decryption (tier 2)', () => awsRead('ssm get-parameter --name /x --with-decryption --profile dev-shop'), /tier 2/],
      ['aws s3 cp (a write, tier 2)', () => awsRead('s3 cp a s3://b/c --profile dev-shop'), /tier 2/],
      ['aws credentials (tier 3)', () => awsRead('sts assume-role --role-arn x --role-session-name y --profile dev-shop'), /never|credentials/i],
      ['gh pr merge (tier 3)', () => gh(`pr merge 9 --repo ${SHOP_API}`), /never|alex's/i],
      ['gh pr ready (tier 2)', () => gh(`pr ready 9 --repo ${SHOP_API}`), /tier 2/],
      ['gh pr comment (tier 2)', () => gh(`pr comment 9 --repo ${SHOP_API} --body x`), /tier 2/],
    ];

    it.each(cases)('refuses %s, logs it as refused, asks nobody and runs nothing', async (_name, call, why) => {
      const before = backends.calls.kubectl.length;
      const r = await call();
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/^Refused: /);
      expect(r.text).toMatch(why);
      expect(payloads('action.classified').at(-1)).toMatchObject({ runId: ELFOQSY_RUN, decision: 'refuse' });
      expect(payloads('approval.requested')).toEqual([]);
      expect(payloads('grant.created')).toEqual([]);
      expect(payloads('change.recorded')).toEqual([]);
      expect(payloads('action.finished')).toEqual([]);
      // Only classifying a set image reads the workload (get -o json); no write reaches the cluster.
      expect(backends.calls.kubectl.slice(before).every((c) => c.args.includes('get') || c.args.length === 0)).toBe(true);
      expect(backends.calls.aws).toEqual([]);
      expect(backends.calls.gh).toEqual([]);
    });
  });

  it('does not wait for a session that runs out in the middle of a call: she is told at once, and the session is marked expired because AWS said so', async () => {
    build(true);
    backends.kubeAnswers.set('get deployments', { ok: false, stdout: '', stderr: 'An error occurred (ExpiredToken) when calling the GetToken operation: The security token included in the request is expired' });
    const r = await Promise.race([kube(`${DEV} get deployments`), new Promise<'waited'>((done) => setTimeout(() => done('waited'), 1000))]);
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/session for dev has run out[\s\S]*do not retry/) });
    expect(aws!.fresh('dev')).toBe(false);
    expect(payloads('aws.session').at(-1)).toMatchObject({ state: 'expired', environment: 'dev' });
    // The next read is refused up front, with no call.
    backends.calls.kubectl.length = 0;
    expect(await kube(`${DEV} get pods`)).toMatchObject({ ok: false, text: expect.stringMatching(/^Refused: .*session for dev has run out/) });
    expect(backends.calls.kubectl).toEqual([]);
  });

  it('never marks a session expired on text her call carried, which an error repeats: not a name, an id, nor the real words', async () => {
    build(true);
    const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<'waited'>((done) => setTimeout(() => done('waited'), 1000))]);
    // A name kubectl does not find, repeated in its error.
    backends.kubeAnswers.set('get deployment ExpiredToken', { ok: false, stdout: '', stderr: 'Error from server (NotFound): deployments.apps "ExpiredToken" not found' });
    expect(await within(kube(`${DEV} get deployment ExpiredToken`))).toMatchObject({ ok: false });
    // An id AWS repeats.
    backends.awsAnswers.set('describe-instances', { ok: false, stdout: '', stderr: 'An error occurred (InvalidInstanceID.Malformed): Invalid id: "ExpiredToken"' });
    expect(await within(awsRead('ec2 describe-instances --instance-ids ExpiredToken --profile dev-shop'))).toMatchObject({ ok: false });
    // Even the real words are not believed from a call that carried such words: it proves nothing, and the hourly check finds out.
    backends.awsAnswers.set('describe-images', { ok: false, stdout: '', stderr: 'An error occurred (ExpiredToken) when calling the DescribeImages operation: the security token included in the request is expired' });
    expect(await within(awsRead('ecr describe-images --repository-name ExpiredToken --profile dev-shop'))).not.toBe('waited');
    expect(aws!.fresh('dev')).toBe(true);
    expect(aws!.current.dev).not.toBe('expired');
    expect(payloads('aws.session')).toEqual([]);
    expect(payloads('elfoqsy.message')).toEqual([]);
  });

  it('asks him once to paste a fresh AWS session, in the language of his latest message', async () => {
    build(true);
    aws!.markExpired('dev');
    void aws!.whenFresh('dev'); // a call that needs the session waits, and the first wait asks him
    const said = () => payloads('elfoqsy.message').filter((m) => m.role === 'elfoqsy').map((m) => m.text);
    expect(said()).toEqual([expect.stringMatching(/^Your AWS session for dev \(profile .*\) has run out\. Please paste a fresh one into ~\/\.aws\/credentials; agents that need dev are waiting/)]);
    aws!.stop();
    language.current = 'vi';
    build(true);
    aws!.markExpired('dev');
    void aws!.whenFresh('dev');
    expect(said().at(-1)).toMatch(/^Phiên AWS của cậu cho dev \(profile .*\) đã hết hạn\. Cậu dán một phiên mới vào ~\/\.aws\/credentials giúp tôi; các agent cần dev đang chờ/);
  });

  it('says at once that an AWS session has run out, instead of waiting for alex to refresh it', async () => {
    build(true);
    aws!.markExpired('dev');
    const r = await Promise.race([kube(`${DEV} get deployments`), new Promise<'waited'>((done) => setTimeout(() => done('waited'), 1000))]);
    expect(r).not.toBe('waited');
    expect(r).toMatchObject({ ok: false });
    expect((r as { text: string }).text).toMatch(/AWS session for dev has run out/);
    expect(backends.calls.kubectl).toEqual([]);
    // Another environment is unaffected.
    expect(await kube('--context staging get deployments')).toMatchObject({ ok: true });
  });
});

describe('her reads in her own session', () => {
  let w: OrchestratorWorld;

  const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: arn:aws:eks:us-west-2:111111111111:cluster/dev-shop
clusters:
  - { name: dev, cluster: { server: https://dev.example } }
  - { name: staging, cluster: { server: https://staging.example } }
  - { name: integration, cluster: { server: https://integration.example } }
  - { name: production, cluster: { server: https://prod.example } }
users:
  - { name: dev-user, user: { exec: { command: aws } } }
  - { name: staging-user, user: { exec: { command: aws } } }
  - { name: integration-user, user: { exec: { command: aws } } }
  - { name: production-user, user: { exec: { command: aws } } }
contexts:
  - { name: arn:aws:eks:us-west-2:111111111111:cluster/dev-shop, context: { cluster: dev, user: dev-user } }
  - { name: arn:aws:eks:us-west-2:222222222222:cluster/staging-shop, context: { cluster: staging, user: staging-user } }
  - { name: arn:aws:eks:us-west-2:333333333333:cluster/integration-shop, context: { cluster: integration, user: integration-user } }
  - { name: production-cluster, context: { cluster: production, user: production-user } }
`;

  const events = (type?: AnyEnvelope['type']) => w.log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
  const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
  const session = (speaker: 'alex' | 'tester' = 'alex'): SessionContext => ({ conversationId: 'c1', speaker: () => speaker, addBlocks: () => undefined });

  beforeEach(() => {
    w = orchestratorWorld({ kubeconfig: KUBECONFIG });
  });

  afterEach(async () => {
    await w.close();
  });

  it('answers which branch is deployed on the three environments from three reads: no agent, nothing asked, in seconds', async () => {
    const wide = (name: string, tag: string) => ({ ok: true, stdout: `NAME   READY   IMAGES\n${name}   1/1   123.dkr.ecr.us-west-2.amazonaws.com/${name}:${tag}`, stderr: '' });
    w.backends.kubeAnswers.set('dev-shop get deployments', wide('shop-api', 'feature-SHOP-3492-9f3c2ab'));
    w.backends.kubeAnswers.set('staging-shop get deployments', wide('shop-api', 'master-4d1e0aa'));
    w.backends.kubeAnswers.set('integration-shop get deployments', wide('shop-api', 'release-2.21-77aa310'));
    const server = orchestratorServer({ log: w.log, state: () => w.live.get(), orchestrator: w.orchestrator, environments, session: session() });
    const options = { mcpServers: { orchestrator: server } };

    const started = Date.now();
    const answers = await Promise.all(['dev', 'staging', 'integration'].map((env) => runTool(options, 'kube', { args: ['--context', env, 'get', 'deployments', '-o', 'wide'] }, 'orchestrator')));
    expect(Date.now() - started).toBeLessThan(2000);

    expect(answers.map((a) => JSON.parse(a).output)).toEqual([
      expect.stringContaining('shop-api:feature-SHOP-3492-9f3c2ab'),
      expect.stringContaining('shop-api:master-4d1e0aa'),
      expect.stringContaining('shop-api:release-2.21-77aa310'),
    ]);
    // No agent started, no run, nothing for him to approve, no message to him.
    expect(payloads('run.created')).toEqual([]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(payloads('elfoqsy.message')).toEqual([]);
    expect(payloads('investigation.started')).toEqual([]);
    expect(w.sdk.sessions).toHaveLength(0);
    // Logged: her own calls, then the proxy's classification and result for each environment, as hers.
    expect(events('tool.called').filter((e) => e.source === 'elfoqsy').map((e) => (e.payload as { tool: string }).tool)).toEqual(['kube', 'kube', 'kube']);
    expect(payloads('action.classified').map((a) => [a.runId, a.proxy, a.tier, a.decision, a.environment]).sort()).toEqual([
      [ELFOQSY_RUN, 'kube', 0, 'run', 'dev'],
      [ELFOQSY_RUN, 'kube', 0, 'run', 'integration'],
      [ELFOQSY_RUN, 'kube', 0, 'run', 'staging'],
    ]);
    expect(payloads('action.finished')).toHaveLength(3);
    // One kubeconfig, shared by the three reads.
    expect(w.kubeconfigReads()).toBe(1);
    expect(new Set(w.backends.calls.kubectl.map((c) => c.kubeconfig)).size).toBe(1);
  });

  it('builds her own kubeconfig like a run’s: the configured contexts only, no current context, private, and built again after a while', async () => {
    await w.orchestrator.elfoqsyRead('kube', { args: ['--context', 'dev', 'get', 'pods'] });
    const path = join(w.world.root, 'runs', ELFOQSY_RUN, 'kubeconfig');
    expect(w.backends.calls.kubectl[0]!.kubeconfig).toBe(path);
    const file = parse(readFileSync(path, 'utf8')) as { contexts: Array<{ name: string }>; 'current-context': string };
    expect(file.contexts.map((c) => c.name).sort()).toEqual(
      [
        'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop',
        'arn:aws:eks:us-west-2:222222222222:cluster/staging-shop',
        'arn:aws:eks:us-west-2:333333333333:cluster/integration-shop',
      ].sort(),
    );
    expect(file['current-context']).toBe('');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await w.orchestrator.elfoqsyRead('kube', { args: ['--context', 'staging', 'get', 'pods'] });
    expect(w.kubeconfigReads()).toBe(1);
    w.clock.advance(KUBECONFIG_RENEW_MS + 1);
    await w.orchestrator.elfoqsyRead('kube', { args: ['--context', 'staging', 'get', 'pods'] });
    expect(w.kubeconfigReads()).toBe(2);
  });

  it('needs no kubeconfig for aws, gh or logs', async () => {
    expect(await w.orchestrator.elfoqsyRead('aws', { args: ['ecr', 'describe-repositories', '--profile', 'dev-shop'] })).toMatchObject({ ok: true });
    expect(await w.orchestrator.elfoqsyRead('gh', { args: ['pr', 'list', '--repo', SHOP_API] })).toMatchObject({ ok: true });
    expect(w.kubeconfigReads()).toBe(0);
  });

  it('serves her tools: output as it came, a refusal in its words, a missing name with the way to find it', async () => {
    const tools = orchestratorHandlers({ log: w.log, state: () => w.live.get(), orchestrator: w.orchestrator, environments, session: session() });
    w.backends.kubeAnswers.set('get deployments', { ok: true, stdout: 'shop-api', stderr: '' });
    expect(await tools.kube({ args: ['--context', 'dev', 'get', 'deployments'] })).toEqual({ proxy: 'kube', output: 'shop-api' });

    const refused = (await tools.kube({ args: ['--context', 'dev', 'delete', 'pod', 'x'] })) as { error: string; message: string };
    expect(refused.error).toBe('refused');
    expect(refused.message).toMatch(/alex's/);

    w.backends.kubeAnswers.set('get deployment shop-brige', { ok: false, stdout: '', stderr: 'Error from server (NotFound): deployments.apps "shop-brige" not found' });
    const missing = (await tools.kube({ args: ['--context', 'dev', 'get', 'deployment', 'shop-brige'] })) as { error: string; message: string };
    expect(missing.error).toBe('failed');
    expect(missing.message).toContain('NotFound');
    expect(missing.message).toMatch(/Do not guess names: list first/);

    expect(await orchestratorHandlers({ log: w.log, state: () => w.live.get() }).kube({ args: ['--context', 'dev', 'get', 'pods'] })).toMatchObject({ error: 'not_available' });
  });

  it('does not follow or watch: a read that never ends would hold her turn, so it is refused before anything runs', async () => {
    const tools = orchestratorHandlers({ log: w.log, state: () => w.live.get(), orchestrator: w.orchestrator, environments, session: session() });
    const endless: Array<[Promise<unknown>, RegExp]> = [
      [tools.kube({ args: ['--context', 'dev', 'logs', '-f', 'deployment/shop-api'] }), /Following logs never ends/],
      [tools.kube({ args: ['--context', 'dev', 'logs', 'deployment/shop-api', '--follow'] }), /Following logs never ends/],
      [tools.kube({ args: ['--context', 'dev', 'get', 'pods', '-w'] }), /Watching never ends/],
      [tools.kube({ args: ['--context', 'dev', 'get', 'pods', '--watch-only'] }), /Watching never ends/],
      // aws logs tail is not a free read at all (tier 2), so its tier is what refuses it; the others are refused as endless.
      [tools.aws({ args: ['logs', 'tail', '/aws/x', '--follow', '--profile', 'dev-shop'] }), /never end|tier 2/],
      [tools.aws({ args: ['ec2', 'wait', 'instance-running', '--profile', 'dev-shop'] }), /never end/],
      [tools.gh({ args: ['run', 'watch', '123', '--repo', SHOP_API] }), /Watching never ends/],
      [tools.gh({ args: ['pr', 'checks', '12', '--watch', '--repo', SHOP_API] }), /Watching never ends/],
    ];
    for (const [call, why] of endless) expect(await call).toMatchObject({ error: 'refused', message: expect.stringMatching(why) });
    // Each refusal is logged as an action, as an agent's is: its kind, its tier (they are reads), the environment, why.
    const logged = payloads('action.classified');
    expect(logged).toHaveLength(endless.length);
    for (const a of logged) expect(a).toMatchObject({ runId: ELFOQSY_RUN, decision: 'refuse', reason: expect.any(String) });
    expect(logged.map((a) => a.kind).sort()).toEqual(['aws.ec2.wait', 'aws.logs.tail', 'gh.pr.checks', 'gh.run.watch', 'kube.get', 'kube.get', 'kube.logs', 'kube.logs']);
    const kubes = logged.filter((a) => a.proxy === 'kube');
    expect(kubes).toHaveLength(4);
    for (const a of kubes) expect(a).toMatchObject({ tier: 0, environment: 'dev' });
    expect(logged.filter((a) => /never end/.test(a.reason))).toHaveLength(7);
    expect(payloads('action.finished')).toEqual([]);
    expect(payloads('approval.requested')).toEqual([]);
    expect(w.backends.calls.kubectl).toEqual([]);
    expect(w.backends.calls.aws).toEqual([]);
    expect(w.backends.calls.gh).toEqual([]);
    // Reading once is fine, and so is following turned off.
    expect(await tools.kube({ args: ['--context', 'dev', 'logs', 'deployment/shop-api', '--tail=200'] })).toMatchObject({ proxy: 'kube' });
    expect(await tools.kube({ args: ['--context', 'dev', 'logs', 'deployment/shop-api', '--follow=false'] })).toMatchObject({ proxy: 'kube' });
    expect(await tools.gh({ args: ['run', 'view', '123', '--repo', SHOP_API] })).toMatchObject({ proxy: 'gh' });
  });

  it('does not hold her turn for a read that is slow: it is not waited for after its time', async () => {
    const slow = orchestratorWorld({ kubeconfig: KUBECONFIG, prepare: (b) => (b.kubectl = () => new Promise(() => undefined)) });
    try {
      const tools = orchestratorHandlers({ log: slow.log, state: () => slow.live.get(), orchestrator: slow.orchestrator, environments, session: session(), readTimeoutMs: 50 });
      const started = Date.now();
      const r = (await tools.kube({ args: ['--context', 'dev', 'get', 'pods'] })) as { error: string; message: string };
      expect(Date.now() - started).toBeLessThan(1500);
      expect(r).toMatchObject({ error: 'failed', message: expect.stringMatching(/took longer than 0 seconds|took longer than \d+ seconds, so it is not waited for/) });
    } finally {
      await slow.close();
    }
  });

  it('keeps her kubeconfig when his cannot be read just as it is renewed, instead of replacing it with an empty one', async () => {
    let busy = false;
    const k = new Kubeconfigs(join(w.world.root, 'k2'), async () => (busy ? Promise.reject(new Error('being rewritten')) : KUBECONFIG), runContexts(environments));
    const first = await k.create('elfoqsy', { renew: true });
    expect(first.contexts).toHaveLength(3);
    busy = true;
    const kept = await k.create('elfoqsy', { renew: true });
    expect(kept.contexts).toHaveLength(3);
    expect((parse(readFileSync(kept.path, 'utf8')) as { contexts: unknown[] }).contexts).toHaveLength(3);
    // A run's own is built from what there is, as before: none.
    expect((await k.create('r1')).contexts).toEqual([]);
  });

  it('lets the tester ask for a read, since a read changes nothing', async () => {
    const tools = orchestratorHandlers({ log: w.log, state: () => w.live.get(), orchestrator: w.orchestrator, environments, session: session('tester') });
    expect(await tools.kube({ args: ['--context', 'dev', 'get', 'pods'] })).toMatchObject({ proxy: 'kube' });
  });
});

describe('reads that never end', () => {
  const endless = (proxy: 'kube' | 'aws' | 'gh', args: string): string | undefined => neverEnds(proxy, args.split(' '));

  it.each([
    ['kube', '--context dev logs -f deployment/x'],
    ['kube', '--context dev logs -fc app deployment/x'],
    ['kube', '--context dev logs --follow=true deployment/x'],
    ['kube', '--context dev get pods -w'],
    ['kube', '--context dev get pods -wA'],
    ['kube', '--context dev get pods --watch-only'],
    ['kube', "--context dev get --raw /api/v1/namespaces/x/pods?watch=true"],
    ['kube', '--context dev rollout status deployment/x'],
    ['kube', '--context dev wait --for=condition=ready pod/x --timeout=-1s'],
    ['kube', '--context dev wait --for=condition=ready pod/x --timeout=2h'],
    ['aws', 'logs tail /aws/x --follow --profile dev-shop'],
    ['aws', 'ec2 wait instance-running --profile dev-shop'],
    ['gh', 'run watch 123 --repo O/R'],
    ['gh', 'run --repo O/R watch 123'],
    ['gh', 'pr checks 12 --watch=true --repo O/R'],
  ] as const)('refuses %s %s', (proxy, args) => {
    expect(endless(proxy, args)).toEqual(expect.any(String));
  });

  it.each([
    ['kube', '--context dev logs deployment/x --tail=200'],
    ['kube', '--context dev logs --follow=false deployment/x'],
    ['kube', '--context dev logs -c app --previous deployment/x'],
    ['kube', '--context dev get pods -owide'],
    ['kube', '--context dev get pods -o wide -A'],
    ['kube', '--context dev get pods -o jsonpath={.items[*].metadata.name}'],
    ['kube', '--context dev get pods -l app=web'],
    ['kube', '--context dev rollout status deployment/x --watch=false'],
    ['kube', '--context dev wait --for=condition=ready pod/x --timeout=30s'],
    ['kube', '--context dev wait --for=condition=ready pod/x'],
    ['kube', '--context dev get --raw /api/v1/namespaces/x/pods?limit=5'],
    ['aws', 'logs tail /aws/x --since 10m --profile dev-shop'],
    ['gh', 'run view 123 --repo O/R'],
    ['gh', 'run list -L5 --repo O/R'],
  ] as const)('allows %s %s', (proxy, args) => {
    expect(endless(proxy, args)).toBeUndefined();
  });
});

describe('her tools and her prompt', () => {
  it('allow the four reads and no shell', () => {
    for (const t of ['kube', 'aws', 'gh', 'logs']) expect(ALLOWED_TOOLS).toContain(`mcp__orchestrator__${t}`);
    expect(ALLOWED_TOOLS).not.toContain('mcp__orchestrator__lookup_logs');
  });

  it('describe the environments by name and say to discover before acting and to answer herself', () => {
    const kube = readDescription('kube', environments);
    expect(kube).toContain('dev, staging, integration');
    expect(kube).toContain('--context');
    for (const name of ['kube', 'aws', 'gh', 'logs'] as const) {
      const text = readDescription(name, environments);
      expect(text).toMatch(/list first/);
      expect(text).toMatch(/never guess a name/);
      expect(text).toMatch(/without starting an agent or an investigator/);
      expect(text).toMatch(/Reads only/);
      expect(DESCRIPTIONS[name]).toMatch(/never guess a name/);
    }
    expect(readDescription('aws', environments)).toContain('dev-shop (dev)');
    expect(readDescription('logs', environments)).toContain('dev, staging, integration');
  });

  it('put the rule in her prompt: discover first, never guess names, answer a read-answerable question herself', () => {
    const prompt = readFileSync(join(REPO_ROOT, 'prompts', 'elfoqsy-system-prompt.md'), 'utf8');
    expect(prompt).toMatch(/kube, aws, gh and logs/);
    expect(prompt).toMatch(/list the deployments[^.]*before/i);
    expect(prompt).toMatch(/never guess a name/i);
    expect(prompt).toMatch(/without starting an agent, a task agent or an investigator/);
  });

  it('show each read in her thinking indicator as a plain line', () => {
    const s = new LiveState(new EventLog(':memory:'));
    const line = (name: 'kube' | 'aws' | 'gh' | 'logs', args: Record<string, unknown>) => activityLine(name, args, s.get());
    expect(line('kube', { args: ['--context', DEV_ARN, '-n', 'x', 'get', 'deployments'] })).toEqual({ tool: 'kube', text: 'List deployments on dev-shop' });
    expect(line('kube', { args: ['--context', 'staging', 'describe', 'deployment', 'shop-api'] })).toEqual({ tool: 'kube', text: 'Describe deployment shop-api on staging' });
    expect(line('kube', { args: ['--context', 'dev', 'logs', 'deployment/shop-api'] })).toEqual({ tool: 'kube', text: 'Read the logs of deployment/shop-api on dev' });
    expect(line('aws', { args: ['ecr', 'describe-images', '--profile', 'dev-shop'] })).toEqual({ tool: 'aws', text: 'Ask AWS: ecr describe-images (dev-shop)' });
    expect(line('gh', { args: ['pr', 'view', '12', '--repo', SHOP_API] })).toEqual({ tool: 'github', text: 'Ask GitHub: pr view 12 (shop-api)' });
    expect(line('logs', { query: 'limit 5', environment: 'dev' })).toEqual({ tool: 'logs', text: 'Read the dev logs "limit 5"' });
    s.close();
  });
});
