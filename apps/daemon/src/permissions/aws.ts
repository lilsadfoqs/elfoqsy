// The aws proxy: an agent's aws CLI call, run by the orchestrator with alex's credentials. Every call names its
// profile; the profile decides the environment. Reads (describe-, list-, get- calls, s3 ls, log queries) are free;
// reading a secret and anything that writes are asked; anything that mints, shows or changes credentials, configures
// a profile, or reaches prod is never done.
import { z } from 'zod';
import { redact } from '../redact';
import { resolveProfile, type Environments } from './environments';
import { hideSecrets, searchJson } from './hide';
import { invalid, shortOutput, type Classified, type ExecResult, type Outcome, type ProxyHandler, type Recorded } from './types';

export interface AwsRequest {
  /** aws's arguments, without "aws". Must include --profile. */
  args: string[];
}

export type AwsCli = (args: string[]) => Promise<ExecResult>;

const schema = z.object({ args: z.array(z.string().max(4000)).min(2).max(60) });

// Calls that hand out or change credentials, or log in or out: alex's alone. A read that produces a new credential
// (a token, a password, a key pair, a signed URL) is here too, whatever its verb : get-,
// not only create-.
const CREDENTIALS: Array<[string, RegExp]> = [
  ['configure', /.*/],
  ['sso', /.*/],
  ['login', /.*/],
  ['logout', /.*/],
  ['sts', /^(assume-.*|get-session-token|get-federation-token|get-delegated-access-token|get-web-identity-token)$/],
  ['ecr', /^get-(login(-password)?|authorization-token)$/],
  ['ecr-public', /^get-(login(-password)?|authorization-token)$/],
  ['eks', /^(get-token|update-kubeconfig)$/],
  ['codeartifact', /^get-authorization-token$/],
  ['iam', /^(create-access-key|create-login-profile|update-login-profile|create-service-specific-credential|reset-service-specific-credential|change-password)$/],
  ['sso-oidc', /.*/],
  ['cognito-identity', /^(get-credentials-for-identity|get-open-id-token|get-open-id-token-for-developer-identity)$/],
  ['cognito-idp', /^get-tokens-from-refresh-token$/],
  ['redshift', /^(get-cluster-credentials(-with-iam)?|get-identity-center-auth-token)$/],
  ['redshift-serverless', /^get-credentials$/],
  ['s3control', /^get-data-access$/],
  ['codepipeline', /^(get-job-details|get-third-party-job-details)$/],
  ['glue', /^get-session-endpoint$/],
  ['lightsail', /^(get-relational-database-master-user-password|get-instance-access-details)$/],
  ['ssm', /^get-access-token$/],
  ['acm', /^get-acme-external-account-binding-credentials$/],
  // Found by the same scan (test/tools/awsSecretReads.py): each returns a new token, password or key pair.
  ['athena', /^get-session-endpoint$/],
  ['bedrock-agentcore', /^get-resource-(oauth2-token|payment-token)$/],
  ['connect', /^get-federation-token$/],
  ['datazone', /^get-environment-credentials$/],
  ['emr', /^(get-cluster-session-credentials|get-session-endpoint)$/],
  ['emr-serverless', /^get-session-endpoint$/],
  ['finspace-data', /^(get-external-data-view-access-details|get-programmatic-access-credentials)$/],
  ['gamelift', /^(get-compute-access|get-compute-auth-token)$/],
  ['lakeformation', /^get-temporary-(data-location|glue-partition|glue-table)-credentials$/],
  ['license-manager', /^get-access-token$/],
  ['kinesis-video-signaling', /^get-ice-server-config$/],
  ['wickr', /^get-oidc-info$/],
  ['emr-containers', /^get-managed-endpoint-session-credentials$/],
  ['bedrock-agentcore', /^get-workload-access-token(-for-jwt|-for-user-id)?$/],
  ['gamelift', /^get-instance-access$/],
  ['route53globalresolver', /^get-access-token$/],
  ['finspace', /^get-kx-connection-string$/],
  // A session on a console or a dashboard, handed out as a URL.
  ['*', /-(presigned|embed)-url$/],
  // Not reads by their verb, and minted all the same: a database login token, a pre-signed URL.
  ['rds', /^generate-db-auth-token$/],
  ['dsql', /^generate-db-connect(-admin)?-auth-token$/],
  ['s3', /^presign$/],
];

