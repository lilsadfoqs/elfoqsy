// What a review of Elfoqsy's new read path found in the classifiers she shares with the agents (v1.5): forms that were
// classified as free reads although policy says they are asked or never done, and the proxies reading local files
// outside the sandbox, with alex's access. Each row is a call and the tier it must get.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carriedStrings, classifyAws, sessionRanOut } from '../src/permissions/aws';
import { classifyGh, insideRun, localFiles, parseGh } from '../src/permissions/gh';
import { classifyKube } from '../src/permissions/kube';
import type { RunRef } from '../src/permissions/types';
import { environments } from './helpers/proxyFakes';

const REPO = 'acme/shop-api';
const split = (s: string): string[] => s.split(' ');

describe('gh: flags as gh reads them', () => {
  let root: string;
  let outside: string;
  let run: RunRef;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'elfoqsy-gh-'));
    root = join(base, 'run');
    outside = join(base, 'secret.txt');
    mkdirSync(root);
    writeFileSync(join(root, 'body.md'), 'Decisions I made\n- x');
    writeFileSync(outside, 'SECRET');
    symlinkSync(outside, join(root, 'link.md'));
    run = { runId: 'r', ticket: 'SHOP-1', agentNumber: 1, branch: 'feature/SHOP-1', targets: [{ repo: REPO, base: 'master' }], kubeconfig: '/k', root };
  });
  afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  const tier = (cmd: string, r: RunRef = run) => classifyGh(split(cmd), r, { repos: [REPO] }).tier;

  it.each([
    // An attached short flag is the flag with its value: these were free reads.
    [`api -XPUT repos/${REPO}/pulls/1/merge`, 3],
    [`api -XDELETE repos/${REPO}/git/refs/heads/x`, 3],
    [`api -X=PUT repos/${REPO}/pulls/1/merge`, 3],
    [`api repos/${REPO}/issues/1/comments -fbody=hi`, 2],
    [`api repos/${REPO}/issues/1/comments -f body=hi`, 2],
    ['api graphql -fquery=mutation{mergePullRequest(input:{})}', 3],
    ['api graphql -f query=mutation{mergePullRequest(input:{})}', 3],
    ['api graphql --field query=mutation{mergePullRequest(input:{})}', 3],
    ['api graphql -f query=query{viewer{login}}', 0],
    // What was always right.
    [`api -X PUT repos/${REPO}/pulls/1/merge`, 3],
    [`api repos/${REPO}/pulls/1`, 0],
    [`api -XGET repos/${REPO}/pulls/1`, 0],
    [`pr view 1 --repo ${REPO}`, 0],
    [`pr list -s open --repo ${REPO}`, 0],
    [`pr merge 1 --repo ${REPO}`, 3],
    [`pr ready 1 --repo ${REPO}`, 2],
    [`run list -L5 --repo ${REPO}`, 0],
  ])('%s is tier %i', (cmd, expected) => {
    expect(tier(cmd)).toBe(expected);
  });

  it('reads a clustered short flag as gh does: -dt is -d and -t with its value', () => {
    const p = parseGh(['pr', 'create', '-dt', 'feature/SHOP-1: x', '--repo', REPO]);
    expect(p.flags.get('-d')).toEqual(['']);
    expect(p.flags.get('-t')).toEqual(['feature/SHOP-1: x']);
    expect(parseGh(['api', '-XPUT', 'x']).flags.get('-X')).toEqual(['PUT']);
    expect(parseGh(['api', '-fbody=hi', 'x']).flags.get('-f')).toEqual(['body=hi']);
  });

  it('refuses a GraphQL query it cannot read, a file or stdin: it may be a mutation', () => {
    expect(tier(`api graphql --input ${join(root, 'body.md')}`)).toBe(2);
    expect(tier('api graphql --input -')).toBe(2);
    expect(tier(`api graphql -F query=@${join(root, 'body.md')}`)).toBe(2);
  });

  it('lets gh read only a file inside the run folder, by its absolute path, never another', () => {
    const create = (flags: string) => classifyGh(['pr', 'create', '--repo', REPO, '--title', 'feature/SHOP-1: fix', ...flags.split(' ')], run, { repos: [REPO] }).tier;
    expect(create(`--body-file ${join(root, 'body.md')}`)).toBe(1);
    expect(create('--body-file -')).toBe(1);
    expect(create(`--body-file ${outside}`)).toBe(3);
    expect(create(`-F ${outside}`)).toBe(3);
    expect(create(`-F${outside}`)).toBe(3);
    expect(create('--body-file body.md')).toBe(3); // relative: gh would read it from the daemon's own folder
    expect(create(`--body-file ${join(root, '..', 'secret.txt')}`)).toBe(3);
    expect(create(`--body-file ${join(root, 'link.md')}`)).toBe(3); // a link in the run folder that points out is not inside
    expect(create('--body-file /home/someone/.config/gh/hosts.yml')).toBe(3);
    // Fields: a key=@file reads one; plain fields do not.
    expect(tier(`api repos/${REPO}/issues/1/comments -F body=@${outside}`)).toBe(3);
    expect(tier(`api repos/${REPO}/issues/1/comments -F body=@${join(root, 'body.md')}`)).toBe(2);
    expect(tier(`api repos/${REPO}/issues/1/comments --input ${outside}`)).toBe(3);
    // Elfoqsy has no run folder: no file at all.
    const hers: RunRef = { runId: 'elfoqsy', ticket: '', agentNumber: 0, branch: '', targets: [], kubeconfig: '/k', actor: 'elfoqsy' };
    expect(tier(`api repos/${REPO}/issues/1/comments --input ${join(root, 'body.md')}`, hers)).toBe(3);
    expect(tier(`pr view 1 --repo ${REPO}`, hers)).toBe(0);
  });

  it('knows which flags name files', () => {
    expect(localFiles(parseGh(['pr', 'create', '-F', '/a', '--body-file', '/b']))).toEqual(['/b', '/a']);
    expect(localFiles(parseGh(['workflow', 'run', 'x', '-F', 'name=value', '--ref', 'main']))).toEqual([]);
    expect(localFiles(parseGh(['api', 'x', '-F', 'a=@/f']))).toEqual(['/f']);
    expect(insideRun('/x/run/a', '/x/run')).toBe(true); // a file not made yet, under the folder
    expect(insideRun('/x/other/a', '/x/run')).toBe(false);
    expect(insideRun('/x/run-2/a', '/x/run')).toBe(false); // a sibling that starts with the same letters
    expect(insideRun('a', root)).toBe(false); // relative
    expect(insideRun('/x/run/a', undefined)).toBe(false); // no run folder
  });
});

