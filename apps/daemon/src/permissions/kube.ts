// The kube proxy: an agent's kubectl call, run by the orchestrator with the run's own kubeconfig. Every call names its
// context; the context decides the environment, and the environment and verb decide the tier. Reads are free, except
// secrets. Only the test harness (harness_deployments) may be changed: on dev (and a local minikube) changing its image,
// restarting and scaling it are done at once and reported, elsewhere they are asked. Deploying a product service is
// alex's. apply, replace, delete, editing or creating configmaps and secrets, draining a node and prod are never
// done. The global kube context can never change: the call runs with --kubeconfig set to the run's own
// file, config commands are refused, and so is any flag that changes who kubectl is or which cluster it reaches.
import { z } from 'zod';
import { redact } from '../redact';
import { contextName, isHarness, needsAws, resolveContext, type Environment, type Environments } from './environments';
import { hideDescribedEnvironment, hideSecrets, hideInStructuredText } from './hide';
import { invalid, shortOutput, type Classified, type ExecResult, type Outcome, type ProxyHandler, type Recorded, type RunRef } from './types';

export interface KubeRequest {
  /** kubectl's arguments, without "kubectl". Must include --context. */
  args: string[];
}

export type Kubectl = (args: string[], kubeconfig: string) => Promise<ExecResult>;

const schema = z.object({ args: z.array(z.string().max(2000)).min(1).max(60) });

// Flags that change who kubectl is, which cluster or which file: refused, whatever the verb.
const AUTH_FLAGS = new Set(['--kubeconfig', '--token', '--as', '--as-group', '--as-uid', '--user', '--cluster', '-s', '--server', '--certificate-authority', '--client-certificate', '--client-key', '--insecure-skip-tls-verify', '--username', '--password', '--tls-server-name']);
// Flags that take a value as the next word, so it is not read as a resource name.
const VALUE_FLAGS = new Set([
  '--context', '-n', '--namespace', '-o', '--output', '-l', '--selector', '--field-selector', '-c', '--container', '--sort-by',
  '--tail', '--since', '--since-time', '--replicas', '--current-replicas', '--to-revision', '--revision', '--type', '--timeout',
  '--request-timeout', '--template', '-L', '--label-columns', '--chunk-size', '--max-log-requests', '--limit-bytes', '-f',
  '--filename', '--patch', '--grace-period', '--resource-version', '--subresource', '-v', '--v', '--raw',
]);
const READS = new Set(['get', 'describe', 'logs', 'events', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'wait']);
// For the harness on dev or local: done at once, recorded, undoable. Elsewhere: asked.
const DEV_FREE: Record<string, string> = { 'set image': 'kube.set_image', 'rollout restart': 'kube.restart', scale: 'kube.scale' };
// Verbs that deploy, when they name a workload: a product service's are alex's.
const DEPLOYS = new Set(['set image', 'rollout restart', 'rollout undo', 'rollout pause', 'rollout resume', 'scale', 'autoscale', 'patch', 'set env', 'set resources', 'set serviceaccount']);
const WORKLOAD = /^(deployments?|deploy|statefulsets?|sts|daemonsets?|ds|replicasets?|rs|replicationcontrollers?|rc)$/i;
const SECRETISH = /^(secrets?|configmaps?|cm)$/i;
const SECRET = /^secrets?$/i;

export interface ParsedKube {
  context?: string;
  namespace?: string;
  allNamespaces: boolean;
  /** "get", "set image", "rollout restart". */
  verb: string;
  /** Resource words after the verb: "deployment/shop-api", "pods", "secret,configmap". */
  resources: string[];
  /** Other words after the verb (a set image's container=image pairs). */
  rest: string[];
  authFlag?: string;
  raw?: string;
  flags: Map<string, string | true>;
}

