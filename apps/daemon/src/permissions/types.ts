// What every capability proxy shares: a request is classified into a tier and an action kind, a write records what it
// will change before it runs, and a tier-1 action ends with Elfoqsy's one line. The proxies hold alex's
// credentials; agents never do.
import type { ProxyName, Tier } from '@elfoqsy/contracts';
import type { z } from 'zod';

export interface Classified {
  tier: Tier;
  /** The action, for grants and the log: "pr.ready", "kube.set_image". */
  kind: string;
  /** Where it lands: dev, staging, integration, local, prod. Grants are per environment. */
  environment?: string;
  /** The request in plain words, for the log, the pane and the question. */
  summary: string;
  /** Why this tier, said to the agent when it is refused and to alex when he is asked. */
  reason: string;
  /** It needs alex's AWS session (aws, or kube on an EKS context): it waits while the session is not fresh. */
  needsAws?: boolean;
  /** Refused because it could not be classified (a usage error the agent can fix), not a tier-3 action. */
  invalid?: boolean;
  /** Said in the approval question too, such as "A pinned digest will be replaced." */
  warning?: string;
  /** A change to the test harness (its deployment or its image), for delegation. */
  harness?: true;
  /** A read that stays free, with every environment variable's value and every credential field in its answer hidden and the names kept (hide.ts). */
  hideSecrets?: true;
  /** The Jira ticket (and field) a write changes: logged as an edit, and the ticket read back. */
  target?: { key: string; fieldId?: string; what: 'field' | 'comment_add' | 'transition' | 'link_add' };
}

/** What a write will change, read before it runs. undo is replayed through the same proxy and tier rules. */
export interface Recorded {
  target: string;
  before: string;
  undo?: { proxy: ProxyName; summary: string; request: Record<string, unknown> };
  noUndo?: string;
}

export interface Outcome {
  ok: boolean;
  /** What the agent gets back: the command's output, redacted, or what went wrong. */
  output: string;
  /** What happened, for Elfoqsy's line after a tier-1 action ("opened shop-api #812 as a draft"). */
  done?: string;
  /** The same, for her line when his latest message was Vietnamese ("đã mở shop-api #812 dưới dạng draft"). */
  doneVi?: string;
  /** A write in a tester's run: logged as it would be, and not sent. */
  notSent?: boolean;
}

/** The run a request comes from, as the proxies need to know it. */
export interface RunRef {
  runId: string;
  ticket: string;
  agentNumber: number;
  branch: string;
  /** The repositories it may push and open PRs on, with their default branch. */
  targets: Array<{ repo: string; base: string }>;
  /** Its own kubeconfig: only the configured non-prod contexts, outside its sandbox. Its private folder is beside it. */
  kubeconfig: string;
  test?: boolean;
  /** The run folder, where Docker works. */
  root?: string;
  /** Its clones, targets and dependencies: what shop.sh builds from. */
  clones?: Array<{ repo: string; path: string }>;
  /** What screens call it, when not its ticket: a task agent's name. */
  label?: string;
  /** Elfoqsy herself: her own Jira edits go through the proxies under this stand-in run. */
  actor?: 'elfoqsy';
}

/** Who a run's requests are from, in Elfoqsy's lines and his cards: "Agent 7", or "Elfoqsy" for her own. */
export const actorName = (run: Pick<RunRef, 'actor' | 'agentNumber'>): string => (run.actor === 'elfoqsy' ? 'Elfoqsy' : `Agent ${run.agentNumber}`);

export interface ProxyHandler<R = unknown> {
  name: ProxyName;
  /** What the agent's tool takes. */
  schema: z.ZodType<R>;
  /** Tier, kind and environment; may read (a tier-0 action) to decide, such as whether a field is empty. */
  classify(request: R, run: RunRef): Promise<Classified>;
  /** For a write: what it will change and how to put it back. Throws when the earlier state cannot be read. */
  record?(request: R, c: Classified, run: RunRef): Promise<Recorded | null>;
  execute(request: R, c: Classified, run: RunRef): Promise<Outcome>;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** A refusal for a request that cannot be classified. */
export const invalid = (kind: string, summary: string, reason: string): Classified => ({ tier: 3, kind, summary, reason, invalid: true });

export const shortOutput = (text: string, max = 6000): string => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
};
