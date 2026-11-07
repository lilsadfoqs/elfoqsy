// The logs proxy: Coralogix queries, run with alex's Coralogix key. The proxy writes the source and the
// application filter itself, for the non-prod applications in config/environments.yaml; the agent writes only what
// comes after. Prod logs are asked, since only alex can ask for them.
import { z } from 'zod';
import { redact } from '../redact';
import { resolveApplication, type Environments } from './environments';
import { invalid, shortOutput, type Classified, type Outcome, type ProxyHandler } from './types';

export const logsSchema = z.object({
  /** DataPrime after the source and filter, for example: filter $m.severity == ERROR | limit 50 */
  query: z.string().max(4000),
  /** One environment (dev, staging, integration) or one application; all non-prod applications when left out. */
  environment: z.string().max(40).optional(),
  application: z.string().max(120).optional(),
  /** ISO times, or how far back from now: 15m, 2h, 1d. */
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type LogsRequest = z.infer<typeof logsSchema>;

export type LogsQuery = (dataprime: string, window: { from: string; to: string; limit: number }) => Promise<string>;

const OWN_FILTER = /(^|\|)\s*source\b|applicationname|\$l\.application/i;

export class LogsProxy implements ProxyHandler<LogsRequest> {
  readonly name = 'logs' as const;
  readonly schema = logsSchema;

  constructor(
    private readonly envs: Environments,
    /** Absent when CORALOGIX_API_KEY is not set. */
    private readonly query: LogsQuery | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The applications a request reaches, and whether one of them is prod. */
  private applications(r: LogsRequest): { apps: string[]; environment?: string; prod?: string; unknown?: string } {
    if (r.application) {
      const resolved = resolveApplication(this.envs, r.application);
      if (resolved.kind === 'prod') return { apps: [r.application], environment: 'prod', prod: r.application };
      if (resolved.kind !== 'env') return { apps: [], unknown: r.application };
      return { apps: [r.application], environment: resolved.env.name };
    }
    if (r.environment) {
      if (/^(prod|prd|production)$/i.test(r.environment)) return { apps: [], environment: 'prod', prod: r.environment };
      const env = this.envs.list.find((e) => e.name === r.environment);
      if (!env?.coralogixApplication) return { apps: [], unknown: r.environment };
      return { apps: [env.coralogixApplication], environment: env.name };
    }
    return { apps: this.envs.list.flatMap((e) => (e.coralogixApplication ? [e.coralogixApplication] : [])) };
  }

  async classify(r: LogsRequest): Promise<Classified> {
    const summary = `Coralogix ${r.application ?? r.environment ?? 'non-prod'}: ${r.query || '(all)'}`.slice(0, 300);
    if (OWN_FILTER.test(r.query)) return invalid('logs.query', summary, 'Write only what comes after the source and filter; name the environment or application in their own fields and the proxy adds the filter.');
    const a = this.applications(r);
    if (a.unknown) return invalid('logs.query', summary, `${a.unknown} is not a configured environment or application. Use dev, staging or integration.`);
    if (a.prod) return { tier: 2, kind: 'logs.prod', environment: 'prod', summary, reason: 'Prod logs are read only when alex asks for them: asked first.' };
    if (!this.query) return invalid('logs.query', summary, 'Coralogix is not configured for the orchestrator (CORALOGIX_API_KEY); ask alex.');
    return { tier: 0, kind: 'logs.query', ...(a.environment ? { environment: a.environment } : {}), summary, reason: 'A read of non-prod logs.' };
  }

  async execute(r: LogsRequest): Promise<Outcome> {
    if (!this.query) return { ok: false, output: 'Coralogix is not configured for the orchestrator (CORALOGIX_API_KEY).' };
    const { apps } = this.applications(r);
    const filter = apps.length === 1 ? `$l.applicationname == '${apps[0]}'` : `$l.applicationname in [${apps.map((a) => `'${a}'`).join(', ')}]`;
    const rest = r.query.trim().replace(/^\|\s*/, '');
    const dataprime = `source logs | filter ${filter}${rest ? ` | ${rest}` : ''}`;
    try {
      const out = await this.query(dataprime, { from: this.at(r.from ?? '1h'), to: this.at(r.to ?? '0m'), limit: r.limit ?? 100 });
      return { ok: true, output: shortOutput(redact(out)) || 'No logs matched.' };
    } catch (error) {
      return { ok: false, output: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  /** An ISO time as given, or "15m", "2h", "1d" before now. */
  private at(when: string): string {
    const m = /^(\d+)([mhd])$/.exec(when.trim());
    if (!m) return new Date(when).toISOString();
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(this.now() - ms).toISOString();
  }
}
