// The pieces of milestone 15 and v1.2.1 on their own: the docker and shop proxies, the workflow's rules, the writes
// other people read, the skill's version and facts, the per-ticket analytics and Coralogix's endpoint. Nothing runs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, ElfEvent } from '@elfoqsy/contracts';
import { baselinePerTicket, periodStats, ticketStats } from '@elfoqsy/state';
import { externalWrite, hasEvidence } from '../src/agents/externalWrites';
import { endStateFor } from '../src/agents/run';
import { isTestPath, quotedFrom, reviewCriteria, reviewFindings, TicketWorkflow, type VerdictReport } from '../src/agents/workflow';
import { botRounds } from '../src/github/gh';
import { textToAdf } from '../src/jira/atlassian';
import { reviewPrompt } from '../src/elfoqsy/review';
import { coralogixEndpoint } from '../src/permissions/backends';
import { classifyDocker, DockerProxy, ecrOf, type DockerBackend } from '../src/permissions/docker';
import { ShopProxy, withoutEnvironment } from '../src/permissions/shop';
import type { ExecResult, RunRef } from '../src/permissions/types';
import { changedSections, environmentFacts, sectionHashes, skillForRun, skillHash, snapshotSkill } from '../src/skill/teamSkill';
import { configured, environments } from './helpers/proxyFakes';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elfoqsy-m15-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (): RunRef => ({ runId: 'run-7', ticket: 'SHOP-3546', agentNumber: 7, branch: 'feature/SHOP-3546', targets: [], kubeconfig: join(root, 'private', 'kubeconfig'), root: join(root, 'run') });
const tier = (c: { tier: number; invalid?: boolean }) => (c.invalid ? 'invalid' : c.tier);

describe('docker: on his Docker, but never reaching the host', () => {
  const d = (args: string) => classifyDocker(args.split(' '), environments, run());

  it.each([
    ['ps -a', 0],
    ['images', 0],
    ['logs elfoqsy-test', 0],
    ['image ls', 0],
    ['build -t it:test .', 0],
    ['build -t it:test -f docker/Dockerfile docker', 0],
    ['pull node:22', 0],
    ['run --rm node:22 npm test', 0],
    ['run --rm -v ./src:/w/src -w /w node:22 npm test', 0],
    ['run --rm -v cache:/root/.npm node:22 npm ci', 0],
    ['tag it:test it:latest', 0],
    ['run -t --rm node:22 npm test', 0],
    ['rm -f mine', 0],
    ['rmi it:test', 2],
    ['push 111111111111.dkr.ecr.us-west-2.amazonaws.com/integration-test-instance:x', 2],
    ['push acme/shop:latest', 3],
    ['run --privileged alpine sh', 3],
    ['run -v /var/run/docker.sock:/var/run/docker.sock alpine sh', 3],
    ['run -v /:/host alpine sh', 3],
    ['run -v ~/.ssh:/x alpine cat /x/id_ed25519', 3],
    ['run --mount type=bind,source=/etc,target=/etc alpine sh', 3],
    ['run --network host alpine sh', 3],
    ['run --pid=host alpine sh', 3],
    ['run --cap-add SYS_ADMIN alpine sh', 3],
    ['run --device /dev/sda alpine sh', 3],
    ['run --env-file /home/alex/.env alpine env', 3],
    ['build --secret id=npm,src=/home/alex/.npmrc .', 3],
    ['build /etc', 3],
    ['cp elfoqsy-test:/etc/passwd /home/alex/passwd', 3],
    ['-H tcp://10.0.0.1:2375 ps', 3],
    ['--context prod ps', 3],
    ['login 111111111111.dkr.ecr.us-west-2.amazonaws.com', 3],
    ['compose up', 3],
    ['system prune -af', 3],
    ['volume prune', 3],
    ['swarm init', 3],
    ['frobnicate', 2],
  ])('docker %s → %s', (args, expected) => {
    expect(tier(d(args))).toBe(expected);
  });

  it('knows the team ECR by account, so a pull from it logs in first with that environment profile', () => {
    expect(ecrOf(environments, '111111111111.dkr.ecr.us-west-2.amazonaws.com/shop-worker:2.22')).toEqual({ registry: '111111111111.dkr.ecr.us-west-2.amazonaws.com', profile: 'dev-shop', region: 'us-west-2', environment: 'dev' });
    expect(ecrOf(environments, '999999999999.dkr.ecr.us-west-2.amazonaws.com/x')).toBeNull();
    expect(d('pull 111111111111.dkr.ecr.us-west-2.amazonaws.com/shop-worker:2.22')).toMatchObject({ tier: 0, needsAws: true, environment: 'dev' });
  });

  it("logs in to ECR into the run's own Docker config, labels the containers it starts, and touches only its own", async () => {
    const calls: Array<[string, string[], string]> = [];
    const backend: DockerBackend = {
      docker: async (args, o) => {
        calls.push(['docker', args, o.dockerConfig]);
        if (args[0] === 'inspect') return { ok: true, stdout: args.at(-1) === 'mine' ? 'run-7\n' : 'run-1\n', stderr: '' };
        return { ok: true, stdout: 'ok', stderr: '' };
      },
      ecrLogin: async (registry, profile, region, dockerConfig) => (calls.push(['login', [registry, profile, region], dockerConfig]), { ok: true, stdout: '', stderr: '' }),
    };
    const proxy = new DockerProxy(environments, backend);
    const r = run();
    const image = '111111111111.dkr.ecr.us-west-2.amazonaws.com/shop-worker:2.22';
    const c = await proxy.classify({ args: ['run', '--rm', image, 'npm', 'test'] }, r);
    await proxy.execute({ args: ['run', '--rm', image, 'npm', 'test'] }, c, r);
    const dockerConfig = join(root, 'private', 'docker');
    expect(calls).toEqual([
      ['login', ['111111111111.dkr.ecr.us-west-2.amazonaws.com', 'dev-shop', 'us-west-2'], dockerConfig],
      ['docker', ['run', '--label', 'elfoqsy.run=run-7', '--rm', image, 'npm', 'test'], dockerConfig],
    ]);
    expect(await proxy.classify({ args: ['stop', 'mine'] }, r)).toMatchObject({ tier: 0 });
    expect(await proxy.classify({ args: ['rm', '-f', 'theirs'] }, r)).toMatchObject({ tier: 3, reason: "theirs is not a container this run started; it is alex's." });
  });
});

