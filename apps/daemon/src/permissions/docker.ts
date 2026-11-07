// The docker proxy: an agent's docker call, run by the orchestrator on alex's Docker with the run folder as its
// working folder. Docker runs as root, so anything that reaches the host is refused: a bind mount outside the run folder,
// the Docker socket, privileged mode, added capabilities or devices, the host's network, PID, IPC or user namespace,
// another daemon or context, and logins (the orchestrator logs in to ECR itself, into a Docker config only this run
// uses, so his own ~/.docker is never touched). Reads, builds, pulls and the run's own containers are free; pushing an
// image is asked; pruning, compose and the rest are refused or asked as below.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { redact } from '../redact';
import type { Environments } from './environments';
import { invalid, shortOutput, type Classified, type ExecResult, type Outcome, type ProxyHandler, type RunRef } from './types';

export interface DockerRequest {
  /** docker's arguments, without "docker". */
  args: string[];
}

export interface DockerBackend {
  /** docker with the run's own Docker config, in the run folder. */
  docker: (args: string[], o: { cwd: string; dockerConfig: string }) => Promise<ExecResult>;
  /** ECR login for one registry with one AWS profile, into the run's own Docker config; the password never leaves the pipe. */
  ecrLogin: (registry: string, profile: string, region: string, dockerConfig: string) => Promise<ExecResult>;
}

const schema = z.object({ args: z.array(z.string().max(4000)).min(1).max(80) });

const READS = new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'history', 'top', 'port', 'stats', 'diff', 'events', 'search']);
const SUB_READS = new Set(['ls', 'inspect', 'history', 'logs', 'ps', 'top', 'port', 'diff', 'stats']);
const OBJECTS = new Set(['container', 'image', 'volume', 'network']);
// Flags of docker itself (before the command) that reach another daemon or another set of credentials.
const GLOBAL_REFUSED = new Set(['-H', '--host', '--context', '-c', '--config', '--tlscacert', '--tlscert', '--tlskey']);
// Flags that take a value as the next word.
// -f and -t take a value only in a build (the Dockerfile, the tag); elsewhere they are --force and --tty.
const BUILD_VALUE_FLAGS = new Set(['-f', '-t']);
const VALUE_FLAGS = new Set([
  '-v', '--volume', '--mount', '--network', '--net', '--pid', '--ipc', '--uts', '--userns', '--cgroupns', '--cap-add', '--device', '--security-opt',
  '--env-file', '-e', '--env', '--name', '-p', '--publish', '-w', '--workdir', '--entrypoint', '-u', '--user', '-l', '--label', '--platform', '--tag',
  '--file', '--build-arg', '--target', '-o', '--output', '--secret', '--ssh', '--volumes-from', '--memory', '-m', '--cpus', '--hostname', '-h',
  '--add-host', '--restart', '--format', '--filter', '--since', '--until', '--tail', '-n', '--signal', '-s', '--log-driver', '--log-opt', '--cache-from',
  '--gpus', '--shm-size', '--ulimit', '--dns', '--runtime', '--cgroup-parent', '--group-add', '--link', '--iidfile', '--cidfile',
]);

interface Parsed {
  /** The command: "run", "image ls", "compose". */
  command: string;
  /** Words after the command that are not flags (an image, a container, a build context). */
  positional: string[];
  /** Every flag with its value (true when it has none), in order. */
  flags: Array<[string, string | true]>;
  globalRefused?: string;
}

export function parseDocker(args: string[]): Parsed {
  let i = 0;
  let globalRefused: string | undefined;
  while (i < args.length && args[i]!.startsWith('-')) {
    const name = args[i]!.split('=')[0]!;
    if (GLOBAL_REFUSED.has(name)) globalRefused ??= name;
    i += args[i]!.includes('=') || !GLOBAL_REFUSED.has(name) && !['-l', '--log-level'].includes(name) ? 1 : 2;
  }
  const first = args[i] ?? '';
  const second = args[i + 1] ?? '';
  const two = OBJECTS.has(first) || ['compose', 'buildx', 'system', 'context', 'plugin', 'swarm', 'trust', 'secret', 'config', 'manifest'].includes(first);
  const command = two && second && !second.startsWith('-') ? `${first} ${second}` : first;
  const rest = args.slice(i + (command.includes(' ') ? 2 : 1));
  const flags: Array<[string, string | true]> = [];
  const positional: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j]!;
    if (a === '--') {
      positional.push(...rest.slice(j + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      if (eq > 0) flags.push([a.slice(0, eq), a.slice(eq + 1)]);
      else if (VALUE_FLAGS.has(a) || ((command === 'build' || command === 'image build') && BUILD_VALUE_FLAGS.has(a))) {
        flags.push([a, rest[j + 1] ?? '']);
        j++;
      } else flags.push([a, true]);
      continue;
    }
    // After the image of a run or create, the rest is the container's own command.
    positional.push(a);
    if ((command === 'run' || command === 'create' || command === 'container run' || command === 'container create') && positional.length === 1) {
      positional.push(...rest.slice(j + 1));
      break;
    }
  }
  return { command, positional, flags, ...(globalRefused ? { globalRefused } : {}) };
}