describe('kube: secrets and local files', () => {
  const tier = (cmd: string) => classifyKube(split(cmd), environments).tier;

  it.each([
    // Secrets named after "--", or read through the API with a query string, were free reads.
    ['--context dev get -n shop-dev -- secrets', 2],
    ['--context dev get -- secret db', 2],
    ['--context dev get --raw /api/v1/namespaces/x/secrets?limit=500', 2],
    ['--context dev get --raw /api/v1/namespaces/x/secrets', 2],
    ['--context dev get --raw /api/v1/namespaces/x/secrets/db', 2],
    ['--context dev get secrets', 2],
    ['--context dev get secret,configmap', 2],
    ['--context dev get pods', 0],
    ['--context dev get --raw /api/v1/namespaces/x/pods', 0],
    ['--context dev get --raw /api/v1/namespaces/x/pods?limit=5', 0],
    // A file or URL kubectl would read, outside the sandbox: never.
    ['--context dev get -f /home/u/.config/gh/hosts.yml', 3],
    ['--context dev get -f/home/u/.config/gh/hosts.yml', 3],
    ['--context dev get --filename /home/u/x.yaml', 3],
    ['--context dev get --filename=https://example.org/x.yaml', 3],
    ['--context dev describe -f x.yaml', 3],
    ['--context dev get -k /home/u/dir', 3],
    ['--context dev rollout status -f x.yaml', 3],
    ['--context dev get pods -o go-template-file=/home/u/x.tmpl', 3],
    ['--context dev get pods --output=jsonpath-file=/home/u/x', 3],
    // Following is not a file.
    ['--context dev logs -f deployment/x', 0],
    ['--context dev logs -fc app pod', 0],
    ['--context dev get pods -owide', 0],
    ['--context dev get pods -o jsonpath={.items[*].spec.containers[*].image}', 0],
    // What was always right.
    ['--context dev apply -f x.yaml', 3],
    ['--context dev delete pod x', 3],
    ['--context automation-test get pods', 2],
  ])('%s is tier %i', (cmd, expected) => {
    expect(tier(cmd)).toBe(expected);
  });
});

