// The narrative's helpers in the daemon (N1): the checks on what an agent reports, and reading a test run's output.
import { describe, expect, it } from 'vitest';
import { CODE_REF, codeRefProblem, isTestCommand, parseTestOutput, testExcerpt } from '../src/agents/narrativeReports';

describe('a code source is a file and line', () => {
  it('accepts path:line and path:line-line, and names what is not', () => {
    for (const ok of ['shop-api/src/map.ts:44', 'src/a.ts:1-20', 'a.py:3', 'packages/x/y.test.tsx:120']) expect(CODE_REF.test(ok)).toBe(true);
    for (const bad of ['src/a.ts', 'a.ts:', 'a.ts:x', ':12', 'a.ts: 12', 'src/a.ts:12:3']) expect(CODE_REF.test(bad)).toBe(false);
    expect(codeRefProblem([{ kind: 'code', ref: 'src/a.ts:1' }, { kind: 'ticket', ref: 'SHOP-1' }, { kind: 'log', ref: 'any text at all' }], 'lines')).toBeNull();
    expect(codeRefProblem([{ kind: 'code', ref: 'src/a.ts' }], 'lines')).toBe('lines: a code source is a file and line, path:line or path:line-line; "src/a.ts" is not.');
  });
});

describe('which commands are test runs', () => {
  it('knows the usual runners, in front of a cd or behind a pipe', () => {
    for (const c of ['npx jest test/a.test.ts', 'cd pkg && npx vitest run', 'npm run test:unit', 'pnpm test', 'yarn test --watch=false', 'pytest -k lifts', 'python -m pytest tests/', 'go test ./...', 'cargo test', 'mvn -q test', './gradlew test', 'dotnet test', 'bundle exec rspec']) {
      expect(isTestCommand(c), c).toBe(true);
    }
    for (const c of ['ls src', 'git status', 'npm install', 'npm run build', 'cat test/a.test.ts', 'grep -rn jest .']) expect(isTestCommand(c), c).toBe(false);
  });
});

describe('reading what a runner printed', () => {
  it('takes the counts of jest and vitest, and the names of the tests that failed, never the file', () => {
    expect(parseTestOutput('FAIL test/map.test.ts\n  ✕ lifts error_code (3 ms)\nTests: 1 failed, 3 passed, 4 total\n')).toEqual({ failed: 1, passed: 3, failedNames: ['lifts error_code'] });
    expect(parseTestOutput(' FAIL  test/map.test.ts > mapper > lifts error_code\n Tests  1 failed | 3 passed (4)\n')).toEqual({ failed: 1, passed: 3, failedNames: ['lifts error_code'] });
    expect(parseTestOutput('PASS a\n Tests  41 passed (41)\n')).toEqual({ passed: 41 });
  });

  it('takes pytest, go and cargo, and gives nothing for a runner it does not know', () => {
    expect(parseTestOutput('===== 2 failed, 7 passed in 1.20s =====')).toEqual({ failed: 2, passed: 7 });
    expect(parseTestOutput('--- FAIL: TestLift (0.00s)\nFAIL\nexit status 1')).toEqual({ failedNames: ['TestLift'] });
    expect(parseTestOutput('test result: ok. 5 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 2 failed; 0 ignored')).toEqual({ passed: 6, failed: 2 });
    expect(parseTestOutput('some runner nobody knows said it was fine')).toEqual({});
  });

  it('keeps the evidence short: where it failed for a failure, the last lines for a pass', () => {
    const long = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\nFAIL test/a.test.ts\n  ✕ x\n    Expected: 1\n    Received: 2\n${Array.from({ length: 40 }, (_, i) => `after ${i}`).join('\n')}`;
    const failing = testExcerpt(long, false).split('\n');
    expect(failing[0]).toBe('FAIL test/a.test.ts');
    expect(failing.length).toBeLessThanOrEqual(8);
    expect(testExcerpt('a\nb\nTests: 3 passed', true)).toBe('a\nb\nTests: 3 passed');
    expect(testExcerpt('x'.repeat(500), true)).toHaveLength(240);
    expect(testExcerpt('', false)).toBe('failed');
  });
});
