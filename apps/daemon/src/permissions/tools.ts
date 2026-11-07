// The capability proxies as an agent sees them: six tools of its run's own MCP server. Each takes the request as it
// would be typed (kubectl, aws and gh arguments) or as a small structured action (Jira, Confluence, Coralogix), and
// hands it to the orchestrator, which classifies it into a tier and runs it with alex's credentials if the tier
// allows. The input shapes are flat for MCP; each proxy validates its own request in full.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ProxyName } from '@elfoqsy/contracts';
import { z } from 'zod';
import type { Environments } from './environments';
import type { ProxyAnswer } from './proxy';

export const PROXY_TOOLS: ProxyName[] = ['kube', 'aws', 'gh', 'jira', 'confluence', 'logs', 'docker', 'shop'];

const TIERS =
  'Reads are free. Some writes are done at once and reported to alex (tier 1), others wait for his approval (tier 2), and some are never done (tier 3): the answer says which.';

type Call = (proxy: ProxyName, input: Record<string, unknown>, extra: unknown) => Promise<ProxyAnswer>;

export function proxyTools(envs: Environments, call: Call) {
  const contexts = envs.list.flatMap((e) => (e.kubeContext ? [`${e.name} (${e.kubeContext}${e.namespace ? `, namespace ${e.namespace}` : ''})`] : []));
  const unknown = envs.unknownContexts.length ? ` ${envs.unknownContexts.join(' and ')} are not ours: every call to them is asked, reads included.` : '';
  const harness = envs.harness.length ? envs.harness.join(', ') : 'none';
  const profiles = envs.list.flatMap((e) => (e.awsProfile ? [`${e.awsProfile} (${e.name})`] : []));
  const apps = envs.list.flatMap((e) => (e.coralogixApplication ? [e.name] : []));
  const answer = (r: ProxyAnswer) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const args = z.array(z.string()).min(1).max(60);
  return [
    tool(
      'kube',
      `Run kubectl through the orchestrator, with this run's own kubeconfig. Pass kubectl's arguments without "kubectl". Every call names its context with --context, by the environment's name or its context: ${contexts.join('; ')}.${unknown} There is no prod access. ${TIERS} Only the test harness (${harness}) may be changed: on dev, set image, rollout restart and scale of it are done at once with the earlier state recorded (alex can undo them), elsewhere they are asked. Deploying a product service is alex's: hand it over with ask_user. get -o json and -o yaml, describe and rollout history show every environment variable's value as <hidden> (names stay); an output format that can print a value by itself (jsonpath or custom-columns reaching env, a template) is reading values and is asked. Reading a secret is asked; apply, replace, delete, editing or creating configmaps and secrets, and kubectl config are never done.`,
      { args },
      async (input, extra) => answer(await call('kube', input, extra)),
    ),
    tool(
      'aws',
      `Run the AWS CLI through the orchestrator. Pass aws's arguments without "aws". Every call names its profile with --profile: ${profiles.join('; ')}. There is no prod access. ${TIERS} describe-, list- and get- calls, s3 ls and log queries are free; reading a secret and any write are asked, and so is any read whose answer is a secret or text the proxy cannot hide one in (a secret's, an SSM parameter's or an app's environment value, what a command printed, user data and a Windows password, an API key's value, a configuration's content, a Lambda function's environment values with get-function or get-function-configuration, a resource's whole configuration from cloudcontrol or config, a Step Functions execution's input and output, an Amplify app's basic-auth login); every other read that returns environment variables (Lambda list-functions, ECS task definitions and tasks, Batch, CodeBuild, SageMaker and more) or a field that holds a credential (a client secret, a webhook's token, a custom header's value, a connection's password) is free but shows each such value as <hidden> (the names and fields stay, the answer is JSON, and a --query runs on it with the values already hidden); a read that writes its answer to a file named in the call (the outfile of apigateway get-export, iot-data get-thing-shadow and the like) is asked too; calls that mint credentials or tokens (a session token, a login password, a database login token, s3 presign, a console or dashboard session URL) are never done, nor an argument that holds file:// or fileb://, nor --debug, --ca-bundle or --cli-auto-prompt, nor an option written as the start of its name (--prof for --profile): write options in full, and put none but the CLI's global ones (--profile, --region, --output, --query) before the service and the operation; anything that hands out or changes credentials or a kubeconfig is never done.`,
      { args: z.array(z.string()).min(2).max(60) },
      async (input, extra) => answer(await call('aws', input, extra)),
    ),
    tool(
      'gh',
      `Run gh through the orchestrator, with alex's GitHub login. Pass gh's arguments without "gh", and name the repository with --repo OWNER/NAME. ${TIERS} Opening this run's PR (gh pr create, always a draft, no reviewers) and re-running the failed jobs of this run branch's CI are done at once. Marking a PR ready, commenting, editing, closing, running a workflow and deleting caches are asked. Merging, approving reviews, releases, secrets and ref changes are never done.`,
      { args },
      async (input, extra) => answer(await call('gh', input, extra)),
    ),
    tool(
      'jira',
      `Jira through the orchestrator. action get {key} or search {jql, max} are free. link_pr {key, url} links this run's own PR in its ticket at once; fill {key, rootCause?, solution?, ac?} fills those bug fields at once while they are empty on this run's ticket assigned to alex. comment {key, text}, transition {key, to}, create {project, type, summary, description}, edit_description {key, description}, and fill over existing text are asked. Write in English; keep the Description short and do not repeat a fact across fields.`,
      {
        action: z.enum(['get', 'search', 'link_pr', 'unlink_pr', 'fill', 'comment', 'transition', 'create', 'edit_description']),
        key: z.string().optional(),
        jql: z.string().optional(),
        max: z.number().int().optional(),
        url: z.string().optional(),
        rootCause: z.string().optional(),
        solution: z.string().optional(),
        ac: z.string().optional(),
        text: z.string().optional(),
        to: z.string().optional(),
        project: z.string().optional(),
        type: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
      },
      async (input, extra) => answer(await call('jira', input, extra)),
    ),
    tool(
      'confluence',
      'Confluence through the orchestrator. action search {cql, limit} and get {pageId} are free; create {space, title, body, parentId?} and edit {pageId, title?, body} are asked.',
      {
        action: z.enum(['search', 'get', 'create', 'edit']),
        cql: z.string().optional(),
        limit: z.number().int().optional(),
        pageId: z.string().optional(),
        space: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        parentId: z.string().optional(),
      },
      async (input, extra) => answer(await call('confluence', input, extra)),
    ),
    tool(
      'logs',
      `Coralogix logs through the orchestrator. Give the DataPrime that comes after the source and filter (for example: filter $m.severity == ERROR | limit 50), and an environment (${apps.join(', ')}) or application; the orchestrator adds the application filter itself, for non-prod applications only. from and to are ISO times or how far back (15m, 2h, 1d). Prod logs are asked.`,
      {
        query: z.string(),
        environment: z.string().optional(),
        application: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().optional(),
      },
      async (input, extra) => answer(await call('logs', input, extra)),
    ),
    tool(
      'docker',
      `Run docker through the orchestrator, on alex's Docker, in your run folder. Pass docker's arguments without "docker". Reads, builds from the run folder, pulls (it logs in to the team's ECR itself) and your own containers are free; pushing an image to ECR and removing an image are asked. Refused: a mount outside the run folder, the Docker socket, --privileged, added capabilities or devices, the host's network, PID, IPC or user namespace, another daemon or context, logins, compose, prune, and other runs' containers.`,
      { args: z.array(z.string()).min(1).max(80) },
      async (input, extra) => answer(await call('docker', input, extra)),
    ),
    tool(
      'shop',
      `alex's shop.sh, for one command: build-integration-test on an environment (${envs.list.filter((e) => e.kubeContext && e.awsProfile).map((e) => e.name).join(', ')}). It builds the integration-test image from your clone of shop-worker, pushes it to that environment's ECR, and points ${harness} at it. Done at once on dev (the earlier image is recorded and alex can undo it); asked elsewhere. Every other shop.sh command is refused; run tests in your clones directly.`,
      { command: z.literal('build-integration-test'), environment: z.string() },
      async (input, extra) => answer(await call('shop', input, extra)),
    ),
  ];
}
