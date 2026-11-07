// What the ticket narrative ("What we know", N1) needs from the daemon besides the agent's own reports: checks on what it
// reports (a code source is path:line), and what the orchestrator sees itself, so it cannot drift: a test-shaped Bash
// command and how it ended, and what a push carried, read from git.
import type { PushedRepo, SourceRef } from '@elfoqsy/contracts';
import type { Git, PreparedRepo } from './git';
import { unpushedLog } from './git';

/** path:line or path:line-line: a code source the narrative can show as "the exact lines". */
export const CODE_REF = /^[^\s:][^:\n]*:\d+(?:-\d+)?$/;

/** Why a code source is not a path:line, or null. Sources of other kinds are free. */
export function codeRefProblem(sources: ReadonlyArray<Pick<SourceRef, 'kind' | 'ref'>>, what: string): string | null {
  const bad = sources.filter((s) => s.kind === 'code' && !CODE_REF.test(s.ref.trim()));
  if (!bad.length) return null;
  return `${what}: a code source is a file and line, path:line or path:line-line; ${bad.map((b) => `"${b.ref.slice(0, 80)}"`).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not.`;
}

/** Test commands by the usual runners, each as a command's own start: after a cd, a pipe or a variable, not an argument. */
const RUNNERS = [
  /^(npx\s+|pnpm\s+(exec\s+|dlx\s+)?|yarn\s+(dlx\s+)?|bunx?\s+)?(vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run)\b/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?[\w:.-]*\btest[\w:.-]*/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?t\b/,
  /^(pytest|py\.test|python3?\s+-m\s+(pytest|unittest))\b/,
  /^go\s+test\b/,
  /^cargo\s+(test|nextest)\b/,
  /^(mvn|\.\/mvnw|gradle|\.\/gradlew)\s+[^\n]*\b(test|verify)\b/,
  /^(dotnet\s+test|rspec|phpunit|bundle\s+exec\s+rspec)\b/,
];
/** The commands of a command line: split at &&, ||, ;, a pipe and a newline, each without its leading VAR=value words and `cd` pairs. */
const commandsOf = (line: string): string[] =>
  line
    .split(/&&|\|\||;|\||\n/)
    .map((c) => c.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
    .filter(Boolean);
export const isTestCommand = (command: string): boolean => commandsOf(command).some((c) => RUNNERS.some((r) => r.test(c)));

export interface ParsedTestRun {
  passed?: number;
  failed?: number;
  failedNames?: string[];
}

const num = (m: RegExpMatchArray | null, i = 1): number | undefined => (m?.[i] === undefined ? undefined : Number(m[i]));

/**
 * What the runner printed, when it is one whose summary is known: vitest and jest ("Tests  1 failed | 3 passed",
 * "Tests: 1 failed, 3 passed"), pytest ("1 failed, 3 passed"), go test (ok / FAIL lines), cargo ("test result:").
 * Never guessed: a runner it does not know gives no counts, only whether the command passed.
 */
export function parseTestOutput(output: string): ParsedTestRun {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const out: ParsedTestRun = {};
  const summary = /^[ \t]*Tests:?[ \t]+(.*)$/m.exec(text)?.[1];
  if (summary) {
    const failed = num(/(\d+)\s+failed/i.exec(summary));
    const passed = num(/(\d+)\s+passed/i.exec(summary));
    if (failed !== undefined) out.failed = failed;
    if (passed !== undefined) out.passed = passed;
  }
  if (out.passed === undefined && out.failed === undefined) {
    const py = /=+\s*(?:(\d+)\s+failed)?[,\s]*(?:(\d+)\s+passed)?[^=\n]*in [\d.]+s/i.exec(text);
    if (py && (py[1] || py[2])) {
      if (py[1]) out.failed = Number(py[1]);
      if (py[2]) out.passed = Number(py[2]);
    }
  }
  if (out.passed === undefined && out.failed === undefined) {
    const cargo = [...text.matchAll(/test result: \w+\.\s+(\d+) passed;\s+(\d+) failed/g)];
    if (cargo.length) {
      out.passed = cargo.reduce((n, m) => n + Number(m[1]), 0);
      out.failed = cargo.reduce((n, m) => n + Number(m[2]), 0);
    }
  }
  const names = new Set<string>();
  const add = (raw: string | undefined) => {
    const name = raw?.replace(/\s*\(\d+\s*ms\)\s*$/, '').trim();
    if (name && name.length < 200 && names.size < 8) names.add(name);
  };
  // A test's own line (jest, mocha, vitest's verbose list): "✕ lifts error_code (3 ms)".
  for (const m of text.matchAll(/^\s*(?:✗|×|✕)\s+(.+?)\s*$/gm)) add(m[1]);
  // A runner's FAIL line: vitest names the test after the file ("FAIL  test/a.test.ts > suite > lifts error_code"); a bare path is only the file.
  for (const m of text.matchAll(/^[ \t]*FAIL[ \t]+(.+?)[ \t]*$/gm)) {
    const rest = m[1]!;
    if (rest.includes(' > ')) add(rest.split(' > ').at(-1));
    else if (!/^[\w./\\@-]+\.[a-z]{1,5}$/i.test(rest)) add(rest);
  }
  for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) add(m[1]);
  if (names.size) out.failedNames = [...names];
  return out;
}

/** The last lines of a test run's output, as the narrative's failing evidence: at most 8 lines of 240 characters. */
export function testExcerpt(output: string, ok: boolean): string {
  const lines = output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  // A failure's evidence is where it failed; a pass is its summary line.
  const failAt = ok ? -1 : lines.findIndex((l) => /\b(FAIL|failed|AssertionError|Error:|expected)\b/i.test(l));
  const slice = failAt >= 0 ? lines.slice(failAt, failAt + 8) : lines.slice(-6);
  return slice.map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l)).join('\n') || (ok ? 'passed' : 'failed');
}

/**
 * What a push carries, per repository, from git alone: the head, the commits GitHub lacked, and the branch's change per
 * file against its base (added and removed lines, binary files as zero).
 */
export async function pushedFacts(git: Git, repos: PreparedRepo[], branch: string): Promise<PushedRepo[]> {
  const out: PushedRepo[] = [];
  for (const repo of repos) {
    const head = (await git.tryRun(['-C', repo.path, 'rev-parse', '--short=7', `refs/heads/${branch}`])) ?? '';
    if (!head) continue;
    const commits = await unpushedLog(git, repo, branch)
      .then((l) => l.map((c) => ({ sha: c.sha, subject: c.subject })).reverse())
      .catch(() => []);
    const numstat = (await git.tryRun(['-C', repo.path, 'diff', '--numstat', '--no-renames', `${repo.base}...refs/heads/${branch}`])) ?? (await git.tryRun(['-C', repo.path, 'diff', '--numstat', '--no-renames', `origin/${repo.base}...refs/heads/${branch}`])) ?? '';
    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added = '0', removed = '0', ...path] = line.split('\t');
        return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
      })
      .filter((f) => f.path)
      .slice(0, 200);
    out.push({ repo: repo.repo, branch, head, commits, files });
  }
  return out;
}
