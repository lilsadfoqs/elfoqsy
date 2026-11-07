// What the SDK's sandbox really does, for every agent kind that has a shell: the ticket agent, a task agent and a
// sub-agent. The real Claude Code binary runs under the real settings (sandboxSettings) against a fake API, so no model
// is called; its shell commands try to write outside the run folder, read credentials and reach the network, and the
// host is checked afterwards for what actually happened. The report, with the gaps, is docs/reports/sandbox-proof.md.
//
// The home is unreadable by default and what a run needs of it is allowed back (alex, 18 October), so every credential
// in it is unreadable without a list of their names, and a run writes only in its own folder, its ticket folder and the
// caches that are Elfoqsy's own. The two properties that did not hold when this was first written (the gate's credentials,
// and the other common ones) were marked `.fails` until that was done; they are plain tests now.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeReviewPack } from '../src/agents/reviewPack';
import { AGENT_CACHE_MARKER, MAX_TMPDIR, agentCacheDir, cacheEnv, ensureAgentCache, sandboxSettings, toolchainReads } from '../src/agents/run';
import { decide } from '../src/gate/policy';
import { SHOP_API, orchestratorWorld } from './helpers/orchestratorWorld';
import { hostServers, makeLayout, runProof, sandboxAvailable, type Kind, type Layout, type Proof, type Servers } from './helpers/sandboxProof';
import { tick } from './helpers/fakeSdk';
import type { Ticket } from '@elfoqsy/contracts';

const KINDS: Kind[] = ['ticket', 'task', 'subagent'];
const available = sandboxAvailable();

interface Run {
  layout: Layout;
  servers: Servers;
  proof: Proof;
}

const reachable = async (url: string): Promise<boolean> => {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
};

