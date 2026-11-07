// How the proxies reach the world with alex's credentials: kubectl and aws with a minimal environment (never
// AWS_PROFILE or AWS keys, so the profile a call names is the one used), gh with his login, Coralogix with its key.
// Only the proxies call these, after the tier policy allows. Simulate mode and tests use their own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghEnv } from '../github/gh';
import { SESSION_EXPIRED } from './aws';
import type { ProbeResult } from './awsSession';
import type { ExecResult } from './types';

type Exec = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
const execFileAsync = promisify(execFile) as unknown as Exec;

// What kubectl, its EKS token plugin and the AWS CLI need from the daemon's environment, and nothing that would pick a
// profile or credentials for them.
const PASS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CA_BUNDLE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
];

export function proxyEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AWS_PAGER: '', NO_COLOR: '1' };
  for (const name of PASS) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

async function run(exec: Exec, file: string, args: string[], env: NodeJS.ProcessEnv, o: { cwd?: string; timeout?: number; input?: string } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(file, args, { env, timeout: o.timeout ?? 120_000, maxBuffer: 20 * 1024 * 1024, ...(o.cwd ? { cwd: o.cwd } : {}) });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr || e.message || `${file} failed` };
  }
}

/** gh calls no tier allows, refused here as well: merging, admin or auto flags, gh's login, secrets, repository changes. */
export function neverGh(args: string[]): string | null {
  const [group = '', verb = ''] = args.filter((a) => !a.startsWith('-'));
  if (args.some((a) => a === '--admin' || a === '--auto')) return 'gh refused: --admin and --auto are never used.';
  if (group === 'pr' && verb === 'merge') return 'gh refused: merging is alex\'s.';
  if (group === 'auth' || group === 'ssh-key' || group === 'gpg-key') return 'gh refused: gh\'s login is alex\'s.';
  if (group === 'secret' && verb !== 'list') return 'gh refused: secrets are alex\'s.';
  if (group === 'repo' && ['delete', 'rename', 'archive', 'edit', 'sync', 'transfer'].includes(verb)) return `gh refused: gh repo ${verb} is alex's.`;
  if (group === 'release' && !['list', 'view'].includes(verb)) return 'gh refused: releases are alex\'s.';
  return null;
}

export function liveBackends(source: NodeJS.ProcessEnv = process.env, exec: Exec = execFileAsync) {
  const env = proxyEnv(source);
  return {
    /** kubectl with the run's own kubeconfig, never the global one. */
    kubectl: (args: string[], kubeconfig: string) => run(exec, 'kubectl', ['--kubeconfig', kubeconfig, ...args], env),
    aws: (args: string[]) => run(exec, 'aws', [...args, '--no-cli-pager'], env),
    gh: (args: string[]) => {
      // The tiers never let these through; this is the last guard before gh runs.
      const never = neverGh(args);
      return never ? Promise.resolve({ ok: false, stdout: '', stderr: never }) : run(exec, 'gh', args, ghEnv(source));
    },
    /** alex's whole kubeconfig, for the runs' own: read with the daemon's KUBECONFIG, if any. */
    kubeconfig: async (): Promise<string | null> => {
      const r = await run(exec, 'kubectl', ['config', 'view', '--raw', '--flatten'], { ...env, ...(source.KUBECONFIG ? { KUBECONFIG: source.KUBECONFIG } : {}) });
      return r.ok ? r.stdout : null;
    },
    /** docker with the run's own Docker config, in the run folder. */
    docker: {
      docker: (args: string[], o: { cwd: string; dockerConfig: string }) => run(exec, 'docker', args, { ...env, DOCKER_CONFIG: o.dockerConfig }, { cwd: o.cwd, timeout: 30 * 60_000 }),
      // The password goes from aws to docker through a pipe in one shell: it is never in the daemon or a log.
      ecrLogin: (registry: string, profile: string, region: string, dockerConfig: string) =>
        run(exec, 'bash', ['-c', 'aws ecr get-login-password --region "$1" --profile "$2" | docker login --username AWS --password-stdin "$3"', 'ecr-login', region, profile, registry], { ...env, DOCKER_CONFIG: dockerConfig }),
    },
    /** shop.sh in a private copy of shop-local-deploy, with exactly the environment given. */
    shopScript: (cwd: string, args: string[], scriptEnv: Record<string, string>) => run(exec, 'bash', ['./shop.sh', ...args], scriptEnv, { cwd, timeout: 45 * 60_000 }),
    /** Does a profile's AWS session work? sts get-caller-identity: it works, it ran out, or something else failed. */
    awsProbe: async (profile: string): Promise<ProbeResult> => {
      const r = await run(exec, 'aws', ['sts', 'get-caller-identity', '--profile', profile, '--no-cli-pager'], env);
      return r.ok ? 'ok' : SESSION_EXPIRED.test(`${r.stderr}\n${r.stdout}`) ? 'expired' : 'error';
    },
  };
}

/** The DataPrime query endpoint for a Coralogix domain: us1.coralogix.com -> https://api.us1.coralogix.com/api/v1/dataprime/query. */
export const coralogixEndpoint = (domain: string): string => `https://api.${domain.trim().replace(/^https?:\/\//, '').replace(/^api\./, '').replace(/\/.*$/, '')}/api/v1/dataprime/query`;

/**
 * A Coralogix DataPrime query (POST /api/v1/dataprime/query, Bearer key) with the daemon's key. Returns the matching
 * records, one per line.
 */
export function coralogixQuery(apiKey: string, domain: string, fetchFn: typeof fetch = globalThis.fetch) {
  return async (query: string, window: { from: string; to: string; limit: number }): Promise<string> => {
    const response = await fetchFn(coralogixEndpoint(domain), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, metadata: { startDate: window.from, endDate: window.to, defaultSource: 'logs', limit: window.limit } }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Coralogix answered ${response.status}: ${text.slice(0, 200)}`);
    const lines: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { result?: { results?: Array<{ userData?: string; metadata?: Array<{ key: string; value: string }> }> } };
        for (const r of o.result?.results ?? []) {
          const at = r.metadata?.find((m) => m.key === 'timestamp')?.value;
          lines.push(`${at ? `${at} ` : ''}${r.userData ?? ''}`);
        }
      } catch {
        /* a progress line */
      }
    }
    return lines.join('\n');
  };
}