describe('shop.sh build-integration-test: the harness only, from a private copy, with the run kubeconfig and a fixed ENVIRONMENT', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/alex' };
  let source: string;
  beforeEach(() => {
    source = join(root, 'code', 'shop-local-deploy');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, 'shop.sh'), '#!/bin/bash\necho run\n');
    writeFileSync(join(source, '.env'), 'AWS_PROFILE_DEV_SHOP=dev-shop\nENVIRONMENT=staging\nexport ENVIRONMENT=prod\nDEV_NAMESPACE=shop-dev\n');
    writeFileSync(join(source, '.git', 'config'), '[core]\n');
  });
  const withClones = (): RunRef => ({ ...run(), clones: [{ repo: 'acme/shop-worker', path: join(root, 'run', 'shop-worker') }] });

  it('is done at once on dev, asked on integration and staging, refused on prod, and needs the shop-worker clone', async () => {
    const proxy = new ShopProxy(environments, source, { script: async () => ({ ok: true, stdout: '', stderr: '' }) }, async () => ({ ok: true, stdout: '', stderr: '' }), env);
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'dev' }, withClones())).toMatchObject({ tier: 1, environment: 'dev', needsAws: true });
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'integration' }, withClones())).toMatchObject({ tier: 2, reason: expect.stringContaining('QA and others share it') });
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'staging' }, withClones())).toMatchObject({ tier: 2 });
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'prod' }, withClones())).toMatchObject({ tier: 3 });
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'local' }, withClones())).toMatchObject({ invalid: true });
    expect(await proxy.classify({ command: 'build-integration-test', environment: 'dev' }, run())).toMatchObject({ invalid: true, reason: expect.stringContaining('no clone of shop-worker') });
    expect(await new ShopProxy(environments, undefined, { script: async () => ({ ok: true, stdout: '', stderr: '' }) }, async () => ({ ok: true, stdout: '', stderr: '' }), env).classify({ command: 'build-integration-test', environment: 'dev' }, withClones())).toMatchObject({ invalid: true });
  });

  it('records the harness image first, then runs the copy with the run kubeconfig, ENVIRONMENT fixed and sudo stubbed', async () => {
    const scripts: Array<{ cwd: string; args: string[]; env: Record<string, string> }> = [];
    const kubectl: Array<string[]> = [];
    const proxy = new ShopProxy(
      environments,
      source,
      { script: async (cwd, args, e): Promise<ExecResult> => (scripts.push({ cwd, args, env: e }), { ok: true, stdout: 'pushed', stderr: '' }) },
      async (args) => (kubectl.push(args), { ok: true, stdout: 'shop-integration-test=111111111111.dkr.ecr.us-west-2.amazonaws.com/integration-test-instance:old\n', stderr: '' }),
      env,
    );
    const r = withClones();
    const c = await proxy.classify({ command: 'build-integration-test', environment: 'dev' }, r);
    const recorded = await proxy.record({ command: 'build-integration-test', environment: 'dev' }, c, r);
    expect(recorded).toMatchObject({
      target: 'deployment/shop-integration-test on dev',
      before: 'container shop-integration-test: image 111111111111.dkr.ecr.us-west-2.amazonaws.com/integration-test-instance:old',
      undo: { proxy: 'kube', request: { args: ['--context', 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop', '-n', 'shop-dev', 'set', 'image', 'deployment/shop-integration-test', 'shop-integration-test=111111111111.dkr.ecr.us-west-2.amazonaws.com/integration-test-instance:old'] } },
    });
    expect(await proxy.execute({ command: 'build-integration-test', environment: 'dev' }, c, r)).toMatchObject({ ok: true, done: expect.stringContaining('rebuilt the test harness (shop-integration-test) on dev') });
    const copy = join(root, 'private', 'shop-local-deploy');
    expect(scripts).toEqual([
      {
        cwd: copy,
        args: ['build-integration-test', 'dev'],
        env: expect.objectContaining({
          KUBECONFIG: r.kubeconfig,
          DOCKER_CONFIG: join(root, 'private', 'docker'),
          ENVIRONMENT: 'dev',
          SHOP_WORKER_DIR: join(root, 'run', 'shop-worker'),
          PATH: `${join(root, 'private', 'bin')}:/usr/bin:/bin`,
        }),
      },
    ]);
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe('AWS_PROFILE_DEV_SHOP=dev-shop\nDEV_NAMESPACE=shop-dev\n');
    expect(readFileSync(join(source, '.env'), 'utf8')).toContain('ENVIRONMENT=staging'); // his own is untouched
    expect(existsSync(join(copy, '.git'))).toBe(false);
    expect(readFileSync(join(root, 'private', 'bin', 'sudo'), 'utf8')).toContain('exit 1');
    expect(statSync(join(root, 'private', 'bin', 'sudo')).mode & 0o111).not.toBe(0);
    expect(withoutEnvironment('A=1\n  export ENVIRONMENT=x\nENVIRONMENTS=y\n')).toBe('A=1\nENVIRONMENTS=y\n');
  });
});

describe('the workflow on its own', () => {
  const v = (over: Partial<VerdictReport> = {}): VerdictReport => ({
    verdict: 'VALID',
    reproduced: true,
    summary: 's',
    symptom: 'Basic Basic dXNlcjpwYXNz in the header',
    sibling: 'The Bearer path sends one scheme.',
    findings: [{ text: 't', sources: [{ kind: 'code', ref: 'a/b.ts:1' }] }],
    chain: [
      { ref: 'a/entry.ts:3', role: 'entry' },
      { ref: 'a/b.ts:1', role: 'fault' },
    ],
    siblingAt: { kind: 'code', ref: 'a/bearer.ts:9' },
    ...over,
  });
  /** A workflow whose agent has reported its understanding, which the verdict comes after. */
  const understood = (...args: ConstructorParameters<typeof TicketWorkflow>): TicketWorkflow => {
    const w = new TicketWorkflow(...args);
    w.understood = true;
    return w;
  };
  const words = 'The webhook gets "Basic Basic dXNlcjpwYXNz in the header" since 2.21.';

  it('reads tests by their usual names and quotes by the words', () => {
    expect(['test/a.ts', 'src/__tests__/a.ts', 'src/a.test.ts', 'src/a.spec.tsx', 'tools/integration_test/data/x.json', 'pkg/a_test.go', 'tests/test_a.py'].every(isTestPath)).toBe(true);
    expect(['src/a.ts', 'src/testing.ts', 'latest/a.ts'].some(isTestPath)).toBe(false);
    expect(quotedFrom('basic basic DXNLCJPWYXNZ in the header.', words)).toBe(true); // case and the final full stop are forgiven
    expect(quotedFrom('Basic Basic dXNlcjpwYXNz in the header.', words)).toBe(true);
    expect(quotedFrom('Basic', words)).toBe(false); // too short to be the symptom
  });

  it("uses the skill's labels: each kind of ticket its own, and the three that stop the run", () => {
    const bug = understood('bug', 'normal');
    expect(bug.verdictProblem(v({ verdict: 'NEW_BEHAVIOR', example: { input: 'a', output: 'b' } }), words)).toBe(
      "A bug's verdict is VALID when it needs a change, or ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID or INSUFFICIENT_EVIDENCE/NOT_REPRODUCED.",
    );
    expect(understood('story', 'normal').verdictProblem(v(), words)).toContain("A story or task's verdict is NEW_BEHAVIOR");
    expect(understood('story', 'normal').verdictProblem(v({ verdict: 'NEW_BEHAVIOR' }), words)).toContain('NEW_BEHAVIOR needs the expected behaviour as one example');
    for (const stop of ['ALREADY_FIXED', 'EXPECTED_BEHAVIOR/INVALID', 'INSUFFICIENT_EVIDENCE/NOT_REPRODUCED'] as const) {
      expect(bug.verdictProblem(v({ verdict: stop }), words)).toContain('Say what you propose to post on the ticket');
      expect(bug.verdictProblem(v({ verdict: stop, ticketComment: 'c' }), words)).toBeNull();
    }
    const rem = understood('remediation', 'remediation');
    expect(rem.verdictProblem(v(), words)).toContain("A remediation's verdict is VALID_FINDING");
    expect(rem.verdictProblem(v({ verdict: 'VALID_FINDING', reproduced: false }), words)).toContain("only once it reproduces from the scanner's inputs");
    expect(rem.verdictProblem(v({ verdict: 'VALID_FINDING' }), words)).toBeNull();
  });

  it('wants the understanding before the verdict, and for a bug the path to the fault and where the working case is, as path:line (N1)', () => {
    expect(new TicketWorkflow('bug', 'normal').verdictProblem(v(), words)).toContain('Report your understanding of the ticket first (report_understanding)');
    const bug = understood('bug', 'normal');
    expect(bug.verdictProblem(v(), words)).toBeNull();
    expect(bug.verdictProblem(v({ chain: undefined }), words)).toContain('Give the path to the fault (chain)');
    expect(bug.verdictProblem(v({ chain: [{ ref: 'a/entry.ts:3', role: 'entry' }] }), words)).toContain('Give the path to the fault (chain)');
    expect(bug.verdictProblem(v({ chain: [{ ref: 'a/b.ts', role: 'fault' }] }), words)).toContain('chain: a code source is a file and line');
    expect(bug.verdictProblem(v({ siblingAt: undefined }), words)).toContain('Say where the working case you compared with is (siblingAt');
    expect(bug.verdictProblem(v({ siblingAt: { kind: 'code', ref: 'a/bearer.ts' } }), words)).toContain('siblingAt: a code source is a file and line');
    // "none" needs no working case to point to.
    expect(bug.verdictProblem(v({ sibling: 'none: the auth path exists once, in auth.ts, so there is nothing to compare with.', siblingAt: undefined }), words)).toBeNull();
    expect(bug.verdictProblem(v({ findings: [{ text: 't', sources: [{ kind: 'code', ref: 'a/b.ts' }] }] }), words)).toContain('findings: a code source is a file and line');
    // A story and a stopping verdict carry no chain.
    expect(understood('story', 'normal').verdictProblem(v({ verdict: 'NEW_BEHAVIOR', example: { input: 'a', output: 'b' }, chain: undefined, siblingAt: undefined }), words)).toBeNull();
  });

  it('allows edits as the verdict says, per kind and mode', () => {
    const w = new TicketWorkflow('bug', 'normal');
    expect(w.repoEdit('src/a.ts')).toContain('Report your verdict first');
    w.setVerdict(v({ reproduced: false }));
    expect([w.repoEdit('test/a.test.ts'), w.repoEdit('src/a.ts')?.slice(0, 26)]).toEqual([null, 'VALID, not reproduced yet:']);
    w.setVerdict(v());
    expect(w.repoEdit('src/a.ts')).toContain('declare every input class');
    w.inputs = ['a'];
    expect(w.repoEdit('src/a.ts')).toBeNull();
    w.setVerdict(v({ verdict: 'EXPECTED_BEHAVIOR/INVALID', ticketComment: 'x' }));
    expect([w.repoEdit('test/a.test.ts'), w.stopping]).toEqual(['Your verdict is EXPECTED_BEHAVIOR/INVALID: no code changes. The run stops when this turn ends.', 'Its verdict: EXPECTED_BEHAVIOR/INVALID. s']);
    const ro = new TicketWorkflow('bug', 'read_only');
    ro.setVerdict(v());
    ro.inputs = ['a'];
    expect([ro.repoEdit('test/a.test.ts'), ro.ticketFolderEdit(), ro.pushProblem()].every((x) => x?.startsWith('Read-only mode'))).toBe(true);
  });

  it('an ambiguous VALID, or NEW_BEHAVIOR, goes on with its example; nobody is asked to confirm it (v1.3)', () => {
    const w = new TicketWorkflow('bug', 'normal');
    w.setVerdict(v({ example: { input: 'a', output: 'b' } }));
    expect(w.repoEdit('test/a.test.ts')).toBeNull();
    expect(w.stopping).toBeUndefined();
    const story = new TicketWorkflow('story', 'normal');
    story.setVerdict(v({ verdict: 'NEW_BEHAVIOR', reproduced: false, example: { input: 'a', output: 'b' } }));
    expect(story.repoEdit('test/a.test.ts')).toBeNull();
  });

  it('holds the first push for a review that says what it found; a contract change or cache bypass it found goes on as a flagged decision (v1.3)', () => {
    const w = new TicketWorkflow('bug', 'normal');
    expect(w.pushProblem()).toContain('It ends with a CONTRACT: line and a CACHE_BYPASS: line');
    expect(w.reviewDone('No Blocker or Major.\nRESULT: success')).toBe(false);
    expect(w.pushProblem()).toContain('Before the first push');
    expect(reviewFindings('CONTRACT: None.\nCACHE_BYPASS: no bypass\nRESULT: success')).toEqual({ contract: null, cacheBypass: null });
    expect(w.reviewDone('Major: x\nCONTRACT: returns 422 instead of 400 for a bad error_code (src/map.ts:40)\nCACHE_BYPASS: none\nRESULT: success')).toBe(true);
    expect(w.pushProblem()).toBeNull();
    expect(w.reviewFlags()).toEqual([{ flag: 'contract', text: 'The review found a visible contract change: returns 422 instead of 400 for a bad error_code (src/map.ts:40)' }]);
  });

  describe('what the review says of each acceptance criterion, and what a NOT MET holds (v1.5, 19 October)', () => {
    const lines = [
      'CONTRACT: none',
      'CACHE_BYPASS: none',
      'CRITERION 1: MET | error_code is at the top of an error result | map.ts:44',
      'CRITERION 2: NOT MET | a 429 keeps its details | map.ts:51 drops them',
      'CRITERION 3: CANNOT TELL | a real provider answers | only a run on dev settles it',
      'RESULT: success',
    ].join('\n');

    it('reads the CRITERION lines: the number, MET, NOT MET or CANNOT TELL, the criterion and why', () => {
      expect(reviewCriteria(lines)).toEqual([
        { n: 1, status: 'met', text: 'error_code is at the top of an error result', why: 'map.ts:44' },
        { n: 2, status: 'not_met', text: 'a 429 keeps its details', why: 'map.ts:51 drops them' },
        { n: 3, status: 'cannot_tell', text: 'a real provider answers', why: 'only a run on dev settles it' },
      ]);
    });

    it('reads what a model does to a line: a bullet, bold, another case, an underscore, a missing why, the same number twice', () => {
      expect(reviewCriteria('- **CRITERION 1: MET** | a | b')).toEqual([{ n: 1, status: 'met', text: 'a', why: 'b' }]);
      expect(reviewCriteria('* criterion 2: not met | a | b')).toEqual([{ n: 2, status: 'not_met', text: 'a', why: 'b' }]);
      expect(reviewCriteria('CRITERION 3: CANNOT_TELL | a')).toEqual([{ n: 3, status: 'cannot_tell', text: 'a', why: '' }]);
      expect(reviewCriteria('CRITERION #4: MET - a | b')).toEqual([{ n: 4, status: 'met', text: 'a', why: 'b' }]);
      expect(reviewCriteria('CRITERION 1: MET | first | x\nCRITERION 1: NOT MET | first | y')).toEqual([{ n: 1, status: 'not_met', text: 'first', why: 'y' }]);
      expect(reviewCriteria('CRITERION 2: MET | b | y\nCRITERION 1: MET | a | x')?.map((c) => c.n)).toEqual([1, 2]);
    });

    it('says none when the ticket states none, and undefined when the review said neither', () => {
      expect(reviewCriteria('CONTRACT: none\nCACHE_BYPASS: none\nCRITERIA: none stated\nRESULT: success')).toEqual([]);
      expect(reviewCriteria('CONTRACT: none\nCACHE_BYPASS: none\nRESULT: success')).toBeUndefined();
      // A status it cannot read is not a criterion.
      expect(reviewCriteria('CRITERION 1: MAYBE | a | b')).toBeUndefined();
      expect(reviewCriteria('The criterion 2 is not met')).toBeUndefined();
    });

    it('counts a review as done only with its criteria when the run has its pack, never holds the push for a NOT MET, and keeps what it said', () => {
      const without = new TicketWorkflow('bug', 'normal');
      expect(without.reviewDone('CONTRACT: none\nCACHE_BYPASS: none\nRESULT: success')).toBe(true); // no pack: as before
      const w = new TicketWorkflow('bug', 'normal', '/run/.elfoqsy/review');
      expect(w.pushProblem()).toContain('a CRITERION line for each acceptance criterion (MET, NOT MET or CANNOT TELL)');
      expect(w.reviewDone('CONTRACT: none\nCACHE_BYPASS: none\nRESULT: success')).toBe(false);
      expect(w.pushProblem()).toContain('Before the first push');
      expect(w.reviewDone(lines)).toBe(true);
      expect(w.pushProblem()).toBeNull(); // a criterion NOT MET is not a push gate
      expect(w.criteria?.map((c) => c.status)).toEqual(['met', 'not_met', 'cannot_tell']);
      expect(w.unmetOpen().map((c) => c.n)).toEqual([2]);
    });

    it('does not accept succeeded while a criterion is NOT MET and unexplained; a reason by its number lets it through; failed and blocked stand', () => {
      const w = new TicketWorkflow('bug', 'normal', '/run/.elfoqsy/review');
      expect(w.reportProblem('succeeded')).toBeNull(); // before any review: nothing is NOT MET
      w.reviewDone(lines);
      const refused = w.reportProblem('succeeded');
      expect(refused).toContain('the review found an acceptance criterion NOT MET: 2 (a 429 keeps its details: map.ts:51 drops them).');
      expect(refused).toContain('A run is not reported succeeded while one is NOT MET.');
      expect(refused).toContain('Meet it and run the review again, or say in unmet why it cannot be met here (its number and why).');
      expect(w.unmetOpen().map((c) => c.n)).toEqual([2]);
      // A reason for a criterion the review did not call NOT MET is a mistake, said so, and nothing of it is kept.
      expect(w.reportProblem('succeeded', [{ n: 1, why: 'It is MET, but I say so.' }])).toContain('unmet names 1, which the review did not call NOT MET (it called 2).');
      expect(w.unmetOpen().map((c) => c.n)).toEqual([2]);
      // Its reason, by number: accepted, and kept for the next report.
      expect(w.reportProblem('succeeded', [{ n: 2, why: 'The provider rate limit lives in a service this run cannot reach.' }])).toBeNull();
      expect(w.unmetOpen()).toEqual([]);
      expect(w.reportProblem('succeeded')).toBeNull();
      // A failure or a block stands whatever is NOT MET, and its reasons are kept all the same.
      const other = new TicketWorkflow('bug', 'normal', '/run/.elfoqsy/review');
      other.reviewDone(lines);
      expect(other.reportProblem('blocked')).toBeNull();
      expect(other.reportProblem('failed', [{ n: 2, why: 'It cannot be met without the provider sandbox.' }])).toBeNull();
      expect(other.unmetOpen()).toEqual([]);
    });

    it('takes a new review as a new judgment: the reasons given for the last one are cleared, and the holds start again', () => {
      const w = new TicketWorkflow('bug', 'normal', '/run/.elfoqsy/review');
      w.reviewDone(lines);
      w.reportProblem('succeeded', [{ n: 2, why: 'The provider rate limit lives in a service this run cannot reach.' }]);
      w.holds = 2;
      expect(w.reviewDone(lines)).toBe(true);
      expect(w.unmetOpen().map((c) => c.n)).toEqual([2]);
      expect(w.holds).toBe(0);
      // And a review that finds them all met leaves nothing open.
      expect(w.reviewDone('CONTRACT: none\nCACHE_BYPASS: none\nCRITERION 1: MET | a | x\nCRITERION 2: MET | b | y\nRESULT: success')).toBe(true);
      expect(w.unmetOpen()).toEqual([]);
      expect(w.reportProblem('succeeded')).toBeNull();
    });

    it('is not a success in the end state either: stopped, naming what is NOT MET, unless the checks are the problem first', () => {
      const passed = [] as never[]; // a plan with nothing left without evidence
      expect(endStateFor(passed, { result: 'succeeded', summary: 'Done.' }, '')).toMatchObject({ state: 'succeeded' });
      expect(endStateFor(passed, { result: 'succeeded', summary: 'Done.' }, '', ['criterion 2 (a 429 keeps its details)'])).toEqual({
        state: 'stopped',
        reason: 'Done. Not counted as succeeded: the review found criterion 2 (a 429 keeps its details) NOT MET, and the agent did not say why it cannot be met.',
      });
      expect(endStateFor(passed, { result: 'blocked', summary: 'Cannot go on.' }, '', ['criterion 2 (x)'])).toMatchObject({ state: 'stopped', reason: 'Cannot go on.' });
    });
  });

  it('gives a task agent no verdict and no pushes, and lets it edit its clones (v1.3)', () => {
    const w = new TicketWorkflow('task', 'normal');
    expect(w.repoEdit('src/a.ts')).toBeNull();
    expect(w.commit()).toBeNull();
    expect(w.pushProblem()).toContain('nothing is pushed');
    expect(w.verdictProblem(v({}), '')).toContain('A task has no verdict');
  });

  it('asks before a fourth bot-review round as read from the PR, and flags the third disproved hypothesis once', () => {
    const w = new TicketWorkflow('bug', 'normal');
    expect([0, 1, 2].map((r) => w.roundNeedsApproval(r))).toEqual([false, false, false]);
    expect(w.roundNeedsApproval(3)).toBe(true);
    w.extraRounds++;
    expect([w.roundNeedsApproval(3), w.roundNeedsApproval(4)]).toEqual([false, true]);
    expect(['h1', 'h2', 'h3', 'h4'].map((h) => w.hypothesis(h, 'disproved'))).toEqual([false, false, true, false]);
  });

  it('counts bot-review rounds from a PR’s reviews: each commit a bot reviewed once, people not', () => {
    expect(
      botRounds([
        { user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, commit_id: 'a' },
        { user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, commit_id: 'a' },
        { user: { login: 'shop-pr-review', type: 'Bot' }, commit_id: 'b' },
        { user: { login: 'quinnho', type: 'User' }, commit_id: 'c' },
        { user: null, commit_id: 'd' },
      ]),
    ).toBe(2);
  });
});

describe('Jira text', () => {
  it('turns a link alone on its line into a card, and a link in a sentence into a link', () => {
    expect(textToAdf('See the page:\nhttps://acme.atlassian.net/wiki/x/7340036\n\nFixed in https://github.com/o/r/pull/9.')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'See the page:' }, { type: 'hardBreak' }, { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/wiki/x/7340036' } }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Fixed in ' },
            { type: 'text', text: 'https://github.com/o/r/pull/9', marks: [{ type: 'link', attrs: { href: 'https://github.com/o/r/pull/9' } }] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    });
  });
});

