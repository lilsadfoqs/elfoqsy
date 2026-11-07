// The shell gate's decision, as a pure function: canUseTool and the PreToolUse hook call decide for every tool call
// an agent makes. 'allow' runs it, 'deny' refuses it, and 'ask' goes to the orchestrator (a push of the run branch, which
// it does itself at once, or a file written outside the run folder, which is tier 2).
//
// the gate only knows the run folder; everything remote goes through the orchestrator's capability proxies
// (kube, aws, gh, jira, confluence, logs), which hold alex's credentials and apply the four tiers. So: edits,
// tests and commits in the run folder, and reads anywhere but credentials and protected paths, are free. Remote tools
// typed in the shell are refused with the proxy to use instead. Tier-3 forms are refused however they are written:
// force-push, pushing main or master or any branch but the run's, deleting a remote branch, anything that would change
// a kube context or AWS profile. Alex's credentials are off limits: gh's config, SSH keys, AWS and kube files, keyrings
// and git credential helpers.
//
// This reads commands, it does not sandbox them (the SDK sandbox does): it catches the plain forms of these actions and
// refuses forms it cannot read (command substitution, eval). Refusing is the safe failure.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { parseShell, type SimpleCommand } from './shell';

export type ApprovalKind = 'push' | 'pr' | 'github' | 'command' | 'jira_write' | 'outside_worktree' | 'network';

export type GateDecision =
  /** note: what the gate would have asked about, when the sandbox decides it instead (a shell command): logged. */
  | { behavior: 'allow'; note?: string }
  | { behavior: 'ask'; kind: ApprovalKind; action: string; reason: string }
  | { behavior: 'deny'; reason: string };

export interface GateContext {
  /** Absolute path of the run's git worktree. */
  worktree: string;
  /** The run's own branch, for example feature/SHOP-3546 (team rule). */
  branch: string;
  /** Hosts an agent may reach without asking. A host also covers its subdomains. */
  hosts: { jira: string[]; github: string[]; registry: string[] };
  /** The session's current directory when it is not the worktree root (the Bash tool keeps a cwd). */
  cwd?: string;
  /** Absolute paths no agent may touch, approval or not: Alex's own clones, the daemon's secrets and data. */
  protectedPaths?: string[];
  /** Extra rules for a whole simple command (words as typed, assignments included), e.g. the test scope. */
  commandPolicy?: (words: string[], cwd: string) => Finding | null;
  /** The agent's TMPDIR (TMP and TEMP name the same folder), as a real path: $TMPDIR in a command is read as it. */
  tmpDir?: string;
  /** alex's home: reading it outside the run folder (and the package caches) is asked; the rest of the disk is free. */
  home?: string;
  /** Folders outside the run folder that the run reads and writes as its own: the ticket folder (~/tickets/<KEY>). */
  shared?: string[];
}

export type Finding = { behavior: 'ask'; kind: ApprovalKind; reason: string } | { behavior: 'deny'; reason: string };

const PROTECTED_BRANCHES = new Set(['main', 'master']);
// When one command needs several approvals, Alex is asked about the most consequential one.
const ASK_ORDER: ApprovalKind[] = ['push', 'pr', 'github', 'jira_write', 'network', 'command', 'outside_worktree'];

const GITHUB_RULE = 'Agents never use gh or alex’s GitHub credentials. Use the gh tool: the orchestrator runs it, under the tier rules.';
// Where credentials live: gh's config, SSH keys, git's stored credentials, netrc, desktop keyrings.
const CREDENTIAL_PATHS = [
  /(^|[/~}])\.config\/gh(\/|$)/,
  /\$\{?GH_CONFIG_DIR\b/,
  /\$\{?XDG_CONFIG_HOME\}?\/gh(\/|$)/,
  /(^|[/~}])\.ssh(\/|$)/,
  /^(~|\$\{?HOME\}?)\/\.claude(\/|$)/, // Claude Code's login
  /(^|[/~}])\.aws(\/|$)/, // AWS profiles, keys and SSO tokens
  /(^|[/~}])\.kube(\/|$)/, // kube contexts and their credentials
  /(^|[/~}])\.docker\/config\.json$/,
  /(^|[/~}])\.config\/(gcloud|helm)(\/|$)/,
  /(^|[/~}])\.azure(\/|$)/,
  /(^|[/~}])\.claude\.json$/,
  /(^|[/~}])\.git-credentials$/,
  /(^|[/~}])\.netrc$/,
  /\.local\/share\/keyrings/,
  /Library\/Keychains/,
];
const KEYRING_TOOLS = new Set(['secret-tool', 'security', 'keyctl', 'kwallet-query', 'kwalletcli', 'gnome-keyring-daemon', 'gnome-keyring']);
const DBUS_TOOLS = new Set(['dbus-send', 'gdbus', 'busctl', 'qdbus']);
// Environment that would change how git or gh authenticate.
const AUTH_ENV = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GIT_SSH|GIT_SSH_COMMAND|SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG|GIT_CONFIG_[A-Z0-9_]*|KUBECONFIG|AWS_PROFILE|AWS_DEFAULT_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=/;

// ToolSearch only loads tool schemas; every tool it surfaces still comes through here.
const SAFE_TOOLS = new Set(['Task', 'Agent', 'TodoWrite', 'ToolSearch', 'BashOutput', 'KillShell', 'KillBash']);
const FILE_TOOLS: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'path',
  Grep: 'path',
  LS: 'path',
};
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DEVICE_PATHS = /^\/dev\/(null|stdin|stdout|stderr|fd\/\d+)$/;

