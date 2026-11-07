// Each run's own kubeconfig: alex's contexts for the configured non-prod environments, nothing else, and no current
// context, so every call has to name one. It lives in the daemon's data folder (DATA_DIR/runs/<runId>/), which a run's
// sandbox cannot read, and goes when the run ends. The kube proxy runs kubectl with it; the agent's own environment
// points KUBECONFIG and the AWS CLI's files there too, so nothing it runs can change his global context or profile.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

interface Named<T> {
  name: string;
  [key: string]: unknown;
  context?: T;
}

interface KubeconfigFile {
  apiVersion?: string;
  kind?: string;
  clusters?: Array<Named<unknown>>;
  users?: Array<Named<unknown>>;
  contexts?: Array<Named<{ cluster?: string; user?: string; namespace?: string }>>;
  'current-context'?: string;
  preferences?: unknown;
}

/** An EKS context by its ARN keeps the cluster name at the end. */
const clusterName = (context: string): string => /^arn:aws:eks:[^:]+:\d{12}:cluster\/(.+)$/.exec(context)?.[1] ?? context;

/**
 * Only the wanted contexts, with their clusters and users, from a whole kubeconfig (kubectl config view --raw --flatten).
 * A wanted name matches a context of that name, or an EKS ARN context whose cluster has that name; either way the run's
 * file names it as configured.
 */
export function runKubeconfig(full: string, wanted: string[]): { yaml: string; contexts: string[] } {
  const src = (parse(full) ?? {}) as KubeconfigFile;
  const contexts: NonNullable<KubeconfigFile['contexts']> = [];
  for (const name of wanted) {
    const found = src.contexts?.find((c) => c.name === name) ?? src.contexts?.find((c) => clusterName(c.name) === name);
    if (found) contexts.push({ ...found, name });
  }
  const clusters = new Set(contexts.map((c) => c.context?.cluster));
  const users = new Set(contexts.map((c) => c.context?.user));
  const out: KubeconfigFile = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: (src.clusters ?? []).filter((c) => clusters.has(c.name)),
    users: (src.users ?? []).filter((u) => users.has(u.name)),
    contexts,
    'current-context': '',
  };
  return { yaml: stringify(out), contexts: contexts.map((c) => c.name) };
}

export class Kubeconfigs {
  constructor(
    /** DATA_DIR/runs: outside every run's sandbox. */
    private readonly root: string,
    /** alex's whole kubeconfig, as kubectl config view --raw --flatten prints it; null when there is none. */
    private readonly readFull: () => Promise<string | null>,
    private readonly wanted: string[],
  ) {}

  dir(runId: string): string {
    return join(this.root, runId);
  }

  path(runId: string): string {
    return join(this.dir(runId), 'kubeconfig');
  }

  /**
   * Writes the run's kubeconfig (mode 0600) and says which contexts it has. Without his kubeconfig it has none.
   * renew: it is a file being built again (Elfoqsy's own, every few minutes): when his kubeconfig cannot be read just now,
   * or has none of the wanted contexts (for instance while `aws eks update-kubeconfig` rewrites it), the file it has
   * stays, instead of being replaced by an empty one.
   */
  async create(runId: string, o: { renew?: boolean } = {}): Promise<{ path: string; contexts: string[] }> {
    const full = await this.readFull().catch(() => null);
    const { yaml, contexts } = runKubeconfig(full ?? '', this.wanted);
    const path = this.path(runId);
    if (o.renew && !contexts.length && existsSync(path)) return { path, contexts: runKubeconfig(readFileSync(path, 'utf8'), this.wanted).contexts };
    mkdirSync(this.dir(runId), { recursive: true, mode: 0o700 });
    // Replaced in one step, so a kubectl running right now (Elfoqsy reads several environments at once) never sees half a file.
    const next = `${path}.${process.pid}.tmp`;
    writeFileSync(next, yaml, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, path);
    return { path, contexts };
  }

  remove(runId: string): void {
    rmSync(this.dir(runId), { recursive: true, force: true });
  }
}