describe('writes other people read', () => {
  it('finds the text of a PR, Jira or Confluence write, and nothing else', () => {
    const body = join(root, 'body.md');
    writeFileSync(body, 'From the file: shop-api/src/a.ts:3');
    expect(externalWrite('gh', { args: ['pr', 'create', '--title', 'feature/SHOP-1: x', '--body-file', 'body.md'] }, [root])).toEqual({ what: 'PR', text: 'feature/SHOP-1: x\nFrom the file: shop-api/src/a.ts:3' });
    expect(externalWrite('gh', { args: ['pr', 'comment', '9', '--body', 'Fixed in abc1234'] }, [root])).toEqual({ what: 'PR', text: 'Fixed in abc1234' });
    expect(externalWrite('gh', { args: ['pr', 'view', '9'] }, [root])).toBeNull();
    expect(externalWrite('gh', { args: ['pr', 'review', '9', '--approve'] }, [root])).toBeNull();
    expect(externalWrite('jira', { action: 'fill', key: 'SHOP-1', rootCause: 'r', ac: 'a' }, [root])).toEqual({ what: 'Jira', text: 'r\na' });
    expect(externalWrite('jira', { action: 'link_pr', key: 'SHOP-1', url: 'u' }, [root])).toBeNull();
    expect(externalWrite('confluence', { action: 'edit', pageId: '1', body: '<p>x</p>' }, [root])).toEqual({ what: 'Confluence', text: '<p>x</p>' });
    expect(externalWrite('gh', { args: ['pr', 'create', '--body-file', '/etc/passwd'] }, [root])).toEqual({ what: 'PR', text: '' }); // never read outside the run
  });

  it('wants evidence in the text: a link, a file and line, a ticket or PR, a commit, a query or an id', () => {
    for (const ok of ['See https://github.com/x/y/pull/9.', 'In shop-api/src/a.ts:12.', 'Tracked in SHOP-3492.', 'PR #218 merged.', 'Fixed in 7a9c2e1.', 'The query `source logs | limit 5`.']) expect(hasEvidence(ok), ok).toBe(true);
    for (const bare of ['It is fixed now.', 'The cause was the mapper.', 'Works on dev.']) expect(hasEvidence(bare), bare).toBe(false);
  });
});