export function decide(tool: string, input: Record<string, unknown>, ctx: GateContext): GateDecision {
  const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);

  if (SAFE_TOOLS.has(tool)) return { behavior: 'allow' };

  if (tool in FILE_TOOLS) {
    const pattern = tool === 'Glob' ? str('pattern') : undefined;
    const paths = [str(FILE_TOOLS[tool]!), pattern, pattern !== undefined ? globRoot(pattern) : undefined].filter(
      (p): p is string => p !== undefined,
    );
    // A search with no path starts from the session's current directory: that is the path it is judged on.
    if (['Grep', 'Glob', 'LS'].includes(tool) && str(FILE_TOOLS[tool]!) === undefined) paths.push('.');
    for (const p of paths) {
      const verdict = fileToolVerdict(tool, p, ctx);
      if (verdict) return verdict;
      // The file tools are not inside the sandbox, so they are judged on where the path really leads as well as on how it is
      // written: a link made in the run folder (the shell may make one) must not turn the run folder into his home.
      const real = realPathOf(p, ctx);
      if (real !== undefined && real !== lexicalPath(p, ctx)) {
        const behind = fileToolVerdict(tool, real, realContext(ctx), p);
        if (behind) return behind;
      }
    }
    return { behavior: 'allow' };
  }

  if (tool === 'WebFetch' || tool === 'WebSearch') {
    return { behavior: 'deny', reason: 'The web is checked by the run before a request leaves; this one was not.' };
  }

  if (tool === 'Bash') {
    // The sandbox is what bounds a shell command; a command that asks to run outside it never runs.
    if (input.dangerouslyDisableSandbox) return { behavior: 'deny', reason: 'A shell command always runs inside the sandbox; it cannot ask to leave it.' };
    const command = str('command') ?? '';
    return finalize(checkScript(command, ctx, { cwd: ctx.cwd ?? ctx.worktree, branch: ctx.branch }), command, true);
  }

  if (tool.startsWith('mcp__')) return finalize([checkMcp(tool)], tool);

  return { behavior: 'deny', reason: `${tool} is not a tool agents may use.` };
}

function ask(kind: ApprovalKind, action: string, reason: string): GateDecision {
  return { behavior: 'ask', kind, action, reason };
}

/**
 * sandboxed: the findings are a shell command's, which runs inside the SDK's sandbox. That
 * sandbox decides what it may read and write: the home unreadable but for what a run needs, writes only in the run folder,
 * the ticket folder and the shared caches. So a command that touches a path outside the run folder, or a shell variable that
 * could point there, is not asked about any more: it is allowed, with a note for the log of what the gate would have asked.
 * Every denial stays (credentials, his clones and the workspace's data, remote tools typed in the shell, pushes), and so does
 * every ask that is not about a path. The file tools are not inside the sandbox and never come here with this set.
 */
function finalize(findings: Array<Finding | null>, action: string, sandboxed = false): GateDecision {
  const real = findings.filter((f): f is Finding => f !== null);
  const deny = real.find((f) => f.behavior === 'deny');
  if (deny) return { behavior: 'deny', reason: deny.reason };
  let asks = real.filter((f): f is Extract<Finding, { behavior: 'ask' }> => f.behavior === 'ask');
  let note: string | undefined;
  if (sandboxed) {
    const paths = asks.filter((f) => f.kind === 'outside_worktree');
    if (paths.length) note = [...new Set(paths.map((f) => f.reason))].join(' ').slice(0, 400);
    asks = asks.filter((f) => f.kind !== 'outside_worktree');
  }
  if (!asks.length) return note ? { behavior: 'allow', note } : { behavior: 'allow' };
  asks.sort((a, b) => ASK_ORDER.indexOf(a.kind) - ASK_ORDER.indexOf(b.kind));
  const top = asks[0]!;
  return { behavior: 'ask', kind: top.kind, action, reason: top.reason };
}

// ---------------------------------------------------------------- shell

interface ShellState {
  cwd: string;
  branch: string; // the branch checked out, as far as this command line has changed it
  /** Variables this line has given a plain literal so far (NAME=/path), which the gate reads as the shell would. */
  vars?: Map<string, string>;
  /** Shell names this line (or the one that started it) may have changed: $TMPDIR and cd are not trusted then. */
  unreadable?: Set<string>;
  /** Inside a loop that may run any number of times: a cd with .. may climb as far. */
  loop?: boolean;
  /** pushd's folders, for popd. */
  dirs?: string[];
  /** The words of the current command whose `$` is quoted or escaped everywhere they appear: text, not a variable. */
  literalOnly?: Set<string>;
}

const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout', 'xargs', 'stdbuf']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const NETWORK_TOOLS = new Set(['nc', 'ncat', 'netcat', 'telnet', 'socat', 'ftp', 'gcloud', 'az', 'terraform']);
// Remote tools that have a proxy, or that must not run from an agent's shell, and what to do instead.
const PROXIED: Record<string, string> = {
  kubectl: 'kubectl runs only through the kube tool, which runs it with the run\'s own kubeconfig and --context on every call.',
  aws: 'aws runs only through the aws tool, with --profile on every call.',
  helm: 'helm is not available to agents; ask alex with ask_user if a chart has to change.',
  docker: 'docker runs only through the docker tool, which keeps containers off the host (no socket, no mounts outside the run folder, no privileged mode).',
  podman: 'podman is not available to agents; ask alex with ask_user.',
  minikube: 'minikube is alex\'s; use the kube tool with --context minikube to read or change what runs there.',
  'shop.sh': 'shop.sh runs only through the shop tool (build-integration-test), with the run\'s own kubeconfig and a fixed environment. Use the kube and aws tools for the rest.',
  'aws-vault': 'AWS credentials are alex\'s; use the aws tool.',
  eksctl: 'eksctl changes clusters and kube contexts; use the kube tool.',
  kubectx: 'kubectx would change the kube context; name the context on each kube tool call instead.',
  kubens: 'kubens would change the kube context; name the namespace on each kube tool call instead.',
};
const REMOTE_SHELLS = new Set(['ssh', 'scp', 'sftp', 'rsync']);
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'twine', 'gem']);
const PUBLISH_VERBS = new Set(['publish', 'unpublish', 'upload', 'deprecate', 'dist-tag', 'owner', 'login', 'adduser', 'push']);
// Commands whose first operand is a pattern or a program, not a file.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'jq', 'perl', 'git-grep']);
// Commands whose operands are text only.
const TEXT_ONLY = new Set(['echo', 'printf', 'test', '[', 'true', 'false', ':', 'export', 'set', 'unset', 'for', 'case']);
// Flags whose value is free text, never a path.
const TEXT_FLAGS = new Set(['-m', '--message', '--title', '--body', '--subject', '-e', '--regexp', '--expression', '--grep']);