const USER_DATA = 'A launch script (user data) often holds bootstrap secrets, and this returns it: asked first.';
const WHOLE_CONFIGURATION = "A resource's whole configuration is in this answer, a Lambda function's or a task definition's environment values included, as text the proxy cannot hide them in: asked first.";

/**
 * Whether the call can carry an option of its operation: written in full, shortened (the CLI takes any unique start of a
 * name), or set inside a --cli-input document, which can set any of them.
 */
const carries = (p: ParsedAws, flag: string): boolean => [...p.flags.keys()].some((k) => k.length > 2 && (flag.startsWith(k) || k === '--cli-input-json' || k === '--cli-input-yaml'));
/** Whether any value or operand of the call reads like this, or a --cli-input document could set it. */
const carriesValue = (p: ParsedAws, like: RegExp): boolean =>
  carries(p, '--cli-input-json') || [...p.flags.values(), ...p.operands].some((v) => typeof v === 'string' && like.test(v));

// Reading values that are secrets: always asked (refused to Elfoqsy). One rule (his, 18 October): a structured field that
// holds a credential or a secret value is hidden by the filter (the two HIDE tables below); a read whose whole answer is
// a secret, or text the filter cannot reach, is asked here; a read that produces a new credential is never done (above).
// An optional last entry says when the call is one that returns them.
const SECRETS: Array<[service: string, operations: RegExp, why?: string, when?: (p: ParsedAws) => boolean]> = [
  ['secretsmanager', /^(get-secret-value|batch-get-secret-value)$/],
  // A parameter of any type: a String can hold a secret as well as a SecureString.
  ['ssm', /^(get-parameters?|get-parameters-by-path|get-parameter-history)$/, 'An SSM parameter of any type can hold a secret, and this returns its value: asked first.'],
  // What commands printed on instances.
  ['ssm', /^(get-command-invocation|list-command-invocations)$/, 'The output of a command run on an instance can print secrets, and this returns it: asked first.'],
  ['kms', /^(decrypt|generate-data-key.*)$/],
  ['lambda', /^(get-function|get-function-configuration)$/, "A Lambda function's environment variables often hold secrets, and this returns their values (and a link to download its code): asked first. list-functions shows the names with the values hidden."],
  // A resource's whole configuration, as text: the environment of a Lambda function or a task definition is in it, where
  // the filter that hides it in their own answers cannot reach.
  ['cloudcontrol', /^(get-resource|list-resources)$/, WHOLE_CONFIGURATION],
  ['config', /^(get-resource-config-history|batch-get-resource-config|batch-get-aggregate-resource-config|get-aggregate-resource-config)$/, WHOLE_CONFIGURATION],
  // The values themselves are what these return.
  ['appsync', /^get-graphql-api-environment-variables$/, "The values of an API's environment variables are what this returns: asked first."],
  ['apigateway', /^get-api-keys$/, 'With --include-values this returns the API keys themselves: asked first.', (p) => carries(p, '--include-values')],
  ['apigateway', /^get-api-key$/, 'With --include-value this returns the API key itself: asked first.', (p) => carries(p, '--include-value')],
  ['appconfig', /^(get-configuration|get-hosted-configuration-version)$/, "A configuration's content is what this returns, and it is often settings with secrets in them: asked first."],
  ['appconfigdata', /^get-latest-configuration$/, "A configuration's content is what this returns, and it is often settings with secrets in them: asked first."],
  ['ec2', /^get-password-data$/, 'This returns the (encrypted) administrator password of a Windows instance: asked first.'],
  ['ec2', /^describe-instance-attribute$/, USER_DATA, (p) => carriesValue(p, /^user-?data$/i)],
  // Reads that exist to return user data are asked; the listings that carry it among other things hide the field.
  ['ec2', /^get-launch-template-data$/, USER_DATA],
  // Run data: an execution's input, output and the payloads in its history are text the filter cannot reach. A task taken
  // off an activity's queue is that and no read: it is not there for the next worker.
  ['stepfunctions', /^(describe-execution|get-execution-history)$/, "An execution's input, output and error text are data of any kind, and the proxy cannot hide a secret in them: asked first."],
  ['stepfunctions', /^get-activity-task$/, "This takes a task, with its input, off an activity's queue; it is no read, and the input can hold secrets: asked first."],
  // The whole answer is a stored credential.
  ['bedrock-agentcore', /^get-resource-api-key$/, 'This returns a stored API key: asked first.'],
  ['pca-connector-scep', /^get-challenge-password$/, 'This returns a connector\'s challenge password: asked first.'],
  ['apigateway', /^(get-usage-plan-keys|get-usage-plan-key)$/, 'This returns the API keys of a usage plan with their values: asked first.'],
  ['ivs', /^(get-stream-key|batch-get-stream-key)$/, 'This returns a channel\'s stream key, which is the secret that lets anyone stream to it: asked first.'],
  ['storagegateway', /^describe-chap-credentials$/, 'The CHAP secrets of a volume are the whole answer: asked first.'],
  ['ec2', /^get-vpn-connection-device-sample-configuration$/, 'The sample configuration is text with the connection\'s pre-shared keys in it: asked first.'],
  ['datazone', /^get-connection$/, 'With --with-secret this returns the connection\'s secrets and tokens: asked first.', (p) => carries(p, '--with-secret')],
  ['logs', /^(get-log-events|filter-log-events|get-log-record|get-log-object)$/, 'With --unmask this returns the log fields that were masked as sensitive data: asked first.', (p) => carries(p, '--unmask')],
];