describe('aws: credentials, objects and local files', () => {
  const P = '--profile dev-shop';
  const tier = (cmd: string) => classifyAws(split(cmd), environments).tier;

  it.each([
    // A registry password was a free read.
    [`ecr get-authorization-token ${P}`, 3],
    [`ecr get-authorization-token --query authorizationData[0].authorizationToken --output text ${P}`, 3],
    [`ecr-public get-authorization-token ${P}`, 3],
    [`ecr get-login-password ${P}`, 3],
    // An object's data copied out was a free read; s3 cp already asked.
    [`s3api get-object --bucket b --key k /dev/stdout ${P}`, 2],
    [`s3api select-object-content --bucket b --key k ${P}`, 2],
    [`s3 cp s3://b/k - ${P}`, 2],
    [`s3api list-objects-v2 --bucket b ${P}`, 0],
    [`s3api head-object --bucket b --key k ${P}`, 0],
    // The CLI reads file:// and fileb:// arguments from local files, with his access, and its errors repeat them.
    [`ec2 describe-instances --instance-ids file:///home/u/.aws/credentials ${P}`, 3],
    [`ec2 describe-instances --instance-ids=file:///home/u/.config/gh/hosts.yml ${P}`, 3],
    [`ec2 describe-instances --cli-input-json file://x.json ${P}`, 3],
    [`kms encrypt --key-id k --plaintext fileb:///home/u/.ssh/id_ed25519 ${P}`, 3],
    [`ec2 describe-instances --instance-ids i-0123456789abcdef0 ${P}`, 0],
    [`ecr describe-images --repository-name shop-api ${P}`, 0],
    [`sts get-caller-identity ${P}`, 0],
  ])('%s is tier %i', (cmd, expected) => {
    expect(tier(cmd)).toBe(expected);
  });

  // alex's decisions of 18 October. The table is SECRETS, HIDE_ENVIRONMENT and CREDENTIALS in aws.ts.
  describe('reads of the values themselves are asked, for an agent, and refused to Elfoqsy, whatever their verb', () => {
    it.each([
      // Environment values in the clear.
      [`lambda get-function --function-name f ${P}`, 2],
      [`lambda get-function-configuration --function-name f ${P}`, 2],
      [`lambda get-function-configuration --function-name f --query Configuration.FunctionName ${P}`, 2],
      // Secrets.
      [`secretsmanager get-secret-value --secret-id s ${P}`, 2],
      [`secretsmanager batch-get-secret-value --secret-id-list a b ${P}`, 2],
      // SSM parameters of any type, with or without decryption, and what commands printed.
      [`ssm get-parameter --name /x ${P}`, 2],
      [`ssm get-parameter --name /x --with-decryption ${P}`, 2],
      [`ssm get-parameter --name /x --no-with-decryption ${P}`, 2],
      [`ssm get-parameters --names /x ${P}`, 2],
      [`ssm get-parameters-by-path --path /x ${P}`, 2],
      [`ssm get-parameter-history --name /x ${P}`, 2],
      [`ssm get-command-invocation --command-id c --instance-id i ${P}`, 2],
      [`ssm list-command-invocations --details ${P}`, 2],
      // A resource's whole configuration, where the environment of a function or a task definition is in it as text.
      [`cloudcontrol get-resource --type-name AWS::Lambda::Function --identifier f ${P}`, 2],
      [`cloudcontrol list-resources --type-name AWS::ECS::TaskDefinition ${P}`, 2],
      [`config get-resource-config-history --resource-type AWS::Lambda::Function --resource-id f ${P}`, 2],
      [`config batch-get-resource-config --resource-keys resourceType=AWS::Lambda::Function,resourceId=f ${P}`, 2],
      [`config get-aggregate-resource-config --configuration-aggregator-name a --resource-identifier x ${P}`, 2],
      // The values themselves are what these return (his rule, 18 October): asked.
      [`appsync get-graphql-api-environment-variables --api-id a ${P}`, 2],
      [`apigateway get-api-keys --include-values ${P}`, 2],
      [`apigateway get-api-keys --include-v ${P}`, 2],
      [`apigateway get-api-keys --cli-input-json {"includeValues":true} ${P}`, 2],
      [`apigateway get-api-key --api-key k --include-value ${P}`, 2],
      [`ec2 get-password-data --instance-id i ${P}`, 2],
      [`ec2 describe-instance-attribute --instance-id i --attribute userData ${P}`, 2],
      [`ec2 describe-instance-attribute --instance-id i --attr userData ${P}`, 2],
      [`ec2 describe-instance-attribute --cli-input-json {"Attribute":"userData"} ${P}`, 2],
      [`ec2 get-launch-template-data --instance-id i ${P}`, 2],
      [`appconfig get-configuration --application a --environment e --configuration c --client-id i /dev/stdout ${P}`, 2],
      [`appconfig get-hosted-configuration-version --application-id a --configuration-profile-id c --version-number 1 /dev/stdout ${P}`, 2],
      [`appconfigdata get-latest-configuration --configuration-token t /dev/stdout ${P}`, 2],
      [`stepfunctions describe-execution --execution-arn e ${P}`, 2],
      [`stepfunctions get-execution-history --execution-arn e ${P}`, 2],
      [`stepfunctions get-activity-task --activity-arn a ${P}`, 2],
      [`bedrock-agentcore get-resource-api-key --resource-credential-provider-name p ${P}`, 2],
      [`pca-connector-scep get-challenge-password --challenge-arn c ${P}`, 2],
      [`apigateway get-usage-plan-keys --usage-plan-id u ${P}`, 2],
      [`apigateway get-usage-plan-key --usage-plan-id u --key-id k ${P}`, 2],
      [`ivs get-stream-key --arn a ${P}`, 2],
      [`ivs batch-get-stream-key --arns a ${P}`, 2],
      [`storagegateway describe-chap-credentials --target-arn t ${P}`, 2],
      [`ec2 get-vpn-connection-device-sample-configuration --vpn-connection-id v --vpn-connection-device-type-id d ${P}`, 2],
      [`datazone get-connection --domain-identifier d --identifier i --with-secret ${P}`, 2],
      [`datazone get-connection --domain-identifier d --identifier i --with-s ${P}`, 2],
      [`logs get-log-events --log-group-name g --log-stream-name s --unmask ${P}`, 2],
      [`logs filter-log-events --log-group-name g --unm ${P}`, 2],
      [`logs get-log-events --cli-input-json {"logGroupName":"g","unmask":true} ${P}`, 2],
      // The same reads, as they are without the switch: free.
      [`logs get-log-events --log-group-name g --log-stream-name s ${P}`, 0],
      [`ivs list-stream-keys --channel-arn c ${P}`, 0],
      // What stays free: the neighbours that carry no values.
      [`secretsmanager describe-secret --secret-id s ${P}`, 0],
      [`secretsmanager list-secrets ${P}`, 0],
      [`ssm describe-parameters ${P}`, 0],
      [`ssm list-commands ${P}`, 0],
      [`lambda get-function-concurrency --function-name f ${P}`, 0],
      [`lambda list-tags --resource arn:aws:lambda:us-west-2:111111111111:function:f ${P}`, 0],
      [`ecs list-task-definitions ${P}`, 0],
      [`ecs describe-services --cluster c --services s ${P}`, 0],
      [`ecs describe-clusters --clusters c ${P}`, 0],
      [`config describe-configuration-recorders ${P}`, 0],
      // His decision of 18 October: listings that carry user data or a basic-auth login hide the field and stay free.
      [`ec2 describe-launch-template-versions --launch-template-id l ${P}`, 0],
      [`ec2 describe-spot-fleet-requests ${P}`, 0],
      [`ec2 describe-spot-instance-requests ${P}`, 0],
      [`autoscaling describe-launch-configurations ${P}`, 0],
      [`amplify list-apps ${P}`, 0],
      // Neighbours of the asked reads that return no values.
      [`apigateway get-api-keys ${P}`, 0],
      [`apigateway get-api-keys --no-include-values ${P}`, 0],
      [`apigateway get-api-key --api-key k ${P}`, 0],
      [`ec2 describe-instance-attribute --instance-id i --attribute instanceType ${P}`, 0],
      [`ec2 describe-launch-templates ${P}`, 0],
      [`ec2 describe-instances ${P}`, 0],
      [`autoscaling describe-auto-scaling-groups ${P}`, 0],
      [`appconfig list-applications ${P}`, 0],
      [`appconfig list-hosted-configuration-versions --application-id a --configuration-profile-id c ${P}`, 0],
      [`stepfunctions list-executions --state-machine-arn s ${P}`, 0],
      // A state machine's definition is configuration with no field named for a secret: still free (said in the report).
      [`stepfunctions describe-state-machine --state-machine-arn s ${P}`, 0],
      // AWS never returns the secret values of a connection, only their names and the secret's ARN.
      [`events describe-connection --name n ${P}`, 0],
    ])('%s is tier %i', (cmd, expected) => {
      expect(tier(cmd)).toBe(expected);
    });

    it('says why, in words that name what it returns', () => {
      const why = (cmd: string) => classifyAws(split(`${cmd} ${P}`), environments);
      expect(why('lambda get-function-configuration --function-name f')).toMatchObject({ kind: 'aws.read_secret', reason: expect.stringMatching(/environment variables.*values.*asked first.*list-functions shows the names/) });
      expect(why('ssm get-parameter --name /x')).toMatchObject({ reason: expect.stringMatching(/parameter of any type/) });
      expect(why('ssm get-command-invocation --command-id c --instance-id i')).toMatchObject({ reason: expect.stringMatching(/output of a command/) });
      expect(why('cloudcontrol get-resource --type-name t --identifier i')).toMatchObject({ reason: expect.stringMatching(/whole configuration.*environment values/) });
      expect(why('secretsmanager get-secret-value --secret-id s')).toMatchObject({ reason: 'Reading a secret is always asked first.' });
    });
  });

  describe('reads that stay free, with environment variables’ values hidden in what they return', () => {
    const hides = (cmd: string) => classifyAws(split(`${cmd} ${P}`), environments);

    it.each([
      'lambda list-functions',
      'lambda list-versions-by-function --function-name f',
      'ecs describe-task-definition --task-definition t',
      'ecs describe-tasks --cluster c --tasks t',
      'lambda list-functions --query Functions[].FunctionName',
      'lambda list-functions --output text',
    ])('%s is tier 0, marked to have its values hidden', (cmd) => {
      expect(hides(cmd)).toMatchObject({ tier: 0, hideSecrets: true, kind: expect.stringMatching(/^aws\.(lambda|ecs)\./) });
    });

    it.each([
      // Environment of containers, jobs and functions (the first group he named, and the ones the filter already covered).
      'ecs describe-daemon-task-definition --task-definition t',
      'ecs describe-express-gateway-service --service-arn s',
      'batch describe-job-definitions',
      'batch describe-jobs --jobs j',
      'codebuild batch-get-projects --names n',
      'codebuild batch-get-builds --ids i',
      'codebuild batch-get-build-batches --ids i',
      'codebuild batch-get-sandboxes --ids i',
      'codepipeline get-pipeline --name n',
      'codepipeline get-pipeline-execution --pipeline-name p --pipeline-execution-id e',
      'devicefarm get-project --arn a',
      'devicefarm list-runs --arn a',
      'lightsail get-container-services',
      'lightsail get-container-service-deployments --service-name s',
      'emr describe-notebook-execution --notebook-execution-id n',
      'bedrock-agentcore-control get-agent-runtime --agent-runtime-id a',
      'cleanroomsml get-trained-model --membership-identifier m --trained-model-arn a',
      'lambda-microvms list-microvm-image-versions',
      'greengrass get-function-definition-version --function-definition-id f --function-definition-version-id v',
      'sagemaker describe-training-job --training-job-name t',
      'sagemaker describe-model --model-name m',
      'sagemaker describe-processing-job --processing-job-name p',
      // Under keys of their own.
      'apigateway get-stage --rest-api-id r --stage-name s',
      'apigateway get-stages --rest-api-id r',
      'apprunner describe-service --service-arn s',
      'glue get-job --job-name j',
      'glue get-jobs',
      'glue batch-get-jobs --job-names j',
      'glue get-session --id i',
      'glue list-sessions',
      'ssm get-automation-execution --automation-execution-id a',
      'pipes describe-pipe --name p',
      'securityhub get-findings',
      'amplify get-app --app-id a',
      'amplify list-apps',
      'amplify get-branch --app-id a --branch-name b',
      'amplify list-branches --app-id a',
      'apigatewayv2 get-stage --api-id a --stage-name s',
      'apigatewayv2 get-stages --api-id a',
      'finspace get-kx-cluster --environment-id e --cluster-name c',
      'gamelift describe-container-group-definition --name n',
      'gameliftstreams get-stream-session --identifier i --stream-session-identifier s',
      'glue get-job-run --job-name j --run-id r',
      'glue get-job-runs --job-name j',
      'glue get-trigger --name t',
      'glue get-workflow-run --name w --run-id r',
      'glue get-workflow-run-properties --name w --run-id r',
      'glue get-dev-endpoint --endpoint-name e',
      'mwaa get-environment --name n',
      'elasticbeanstalk describe-configuration-settings --application-name a --environment-name e',
      'sagemaker describe-app-image-config --app-image-config-name n',
      'sagemaker describe-partner-app --arn a',
      'codepipeline list-action-executions --pipeline-name p',
    ])('%s is tier 0, marked to have its values hidden (the table of environments)', (cmd) => {
      expect(hides(cmd)).toMatchObject({ tier: 0, hideSecrets: true, reason: expect.stringMatching(/environment variables are hidden/) });
    });

    it.each([
      // A field that holds a credential: hidden, and the field stays (his rule, 18 October).
      'cognito-idp describe-user-pool-client --user-pool-id p --client-id c',
      'cognito-idp list-user-pool-client-secrets --user-pool-id p --client-id c',
      'cloudfront get-distribution --id d',
      'cloudfront get-distribution-config --id d',
      'cloudfront list-distributions',
      'cloudfront list-distributions-by-web-acl-id --web-acl-id w',
      'codepipeline list-webhooks',
      'ec2 describe-vpn-connections',
      'ec2 describe-verified-access-trust-providers',
      'elbv2 describe-listeners --load-balancer-arn l',
      'elbv2 describe-rules --listener-arn l',
      'wafv2 list-api-keys --scope REGIONAL',
      'dataexchange get-asset --data-set-id d --revision-id r --asset-id a',
      'glue get-connection --name c',
      'glue get-connections',
      'amplifybackend get-backend-auth --app-id a --backend-environment-name b --resource-name r',
      'datasync describe-location-fsx-ontap --location-arn l',
      'dms describe-endpoints',
      'ivs get-channel --arn a',
      'mediapackage describe-channel --id i',
      'datazone get-connection --domain-identifier d --identifier i',
      'wickr get-opentdf-config --network-id n',
      'ec2 describe-launch-template-versions --launch-template-id l',
      'ec2 describe-spot-fleet-requests',
      'ec2 describe-spot-instance-requests',
      'autoscaling describe-launch-configurations',
      'appstream describe-directory-configs',
      'chime get-bot --account-id a --bot-id b',
      'chime-sdk-meetings list-attendees --meeting-id m',
      'cloudformation describe-stacks',
      'cloudformation describe-change-set --change-set-name c --stack-name s',
      'cloudhsmv2 describe-clusters',
      'docdb describe-db-instances',
      'neptune describe-db-instances',
      'rds describe-db-instances',
      'rds describe-db-clusters',
      'redshift describe-clusters',
      'emr describe-cluster --cluster-id c',
      'fsx describe-file-systems',
      'ivs-realtime get-ingest-configuration --arn a',
      'lexv2-models describe-bot-recommendation --bot-id b --bot-version v --locale-id l --bot-recommendation-id r',
      'lightsail get-relational-database --relational-database-name d',
      'quicksight describe-asset-bundle-import-job --aws-account-id 1 --asset-bundle-import-job-id j',
    ])('%s is tier 0, marked to have its credential fields hidden', (cmd) => {
      expect(hides(cmd)).toMatchObject({ tier: 0, hideSecrets: true, reason: expect.stringMatching(/fields that hold a credential.*are hidden/) });
    });

    it('marks no other read, and not the reads that are asked', () => {
      for (const cmd of ['lambda get-function-concurrency --function-name f', 'ecs list-task-definitions', 'ecs describe-services --cluster c --services s', 'sts get-caller-identity', 'ec2 describe-instances']) {
        expect(hides(cmd), cmd).not.toHaveProperty('hideSecrets');
      }
      expect(hides('lambda get-function-configuration --function-name f')).toMatchObject({ tier: 2 });
      expect(hides('lambda get-function-configuration --function-name f')).not.toHaveProperty('hideSecrets');
    });

    it('refuses --debug on any call, which prints answers past every filter', () => {
      expect(hides('lambda list-functions --debug')).toMatchObject({ tier: 3, kind: 'aws.debug' });
      expect(hides('ec2 describe-instances --debug')).toMatchObject({ tier: 3, kind: 'aws.debug' });
    });
  });

  describe('reads that mint credentials or tokens are never done, as ecr get-authorization-token is', () => {
    it.each([
      [`redshift get-cluster-credentials --db-user u --cluster-identifier c ${P}`],
      [`redshift get-cluster-credentials-with-iam --cluster-identifier c ${P}`],
      [`redshift get-identity-center-auth-token --cluster-ids c ${P}`],
      [`redshift-serverless get-credentials --workgroup-name w ${P}`],
      [`s3control get-data-access --account-id 1 --target s3://b/* --permission READ ${P}`],
      [`codepipeline get-job-details --job-id j ${P}`],
      [`codepipeline get-third-party-job-details --job-id j --client-token t ${P}`],
      [`glue get-session-endpoint --id i ${P}`],
      [`lightsail get-relational-database-master-user-password --relational-database-name d ${P}`],
      [`lightsail get-instance-access-details --instance-name i ${P}`],
      [`cognito-identity get-credentials-for-identity --identity-id i ${P}`],
      [`cognito-identity get-open-id-token --identity-id i ${P}`],
      [`cognito-identity get-open-id-token-for-developer-identity --identity-pool-id p --logins a=b ${P}`],
      [`cognito-idp get-tokens-from-refresh-token --client-id c --refresh-token r ${P}`],
      [`ssm get-access-token --access-request-id a ${P}`],
      [`acm get-acme-external-account-binding-credentials --acme-account-id a ${P}`],
      [`athena get-session-endpoint --session-id s ${P}`],
      [`bedrock-agentcore get-resource-oauth2-token --resource-credential-provider-name p ${P}`],
      [`bedrock-agentcore get-resource-payment-token --resource-credential-provider-name p ${P}`],
      [`connect get-federation-token --instance-id i ${P}`],
      [`datazone get-environment-credentials --domain-identifier d --environment-identifier e ${P}`],
      [`emr get-cluster-session-credentials --cluster-id c --execution-role-arn r ${P}`],
      [`emr get-session-endpoint --session-id s ${P}`],
      [`emr-serverless get-session-endpoint --application-id a ${P}`],
      [`finspace-data get-programmatic-access-credentials --environment-id e ${P}`],
      [`finspace-data get-external-data-view-access-details --data-view-id d --dataset-id s ${P}`],
      [`gamelift get-compute-access --fleet-id f --compute-name c ${P}`],
      [`gamelift get-compute-auth-token --fleet-id f --compute-name c ${P}`],
      [`lakeformation get-temporary-glue-table-credentials --table-arn t --permissions SELECT ${P}`],
      [`lakeformation get-temporary-glue-partition-credentials --table-arn t --partition v ${P}`],
      [`lakeformation get-temporary-data-location-credentials --data-location s3://b ${P}`],
      [`license-manager get-access-token --token t ${P}`],
      [`kinesis-video-signaling get-ice-server-config --channel-arn c ${P}`],
      [`wickr get-oidc-info --network-id n ${P}`],
      [`rds generate-db-auth-token --hostname h --port 5432 --username u ${P}`],
      [`dsql generate-db-connect-admin-auth-token --hostname h ${P}`],
      [`dsql generate-db-connect-auth-token --hostname h ${P}`],
      [`s3 presign s3://b/k ${P}`],
      // From the review of the fourth round: reads that return a credential, and the ones the verbs hid.
      [`sts get-delegated-access-token --trade-in-token t ${P}`],
      [`sts get-web-identity-token --audience a ${P}`],
      [`sts assume-root --target-principal 1 --task-policy-arn arn:aws:iam::aws:policy/root-task/IAMAuditRootUserCredentials ${P}`],
      [`iam reset-service-specific-credential --service-specific-credential-id i ${P}`],
      [`iam change-password --old-password a --new-password b ${P}`],
      [`emr-containers get-managed-endpoint-session-credentials --endpoint-identifier e --virtual-cluster-identifier v --execution-role-arn r --credential-type TOKEN ${P}`],
      [`bedrock-agentcore get-workload-access-token --workload-name w ${P}`],
      [`bedrock-agentcore get-workload-access-token-for-jwt --workload-name w --user-token t ${P}`],
      [`bedrock-agentcore get-workload-access-token-for-user-id --workload-name w --user-id u ${P}`],
      [`gamelift get-instance-access --fleet-id f --instance-id i ${P}`],
      [`route53globalresolver get-access-token --access-source-id a ${P}`],
      [`finspace get-kx-connection-string --user-arn u --environment-id e --cluster-name c ${P}`],
      [`emr get-on-cluster-app-ui-presigned-url --cluster-id c ${P}`],
      [`emr get-persistent-app-ui-presigned-url --persistent-app-ui-id p ${P}`],
      [`quicksight get-dashboard-embed-url --aws-account-id 1 --dashboard-id d --identity-type IAM ${P}`],
      [`quicksight get-session-embed-url --aws-account-id 1 ${P}`],
      [`ecr get-authorization-token ${P}`],
      [`sts get-session-token ${P}`],
    ])('%s is tier 3', (cmd) => {
      expect(classifyAws(split(cmd), environments)).toMatchObject({ tier: 3, kind: 'aws.credentials' });
    });

    it('leaves their neighbours alone', () => {
      for (const cmd of ['redshift describe-clusters', 'cognito-idp list-user-pools --max-results 5', 'glue get-jobs', 'lightsail get-instances', 's3control list-access-points --account-id 1']) {
        expect(tier(`${cmd} ${P}`), cmd).not.toBe(3);
      }
    });
  });
});