function checkScript(script: string, ctx: GateContext, state: ShellState): Array<Finding | null> {
  const parsed = parseShell(script);
  if (!parsed.ok) {
    return [{ behavior: 'deny', reason: `The command uses ${parsed.reason}, which hides what would run. Run the parts separately.` }];
  }
  const commands = parsed.commands;
  const line = lineFacts(script, commands);
  // A shell started by this line (bash -c, a here-document) gets none of its variables and runs once per call, but what
  // the line changed in the environment (an export, a prefix assignment) still counts against trusting $TMPDIR or cd.
  const inner: ShellState = {
    cwd: state.cwd,
    branch: state.branch,
    vars: new Map(),
    unreadable: new Set([...(state.unreadable ?? []), ...line.unreadable]),
    dirs: [],
  };
  const findings: Array<Finding | null> = [];
  const subshells: string[] = []; // the folder each open subshell started in

  const step = (i: number): void => {
    const c = commands[i]!;
    const cwd = inner.cwd;
    findings.push(...checkCommand(c, ctx, inner));
    // A pipeline's parts and a background job run in subshells: a cd there does not move this shell.
    if (c.before === '|' || c.after === '|' || c.after === '&') inner.cwd = cwd;
    for (const [name, raw] of line.assignments.get(i) ?? []) {
      const value = expandKnown(raw, inner.vars);
      if (PLAIN_VALUE.test(value)) inner.vars!.set(name, value);
    }
  };

  const walk = (from: number, to: number): void => {
    for (let i = from; i < to; ) {
      for (const p of commands[i]!.parens) {
        if (p === '(') subshells.push(inner.cwd);
        else inner.cwd = subshells.pop() ?? inner.cwd; // a cd inside a subshell ends with it
      }
      const loop = line.loops.get(i);
      if (!loop) {
        step(i++);
        continue;
      }
      const unbounded = inner.loop;
      if (loop.kind === 'for') {
        step(i);
        const values = loopValues(loop, ctx, inner);
        if (!values || values.glob) inner.loop = true; // as many times as there are matches, or a list it cannot read
        if (!values) walk(i + 1, loop.end);
        else {
          // Each word in turn, as the shell runs them: a cd in one pass is where the next one starts.
          for (const value of values.list) {
            inner.vars!.set(loop.name!, value);
            walk(i + 1, loop.end);
          }
          inner.vars!.delete(loop.name!); // after the loop it holds the last word, or nothing: not read
        }
      } else {
        inner.loop = true; // while and until: the condition and the body, any number of times
        step(i);
        walk(i + 1, loop.end);
      }
      inner.loop = unbounded;
      i = loop.end;
    }
  };

  walk(0, commands.length);
  return findings;
}

// ---------------------------------------------------------------- variables
//
// alex's rules (after the probes): the gate reads a variable given a plain literal earlier in the same command
// (NAME=/path), a value built only from literals and variables it already reads (H=$P/.tmp/harness), and the variable
// of a loop over plain words (for r in a b). A relative glob in a loop list, used while the shell is inside the run
// folder, can only match files there, so it counts as plain too. Anything else (command substitution, ~, eval,
// export, any other expansion) still asks him, and so does a variable it cannot read used as an argument.