describe.skipIf(!available)('the sandbox, in each agent kind that has a shell', () => {
  const runs = new Map<Kind, Run>();
  let online = false;

  beforeAll(async () => {
    online = await reachable('https://registry.npmjs.org/');
    await Promise.all(
      KINDS.map(async (kind, i) => {
        const layout = makeLayout(`k${i}`); // short: the sandbox's sockets sit in each run's temp folder
        const servers = await hostServers(layout);
        runs.set(kind, { layout, servers, proof: await runProof(kind, layout, servers) });
      }),
    );
  }, 180_000);

  afterAll(async () => {
    // Its own made-up machines and the one file it was allowed to leave in /tmp, nothing else.
    for (const { layout, servers } of runs.values()) {
      await servers.close();
      rmSync(layout.tmpMarker, { force: true });
      rmSync(layout.base, { recursive: true, force: true });
    }
  });

  const result = (kind: Kind, name: string): string => runs.get(kind)!.proof.results.get(name) ?? '(not run)';
  const readable = (kind: Kind, listedIn: Layout['secrets'][number]['listedIn']): string[] =>
    runs.get(kind)!.layout.secrets.filter((s) => s.listedIn === listedIn && result(kind, `read ${s.name}`) !== 'BLOCKED').map((s) => s.name);

  describe.each(KINDS)('%s', (kind) => {
    it('runs its commands inside the sandbox: the proof ran in full', () => {
      const { proof } = runs.get(kind)!;
      expect(proof.results.size, `what came back: ${proof.raw.slice(0, 400)}`).toBeGreaterThan(60);
      expect(result(kind, 'allowed: the run folder')).toBe('0');
      expect(proof.raw).not.toMatch(/sandbox is required but failed/i);
    });

    it('cannot write outside its run folder: nothing it tried reached the host', () => {
      const { proof, layout } = runs.get(kind)!;
      // Twenty places (the home, a dotfile, another run, another ticket, the clones, the daemon's data, the repository, /etc,
      // /usr/local, /var/tmp, /tmp, his own caches, a symlink, a hard link, a move, ..): nothing reached the host.
      expect(Object.keys(layout.markers)).toHaveLength(19);
      expect(proof.created).toEqual([]);
      expect(proof.bashrc).toBe('# bashrc\n');
    });

    it('can write only where it is allowed to on purpose: its run folder, its temp folder, the shared cache and, for a ticket agent, its ticket folder', () => {
      for (const name of ['the run folder', 'the run temp folder', 'the shared cache folder']) expect(result(kind, `allowed: ${name}`)).toBe('0');
      // The ticket folder is a ticket agent's own (and its sub-agents'); a task has none.
      if (kind === 'task') expect(result(kind, 'allowed: the ticket folder')).not.toBe('0');
      else expect(result(kind, 'allowed: the ticket folder')).toBe('0');
      // Not any more: /tmp, and his own ~/.npm and ~/.cache. Nor another ticket's folder.
      for (const name of ['write /tmp', 'write his npm cache', 'write his cache folder', 'write another ticket folder']) expect(result(kind, name), name).not.toBe('0');
    });

    it('reads only what it needs of the home: its folder, its ticket folder (a ticket agent), the shared cache, and the toolchains it runs', () => {
      expect(result(kind, 'read: the run folder')).toBe('READABLE');
      expect(result(kind, 'read: the shared cache')).toBe('READABLE');
      expect(result(kind, 'read: what it wrote in the shared cache')).toBe('READABLE');
      expect(result(kind, 'read: the ticket folder')).toBe(kind === 'task' ? 'BLOCKED' : 'READABLE');
      // Not another run's, another ticket's, or a document of his.
      for (const name of ['read: another run', 'read: another ticket folder', 'read: a document in the home']) expect(result(kind, name), name).toBe('BLOCKED');
      // The toolchains run: node in an nvm-shaped folder, ~/.cargo/bin, ~/.local/bin.
      for (const name of ['run: node in an nvm-shaped folder', 'run: cargo in ~/.cargo/bin', 'run: a tool in ~/.local/bin']) expect(result(kind, name), name).toBe('RUNS');
    });

    it('reaches only the allowlist on the network', (ctx) => {
      const { servers } = runs.get(kind)!;
      const reached = (name: string) => /^0 2\d\d/.test(result(kind, name));
      for (const name of [
        'net: a host off the list',
        'net: a host off the list, plain http',
        'net: an IP address, straight',
        'net: an IP address, through the proxy',
        'net: the host loopback, straight',
        'net: the host loopback, through the proxy',
        'net: localhost by name, through the proxy',
      ]) expect(reached(name), name).toBe(false);
      for (const name of ['net: a raw TCP connection', 'net: a Unix socket on the host', 'net: a UDP DNS lookup']) expect(result(kind, name), name).not.toBe('0');
      // The servers on the host were never touched.
      expect(servers.hits()).toEqual({ web: 0, socket: 0 });
      if (!online) ctx.skip();
      expect(result(kind, 'net: an allowlisted host')).toBe('0 200');
    });

    // The daemon runs git in a run's clone with its own environment, outside the sandbox (status, add, push, fetch). Whatever a
    // shell can plant in the clone's .git/config (core.fsmonitor, a filter, a credential helper, a remote), its hooks or info
    // runs there. Found by a review: a core.fsmonitor in .git/config ran under the daemon's plain `git status`.
    it('cannot plant what the daemon’s own git would run: .git/config, hooks and info are not writable, and the clone cannot be moved or replaced', () => {
      const { proof, layout } = runs.get(kind)!;
      const attacks = [...proof.results.keys()].filter((k) => k.startsWith('guarded: '));
      expect(attacks).toHaveLength(15);
      for (const name of attacks) expect(result(kind, name), name).not.toBe('0');
      // Checked on the host, not by the exit codes.
      expect(proof.clone.config).toBe(layout.cloneBefore.config);
      expect(proof.clone.hooks).toEqual(layout.cloneBefore.hooks);
      expect(proof.clone.info).toEqual(layout.cloneBefore.info);
      expect(proof.clone.gitIsDir).toBe(true);
      expect(proof.clone.hookBody).toBe('#!/bin/sh\nexit 0\n');
      for (const moved of ['repo-old', 'my-hooks']) expect(existsSync(join(layout.runRoot, moved)), moved).toBe(false);
      expect(existsSync(join(layout.clone, '.git-old'))).toBe(false);
    });

    it('can still do the git work an agent does every day: commit, branch, switch, stash, status, diff, log', () => {
      for (const name of ['git commit', 'git branch', 'git switch -c', 'git stash', 'git status and diff', 'git log']) expect(result(kind, `works: ${name}`), name).toBe('0');
    });

    it('cannot even see, let alone signal, another process of the same user (the daemon is one)', () => {
      expect(result(kind, 'signal another process of the same user')).not.toBe('0');
    });

    it('cannot read the credentials the sandbox lists, nor the daemon’s own clones, data and logs', () => {
      expect(readable(kind, 'sandbox')).toEqual([]);
      expect(readable(kind, 'protected')).toEqual([]);
      // Nor the environment of another process of the same user, where the daemon has its tokens.
      expect(result(kind, 'read the environment of another process')).toBe('BLOCKED');
    });

    // The gate names these as credentials and the sandbox did not list them: the home's rule closes them.
    it('cannot read the credentials the gate itself names (gcloud, helm, azure, git credentials, netrc, keyrings)', () => {
      expect(readable(kind, 'gate')).toEqual([]);
    });

    // And the other places credentials live, which no list named: gnupg, pgpass, pypirc, cookies, history, cargo's credentials
    // (in a folder whose bin is readable), the Maven settings.
    it('cannot read other common credential locations (gnupg, pgpass, pypirc, cookies, history, cargo credentials, ...)', () => {
      expect(readable(kind, 'neither')).toEqual([]);
    });
  });

  it('keeps the sandbox\'s own settings what they are described to be: the home denied, a short list allowed back, /tmp and his caches not writable', () => {
    const { layout } = runs.get('ticket')!;
    const settings = sandboxSettings(layout.runRoot, layout.protectedPaths, layout.home, [layout.ticketDir], { cacheDir: layout.cache });
    expect(settings.filesystem?.denyRead).toContain(layout.home);
    expect(settings.filesystem?.allowWrite).toEqual([layout.runRoot, layout.ticketDir, layout.cache]);
    expect(settings.filesystem?.allowRead).toEqual(expect.arrayContaining([layout.runRoot, layout.ticketDir, layout.cache, join(layout.home, '.nvm'), join(layout.home, '.cargo', 'bin'), join(layout.home, '.local', 'bin')]));
    // Narrow: not the home, not ~/.cargo itself (credentials.toml), not his caches.
    for (const never of [layout.home, join(layout.home, '.cargo'), join(layout.home, '.npm'), join(layout.home, '.cache'), '/tmp']) {
      expect(settings.filesystem?.allowRead, never).not.toContain(never);
      expect(settings.filesystem?.allowWrite, never).not.toContain(never);
    }
  });

  it('keeps a shell command in the sandbox even when it asks to leave it: dangerouslyDisableSandbox is ignored', async () => {
    const { layout, servers } = runs.get('ticket')!;
    const marker = layout.markers['the home folder']!;
    rmSync(marker, { force: true });
    await runProof('ticket', layout, servers, { tool: { name: 'Bash', input: { command: `: > '${marker}'`, description: 'try', dangerouslyDisableSandbox: true } } });
    expect(existsSync(marker)).toBe(false);
  });

  // The reviewer's pack (19 October): what the reviewer holds the diff to is written by the orchestrator, so the run's own shell may not rewrite it.
  it('makes the reviewer’s pack read-only to a shell: not appended to, replaced, removed or renamed, and no file added; the same script changes it without the setting', async () => {
    const { layout, servers } = runs.get('ticket')!;
    const pack = join(layout.runRoot, '.elfoqsy', 'review');
    const gitDirs = [join(layout.clone, '.git')];
    const write = () => writeReviewPack(layout.runRoot, { ticket: { key: 'SHOP-1', summary: 's', description: 'd' } as Ticket, acceptance: 'The criteria.', handoff: 'The handoff.' });
    const script = [
      `cd '${pack}' || exit 0`,
      'echo tampered >> acceptance-criteria.md',
      'chmod u+w handoff.md',
      'echo tampered > handoff.md',
      ': > added.md',
      `mv '${pack}' '${pack}.moved'`,
      'rm -f acceptance-criteria.md',
      'true',
    ].join('\n');
    const before = () => ({ criteria: readFileSync(join(pack, 'acceptance-criteria.md'), 'utf8'), handoff: readFileSync(join(pack, 'handoff.md'), 'utf8') });
    try {
      write();
      const intact = before();
      await runProof('ticket', layout, servers, { script, sandbox: sandboxSettings(layout.runRoot, layout.protectedPaths, layout.home, [layout.ticketDir], { cacheDir: layout.cache, gitDirs, readOnlyDirs: [pack] }) });
      // Checked on the host: nothing of the script happened.
      expect(before()).toEqual(intact);
      expect(existsSync(join(pack, 'added.md'))).toBe(false);
      expect(existsSync(`${pack}.moved`)).toBe(false);
      expect(readdirSync(pack).sort()).toEqual(['acceptance-criteria.md', 'handoff.md']);
      // The control: without the setting, the same script does it, so what held was the setting.
      rmSync(pack, { recursive: true, force: true });
      write();
      await runProof('ticket', layout, servers, { script, sandbox: sandboxSettings(layout.runRoot, layout.protectedPaths, layout.home, [layout.ticketDir], { cacheDir: layout.cache, gitDirs }) });
      expect(existsSync(`${pack}.moved`), 'the folder was renamed away').toBe(true);
      expect(existsSync(join(`${pack}.moved`, 'added.md')) || !existsSync(join(`${pack}.moved`, 'acceptance-criteria.md')), 'a file was added or removed').toBe(true);
    } finally {
      rmSync(pack, { recursive: true, force: true });
      rmSync(`${pack}.moved`, { recursive: true, force: true });
    }
  }, 120_000);

  it('the Write and Read tools are not inside the sandbox, so the gate keeps deciding them', async () => {
    const { layout, servers } = runs.get('ticket')!;
    const outside = join(layout.home, 'written-by-the-write-tool');
    await runProof('ticket', layout, servers, { tool: { name: 'Write', input: { file_path: outside, content: 'x' } } });
    // If this ever fails, the SDK bounds its file tools too, and the gate may stop asking for them as well.
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { force: true });
    const listed = layout.secrets.find((s) => s.listedIn === 'sandbox')!;
    const read = await runProof('ticket', layout, servers, { tool: { name: 'Read', input: { file_path: listed.path } } });
    expect(read.raw).toContain(listed.content);
    // So the gate's own rules for them stay: a write outside the run folder is asked, a credential is refused.
    const ctx = { worktree: layout.runRoot, branch: 'feature/SHOP-1', hosts: { jira: [], github: [], registry: [] }, protectedPaths: layout.protectedPaths, home: layout.home };
    expect(decide('Write', { file_path: outside }, ctx)).toMatchObject({ behavior: 'ask', kind: 'outside_worktree' });
    expect(decide('Read', { file_path: listed.path }, ctx)).toMatchObject({ behavior: 'deny' });
  });

  it('keeps the run’s temp folder, where the sandbox’s sockets live, inside what the sandbox accepts', async () => {
    const { layout, servers } = runs.get('ticket')!;
    const at = async (length: number): Promise<boolean> => {
      const pad = length - join(layout.runsRoot, '.tmp').length - 1;
      const runRoot = join(layout.runsRoot, 'p'.repeat(pad));
      const tmp = join(runRoot, '.tmp');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tmp, { recursive: true });
      const proof = await runProof('ticket', { ...layout, runRoot }, servers, { script: 'echo PROOF-OK', tmpdir: tmp });
      rmSync(runRoot, { recursive: true, force: true });
      return proof.raw.includes('PROOF-OK');
    };
    expect(await at(MAX_TMPDIR)).toBe(true);
    // The real limit is a little above MAX_TMPDIR (74 with SDK 0.3.295); far above would mean MAX_TMPDIR is too tight.
    expect(await at(MAX_TMPDIR + 2)).toBe(false);
  }, 60_000);
});