// From the independent review of the fourth round, each reproduced before it was fixed: what the CLI reads in a call that the
// classifier read differently.
describe('aws: a call is read the way the CLI reads it', () => {
  const P = '--profile dev-shop';
  const classify = (cmd: string) => classifyAws(split(cmd), environments);

  it.each([
    // The CLI's shorthand takes file:// after "=", after "@=" with spaces and quotes, or inside brackets.
    ['--filters Name=file:///etc/hostname'],
    ['--filters Name@=file:///etc/hostname'],
    ['--filters Name@="file:///etc/hostname"'],
    ["--filters Name@='file:///etc/hostname'"],
    ['--filters Name@=[file:///etc/hostname]'],
    ['--filters Name=a,Values@="file://$HOME/.aws/config"'],
    ['--filters Name=a,Values=fileb:///etc/hostname'],
    ['--query FILE://x'],
  ])('%s reads a local file, outside the sandbox: never', (flags) => {
    expect(classify(`ec2 describe-instances ${P} ${flags}`)).toMatchObject({ tier: 3, kind: 'aws.local_file' });
  });

  it('refuses an option before the service and the operation that the parser cannot place, and --ca-bundle anywhere', () => {
    expect(classify(`ec2 --foo describe-instances ${P}`)).toMatchObject({ tier: 3, kind: 'aws.option_before_command', invalid: true });
    expect(classify(`--foo bar ec2 describe-instances ${P}`)).toMatchObject({ kind: 'aws.option_before_command' });
    // The review's call: --ca-bundle takes the next word, so the CLI ran terminate-instances.
    expect(classify(`ec2 --ca-bundle describe-instances terminate-instances --instance-ids i-1 ${P}`)).toMatchObject({ tier: 3, kind: 'aws.auth' });
    expect(classify(`ec2 describe-instances --ca-bundle /tmp/ca.pem ${P}`)).toMatchObject({ tier: 3, kind: 'aws.auth' });
    expect(classify(`--cli-auto-prompt ec2 describe-instances ${P}`)).toMatchObject({ tier: 3, kind: 'aws.interactive' });
  });

  it.each([
    `--region us-east-1 ec2 describe-instances ${P}`,
    `--no-paginate ec2 describe-instances ${P}`,
    `--cli-read-timeout 5 --cli-connect-timeout 5 ec2 describe-instances ${P}`,
    `--output json --query Reservations ec2 describe-instances ${P}`,
    `--cli-binary-format raw-in-base64-out ec2 describe-instances ${P}`,
    `ec2 --region us-east-1 describe-instances ${P}`,
  ])('still reads the CLI’s own global options in front: %s', (cmd) => {
    expect(classify(cmd)).toMatchObject({ tier: 0, kind: 'aws.ec2.describe-instances' });
  });

  describe('a read that writes the file named in the call is asked, and never free', () => {
    it.each([
      `iot-data get-thing-shadow --thing-name t /home/u/.zshrc ${P}`,
      `iot-data get-thing-shadow --thing-name t ${P} /home/u/.zshrc`,
      `apigateway get-export --rest-api-id r --stage-name s --export-type oas30 out.json ${P}`,
      `apigateway get-sdk --rest-api-id r --stage-name s --sdk-type javascript out.zip ${P}`,
      `cloudfront get-function --name n out.js ${P}`,
      `appsync get-introspection-schema --api-id a --format SDL out.graphql ${P}`,
      `glacier get-job-output --account-id - --vault-name v --job-id j out.bin ${P}`,
      `s3api get-object-annotation --bucket b --key k out ${P}`,
      `codeartifact get-package-version-asset --domain d --repository r --format npm --package p --package-version 1 --asset a out ${P}`,
      `gamelift get-game-session-log --game-session-id g --save-as /home/u/.bashrc ${P}`,
    ])('%s', (cmd) => {
      expect(classify(cmd)).toMatchObject({ tier: 2 });
    });

    it('says what it would do, and leaves the reads that return text alone', () => {
      expect(classify(`iot-data get-thing-shadow --thing-name t out ${P}`)).toMatchObject({ kind: 'aws.writes_file', reason: expect.stringMatching(/writes its answer to a file.*asked first/) });
      for (const cmd of ['apigateway get-rest-apis', 'cloudfront list-functions', 'glacier list-jobs --account-id - --vault-name v', 'iot-data list-named-shadows-for-thing --thing-name t', 'gamelift describe-game-sessions']) {
        expect(classify(`${cmd} ${P}`).tier, cmd).toBe(0);
      }
    });
  });
});

