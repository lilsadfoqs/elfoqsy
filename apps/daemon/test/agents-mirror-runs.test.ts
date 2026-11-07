// A run and the mirror (alex, 18 October): the run's clones are hard-linked from Elfoqsy's mirror and share no object file with his
// own clone; when the run ends the mirror is checked with git fsck, and made again, with a line in her voice, if the run damaged it.
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEnvelope, Ticket } from '@elfoqsy/contracts';
import { language } from '../src/elfoqsy/voice';
import { tick } from './helpers/fakeSdk';
import { SHOP_API, orchestratorWorld, type OrchestratorWorld } from './helpers/orchestratorWorld';

const ticket = (key: string): Ticket => ({
  key,
  board: 'SHOP',
  summary: 'x',
  type: 'Bug',
  status: 'To do',
  priority: 'Major',
  storyPoints: 1,
  sprint: 's',
  sprintsCarried: 1,
  epic: null,
  reporter: 'r',
  created: '',
  updated: '',
  labels: [],
  linked: [],
  description: 'd',
});

let w: OrchestratorWorld;
beforeEach(() => {
  w = orchestratorWorld({ tickets: true });
  w.log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546') });
});
afterEach(async () => {
  language.current = 'en';
  await w.close();
});

const mirrorPath = () => join(dirname(w.world.worktrees), 'mirrors', 'shop-api.git');
const events = <T extends AnyEnvelope['type']>(type: T) => w.log.readFrom(0, 100_000, [type]);

const inodes = (dir: string): Set<string> => {
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const s = statSync(path);
        out.add(`${s.dev}:${s.ino}`);
      }
    }
  };
  walk(dir);
  return out;
};
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

async function spawn(): Promise<{ runId: string; clone: string }> {
  const r = await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
  expect(r).not.toHaveProperty('error');
  await tick();
  const created = events('run.created').at(-1)!.payload as { runId: string; worktree: string };
  return { runId: created.runId, clone: join(created.worktree, 'shop-api') };
}

async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('did not happen');
    await tick(40);
  }
}

describe('a run’s clones', () => {
  it('are linked from the mirror and share no object file with his clone', async () => {
    const { clone } = await spawn();
    const run = inodes(join(clone, '.git', 'objects'));
    expect([...run].filter((i) => inodes(join(mirrorPath(), 'objects')).has(i)).length, 'linked from the mirror').toBeGreaterThan(0);
    expect([...run].filter((i) => inodes(join(w.world.clone.path, '.git', 'objects')).has(i)).length, 'none of his').toBe(0);
    // His clone is as it was.
    expect(w.world.git(w.world.clone.path, 'remote')).toBe('origin');
  });

  it('come from a mirror that was made for the run, in the folder beside the run folders and not in his', async () => {
    await spawn();
    expect(statSync(join(mirrorPath(), 'HEAD')).isFile()).toBe(true);
    expect(mirrorPath().startsWith(w.world.clone.path)).toBe(false);
    expect(mirrorPath().startsWith(dirname(w.world.worktrees))).toBe(true);
  });
});

describe('when a run ends', () => {
  it('checks the mirror, and says nothing when it is whole', async () => {
    const { runId } = await spawn();
    await w.orchestrator.cancel(runId, 'Test over.');
    await until(() => events('mirror.checked').length > 0);
    expect(events('mirror.checked')[0]!.payload).toMatchObject({ repo: SHOP_API, runId, ok: true });
    expect(events('mirror.checked')[0]!.payload).not.toHaveProperty('recreated');
    const lines = events('elfoqsy.message').map((e) => (e.payload as { text: string }).text);
    expect(lines.filter((t) => /mirror/i.test(t))).toEqual([]);
  });

  it('finds what the run did to an object file through its own clone, makes the mirror again, and says so', async () => {
    const { runId, clone } = await spawn();
    const mirror = inodes(join(mirrorPath(), 'objects'));
    const linked = files(join(clone, '.git', 'objects')).find((f) => (f.endsWith('.pack') || /\/objects\/[0-9a-f]{2}\//.test(f)) && mirror.has(`${statSync(f).dev}:${statSync(f).ino}`));
    expect(linked, 'an object file linked into the run clone').toBeDefined();
    chmodSync(linked!, 0o644);
    const bytes = readFileSync(linked!);
    for (let i = Math.min(40, bytes.length - 1); i < Math.min(64, bytes.length); i++) bytes[i] = bytes[i]! ^ 0xff;
    writeFileSync(linked!, bytes);

    await w.orchestrator.cancel(runId, 'Test over.');
    await until(() => events('mirror.checked').length > 0);
    expect(events('mirror.checked')[0]!.payload).toMatchObject({ repo: SHOP_API, runId, ok: false, recreated: true, problem: expect.any(String) });
    await until(() => events('elfoqsy.message').some((e) => /mirror/i.test((e.payload as { text: string }).text)));
    const line = events('elfoqsy.message').map((e) => (e.payload as { text: string }).text).find((t) => /mirror/i.test(t))!;
    expect(line).toBe("The mirror of shop-api was damaged after Agent 1's run, and I made it again. Your own clone was not touched.");
    // The mirror is whole, shares nothing with the damaged run clone, and his clone is what it was.
    expect([...inodes(join(mirrorPath(), 'objects'))].filter((i) => inodes(join(clone, '.git', 'objects')).has(i))).toEqual([]);
    expect(w.world.git(mirrorPath(), 'fsck', '--full', '--no-dangling')).not.toMatch(/error|missing|corrupt/i);
    expect(w.world.git(w.world.clone.path, 'fsck', '--full', '--no-dangling')).not.toMatch(/error|missing|corrupt/i);
  });

  it('says it in Vietnamese, with tôi and cậu, when his latest message was in Vietnamese', async () => {
    language.current = 'vi';
    const { runId, clone } = await spawn();
    const mirror = inodes(join(mirrorPath(), 'objects'));
    const linked = files(join(clone, '.git', 'objects')).find((f) => (f.endsWith('.pack') || /\/objects\/[0-9a-f]{2}\//.test(f)) && mirror.has(`${statSync(f).dev}:${statSync(f).ino}`));
    expect(linked, 'an object file linked into the run clone').toBeDefined();
    chmodSync(linked!, 0o644);
    const bytes = readFileSync(linked!);
    for (let i = Math.min(40, bytes.length - 1); i < Math.min(64, bytes.length); i++) bytes[i] = bytes[i]! ^ 0xff;
    writeFileSync(linked!, bytes);
    await w.orchestrator.cancel(runId, 'Test over.');
    await until(() => events('elfoqsy.message').some((e) => /mirror/i.test((e.payload as { text: string }).text)));
    const line = events('elfoqsy.message').map((e) => (e.payload as { text: string }).text).find((t) => /mirror/i.test(t))!;
    expect(line).toBe('Mirror của shop-api bị hỏng sau lượt chạy của Agent 1, tôi đã dựng lại. Clone của cậu không bị đụng tới.');
  });

  it('checks the mirror after a task agent’s run as well', async () => {
    const r = await w.orchestrator.spawnTask({ name: 'Read shop-api', goal: 'look', deliverable: 'table', model: 'haiku', effort: 'low', repos: [SHOP_API] });
    expect(r).not.toHaveProperty('error');
    await tick();
    const created = events('run.created').at(-1)!.payload as { runId: string };
    await w.orchestrator.cancel(created.runId, 'Test over.');
    await until(() => events('mirror.checked').length > 0);
    expect(events('mirror.checked')[0]!.payload).toMatchObject({ repo: SHOP_API, ok: true });
  });
});