/** Names that change how the shell itself works or where it reads; never read as a plain variable. */
const SHELL_NAMES = new Set(['HOME', 'PWD', 'OLDPWD', 'CDPATH', 'IFS', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'ENV', 'BASH_ENV', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'PROMPT_COMMAND']);
/** Builtins that set variables, or run code that could: with any of them on the line, no variable is read. */
const VARIABLE_BUILTINS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'declare', 'typeset', 'local', 'readonly', 'unset', 'export', 'let', 'source', '.', 'printf', 'trap', 'builtin', 'enable', 'alias', 'shopt', 'function', 'select', 'eval']);
const COMPOUND_OPEN = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{']);
const COMPOUND_CLOSE = new Set(['fi', 'done', 'esac', '}']);
/** A value the shell keeps exactly as written: no expansion, no globbing, no splitting, no tilde. */
const PLAIN_VALUE = /^[A-Za-z0-9_./@%+,:=-]+$/;
/** A glob that can only match below the folder it runs in: no leading /, no .., no ~, nothing else expanded. */
const GLOB_VALUE = /^[A-Za-z0-9_./@%+,:=*?[\]-]+$/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PLAIN_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
/** Any expansion the shell would make of a `$`: a name, ${...}, a positional or special parameter. */
const UNREAD = /\$(?:\{|[A-Za-z0-9_@*#?$!-])/;

interface Loop {
  kind: 'for' | 'while';
  /** The index of its `done`. */
  end: number;
  /** A for loop the gate may read: its variable, set nowhere else on the line, and its words as typed. */
  name?: string;
  items?: string[];
}

interface LineFacts {
  /** The candidate NAME=value statements, by the index of their command; the value is read when the walk gets there. */
  assignments: Map<number, Array<[string, string]>>;
  /** The loops that start at each index. */
  loops: Map<number, Loop>;
  /** Shell names the line may change. */
  unreadable: Set<string>;
}

/** The compounds a command's leading keywords open and close: `do while x` opens one, `done` closes one. */
function keywords(words: string[]): { opens: string[]; closes: number; at: number } {
  const opens: string[] = [];
  let closes = 0;
  let at = 0;
  for (; at < words.length; at++) {
    const w = words[at]!;
    if (w === 'for' || w === 'select' || w === 'case') {
      opens.push(w); // a name or a word follows, not another keyword
      break;
    }
    if (!KEYWORDS.has(w)) break;
    if (COMPOUND_OPEN.has(w)) opens.push(w);
    if (COMPOUND_CLOSE.has(w)) closes++;
  }
  return { opens, closes, at };
}

/** The command a line of words runs, past keywords, assignments and wrappers. */
function programOf(words: string[]): string {
  let i = 0;
  while (i < words.length && (KEYWORDS.has(words[i]!) || ASSIGNMENT_WORD.test(words[i]!))) i++;
  while (i < words.length && WRAPPERS.has(words[i]!)) {
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || ASSIGNMENT_WORD.test(words[i]!) || /^\d/.test(words[i]!))) i++;
  }
  return posix.basename(words[i] ?? '');
}

/**
 * What the gate may read of a line's variables, before it walks it. A name is read only when its one mention on the
 * line, outside $NAME and ${NAME}, is either a NAME=value statement run unconditionally in this shell (at the top of
 * the line, not in a subshell, pipeline, background job, if, loop or brace group, and not after && or ||) or the
 * variable of a for loop. Nothing is read on a line that could set variables some other way.
 */
function lineFacts(script: string, commands: SimpleCommand[]): LineFacts {
  const mentions = new Map<string, number>();
  const mention = (text: string) => {
    for (const name of text.replace(REFERENCE, ' ').match(IDENTIFIER) ?? []) mentions.set(name, (mentions.get(name) ?? 0) + 1);
  };
  let blocked = /\(\(/.test(script); // arithmetic can assign: (( P = 1 ))
  for (const c of commands) {
    c.words.forEach(mention);
    c.redirects.forEach(mention);
    const program = programOf(c.words);
    if (VARIABLE_BUILTINS.has(program) || c.words.includes('function')) blocked = true;
    for (const w of [...c.words, ...c.redirects]) {
      // ${P:=x}, ${P=x}, ${!P} and the like: anything but the plain form may assign or indirect.
      if (/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(w)) blocked = true;
    }
  }
  const unreadable = new Set([...SHELL_NAMES].filter((n) => blocked || mentions.has(n)));
  if (unreadable.has('IFS')) blocked = true;
  const readable = (name: string) => !blocked && !SHELL_NAMES.has(name) && mentions.get(name) === 1;

  // The loops, whatever their words: their bodies run any number of times.
  const loops = new Map<number, Loop>();
  commands.forEach((c, i) => {
    const { opens, at } = keywords(c.words);
    const kind = opens.includes('for') ? 'for' : opens.includes('while') || opens.includes('until') ? 'while' : undefined;
    if (!kind) return;
    let depth = 1;
    let end = commands.length;
    for (let j = i + 1; j < commands.length; j++) {
      const k = keywords(commands[j]!.words);
      depth += k.opens.length - k.closes;
      if (depth <= 0) {
        end = j;
        break;
      }
    }
    const loop: Loop = { kind, end };
    if (kind === 'for') {
      const [name = '', inWord, ...items] = c.words.slice(at + 1);
      const literal = c.literalDollar.words.some((j) => j > at);
      if (inWord === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && readable(name) && !literal) Object.assign(loop, { name, items });
    }
    loops.set(i, loop);
  });

  const assignments = new Map<number, Array<[string, string]>>();
  let compound = 0;
  commands.forEach((c, i) => {
    const { opens, closes } = keywords(c.words);
    const inCompound = compound > 0 || opens.length > 0;
    compound = Math.max(0, compound + opens.length - closes);
    const standalone =
      !inCompound &&
      c.depth === 0 &&
      ['', ';', '\n'].includes(c.before) &&
      ['', ';', '\n', '&&', '||'].includes(c.after) &&
      !c.redirects.length &&
      !c.heredocs.length &&
      c.words.length > 0 &&
      c.words.every((w) => PLAIN_ASSIGNMENT.test(w));
    if (!standalone) return;
    const plain: Array<[string, string]> = [];
    for (const [j, w] of c.words.entries()) {
      const [, name = '', value = ''] = PLAIN_ASSIGNMENT.exec(w) ?? [];
      // Literals and $NAME or ${NAME} only; whether those are read is known when the walk gets here.
      if (!readable(name) || c.literalDollar.words.includes(j) || !PLAIN_VALUE.test(value.replace(REFERENCE, 'x'))) continue;
      plain.push([name, value]);
    }
    if (plain.length) assignments.set(i, plain);
  });
  return { assignments, loops, unreadable };
}

/** The words a for loop's variable takes, if the gate can read them all: plain words, or relative globs run inside the run folder. */
function loopValues(loop: Loop, ctx: GateContext, state: ShellState): { list: string[]; glob: boolean } | undefined {
  if (!loop.name || !loop.items) return undefined;
  const list: string[] = [];
  let glob = false;
  for (const item of loop.items) {
    const value = expandKnown(item, state.vars);
    if (PLAIN_VALUE.test(value)) list.push(value);
    else if (isRelativeGlob(value) && isUnder(ctx.worktree, state.cwd)) {
      list.push(value); // stands for any file it matches: a name below the folder the loop runs in
      glob = true;
    } else return undefined;
  }
  return { list, glob };
}

/** A glob that only matches below where it runs: no leading /, no .., and no part that could match . or .. itself. */
function isRelativeGlob(value: string): boolean {
  if (!GLOB_VALUE.test(value) || value.startsWith('/') || !/[*?[]/.test(value)) return false;
  return value.split('/').every((part) => part !== '..' && !(/[*?[]/.test(part) && /^[.[]/.test(part)));
}

/** A word as the shell would expand the variables read so far; others are left as typed. */
function expandKnown(word: string, vars: Map<string, string> | undefined): string {
  if (!vars?.size || !word.includes('$')) return word;
  return word.replace(REFERENCE, (ref, braced: string | undefined, bare: string | undefined) => vars.get(braced ?? bare ?? '') ?? ref);
}

/** Whether a word still holds an expansion the gate has not read ($HOME aside, which is his home). */
function hasUnread(word: string): boolean {
  return UNREAD.test(word.replace(/^\$\{?HOME\}?(?=\/|$)/, ''));
}

function checkCommand(command: SimpleCommand, ctx: GateContext, state: ShellState): Array<Finding | null> {
  const findings: Array<Finding | null> = [];
  // Plain variables are read as the shell would; a quoted or escaped `$` is left alone, as the shell leaves it.
  const words = command.words.map((w, j) => (command.literalDollar.words.includes(j) ? w : expandKnown(w, state.vars)));
  const redirects = command.redirects.map((r, j) => (command.literalDollar.redirects.includes(j) ? r : expandKnown(r, state.vars)));
  // A word typed both ways ('$X' and $X) counts as the expanded one.
  const typed = new Set([...words.filter((_, j) => !command.literalDollar.words.includes(j)), ...redirects.filter((_, j) => !command.literalDollar.redirects.includes(j))]);
  state.literalOnly = new Set([...command.literalDollar.words.map((j) => command.words[j]!), ...command.literalDollar.redirects.map((j) => command.redirects[j]!)].filter((w) => !typed.has(w)));
  if (ctx.commandPolicy) findings.push(ctx.commandPolicy(words.filter((w) => !KEYWORDS.has(w)), state.cwd));

  // Leading assignments and shell keywords: FOO=1 git push, if git push; then ...
  while (words.length && (KEYWORDS.has(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) {
    const w = words.shift()!;
    findings.push(checkAuthEnv(w));
    const value = w.includes('=') ? w.slice(w.indexOf('=') + 1) : '';
    if (value) findings.push(checkPathWord(value, ctx, state, { assignment: true })); // a value is not yet a path anything uses
  }
  // Wrappers that run another command: env, time, timeout 60 ..., xargs -n1 ...
  while (words.length && WRAPPERS.has(words[0]!)) {
    const wrapper = words.shift()!;
    while (words.length && (words[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || (wrapper === 'timeout' && /^\d/.test(words[0]!)))) {
      findings.push(checkAuthEnv(words.shift()!));
    }
  }

  for (const target of redirects) findings.push(checkPathWord(target, ctx, state));

  const [program = '', ...args] = words;
  const name = posix.basename(program);
  if (!name) return findings;
  const run = withTmp(program, ctx, state);
  if ((run === undefined || hasUnread(run)) && !state.literalOnly?.has(program)) {
    findings.push({ behavior: 'deny', reason: `${program} is a shell variable the workspace cannot read, which hides what would run. Name the command itself.` });
    return findings;
  }

  if (name === 'sudo' || name === 'doas' || name === 'su') {
    findings.push({ behavior: 'deny', reason: 'Agents never run commands as another user.' });
    return findings;
  }
  if (KEYRING_TOOLS.has(name) || (DBUS_TOOLS.has(name) && args.some((a) => /secret/i.test(a)))) {
    findings.push({ behavior: 'deny', reason: `${name} reads the keyring, where alex's credentials live.` });
    return findings;
  }
  if (name === 'export') {
    for (const a of args) findings.push(checkAuthEnv(a));
    return findings;
  }
  if (name === 'eval') {
    findings.push({ behavior: 'deny', reason: 'eval hides what would run. Run the command directly.' });
    return findings;
  }
  if (SHELLS.has(name)) {
    const c = args.indexOf('-c');
    // bash shop.sh ...: the script it runs is judged like the script run directly.
    const script = c < 0 ? args.find((a) => !a.startsWith('-')) : undefined;
    const proxiedScript = script !== undefined ? PROXIED[posix.basename(script)] : undefined;
    if (proxiedScript) {
      findings.push({ behavior: 'deny', reason: proxiedScript });
      return findings;
    }
    if (c >= 0) findings.push(...checkScript(args[c + 1] ?? '', ctx, { ...state }));
    for (const body of command.heredocs) findings.push(...checkScript(body, ctx, { ...state }));
    findings.push(...checkOperands(name, c >= 0 ? args.slice(0, c) : args, ctx, state));
    return findings;
  }

  const proxied = PROXIED[name];
  if (proxied) {
    findings.push({ behavior: 'deny', reason: proxied });
    return findings;
  }

  switch (name) {
    case 'cd':
    case 'pushd': {
      const word = args.find((a) => !a.startsWith('-'));
      const target = word === undefined ? undefined : withTmp(word, ctx, state);
      const credential = target ? credentialPath(target, ctx, state.cwd) : null;
      if (credential) findings.push(credential);
      else if (target && !target.startsWith('/') && state.unreadable?.has('CDPATH')) {
        findings.push({ behavior: 'ask', kind: 'outside_worktree', reason: `cd ${word} may go anywhere: this command sets CDPATH.` });
      } else if (!target || target === '-' || target.startsWith('~') || target.startsWith('$') || (hasUnread(target) && !state.literalOnly?.has(word!))) {
        findings.push(outside(`cd ${word ?? ''}`.trim()));
      } else if (state.loop && !target.startsWith('/') && target.split('/').includes('..')) {
        // Once per pass, any number of passes: from inside the run folder it can climb anywhere.
        findings.push({ behavior: 'ask', kind: 'outside_worktree', reason: `cd ${word} runs in a loop, so it may climb out of the run folder.` });
      } else {
        const next = posix.resolve(state.cwd, target);
        if (isPrivate(ctx, state.cwd, target)) findings.push(outside(shown(word!, target)));
        if (name === 'pushd') state.dirs?.push(state.cwd);
        state.cwd = next;
      }
      return findings;
    }
    case 'popd': {
      // Back to where this line's pushd left; a folder pushed before the line is not known.
      const back = state.dirs?.pop();
      if (back === undefined || state.loop) findings.push({ behavior: 'ask', kind: 'outside_worktree', reason: 'popd goes back to a folder this command did not name.' });
      else state.cwd = back;
      return findings;
    }
    case 'git':
      findings.push(...checkGit(args, ctx, state));
      return findings;
    case 'gh':
      findings.push({ behavior: 'deny', reason: GITHUB_RULE });
      return findings;
    case 'jira':
    case 'acli':
      findings.push({ behavior: 'deny', reason: 'Jira is reached only through the jira tool, under the tier rules.' });
      return findings;
  }

  if (HTTP_CLIENTS.has(name)) findings.push(checkHttp(name, args, ctx));
  else if (REMOTE_SHELLS.has(name)) findings.push(checkRemoteShell(name, args, ctx));
  else if (NETWORK_TOOLS.has(name)) findings.push({ behavior: 'ask', kind: 'network', reason: `${name} talks to hosts other than Jira, GitHub or the package registry.` });
  else if (PUBLISHERS.has(name) && args.some((a) => PUBLISH_VERBS.has(a))) {
    findings.push({ behavior: 'ask', kind: 'network', reason: `${name} would publish or change something on the registry.` });
  }
  for (const url of args.filter(isUrl)) {
    const host = hostOf(url);
    if (!HTTP_CLIENTS.has(name) && host && !isAllowedHost(host, ctx)) {
      findings.push({ behavior: 'ask', kind: 'network', reason: `Reaches ${host}, which is not Jira, GitHub or the package registry.` });
    }
  }
  findings.push(...checkOperands(name, args, ctx, state));
  return findings;
}

/** Path checks for a command's operands, skipping text that is clearly not a file. */
function checkOperands(name: string, args: string[], ctx: GateContext, state: ShellState): Array<Finding | null> {
  if (TEXT_ONLY.has(name)) return [];
  const findings: Array<Finding | null> = [];
  const hasExplicitPattern = args.some((a) => a === '-e' || a === '--regexp' || a === '--expression' || a === '-f');
  let skippedPattern = !PATTERN_FIRST.has(name) || hasExplicitPattern;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (TEXT_FLAGS.has(arg)) {
      i++; // its value is text
      continue;
    }
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      if (eq > 0 && !TEXT_FLAGS.has(arg.slice(0, eq))) findings.push(checkPathWord(arg.slice(eq + 1), ctx, state));
      continue;
    }
    if (!skippedPattern) {
      skippedPattern = true;
      continue;
    }
    findings.push(checkPathWord(arg, ctx, state));
  }
  return findings;
}

function checkPathWord(word: string, ctx: GateContext, state: ShellState, opts: { assignment?: boolean } = {}): Finding | null {
  if (!word || isUrl(word) || DEVICE_PATHS.test(word)) return null;
  const path = withTmp(word, ctx, state);
  if (path === undefined) return opts.assignment ? null : outside(word);
  const credential = credentialPath(path, ctx, state.cwd);
  if (credential) return credential;
  // The line changed HOME itself: ~ and $HOME are no longer known to be his home, or anywhere.
  if (state.unreadable?.has('HOME') && /^(~|\$\{?HOME\b)/.test(path)) return { behavior: 'ask', kind: 'outside_worktree', reason: `Touches ${word}: this command changes HOME, so where it points is not known.` };
  // A variable it cannot read, used as an argument, could be any path (a quoted or escaped `$` is text).
  if (!opts.assignment && hasUnread(path) && !state.literalOnly?.has(word)) return outside(word);
  const looksLikePath =
    path.startsWith('/') ||
    path.startsWith('~') ||
    /^\$\{?HOME\b/.test(path) ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('/../') ||
    path.endsWith('/..');
  if (!looksLikePath) return null;
  // The sandbox keeps writes in the run folder; here only alex's home is kept out of reads.
  return isPrivate(ctx, state.cwd, path) ? outside(shown(word, path)) : null;
}

const TMP_VAR = /^\$(?:\{(?:TMPDIR|TMP|TEMP)\}|(?:TMPDIR|TMP|TEMP)\b)/;

/**
 * A word with the agent's real TMPDIR put in for a leading $TMPDIR, $TMP or $TEMP (braces or not), so the
 * gate judges where it really points. Undefined when it names one of them and the TMPDIR is not known.
 */
function withTmp(word: string, ctx: GateContext, state: ShellState): string | undefined {
  const m = TMP_VAR.exec(word);
  if (!m) return word;
  // The line set it itself (TMPDIR=/home/... or read TMPDIR): it is no longer the run's temp folder.
  if (['TMPDIR', 'TMP', 'TEMP'].some((n) => state.unreadable?.has(n) && m[0].includes(n))) return undefined;
  return ctx.tmpDir === undefined ? undefined : ctx.tmpDir + word.slice(m[0].length);
}

/** A path as typed, and where it resolves when that is different. */
const shown = (word: string, path: string): string => (word === path ? word : `${word} (${path})`);

function credentialPath(path: string, ctx: GateContext, cwd: string): Finding | null {
  if (CREDENTIAL_PATHS.some((re) => re.test(path))) {
    return { behavior: 'deny', reason: `${path} is where alex's credentials live. Agents never read or change it.` };
  }
  const absolute = posix.resolve(cwd, path);
  if (ctx.protectedPaths?.some((p) => isUnder(p, absolute))) {
    return { behavior: 'deny', reason: `${path} is off limits to agents (alex's own clones or the workspace's data).` };
  }
  return null;
}

function checkAuthEnv(assignment: string): Finding | null {
  return AUTH_ENV.test(assignment)
    ? { behavior: 'deny', reason: `${assignment.split('=')[0]} would change how git or gh authenticate.` }
    : null;
}

function outside(path: string): Finding {
  // As typed (not "word (where it resolves)"), with an expansion the gate has not read: it could point anywhere.
  const typed = path.replace(/^cd /, '');
  const where = typed.includes(' (') || !hasUnread(typed)
    ? "in alex's home outside the run folder"
    : `${/^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(typed) ? 'a shell variable' : 'a path with a shell variable'} the workspace cannot read, so it may be outside the run folder`;
  return { behavior: 'ask', kind: 'outside_worktree', reason: `Touches ${path}, ${where}.` };
}

/**
 * In alex's home but outside the run folder and the package caches (~/.npm, ~/.cache): his own files, which an
 * agent reads only when he agrees. The rest of the disk (system paths, tools) is free to read.
 */
function isPrivate(ctx: GateContext, cwd: string, path: string): boolean {
  const home = ctx.home ?? homedir();
  const expanded = path.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (expanded.startsWith('~') || expanded.startsWith('$')) return true; // another user's home, or a variable it cannot read
  const absolute = posix.resolve(cwd, expanded);
  if (isUnder(ctx.worktree, absolute) || ctx.shared?.some((d) => isUnder(d, absolute))) return false;
  // A folder above the home reaches into it: a search from / or /home reads his files too.
  if (isUnder(absolute, home)) return true;
  if (!isUnder(home, absolute)) return false;
  return true; // his ~/.npm and ~/.cache too: agents have caches of their own now (the shared folder is in `shared`)
}

/** A glob's fixed start: the folder it searches from, before the first wildcard. */
const globRoot = (pattern: string): string => {
  const cut = pattern.search(/[*?[{]/);
  if (cut < 0) return pattern;
  const fixed = pattern.slice(0, cut);
  return fixed.endsWith('/') ? fixed.slice(0, -1) || '/' : posix.dirname(fixed) || '.';
};

/** One file tool's path, judged as written (or, with `shown`, as it really resolves: said as the path the agent gave). */
function fileToolVerdict(tool: string, p: string, ctx: GateContext, shown?: string): GateDecision | null {
  const cwd = ctx.cwd ?? ctx.worktree;
  const said = shown ?? p;
  const credential = credentialPath(p, ctx, cwd);
  if (credential) return { behavior: 'deny', reason: shown ? `${said} leads to ${p}. ${credential.reason}` : credential.reason };
  // A repository's .git is what the workspace's own git trusts: it runs git in the clone, outside the sandbox, so a hook or a config
  // key written there by hand would run with his access. The file tools are outside the sandbox that keeps a shell from it, so they
  // are refused here, whatever the run folder: git commands do what an agent needs.
  if (WRITE_TOOLS.has(tool)) {
    const absolute = lexicalPath(p, ctx);
    if (absolute !== undefined && /(^|\/)\.git(\/|$)/.test(absolute)) {
      return { behavior: 'deny', reason: `${shown ? `${said} leads to ${p}, ` : `${p} is `}inside a repository's .git folder: its hooks and config run when the workspace runs git, outside your sandbox. Use git commands, not the ${tool} tool, for anything in it.` };
    }
  }
  // Writing outside the run folder is asked (tier 2), and so is reading alex's home; other reads are free.
  if (WRITE_TOOLS.has(tool) && !isInside(ctx.worktree, cwd, p) && !inShared(ctx, cwd, p)) {
    return ask('outside_worktree', `${tool} ${said}`, `${tool} writes ${shown ? `${said}, which leads to ${p}` : p}, outside the run folder.`);
  }
  if (isPrivate(ctx, cwd, p)) return ask('outside_worktree', `${tool} ${said}`, `${tool} reads ${shown ? `${said}, which leads to ${p}` : p}, in alex's home outside the run folder.`);
  return null;
}

/** The absolute path a file tool's argument names, with ~ and $HOME read as his home; undefined when it names a variable. */
function lexicalPath(p: string, ctx: GateContext): string | undefined {
  const home = ctx.home ?? homedir();
  const expanded = p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (expanded.startsWith('~') || expanded.startsWith('$')) return undefined;
  return posix.resolve(ctx.cwd ?? ctx.worktree, expanded);
}

/** Where a path leads once every link in it is followed, also when the file is not there yet or the link dangles. */
function realTarget(absolute: string, depth = 0): string {
  if (depth > 32) return absolute;
  const rest: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return posix.join(realpathSync(existing), ...rest.reverse());
    } catch {
      try {
        // A link whose target is not there: writing through it creates the target, wherever it is.
        if (lstatSync(existing).isSymbolicLink()) return realTarget(posix.join(posix.resolve(posix.dirname(existing), readlinkSync(existing)), ...rest.reverse()), depth + 1);
      } catch {
        // not there at all: look at its parent
      }
      const parent = posix.dirname(existing);
      if (parent === existing) return absolute;
      rest.push(posix.basename(existing));
      existing = parent;
    }
  }
}

function realPathOf(p: string, ctx: GateContext): string | undefined {
  const lexical = lexicalPath(p, ctx);
  return lexical === undefined ? undefined : realTarget(lexical);
}

/** The same rules for a path that has been followed to where it really is: the run folder, his home and the rest as they really are. */
function realContext(ctx: GateContext): GateContext {
  const home = ctx.home ?? homedir();
  return {
    ...ctx,
    worktree: realTarget(ctx.worktree),
    home: realTarget(home),
    ...(ctx.shared ? { shared: ctx.shared.map((d) => realTarget(d)) } : {}),
    ...(ctx.protectedPaths ? { protectedPaths: [...new Set([...ctx.protectedPaths, ...ctx.protectedPaths.map((d) => realTarget(d))])] } : {}),
  };
}

// ---------------------------------------------------------------- git and GitHub

function checkGit(args: string[], ctx: GateContext, state: ShellState): Array<Finding | null> {
  const findings: Array<Finding | null> = [];
  let i = 0;
  // Global options before the subcommand.
  while (i < args.length && args[i]!.startsWith('-')) {
    const opt = args[i]!;
    if (opt === '-C') {
      const word = args[i + 1] ?? '';
      const dir = withTmp(word, ctx, state);
      findings.push(dir === undefined || (hasUnread(dir) && !state.literalOnly?.has(word)) ? outside(word) : credentialPath(dir, ctx, state.cwd) ?? (isPrivate(ctx, state.cwd, dir) ? outside(shown(word, dir)) : null));
      i += 2;
    } else if (opt === '-c') {
      if (/^(credential\.|core\.sshcommand|core\.askpass)/i.test(args[i + 1] ?? '')) {
        findings.push({ behavior: 'deny', reason: 'Agents never change how git authenticates.' });
      }
      i += 2;
    }
    else if (opt.startsWith('--git-dir=') || opt.startsWith('--work-tree=')) {
      const word = opt.slice(opt.indexOf('=') + 1);
      const p = withTmp(word, ctx, state);
      findings.push(p === undefined || (hasUnread(p) && !state.literalOnly?.has(word)) ? outside(word) : credentialPath(p, ctx, state.cwd) ?? (isPrivate(ctx, state.cwd, p) ? outside(shown(word, p)) : null));
      i++;
    } else i++;
  }
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);

  switch (sub) {
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      findings.push({ behavior: 'deny', reason: 'git credential would hand out alex’s stored credentials.' });
      break;
    case 'push':
      findings.push(checkPush(rest, state, ctx));
      break;
    case 'checkout':
    case 'switch': {
      const create = rest.findIndex((a) => a === '-b' || a === '-B' || a === '-c' || a === '-C');
      if (create >= 0 && rest[create + 1]) state.branch = rest[create + 1]!;
      else if (!rest.includes('--')) {
        const target = rest.find((a) => !a.startsWith('-'));
        if (target) state.branch = target;
      }
      break;
    }
    case 'config':
      if (rest.some((a) => /^(credential\.|core\.sshcommand|core\.askpass|url\.)/i.test(a))) {
        findings.push({ behavior: 'deny', reason: 'Agents never change how git authenticates.' });
      } else if (rest.some((a) => a === '--global' || a === '--system')) findings.push(outside('git config outside the repository'));
      break;
    case 'clone':
    case 'remote':
    case 'fetch':
    case 'pull':
    case 'ls-remote':
    case 'submodule':
      for (const url of rest.filter(isUrl)) {
        const host = hostOf(url);
        if (host && !isAllowedHost(host, ctx)) {
          findings.push({ behavior: 'ask', kind: 'network', reason: `Reaches ${host}, which is not GitHub.` });
        }
      }
      break;
    case 'send-email':
      findings.push({ behavior: 'ask', kind: 'network', reason: 'Sends email.' });
      break;
  }
  findings.push(...checkOperands(`git-${sub}`, rest, ctx, state));
  return findings;
}

/**
 * A push: the run branch goes to the orchestrator, which pushes it at once (tier 1). Everything else about pushing is
 * tier 3, refused however it is written: force, deleting or renaming a remote branch, main or master, any other branch,
 * tags, every branch at once.
 */
function checkPush(args: string[], state: ShellState, ctx: GateContext): Finding {
  const never = (reason: string): Finding => ({ behavior: 'deny', reason: `${reason} That is alex's to do.` });
  if (args.some((a) => a === '--all' || a === '--mirror' || a === '--branches' || a === '--tags' || a === '--follow-tags')) {
    return never('Pushing every branch or tags at once could push main or master or rewrite what is there.');
  }
  if (args.some((a) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|-d|--delete|--prune)$/.test(a) || /^-[a-z]*f[a-z]*$/.test(a))) {
    return never('Force-pushing, deleting or pruning remote branches is never done by an agent.');
  }
  const valueFlags = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) i++;
    else if (!a.startsWith('-')) positional.push(a);
  }
  const refspecs = positional.slice(1); // the first operand is the remote
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return never('A + refspec force-pushes.');
    if (spec.startsWith(':')) return never('An empty source deletes the remote branch.');
  }
  const destinations = refspecs.length
    ? refspecs.map((spec) => {
        const colon = spec.indexOf(':');
        const dst = colon >= 0 ? spec.slice(colon + 1) : spec;
        return dst === 'HEAD' || dst === '@' ? state.branch : dst.replace(/^refs\/heads\//, '');
      })
    : [state.branch];
  const blocked = destinations.find((d) => PROTECTED_BRANCHES.has(d));
  if (blocked) return never(`Never push to ${blocked}, even with approval.`);
  const other = destinations.find((d) => d !== ctx.branch);
  if (other) return never(`Only the run branch, ${ctx.branch}, is pushed; ${other} is another branch (pushing it under another name would rename it).`);
  return { behavior: 'ask', kind: 'push', reason: `Pushes ${ctx.branch}.` };
}

/** HTTP method of a curl-like call: explicit -X/--method, or POST when a body is given. */
function methodOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-X' || a === '--method' || a === '--request') return (args[i + 1] ?? 'GET').toUpperCase();
    if (/^(--method|--request)=/.test(a)) return a.slice(a.indexOf('=') + 1).toUpperCase();
    if (/^-X[A-Za-z]+$/.test(a)) return a.slice(2).toUpperCase();
  }
  const bodyFlags = /^(-d|--data.*|-F|--form.*|--json|-T|--upload-file|-f|--field|--raw-field|--input|--post-data|--post-file)$/;
  return args.some((a) => bodyFlags.test(a.split('=')[0]!)) ? 'POST' : 'GET';
}

function checkHttp(name: string, args: string[], ctx: GateContext): Finding | null {
  // httpie and xh take the method as a bare word: http POST example.com
  const bareMethod = args.find((a) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(a));
  const method = bareMethod ?? methodOf(args);
  const targets = args.filter((a) => isUrl(a) || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(a));
  for (const target of targets) {
    const host = hostOf(isUrl(target) ? target : `https://${target}`);
    if (!host) continue;
    if (!isAllowedHost(host, ctx)) {
      return { behavior: 'ask', kind: 'network', reason: `${name} reaches ${host}, which is not Jira, GitHub or the package registry.` };
    }
    if (method === 'GET' || method === 'HEAD') continue;
    if (matchesHost(host, ctx.hosts.jira)) return { behavior: 'deny', reason: `${method} to Jira: Jira is written only through the jira tool, under the tier rules.` };
    if (matchesHost(host, ctx.hosts.github)) return { behavior: 'deny', reason: GITHUB_RULE };
    return { behavior: 'ask', kind: 'network', reason: `${method} writes to the package registry.` };
  }
  return null;
}

/** ssh, scp, sftp and rsync: never to GitHub (that would use Alex's SSH key); elsewhere, ask. */
function checkRemoteShell(name: string, args: string[], ctx: GateContext): Finding | null {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    // user@host:path or host:path for all of them; a bare user@host or host for ssh.
    const host = /^(?:[^@\s/]+@)?([^:\s/]+):/.exec(a)?.[1] ?? (name === 'ssh' ? /^(?:[^@\s]+@)?([^:\s/]+)$/.exec(a)?.[1] : undefined);
    if (!host) continue;
    if (matchesHost(host, ctx.hosts.github)) return { behavior: 'deny', reason: GITHUB_RULE };
    return { behavior: 'ask', kind: 'network', reason: `${name} reaches ${host}, which is not Jira, GitHub or the package registry.` };
  }
  return null;
}

// ---------------------------------------------------------------- MCP tools

function checkMcp(tool: string): Finding | null {
  const [, server = ''] = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool) ?? [];
  if (/jira|atlassian|confluence/i.test(server)) return { behavior: 'deny', reason: 'Jira and Confluence are reached only through the jira and confluence tools, under the tier rules.' };
  if (/github/i.test(server)) return { behavior: 'deny', reason: GITHUB_RULE };
  return { behavior: 'deny', reason: `${tool} is not a tool agents may use.` };
}

// ---------------------------------------------------------------- paths and hosts

function isUnder(root: string, path: string): boolean {
  const rel = posix.relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}

/** Inside one of the run's shared folders (the ticket folder), with ~ and $HOME read as his home. */
function inShared(ctx: GateContext, cwd: string, path: string): boolean {
  if (!ctx.shared?.length || !path) return false;
  const home = ctx.home ?? homedir();
  const expanded = path.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (expanded.startsWith('~') || expanded.startsWith('$')) return false;
  const absolute = posix.resolve(cwd, expanded);
  return ctx.shared.some((d) => isUnder(d, absolute));
}

function isInside(worktree: string, cwd: string, path: string): boolean {
  if (!path) return true;
  if (path.startsWith('~') || /^\$\{?HOME\b/.test(path)) return false;
  return isUnder(worktree, posix.resolve(cwd, path));
}

function isUrl(word: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(word);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function matchesHost(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function isAllowedHost(host: string, ctx: GateContext): boolean {
  return matchesHost(host, [...ctx.hosts.jira, ...ctx.hosts.github, ...ctx.hosts.registry]);
}
