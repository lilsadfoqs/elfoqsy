// The shop proxy: alex's shop.sh, for the one command a run needs, build-integration-test <environment>. It
// builds the integration-test image from the run's clone of the shop-worker repository, pushes it to that environment's ECR
// and points the shop-integration-test deployment at it. The script is run from a private copy of shop-local-deploy
// (outside the run's sandbox, so its copy step never writes into /code and the agent never reads its .env), with the
// run's own kubeconfig and Docker config, ENVIRONMENT fixed (the copy's .env line that overrides it is taken out), and
// sudo replaced by a stub that fails. On dev it is done at once, the harness's earlier image recorded first (Undo sets
// it back); elsewhere it is asked; prod is refused. Every other shop.sh command is refused: the local ones mount the
// Docker socket and ~/.ssh into a builder.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { redact } from '../redact';
import { contextName, type Environments } from './environments';
import { dockerConfigOf } from './docker';
import type { Kubectl } from './kube';
import { invalid, shortOutput, type Classified, type ExecResult, type Outcome, type ProxyHandler, type Recorded, type RunRef } from './types';

export interface ShopRequest {
  command: 'build-integration-test';
  environment: string;
}

export interface ShopBackend {
  /** bash shop.sh <args> in a folder, with exactly this environment. */
  script: (cwd: string, args: string[], env: Record<string, string>) => Promise<ExecResult>;
}

const schema = z.object({ command: z.literal('build-integration-test'), environment: z.string().min(1).max(40) });

/** The harness the command changes. */
export const HARNESS = 'shop-integration-test';
const WORKER = /(^|\/)shop-worker$/;

/** The copy's .env without the line that overrides ENVIRONMENT. */
export const withoutEnvironment = (dotenv: string): string =>
  dotenv
    .split('\n')
    .filter((l) => !/^\s*(export\s+)?ENVIRONMENT\s*=/.test(l))
    .join('\n');

const SUDO_STUB = '#!/bin/sh\necho "sudo is not available to agents: alex runs anything that needs it." >&2\nexit 1\n';

export class ShopProxy implements ProxyHandler<ShopRequest> {
  readonly name = 'shop' as const;
  readonly schema = schema;

  constructor(
    private readonly envs: Environments,
    /** alex's shop-local-deploy checkout (read only), absent when there is none. */
    private readonly source: string | undefined,
    private readonly backend: ShopBackend,
    private readonly kubectl: Kubectl,
    /** What the script needs from the daemon's environment: PATH, HOME, AWS files. */
    private readonly baseEnv: Record<string, string>,
  ) {}

  async classify(request: ShopRequest, run: RunRef): Promise<Classified> {
    const summary = `shop.sh build-integration-test ${request.environment}`;
    const kind = 'shop.build_integration_test';
    if (!this.source || !existsSync(join(this.source, 'shop.sh'))) return invalid(kind, summary, 'shop-local-deploy is not available to the orchestrator.');
    if (/(^|[^a-z])(prod|prd|production)([^a-z]|$)/i.test(request.environment)) return { tier: 3, kind, summary, environment: 'prod', reason: 'There is no prod access at all.' };
    const env = this.envs.list.find((e) => e.name === request.environment);
    if (!env?.kubeContext || !env.awsProfile) {
      return invalid(kind, summary, `build-integration-test runs on ${this.envs.list.filter((e) => e.kubeContext && e.awsProfile).map((e) => e.name).join(', ')}.`);
    }
    if (!this.worker(run)) return invalid(kind, summary, 'This run has no clone of shop-worker to build the integration test from.');
    const base = { kind, summary, environment: env.name, needsAws: true, harness: true as const };
    if (env.name === 'dev') return { ...base, tier: 1, reason: `Rebuilding the test harness (${HARNESS}) on dev is done at once, with its earlier image recorded.` };
    return { ...base, tier: 2, reason: `Rebuilding the test harness on ${env.name} is asked first: ${env.name === 'integration' ? 'QA and others share it' : 'it serves releases'}.` };
  }

  private worker(run: RunRef): string | undefined {
    return run.clones?.find((c) => WORKER.test(c.repo))?.path;
  }

  async record(request: ShopRequest, c: Classified, run: RunRef): Promise<Recorded> {
    const env = this.envs.list.find((e) => e.name === c.environment)!;
    const ctx = ['--context', contextName(this.envs, env.kubeContext!), ...(env.namespace ? ['-n', env.namespace] : [])];
    const r = await this.kubectl([...ctx, 'get', `deployment/${HARNESS}`, '-o', 'jsonpath={range .spec.template.spec.containers[*]}{.name}={.image}{"\\n"}{end}'], run.kubeconfig);
    if (!r.ok) throw new Error(`The harness's image on ${env.name} could not be read: ${redact(r.stderr).slice(0, 200)}`);
    const pairs = r.stdout.split('\n').filter((l) => l.includes('='));
    return {
      target: `deployment/${HARNESS} on ${env.name}`,
      before: pairs.map((x) => `container ${x.replace('=', ': image ')}`).join('; ') || 'no containers',
      ...(pairs.length
        ? { undo: { proxy: 'kube' as const, summary: `Set ${HARNESS} back to ${pairs.map((x) => x.split('=')[1]).join(', ')}`, request: { args: [...ctx, 'set', 'image', `deployment/${HARNESS}`, ...pairs] } } }
        : { noUndo: 'Its earlier image could not be read.' }),
    };
  }

  async execute(request: ShopRequest, c: Classified, run: RunRef): Promise<Outcome> {
    const priv = dirname(run.kubeconfig);
    const copy = join(priv, 'shop-local-deploy');
    const bin = join(priv, 'bin');
    // A fresh private copy each time: the script writes into its own folder.
    rmSync(copy, { recursive: true, force: true });
    cpSync(this.source!, copy, { recursive: true, filter: (src) => !/\/\.git(\/|$)/.test(src) });
    const dotenv = join(copy, '.env');
    if (existsSync(dotenv)) writeFileSync(dotenv, withoutEnvironment(readFileSync(dotenv, 'utf8')));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'sudo'), SUDO_STUB);
    chmodSync(join(bin, 'sudo'), 0o755);
    const worker = this.worker(run)!;
    const env = {
      ...this.baseEnv,
      PATH: `${bin}:${this.baseEnv.PATH ?? '/usr/bin:/bin'}`,
      KUBECONFIG: run.kubeconfig,
      DOCKER_CONFIG: dockerConfigOf(run),
      ENVIRONMENT: request.environment,
      SHOP_WORKER_DIR: worker,
      WORKER_DIR: worker,
    };
    const r = await this.backend.script(copy, ['build-integration-test', request.environment], env);
    const output = shortOutput(redact(`${r.stdout}\n${r.stderr}`.trim()), 4000);
    if (!r.ok) return { ok: false, output: output || 'shop.sh build-integration-test failed.' };
    return { ok: true, output: output || 'Done.', done: `rebuilt the test harness (${HARNESS}) on ${c.environment} from its branch; the earlier image is recorded`, doneVi: `đã build lại test harness (${HARNESS}) trên ${c.environment} từ branch của nó; image cũ đã được ghi lại` };
  }
}