const values = (p: Parsed, ...names: string[]): string[] => p.flags.filter(([n]) => names.includes(n)).map(([, v]) => (v === true ? '' : v));
const hasFlag = (p: Parsed, ...names: string[]): boolean => p.flags.some(([n]) => names.includes(n));

/** Whether a host path is inside the run folder, read from the run folder. */
const insideRun = (root: string, path: string): boolean => {
  const full = resolve(root, path);
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const SOCKET = /docker\.sock|containerd\.sock|podman\.sock|\/var\/run\/docker|\/run\/docker/;

/** Why a mount reaches the host, or null: -v src:dst[:opts], or --mount type=bind,source=…,target=…. */
function mountProblem(root: string, spec: string, long: boolean): string | null {
  if (SOCKET.test(spec)) return 'Mounting the Docker socket hands over the host.';
  let source: string | undefined;
  let bind = true;
  if (long) {
    const parts = Object.fromEntries(spec.split(',').map((kv) => [kv.split('=')[0]!.trim(), kv.slice(kv.indexOf('=') + 1).trim()]));
    bind = !parts.type || parts.type === 'bind';
    source = parts.source ?? parts.src;
  } else {
    const [src, dst] = spec.split(':');
    if (dst === undefined) return null; // an anonymous volume
    source = src;
    bind = !!src && (src.startsWith('/') || src.startsWith('.') || src.startsWith('~') || src.startsWith('$'));
  }
  if (!bind || !source) return null; // a named volume Docker manages
  if (source.startsWith('~') || source.startsWith('$')) return `${source} is outside the run folder.`;
  return insideRun(root, source) ? null : `${source} is outside the run folder.`;
}

const REGISTRY = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\//;

/** The environment of an ECR image of a configured account, if it is one. */
export function ecrOf(envs: Environments, image: string): { registry: string; profile: string; region: string; environment: string } | null {
  const m = REGISTRY.exec(image);
  if (!m) return null;
  const env = envs.list.find((e) => e.awsAccount === m[1] && e.awsProfile);
  return env ? { registry: `${m[1]}.dkr.ecr.${m[2]}.amazonaws.com`, profile: env.awsProfile!, region: m[2]!, environment: env.name } : null;
}

/** The images a Dockerfile builds from (its FROM lines). */
function fromImages(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1]!);
}