// Found while checking the CLI against the classifier: aws takes any unique start of an option's name (--prof for
// --profile, --que for --query, --endpoint for --endpoint-url) and the last one given wins, so a check written for a full
// name saw one spelling of it: --profile dev --prof=other ran against `other` as a tier-0 read of dev.
describe('aws: a shortened option is the option', () => {
  const P = '--profile dev-shop';
  const classify = (cmd: string) => classifyAws(split(cmd), environments);

  it.each([
    ['--prof=some-other-profile', '--profile'],
    ['--endpoint=http://127.0.0.1:9', '--endpoint-url'],
    ['--endpoint http://127.0.0.1:9', '--endpoint-url'],
    ['--no-sign', '--no-sign-request'],
    ['--no-verify', '--no-verify-ssl'],
    ['--deb', '--debug'],
    ['--que Functions[].Environment.Variables', '--query'],
    ['--out text', '--output'],
    ['--fol', '--follow'],
    ['--cli-input {}', '--cli-input-'],
    ['--cli-input-j {}', '--cli-input-json'],
    ['--regi us-east-2', '--region'],
    ['--col off', '--color'],
  ])('%s is refused, with the option it shortens named', (flag, full) => {
    expect(classify(`lambda list-functions ${P} ${flag}`)).toMatchObject({ tier: 3, kind: 'aws.shortened_flag', reason: expect.stringContaining(full) });
    expect(classify(`ec2 describe-instances ${P} ${flag}`)).toMatchObject({ tier: 3, kind: 'aws.shortened_flag' });
  });

  it('refuses a second profile that would win, and the endpoint that would take the signature', () => {
    expect(classify('ec2 describe-instances --profile dev-shop --prof=prod-account')).toMatchObject({ tier: 3 });
    expect(classify('ec2 describe-instances --profile dev-shop --endpoint-url http://127.0.0.1:9')).toMatchObject({ tier: 3, kind: 'aws.auth' });
  });

  it.each([
    '--region us-east-1',
    '--output json',
    '--query Reservations[].Instances[].InstanceId',
    '--no-paginate',
    '--max-items 5',
    '--page-size 10',
    '--filters Name=instance-state-name,Values=running',
    '--instance-ids i-0123456789abcdef0',
    '--cli-read-timeout 5',
  ])('does not mistake the option %s, written in full or an option of the operation', (flag) => {
    expect(classify(`ec2 describe-instances ${P} ${flag}`)).toMatchObject({ tier: 0 });
  });
});