// Reads that write their answer to a file the call names (the outfile that the CLI asks for when the answer is a blob), with
// alex's access and outside the sandbox: a free read could overwrite any file of his. Asked, refused to Elfoqsy.
// Generated from the service models (test/tools/awsFileWrites.py; test/aws-model-coverage.test.ts fails when a new one is missing).
const WRITES_FILES: Array<[service: string, operations: RegExp]> = [
  ['agenttoolkit', /^(get-skill-file)$/],
  ['apigateway', /^(get-export|get-sdk)$/],
  ['appconfig', /^(get-configuration|get-hosted-configuration-version)$/],
  ['appconfigdata', /^(get-latest-configuration)$/],
  ['appsync', /^(get-introspection-schema)$/],
  ['cloudfront', /^(get-connection-function|get-function)$/],
  ['codeartifact', /^(get-package-version-asset)$/],
  ['codeguruprofiler', /^(get-profile)$/],
  ['datazone', /^(get-lineage-event)$/],
  ['ebs', /^(get-snapshot-block)$/],
  ['geo-maps', /^(get-glyphs|get-sprites|get-static-map|get-style-descriptor|get-tile)$/],
  ['glacier', /^(get-job-output)$/],
  ['iot-data', /^(get-thing-shadow)$/],
  ['iotwireless', /^(get-position-estimate|get-resource-position)$/],
  ['kinesis-video-archived-media', /^(get-clip|get-media-for-fragment-list)$/],
  ['kinesis-video-media', /^(get-media)$/],
  ['lakeformation', /^(get-work-unit-results)$/],
  ['location', /^(get-map-glyphs|get-map-sprites|get-map-style-descriptor|get-map-tile)$/],
  ['medialive', /^(describe-input-device-thumbnail)$/],
  ['mediastore-data', /^(get-object)$/],
  ['medical-imaging', /^(get-image-frame|get-image-set-metadata)$/],
  ['omics', /^(get-read-set|get-reference)$/],
  ['s3api', /^(get-object|get-object-annotation|get-object-torrent)$/],
  ['sagemaker-geospatial', /^(get-tile)$/],
  ['schemas', /^(get-code-binding-source)$/],
  ['tnb', /^(get-sol-function-package-content|get-sol-function-package-descriptor|get-sol-network-package-content|get-sol-network-package-descriptor)$/],
  ['workmailmessageflow', /^(get-raw-message-content)$/],
  // A custom command: it downloads the log and writes it where --save-as says.
  ['gamelift', /^get-game-session-log$/],
];
// Reads that stay free, with every environment variable's value in the answer hidden and the names kept (hide.ts). The
// call runs with --output json and without --query, and the query, if there was one, runs on the answer with the values
// already hidden, so no query and no output format can bring a value out.
const HIDE_ENVIRONMENT: Array<[service: string, operations: RegExp]> = [
  ['lambda', /^(list-functions|list-versions-by-function)$/],
  ['ecs', /^(describe-tasks|describe-task-definition|describe-daemon-task-definition|describe-express-gateway-service)$/],
  ['batch', /^(describe-job-definitions|describe-jobs)$/],
  ['codebuild', /^batch-get-(projects|builds|build-batches|sandboxes)$/],
  ['codepipeline', /^(get-pipeline|get-pipeline-execution|list-action-executions)$/],
  ['devicefarm', /^(get-project|get-run|list-projects|list-runs)$/],
  ['lightsail', /^(get-container-services|get-container-service-deployments)$/],
  ['emr', /^describe-notebook-execution$/],
  ['bedrock-agentcore-control', /^(get-agent-runtime|get-harness)$/],
  ['cleanroomsml', /^(get-trained-model|get-trained-model-inference-job)$/],
  ['lambda-microvms', /^(get-microvm-image-version|list-microvm-image-versions)$/],
  ['greengrass', /^get-function-definition-version$/],
  ['sagemaker', /^(describe-(ai-recommendation-job|algorithm|auto-ml-job(-v2)?|data-quality-job-definition|hyper-parameter-tuning-job|inference-component|model|model-bias-job-definition|model-explainability-job-definition|model-package|model-quality-job-definition|monitoring-schedule|processing-job|training-job|transform-job|app-image-config|partner-app|optimization-job)|list-candidates-for-auto-ml-job|list-app-image-configs)$/],
  // Under keys of their own: stage variables, runtime environment, job arguments, automation variables, a pipe's target
  // environment, and the findings that quote a resource's configuration.
  ['apigateway', /^(get-stage|get-stages)$/],
  ['apprunner', /^describe-service$/],
  ['glue', /^(get-job|get-jobs|batch-get-jobs|get-session|list-sessions|get-job-run|get-job-runs|get-trigger|get-triggers|batch-get-triggers|get-workflow|batch-get-workflows|get-workflow-run|get-workflow-runs|get-workflow-run-properties|get-dev-endpoint|get-dev-endpoints|batch-get-dev-endpoints)$/],
  ['amplify', /^(get-app|list-apps|get-branch|list-branches)$/], // environment variables, and the basic-auth login (a field that holds a credential)
  ['apigatewayv2', /^(get-stage|get-stages)$/],
  ['finspace', /^get-kx-cluster$/],
  ['gamelift', /^(describe-container-group-definition|list-container-group-definition-versions|list-container-group-definitions)$/],
  ['gameliftstreams', /^get-stream-session$/],
  ['mwaa', /^get-environment$/],
  ['elasticbeanstalk', /^describe-configuration-settings$/],
  ['ssm', /^get-automation-execution$/],
  ['pipes', /^describe-pipe$/],
  ['securityhub', /^get-findings$/],
];
// Reads that stay free, with every field that holds a credential hidden and the field kept: a client secret, a webhook's
// token, a pre-shared key, a custom origin header's value, a connection's password (the same filter, hide.ts).
const HIDE_FIELDS: Array<[service: string, operations: RegExp]> = [
  ['cognito-idp', /^(describe-user-pool-client|list-user-pool-client-secrets)$/],
  ['cloudfront', /^(get-distribution|get-distribution-config|list-distributions.*)$/],
  ['codepipeline', /^list-webhooks$/],
  ['ec2', /^(describe-vpn-connections|describe-verified-access-trust-providers)$/],
  ['elbv2', /^(describe-listeners|describe-rules)$/],
  ['wafv2', /^list-api-keys$/],
  ['dataexchange', /^(get-asset|get-job|list-jobs|list-revision-assets)$/],
  ['glue', /^(get-connection|get-connections)$/],
  ['amplifybackend', /^get-backend-auth$/],
  ['datasync', /^describe-location-fsx-(ontap|open-zfs)$/],
  ['dms', /^describe-endpoints$/],
  ['ivs', /^(get-channel|batch-get-channel|get-stream-session)$/],
  ['mediapackage', /^(describe-channel|list-channels)$/],
  ['datazone', /^(get-connection|list-connections)$/],
  ['wickr', /^get-opentdf-config$/],
  // A launch script (user data) is a field of these answers, among the rest of the configuration.
  ['ec2', /^(describe-launch-template-versions|describe-spot-fleet-requests|describe-spot-instance-requests)$/],
  ['autoscaling', /^describe-launch-configurations$/],
  ['appstream', /^describe-directory-configs$/],
  ['chime', /^(get-bot|list-bots)$/],
  ['chime-sdk-meetings', /^(get-attendee|list-attendees)$/],
  // A pending change of a master password, and a resolved parameter value, are in the answers of the commonest reads.
  ['cloudformation', /^(describe-stacks|describe-change-set|describe-stack-set|describe-stack-instance)$/],
  ['cloudhsmv2', /^describe-clusters$/],
  ['docdb', /^describe-db-instances$/],
  ['neptune', /^describe-db-instances$/],
  ['rds', /^(describe-db-clusters|describe-db-instances|describe-tenant-databases)$/],
  ['redshift', /^describe-clusters$/],
  ['emr', /^describe-cluster$/],
  ['fsx', /^(describe-backups|describe-file-systems|describe-snapshots|describe-volumes)$/],
  ['ivs-realtime', /^get-ingest-configuration$/],
  ['lexv2-models', /^describe-bot-recommendation$/],
  ['lightsail', /^(get-bucket-access-keys|get-relational-database|get-relational-databases)$/],
  ['quicksight', /^describe-asset-bundle-import-job$/],
];
// The aws CLI takes any unique start of an option's name (--prof for --profile, --que for --query, --endpoint for
// --endpoint-url), so a check written for a full name sees one spelling of it, and the last one given wins. These are the
// options the proxies depend on: written in full, or refused.
const GUARDED_FLAGS = [
  '--profile', '--region', '--output', '--query', '--endpoint-url', '--no-verify-ssl', '--no-sign-request', '--ca-bundle', '--debug',
  '--no-paginate', '--cli-input-json', '--cli-input-yaml', '--cli-read-timeout', '--cli-connect-timeout', '--color', '--follow',
  '--generate-cli-skeleton', '--cli-binary-format', '--no-cli-pager', '--cli-auto-prompt', '--no-cli-auto-prompt', '--cli-error-format',
];
export const READ_OP = /^(describe-|list-|get-|batch-get-|lookup-|search-|filter-log-events$|start-query$|get-query-results$|head-|wait$)/;
// The CLI's own global options: the ones that take a value, and the ones that do not. Before the service and the operation
// only these are read the way the CLI reads them (a value-taking option the parser does not know would swallow the wrong word).
const GLOBAL_VALUE = new Set(['--profile', '--region', '--output', '--query', '--endpoint-url', '--color', '--cli-read-timeout', '--cli-connect-timeout', '--ca-bundle', '--cli-binary-format', '--cli-error-format']);
const GLOBAL_BOOLEAN = new Set(['--debug', '--no-verify-ssl', '--no-paginate', '--no-sign-request', '--no-cli-pager', '--cli-auto-prompt', '--no-cli-auto-prompt']);

