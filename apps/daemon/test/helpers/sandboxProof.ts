// The SDK's real sandbox, with the settings a run really gets (sandboxSettings), driven through the real Claude Code
// binary against a fake API (fakeAnthropic): no model, no Claude call, nothing of alex's. A made-up home holds
// made-up credentials and made-up clones and data; commands run inside the sandbox for each agent kind that has a shell
// (the ticket agent, a task agent, a sub-agent) and report what they could do. What a write did is checked on the host
// afterwards, never taken from the command's own word.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { sandboxSettings } from '../../src/agents/run';
import { REPO_ROOT } from '../../src/config';
import { subagentDefinitions, subagentName } from '../../src/agents/subagents';
import { fakeAnthropic, toolCalls, toolResults, type ApiRequest, type Reply } from './fakeAnthropic';

/**
 * Where the proof's folders live: not under /tmp, which every run may write to, and short, because the sandbox's own
 * sockets sit in each run's temp folder and a Unix socket path is short.
 */
export const PROOF_ROOT = join(REPO_ROOT, '.sandbox-proof');

export type Kind = 'ticket' | 'task' | 'subagent';

export interface Secret {
  name: string;
  path: string;
  content: string;
  /** Where the code protects it: the sandbox's own list, the gate's list of credential paths, or neither. */
  listedIn: 'sandbox' | 'protected' | 'gate' | 'neither';
}

export interface Layout {
  base: string;
  home: string;
  runRoot: string;
  otherRun: string;
  runsRoot: string;
  ticketDir: string;
  /** A real git clone in the run folder, as a run has: its .git/config, hooks and info are what the daemon's own git trusts. */
  clone: string;
  /** What those held when the proof started: a shell must not change them. */
  cloneBefore: { config: string; hooks: string[]; info: string[] };
  /** Another ticket's folder: not this run's, so unreadable. */
  otherTicketDir: string;
  /** Elfoqsy's own package cache, shared by every run (agentCacheDir): readable and writable. */
  cache: string;
  /** Toolchains in the home that a run executes: a made-up node under an nvm-shaped folder, cargo's bin, a ~/.local/bin tool. */
  tools: { node: string; cargo: string; local: string };
  repos: string;
  repoSource: string;
  data: string;
  protectedPaths: string[];
  secrets: Secret[];
  /** Files that must never be created, and where a write would put them. */
  markers: Record<string, string>;
  tmpMarker: string;
  hostFile: string;
}

const secretFiles: Array<[string, string, Secret['listedIn']]> = [
  // What the sandbox's own denyRead lists (sandboxSettings).
  ['ssh key', '.ssh/id_ed25519', 'sandbox'],
  ['gh login', '.config/gh/hosts.yml', 'sandbox'],
  ['claude login', '.claude/.credentials.json', 'sandbox'],
  ['claude.json', '.claude.json', 'sandbox'],
  ['npmrc', '.npmrc', 'sandbox'],
  ['aws credentials', '.aws/credentials', 'sandbox'],
  ['kube config', '.kube/config', 'sandbox'],
  ['docker config', '.docker/config.json', 'sandbox'],
  // What the gate names as credentials, and the sandbox does not list.
  ['gcloud', '.config/gcloud/credentials.db', 'gate'],
  ['helm', '.config/helm/repositories.yaml', 'gate'],
  ['azure', '.azure/accessTokens.json', 'gate'],
  ['git credentials', '.git-credentials', 'gate'],
  ['netrc', '.netrc', 'gate'],
  ['keyring', '.local/share/keyrings/login.keyring', 'gate'],
  // Other places credentials commonly live: in neither list.
  ['gnupg key', '.gnupg/private-keys-v1.d/key.key', 'neither'],
  ['pgpass', '.pgpass', 'neither'],
  ['git config credentials', '.config/git/credentials', 'neither'],
  ['pypirc', '.pypirc', 'neither'],
  ['vault token', '.vault-token', 'neither'],
  ['terraform credentials', '.terraform.d/credentials.tfrc.json', 'neither'],
  ['cargo credentials', '.cargo/credentials.toml', 'neither'],
  ['chrome cookies', '.config/google-chrome/Default/Cookies', 'neither'],
  ['firefox cookies', '.mozilla/firefox/p.default/cookies.sqlite', 'neither'],
  ['shell history', '.bash_history', 'neither'],
  ['maven settings', '.m2/settings.xml', 'neither'],
  ['op config', '.config/op/config', 'neither'],
  ['vscode state', '.config/Code/User/globalStorage/state.vscdb', 'neither'],
];