describe('AWS saying that a session ran out', () => {
  const real = 'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired';

  it('counts when AWS says it and the call carried nothing like it', () => {
    expect(sessionRanOut(real, ['sts', 'get-caller-identity', '--profile', 'dev'])).toBe(true);
    expect(sessionRanOut(real)).toBe(true);
    expect(sessionRanOut('Error loading SSO Token: Token for dev does not exist', ['x'])).toBe(true);
    expect(sessionRanOut('Error from server (NotFound): pods "x" not found', ['get', 'pods'])).toBe(false);
  });

  it('does not count when the call carried text that says it, which an error repeats', () => {
    expect(sessionRanOut('Invalid id: "ExpiredToken"', ['ec2', 'describe-instances', '--instance-ids', 'ExpiredToken'])).toBe(false);
    expect(sessionRanOut(real, ['ecr', 'describe-images', '--repository-name', 'ExpiredToken'])).toBe(false);
    expect(sessionRanOut('deployments.apps "the session has expired" not found', ['get', 'deployment', 'the session has expired'])).toBe(false);
    // A call that carries the text only in a nested field is as suspect as in a word.
    expect(sessionRanOut(real, carriedStrings({ args: ['a'], extra: { note: ['ExpiredToken'] } }))).toBe(false);
  });

  it('collects every string a request carries, at any depth', () => {
    expect(carriedStrings({ args: ['a', 'b'], n: 3, nested: { x: 'c', y: [{ z: 'd' }] }, flag: true })).toEqual(['a', 'b', 'c', 'd']);
    expect(carriedStrings('x')).toEqual(['x']);
    expect(carriedStrings(undefined)).toEqual([]);
  });
});
