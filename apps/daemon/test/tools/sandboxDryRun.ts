// A dry run of the sandbox a run really gets, on this machine, before it is enabled for real: the real home, the real
// toolchains (toolchainReads), the real SDK and binary, against the fake API (no model). Only harmless commands run: version
// numbers, a write to the run's own temp folder and to Elfoqsy's cache, and `test -r` on paths that must be unreadable (it asks
// the kernel whether the file could be read; nothing is read, nothing is listed). No network. The run folder is a scratch one
// in the same place real runs live (inside the home), removed afterwards. Run it after changing the allow list:
//   pnpm --filter @elfoqsy/daemon sandbox:dryrun
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentCacheDir, cacheEnv, sandboxSettings, toolchainReads } from '../../src/agents/run';
import { REPO_ROOT, defaultWorktreesRoot } from '../../src/config';
import { hostServers, makeLayout, runProof } from '../helpers/sandboxProof';

const home = homedir();
// The default place for run folders (his .env is not read: a WORKTREES_ROOT of his own would put them elsewhere).
const worktreesRoot = defaultWorktreesRoot(process.env);
const cache = agentCacheDir(worktreesRoot);
const scratch = join(dirname(worktreesRoot), 'dryrun', 'd0');
const runRoot = join(scratch, 'run');
const tmp = join(runRoot, '.tmp');
mkdirSync(tmp, { recursive: true });
mkdirSync(cache, { recursive: true });

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
// What must be unreadable from a shell, and whether it is there to be tested at all (asked of the host, outside the sandbox).
const mustBlock = ['.ssh', '.aws', '.kube', '.gnupg', '.docker', '.claude', '.claude.json', '.npmrc', '.bash_history', '.zsh_history', '.gitconfig', '.config/gh', '.config/gcloud', '.cargo/credentials.toml', '.local/share/keyrings', 'Documents', 'Downloads', '.cache', '.npm', 'tickets'].map((p) => join(home, p));
const present = mustBlock.filter((p) => existsSync(p));

const toolchains = toolchainReads(home);

// A script in an allowed bin folder is readable by every agent. A wrapper that holds a literal token would hand it over, so look,
// and say which file and how many lines (never what is in it).
const LITERAL_CREDENTIAL = /(token|secret|key|passw[a-z]*)[A-Za-z_]*=["']?[A-Za-z0-9_./+=-]{16,}/i;
const warnings: string[] = [];
for (const dir of toolchains.filter((t) => t.endsWith('/bin'))) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).size > 65_536) continue;
      const head = Buffer.alloc(2);
      const fd = openSync(file, 'r');
      readSync(fd, head, 0, 2, 0);
      closeSync(fd);
      if (head.toString() !== '#!') continue;
      const hits = readFileSync(file, 'utf8').split('\n').filter((l) => LITERAL_CREDENTIAL.test(l)).length;
      if (hits) warnings.push(`${file.replace(home, '~')}: ${hits} line(s) look like a literal credential`);
    } catch {
      // not readable here: not a thing to warn about
    }
  }
}
const script = [
  `x() { n=$1; shift; out=$("$@" 2>&1 | head -1); echo "CASE $n $out"; }`,
  `b() { n=$1; if [ -r "$2" ]; then echo "CASE $n READABLE"; else echo "CASE $n BLOCKED"; fi; }`,
  `x 'node' node --version`,
  `x 'npm' npm --version`,
  `x 'npx' npx --version`,
  `x 'pnpm' pnpm --version`,
  `x 'git' git --version`,
  `x 'bash' bash -c 'echo $BASH_VERSION'`,
  `x 'tar' tar --version`,
  `x 'where node is' sh -c 'command -v node'`,
  `x 'where pnpm is' sh -c 'command -v pnpm'`,
  `x 'npm cache dir' npm config get cache`,
  `x 'pnpm store path' pnpm store path`,
  `x 'npm, a command that warns of unknown config' npm config get registry`,
  `x 'XDG_CACHE_HOME' sh -c 'echo $XDG_CACHE_HOME'`,
  `x 'TMPDIR' sh -c 'echo $TMPDIR'`,
  `x 'a write to TMPDIR from node' node -e ${q(`require('fs').writeFileSync(process.env.TMPDIR + '/dry', 'x'); console.log('ok')`)}`,
  `x 'a write to the cache from node' node -e ${q(`require('fs').mkdirSync(process.env.XDG_CACHE_HOME, {recursive: true}); require('fs').writeFileSync(process.env.XDG_CACHE_HOME + '/dry', 'x'); console.log('ok')`)}`,
  `x 'a write to /tmp from node' node -e ${q(`try { require('fs').writeFileSync('/tmp/dry-should-fail-' + process.pid, 'x'); console.log('WROTE (should not)'); } catch (e) { console.log('blocked: ' + e.code); }`)}`,
  ...present.map((p) => `b ${q(`test -r ${p.replace(home, '~')}`)} ${q(p)}`),
].join('\n');

const layout = makeLayout('dry');
const servers = await hostServers(layout);
try {
  const sandbox = sandboxSettings(runRoot, [join(REPO_ROOT, '.env'), join(REPO_ROOT, 'data')], home, [], { cacheDir: cache });
  const proof = await runProof('ticket', { ...layout, runRoot }, servers, {
    script,
    tmpdir: tmp,
    sandbox,
    extraEnv: { HOME: home, PATH: [dirname(process.execPath), process.env.PATH ?? '', join(home, '.local', 'bin')].join(':'), ...cacheEnv(cache) },
  });
  console.log(`Allowed back into the home (${toolchains.length} toolchains): ${toolchains.map((t) => t.replace(home, '~')).join(', ') || 'none'}`);
  console.log(`Writable: the run folder, the shared cache ${cache.replace(home, '~')}. Not /tmp, not ~/.npm, not ~/.cache.\n`);
  // Every line the commands printed (the parsed results keep only the yes/no ones).
  for (const line of proof.raw.split('\n').filter((l) => l.startsWith('CASE '))) {
    const [, name = '', result = ''] = /^CASE '?(.*?)'? (\S.*)$/.exec(line.trim()) ?? [];
    console.log(`${name.padEnd(46)} ${result}`);
  }
  const readable = present.filter((p) => proof.results.get(`test -r ${p.replace(home, '~')}`) !== 'BLOCKED');
  console.log(`\nChecked ${present.length} sensitive paths that exist on this machine (of ${mustBlock.length} named): ${readable.length ? `READABLE: ${readable.join(', ')}` : 'all of them unreadable.'}`);
  for (const w of warnings) console.log(`WARNING, readable by every agent: ${w}`);
  if (!warnings.length) console.log('No script in an allowed bin folder holds a literal credential.');
  if (!proof.results.size) console.log(`Nothing came back: ${proof.raw.slice(0, 600)}`);
  process.exitCode = readable.length || warnings.length || !proof.results.size ? 1 : 0;
} finally {
  await servers.close();
  rmSync(layout.base, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