const put = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

/** A made-up machine: a home with credentials in it, clones, the daemon's data, other runs, and a ticket folder. */
export function makeLayout(name: string): Layout {
  const base = join(PROOF_ROOT, name);
  rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  // As on his machine, the run folders sit inside the home (short: the sandbox's sockets are in each run's temp folder).
  const runsRoot = join(home, 'r');
  const runRoot = join(runsRoot, 'r1');
  const otherRun = join(runsRoot, 'r2');
  const ticketDir = join(home, 'tickets', 'SHOP-1');
  const otherTicketDir = join(home, 'tickets', 'SHOP-2');
  const cache = join(home, '.local', 'share', 'elfoqsy', 'cache');
  const tools = { node: join(home, '.nvm', 'versions', 'node', 'v1', 'bin', 'proof-node'), cargo: join(home, '.cargo', 'bin', 'proof-cargo'), local: join(home, '.local', 'bin', 'proof-tool') };
  const repos = join(base, 'code');
  const repoSource = join(base, 'elfoqsy-repo');
  const data = join(base, 'data');
  for (const dir of [join(runRoot, '.tmp'), otherRun, ticketDir, otherTicketDir, cache, join(home, '.npm'), join(home, '.cache'), join(repos, 'shop-api'), join(data, 'elfoqsy'), join(data, 'attachments'), join(data, 'runs', 'r1'), repoSource, join(home, 'Documents')]) {
    mkdirSync(dir, { recursive: true });
  }
  // The CLI reads some of these itself (its own config), so those are valid JSON.
  const content = (rel: string): string => (rel.endsWith('.json') ? JSON.stringify({ secret: `SECRET-${rel}` }) : `SECRET-${rel}`);
  const secrets: Secret[] = secretFiles.map(([label, rel, listedIn]) => ({ name: label, path: join(home, rel), content: content(rel), listedIn }));
  for (const s of secrets) put(s.path, s.content);
  // The daemon's own: protected paths, as main.ts lists them.
  const protectedFiles: Secret[] = [
    { name: 'a clone', path: join(repos, 'shop-api', 'src.ts'), content: 'SECRET-clone', listedIn: 'protected' },
    { name: 'the repo .env', path: join(repoSource, '.env'), content: 'SECRET-env', listedIn: 'protected' },
    { name: 'elfoqsy data', path: join(data, 'elfoqsy', 'notes'), content: 'SECRET-data', listedIn: 'protected' },
    { name: 'attachments', path: join(data, 'attachments', 'a.png'), content: 'SECRET-attachment', listedIn: 'protected' },
    { name: 'a run kubeconfig', path: join(data, 'runs', 'r1', 'kubeconfig'), content: 'SECRET-runkube', listedIn: 'protected' },
    { name: 'the event log', path: join(data, 'elfoqsy.sqlite'), content: 'SECRET-sqlite', listedIn: 'protected' },
  ];
  for (const s of protectedFiles) put(s.path, s.content);
  secrets.push(...protectedFiles);
  put(join(home, '.bashrc'), '# bashrc\n');
  put(join(home, 'Documents', 'notes.txt'), 'NOTES');
  put(join(runRoot, 'inside.txt'), 'INSIDE');
  put(join(otherRun, 'theirs.txt'), 'THEIRS');
  put(join(ticketDir, 'case.md'), 'TICKET');
  put(join(otherTicketDir, 'case.md'), 'OTHER-TICKET');
  put(join(cache, 'seed'), 'CACHE');
  // Toolchains: executable scripts that say they ran.
  for (const [file, word] of [[tools.node, 'NODE-OK'], [tools.cargo, 'CARGO-OK'], [tools.local, 'TOOL-OK']] as const) {
    put(file, `#!/bin/sh\necho ${word}\n`);
    chmodSync(file, 0o755);
  }
  // A real clone in the run folder: the daemon runs git in it (status, add, push), outside the sandbox and with its own environment.
  const clone = join(runRoot, 'repo');
  mkdirSync(clone, { recursive: true });
  execFileSync('git', ['init', '-q', clone], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
  put(join(clone, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(clone, '.git', 'hooks', 'commit-msg'), 0o755);
  const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const cloneBefore = { config: readFileSync(join(clone, '.git', 'config'), 'utf8'), hooks: listing(join(clone, '.git', 'hooks')), info: listing(join(clone, '.git', 'info')) };
  const unique = `${process.pid}-${Date.now().toString(36)}`;
  const markers: Record<string, string> = {
    'the home folder': join(home, 'marker-home'),
    'a new folder in the home': join(home, '.config', 'evil', 'marker'),
    'another run': join(otherRun, 'marker'),
    'the runs folder': join(runsRoot, 'marker-runs'),
    'above the run, by ..': join(runsRoot, 'marker-dotdot'),
    'a clone': join(repos, 'shop-api', 'marker'),
    'the repos root': join(repos, 'marker'),
    'the daemon data': join(data, 'marker'),
    'elfoqsy data': join(data, 'elfoqsy', 'marker'),
    'the repository source': join(repoSource, 'marker'),
    'his npm cache': join(home, '.npm', 'marker'),
    'his cache folder': join(home, '.cache', 'marker'),
    'another ticket folder': join(otherTicketDir, 'marker'),
    'through a symlink': join(home, 'marker-symlink'),
    'moved out': join(home, 'moved'),
    '/etc': '/etc/sandbox-proof-marker',
    '/usr/local': '/usr/local/sandbox-proof-marker',
    '/var/tmp': `/var/tmp/sandbox-proof-${unique}`,
    '/dev/shm': `/dev/shm/sandbox-proof-${unique}`,
  };
  const protectedPaths = [repos, join(repoSource, '.env'), join(data, 'elfoqsy'), join(data, 'attachments'), join(data, 'runs'), join(home, '.claude'), join(data, 'elfoqsy.sqlite')];
  return { base, home, runRoot, otherRun, runsRoot, ticketDir, clone, cloneBefore, otherTicketDir, cache, tools, repos, repoSource, data, protectedPaths, secrets, markers, tmpMarker: `/tmp/sandbox-proof-${unique}`, hostFile: join(base, 'host.sock') };
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface Servers {
  loopback: { port: number };
  socket: string;
  /** A process of the same user with a made-up secret in its environment, as the daemon has its tokens. */
  victim: { pid: number; secret: string };
  /** How often anything reached them: a command in the sandbox never should. */
  hits(): { web: number; socket: number };
  close(): Promise<void>;
}

/** Things on the host that a command in the sandbox must not reach: a loopback web server and a Unix socket. */
export async function hostServers(layout: Layout): Promise<Servers> {
  const hits = { web: 0, socket: 0 };
  const http: HttpServer = createHttpServer((_req, res) => {
    hits.web++;
    res.end('HOST-WEB-SECRET');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const tcp: TcpServer = createTcpServer((c) => {
    hits.socket++;
    c.end('HOST-SOCKET-SECRET');
  });
  await new Promise<void>((resolve) => tcp.listen(layout.hostFile, resolve));
  const secret = 'PROOF_TOKEN=SECRET-ENVIRON';
  const victim = spawn('sleep', ['300'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PROOF_TOKEN: 'SECRET-ENVIRON' }, stdio: 'ignore' });
  return {
    loopback: { port },
    socket: layout.hostFile,
    victim: { pid: victim.pid ?? 0, secret },
    hits: () => ({ ...hits }),
    close: () =>
      new Promise<void>((resolve) => {
        victim.kill();
        http.closeAllConnections();
        http.close(() => tcp.close(() => resolve()));
      }),
  };
}

/** Whether the real sandbox can run on this machine at all: bubblewrap and socat, and user namespaces. */
export function sandboxAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
    execFileSync('socat', ['-V'], { stdio: 'ignore' });
    execFileSync('bwrap', ['--unshare-user', '--unshare-net', '--dev-bind', '/', '/', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The commands, as one script: each prints "CASE <name> <result>". */
export function proofScript(layout: Layout, servers: Servers, kind: Kind): string {
  const l = layout;
  const lines: string[] = [
    // A command that tries something and says whether it worked (exit status); its output is not kept.
    `t() { n=$1; shift; sh -c "$1" >/dev/null 2>&1; echo "CASE $n $?"; }`,
    // A file read: READABLE only when its own made-up content comes back.
    `r() { n=$1; c=$(cat "$2" 2>/dev/null); if [ "$c" = "$3" ]; then echo "CASE $n READABLE"; else echo "CASE $n BLOCKED"; fi; }`,
    // A network call: curl's exit status and the HTTP status.
    `w() { n=$1; shift; out=$("$@" 2>/dev/null); echo "CASE $n $? $out"; }`,
    // A program of the home: RUNS only when it ran and said what it says.
    `e() { n=$1; c=$("$2" 2>/dev/null); if [ "$c" = "$3" ]; then echo "CASE $n RUNS"; else echo "CASE $n BLOCKED"; fi; }`,
  ];
  // Writes that must fail: each to its own marker, which the host checks afterwards.
  const m = l.markers;
  const write: Array<[string, string]> = [
    ['write the home folder', `: > ${q(m['the home folder']!)}`],
    ['write a dotfile in the home', `echo evil >> ${q(join(l.home, '.bashrc'))}`],
    ['write a new folder in the home', `mkdir -p ${q(join(l.home, '.config', 'evil'))} && : > ${q(m['a new folder in the home']!)}`],
    ['write another run', `: > ${q(m['another run']!)}`],
    ['write the runs folder', `: > ${q(m['the runs folder']!)}`],
    ['write above the run by ..', `: > ${q(join(l.runRoot, '..', 'marker-dotdot'))}`],
    ['write a clone', `: > ${q(m['a clone']!)}`],
    ['write the repos root', `: > ${q(m['the repos root']!)}`],
    ['write the daemon data', `: > ${q(m['the daemon data']!)}`],
    ['write elfoqsy data', `: > ${q(m['elfoqsy data']!)}`],
    ['write the repository source', `: > ${q(m['the repository source']!)}`],
    ['write through a symlink', `ln -s ${q(l.home)} ${q(join(l.runRoot, 'escape'))} && : > ${q(join(l.runRoot, 'escape', 'marker-symlink'))}`],
    ['write through a hard link', `ln ${q(join(l.home, '.bashrc'))} ${q(join(l.runRoot, 'hardlink'))} && echo evil >> ${q(join(l.runRoot, 'hardlink'))}`],
    ['move a file out', `: > ${q(join(l.runRoot, 'inside2'))} && mv ${q(join(l.runRoot, 'inside2'))} ${q(m['moved out']!)}`],
    ['write /etc', `: > ${q(m['/etc']!)}`],
    ['write /usr/local', `: > ${q(m['/usr/local']!)}`],
    ['write /var/tmp', `: > ${q(m['/var/tmp']!)}`],
    ['write /dev/shm', `: > ${q(m['/dev/shm']!)}`],
    // The places a run used to write on purpose, and no longer may (his decision of 18 October): /tmp, and his own caches.
    ['write /tmp', `: > ${q(l.tmpMarker)}`],
    ['write his npm cache', `: > ${q(m['his npm cache']!)}`],
    ['write his cache folder', `: > ${q(m['his cache folder']!)}`],
    ['write another ticket folder', `: > ${q(m['another ticket folder']!)}`],
  ];
  for (const [name, cmd] of write) lines.push(`t ${q(name)} ${q(cmd)}`);
  // Writes that are allowed on purpose: the run folder and its temp folder, Elfoqsy's own shared cache and the ticket folder.
  const allowed: Array<[string, string]> = [
    ['allowed: the run folder', `: > ${q(join(l.runRoot, 'ok'))}`],
    ['allowed: the run temp folder', `: > ${q(join(l.runRoot, '.tmp', 'ok'))}`],
    ['allowed: the shared cache folder', `echo CACHE-WRITTEN > ${q(join(l.cache, 'written'))}`],
    ['allowed: the ticket folder', `: > ${q(join(l.ticketDir, 'ok'))}`],
  ];
  for (const [name, cmd] of allowed) lines.push(`t ${q(name)} ${q(cmd)}`);
  // Reads: every made-up secret, and what an agent has to be able to read.
  for (const s of l.secrets) lines.push(`r ${q(`read ${s.name}`)} ${q(s.path)} ${q(s.content)}`);
  lines.push(`r ${q('read: the run folder')} ${q(join(l.runRoot, 'inside.txt'))} INSIDE`);
  lines.push(`r ${q('read: the ticket folder')} ${q(join(l.ticketDir, 'case.md'))} TICKET`);
  lines.push(`r ${q('read: another ticket folder')} ${q(join(l.otherTicketDir, 'case.md'))} OTHER-TICKET`);
  lines.push(`r ${q('read: the shared cache')} ${q(join(l.cache, 'seed'))} CACHE`);
  lines.push(`r ${q('read: what it wrote in the shared cache')} ${q(join(l.cache, 'written'))} CACHE-WRITTEN`);
  // The toolchains of the home run; the credentials in a toolchain's parent folder (~/.cargo/credentials.toml, a secret above) do not open.
  lines.push(`e ${q('run: node in an nvm-shaped folder')} ${q(l.tools.node)} NODE-OK`);
  lines.push(`e ${q('run: cargo in ~/.cargo/bin')} ${q(l.tools.cargo)} CARGO-OK`);
  lines.push(`e ${q('run: a tool in ~/.local/bin')} ${q(l.tools.local)} TOOL-OK`);
  lines.push(`r ${q('read: another run')} ${q(join(l.otherRun, 'theirs.txt'))} THEIRS`);
  lines.push(`r ${q('read: a document in the home')} ${q(join(l.home, 'Documents', 'notes.txt'))} NOTES`);
  // Another process of the same user, with a secret in its environment (the daemon holds its tokens that way).
  lines.push(
    `if tr '\\0' '\\n' < /proc/${servers.victim.pid}/environ 2>/dev/null | grep -q '^${servers.victim.secret}$'; then echo ${q('CASE read the environment of another process READABLE')}; else echo ${q('CASE read the environment of another process BLOCKED')}; fi`,
  );
  // The daemon runs git in this clone with its own environment, outside the sandbox: whatever a shell can plant in its config,
  // hooks or info (core.fsmonitor, a hook, a filter, a credential helper, another remote) runs there. None of it may be writable,
  // and the agent's own git work must still go through.
  const g = join(l.clone, '.git');
  const git = `git -C ${q(l.clone)} -c user.name=agent -c user.email=agent@example.invalid`;
  const evil = `printf '#!/bin/sh\\ntouch /tmp/pwned\\n'`;
  const guarded: Array<[string, string]> = [
    ['git config core.fsmonitor', `${git} config core.fsmonitor '/bin/true'`],
    ['git config a credential helper', `${git} config credential.helper '!evil'`],
    ['git config another remote', `${git} remote add evil https://example.invalid/x.git`],
    ['append to .git/config', `printf '[core]\\n\\tfsmonitor = /bin/true\\n' >> ${q(join(g, 'config'))}`],
    ['replace .git/config', `printf '[core]\\n' > ${q(join(g, 'config'))}`],
    ['delete .git/config', `rm -f ${q(join(g, 'config'))}`],
    ['write a hook', `${evil} > ${q(join(g, 'hooks', 'pre-push'))}`],
    ['change the installed hook', `${evil} > ${q(join(g, 'hooks', 'commit-msg'))}`],
    ['delete the hooks folder', `rm -rf ${q(join(g, 'hooks'))}`],
    ['replace the hooks folder by a link', `mv ${q(join(g, 'hooks'))} ${q(join(g, 'hooks-old'))} && ln -s ${q(join(l.runRoot, 'my-hooks'))} ${q(join(g, 'hooks'))}`],
    ['write .git/info/attributes', `echo '* filter=evil' > ${q(join(g, 'info', 'attributes'))}`],
    ['rename .git away', `mv ${q(g)} ${q(join(l.clone, '.git-old'))}`],
    ['rename the clone away', `mv ${q(l.clone)} ${q(join(l.runRoot, 'repo-old'))}`],
    ['delete .git', `rm -rf ${q(g)}`],
    ['point .git elsewhere', `rm -rf ${q(g)} && echo 'gitdir: ${l.runRoot}/elsewhere' > ${q(g)}`],
  ];
  // What an agent does with git every day, first: the attacks below include destroying the repository.
  const work: Array<[string, string]> = [
    ['git commit', `echo work > ${q(join(l.clone, 'work.txt'))} && ${git} add work.txt && ${git} commit -q -m work`],
    ['git branch', `${git} branch topic`],
    ['git switch -c', `${git} switch -q -c feature`],
    ['git stash', `echo more >> ${q(join(l.clone, 'work.txt'))} && ${git} stash -q`],
    ['git status and diff', `${git} status --porcelain && ${git} diff --stat`],
    ['git log', `${git} log --oneline`],
  ];
  for (const [name, cmd] of work) lines.push(`t ${q(`works: ${name}`)} ${q(cmd)}`);
  for (const [name, cmd] of guarded) lines.push(`t ${q(`guarded: ${name}`)} ${q(cmd)}`);
  // Another process of the same user could be signalled too (the daemon is one): the sandbox must not show it to a command.
  lines.push(`t ${q('signal another process of the same user')} ${q(`kill -0 ${servers.victim.pid}`)}`);
  // Network: the allowlist through the sandbox's proxy, and everything else.
  const code = `-sS -o /dev/null -w '%{http_code}' --max-time 8`;
  lines.push(`w ${q('net: an allowlisted host')} curl ${code} https://registry.npmjs.org/`);
  lines.push(`w ${q('net: a host off the list')} curl ${code} https://example.org/`);
  lines.push(`w ${q('net: a host off the list, plain http')} curl ${code} http://example.org/`);
  lines.push(`w ${q('net: an IP address, straight')} curl --noproxy '*' ${code} http://1.1.1.1/`);
  lines.push(`w ${q('net: an IP address, through the proxy')} curl ${code} http://1.1.1.1/`);
  lines.push(`w ${q('net: the host loopback, straight')} curl --noproxy '*' ${code} http://127.0.0.1:${servers.loopback.port}/`);
  lines.push(`w ${q('net: the host loopback, through the proxy')} curl ${code} http://127.0.0.1:${servers.loopback.port}/`);
  lines.push(`w ${q('net: localhost by name, through the proxy')} curl ${code} http://localhost:${servers.loopback.port}/`);
  lines.push(`w ${q('net: a raw TCP connection')} bash -c ${q('exec 3<>/dev/tcp/1.1.1.1/80')}`);
  lines.push(`w ${q('net: a Unix socket on the host')} sh -c ${q(`socat -u /dev/null UNIX-CONNECT:${servers.socket}`)}`);
  lines.push(`w ${q('net: a UDP DNS lookup')} sh -c ${q(`getent hosts example.org`)}`);
  void kind;
  return lines.join('\n');
}

export interface Proof {
  results: Map<string, string>;
  /** The clone's .git as it is on the host afterwards. */
  clone: { config: string; hooks: string[]; info: string[]; gitIsDir: boolean; hookBody: string };
  /** What the made-up machine looks like afterwards, checked on the host. */
  created: string[];
  bashrc: string;
  raw: string;
}

/**
 * Runs the proof in one kind of agent session: the real SDK, the real settings, the real binary. canUseTool allows
 * everything and no hook runs, so the only thing between a command and the machine is the sandbox.
 */
export async function runProof(
  kind: Kind,
  layout: Layout,
  servers: Servers,
  opts: {
    script?: string;
    extraEnv?: Record<string, string>;
    tmpdir?: string;
    /** One tool call instead of the script (Write, Edit, Read...). */
    tool?: { name: string; input: Record<string, unknown> };
    /** Other sandbox settings than a run's real ones, to try a change before making it. */
    sandbox?: NonNullable<Options['sandbox']>;
  } = {},
): Promise<Proof> {
  const script = opts.script ?? proofScript(layout, servers, kind);
  // A long script goes in a file of the run's temp folder: its quotes are quoted again at each level the sandbox wraps a
  // command in, and past 131071 bytes it is refused as too long for one argument.
  const scriptTmp = opts.tmpdir ?? join(layout.runRoot, '.tmp');
  let command = script;
  if (script.length > 8000) {
    mkdirSync(scriptTmp, { recursive: true });
    writeFileSync(join(scriptTmp, 'proof.sh'), script);
    command = `sh ${join(scriptTmp, 'proof.sh')}`;
  }
  const sub = subagentName('claude-haiku-5-5', 'low');
  let output = '';
  const reply = (req: ApiRequest): Reply => {
    const isAgent = req.tools.includes('Bash');
    if (!isAgent) return [{ type: 'text', text: 'ok' }];
    const isSub = req.system.includes('You are a sub-agent working for a ticket agent');
    const calls = toolCalls(req);
    const first = calls[0];
    if (first) {
      const result = toolResults(req).get(first.id);
      if (result !== undefined && (first.name === 'Bash' || first.name === opts.tool?.name)) output = result;
      return [{ type: 'text', text: isSub ? 'RESULT: success' : 'done' }];
    }
    if (kind === 'subagent' && !isSub) return [{ type: 'tool_use', name: 'Agent', input: { description: 'run the proof', prompt: 'Run the proof command.', subagent_type: sub, run_in_background: false } }];
    if (opts.tool) return [{ type: 'tool_use', name: opts.tool.name, input: opts.tool.input }];
    return [{ type: 'tool_use', name: 'Bash', input: { command, description: 'proof' } }];
  };
  const api = await fakeAnthropic(reply);
  // A hung run must not hang the suite.
  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), 90_000);
  try {
    const shared = kind === 'task' ? [] : [layout.ticketDir];
    const tmp = opts.tmpdir ?? join(layout.runRoot, '.tmp');
    for await (const m of query({
      prompt: 'Run the proof.',
      options: {
        abortController,
        cwd: layout.runRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: layout.home,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: 'test-key-not-real',
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...opts.extraEnv,
        },
        model: 'claude-haiku-5-5',
        tools: { type: 'preset', preset: 'claude_code' },
        agents: subagentDefinitions(['claude-haiku-5-5'], ['low']),
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        permissionMode: 'default',
        canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        sandbox: opts.sandbox ?? sandboxSettings(layout.runRoot, layout.protectedPaths, layout.home, shared, { cacheDir: layout.cache, gitDirs: [join(layout.clone, '.git')] }),
      },
    })) {
      // The turn is over; a sub-agent's command may still be running behind it, so wait for what it printed.
      if (m.type === 'result' && (kind !== 'subagent' || output !== '')) break;
    }
  } catch (error) {
    if (!abortController.signal.aborted) throw error;
  } finally {
    clearTimeout(deadline);
    await api.close();
  }
  const results = new Map<string, string>();
  for (const line of output.split('\n')) {
    const found = /^CASE (.+?) (READABLE|BLOCKED|RUNS|\d+(?: .*)?)$/.exec(line.trim());
    if (found) results.set(found[1]!, found[2]!);
  }
  const created = [...Object.values(layout.markers), layout.tmpMarker, join(layout.runRoot, 'escape', 'marker-symlink')].filter((p) => existsSync(p));
  const gitDir = join(layout.clone, '.git');
  const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const hook = join(gitDir, 'hooks', 'commit-msg');
  const cloneAfter = {
    config: existsSync(join(gitDir, 'config')) ? readFileSync(join(gitDir, 'config'), 'utf8') : '(gone)',
    hooks: list(join(gitDir, 'hooks')),
    info: list(join(gitDir, 'info')),
    // A directory still, not a file that points elsewhere. (rm -rf .git may take what is not protected, HEAD and the objects: the
    // agent's own repository, which is its to wreck.)
    gitIsDir: existsSync(gitDir) && statSync(gitDir).isDirectory(),
    hookBody: existsSync(hook) ? readFileSync(hook, 'utf8') : '(gone)',
  };
  return { results, clone: cloneAfter, created, bashrc: readFileSync(join(layout.home, '.bashrc'), 'utf8'), raw: output };
}