export function classifyDocker(args: string[], envs: Environments, run: RunRef): Classified {
  const p = parseDocker(args);
  const summary = `docker ${args.join(' ')}`.slice(0, 300);
  const kind = `docker.${p.command.replace(/ /g, '_') || 'call'}`;
  const never = (reason: string): Classified => ({ tier: 3, kind, summary, reason });
  const root = run.root;
  if (!root) return invalid(kind, summary, 'This run has no folder for Docker to work in.');
  if (p.globalRefused) return never(`${p.globalRefused} would reach another Docker daemon or other credentials.`);
  if (!p.command) return invalid(kind, summary, 'No docker command was given.');
  if (['login', 'logout'].includes(p.command)) return never('Docker logins are the orchestrator\'s: it logs in to ECR itself when an image needs it.');
  if (p.command.startsWith('compose') || p.command === 'compose') return never('docker compose files mount the socket and host folders; run the containers you need with docker run instead.');
  if (/^(buildx|context|swarm|plugin|trust|secret|config|system prune|image prune|container prune|volume prune|network prune|builder)/.test(p.command)) {
    return never(`docker ${p.command} changes the Docker setup or removes what others made; it is alex's to do.`);
  }
  // Reads.
  if (READS.has(p.command) || (p.command.includes(' ') && SUB_READS.has(p.command.split(' ')[1]!))) {
    return { tier: 0, kind, summary, reason: 'A read.' };
  }
  // A build: its context, Dockerfile and outputs in the run folder; no host secrets or SSH agent.
  if (p.command === 'build' || p.command === 'image build') {
    if (hasFlag(p, '--secret', '--ssh')) return never('Build secrets and the SSH agent come from the host; a build gets neither.');
    if (values(p, '--network').some((v) => v === 'host')) return never("A build on the host's network reaches the host.");
    const context = p.positional[0] ?? '.';
    if (/^(https?|git):\/\/|^git@/.test(context)) return invalid(kind, summary, 'Build from a folder in the run folder, not a URL.');
    for (const path of [context, ...values(p, '-f', '--file'), ...values(p, '-o', '--output').map((o) => o.replace(/^.*dest=/, '')), ...values(p, '--iidfile')]) {
      if (path && path !== '-' && !insideRun(root, path)) return never(`${path} is outside the run folder.`);
    }
    return { tier: 0, kind, summary, reason: 'A build from the run folder.', needsAws: needsEcr(envs, root, p) };
  }
  if (p.command === 'pull' || p.command === 'image pull') {
    const image = p.positional[0] ?? '';
    return { tier: 0, kind, summary, reason: 'A pull.', ...(ecrOf(envs, image) ? { needsAws: true, environment: ecrOf(envs, image)!.environment } : {}) };
  }
  if (p.command === 'push' || p.command === 'image push') {
    const image = p.positional[0] ?? '';
    const ecr = ecrOf(envs, image);
    if (!ecr) return never(`Pushing ${image || 'an image'} outside the team's ECR is alex's to do.`);
    // The test harness's image, for delegation.
    const harness = envs.harness.some((h) => image.split('@')[0]!.split(':')[0]!.endsWith(`/${h}`)) ? { harness: true as const } : {};
    return { tier: 2, kind, summary, environment: ecr.environment, needsAws: true, ...harness, reason: `Pushing an image to ${ecr.environment}'s ECR is asked first.` };
  }
  // Containers: started by this run, and only with what keeps them off the host.
  if (['run', 'create', 'container run', 'container create'].includes(p.command)) {
    if (hasFlag(p, '--privileged')) return never('Privileged mode hands over the host.');
    for (const [flag, v] of p.flags) {
      const value = v === true ? '' : v;
      if ((flag === '--network' || flag === '--net') && value === 'host') return never("The host's network is refused.");
      if (['--pid', '--ipc', '--uts', '--userns', '--cgroupns'].includes(flag) && (value === 'host' || value.startsWith('container:'))) return never(`${flag}=${value} reaches outside the container.`);
      if (['--cap-add', '--device', '--security-opt', '--volumes-from', '--cgroup-parent', '--runtime'].includes(flag)) return never(`${flag} gives the container more than it needs; it is refused.`);
      if (flag === '-v' || flag === '--volume' || flag === '--mount') {
        const problem = mountProblem(root, value, flag === '--mount');
        if (problem) return never(problem);
      }
      if (flag === '--env-file' && !insideRun(root, value)) return never(`${value} is outside the run folder.`);
    }
    const image = p.positional[0] ?? '';
    const ecr = ecrOf(envs, image);
    return { tier: 0, kind, summary, reason: 'A container of this run, kept off the host.', ...(ecr ? { needsAws: true, environment: ecr.environment } : {}) };
  }
  // docker cp writes on the host as root: its host side stays in the run folder.
  if (p.command === 'cp' || p.command === 'container cp') {
    const [a = '', b = ''] = p.positional;
    const local = a.includes(':') ? b : a;
    if (!local || !insideRun(root, local)) return never(`${local || 'The host side'} is outside the run folder.`);
    return { tier: 0, kind: 'docker.own_container', summary, reason: "One of this run's own containers." };
  }
  // The run's own containers: stop, start, exec, remove. Whose a container is shows in its label.
  if (['exec', 'stop', 'start', 'restart', 'kill', 'rm', 'wait', 'container exec', 'container stop', 'container start', 'container rm', 'container kill', 'container restart'].includes(p.command)) {
    if (hasFlag(p, '--privileged')) return never('Privileged mode hands over the host.');
    return { tier: 0, kind: 'docker.own_container', summary, reason: "One of this run's own containers." };
  }
  if (p.command === 'tag' || p.command === 'image tag') return { tier: 0, kind, summary, reason: 'A local tag.' };
  if (p.command === 'rmi' || p.command === 'image rm') return { tier: 2, kind, summary, reason: 'Removing an image may remove alex\'s own: asked first.' };
  return { tier: 2, kind, summary, reason: `docker ${p.command} is not a known command: asked first.` };
}