describe('every agent kind that has a shell gets the one sandbox', () => {
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

  it('is the same for a ticket agent and a task agent, apart from the ticket folder a ticket agent holds', async () => {
    const w = orchestratorWorld({ tickets: true });
    try {
      w.log.append('jira', 'ticket.synced', { ticket: ticket('SHOP-3546') });
      await w.orchestrator.spawn({ ticketKey: 'SHOP-3546', repos: [SHOP_API] });
      await w.orchestrator.spawnTask({ name: 'Compare images', goal: 'g', deliverable: 'table', model: 'haiku', effort: 'low' });
      await tick();
      const [ticketSession, taskSession] = w.sdk.sessions;
      const created = w.log.readFrom(0, 1000, ['run.created']).map((e) => e.payload as { worktree: string });
      const home = homedir();
      const protectedPaths = [w.world.reposRoot];
      const ticketDir = join(w.world.root, 'tickets', 'SHOP-3546');
      const cacheDir = agentCacheDir(dirname(created[0]!.worktree));
      // The clones in each run folder: what the daemon's own git trusts there is not writable from a shell.
      const gitDirs = (worktree: string) => readdirSync(worktree, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(worktree, d.name, '.git'))).map((d) => join(worktree, d.name, '.git'));
      expect(gitDirs(created[0]!.worktree).length).toBeGreaterThan(0);
      // A ticket agent's reviewer reads the ticket's handoff and acceptance criteria from a folder its shell cannot write to.
      const pack = join(created[0]!.worktree, '.elfoqsy', 'review');
      expect(existsSync(join(pack, 'acceptance-criteria.md'))).toBe(true);
      expect(ticketSession!.options.sandbox).toEqual(sandboxSettings(created[0]!.worktree, protectedPaths, home, [ticketDir], { cacheDir, gitDirs: gitDirs(created[0]!.worktree), readOnlyDirs: [pack] }));
      expect(existsSync(join(created[1]!.worktree, '.elfoqsy', 'review'))).toBe(false);
      expect(taskSession!.options.sandbox).toEqual(sandboxSettings(created[1]!.worktree, protectedPaths, home, [], { cacheDir, gitDirs: gitDirs(created[1]!.worktree) }));
      for (const hooks of gitDirs(created[0]!.worktree).map((d) => join(d, 'hooks'))) expect((ticketSession!.options.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toContain(hooks);
      // Both run with the package managers pointed at that cache, and a TMPDIR of their own inside the run folder.
      for (const [session, worktree] of [[ticketSession!, created[0]!.worktree], [taskSession!, created[1]!.worktree]] as const) {
        expect(session.options.env).toMatchObject({ ...cacheEnv(cacheDir), TMPDIR: join(worktree, '.tmp') });
      }
      expect(existsSync(cacheDir)).toBe(true);
      for (const s of [ticketSession!, taskSession!]) {
        expect(s.options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { strictAllowlist: true } });
        // Its sub-agents are in the same session, with its sandbox: they define no sandbox of their own.
        expect(Object.keys(s.options.agents ?? {}).length).toBeGreaterThan(1);
        for (const def of Object.values(s.options.agents ?? {})) expect(def).not.toHaveProperty('sandbox');
      }
    } finally {
      await w.close();
    }
  });

  it('is the only kind of session that has a shell: investigators, the responder and Elfoqsy have none', () => {
    const src = (file: string) => readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');
    for (const file of ['agents/investigator.ts', 'decisions/responder.ts', 'elfoqsy/session.ts']) {
      const text = src(file);
      // Bash is never in a list of the tools a session is given; at most in the list of those it is denied.
      expect(text, file).not.toMatch(/\btools:\s*\[[^\]]*'Bash'/);
      expect(text, file).not.toMatch(/(?<!dis)allowedTools:[^\n]*'Bash'/);
      for (const line of text.split('\n').filter((l) => l.includes("'Bash'") && !l.trim().startsWith('//'))) expect(line, `${file}: ${line.trim()}`).toContain('disallowedTools');
    }
    // The responder and the usage probe are given no built-in tools at all. Elfoqsy is given none either, but the web (19 October), and
    // only behind its outgoing check: WebSearch and WebFetch, which have no shell and no files; and Skill (20 October), which loads a
    // skill's text and runs nothing.
    for (const file of ['decisions/responder.ts']) expect(src(file), file).toMatch(/\btools:\s*\[\]/);
    expect(src('elfoqsy/session.ts')).toContain("tools: [...(o.web ? WEB_TOOLS : []), ...(o.abilities ? ['Skill'] : [])],");
    expect(src('elfoqsy/web.ts')).toContain("export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;");
  });
});

