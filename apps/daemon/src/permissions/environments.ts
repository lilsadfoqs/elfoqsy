// The environments agents may reach through the orchestrator's proxies, from config/environments.yaml: AWS profiles and
// accounts, kube contexts, namespaces and Coralogix applications. There is no prod access at all: anything that resolves
// to prod is tier 3. A context listed under unknown_contexts is tier 2 for every call, reads included; any other name
// the config does not know is refused. harness_deployments are the only deployments agents may change: product services
// are alex's to deploy.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const environmentSchema = z.object({
  aws_profile: z.string().min(1).optional(),
  aws_account: z.string().regex(/^\d{12}$/).optional(),
  kube_context: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  coralogix_application: z.string().min(1).optional(),
});

const fileSchema = z.object({
  region: z.string().min(1),
  environments: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), environmentSchema),
  prod: z.object({ access: z.literal('none') }),
  unknown_contexts: z.array(z.string().min(1)).default([]),
  harness_deployments: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/)).default([]),
});

export interface Environment {
  name: string;
  awsProfile?: string;
  awsAccount?: string;
  kubeContext?: string;
  namespace?: string;
  coralogixApplication?: string;
}

export interface Environments {
  region: string;
  list: Environment[];
  unknownContexts: string[];
  /** The deployments agents may change; every other one is a product service. */
  harness: string[];
}

export type Resolved =
  | { kind: 'env'; env: Environment }
  | { kind: 'prod'; name: string }
  | { kind: 'unknown_listed'; name: string }
  | { kind: 'unknown'; name: string };

/** Names that point at prod, however they are spelled: the prod profile, a prod cluster or application. */
const PROD = /(^|[^a-z])(prod|prd|production)([^a-z]|$)/i;
// An EKS context as aws eks update-kubeconfig names it.
const EKS_ARN = /^arn:aws:eks:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/;

export function parseEnvironments(text: string): Environments {
  const file = fileSchema.parse(parse(text));
  return {
    region: file.region,
    list: Object.entries(file.environments).map(([name, e]) => ({
      name,
      ...(e.aws_profile ? { awsProfile: e.aws_profile } : {}),
      ...(e.aws_account ? { awsAccount: e.aws_account } : {}),
      ...(e.kube_context ? { kubeContext: e.kube_context } : {}),
      ...(e.namespace ? { namespace: e.namespace } : {}),
      ...(e.coralogix_application ? { coralogixApplication: e.coralogix_application } : {}),
    })),
    unknownContexts: file.unknown_contexts,
    harness: file.harness_deployments,
  };
}

export function loadEnvironments(file: string): Environments {
  return parseEnvironments(readFileSync(file, 'utf8'));
}

/**
 * A kube context: by its configured name, by the environment's name ("dev") or its EKS cluster's name
 * ("dev-shop"), or as an EKS ARN of a configured cluster in that environment's account.
 */
export function resolveContext(envs: Environments, context: string): Resolved {
  const direct =
    envs.list.find((e) => e.kubeContext === context) ??
    envs.list.find((e) => e.kubeContext && (e.name === context || clusterOf(e.kubeContext) === context));
  if (direct) return { kind: 'env', env: direct };
  const arn = EKS_ARN.exec(context);
  if (arn) {
    const [, , account, cluster] = arn;
    const env = envs.list.find((e) => e.kubeContext && clusterOf(e.kubeContext) === cluster && (!e.awsAccount || e.awsAccount === account));
    if (env) return { kind: 'env', env };
  }
  if (PROD.test(context)) return { kind: 'prod', name: context };
  if (envs.unknownContexts.includes(context)) return { kind: 'unknown_listed', name: context };
  return { kind: 'unknown', name: context };
}

export function resolveProfile(envs: Environments, profile: string): Resolved {
  const env = envs.list.find((e) => e.awsProfile === profile);
  if (env) return { kind: 'env', env };
  if (PROD.test(profile)) return { kind: 'prod', name: profile };
  return { kind: 'unknown', name: profile };
}

export function resolveApplication(envs: Environments, application: string): Resolved {
  const env = envs.list.find((e) => e.coralogixApplication === application);
  if (env) return { kind: 'env', env };
  if (PROD.test(application)) return { kind: 'prod', name: application };
  return { kind: 'unknown', name: application };
}

/** An EKS ARN's cluster name; any other context as it is. */
const clusterOf = (context: string): string => EKS_ARN.exec(context)?.[3] ?? context;

/** The context kubectl knows a resolved context by: "dev" becomes dev's configured context. */
export const contextName = (envs: Environments, context: string): string => {
  const r = resolveContext(envs, context);
  return r.kind === 'env' && r.env.kubeContext ? r.env.kubeContext : context;
};

/** The kube contexts a run's kubeconfig keeps: the configured ones and the unknown ones (every call to those is asked), never prod. */
export const runContexts = (envs: Environments): string[] => [...envs.list.flatMap((e) => (e.kubeContext ? [e.kubeContext] : [])), ...envs.unknownContexts.filter((c) => !PROD.test(c))];

/** Whether a deployment is part of the test harness (agents may change it) rather than a product service. */
export const isHarness = (envs: Environments, deployment: string): boolean => envs.harness.includes(deployment);

/** EKS contexts get their tokens from AWS, so they need alex's AWS session; minikube does not. */
export const needsAws = (env: Environment): boolean => env.awsProfile !== undefined;
