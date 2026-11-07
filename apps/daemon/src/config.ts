// Configuration comes only from environment variables, read and validated once at start.
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

// owner/name, for example acme/shop-api. Enterprise-managed accounts carry an _suffix.
const REPO = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))]);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The ticket agent is always Opus 5.5 at xhigh. Not configurable, and Elfoqsy cannot choose. */
export const TICKET_AGENT = { model: 'claude-opus-5-5', effort: 'xhigh' } as const;
/** Elfoqsy's own turns: Opus 5.5 at medium; ELFOQSY_MODEL changes the model. The exam's answerer runs exactly so. */
export const ELFOQSY_EFFORT = 'medium' as const;
/**
 * Her conversation replies (alex, 19 October): high, not medium. A separate constant: ELFOQSY_EFFORT is also the exam's answerer, whose
 * effort must not move or a later exam stops being comparable with the baseline.
 */
export const ELFOQSY_REPLY_EFFORT = 'high' as const;
export const elfoqsyModel = (c: { ELFOQSY_MODEL?: string | undefined }): string => c.ELFOQSY_MODEL ?? 'claude-opus-5-5';

const repoList = z
  .string()
  .default('')
  .transform((v) => [...new Set(v.split(',').map((r) => r.trim()).filter(Boolean))])
  .refine((repos) => repos.every((r) => REPO.test(r)), 'each repository is owner/name');