describe('what a run may read of the home, and where its caches are', () => {
  const home = '/home/u';
  const has = (...present: string[]) => (path: string) => present.includes(path);

  it('lists the toolchains that are on the machine and no others, and never a folder that holds credentials', () => {
    const exists = has(`${home}/.nvm`, `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/.cargo`, `${home}/.dotnet`, `${home}/sdk`);
    const reads = toolchainReads(home, exists, '/usr/bin/node');
    // .cargo itself (credentials.toml) and .dotnet (certificate stores) are never named: cargo's bin is.
    expect(reads).toEqual([`${home}/.nvm`, `${home}/.cargo/bin`, `${home}/.local/bin`, `${home}/sdk`]);
    expect(toolchainReads(home, has(), '/usr/bin/node')).toEqual([]);
  });

  it('adds the folder of the node that runs the daemon only when it is a node install of its own, a level or more below the home', () => {
    const install = has(`${home}/tools/node-v24/lib/node_modules`);
    expect(toolchainReads(home, install, `${home}/tools/node-v24/bin/node`)).toEqual([`${home}/tools/node-v24`]);
    // Inside nvm, which is listed: nothing more.
    expect(toolchainReads(home, has(`${home}/.nvm`, `${home}/.nvm/versions/node/v24.18.0/lib/node_modules`), `${home}/.nvm/versions/node/v24.18.0/bin/node`)).toEqual([`${home}/.nvm`]);
    // Outside the home: nothing to allow.
    expect(toolchainReads(home, has('/usr/local/lib/node_modules'), '/usr/local/bin/node')).toEqual([]);
    // Not a node install (no lib/node_modules): a folder with a bin/node in it is not a toolchain.
    expect(toolchainReads(home, has(), `${home}/tools/node-v24/bin/node`)).toEqual([]);
    // Never a folder that holds more than node: ~/.local/bin/node would open all of ~/.local, ~/.cargo/bin/node all of ~/.cargo, ~/bin/node the home.
    for (const node of [`${home}/.local/bin/node`, `${home}/.cargo/bin/node`, `${home}/bin/node`]) {
      expect(toolchainReads(home, has(`${home}/.local/lib/node_modules`, `${home}/.cargo/lib/node_modules`, `${home}/lib/node_modules`), node), node).toEqual([]);
    }
  });

  it('claims the cache folder with a marker and takes over no folder that holds anything else', () => {
    const base = mkdtempSync(join(tmpdir(), 'elfoqsy-cache-'));
    try {
      const fresh = join(base, 'cache');
      ensureAgentCache(fresh);
      expect(existsSync(join(fresh, AGENT_CACHE_MARKER))).toBe(true);
      writeFileSync(join(fresh, 'npm-thing'), 'x');
      ensureAgentCache(fresh); // again: it is hers now, with what is in it
      expect(existsSync(join(fresh, 'npm-thing'))).toBe(true);
      // A folder that exists, is not empty and is not hers: refused, with the setting that names another.
      const foreign = join(base, 'his-cache');
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'notes.txt'), 'his');
      expect(() => ensureAgentCache(foreign)).toThrow(/already holds something else.*AGENT_CACHE_DIR/);
      expect(existsSync(join(foreign, AGENT_CACHE_MARKER))).toBe(false);
      // An empty folder that exists is taken.
      const empty = join(base, 'empty');
      mkdirSync(empty);
      ensureAgentCache(empty);
      expect(existsSync(join(empty, AGENT_CACHE_MARKER))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('puts every package cache in Elfoqsy’s own folder, beside the run folders and shared by them', () => {
    expect(agentCacheDir('/home/u/.local/share/elfoqsy/runs')).toBe('/home/u/.local/share/elfoqsy/cache');
    const env = cacheEnv('/c');
    expect(env).toMatchObject({ XDG_CACHE_HOME: '/c/xdg', npm_config_cache: '/c/npm', PNPM_HOME: '/c/pnpm-home' });
    // Only the cache folder of the XDG family moves: the Claude Code process of the session reads this environment too.
    expect(Object.keys(env).filter((k) => k.startsWith('XDG_'))).toEqual(['XDG_CACHE_HOME']);
    // No npm_config_ variable npm does not know: npm 11 warns about each on every command.
    expect(Object.keys(env).filter((k) => k.startsWith('npm_config_'))).toEqual(['npm_config_cache']);
    // Every one of them is under it, and none is his.
    for (const value of Object.values(env)) expect(value.startsWith('/c/')).toBe(true);
  });
});