/** kubectl's words read as context, namespace, verb and resources. Flags may come before or after the verb. */
export function parseKube(args: string[]): ParsedKube {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let authFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      positional.push(...args.slice(i + 1).map((w) => `-- ${w}`));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (AUTH_FLAGS.has(name)) authFlag ??= name;
      if (eq > 0) flags.set(name, a.slice(eq + 1));
      else if (VALUE_FLAGS.has(name) || AUTH_FLAGS.has(name)) {
        // -p is a value only for patch (--patch); for logs it is --previous.
        flags.set(name, args[i + 1] ?? '');
        i++;
      } else flags.set(name, true);
      continue;
    }
    positional.push(a);
  }
  const [first = '', second = ''] = positional;
  const twoWord = (first === 'set' || first === 'rollout' || first === 'config' || first === 'auth' || first === 'create') && second && !second.includes('/');
  const verb = twoWord ? `${first} ${second}` : first;
  const after = positional.slice(twoWord ? 2 : 1);
  const value = (name: string, alias?: string): string | undefined => {
    const v = flags.get(name) ?? (alias ? flags.get(alias) : undefined);
    return typeof v === 'string' && v ? v : undefined;
  };
  // set image takes container=image pairs after the resource; scale and others take only resources.
  const resources = verb === 'set image' ? after.filter((w) => !w.includes('=')) : after.filter((w) => !w.startsWith('-- '));
  const rest = verb === 'set image' ? after.filter((w) => w.includes('=')) : after.filter((w) => w.startsWith('-- '));
  const context = value('--context');
  const namespace = value('--namespace', '-n');
  const raw = value('--raw');
  return {
    ...(context ? { context } : {}),
    ...(namespace ? { namespace } : {}),
    allNamespaces: flags.has('-A') || flags.has('--all-namespaces'),
    verb,
    resources,
    rest,
    ...(authFlag ? { authFlag } : {}),
    ...(raw ? { raw } : {}),
    flags,
  };
}

/** The workload a call names ("deployment/x" or "deployment x"), when it names one. */
export function workloadNamed(p: ParsedKube): { type: string; name: string } | null {
  const [first = '', second] = p.resources;
  const slash = first.indexOf('/');
  const type = slash > 0 ? first.slice(0, slash) : first;
  const name = slash > 0 ? first.slice(slash + 1) : second;
  return WORKLOAD.test(type) && name ? { type: type.toLowerCase(), name } : null;
}

/** The resource types named, lower-case: "secret,configmap" and "secret/x" both count. */
const typesOf = (resources: string[]): string[] =>
  resources.flatMap((r) => r.split(',')).map((r) => (r.split('/')[0] ?? '').toLowerCase().replace(/\..*$/, ''));

/** The output format a call asks for (-o json, -ojson, --output=json; the last one wins), and what follows an "=" in it. */
export function outputFormat(args: string[]): { name: string; spec: string } | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-o' || a === '--output') found = args[i + 1];
    else if (a.startsWith('--output=')) found = a.slice('--output='.length);
    else if (/^-o./.test(a)) found = a.slice(2);
  }
  if (found === undefined) return undefined;
  const eq = found.indexOf('=');
  return { name: (eq > 0 ? found.slice(0, eq) : found).toLowerCase(), spec: eq > 0 ? found.slice(eq + 1) : '' };
}

// Output formats that print what they are told to: -o json and -o yaml print the whole object, whose environment values
// the proxy hides, but these can print a value by itself, past that.
const PROJECTING = new Set(['jsonpath', 'jsonpath-as-json', 'custom-columns', 'go-template', 'template']);
// A path that ends at one of these ends at an object that holds containers, environment or annotations.
const WHOLE = new Set(['containers', 'initContainers', 'ephemeralContainers', 'spec', 'template', 'items', 'jobTemplate', 'podTemplate', 'metadata', 'annotations']);

/** The last field a path names, with its trailing subscripts and filters taken off ("containers[*]" is "containers"). */
function lastName(path: string): string {
  let depth = 0;
  let current = '';
  let last = '';
  for (const ch of path) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) {
      if (current) last = current;
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) last = current;
  return last.replace(/(\[[^\]]*\])+$/, '');
}

/** Whether a JSONPath can print an environment value: it names one, reaches down everywhere, or ends at an object that holds them. */
function pathReachesEnvironment(path: string): boolean {
  const s = path.trim();
  if (!s || s === '.' || s === '@' || s === '$') return true;
  if (s.includes('..')) return true;
  if (/\b(env|envFrom|valueFrom|value|environment|annotations|last-applied-configuration)\b/i.test(s)) return true;
  const name = lastName(s);
  return name === '' || name === '*' || WHOLE.has(name);
}