const envSchema = z.object({
  // Local transport. The daemon only ever listens on 127.0.0.1.
  // Simulate mode only: agents on the map in total. 3 are the agreed screens; more are generated to test crowding.
  SIM_AGENTS: z.coerce.number().int().min(1).max(60).default(3),
  DAEMON_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  DATA_DIR: optional,
  MOCK_DIR: optional,

  // Elfoqsy runs on Alex's Claude Code login; there is deliberately no API key here.
  ELFOQSY_MODEL: optional,
  // Off: Jira, GitHub and run changes do not become turns for her (she still answers messages). For
  // test runs that must make no Claude calls beyond the ones asked for.
  ELFOQSY_WORKSPACE_UPDATES: z.enum(['on', 'off']).default('on'),
  // Off: no weekly review at start, even when one is due.
  ELFOQSY_WEEKLY_REVIEW: z.enum(['on', 'off']).default('on'),
  // Off: no session exports its traces, and the daemon's OTLP receiver does not start (telemetry/).
  ELFOQSY_TELEMETRY: z.enum(['on', 'off']).default('on'),
  JIRA_SITE: z.url().default('https://acme.atlassian.net'),
  JIRA_EMAIL: optional,
  JIRA_API_TOKEN: optional,
  JIRA_PROJECTS: z
    .string()
    .default('SHOP,CORE')
    .transform((v) => v.split(',').map((p) => p.trim()).filter(Boolean)),
  JIRA_STORY_POINTS_FIELD: z.string().default('customfield_16486'),
  JIRA_SPRINT_FIELD: z.string().default('customfield_10521'),
  // GitHub goes through Alex's logged-in gh CLI, so there is no token here. All of these follow the
  // same rules: reads are free, writes go through the gh proxy and its tiers, and nothing is ever merged
  // by the system. Some have no branch protection, so the tiers are the only check.
  GITHUB_REPOS: repoList,
  // The bug fields the jira proxy fills, by custom field id: Root cause description, Solution and Acceptance criteria
  // (read from SHOP-2430 on 2026-10-11; all three are rich text).
  JIRA_ROOT_CAUSE_FIELD: z.string().default('customfield_16595'),
  JIRA_SOLUTION_FIELD: z.string().default('customfield_16727'),
  JIRA_AC_FIELD: z.string().default('customfield_16728'),
  // Coralogix for the logs proxy: a read-only API key (the DataQuerying preset), and the account's domain as Coralogix's
  // domain selector names it (US1: us1.coralogix.com, queried at https://api.us1.coralogix.com). Without the key, the logs
  // proxy says it is not configured.
  CORALOGIX_API_KEY: optional,
  CORALOGIX_DOMAIN: z.string().default('us1.coralogix.com'),
  // Where Alex's clones live. Read only: agents work in their own clones under WORKTREES_ROOT.
  REPOS_ROOT: optional,
  WORKTREES_ROOT: optional,
  // Where the agents' package caches live, one folder for every run (default: `cache` beside WORKTREES_ROOT). Elfoqsy's own: every
  // agent's shell reads and writes all of it, so it must not be a folder that holds anything else.
  AGENT_CACHE_DIR: optional,
  // Where the mirrors of the repositories live (default: `mirrors` beside WORKTREES_ROOT, on the same disk so run clones can be hard-linked from
  // them). Elfoqsy's own: run clones share their object files, so they are never his clones, and agents never read this folder.
  AGENT_MIRRORS_DIR: optional,
  // Agents (ticket and task) working at once. Also a workspace setting he changes from the settings sheet or
  // through Elfoqsy; the setting wins.
  MAX_PARALLEL_AGENTS: z.coerce.number().int().min(1).default(6),
  // Hosts of his and his company's that a web request must never reach or name, comma-separated, besides the
  // Jira site, Coralogix, private addresses and internal names, which are always refused.
  INTERNAL_HOSTS: list(''),
  AGENT_MAX_MINUTES: z.coerce.number().positive().default(45),
  // How often agents report a heartbeat, in working minutes: a reminder after one interval without one,
  // a missed_heartbeats flag after two. 5 normally; a probe may set 1 to see the reminder live.
  AGENT_HEARTBEAT_MINUTES: z.coerce.number().positive().max(30).default(5),
  // The ticket agent is Opus 5.5 at xhigh (his standing rule). Only a probe sets these, and only for one run.
  TICKET_AGENT_MODEL: z.string().regex(/^claude-(haiku|sonnet|opus)-\d+-\d+$/, 'a model id like claude-opus-5-5').default(TICKET_AGENT.model),
  TICKET_AGENT_EFFORT: z.enum(EFFORTS).default(TICKET_AGENT.effort),
  // Tokens one run may use, cache reads not counted; also sent as the agent's task budget.
  AGENT_MAX_TOKENS: z.coerce.number().int().min(20_000).default(3_000_000),
  // What the ticket agent may choose from for each sub-agent.
  SUBAGENT_MODELS: list('claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5').refine(
    (models) => models.length > 0 && models.every((m) => /^claude-(haiku|sonnet|opus)-\d+-\d+$/.test(m)),
    'model ids like claude-sonnet-5-5',
  ),
  SUBAGENT_EFFORTS: list('low,medium,high,xhigh').refine(
    (efforts) => efforts.length > 0 && efforts.every((e) => (EFFORTS as readonly string[]).includes(e)),
    `efforts among ${EFFORTS.join(', ')}`,
  ),
  MAX_PARALLEL_SUBAGENTS: z.coerce.number().int().min(1).default(4),
  // Before starting a run, Elfoqsy warns when the plan's usage is at or above these percentages.
  USAGE_WARN_FIVE_HOUR: z.coerce.number().min(0).max(100).default(60),
  USAGE_WARN_SEVEN_DAY: z.coerce.number().min(0).max(100).default(80),
});

// What live mode needs. Elfoqsy and agents use the claude CLI's login, checked at start.
const LIVE_REQUIRED = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'GITHUB_REPOS', 'REPOS_ROOT'] as const;

export type Mode = 'simulate' | 'live';

export interface Config extends z.infer<typeof envSchema> {
  mode: Mode;
  dataDir: string;
  mockDir: string;
  /** Where each run's clones go: outside this repository and outside REPOS_ROOT. */
  worktreesRoot: string;
  /** The agents' shared package caches (AGENT_CACHE_DIR, else beside worktreesRoot): created, and claimed with a marker, when a run starts. */
  agentCacheDir: string;
  /** The mirrors run clones are hard-linked from (AGENT_MIRRORS_DIR, else beside worktreesRoot). */
  agentMirrorsDir: string;
}

export class ConfigError extends Error {}