describe('the team-dev skill: its version, its sections, its facts', () => {
  const skill = () => {
    const dir = join(root, 'team-dev');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: team-dev\n---\n\n# Acme Shop Dev\n\nInvocation: `$ARGUMENTS`\n\n## Entry\n\nOne.\n\n## Verify\n\nTwo.\n');
    writeFileSync(join(dir, 'references', 'environments.md'), '# Lower environments\n\n| Environment | Use |\n|---|---|\n| Local | Minikube. |\n| Dev | Builds. |\n\n## Access\n\n- AWS (us-west-2): dev 111111111111.\n- Pass `--context`.\n');
    return dir;
  };

  it('hashes the files, splits the Markdown at its sections, and names what changed', () => {
    const dir = skill();
    const before = sectionHashes(dir);
    expect(Object.keys(before)).toEqual(['SKILL.md', 'SKILL.md › Entry', 'SKILL.md › Verify', 'references/environments.md', 'references/environments.md › Access']);
    const hash = skillHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: team-dev\n---\n\n# Acme Shop Dev\n\nInvocation: `$ARGUMENTS`\n\n## Entry\n\nOne, changed.\n\n## Close-out\n\nThree.\n');
    expect(skillHash(dir)).not.toBe(hash);
    expect(changedSections(before, sectionHashes(dir))).toEqual(['SKILL.md › Close-out (new)', 'SKILL.md › Entry', 'SKILL.md › Verify (removed)']);
  });

  it('copies itself read-only for a run, and reads as the run needs it', () => {
    const snap = snapshotSkill(skill(), join(root, 'run', '.elfoqsy', 'team-dev'));
    expect(snap).toMatchObject({ files: 2, hash: skillHash(join(root, 'team-dev')) });
    expect(statSync(join(snap.dir, 'references', 'environments.md')).mode & 0o222).toBe(0);
    expect(skillForRun(snap.skillMd, 'SHOP-3546 hotfix')).toBe('# Acme Shop Dev\n\nInvocation: `SHOP-3546 hotfix`\n\n## Entry\n\nOne.\n\n## Verify\n\nTwo.');
  });

  it('turns references/environments.md into one fact per row and bullet, with its section', () => {
    expect(environmentFacts(readFileSync(join(skill(), 'references', 'environments.md'), 'utf8'))).toEqual([
      'Lower environments: Local: Minikube.',
      'Lower environments: Dev: Builds.',
      'Access: AWS (us-west-2): dev 111111111111.',
      'Access: Pass `--context`.',
    ]);
  });

});