/** The paths of a jsonpath template ({.a.b}{"\n"}{range .items[*]}{.c}{end}), or of the whole text when it has no braces. */
function jsonPaths(spec: string): string[] {
  const groups = [...spec.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!.trim());
  if (!groups.length) return spec.trim() ? [spec.trim()] : [];
  // "range .items[*]" says what to repeat over and prints nothing itself; what is printed is the paths in its body.
  return groups.filter((g) => g !== '' && g !== 'end' && !/^range\s/.test(g) && !/^(".*"|'.*')$/.test(g));
}

/** The paths of a custom-columns spec (NAME:.metadata.name,IMAGE:.spec.containers[*].image). */
function columnPaths(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => (part.includes(':') ? part.slice(part.indexOf(':') + 1) : part));
}

/** Whether an output format can print the value of an environment variable by itself (a template program always can). */
export function projectionReachesEnvironment(format: { name: string; spec: string }): boolean {
  if (!PROJECTING.has(format.name)) return false;
  if (format.name === 'go-template' || format.name === 'template') return true;
  const paths = format.name === 'custom-columns' ? columnPaths(format.spec) : jsonPaths(format.spec);
  return paths.length === 0 || paths.some(pathReachesEnvironment);
}

/**
 * What a get, describe or rollout history prints, with every environment variable's value hidden and its name kept: -o json
 * and -o yaml parsed (an answer that cannot be parsed is not shown), --raw JSON, and describe's "Environment:" blocks. A
 * table, names or wide print no environment, so they are as they came. null: not to be shown.
 */
export function hideKubeOutput(args: string[], text: string, ok: boolean): string | null {
  const p = parseKube(args);
  if (p.verb === 'describe' || p.verb === 'rollout history') return hideDescribedEnvironment(text);
  if (p.verb !== 'get') return text;
  const name = outputFormat(args)?.name;
  if (name !== 'json' && name !== 'yaml' && p.raw === undefined) return text;
  if (name !== 'json' && name !== 'yaml') {
    try {
      return JSON.stringify(hideSecrets(JSON.parse(text)), null, 2);
    } catch {
      return text; // a raw endpoint that is not JSON (metrics, health) holds no object with an environment
    }
  }
  const hidden = hideInStructuredText(text, name);
  return hidden ?? (ok ? null : text); // a failure's text is an error message, not an answer
}

/**
 * Whether the call makes kubectl read a local file or URL: -f, --filename, -k or --kustomize (attached forms too, such as
 * -f/path), or an output template read from a file. For logs, -f is "follow", which reads nothing.
 */
export function readsLocalFile(p: ParsedKube, args: string[]): boolean {
  if (p.verb !== 'logs' && (p.flags.has('-f') || p.flags.has('--filename') || p.flags.has('-k') || p.flags.has('--kustomize'))) return true;
  if (p.verb !== 'logs' && args.some((a) => /^-[fk]./.test(a) || /^--(filename|kustomize)(=|$)/.test(a))) return true;
  return args.some((a) => /(go-template-file|jsonpath-file|custom-columns-file|templatefile)/i.test(a));
}