/** Whether a build pulls from a configured ECR (its Dockerfile's FROM lines), so it needs an AWS session. */
function needsEcr(envs: Environments, root: string, p: Parsed): boolean {
  const file = values(p, '-f', '--file')[0] ?? join(p.positional[0] ?? '.', 'Dockerfile');
  const path = resolve(root, file);
  if (!insideRun(root, path) || !existsSync(path)) return false;
  return fromImages(readFileSync(path, 'utf8')).some((i) => ecrOf(envs, i) !== null);
}

/** The run's own Docker config, in its private folder beside its kubeconfig (outside its sandbox). */
export const dockerConfigOf = (run: RunRef): string => join(dirname(run.kubeconfig), 'docker');

export class DockerProxy implements ProxyHandler<DockerRequest> {
  readonly name = 'docker' as const;
  readonly schema = schema;

  constructor(
    private readonly envs: Environments,
    private readonly backend: DockerBackend,
  ) {}

  async classify(request: DockerRequest, run: RunRef): Promise<Classified> {
    const c = classifyDocker(request.args, this.envs, run);
    if (c.kind !== 'docker.own_container' || c.tier !== 0) return c;
    // Only containers this run started: their label says so.
    const p = parseDocker(request.args);
    const [a = '', b = ''] = p.positional;
    const name = (p.command.endsWith('cp') ? (a.includes(':') ? a : b) : a).split(':')[0];
    if (!name) return invalid(c.kind, c.summary, 'Name the container.');
    const r = await this.backend.docker(['inspect', '--format', '{{ index .Config.Labels "elfoqsy.run" }}', name], { cwd: run.root!, dockerConfig: dockerConfigOf(run) });
    if (!r.ok || r.stdout.trim() !== run.runId) return { ...c, tier: 3, reason: `${name} is not a container this run started; it is alex's.` };
    return c;
  }

  async execute(request: DockerRequest, c: Classified, run: RunRef): Promise<Outcome> {
    const dockerConfig = dockerConfigOf(run);
    const p = parseDocker(request.args);
    // ECR images: the orchestrator logs in first, for each registry the call needs.
    const images = p.command === 'build' || p.command === 'image build' ? this.buildImages(run.root!, p) : p.positional.slice(0, 1);
    for (const image of images) {
      const ecr = ecrOf(this.envs, image);
      if (!ecr) continue;
      const login = await this.backend.ecrLogin(ecr.registry, ecr.profile, ecr.region, dockerConfig);
      if (!login.ok) return { ok: false, output: `The ECR login for ${ecr.environment} failed: ${redact(login.stderr).slice(0, 300)}` };
    }
    // Every container this run starts carries its label, so only it can stop or remove it.
    let args = request.args;
    if (['run', 'create', 'container run', 'container create'].includes(p.command)) {
      const at = request.args.indexOf(p.command.split(' ').at(-1)!) + 1;
      args = [...request.args.slice(0, at), '--label', `elfoqsy.run=${run.runId}`, ...request.args.slice(at)];
    }
    const r = await this.backend.docker(args, { cwd: run.root!, dockerConfig });
    const output = shortOutput(redact(r.ok ? r.stdout || r.stderr : r.stderr || r.stdout));
    return r.ok ? { ok: true, output: output || 'Done.', done: `ran docker ${p.command}`, doneVi: `đã chạy docker ${p.command}` } : { ok: false, output: output || 'docker failed.' };
  }

  private buildImages(root: string, p: Parsed): string[] {
    const file = values(p, '-f', '--file')[0] ?? join(p.positional[0] ?? '.', 'Dockerfile');
    const path = resolve(root, file);
    return insideRun(root, path) && existsSync(path) ? fromImages(readFileSync(path, 'utf8')) : [];
  }
}