export interface ParsedAws {
  profile?: string;
  service: string;
  operation: string;
  operands: string[];
  flags: Map<string, string | true>;
  /** An option before the service and the operation that is not one of the CLI's global options. */
  unknownBeforeCommand?: string;
}

export function parseAws(args: string[]): ParsedAws {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let unknownBeforeCommand: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (positional.length < 2 && !GLOBAL_VALUE.has(name) && !GLOBAL_BOOLEAN.has(name)) unknownBeforeCommand ??= name;
      if (eq > 0) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (i + 1 < args.length && !args[i + 1]!.startsWith('--') && (GLOBAL_VALUE.has(a) || positional.length >= 2)) {
        flags.set(a, args[i + 1]!);
        i++;
      } else flags.set(a, true);
      continue;
    }
    positional.push(a);
  }
  const [service = '', operation = '', ...operands] = positional;
  const profile = flags.get('--profile');
  return { ...(typeof profile === 'string' && profile ? { profile } : {}), service, operation, operands, flags, ...(unknownBeforeCommand ? { unknownBeforeCommand } : {}) };
}

export function classifyAws(args: string[], envs: Environments): Classified {
  const p = parseAws(args);
  const summary = `aws ${args.join(' ')}`.slice(0, 300);
  if (!p.profile) return invalid('aws.no_profile', summary, 'Every aws call names its profile: add --profile, for example --profile dev-shop.');
  if (p.unknownBeforeCommand) {
    return invalid('aws.option_before_command', summary, `${p.unknownBeforeCommand} comes before the service and the operation, where only the CLI's own global options (--profile, --region, --output, --query and the like) are read the way the CLI reads them. Put it after the operation.`);
  }
  if (!p.service || !p.operation) return invalid('aws.no_command', summary, 'Name the service and the operation, for example aws --profile dev-shop sts get-caller-identity.');
  const shortened = args.filter((a) => a.startsWith('--') && a.length > 2).map((a) => a.split('=')[0]!).find((name) => !GUARDED_FLAGS.includes(name) && GUARDED_FLAGS.some((full) => full.startsWith(name)));
  if (shortened) {
    return { tier: 3, kind: 'aws.shortened_flag', summary, reason: `${shortened} is the start of an option's name, which the aws CLI accepts (${GUARDED_FLAGS.find((full) => full.startsWith(shortened))}), and no check here sees it that way. Write the option in full.` };
  }
  if (p.flags.has('--endpoint-url') || p.flags.has('--no-verify-ssl') || p.flags.has('--no-sign-request') || p.flags.has('--ca-bundle')) {
    return { tier: 3, kind: 'aws.auth', summary, reason: '--endpoint-url, --ca-bundle, --no-verify-ssl and --no-sign-request change where the call goes, whom it trusts or how it authenticates.' };
  }
  // The aws CLI reads any argument written file:// or fileb:// from a local file, and echoes parameters in its errors;
  // it runs in the orchestrator, outside the sandbox, with his access, so that would read any file of his.
  // Anywhere in an argument: shorthand writes it after "=", after "@=" and a quote, or inside brackets.
  if (args.some((a) => /(file|fileb):\/\//i.test(a))) {
    return { tier: 3, kind: 'aws.local_file', summary, reason: 'An argument that holds file:// or fileb:// makes the aws CLI read a local file with alex\'s access, outside the sandbox, and its errors repeat what it read. Give the value itself.' };
  }
  // --debug prints the whole conversation with AWS, answers included, in the error text: past every filter.
  // --cli-auto-prompt asks questions on a terminal that is not there, and waits.
  if (args.includes('--cli-auto-prompt')) return { tier: 3, kind: 'aws.interactive', summary, reason: '--cli-auto-prompt is interactive and would wait for a terminal. Run the call without it.' };
  if (args.includes('--debug')) return { tier: 3, kind: 'aws.debug', summary, reason: '--debug prints the whole conversation with AWS, answers included, which are hidden or asked about elsewhere. Run the call without it.' };
  const kind = `aws.${p.service}.${p.operation}`;
  for (const [service, ops] of CREDENTIALS) {
    if ((service === '*' || p.service === service) && ops.test(p.operation)) {
      return { tier: 3, kind: 'aws.credentials', summary, reason: `aws ${p.service} ${p.operation} hands out or changes credentials, profiles or a kubeconfig; agents never hold credentials, and alex's profile and kube context never change.` };
    }
  }
  const resolved = resolveProfile(envs, p.profile);
  if (resolved.kind === 'prod') return { tier: 3, kind, environment: 'prod', summary, reason: `${p.profile} is prod. There is no prod access at all.` };
  if (resolved.kind !== 'env') {
    const known = envs.list.flatMap((e) => (e.awsProfile ? [e.awsProfile] : [])).join(', ');
    return invalid('aws.unknown_profile', summary, `${p.profile} is not a configured profile. Use one of: ${known}.`);
  }
  const base = { kind, environment: resolved.env.name, summary, needsAws: true };
  const secret = SECRETS.find(([s, ops, , when]) => p.service === s && ops.test(p.operation) && (when?.(p) ?? true));
  if (secret) return { ...base, tier: 2, kind: 'aws.read_secret', reason: secret[2] ?? 'Reading a secret is always asked first.' };
  const hides = (table: Array<[string, RegExp]>): boolean => table.some(([s, ops]) => p.service === s && ops.test(p.operation));
  if (hides(HIDE_ENVIRONMENT)) {
    return { ...base, tier: 0, hideSecrets: true, reason: 'A read: the values of environment variables are hidden in its answer, and their names stay. The answer is JSON, and a --query runs on it with the values already hidden.' };
  }
  if (hides(HIDE_FIELDS)) {
    return { ...base, tier: 0, hideSecrets: true, reason: 'A read: fields that hold a credential (a secret, a token, a key) are hidden in its answer, and the fields stay. The answer is JSON, and a --query runs on it with the values already hidden.' };
  }
  if (p.service === 's3') {
    if (p.operation === 'ls') return { ...base, tier: 0, reason: 'A read.' };
    return { ...base, tier: 2, kind: 'aws.s3_write', reason: `aws s3 ${p.operation} writes to S3 or copies its data out: asked first.` };
  }
  // s3api get-object copies an object's data out, to a file of his or to the screen, as s3 cp does.
  if (p.service === 's3api' && /^(get-object|get-object-torrent|select-object-content)$/.test(p.operation)) {
    return { ...base, tier: 2, kind: 'aws.s3_read', reason: `aws s3api ${p.operation} copies an object's data out, to a file or the screen: asked first.` };
  }
  if (WRITES_FILES.some(([service, ops]) => p.service === service && ops.test(p.operation))) {
    return { ...base, tier: 2, kind: 'aws.writes_file', reason: `aws ${p.service} ${p.operation} writes its answer to a file named in the call, with alex's access and outside the sandbox: asked first.` };
  }
  if (p.service === 'ecr' && /^(put-image|batch-delete-image|delete-repository|put-lifecycle-policy|set-repository-policy)$/.test(p.operation)) {
    return { ...base, tier: 2, kind: p.operation === 'put-image' ? 'aws.ecr_push' : kind, reason: `aws ecr ${p.operation} changes images in ECR: asked first.` };
  }
  if (p.service === 'sts' && p.operation === 'get-caller-identity') return { ...base, tier: 0, reason: 'A read.' };
  if (READ_OP.test(p.operation)) return { ...base, tier: 0, reason: 'A read.' };
  return { ...base, tier: 2, reason: `aws ${p.service} ${p.operation} is not a read: asked first.` };
}

export class AwsProxy implements ProxyHandler<AwsRequest> {
  readonly name = 'aws' as const;
  readonly schema = schema;

  constructor(
    private readonly envs: Environments,
    private readonly cli: AwsCli,
  ) {}

  async classify(request: AwsRequest): Promise<Classified> {
    return classifyAws(request.args, this.envs);
  }

  async record(request: AwsRequest, c: Classified): Promise<Recorded | null> {
    if (c.tier === 0 || c.kind === 'aws.read_secret') return null;
    const p = parseAws(request.args);
    return {
      target: `${p.service} ${p.operation} on ${c.environment}`,
      before: 'Not read: AWS writes are recorded by their call.',
      noUndo: 'The orchestrator does not undo AWS writes; ask alex if one has to be put back.',
    };
  }

  async execute(request: AwsRequest, c: Classified): Promise<Outcome> {
    if (c.hideSecrets) return this.executeHidden(request, c);
    const r = await this.cli(request.args);
    const output = shortOutput(redact(r.ok ? r.stdout : r.stderr || r.stdout));
    if (!r.ok) return { ok: false, output: output || 'aws failed.' };
    const p = parseAws(request.args);
    return { ok: true, output: output || 'Done.', done: `ran aws ${p.service} ${p.operation} on ${c.environment}`, doneVi: `đã chạy aws ${p.service} ${p.operation} trên ${c.environment}` };
  }

  /**
   * A read whose answer holds environment variables or credential fields: run with --output json and without the caller's --query and --output,
   * hide every such value in the parsed answer, and only then run the caller's --query on it. So no query and no format can
   * bring a value out; the answer is JSON.
   */
  private async executeHidden(request: AwsRequest, c: Classified): Promise<Outcome> {
    const { args, query } = withoutQueryAndOutput(request.args);
    const r = await this.cli([...args, '--output', 'json']);
    // An error is AWS's words; the answer is not read from a failure.
    if (!r.ok) return { ok: false, output: shortOutput(redact(r.stderr)) || 'aws failed.' };
    let shown: unknown;
    try {
      shown = r.stdout.trim() ? hideSecrets(JSON.parse(r.stdout)) : null;
    } catch {
      return { ok: false, output: 'The answer could not be read, so it is not shown: environment values and credential fields cannot be hidden in what is not understood.' };
    }
    if (query !== undefined) {
      try {
        shown = searchJson(shown, query);
      } catch (error) {
        return { ok: false, output: `The --query could not be run on the answer: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const p = parseAws(request.args);
    return { ok: true, output: shortOutput(redact(JSON.stringify(shown, null, 2))) || 'Done.', done: `ran aws ${p.service} ${p.operation} on ${c.environment}`, doneVi: `đã chạy aws ${p.service} ${p.operation} trên ${c.environment}` };
  }
}

/** The call without its --query and --output (as a word, or as --flag=value), and the last --query given. */
export function withoutQueryAndOutput(args: string[]): { args: string[]; query?: string } {
  const out: string[] = [];
  let query: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--query') query = args[++i] ?? '';
    else if (a.startsWith('--query=')) query = a.slice('--query='.length);
    else if (a === '--output') i++;
    else if (a.startsWith('--output=')) continue;
    else out.push(a);
  }
  return { args: out, ...(query !== undefined ? { query } : {}) };
}

/** An error that says the AWS session has run out, rather than that the call itself failed. */
/**
 * Whether an error is AWS saying the session ran out. Only AWS's own words count: when the request carried text that
 * itself looks like that (an instance id written "ExpiredToken", repeated back in the error), the error proves
 * nothing, and the hourly check and the next honest call find out.
 */
export function sessionRanOut(error: string, carried: readonly string[] = []): boolean {
  return SESSION_EXPIRED.test(error) && !carried.some((text) => SESSION_EXPIRED.test(text));
}

/** Every string a request carries, at any depth: the text an error message might repeat. */
export function carriedStrings(request: unknown): string[] {
  if (typeof request === 'string') return [request];
  if (Array.isArray(request)) return request.flatMap(carriedStrings);
  if (request && typeof request === 'object') return Object.values(request).flatMap(carriedStrings);
  return [];
}

export const SESSION_EXPIRED =/ExpiredToken|token (has|is) expired|session (has )?expired|Error loading SSO Token|The SSO session associated with this profile has expired|Token has expired and refresh failed|InvalidClientTokenId/i;