export function classifyKube(args: string[], envs: Environments): Classified {
  const p = parseKube(args);
  const summary = `kubectl ${args.join(' ')}`.slice(0, 300);
  if (!p.context) return invalid('kube.no_context', summary, 'Every kubectl call names its context: add --context, for example --context dev.');
  if (p.authFlag) {
    return { tier: 3, kind: 'kube.auth', summary, reason: `${p.authFlag} would change who kubectl is or which cluster or file it uses. The orchestrator runs it with the run's own kubeconfig.` };
  }
  if (!p.verb) return invalid('kube.no_verb', summary, 'No kubectl command was given.');
  if (p.verb.startsWith('config')) return { tier: 3, kind: 'kube.config', summary, reason: 'kubectl config is refused: no command may change a kube context, and contexts are named with --context on each call.' };
  const resolved = resolveContext(envs, p.context);
  if (resolved.kind === 'prod') return { tier: 3, kind: `kube.${verbKind(p.verb)}`, environment: 'prod', summary, reason: `${p.context} is prod. There is no prod access at all.` };
  if (resolved.kind === 'unknown') {
    const known = envs.list.flatMap((e) => (e.kubeContext ? [`${e.name} (${e.kubeContext})`] : [])).join(', ');
    const local = envs.list.some((e) => e.name === 'local') ? '' : ' There is no local cluster yet.';
    return invalid('kube.unknown_context', summary, `${p.context} is not a configured context. Use one of: ${known}.${local}`);
  }
  const env: Environment | undefined = resolved.kind === 'env' ? resolved.env : undefined;
  const environment = resolved.kind === 'env' ? resolved.env.name : resolved.name;
  const aws = env ? needsAws(env) : true;
  const base = { environment, summary, needsAws: aws };
  const kind = `kube.${verbKind(p.verb)}`;
  // What it names, including words after "--" (kubectl reads those as names too: "get -- secrets").
  const types = typesOf([...p.resources, ...p.rest.filter((w) => w.startsWith('-- ')).map((w) => w.slice(3))]);

  const tier3 = (reason: string): Classified => ({ ...base, tier: 3, kind, reason });
  if (p.verb === 'apply' || p.verb === 'replace') return tier3(`kubectl ${p.verb} is never run by an agent; it is alex's to do.`);
  if (p.verb === 'delete') return tier3(types.some((t) => /^(pods?|po)$/.test(t)) ? 'Deleting pods is alex\'s to do.' : 'kubectl delete is never run by an agent; it is alex\'s to do.');
  if (p.verb === 'drain') return tier3('Draining a node deletes its pods; that is alex\'s to do.');
  if ((p.verb === 'edit' || p.verb === 'patch' || p.verb.startsWith('create') || p.verb === 'set env' || p.verb === 'label' || p.verb === 'annotate') && (types.some((t) => SECRETISH.test(t)) || /^create (secret|configmap)/.test(p.verb))) {
    return tier3('Editing or creating configmaps and secrets is alex\'s to do.');
  }
  if (p.verb === 'edit') return invalid('kube.edit', summary, 'kubectl edit is interactive. Use set image, scale or rollout restart, or patch with a stated patch.');
  // kubectl runs in the orchestrator, outside the sandbox, with his access: a file or URL it reads (-f, -k, a template
  // file) can be one the sandbox hides, and its error message prints what it found in it.
  if (readsLocalFile(p, args)) {
    return tier3('kubectl would read a local file or a URL (-f, -k, a template file) with alex\'s access, outside the sandbox; its error messages print what it finds. Read the cluster with get, describe and logs instead.');
  }

  if (resolved.kind === 'unknown_listed') {
    return { ...base, tier: 2, kind, reason: `${p.context} is not ours: every call to it is asked, reads included.` };
  }

  // Deploying a product service is alex's; only the harness may be changed.
  const workload = workloadNamed(p);
  if (DEPLOYS.has(p.verb) && workload && !isHarness(envs, workload.name)) {
    const harness = envs.harness.length ? ` Only the test harness (${envs.harness.join(', ')}) may be changed.` : '';
    return tier3(`${workload.name} is a product service: deploying it is alex's.${harness} Hand over with ask_user (environment, source SHAs, image tags, scenarios, rollback) and wait.`);
  }

  // Reads.
  const readsSecret = types.some((t) => SECRET.test(t)) || (p.raw !== undefined && /\/secrets([/?#]|$)/i.test(p.raw));
  if (READS.has(p.verb) || p.verb === 'rollout status' || p.verb === 'rollout history' || p.verb === 'auth can-i') {
    if (readsSecret) return { ...base, tier: 2, kind: 'kube.read_secret', reason: 'Reading a secret is always asked first.' };
    // get, describe and rollout history print environment variables' values, which the proxy hides (-o json and -o yaml
    // whole): an output format that can print a value by itself is reading values, so it is asked.
    const format = p.verb === 'get' ? outputFormat(args) : undefined;
    if (format && projectionReachesEnvironment(format)) {
      return { ...base, tier: 2, kind: 'kube.read_secret', reason: `-o ${format.name} can print the value of an environment variable, which -o yaml and -o json hide: read the whole object with one of those, or this is asked first.` };
    }
    const hides = p.verb === 'get' || p.verb === 'describe' || p.verb === 'rollout history';
    return { ...base, tier: 0, kind, reason: 'A read.', ...(hides ? { hideSecrets: true as const } : {}) };
  }
  if (p.allNamespaces) return invalid(kind, summary, 'A change cannot span all namespaces. Name one with -n.');

  // Writes: the harness in the environment's own namespace on dev or local: image, restart and scale are done at once.
  const devLike = environment === 'dev' || environment === 'local';
  const ownNamespace = !p.namespace || !env?.namespace || p.namespace === env.namespace;
  const free = DEV_FREE[p.verb];
  if (free) {
    if (devLike && ownNamespace && workload) return { ...base, tier: 1, kind: free, reason: `${verbWords(p.verb)} of the harness on ${environment} is done at once, with the earlier state recorded.` };
    // The harness in its environment's own namespace: what delegation knows as a harness write.
    const harness = workload && ownNamespace ? { harness: true as const } : {};
    if (p.verb === 'scale') return { ...base, ...harness, tier: 2, kind: free, reason: `Scaling anything outside dev is asked first${devLike ? ', and so is a namespace other than the environment\'s' : ''}.` };
    return { ...base, ...harness, tier: 2, kind: free, reason: devLike ? `Outside ${env?.namespace}, a change is asked first.` : `Any kubectl write on ${environment} is asked first.` };
  }
  if (['exec', 'attach', 'port-forward', 'cp', 'run', 'debug', 'proxy'].includes(p.verb)) {
    return { ...base, tier: 2, kind: 'kube.traffic', reason: `kubectl ${p.verb} reaches into the ${environment} cluster: asked first.` };
  }
  if (p.verb.startsWith('rollout ') || ['patch', 'label', 'annotate', 'scale', 'autoscale', 'expose', 'cordon', 'uncordon', 'taint'].includes(p.verb) || p.verb.startsWith('set ') || p.verb.startsWith('create')) {
    return { ...base, tier: 2, kind, reason: `kubectl ${p.verb} on ${environment} is asked first.` };
  }
  return { ...base, tier: 2, kind, reason: `kubectl ${p.verb} is not a known command: asked first.` };
}

const verbKind = (verb: string): string => verb.replace(/ /g, '_').replace(/[^a-z_-]/gi, '') || 'call';
const verbWords = (verb: string): string => ({ 'set image': 'Changing an image', 'rollout restart': 'A restart', scale: 'Scaling' })[verb] ?? verb;

/** Words with the context as kubectl knows it ("dev" becomes dev's configured context). */
function withContext(args: string[], envs: Environments): string[] {
  return args.map((a, i) => {
    if (args[i - 1] === '--context') return contextName(envs, a);
    if (a.startsWith('--context=')) return `--context=${contextName(envs, a.slice('--context='.length))}`;
    return a;
  });
}

/**
 * Words as they run: the context as kubectl knows it, and the environment's namespace added when the call names none,
 * so it never runs in "default" by accident.
 */
function withNamespace(raw: string[], envs: Environments): string[] {
  const args = withContext(raw, envs);
  const p = parseKube(args);
  if (p.namespace || p.allNamespaces || !p.context) return args;
  const resolved = resolveContext(envs, p.context);
  const ns = resolved.kind === 'env' ? resolved.env.namespace : undefined;
  if (!ns || ['api-resources', 'api-versions', 'version', 'cluster-info', 'explain'].includes(p.verb)) return args;
  return [...args, '-n', ns];
}

interface Workload {
  kind: string;
  name: string;
  namespace?: string;
  replicas?: number;
  revision?: string;
  containers: Array<{ name: string; image: string }>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

function workloadOf(json: string): Workload | null {
  try {
    const o = JSON.parse(json) as {
      kind?: string;
      metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
      spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name: string; image: string }> } } };
    };
    if (!o.kind || !o.metadata?.name) return null;
    return {
      kind: o.kind,
      name: o.metadata.name,
      ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}),
      ...(o.spec?.replicas !== undefined ? { replicas: o.spec.replicas } : {}),
      ...(o.metadata.annotations?.['deployment.kubernetes.io/revision'] ? { revision: o.metadata.annotations['deployment.kubernetes.io/revision'] } : {}),
      containers: (o.spec?.template?.spec?.containers ?? []).map((c) => ({ name: c.name, image: c.image })),
      labels: o.metadata.labels ?? {},
      annotations: o.metadata.annotations ?? {},
    };
  } catch {
    return null;
  }
}

