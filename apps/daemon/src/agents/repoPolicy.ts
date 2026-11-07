// Per-repository setup and tests for ticket agents, from config/agent-repos.json, for the run prompt. every
// test in the run folder is free (tier 0); allowedTestCommands is kept as a record of each repository's unit tests.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const repoPolicySchema = z.object({
  needs: z.array(z.string()),
  setup: z.array(z.string()),
  unitTests: z.array(z.string()),
  allowedTestCommands: z.array(z.string()),
  /** local: the unit tests can run in the run folder. ci: they cannot run on this host; the run prompt says so (no gate rule). */
  testsIn: z.enum(['local', 'ci']).default('local'),
  notes: z.string(),
});

export type RepoPolicy = z.infer<typeof repoPolicySchema>;

const fileSchema = z.object({ repos: z.record(z.string(), repoPolicySchema) });

export const EMPTY_POLICY: RepoPolicy = { needs: [], setup: [], unitTests: [], allowedTestCommands: [], testsIn: 'local', notes: '' };

export function loadRepoPolicies(file: string): Record<string, RepoPolicy> {
  return fileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).repos;
}

/** The directory a repository gets inside a run folder: its GitHub name, which the CI scripts expect. */
export const repoDir = (repo: string): string => repo.split('/')[1] ?? repo;
