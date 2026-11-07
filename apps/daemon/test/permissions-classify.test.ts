// The four tiers, as each proxy classifies its requests (brief-v1.2/docs/permissions.md). Pure tables: nothing runs.
import { describe, expect, it } from 'vitest';
import { classifyAws } from '../src/permissions/aws';
import { parseEnvironments, resolveApplication, resolveContext, resolveProfile, runContexts } from '../src/permissions/environments';
import { classifyGh } from '../src/permissions/gh';
import { classifyKube, parseKube } from '../src/permissions/kube';
import { runKubeconfig } from '../src/permissions/kubeconfig';
import { toHim } from '../src/permissions/proxy';
import type { RunRef } from '../src/permissions/types';
import { configured, environments as envs } from './helpers/proxyFakes';

const SHOP_API = 'acme/shop-api';
const run: RunRef = { runId: 'r1', ticket: 'SHOP-3492', agentNumber: 7, branch: 'feature/SHOP-3492', targets: [{ repo: SHOP_API, base: 'master' }], kubeconfig: '/data/runs/r1/kubeconfig' };
const tier = (c: { tier: number; invalid?: boolean }) => (c.invalid ? 'invalid' : c.tier);

describe('environments, from config/environments.yaml', () => {
  it('resolves contexts, EKS ARNs, profiles and applications, with prod and unknown names kept apart', () => {
    expect(resolveContext(envs, 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop')).toMatchObject({ kind: 'env', env: { name: 'dev', namespace: 'shop-dev' } });
    expect(resolveContext(envs, 'dev-shop')).toMatchObject({ kind: 'env', env: { name: 'dev' } }); // the cluster's name
    expect(resolveContext(envs, 'staging')).toMatchObject({ kind: 'env', env: { name: 'staging' } }); // the environment's name
    expect(resolveContext(envs, 'arn:aws:eks:us-west-2:333333333333:cluster/integration-shop')).toMatchObject({ kind: 'env', env: { name: 'integration' } });
    expect(resolveContext(envs, 'arn:aws:eks:us-west-2:111111111111:cluster/integration-shop')).toMatchObject({ kind: 'unknown' }); // another account
    expect(resolveContext(envs, 'minikube')).toMatchObject({ kind: 'env', env: { name: 'local' } });
    expect(resolveContext(envs, 'arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod')).toMatchObject({ kind: 'prod' });
    expect(resolveContext(envs, 'integration-usw2')).toMatchObject({ kind: 'unknown_listed' });
    expect(resolveContext(envs, 'automation-test')).toMatchObject({ kind: 'unknown_listed' });
    expect(resolveContext(configured, 'minikube')).toMatchObject({ kind: 'unknown' }); // no local cluster yet
    expect(resolveContext(envs, 'someone-elses-cluster')).toMatchObject({ kind: 'unknown' });
    expect(resolveProfile(envs, 'staging-shop')).toMatchObject({ kind: 'env', env: { name: 'staging' } });
    expect(resolveProfile(envs, 'core-shop-prod')).toMatchObject({ kind: 'prod' });
    expect(resolveProfile(envs, 'production')).toMatchObject({ kind: 'prod' });
    expect(resolveProfile(envs, 'acme-fraudcheck-stage')).toMatchObject({ kind: 'unknown' });
    expect(resolveApplication(envs, 'shop-dev')).toMatchObject({ kind: 'env', env: { name: 'dev' } });
    expect(resolveApplication(envs, 'shop-prd')).toMatchObject({ kind: 'prod' });
    expect(runContexts(envs)).toEqual([
      'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop',
      'arn:aws:eks:us-west-2:222222222222:cluster/staging-shop',
      'arn:aws:eks:us-west-2:333333333333:cluster/integration-shop',
      'minikube',
      'automation-test',
      'integration-usw2',
    ]);
    expect(envs.harness).toEqual(['shop-integration-test']);
  });

  it('refuses a config that grants prod any access', () => {
    expect(() => parseEnvironments('region: us-west-2\nenvironments: {}\nprod:\n  access: read\n')).toThrow();
  });
});

describe('kube: every call names its context; the context decides the environment', () => {
  const k = (args: string) => classifyKube(args.split(' '), envs);

  it.each([
    ['get pods', 'invalid'],
    ['--context dev-shop get pods', 0],
    ['get pods --context=dev-shop -n shop-dev -o wide', 0],
    ['--context staging-shop describe deployment shop-api', 0],
    ['--context integration-shop logs deploy/shop-api --tail 200', 0],
    ['--context dev-shop get configmap shop-api-config -o yaml', 0],
    ['--context dev-shop get secret shop-api-token -o yaml', 2],
    ['--context dev-shop get secrets,configmaps', 2],
    ['--context dev-shop describe secret/shop-api-token', 2],
    ['--context dev-shop get --raw /api/v1/namespaces/x/secrets/y', 2],
    ['--context dev get pods', 0],
    ['--context arn:aws:eks:us-west-2:111111111111:cluster/dev-shop get pods', 0],
    // The harness may change; product services are alex's to deploy.
    ['--context dev-shop set image deployment/shop-integration-test shop-integration-test=it:SHOP-3049', 1],
    ['--context dev rollout restart deployment shop-integration-test', 1],
    ['--context dev-shop scale deployment/shop-integration-test --replicas=0', 1],
    ['--context minikube set image deployment/shop-integration-test shop-integration-test=it:dev', 1],
    ['--context dev-shop set image deployment/shop-api shop-api=shop-api:2.22.0', 3],
    ['--context dev-shop rollout restart deployment/shop-api', 3],
    ['--context dev-shop scale deploy/order-worker --replicas=0', 3],
    ['--context dev-shop rollout undo deployment/shop-api', 3],
    ['--context minikube set image deployment/shop-api shop-api=shop-api:dev', 3],
    ['--context dev-shop -n kube-system rollout restart deployment/coredns', 3],
    ['--context dev-shop -n other rollout restart deployment/shop-integration-test', 2],
    ['--context staging-shop set image deployment/shop-integration-test shop-integration-test=it:2.22.0', 2],
    ['--context staging-shop scale deployment/shop-integration-test --replicas=1', 2],
    ['--context integration-shop rollout restart deployment/shop-integration-test', 2],
    ['--context staging-shop set image deployment/shop-api shop-api=shop-api:2.22.0', 3],
    ['--context integration-shop rollout restart deployment/shop-api', 3],
    ['--context dev-shop exec -it shop-api-0 -- sh', 2],
    ['--context dev-shop port-forward svc/shop-api 8080:80', 2],
    ['--context dev-shop label deployment/shop-api team=shop', 2],
    ['--context dev-shop patch deployment/shop-api -p {"spec":{}}', 3],
    ['--context dev-shop patch deployment/shop-integration-test -p {"spec":{}}', 2],
    ['--context dev-shop frobnicate deployment/shop-api', 2],
    ['--context integration-usw2 get pods', 2],
    ['--context automation-test get pods', 2],
    ['--context automation-test logs deploy/x', 2],
    ['--context dev-shop apply -f deploy.yaml', 3],
    ['--context dev-shop replace -f deploy.yaml', 3],
    ['--context dev-shop delete pod shop-api-0', 3],
    ['--context dev-shop delete job old-run', 3],
    ['--context dev-shop edit configmap shop-api-config', 3],
    ['--context dev-shop patch configmap shop-api-config -p {"data":{}}', 3],
    ['--context dev-shop create secret generic x --from-literal=a=b', 3],
    ['--context dev-shop drain node-1', 3],
    ['--context dev-shop config use-context staging-shop', 3],
    ['--context dev-shop --kubeconfig /home/alex/.kube/config get pods', 3],
    ['--context dev-shop --as system:admin get pods', 3],
    ['--context dev-shop --token abc get pods', 3],
    ['--context arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod get pods', 3],
    ['--context someone-elses-cluster get pods', 'invalid'],
    ['--context dev-shop edit deployment shop-api', 'invalid'],
    ['--context dev-shop -A rollout restart deployment/shop-integration-test', 'invalid'],
  ])('%s → %s', (args, expected) => {
    expect(tier(k(args))).toBe(expected);
  });

  it('names the kind, the environment and whether it needs AWS', () => {
    expect(k('--context dev-shop set image deployment/shop-integration-test shop-integration-test=b:2')).toMatchObject({ kind: 'kube.set_image', environment: 'dev', needsAws: true });
    expect(k('--context dev set image deployment/shop-api shop-api=b:2')).toMatchObject({
      tier: 3,
      reason: "shop-api is a product service: deploying it is alex's. Only the test harness (shop-integration-test) may be changed. Hand over with ask_user (environment, source SHAs, image tags, scenarios, rollback) and wait.",
    });
    expect(classifyKube(['--context', 'minikube', 'get', 'pods'], configured)).toMatchObject({ invalid: true, reason: expect.stringContaining('There is no local cluster yet.') });
    expect(k('--context minikube get pods')).toMatchObject({ environment: 'local', needsAws: false });
    expect(k('--context integration-usw2 get pods')).toMatchObject({ environment: 'integration-usw2', reason: 'integration-usw2 is not ours: every call to it is asked, reads included.' });
    expect(k('get pods')).toMatchObject({ reason: expect.stringContaining('add --context') });
  });

  it('reads flags before or after the verb', () => {
    expect(parseKube(['-n', 'x', '--context=dev', 'rollout', 'restart', 'deployment/shop-api'])).toMatchObject({ context: 'dev', namespace: 'x', verb: 'rollout restart', resources: ['deployment/shop-api'] });
    expect(parseKube(['--context', 'dev', 'set', 'image', 'deploy/b', 'b=img:1', 'c=img:2'])).toMatchObject({ verb: 'set image', resources: ['deploy/b'], rest: ['b=img:1', 'c=img:2'] });
  });
});

describe('aws: every call names its profile', () => {
  const a = (args: string) => classifyAws(args.split(' '), envs);

  it.each([
    ['sts get-caller-identity', 'invalid'],
    ['--profile dev-shop sts get-caller-identity', 0],
    ['s3 ls s3://team-dev-results --profile dev-shop', 0],
    ['ecr describe-images --repository-name shop-api --profile staging-shop', 0],
    ['logs filter-log-events --log-group-name /shop/dev/shop-api --filter-pattern 401 --profile dev-shop', 0],
    ['eks describe-cluster --name dev-shop --profile dev-shop', 0],
    ['secretsmanager get-secret-value --secret-id shop-api --profile dev-shop', 2],
    ['ssm get-parameter --name /x --with-decryption --profile dev-shop', 2],
    // Of any type (18 October): a String can hold a secret as well as a SecureString. describe-parameters stays free.
    ['ssm get-parameter --name /x --profile dev-shop', 2],
    ['ssm describe-parameters --profile dev-shop', 0],
    ['kms decrypt --ciphertext-blob x --profile dev-shop', 2],
    ['ecr put-image --repository-name shop-api --profile dev-shop', 2],
    ['s3 cp report.json s3://team-dev-results/ --profile dev-shop', 2],
    ['lambda invoke --function-name x out.json --profile dev-shop', 2],
    ['configure set region us-east-1 --profile dev-shop', 3],
    ['sso login --profile dev-shop', 3],
    ['sts assume-role --role-arn x --role-session-name y --profile dev-shop', 3],
    ['ecr get-login-password --profile dev-shop', 3],
    ['eks get-token --cluster-name x --profile dev-shop', 3],
    ['eks update-kubeconfig --name dev-shop --profile dev-shop', 3],
    ['s3 ls --profile core-shop-prod', 3],
    ['s3 ls --endpoint-url http://evil --profile dev-shop', 3],
    ['s3 ls --profile acme-fraudcheck-stage', 'invalid'],
  ])('%s → %s', (args, expected) => {
    expect(tier(a(args))).toBe(expected);
  });
});

describe('gh: the run’s own draft PR and failed CI at once; ready, comments and workflows asked; merging never', () => {
  const g = (...args: string[]) => classifyGh(args, run, { repos: [SHOP_API, 'acme/shop-shared'] });

  it.each([
    [['pr', 'view', '812', '--repo', SHOP_API], 0],
    [['pr', 'checks', '812', '--repo', 'someone/else'], 0],
    [['run', 'view', '123', '--log-failed', '--repo', SHOP_API], 0],
    [['api', 'repos/acme/shop-api/pulls/812'], 0],
    [['api', 'graphql', '-f', 'query={ viewer { login } }'], 0],
    [['search', 'prs', 'SHOP-3492'], 0],
    [['pr', 'create', '--repo', SHOP_API, '--title', 'feature/SHOP-3492: fix the header', '--body', 'x'], 1],
    [['pr', 'create', '--repo', SHOP_API, '--title', 'SHOP-3492: fix the header', '--body', 'x'], 'invalid'],
    [['pr', 'create', '--repo', SHOP_API, '--head', 'feature/SHOP-3492', '--base', 'master', '--title', 'feature/SHOP-3492: send one Basic scheme', '--body', 'b'], 1],
    [['pr', 'create', '--repo', SHOP_API, '--title', 'fix the header', '--body', 'b'], 'invalid'],
    [['pr', 'create', '--repo', SHOP_API, '--title', 'feature/SHOP-3492: ', '--body', 'b'], 'invalid'],
    [['run', 'rerun', '123', '--failed', '--repo', SHOP_API], 1],
    [['pr', 'create', '--repo', SHOP_API, '--base', 'release/2.22', '--title', 'feature/SHOP-3492: send one Basic scheme', '--body', 'b'], 2],
    [['run', 'rerun', '123', '--repo', SHOP_API], 2],
    [['pr', 'ready', '812', '--repo', SHOP_API], 2],
    [['pr', 'comment', '812', '--body', 'Ready for review.', '--repo', SHOP_API], 2],
    [['pr', 'edit', '812', '--add-reviewer', 'quinn', '--repo', SHOP_API], 2],
    [['pr', 'close', '812', '--repo', SHOP_API], 2],
    [['workflow', 'run', 'ci', '--ref', 'feature/SHOP-3492', '--repo', SHOP_API], 2],
    [['cache', 'delete', '--all', '--repo', SHOP_API], 2],
    [['api', '-X', 'POST', 'repos/acme/shop-api/issues/812/comments', '-f', 'body=x'], 2],
    [['pr', 'merge', '812', '--repo', SHOP_API], 3],
    [['pr', 'merge', '812'], 3],
    [['pr', 'review', '812', '--approve', '--repo', SHOP_API], 3],
    [['pr', 'review', '812', '-a', '--repo', SHOP_API], 3],
    [['pr', 'create', '--auto', '--repo', SHOP_API], 3],
    [['api', '-X', 'PUT', 'repos/acme/shop-api/pulls/812/merge'], 3],
    [['api', '-X', 'PATCH', 'repos/acme/shop-api/git/refs/heads/feature/SHOP-3492', '-f', 'sha=x', '-F', 'force=true'], 3],
    [['api', '-X', 'POST', 'repos/acme/shop-api/branches/feature/SHOP-3492/rename', '-f', 'new_name=x'], 3],
    [['api', '-X', 'POST', 'repos/acme/shop-api/pulls/812/reviews', '-f', 'event=APPROVE'], 3],
    [['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input: {}) { clientMutationId } }'], 3],
    [['workflow', 'run', 'deploy-staging', '--ref', 'feature/SHOP-3492', '--repo', SHOP_API], 3],
    [['workflow', 'run', 'ci', '--ref', 'master', '--repo', SHOP_API], 3],
    [['release', 'create', 'v2.22.1', '--repo', SHOP_API], 3],
    [['repo', 'rename', 'x', '--repo', SHOP_API], 3],
    [['auth', 'token'], 3],
    [['secret', 'set', 'X', '--repo', SHOP_API], 3],
    [['pr', 'create', '--repo', SHOP_API, '--head', 'feature/OTHER-1', '--title', 't', '--body', 'b'], 'invalid'],
    [['pr', 'create', '--repo', SHOP_API, '--reviewer', 'quinn', '--title', 't', '--body', 'b'], 'invalid'],
    [['pr', 'create', '--repo', 'acme/shop-shared', '--title', 't', '--body', 'b'], 'invalid'],
    [['pr', 'comment', '1', '--body', 'x', '--repo', 'someone/else'], 'invalid'],
    [['pr', 'comment', '1', '--body', 'x'], 'invalid'],
    [['codespace', 'list'], 'invalid'],
  ])('%j → %s', (args, expected) => {
    expect(tier(g(...(args as string[])))).toBe(expected);
  });

  it('names its kinds, which grants are kept by', () => {
    expect(g('pr', 'ready', '812', '--repo', SHOP_API).kind).toBe('gh.pr.ready');
    expect(g('pr', 'comment', '812', '--body', 'x', '--repo', SHOP_API).kind).toBe('gh.pr.comment');
    expect(g('pr', 'create', '--repo', SHOP_API, '--title', 't', '--body', 'b').kind).toBe('gh.pr.create');
  });
});

describe('Elfoqsy’s line about a refusal speaks to alex himself', () => {
  it.each([
    ["Merging is alex's to do.", 'Merging is yours to do.'],
    ["gh auth is alex's login; agents never hold credentials.", 'gh auth is your login; agents never hold credentials.'],
    ["Secrets are alex's.", 'Secrets are yours.'],
    ["alex's profile and kube context never change.", 'your profile and kube context never change.'],
  ])('%s', (reason, said) => {
    expect(toHim(reason)).toBe(said);
  });
});

describe('a run’s own kubeconfig', () => {
  // Fake contexts and users only: no real cluster, token or key.
  const full = `
apiVersion: v1
kind: Config
current-context: arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod
clusters:
  - name: arn:aws:eks:us-west-2:111111111111:cluster/dev-shop
    cluster: { server: https://dev.example.invalid }
  - name: arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod
    cluster: { server: https://prod.example.invalid }
  - name: minikube
    cluster: { server: https://127.0.0.1:8443 }
users:
  - name: dev-user
    user: { exec: { command: aws, args: [eks, get-token, --cluster-name, dev-shop, --profile, dev-shop] } }
  - name: prod-user
    user: { exec: { command: aws, args: [eks, get-token, --cluster-name, core-shop-prod, --profile, core-shop-prod] } }
  - name: minikube
    user: { client-key-data: not-a-real-key }
contexts:
  - name: arn:aws:eks:us-west-2:111111111111:cluster/dev-shop
    context: { cluster: 'arn:aws:eks:us-west-2:111111111111:cluster/dev-shop', user: dev-user }
  - name: arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod
    context: { cluster: 'arn:aws:eks:us-west-2:111111111111:cluster/core-shop-prod', user: prod-user }
  - name: minikube
    context: { cluster: minikube, user: minikube }
`;

  it('keeps only the configured contexts, named as configured, with no current context and nothing of prod', () => {
    const { yaml, contexts } = runKubeconfig(full, runContexts(envs));
    expect(contexts).toEqual(['arn:aws:eks:us-west-2:111111111111:cluster/dev-shop', 'minikube']);
    expect(yaml).toContain('current-context: ""');
    expect(yaml).toContain('name: arn:aws:eks:us-west-2:111111111111:cluster/dev-shop');
    expect(yaml).not.toMatch(/prod/);
  });

  it('is empty without alex’s kubeconfig', () => {
    expect(runKubeconfig('', runContexts(envs)).contexts).toEqual([]);
  });
});