const PINNED = /@sha256:[0-9a-f]{64}$/;

export class KubeProxy implements ProxyHandler<KubeRequest> {
  readonly name = 'kube' as const;
  readonly schema = schema;

  constructor(
    private readonly envs: Environments,
    private readonly kubectl: Kubectl,
  ) {}

  async classify(request: KubeRequest, run: RunRef): Promise<Classified> {
    const c = classifyKube(request.args, this.envs);
    if (c.kind !== 'kube.set_image' || c.tier === 3) return c;
    // Replacing a pinned digest is always asked, and the question says so.
    const target = await this.read(request.args, run).catch(() => null);
    const pinned = target?.containers.filter((x) => PINNED.test(x.image) && this.changed(request.args).has(x.name)) ?? [];
    if (!pinned.length) return c;
    return {
      ...c,
      tier: 2,
      reason: 'Replacing a pinned image digest is asked first.',
      warning: `A pinned digest will be replaced: ${pinned.map((x) => `${x.name} at ${x.image}`).join(', ')}.`,
    };
  }

  /** The workload a write names, as it is now. */
  private async read(args: string[], run: RunRef): Promise<Workload | null> {
    const p = parseKube(withNamespace(args, this.envs));
    const resource = p.resources[0];
    if (!resource || !p.context) return null;
    const get = ['--context', p.context, ...(p.namespace ? ['-n', p.namespace] : []), 'get', resource, '-o', 'json'];
    const r = await this.kubectl(get, run.kubeconfig);
    return r.ok ? workloadOf(r.stdout) : null;
  }