describe('per ticket: active hours and interventions, against the team-dev baseline', () => {
  const T = Date.parse('2026-10-12T08:00:00Z');
  let seq = 0;
  const e = <K extends ElfEvent['type']>(minutes: number, type: K, payload: Extract<ElfEvent, { type: K }>['payload']): AnyEnvelope =>
    ({ seq: ++seq, id: `e${seq}`, ts: new Date(T + minutes * 60_000).toISOString(), type, source: 'orchestrator', payload }) as unknown as AnyEnvelope;

  it('counts gaps of 30 minutes or less as active, and his guidance, pauses, answers and messages as interventions', () => {
    const events = [
      e(0, 'conversation.created', { conversationId: 'c1', title: 'x', ticket: 'SHOP-1' }),
      e(0, 'elfoqsy.message', { messageId: 'm1', role: 'you', text: 'start it', conversationId: 'c1' }),
      e(1, 'run.created', { runId: 'r1', ticket: 'SHOP-1', worktree: '/w', branch: 'feature/SHOP-1', agentNumber: 1 }),
      e(20, 'run.heartbeat', { runId: 'r1', step: 'Fix', sinceLast: 'x', next: 'y', progress: 'some', risks: [], tokens: 1, workingSeconds: 60 }),
      e(30, 'approval.requested', { approvalId: 'a1', runId: 'r1', kind: 'question', question: '?' }),
      e(35, 'approval.resolved', { approvalId: 'a1', decision: 'answered', answer: 'yes' }),
      e(40, 'run.guidance', { runId: 'r1', text: 'skip it', by: 'you' }),
      e(41, 'run.guidance', { runId: 'r1', text: 'tester', by: 'tester' }),
      // A two-hour gap is not working time.
      e(161, 'run.paused', { runId: 'r1', by: 'you' }),
      e(170, 'elfoqsy.message', { messageId: 'm2', role: 'test', text: 'not his', conversationId: 'c1' }),
    ];
    expect(ticketStats(events, T, T + 24 * 3_600_000)).toEqual([{ ticket: 'SHOP-1', activeHours: 0.8, interventions: 4 }]);
    const p = periodStats(events, T, T + 24 * 3_600_000);
    expect(p.metrics).toMatchObject({ ticketsWorked: 1, activeHours: 0.8, activeHoursPerTicket: 0.8, interventionsPerTicket: 4, baselineHoursPerTicket: 5.3, baselineInterventionsPerTicket: 18.4 });
    expect(baselinePerTicket()).toEqual({ hours: 5.3, interventions: 18.4 });
    expect(reviewPrompt('2026-10-12', p)).toContain('SHOP-1 0.8 h, 4. Average 0.8 h and 4 interventions per ticket; the baseline, 8 tickets with the skill alone (the team-dev retrospective of 11 October 2026), is 5.3 h and 18.4.');
  });
});

describe('Coralogix and the environments', () => {
  it('queries US1 at api.us1.coralogix.com, however the domain is written', () => {
    for (const d of ['us1.coralogix.com', 'api.us1.coralogix.com', 'https://api.us1.coralogix.com/', ' us1.coralogix.com ']) expect(coralogixEndpoint(d)).toBe('https://api.us1.coralogix.com/api/v1/dataprime/query');
  });

  it("maps alex's contexts by their ARNs, keeps automation-test and integration-usw2 asked, and has no local cluster yet", () => {
    expect(configured.list.map((x) => [x.name, x.kubeContext])).toEqual([
      ['dev', 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop'],
      ['staging', 'arn:aws:eks:us-west-2:222222222222:cluster/staging-shop'],
      ['integration', 'arn:aws:eks:us-west-2:333333333333:cluster/integration-shop'],
    ]);
    expect(configured.unknownContexts).toEqual(['automation-test', 'integration-usw2']);
    expect(configured.harness).toEqual(['shop-integration-test']);
  });
});