/** Never includes values in its errors, only variable names, so secrets cannot leak into logs. */
export function loadConfig(env: NodeJS.ProcessEnv, mode: Mode): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(`Invalid environment variables: ${names.join(', ')}`);
  }
  const values = parsed.data;
  if (mode === 'live') {
    const missing = LIVE_REQUIRED.filter((name) => {
      const value = values[name];
      return Array.isArray(value) ? value.length === 0 : !value;
    });
    if (missing.length) {
      throw new ConfigError(
        `Missing environment variables for live mode: ${missing.join(', ')}.\n` +
          'Copy .env.example to .env and fill them in, or run `pnpm dev:sim` for the demo, which needs no tokens.',
      );
    }
  }
  const worktreesRoot = resolve(values.WORKTREES_ROOT ?? defaultWorktreesRoot(env));
  // A run folder inside this repository (or inside his clones) would be part of that git repository:
  // Claude Code would treat it as that project. Runs live outside both.
  for (const [name, root] of [['the elfoqsy repository', REPO_ROOT], ['REPOS_ROOT', values.REPOS_ROOT]] as const) {
    if (root && isInside(worktreesRoot, resolve(root))) throw new ConfigError(`WORKTREES_ROOT must be outside ${name}.`);
  }
  // Each run's TMPDIR is inside its folder, and Claude Code puts the sandbox's socket files there:
  // Unix socket paths are short, so the folders must be too.
  if (worktreesRoot.length > MAX_WORKTREES_ROOT) {
    throw new ConfigError(`WORKTREES_ROOT is too long: at most ${MAX_WORKTREES_ROOT} characters, so the sandbox's sockets fit in each run's temp folder.`);
  }
  const agentCacheDir = resolve(values.AGENT_CACHE_DIR ?? join(dirname(worktreesRoot), 'cache'));
  const home = resolve(env.HOME || homedir());
  // Never his home or a folder above it, nor a folder of this repository or of his clones: every agent could read and write all of it.
  if (isInside(home, agentCacheDir)) throw new ConfigError('AGENT_CACHE_DIR must not be his home or a folder above it.');
  for (const [name, root] of [['the elfoqsy repository', REPO_ROOT], ['REPOS_ROOT', values.REPOS_ROOT]] as const) {
    if (root && (isInside(agentCacheDir, resolve(root)) || isInside(resolve(root), agentCacheDir))) throw new ConfigError(`AGENT_CACHE_DIR must be apart from ${name}.`);
  }
  const agentMirrorsDir = resolve(values.AGENT_MIRRORS_DIR ?? join(dirname(worktreesRoot), 'mirrors'));
  // Not his home or a folder above it, not a folder of this repository or of his clones, and apart from the run folders and the cache: it is
  // protected from agents as a whole, and nothing else may sit in it.
  if (isInside(home, agentMirrorsDir)) throw new ConfigError('AGENT_MIRRORS_DIR must not be his home or a folder above it.');
  for (const [name, root] of [['the elfoqsy repository', REPO_ROOT], ['REPOS_ROOT', values.REPOS_ROOT]] as const) {
    if (root && (isInside(agentMirrorsDir, resolve(root)) || isInside(resolve(root), agentMirrorsDir))) throw new ConfigError(`AGENT_MIRRORS_DIR must be apart from ${name}.`);
  }
  for (const [name, other] of [['WORKTREES_ROOT', worktreesRoot], ['AGENT_CACHE_DIR', agentCacheDir]] as const) {
    if (isInside(agentMirrorsDir, other) || isInside(other, agentMirrorsDir)) throw new ConfigError(`AGENT_MIRRORS_DIR must be apart from ${name}.`);
  }
  return {
    ...values,
    mode,
    agentCacheDir,
    agentMirrorsDir,
    dataDir: resolve(values.DATA_DIR ?? resolve(REPO_ROOT, 'data')),
    worktreesRoot,
    mockDir: resolve(values.MOCK_DIR ?? resolve(REPO_ROOT, 'mock')),
  };
}

/** $XDG_DATA_HOME/elfoqsy/runs, else ~/.local/share/elfoqsy/runs: outside any repository, and short. */
export function defaultWorktreesRoot(env: NodeJS.ProcessEnv): string {
  const dataHome = env.XDG_DATA_HOME || resolve(env.HOME || homedir(), '.local', 'share');
  return resolve(dataHome, 'elfoqsy', 'runs');
}

/** Leaves room for /<KEY>-<id>/.tmp/claude-socks-<16 hex>.sock within a Unix socket path (107 characters). */
export const MAX_WORKTREES_ROOT = 50;

const isInside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