  /** The containers a set image changes: name=image pairs; "*" changes all. */
  private changed(args: string[]): Map<string, string> {
    return new Map(parseKube(args).rest.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  }

  async record(request: KubeRequest, c: Classified, run: RunRef): Promise<Recorded | null> {
    if (c.tier === 0) return null;
    const p = parseKube(withNamespace(request.args, this.envs));
    const where = `${p.namespace ? ` in ${p.namespace}` : ''} on ${c.environment}`;
    const ctx = ['--context', p.context!, ...(p.namespace ? ['-n', p.namespace] : [])];
    if (['kube.traffic', 'kube.create', 'kube.create_deployment', 'kube.create_job', 'kube.run', 'kube.expose', 'kube.autoscale'].includes(c.kind) || p.verb.startsWith('create')) {
      return { target: `${p.verb}${p.resources[0] ? ` ${p.resources[0]}` : ''}${where}`, before: 'Nothing: it adds or reaches into something rather than changing what is there.', noUndo: 'Removing what it adds would be a delete, which only alex may run.' };
    }
    const w = await this.read(request.args, run);
    if (!w) throw new Error(`The earlier state of ${p.resources[0] ?? 'the resource'} could not be read, so nothing was changed.`);
    const target = `${w.kind.toLowerCase()}/${w.name}${where}`;
    const res = `${w.kind.toLowerCase()}/${w.name}`;
    switch (c.kind) {
      case 'kube.set_image': {
        const changed = this.changed(request.args);
        const touched = w.containers.filter((x) => changed.has(x.name) || changed.has('*'));
        if (!touched.length) throw new Error(`${res} has no container named ${[...changed.keys()].join(', ')}.`);
        return {
          target,
          before: touched.map((x) => `container ${x.name}: image ${x.image}`).join('; '),
          undo: { proxy: 'kube', summary: `Set ${touched.map((x) => `${x.name} back to ${x.image}`).join(', ')}`, request: { args: [...ctx, 'set', 'image', res, ...touched.map((x) => `${x.name}=${x.image}`)] } },
        };
      }
      case 'kube.scale':
        if (w.replicas === undefined) throw new Error(`${res} has no replica count to record.`);
        return { target, before: `${w.replicas} replica${w.replicas === 1 ? '' : 's'}`, undo: { proxy: 'kube', summary: `Scale ${res} back to ${w.replicas}`, request: { args: [...ctx, 'scale', res, `--replicas=${w.replicas}`] } } };
      case 'kube.restart':
        if (!w.revision) return { target, before: 'No rollout revision to go back to.', noUndo: `${res} has no rollout revision recorded.` };
        return { target, before: `rollout revision ${w.revision}`, undo: { proxy: 'kube', summary: `Roll ${res} back to revision ${w.revision}`, request: { args: [...ctx, 'rollout', 'undo', res, `--to-revision=${w.revision}`] } } };
      case 'kube.label':
      case 'kube.annotate': {
        const field = c.kind === 'kube.label' ? 'labels' : 'annotations';
        const current = w[field];
        const keys = p.rest.length ? [] : request.args.filter((a) => /^[\w./-]+(=.*|-)$/.test(a) && !a.startsWith('-')).map((a) => a.replace(/(=.*|-)$/, ''));
        const restore = keys.map((k) => (k in current ? `${k}=${current[k]}` : `${k}-`));
        return {
          target,
          before: keys.map((k) => (k in current ? `${k}=${current[k]}` : `${k} not set`)).join('; ') || `its ${field}`,
          ...(restore.length
            ? { undo: { proxy: 'kube', summary: `Put ${res}'s ${field} back`, request: { args: [...ctx, c.kind === 'kube.label' ? 'label' : 'annotate', res, ...restore, '--overwrite'] } } }
            : { noUndo: `Which ${field} it changes could not be read from the call.` }),
        };
      }
      default:
        return {
          target,
          before: `${w.kind} ${w.name}: ${w.replicas ?? '?'} replicas, ${w.containers.map((x) => `${x.name} ${x.image}`).join(', ') || 'no containers'}`,
          noUndo: `Putting back a ${p.verb} would need kubectl apply or replace, which only alex may run; its earlier state is recorded here.`,
        };
    }
  }

  async execute(request: KubeRequest, c: Classified, run: RunRef): Promise<Outcome> {
    const args = withNamespace(request.args, this.envs);
    const r = await this.kubectl(args, run.kubeconfig);
    let text = r.ok ? r.stdout : r.stderr || r.stdout;
    if (c.hideSecrets) {
      const hidden = hideKubeOutput(args, text, r.ok);
      if (hidden === null) return { ok: false, output: 'The answer could not be read, so it is not shown: the values of environment variables cannot be hidden in what is not understood.' };
      text = hidden;
    }
    const output = shortOutput(redact(text));
    if (!r.ok) return { ok: false, output: output || 'kubectl failed.' };
    const p = parseKube(args);
    const res = p.resources[0] ?? '';
    const images = p.rest.map((x) => x.slice(x.indexOf('=') + 1)).join(', ');
    const replicas = String(p.flags.get('--replicas') ?? '?');
    const done =
      c.kind === 'kube.set_image'
        ? { en: `changed ${res}'s image on ${c.environment} to ${images}; the earlier image is recorded`, vi: `đã đổi image của ${res} trên ${c.environment} thành ${images}; image cũ đã được ghi lại` }
        : c.kind === 'kube.restart'
          ? { en: `restarted ${res} on ${c.environment}`, vi: `đã restart ${res} trên ${c.environment}` }
          : c.kind === 'kube.scale'
            ? { en: `scaled ${res} on ${c.environment} to ${replicas}`, vi: `đã đặt số replica của ${res} trên ${c.environment} thành ${replicas}` }
            : { en: `ran kubectl ${p.verb} on ${c.environment}`, vi: `đã chạy kubectl ${p.verb} trên ${c.environment}` };
    return { ok: true, output: output || 'Done.', done: done.en, doneVi: done.vi };
  }
}
