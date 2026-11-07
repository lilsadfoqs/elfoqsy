// Environment variables' values are hidden in what free reads return, names kept (alex, 18 October): Lambda's and
// ECS's, kubectl's get -o json|yaml and describe. Reading the values themselves is reading secrets. First the filter on its
// own, then through the proxies for an agent and for Elfoqsy, with fake backends.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, EventType, PayloadOf } from '@elfoqsy/contracts';
import { Approvals } from '../src/agents/approvals';
import { EventLog } from '../src/eventLog';
import { createProxies } from '../src/permissions';
import { withoutQueryAndOutput } from '../src/permissions/aws';
import { Grants } from '../src/permissions/grants';
import { HIDDEN, hideDescribedEnvironment, hideSecrets, hideInStructuredText, searchJson } from '../src/permissions/hide';
import { hideKubeOutput, outputFormat, projectionReachesEnvironment } from '../src/permissions/kube';
import type { Proxies, ProxyRun } from '../src/permissions/proxy';
import { ManualClock } from './helpers/fakeSdk';
import { environments, fakeBackends, type FakeBackends } from './helpers/proxyFakes';

// Made up and obviously so; the secrets in these fixtures are words, so none is token-shaped.
const SECRET = 'hunter2-not-a-real-secret';

describe('hiding environment variables’ values', () => {
  it('keeps names and hides values in a Lambda answer, the error too being left alone', () => {
    const answer = { Functions: [{ FunctionName: 'f', Runtime: 'nodejs22.x', Environment: { Variables: { DB_PASSWORD: SECRET, MODE: 'prod' }, Error: { ErrorCode: 'x', Message: 'kms denied' } } }, { FunctionName: 'g' }] };
    expect(hideSecrets(answer)).toEqual({
      Functions: [{ FunctionName: 'f', Runtime: 'nodejs22.x', Environment: { Variables: { DB_PASSWORD: HIDDEN, MODE: HIDDEN }, Error: { ErrorCode: 'x', Message: 'kms denied' } } }, { FunctionName: 'g' }],
    });
    expect(JSON.stringify(hideSecrets(answer))).not.toContain(SECRET);
  });

  it('hides a task definition’s and a task’s container environment, and leaves references to secrets as they are', () => {
    const definition = { taskDefinition: { family: 'shop-api', containerDefinitions: [{ name: 'app', image: 'shop-api:1', environment: [{ name: 'A', value: SECRET }, { name: 'B', value: '1' }], secrets: [{ name: 'S', valueFrom: 'arn:aws:secretsmanager:us-west-2:111111111111:secret:x' }], environmentFiles: [{ value: 'arn:aws:s3:::b/env', type: 's3' }] }] } };
    const hidden = hideSecrets(definition) as typeof definition;
    expect(hidden.taskDefinition.containerDefinitions[0]!.environment).toEqual([{ name: 'A', value: HIDDEN }, { name: 'B', value: HIDDEN }]);
    expect(hidden.taskDefinition.containerDefinitions[0]!.secrets).toEqual(definition.taskDefinition.containerDefinitions[0]!.secrets);
    expect(hidden.taskDefinition.containerDefinitions[0]!.environmentFiles).toEqual(definition.taskDefinition.containerDefinitions[0]!.environmentFiles);
    const tasks = { tasks: [{ taskArn: 't', overrides: { containerOverrides: [{ name: 'app', environment: [{ name: 'TOKEN_FOR_X', value: SECRET }] }] } }] };
    expect(JSON.stringify(hideSecrets(tasks))).not.toContain(SECRET);
    expect(JSON.stringify(hideSecrets(tasks))).toContain('TOKEN_FOR_X');
  });

  it('hides a pod or workload’s env, in init containers and templates too, and the manifest kubectl keeps in an annotation', () => {
    const deployment = {
      kind: 'Deployment',
      metadata: { name: 'shop-api', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': `{"env":[{"name":"A","value":"${SECRET}"}]}`, 'team': 'shop' } },
      spec: {
        template: {
          spec: {
            initContainers: [{ name: 'init', env: [{ name: 'I', value: SECRET }] }],
            containers: [{ name: 'app', image: 'shop-api:1', env: [{ name: 'A', value: SECRET }, { name: 'K', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }, { name: 'N', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }] }],
          },
        },
      },
    };
    const hidden = hideSecrets(deployment) as typeof deployment;
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    const [app] = hidden.spec.template.spec.containers;
    expect(app!.env).toEqual([{ name: 'A', value: HIDDEN }, { name: 'K', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }, { name: 'N', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }]);
    expect(hidden.spec.template.spec.initContainers[0]!.env).toEqual([{ name: 'I', value: HIDDEN }]);
    expect(hidden.metadata.annotations).toEqual({ 'kubectl.kubernetes.io/last-applied-configuration': HIDDEN, team: 'shop' });
    // The image and the names stay: that is what "which version runs where" needs.
    expect(app!.image).toBe('shop-api:1');
  });

  it('hides a service’s Environment map (SageMaker’s kind) and touches no other "value"', () => {
    expect(hideSecrets({ Environment: { A: SECRET, B: 'x' } })).toEqual({ Environment: { A: HIDDEN, B: HIDDEN } });
    const other = { metadata: { labels: { value: 'v' } }, spec: { replicas: 3 }, status: { conditions: [{ type: 'Ready', value: 'True' }] } };
    expect(hideSecrets(other)).toEqual(other);
  });

  it('hides the environment under every key that holds one, keeping the names and the configuration around it', () => {
    // CodeBuild: an object that describes the build environment and holds the variables. Only the variables go.
    const build = { projects: [{ name: 'p', environment: { type: 'LINUX_CONTAINER', image: 'aws/codebuild/standard:7.0', computeType: 'BUILD_GENERAL1_SMALL', environmentVariables: [{ name: 'NPM_TOKEN', value: SECRET, type: 'PLAINTEXT' }] } }] };
    expect(hideSecrets(build)).toEqual({ projects: [{ name: 'p', environment: { type: 'LINUX_CONTAINER', image: 'aws/codebuild/standard:7.0', computeType: 'BUILD_GENERAL1_SMALL', environmentVariables: [{ name: 'NPM_TOKEN', value: HIDDEN, type: 'PLAINTEXT' }] } }] });
    // Maps of names to values, under the keys the services use for them.
    for (const shape of [
      { apps: [{ environmentVariables: { A: SECRET } }] },
      { Job: { DefaultArguments: { '--password': SECRET, '--job-language': 'python' } } },
      { item: [{ variables: { A: SECRET } }] },
      { AutomationExecution: { Variables: { A: [SECRET] } } },
      { Service: { SourceConfiguration: { ImageRepository: { ImageConfiguration: { RuntimeEnvironmentVariables: { A: SECRET } } } } } },
      { notebookExecution: { EnvironmentVariables: { A: SECRET } } },
      { Target: { EcsTaskParameters: { Overrides: { ContainerOverrides: [{ Environment: [{ Name: 'A', Value: SECRET }] }] } } } },
      { Findings: [{ Resources: [{ Details: { AwsEcsTaskDefinition: { ContainerDefinitions: [{ Environment: [{ Name: 'A', Value: SECRET }] }] } } }] }] },
      { Environment: [{ Name: 'A', Value: SECRET }] },
      { pipelineExecution: { variables: [{ name: 'A', resolvedValue: SECRET }] } },
    ]) {
      const hidden = JSON.stringify(hideSecrets(shape));
      expect(hidden, hidden).not.toContain(SECRET);
      expect(hidden).toContain('"A"'.replace('"A"', hidden.includes('--password') ? '--password' : 'A'));
    }
    // An environment variable named like a key does not turn the map into a description.
    expect(hideSecrets({ Environment: { Variables: SECRET, env: SECRET } })).toEqual({ Environment: { Variables: HIDDEN, env: HIDDEN } });
    // A plain word under "environment" is a name, not a map.
    expect(hideSecrets({ environment: 'dev', Environment: 'prod' })).toEqual({ environment: 'dev', Environment: 'prod' });
  });

  it('hides a field that holds a credential and keeps the field, and the fields around it', () => {
    const answer = {
      UserPoolClient: { ClientId: 'c', ClientName: 'web', ClientSecret: SECRET, TokenValidityUnits: { AccessToken: 'hours' } },
      ClientSecrets: [{ ClientSecretId: 'i', ClientSecretValue: SECRET }],
      Distribution: { Origins: { Items: [{ Id: 'o', CustomHeaders: { Items: [{ HeaderName: 'X-Origin-Verify', HeaderValue: SECRET }] } }] } },
      webhooks: [{ definition: { name: 'w', authentication: 'GITHUB_HMAC', authenticationConfiguration: { SecretToken: SECRET } } }],
      VpnConnections: [{ VpnConnectionId: 'vpn-1', CustomerGatewayConfiguration: `<vpn_connection><pre_shared_key>${SECRET}</pre_shared_key></vpn_connection>`, Options: { TunnelOptions: [{ OutsideIpAddress: '203.0.113.1', PreSharedKey: SECRET }] } }],
      Protocol: { SMB: { Domain: 'd', Password: SECRET, User: 'u' } },
      SourceControlDetails: { Provider: 'GITHUB', AuthStrategy: 'PERSONAL_ACCESS_TOKEN', AuthToken: SECRET },
      app: { basicAuthCredentials: SECRET, name: 'a' },
      LaunchTemplateData: { InstanceType: 't3.micro', UserData: SECRET },
      passwordPolicy: { minimumLength: 8 },
    };
    const hidden = hideSecrets(answer) as Record<string, any>;
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(hidden.UserPoolClient).toEqual({ ClientId: 'c', ClientName: 'web', ClientSecret: HIDDEN, TokenValidityUnits: { AccessToken: 'hours' } });
    expect(hidden.ClientSecrets).toEqual([{ ClientSecretId: 'i', ClientSecretValue: HIDDEN }]);
    expect(hidden.Distribution.Origins.Items[0].CustomHeaders.Items).toEqual([{ HeaderName: 'X-Origin-Verify', HeaderValue: HIDDEN }]);
    expect(hidden.webhooks[0].definition).toEqual({ name: 'w', authentication: 'GITHUB_HMAC', authenticationConfiguration: { SecretToken: HIDDEN } });
    expect(hidden.VpnConnections[0]).toEqual({ VpnConnectionId: 'vpn-1', CustomerGatewayConfiguration: HIDDEN, Options: { TunnelOptions: [{ OutsideIpAddress: '203.0.113.1', PreSharedKey: HIDDEN }] } });
    expect(hidden.Protocol.SMB).toEqual({ Domain: 'd', Password: HIDDEN, User: 'u' });
    expect(hidden.SourceControlDetails).toEqual({ Provider: 'GITHUB', AuthStrategy: 'PERSONAL_ACCESS_TOKEN', AuthToken: HIDDEN });
    expect(hidden.LaunchTemplateData).toEqual({ InstanceType: 't3.micro', UserData: HIDDEN });
    // A field whose name only contains the word is not one, and an object under such a name is walked, not blanked.
    expect(hidden.passwordPolicy).toEqual({ minimumLength: 8 });
    expect(hideSecrets({ spec: { clientSecret: { name: 'oidc', key: 'secret' } } })).toEqual({ spec: { clientSecret: { name: 'oidc', key: 'secret' } } });
  });

  it('hides what the review found shown: environment written as JSON text, exported variables, canary overrides, log options', () => {
    // CodePipeline writes a CodeBuild action's environment variables as a string of JSON.
    const pipeline = { pipeline: { stages: [{ actions: [{ configuration: { ProjectName: 'p', EnvironmentVariables: JSON.stringify([{ name: 'DB_PASSWORD', value: SECRET, type: 'PLAINTEXT' }]) } }] }] } };
    const hidden = hideSecrets(pipeline) as typeof pipeline;
    const written = hidden.pipeline.stages[0]!.actions[0]!.configuration.EnvironmentVariables;
    expect(written).not.toContain(SECRET);
    expect(JSON.parse(written)).toEqual([{ name: 'DB_PASSWORD', value: HIDDEN, type: 'PLAINTEXT' }]);
    expect(hidden.pipeline.stages[0]!.actions[0]!.configuration.ProjectName).toBe('p');
    // A string that is not JSON stays; one that looks like JSON and is not is hidden whole.
    expect(hideSecrets({ environment: 'dev' })).toEqual({ environment: 'dev' });
    expect(hideSecrets({ EnvironmentVariables: `[{"name": "A", "value": "${SECRET}` })).toEqual({ EnvironmentVariables: HIDDEN });
    for (const shape of [
      { builds: [{ exportedEnvironmentVariables: [{ name: 'A', value: SECRET }] }] },
      { item: [{ stageName: 's', variables: { A: 'x' }, canarySettings: { stageVariableOverrides: { A: SECRET } } }] },
      { Item: [{ StageVariables: { A: SECRET } }] },
      { Environment: { AirflowConfigurationOptions: { 'core.fernet_key': SECRET } } },
      { OptionSettings: [{ Namespace: 'aws:elasticbeanstalk:application:environment', OptionName: 'DB', Value: SECRET }] },
      { JobRun: { Arguments: { '--api-key': SECRET } } },
      { Triggers: [{ Actions: [{ Arguments: { '--p': SECRET } }] }] },
    ]) expect(JSON.stringify(hideSecrets(shape)), JSON.stringify(shape)).not.toContain(SECRET);
    // The log driver's options: the credentials go, the group and the region stay.
    const task = { containerDefinitions: [{ name: 'app', logConfiguration: { logDriver: 'splunk', options: { 'splunk-token': SECRET, 'splunk-url': 'https://splunk.example.test', apikey: SECRET, 'awslogs-group': 'g' } } }] };
    expect(hideSecrets(task)).toEqual({ containerDefinitions: [{ name: 'app', logConfiguration: { logDriver: 'splunk', options: { 'splunk-token': HIDDEN, 'splunk-url': 'https://splunk.example.test', apikey: HIDDEN, 'awslogs-group': 'g' } } }] });
  });

  it('hides any field named ...Password, and the login in a connection URL', () => {
    const answer = { DBInstances: [{ DBInstanceIdentifier: 'd', PendingModifiedValues: { MasterUserPassword: SECRET, AllocatedStorage: 20 } }], Endpoints: [{ SaslPassword: SECRET, SslClientKeyPassword: SECRET, EndpointIdentifier: 'e' }], webhook: { url: 'https://x.test', secret: SECRET } };
    const hidden = hideSecrets(answer) as typeof answer;
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(hidden.DBInstances[0]!.PendingModifiedValues).toEqual({ MasterUserPassword: HIDDEN, AllocatedStorage: 20 });
    expect(hidden.webhook).toEqual({ url: 'https://x.test', secret: HIDDEN });
    const connection = { Connection: { ConnectionProperties: { JDBC_CONNECTION_URL: `jdbc:postgresql://db.internal:5432/app?user=app&password=${SECRET}`, HOST: 'db.internal' } } };
    expect(JSON.stringify(hideSecrets(connection))).not.toContain(SECRET);
    expect((hideSecrets(connection) as typeof connection).Connection.ConnectionProperties.HOST).toBe('db.internal');
    expect(hideSecrets({ Connection: { ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:postgresql://db.internal:5432/app' } } })).toEqual({ Connection: { ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:postgresql://db.internal:5432/app' } } });
  });

  it('hides the secret properties of a Glue connection and keeps the rest', () => {
    const connection = { Connection: { Name: 'c', ConnectionProperties: { HOST: 'db.internal', PORT: '5432', USERNAME: 'app', PASSWORD: SECRET, SECRET_ID: 'prod/db', KAFKA_CLIENT_KEYSTORE_PASSWORD: SECRET, ENCRYPTED_PASSWORD: SECRET, KAFKA_SASL_SCRAM_SECRETS_ARN: 'arn:aws:secretsmanager:x' } } };
    expect(hideSecrets(connection)).toEqual({ Connection: { Name: 'c', ConnectionProperties: { HOST: 'db.internal', PORT: '5432', USERNAME: 'app', PASSWORD: HIDDEN, SECRET_ID: 'prod/db', KAFKA_CLIENT_KEYSTORE_PASSWORD: HIDDEN, ENCRYPTED_PASSWORD: HIDDEN, KAFKA_SASL_SCRAM_SECRETS_ARN: 'arn:aws:secretsmanager:x' } } });
  });

  it('reads JSON and YAML, one document or several, in the same form, and shows nothing it cannot read', () => {
    const json = hideInStructuredText(JSON.stringify({ spec: { containers: [{ name: 'a', env: [{ name: 'X', value: SECRET }] }] } }), 'json')!;
    expect(JSON.parse(json).spec.containers[0].env).toEqual([{ name: 'X', value: HIDDEN }]);
    const yaml = hideInStructuredText(`kind: Pod\nspec:\n  containers:\n    - name: a\n      env:\n        - name: X\n          value: ${SECRET}\n---\nkind: Pod\nspec:\n  containers:\n    - name: b\n      env:\n        - {name: Y, value: ${SECRET}}\n`, 'yaml')!;
    expect(yaml).not.toContain(SECRET);
    expect(yaml).toContain('name: X');
    expect(yaml).toContain('name: Y');
    expect(yaml.split('---\n')).toHaveLength(2);
    expect(hideInStructuredText('not json {', 'json')).toBeNull();
    expect(hideInStructuredText('a: [unclosed', 'yaml')).toBeNull();
  });

  describe('kubectl describe', () => {
    const describe_ = `Name:         shop-api-0
Containers:
  app:
    Image:      shop-api:1
    Environment:
      MODE:        prod
      DB_PASSWORD: ${SECRET}
      FROM_SECRET: <set to the key 'password' in secret 'db'>  Optional: false
      FROM_FIELD:  (v1:metadata.name)
      LIMIT:       (limits.cpu)
      TRICK:       <set to the key 'x' in secret 'y'> but really ${SECRET}
    Mounts:
      /data from vol (rw)
  sidecar:
    Environment:  <none>
    Mounts:       <none>
  third:
    Environment Variables from:
      cfg  ConfigMap  Optional: false
    Environment:
      PEM: -----BEGIN KEY-----
MIIBVwIBADANBgkq${SECRET}
-----END KEY-----
    Mounts:
      /x from y (rw)
Conditions:
  Type    Status
  Ready   True
`;

    it('hides each entry’s value, keeps names and references, and keeps the rest of the text', () => {
      const out = hideDescribedEnvironment(describe_);
      expect(out).not.toContain(SECRET);
      expect(out).toContain(`MODE:        ${HIDDEN}`);
      expect(out).toContain(`DB_PASSWORD: ${HIDDEN}`);
      expect(out).toContain("FROM_SECRET: <set to the key 'password' in secret 'db'>  Optional: false");
      expect(out).toContain('FROM_FIELD:  (v1:metadata.name)');
      expect(out).toContain('LIMIT:       (limits.cpu)');
      // A value that only begins like a reference is a value.
      expect(out).toContain(`TRICK:       ${HIDDEN}`);
      expect(out).toContain('Environment:  <none>');
      expect(out).toContain('Environment Variables from:\n      cfg  ConfigMap  Optional: false');
      expect(out).toContain('Image:      shop-api:1');
      expect(out).toContain('/data from vol (rw)');
      expect(out).toContain('Conditions:\n  Type    Status\n  Ready   True');
    });

    it('hides a value that runs over several lines, up to the next heading', () => {
      const out = hideDescribedEnvironment(describe_);
      expect(out).toContain(`PEM: ${HIDDEN}`);
      expect(out).not.toContain('MIIBVwIBADANBgkq');
      expect(out).not.toContain('END KEY');
      expect(out).toContain('Mounts:\n      /x from y (rw)');
    });
  });
});

describe('what a call asks for, as kubectl and aws read it', () => {
  it('reads kubectl’s output format in every spelling, the last one winning', () => {
    expect(outputFormat(['get', 'pods', '-o', 'json'])).toEqual({ name: 'json', spec: '' });
    expect(outputFormat(['get', 'pods', '-ojson'])).toEqual({ name: 'json', spec: '' });
    expect(outputFormat(['get', 'pods', '--output=yaml'])).toEqual({ name: 'yaml', spec: '' });
    expect(outputFormat(['get', 'pods', '--output', 'wide'])).toEqual({ name: 'wide', spec: '' });
    expect(outputFormat(['get', 'pods', '-o', 'json', '-o', 'jsonpath={.items[*].metadata.name}'])).toEqual({ name: 'jsonpath', spec: '{.items[*].metadata.name}' });
    expect(outputFormat(['get', 'pods'])).toBeUndefined();
  });

  it.each([
    // What reaches a value, or an object that holds them.
    ['jsonpath', '{.items[*].spec.containers[*].env}', true],
    ['jsonpath', '{.items[*].spec.template.spec.containers[*].env[*].value}', true],
    ['jsonpath', '{.spec.template.spec.containers[0]}', true],
    ['jsonpath', '{.spec.template.spec.containers[*]}', true],
    ['jsonpath', '{.items[*].spec}', true],
    ['jsonpath', '{.items[*]}', true],
    ['jsonpath', '{.items}', true],
    ['jsonpath', '{@}', true],
    ['jsonpath', '{.}', true],
    ['jsonpath', '{..env}', true],
    ['jsonpath', '{..value}', true],
    ['jsonpath', '{.metadata.annotations}', true],
    ['jsonpath', '{.metadata}', true],
    ['jsonpath', "{.items[*]['spec']}", true],
    ['jsonpath', '{.metadata.annotations.kubectl\\.kubernetes\\.io/last-applied-configuration}', true],
    ['jsonpath', '{range .items[*]}{.metadata.name}{"\\n"}{.spec}{end}', true],
    ['jsonpath', '', true],
    ['jsonpath-as-json', '{.items[*].spec.containers[*]}', true],
    ['custom-columns', 'NAME:.metadata.name,ENV:.spec.containers[*].env', true],
    ['custom-columns', 'NAME:.metadata.name,C:.spec.containers[*]', true],
    ['go-template', '{{ range .items }}{{ .metadata.name }}{{ end }}', true],
    ['template', '{{ . }}', true],
    // What cannot: names, images, counts and labels.
    ['jsonpath', '{.items[*].metadata.name}', false],
    ['jsonpath', '{.items[*].spec.containers[*].image}', false],
    ['jsonpath', '{.spec.template.spec.containers[0].image}', false],
    ['jsonpath', '{.status.availableReplicas}', false],
    ['jsonpath', '{.metadata.labels.app}', false],
    ['jsonpath', '{range .items[*]}{.metadata.name}{"\\t"}{.spec.containers[*].image}{"\\n"}{end}', false],
    ['jsonpath', '{.items[?(@.metadata.name=="shop-api")].spec.containers[*].image}', false],
    ['custom-columns', 'NAME:.metadata.name,IMAGE:.spec.containers[*].image', false],
    ['custom-columns', 'NAME:.metadata.name,READY:.status.readyReplicas', false],
    ['json', '', false],
    ['yaml', '', false],
    ['wide', '', false],
    ['name', '', false],
  ])('-o %s=%s reaches a value: %s', (name, spec, expected) => {
    expect(projectionReachesEnvironment({ name, spec })).toBe(expected);
  });

  it('takes --query and --output off an AWS call and keeps the rest, the last --query winning', () => {
    expect(withoutQueryAndOutput(['lambda', 'list-functions', '--query', 'Functions[].FunctionName', '--output', 'text', '--profile', 'dev'])).toEqual({ args: ['lambda', 'list-functions', '--profile', 'dev'], query: 'Functions[].FunctionName' });
    expect(withoutQueryAndOutput(['lambda', 'list-functions', '--query=a', '--output=table', '--query=b', '--profile', 'dev'])).toEqual({ args: ['lambda', 'list-functions', '--profile', 'dev'], query: 'b' });
    expect(withoutQueryAndOutput(['lambda', 'list-functions', '--profile', 'dev'])).toEqual({ args: ['lambda', 'list-functions', '--profile', 'dev'] });
  });

  it('runs a JMESPath query on a JSON value', () => {
    expect(searchJson({ Functions: [{ FunctionName: 'a', Runtime: 'x' }, { FunctionName: 'b', Runtime: 'y' }] }, "Functions[?Runtime=='y'].FunctionName")).toEqual(['b']);
    expect(() => searchJson({}, 'Functions[')).toThrow();
  });
});

describe('through the proxies', () => {
  const T0 = Date.parse('2026-10-18T08:00:00Z');
  const P = '--profile dev-shop';
  const DEV = '--context dev';
  const run: ProxyRun = { runId: 'run-7', ticket: 'SHOP-3492', agentNumber: 7, branch: 'feature/SHOP-3492', targets: [], kubeconfig: '/data/runs/run-7/kubeconfig' };
  const hers: ProxyRun = { runId: 'elfoqsy', ticket: '', agentNumber: 0, branch: '', targets: [], kubeconfig: '/data/runs/elfoqsy/kubeconfig', actor: 'elfoqsy' };
  let clock: ManualClock;
  let log: EventLog;
  let approvals: Approvals;
  let grants: Grants;
  let backends: FakeBackends;
  let proxies: Proxies;

  const events = (type?: AnyEnvelope['type']) => log.readFrom(0, 100_000).filter((e) => !type || e.type === type);
  const payloads = <T extends EventType>(type: T) => events(type).map((e) => e.payload as PayloadOf<T>);
  const aws = (cmd: string, as: ProxyRun = run) => (as === hers ? proxies.read(hers, 'aws', { args: cmd.split(' ') }) : proxies.request(run, 'aws', { args: cmd.split(' ') }));
  const kube = (cmd: string, as: ProxyRun = run) => (as === hers ? proxies.read(hers, 'kube', { args: cmd.split(' ') }) : proxies.request(run, 'kube', { args: cmd.split(' ') }));

  const functions = JSON.stringify({ Functions: [{ FunctionName: 'shop-api-hook', Runtime: 'nodejs22.x', Environment: { Variables: { DB_PASSWORD: SECRET, STAGE: 'dev' } } }, { FunctionName: 'plain' }] });
  const deployment = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: 'Deployment',
      metadata: { name: 'shop-api', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': `{"env":[{"name":"A","value":"${SECRET}"}]}` } },
      spec: { template: { spec: { containers: [{ name: 'app', image: '123.dkr.ecr.us-west-2.amazonaws.com/shop-api:feature-SHOP-3492-9f3c2ab', env: [{ name: 'DB_PASSWORD', value: SECRET }, { name: 'KEY', valueFrom: { secretKeyRef: { name: 'db', key: 'k' } } }] }] } } },
      ...extra,
    });

  beforeEach(() => {
    clock = new ManualClock(T0);
    log = new EventLog(':memory:', () => new Date(clock.now));
    backends = fakeBackends();
    approvals = new Approvals(log, undefined, clock);
    grants = new Grants(log, { clock, now: () => clock.now });
    proxies = createProxies({ log, approvals, grants, environments, backends, repos: [], say: () => undefined, now: () => clock.now });
    proxies.register(run);
  });

  afterEach(() => {
    proxies.close();
    grants.close();
    approvals.close();
    log.close();
  });

  describe.each([
    ['an agent', run],
    ['Elfoqsy', hers],
  ] as const)('%s', (_who, as) => {
    it('lists Lambda functions with the values hidden and the names kept, as JSON whatever --output says', async () => {
      backends.awsAnswers.set('lambda list-functions', { ok: true, stdout: functions, stderr: '' });
      const r = await aws(`lambda list-functions --output text ${P}`, as);
      expect(r.ok).toBe(true);
      expect(r.text).not.toContain(SECRET);
      expect(JSON.parse(r.text).Functions[0].Environment.Variables).toEqual({ DB_PASSWORD: HIDDEN, STAGE: HIDDEN });
      expect(JSON.parse(r.text).Functions[0].FunctionName).toBe('shop-api-hook');
      // The call went out with --output json and without the caller's --output.
      expect(backends.calls.aws.at(-1)).toEqual(['lambda', 'list-functions', '--profile', 'dev-shop', '--output', 'json']);
      expect(payloads('action.classified').at(-1)).toMatchObject({ tier: 0, decision: 'run', kind: 'aws.lambda.list-functions' });
      expect(JSON.stringify(events())).not.toContain(SECRET);
    });

    it('runs --query on the hidden answer: names come out, values never do', async () => {
      backends.awsAnswers.set('lambda list-functions', { ok: true, stdout: functions, stderr: '' });
      expect(JSON.parse((await aws(`lambda list-functions --query Functions[].FunctionName ${P}`, as)).text)).toEqual(['shop-api-hook', 'plain']);
      expect((await aws(`lambda list-functions --query Functions[0].Environment.Variables ${P}`, as)).text).not.toContain(SECRET);
      expect(JSON.parse((await aws(`lambda list-functions --query=Functions[0].Environment.Variables.DB_PASSWORD ${P}`, as)).text)).toBe(HIDDEN);
      expect(JSON.parse((await aws(`lambda list-functions --query Functions[?Environment.Variables.STAGE].FunctionName ${P}`, as)).text)).toEqual(['shop-api-hook']);
      // The query never reached AWS.
      for (const call of backends.calls.aws) expect(call).not.toContain('--query');
    });

    it('hides ECS’s task definition and task environment', async () => {
      const definition = JSON.stringify({ taskDefinition: { containerDefinitions: [{ name: 'app', environment: [{ name: 'TOKEN', value: SECRET }], secrets: [{ name: 'S', valueFrom: 'arn:x' }] }] } });
      backends.awsAnswers.set('ecs describe-task-definition', { ok: true, stdout: definition, stderr: '' });
      const d = await aws(`ecs describe-task-definition --task-definition t ${P}`, as);
      expect(d.ok).toBe(true);
      expect(d.text).not.toContain(SECRET);
      expect(d.text).toContain('TOKEN');
      expect(d.text).toContain('arn:x');
      backends.awsAnswers.set('ecs describe-tasks', { ok: true, stdout: JSON.stringify({ tasks: [{ overrides: { containerOverrides: [{ environment: [{ name: 'T', value: SECRET }] }] } }] }), stderr: '' });
      expect((await aws(`ecs describe-tasks --cluster c --tasks t ${P}`, as)).text).not.toContain(SECRET);
    });

    it('hides the credential fields of a read that returns them, keeps the fields, and lets no --query bring one out', async () => {
      const distribution = JSON.stringify({ DistributionConfig: { Origins: { Items: [{ Id: 'o', CustomHeaders: { Items: [{ HeaderName: 'X-Origin-Verify', HeaderValue: SECRET }] } }] } } });
      backends.awsAnswers.set('cloudfront get-distribution-config', { ok: true, stdout: distribution, stderr: '' });
      const r = await aws(`cloudfront get-distribution-config --id d ${P}`, as);
      expect(r.ok).toBe(true);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).toContain('X-Origin-Verify');
      const q = await aws(`cloudfront get-distribution-config --id d --query DistributionConfig.Origins.Items[0].CustomHeaders.Items[0].HeaderValue ${P}`, as);
      expect(JSON.parse(q.text)).toBe(HIDDEN);
      for (const call of backends.calls.aws) expect(call).not.toContain('--query');
      expect(JSON.stringify(events())).not.toContain(SECRET);
    });

    // His condition for keeping the reads that return a pre-signed URL free (18 October): the signature never reaches the
    // model that reads the answer, nor the log.
    describe('a pre-signed URL in what a read returns', () => {
      const SIGNED = {
        aws: `https://shop-layers.s3.us-west-2.amazonaws.com/layers/x.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=made-up&X-Amz-Date=20261018T080000Z&X-Amz-Expires=600&X-Amz-Security-Token=session-word-not-a-token&X-Amz-Signature=signature-word-not-a-signature`,
        google: 'https://storage.example.test/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=google-word-not-a-signature',
        cloudfront: 'https://d111.cloudfront.example.test/o?Expires=1&Signature=cloudfront-word-not-a-signature~&Key-Pair-Id=K1',
        azure: 'https://acct.blob.example.test/c/o?sv=2022-11-02&sig=YXp1cmUtd29yZC1ub3QtYS1zaWduYXR1cmU%3D&se=2026-10-18',
      };
      const WORDS = ['session-word-not-a-token', 'signature-word-not-a-signature', 'google-word-not-a-signature', 'cloudfront-word-not-a-signature', 'YXp1cmUtd29yZC1ub3QtYS1zaWduYXR1cmU'];

      it('is read as it is, its signature and token gone and the rest of the link kept, in a read that is free', async () => {
        const layer = JSON.stringify({ LayerVersionArn: 'arn:aws:lambda:us-west-2:111111111111:layer:x:1', Content: { Location: SIGNED.aws, CodeSize: 100 }, Other: [SIGNED.google, SIGNED.cloudfront, SIGNED.azure] });
        backends.awsAnswers.set('lambda get-layer-version', { ok: true, stdout: layer, stderr: '' });
        const r = await aws(`lambda get-layer-version --layer-name x --version-number 1 ${P}`, as);
        expect(r.ok).toBe(true);
        expect(payloads('action.classified').at(-1)).toMatchObject({ tier: 0, decision: 'run' });
        for (const word of WORDS) expect(r.text, word).not.toContain(word);
        expect(r.text).toContain('shop-layers.s3.us-west-2.amazonaws.com/layers/x.zip');
        expect(r.text).toContain('X-Amz-Signature=[redacted');
        expect(r.text).toContain('"CodeSize":100');
        for (const word of WORDS) expect(JSON.stringify(events()), word).not.toContain(word);
      });

      it('is gone from a kubectl answer as well', async () => {
        backends.kubeAnswers.set('get configmap', { ok: true, stdout: JSON.stringify({ kind: 'ConfigMap', data: { url: SIGNED.aws, other: SIGNED.google } }), stderr: '' });
        const r = await kube(`${DEV} get configmap x -o json`, as);
        for (const word of WORDS) expect(r.text, word).not.toContain(word);
        for (const word of WORDS) expect(JSON.stringify(events()), word).not.toContain(word);
      });
    });

    it('refuses a shortened option before anything runs, and logs the refusal', async () => {
      for (const cmd of [`lambda list-functions --que Functions[].Environment.Variables ${P}`, `ec2 describe-instances --prof=another-profile ${P}`, `ec2 describe-instances --endpoint=http://127.0.0.1:9 ${P}`, `lambda list-functions --out text ${P}`]) {
        const r = await aws(cmd, as);
        expect(r, cmd).toMatchObject({ ok: false, text: expect.stringMatching(/^Refused: .*Write the option in full/) });
        expect(payloads('action.classified').at(-1), cmd).toMatchObject({ tier: 3, decision: 'refuse', kind: 'aws.shortened_flag' });
      }
      expect(backends.calls.aws).toEqual([]);
    });

    it('shows nothing it cannot understand, and passes an error through', async () => {
      backends.awsAnswers.set('lambda list-functions', { ok: true, stdout: 'Functions\tshop-api-hook\tDB_PASSWORD=x', stderr: '' });
      const text = await aws(`lambda list-functions ${P}`, as);
      expect(text).toMatchObject({ ok: false, text: expect.stringContaining('cannot be hidden') });
      expect(text.text).not.toContain('DB_PASSWORD=x');
      backends.awsAnswers.set('lambda list-versions-by-function', { ok: false, stdout: '', stderr: 'An error occurred (ResourceNotFoundException) when calling the ListVersionsByFunction operation: Function not found' });
      expect(await aws(`lambda list-versions-by-function --function-name nope ${P}`, as)).toMatchObject({ ok: false, text: expect.stringContaining('Function not found') });
      expect(await aws(`lambda list-functions --query Functions[ ${P}`, as)).toMatchObject({ ok: false });
    });

    it('lists a deployment with -o json or -o yaml, the values hidden, names, images and references kept', async () => {
      backends.kubeAnswers.set('get deployments -o json', { ok: true, stdout: deployment(), stderr: '' });
      const j = await kube(`${DEV} get deployments -o json`, as);
      expect(j.ok).toBe(true);
      expect(j.text).not.toContain(SECRET);
      const container = JSON.parse(j.text).spec.template.spec.containers[0];
      expect(container.env).toEqual([{ name: 'DB_PASSWORD', value: HIDDEN }, { name: 'KEY', valueFrom: { secretKeyRef: { name: 'db', key: 'k' } } }]);
      expect(container.image).toContain('shop-api:feature-SHOP-3492-9f3c2ab');
      expect(JSON.parse(j.text).metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']).toBe(HIDDEN);

      const yaml = `kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: shop-api:1\n          env:\n            - name: DB_PASSWORD\n              value: ${SECRET}\n`;
      backends.kubeAnswers.set('get deployments -oyaml', { ok: true, stdout: yaml, stderr: '' });
      const y = await kube(`${DEV} get deployments -oyaml`, as);
      expect(y.text).not.toContain(SECRET);
      expect(y.text).toContain('DB_PASSWORD');
      expect(y.text).toContain('image: shop-api:1');
    });

    it('describes a pod with the values hidden, and shows the wide table and the images as they are', async () => {
      backends.kubeAnswers.set('describe pod', { ok: true, stdout: `Name: p\nContainers:\n  app:\n    Environment:\n      DB_PASSWORD: ${SECRET}\n    Mounts: <none>\n`, stderr: '' });
      const d = await kube(`${DEV} describe pod p`, as);
      expect(d.text).not.toContain(SECRET);
      expect(d.text).toContain(`DB_PASSWORD: ${HIDDEN}`);
      const table = 'NAME            READY   IMAGES\nshop-api    1/1     123.dkr.ecr.us-west-2.amazonaws.com/shop-api:master-4d1e0aa';
      backends.kubeAnswers.set('get deployments -o wide', { ok: true, stdout: table, stderr: '' });
      expect((await kube(`${DEV} get deployments -o wide`, as)).text).toBe(table);
      backends.kubeAnswers.set('get deployments -o jsonpath', { ok: true, stdout: 'shop-api:master-4d1e0aa', stderr: '' });
      expect((await kube(`${DEV} get deployments -o jsonpath={.items[*].spec.template.spec.containers[*].image}`, as)).text).toBe('shop-api:master-4d1e0aa');
    });

    it('shows a --raw JSON answer with the values hidden, and a raw endpoint that is not JSON as it is', async () => {
      backends.kubeAnswers.set('get --raw /api/v1/namespaces/shop-dev/pods', { ok: true, stdout: JSON.stringify({ items: [{ spec: { containers: [{ name: 'a', env: [{ name: 'X', value: SECRET }] }] } }] }), stderr: '' });
      expect((await kube(`${DEV} get --raw /api/v1/namespaces/shop-dev/pods`, as)).text).not.toContain(SECRET);
      backends.kubeAnswers.set('get --raw /metrics', { ok: true, stdout: '# HELP up\nup 1', stderr: '' });
      expect((await kube(`${DEV} get --raw /metrics`, as)).text).toBe('# HELP up\nup 1');
    });

    it('does not show a -o json answer it cannot parse, but passes a failure’s error through', async () => {
      backends.kubeAnswers.set('get deployments -o json', { ok: true, stdout: `{"spec": ${SECRET}`, stderr: '' });
      const broken = await kube(`${DEV} get deployments -o json`, as);
      expect(broken).toMatchObject({ ok: false, text: expect.stringContaining('cannot be hidden') });
      expect(broken.text).not.toContain(SECRET);
      backends.kubeAnswers.set('get deployment nope -o json', { ok: false, stdout: '', stderr: 'Error from server (NotFound): deployments.apps "nope" not found' });
      expect(await kube(`${DEV} get deployment nope -o json`, as)).toMatchObject({ ok: false, text: expect.stringContaining('NotFound') });
    });
  });

  it('redacts what an action returns at the one exit, even from a proxy that redacts nothing itself', async () => {
    const url = `https://b.s3.us-west-2.amazonaws.com/o?X-Amz-Security-Token=session-word-not-a-token&X-Amz-Signature=signature-word-not-a-signature`;
    for (const as of [run, hers]) {
      const outcome = await proxies.perform(as, { tier: 0, kind: 'test.unredacted', summary: 'a proxy that forgot', reason: 'A read.' }, `act-${as.runId}`, async () => ({ ok: true, output: `here it is: ${url}` }));
      expect(outcome.output).not.toContain('session-word-not-a-token');
      expect(outcome.output).not.toContain('signature-word-not-a-signature');
      expect(outcome.output).toContain('https://b.s3.us-west-2.amazonaws.com/o?');
    }
    expect(JSON.stringify(events())).not.toContain('signature-word-not-a-signature');
    expect(JSON.stringify(events())).not.toContain('session-word-not-a-token');
  });

  it('asks an agent for an output format that can print a value, and refuses it to Elfoqsy, with the way to read the object', async () => {
    const reason = /can print the value of an environment variable.*-o yaml and -o json hide/;
    for (const fmt of ['-o jsonpath={.items[*].spec.template.spec.containers[*].env}', '-o go-template={{.items}}', '-o custom-columns=ENV:.spec.containers[*].env']) {
      const r = await kube(`${DEV} get deployments ${fmt}`, hers);
      expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/^Refused: /) });
      expect(r.text).toMatch(reason);
      expect(payloads('action.classified').at(-1)).toMatchObject({ decision: 'refuse', tier: 2, kind: 'kube.read_secret' });
    }
    expect(backends.calls.kubectl).toEqual([]);
  });

  it('refuses Elfoqsy the reads that return the values themselves, and the ones that mint credentials', async () => {
    const refused: Array<[string, RegExp]> = [
      [`lambda get-function-configuration --function-name f ${P}`, /tier 2/],
      [`lambda get-function --function-name f ${P}`, /tier 2/],
      [`ssm get-parameter --name /x ${P}`, /tier 2/],
      [`ssm get-parameters-by-path --path /x ${P}`, /tier 2/],
      [`ssm get-command-invocation --command-id c --instance-id i ${P}`, /tier 2/],
      [`cloudcontrol get-resource --type-name AWS::Lambda::Function --identifier f ${P}`, /tier 2/],
      [`config get-resource-config-history --resource-type AWS::Lambda::Function --resource-id f ${P}`, /tier 2/],
      [`redshift get-cluster-credentials --db-user u --cluster-identifier c ${P}`, /credentials/],
      [`s3control get-data-access --account-id 1 --target s3://b/* --permission READ ${P}`, /credentials/],
      [`lambda list-functions --debug ${P}`, /--debug/],
      // His rule of 18 October for what was still undecided: values and text the filter cannot reach are asked.
      [`appsync get-graphql-api-environment-variables --api-id a ${P}`, /tier 2/],
      [`apigateway get-api-keys --include-values ${P}`, /tier 2/],
      [`ec2 get-password-data --instance-id i ${P}`, /tier 2/],
      [`ec2 get-launch-template-data --instance-id i ${P}`, /tier 2/],
      [`ec2 describe-instance-attribute --instance-id i --attribute userData ${P}`, /tier 2/],
      [`appconfig get-configuration --application a --environment e --configuration c --client-id i /dev/stdout ${P}`, /tier 2/],
      [`stepfunctions describe-execution --execution-arn e ${P}`, /tier 2/],
      // What produces a new credential is never done.
      [`athena get-session-endpoint --session-id s ${P}`, /credentials/],
      [`lakeformation get-temporary-glue-table-credentials --table-arn t --permissions SELECT ${P}`, /credentials/],
      [`rds generate-db-auth-token --hostname h --port 5432 --username u ${P}`, /credentials/],
      [`s3 presign s3://b/k ${P}`, /credentials/],
      // And a shortened option is not a way round any of it.
      [`lambda list-functions --que Functions[].Environment.Variables ${P}`, /Write the option in full/],
    ];
    for (const [cmd, why] of refused) {
      const r = await aws(cmd, hers);
      expect(r, cmd).toMatchObject({ ok: false });
      expect(r.text, cmd).toMatch(why);
    }
    expect(backends.calls.aws).toEqual([]);
  });
});
