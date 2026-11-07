// v1.5: stops that did no good. The plan's usage never holds a start (agents-run.test.ts), and a long task name no longer
// refuses to start a task because its folder would be too long for the sandbox's sockets.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TMPDIR, runTmp } from '../src/agents/run';
import { taskFolderKey } from '../src/agents/orchestrator';
import { MAX_WORKTREES_ROOT } from '../src/config';
import { orchestratorWorld, type OrchestratorWorld } from './helpers/orchestratorWorld';
import { tick } from './helpers/fakeSdk';

const folderOf = (root: string, key: string): string => join(root, `${key}-abc123`);

describe('a task’s folder name', () => {
  const names = ['x', 'review-812', 'compare-integration-and-staging', 'a-very-long-task-name-that-goes-on-and-on-and-on', 'x'.repeat(24)];

  it.each([0, 20, 42, MAX_WORKTREES_ROOT])('always fits the sandbox’s sockets, whatever the name, under a runs folder of %i characters (the longest allowed is %i)', (extra) => {
    const root = '/r'.padEnd(Math.min(extra, MAX_WORKTREES_ROOT) || 2, 'r');
    for (const name of names) {
      const key = taskFolderKey(root, name);
      expect(runTmp(folderOf(root, key)).length).toBeLessThanOrEqual(MAX_TMPDIR);
      expect(key).toMatch(/^task(-|$)/);
      expect(key).not.toMatch(/-$/);
    }
  });

  it('keeps as much of the name as fits: the default runs folder (42 characters) leaves 13 for it after "task-"', () => {
    const root = `/home/alexrivera/.local/share/elfoqsy/runs`;
    expect(root.length).toBe(42);
    expect(taskFolderKey(root, 'compare-integration-and-staging')).toBe('task-compare-integ');
    expect(taskFolderKey(root, 'notes')).toBe('task-notes');
  });
});

describe('starting a task with a long name', () => {
  let w: OrchestratorWorld;

  afterEach(async () => {
    await w.close();
  });

  // The runs folder at its longest (WORKTREES_ROOT, at most 50 characters): the case where the name has the least room.
  beforeEach(() => {
    w = orchestratorWorld({ worktreesRoot: (world) => join(world.root, 'w'.repeat(MAX_WORKTREES_ROOT - world.root.length - 1)) });
  });

  it('starts, with its folder shortened to fit, instead of failing with "too long for the sandbox’s sockets"', async () => {
    const started = await w.orchestrator.spawnTask({
      name: 'Compare integration and staging images',
      goal: 'A table of service, integration image, staging image.',
      deliverable: 'table',
      model: 'haiku',
      effort: 'low',
    });
    expect(started).toMatchObject({ agentNumber: 1 });
    await tick();
    const created = w.log.readFrom(0, 1000, ['run.created']).at(-1)!.payload as { worktree: string; task?: { name: string }; branch: string };
    expect(runTmp(created.worktree).length).toBeLessThanOrEqual(MAX_TMPDIR);
    expect(created.worktree).toMatch(/task-/);
    // What people see keeps the whole name, and so does the branch.
    expect(created.task?.name).toBe('Compare integration and staging images');
    expect(created.branch).toMatch(/^elfoqsy-task\/compare-integration-and/);
    mkdirSync(created.worktree, { recursive: true });
  });
});
