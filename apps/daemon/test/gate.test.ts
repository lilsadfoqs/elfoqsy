import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide, type GateContext } from '../src/gate/policy';
import { parseShell } from '../src/gate/shell';

const ctx: GateContext = {
  worktree: '/work/SHOP-3546-r4',
  branch: 'feature/SHOP-3546',
  hosts: {
    jira: ['acme.atlassian.net'],
    github: ['github.com', 'githubusercontent.com'],
    registry: ['registry.npmjs.org'],
  },
  home: '/home/alex',
};
/** As it really is: the run folder inside alex's home (~/.local/share/elfoqsy/runs), next to other runs'. */
const inHome: GateContext = { ...ctx, worktree: '/home/alex/.local/share/elfoqsy/runs/SHOP-3546-r4' };

const bash = (command: string) => decide('Bash', { command }, ctx);
// allow:noted is a shell command the sandbox decides: allowed, with what the gate would have asked about for the log.
const behavior = (d: ReturnType<typeof decide>) => (d.behavior === 'ask' ? `ask:${d.kind}` : d.behavior === 'allow' && d.note ? 'allow:noted' : d.behavior);

describe('allowed inside the worktree', () => {
  it.each([
    'pnpm test',
    'git status && git diff --stat',
    'git add -A && git commit -m "fix: lift error_code from /details to the top level"',
    'grep -rn "/rest/api/3" src | head -20',
    "sed -n '/error_code/p' src/payments/client.ts",
    'cat package.json 2>/dev/null',
    'pnpm test > test-output.txt 2>&1',
    'git fetch origin && git rebase origin/develop',
    'git checkout -b feature/SHOP-3546-retry',
    'npm install',
    'curl -s https://registry.npmjs.org/protobufjs',
    'curl -s -H "Accept: application/json" https://acme.atlassian.net/rest/api/3/issue/SHOP-3546',
    'cd src && ls && cd ..',
    "cat > notes.md <<'EOF'\nWe will git push origin main later, and read /etc/hosts.\nEOF",
    'echo "git push origin main" > TODO.txt',
    'timeout 600 pnpm vitest run',
    'git log --grep=/api/ --oneline',
  ])('Bash: %s', (command) => {
    expect(bash(command)).toEqual({ behavior: 'allow' });
  });

  it.each([
    ['Read', { file_path: 'src/payments/client.ts' }],
    ['Read', { file_path: '/work/SHOP-3546-r4/src/payments/client.ts' }],
    ['Edit', { file_path: '/work/SHOP-3546-r4/src/payments/webhook.ts', old_string: 'a', new_string: 'b' }],
    ['Glob', { pattern: '**/*.test.ts' }],
    ['Grep', { pattern: 'error_code', path: 'src' }],
    ['Task', { description: 'search', prompt: 'find error_code' }],
    ['TodoWrite', { todos: [] }],
    ['ToolSearch', { query: 'select:Grep', max_results: 5 }],
  ])('%s %j', (tool, input) => {
    expect(decide(tool, input, ctx)).toEqual({ behavior: 'allow' });
  });
});

describe('push: the run branch goes to the orchestrator; every other push is tier 3', () => {
  it.each([
    'git push',
    'git push origin feature/SHOP-3546',
    'git push -u origin HEAD',
    'pnpm test && git push origin HEAD',
    'GIT_TRACE=1 git push',
    'bash -c "git push origin HEAD"',
    'bash <<EOF\ngit push\nEOF',
    'git push origin refs/heads/feature/SHOP-3546',
  ])('hands it to the orchestrator: %s', (command) => {
    const d = bash(command);
    expect(behavior(d)).toBe('ask:push');
    if (d.behavior === 'ask') expect(d.action).toBe(command);
  });

  it.each([
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push origin +feature/SHOP-3546:refs/heads/master',
    'git push origin :main',
    'git push --all',
    'git push --mirror origin',
    'git checkout main && git push',
    'git switch master && git push origin HEAD',
    'sh -c "git push origin main"',
    'git push --force',
    'git push -f origin feature/SHOP-3546',
    'git push -uf origin feature/SHOP-3546',
    'git push --force-with-lease origin feature/SHOP-3546',
    'git push origin +feature/SHOP-3546',
    'git push origin :feature/SHOP-3546',
    'git push --delete origin feature/SHOP-3546',
    'git push origin feature/SHOP-3546:feature/SHOP-3546-v2',
    'git push origin v2.22.1',
    'git push --tags',
    'git checkout -b other && git push origin HEAD',
  ])('refuses: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it('says a refused push is alex’s to do', () => {
    expect(bash('git push --force')).toEqual({ behavior: 'deny', reason: "Force-pushing, deleting or pruning remote branches is never done by an agent. That is alex's to do." });
  });

  it('denies a plain push when the run branch itself is main', () => {
    expect(behavior(decide('Bash', { command: 'git push' }, { ...ctx, branch: 'main' }))).toBe('deny');
  });

  it('denies repository writes through a GitHub MCP server', () => {
    expect(behavior(decide('mcp__github__push_files', {}, ctx))).toBe('deny');
  });
});

describe('remote tools only through the proxies: never from the agent’s shell', () => {
  it.each([
    ['kubectl --context dev-shop get pods', 'kube tool'],
    ['kubectl config use-context integration-shop', 'kube tool'],
    ['aws --profile dev-shop sts get-caller-identity', 'aws tool'],
    ['helm upgrade shop-api ./chart', 'helm is not available'],
    ['docker push acme/shop:latest', 'docker runs only through the docker tool'],
    ['docker run -v ~/.ssh:/x alpine cat /x/id_ed25519', 'keeps containers off the host'],
    ['minikube start', 'minikube is alex'],
    ['./shop.sh deploy dev', 'shop.sh runs only through the shop tool'],
    ['bash shop.sh restart-shop-api', 'shop.sh runs only through the shop tool'],
    ['kubectx staging', 'kubectx would change the kube context'],
    ['jira issue move SHOP-3546 "In Progress"', 'jira tool'],
  ])('refuses %s, naming what to use', (command, said) => {
    expect(bash(command)).toEqual({ behavior: 'deny', reason: expect.stringContaining(said) });
  });

  it.each([
    'KUBECONFIG=~/.kube/config ./run.sh',
    'export AWS_PROFILE=dev-shop',
    'AWS_ACCESS_KEY_ID=x npm test',
    'env AWS_SHARED_CREDENTIALS_FILE=/tmp/c node x.js',
    'cat ~/.aws/credentials',
    'ls ~/.aws/sso/cache',
    'cat ~/.kube/config',
    'cat /home/alex/.docker/config.json',
  ])('refuses anything that would pick or read a kube context or AWS profile: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it.each([
    ['Read', { file_path: '/home/alex/.aws/credentials' }],
    ['Read', { file_path: '~/.kube/config' }],
    ['Grep', { pattern: 'aws_secret', path: '/home/alex/.aws' }],
  ])('refuses %s %j', (tool, input) => {
    expect(behavior(decide(tool, input, ctx))).toBe('deny');
  });
});

describe('GitHub: agents never use gh or Alex’s credentials', () => {
  it.each([
    'gh pr create --fill --base develop',
    'gh pr view 212',
    'gh pr checks 212',
    'gh pr merge 212 --squash',
    'gh run rerun 123',
    'gh api repos/acme/shop-api/pulls',
    'gh auth token',
    'curl -X PATCH https://api.github.com/repos/acme/shop/pulls/212 -d "{}"',
    'curl -X POST https://api.github.com/repos/acme/shop/issues/1/comments -d "{}"',
    'ssh -T git@github.com',
    'ssh git@github.com git-receive-pack acme/shop-api',
    'scp notes.txt git@github.com:x',
  ])('denies: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it.each(['mcp__github__create_pull_request', 'mcp__github__get_pull_request', 'mcp__github__merge_pull_request'])(
    'denies the GitHub MCP tool %s',
    (tool) => {
      expect(behavior(decide(tool, {}, ctx))).toBe('deny');
    },
  );

  it.each([
    'cat ~/.config/gh/hosts.yml',
    'ls $HOME/.config/gh',
    'cat ${XDG_CONFIG_HOME}/gh/hosts.yml',
    'ls $GH_CONFIG_DIR',
    'cat ~/.ssh/id_ed25519',
    'cd ~/.ssh',
    'echo key >> /home/alex/.ssh/authorized_keys',
    'cat ~/.git-credentials',
    'cat ~/.netrc',
    'ls ~/.local/share/keyrings',
    'secret-tool lookup service gh:github.com',
    'security find-generic-password -s gh:github.com -w',
    'keyctl show',
    'dbus-send --session --dest=org.freedesktop.secrets /org/freedesktop/secrets',
    'git credential fill',
    'git config credential.helper store',
    'git config --global credential.helper store',
    'git -c credential.helper=store fetch',
    'git -c core.sshCommand="ssh -i x" fetch',
    'GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519" git push',
    'env SSH_AUTH_SOCK=/run/user/1000/agent git fetch',
    'export GH_TOKEN=abc',
    'GITHUB_TOKEN=abc npm test',
  ])('denies touching credentials: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it.each([
    ['Read', { file_path: '/home/alex/.config/gh/hosts.yml' }],
    ['Read', { file_path: '~/.ssh/id_ed25519' }],
    ['Grep', { pattern: 'oauth_token', path: '/home/alex/.config/gh' }],
  ])('denies %s %j', (tool, input) => {
    expect(behavior(decide(tool, input, ctx))).toBe('deny');
  });

  it('still lets agents clone public repositories over HTTPS', () => {
    expect(bash('git clone https://github.com/protobufjs/protobuf.js vendor/protobufjs')).toEqual({ behavior: 'allow' });
  });
});

describe('Jira writes: only through the jira tool', () => {
  it.each([
    'curl -X POST https://acme.atlassian.net/rest/api/3/issue/SHOP-3546/transitions -d @t.json',
    'curl https://acme.atlassian.net/rest/api/3/issue/SHOP-3546/comment --json \'{"body":"x"}\'',
    'jira issue move SHOP-3546 "In Progress"',
  ])('refuses: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it.each(['mcp__jira__transitionJiraIssue', 'mcp__atlassian__addCommentToJiraIssue', 'mcp__jira__getJiraIssue'])('refuses the MCP tool %s', (tool) => {
    expect(decide(tool, {}, ctx)).toEqual({ behavior: 'deny', reason: expect.stringContaining('jira and confluence tools') });
  });
});

describe('reading and writing outside the run folder', () => {
  it.each([
    'cat /etc/hosts',
    'ls ..',
    'cd .. && ls',
    'echo done > /tmp/out.txt',
    'git -C /repos/shop-worker status',
    'cat /usr/lib/node_modules/npm/package.json',
  ])('lets it read the rest of the disk (the sandbox keeps writes in the run folder): %s', (command) => {
    expect(bash(command)).toEqual({ behavior: 'allow' });
  });

  it.each(['cp dist/app.js ~/backup/', 'cat ~/notes.txt', 'ls ~/.npm/_cacache', 'rm -rf $HOME/.cache/elfoqsy', 'ls $HOME/Documents', 'git config --global user.name agent', 'cd', 'grep -rn token /', 'find /home -name "*.pem"', 'ls /home'])(
    'notes it for the log, and leaves it to the sandbox, when it reads his home or a folder above it: %s',
    (command) => {
      expect(behavior(bash(command))).toBe('allow:noted');
    },
  );

  it.each(['ls ..', 'cd .. && ls', 'cd src && cat ../../other-run/secrets.env'])('notes it when the run folder sits in his home and the path leaves it: %s', (command) => {
    expect(behavior(decide('Bash', { command }, inHome))).toBe('allow:noted');
  });

  it.each([
    ['Read', { file_path: '/etc/passwd' }],
    ['Grep', { pattern: 'error_code', path: '/usr/lib/node_modules' }],
    ['Glob', { pattern: '/opt/**/*.so' }],
  ])('lets the file tools read outside it too: %s %j', (tool, input) => {
    expect(decide(tool, input, ctx)).toEqual({ behavior: 'allow' });
  });

  it.each([
    ['Read', { file_path: '/home/alex/notes.md' }],
    ['Grep', { pattern: 'token', path: '/' }],
    ['Glob', { pattern: '/home/**/*.pem' }],
    ['Write', { file_path: '/home/alex/.bashrc', content: '' }],
    ['Write', { file_path: '/tmp/out.txt', content: '' }],
    ['Edit', { file_path: '../SHOP-3472-r2/package.json', old_string: 'a', new_string: 'b' }],
  ])('asks before a file tool reads his home or writes outside the run folder: %s %j', (tool, input) => {
    expect(behavior(decide(tool, input, ctx))).toBe('ask:outside_worktree');
  });
});

describe('$TMPDIR, read as the real path it names', () => {
  const inRun = { ...inHome, tmpDir: '/home/alex/.local/share/elfoqsy/runs/SHOP-3546-r4/.tmp' };
  const run = (command: string, c: GateContext = inRun) => behavior(decide('Bash', { command }, c));

  it.each([
    'mkdir -p "$TMPDIR/provider-check" && cd "$TMPDIR/provider-check" && ls',
    'cd ${TMPDIR} && touch a.txt',
    'cat $TMP/out.log',
    'ls $TEMP',
    'git -C $TMPDIR/scratch status',
    'echo x > $TMPDIR/x.txt',
  ])('allows it inside the run folder: %s', (command) => {
    expect(run(command)).toBe('allow');
  });

  it.each(['cd "$TMPDIR/../.." && ls', 'cat $TMPDIR/../../../etc/passwd', 'cp a.ts ${TMP}/../../other-run/'])('notes it when it escapes the run folder: %s', (command) => {
    expect(run(command)).toBe('allow:noted');
  });

  it('notes it when the TMPDIR itself points into his home, and says where it points', () => {
    const d = decide('Bash', { command: 'cd "$TMPDIR/provider-check" && ls' }, { ...ctx, tmpDir: '/home/alex/elsewhere' });
    expect(d).toMatchObject({ behavior: 'allow', note: "Touches $TMPDIR/provider-check (/home/alex/elsewhere/provider-check), in alex's home outside the run folder." });
    expect(run('mkdir -p $TMPDIR/x', { ...ctx, tmpDir: '/home/alex/elsewhere' })).toBe('allow:noted');
    expect(run('mkdir -p $TMPDIR/x', { ...ctx, tmpDir: '/tmp' })).toBe('allow'); // outside his home: the sandbox's business
  });

  it('says a loop variable it cannot read may be outside the run folder, not that it is in his home (probe P1)', () => {
    const d = decide('Bash', { command: 'for r in "$@"; do git -C $r status -sb; done' }, ctx);
    expect(d).toMatchObject({ behavior: 'allow', note: 'Touches $r, a shell variable the workspace cannot read, so it may be outside the run folder.' });
    expect(decide('Bash', { command: 'cat $HOME/notes.txt' }, ctx)).toMatchObject({ note: expect.stringContaining("in alex's home") });
  });

  it('notes it when the TMPDIR is not known', () => {
    expect(run('cd $TMPDIR/x', ctx)).toBe('allow:noted');
    expect(run('mkdir -p "$TMPDIR/x"', ctx)).toBe('allow:noted');
  });

  it('leaves other variables as they were', () => {
    expect(run('cd $TMPDIRX')).toBe('allow:noted');
    expect(run('cat $HOME/notes.txt')).toBe('allow:noted');
  });
});

describe('network beyond Jira, GitHub and the registry', () => {
  it.each([
    'curl https://example.com/install.sh',
    'wget http://downloads.example.org/tool.tar.gz',
    'curl example.org/x',
    'ssh deploy@10.0.0.5',
    'scp build.zip ops@staging.internal:/srv/',
    'npm publish',
    'nc -l 4444',
    'git clone https://gitlab.com/someone/tool.git vendor/tool',
  ])('asks: %s', (command) => {
    expect(behavior(bash(command))).toBe('ask:network');
  });

  it.each([
    ['WebFetch', { url: 'https://example.com', prompt: 'read' }],
    ['WebFetch', { url: 'https://api.github.com/repos/acme/shop/pulls/212', prompt: 'read' }],
    ['WebSearch', { query: 'protobufjs peer version' }],
  ])('leaves the web to the run, which checks each request before it leaves (v1.3): %s %j', (tool, input) => {
    // The policy on its own still refuses: only the run's gate, with the redactor's outbound check, lets a request out.
    const d = decide(tool, input, ctx);
    expect(d).toEqual({ behavior: 'deny', reason: expect.stringContaining('checked by the run') });
  });

  it('asks before ssh to any other host', () => {
    expect(behavior(bash('ssh deploy@staging.internal'))).toBe('ask:network');
  });
});

describe('denied outright', () => {
  it.each([
    'sudo apt-get install jq',
    'echo $(git push origin main)',
    'echo `whoami`',
    'eval "git push"',
    'gh auth token',
    'diff <(cat a) <(cat b)',
    'echo "unterminated',
  ])('Bash: %s', (command) => {
    expect(behavior(bash(command))).toBe('deny');
  });

  it.each(['Teleport', 'mcp__slack__post_message', 'mcp__aws__run_instances'])('unknown tool %s', (tool) => {
    expect(behavior(decide(tool, {}, ctx))).toBe('deny');
  });
});

describe('combining several commands', () => {
  it('lets a deny win over an ask', () => {
    expect(behavior(bash('cat /etc/hosts && git push origin main'))).toBe('deny');
  });

  it('asks about the most consequential action', () => {
    expect(behavior(bash('curl https://example.com && git push'))).toBe('ask:push');
    expect(behavior(bash('cat ~/notes.txt && git push'))).toBe('ask:push');
    expect(behavior(bash('ls .. && gh pr create --fill'))).toBe('deny');
  });
});

describe('parseShell', () => {
  it('splits on operators and keeps quoted text together', () => {
    const parsed = parseShell('a "b c" && d | e; f || g & h');
    expect(parsed.ok && parsed.commands.map((c) => c.words)).toEqual([['a', 'b c'], ['d'], ['e'], ['f'], ['g'], ['h']]);
  });

  it('separates redirect targets and here-document bodies from words', () => {
    const parsed = parseShell("cat <<'EOF' > out.txt 2>&1\nline one\nEOF\nls");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]).toMatchObject({ words: ['cat'], redirects: ['out.txt'], heredocs: ['line one'] });
    expect(parsed.commands[1]!.words).toEqual(['ls']);
  });
});

describe('parseShell: where each command runs', () => {
  it('notes the operators around each command, its subshell depth, and the words whose $ is quoted or escaped', () => {
    const parsed = parseShell("P=/a; (Q=/b) && R=/c | cat\necho '$P' \\$Q \"$R\"");
    expect(parsed.ok && parsed.commands.map((c) => [c.words.join(' '), c.before, c.after, c.depth, c.literalDollar.words])).toEqual([
      ['P=/a', '', ';', 0, []],
      ['Q=/b', '(', ')', 1, []],
      ['R=/c', '&&', '|', 0, []],
      ['cat', '|', '\n', 0, []],
      ['echo $P $Q $R', '\n', '', 0, [1, 2]],
    ]);
  });
});

// alex's rule after the probes: a variable given a plain literal earlier in the same command (NAME=/path) is read
// as the shell would; anything else (command substitution, ~, eval, export, any other expansion) is still noted.
describe('plain variables', () => {
  const R = inHome.worktree;
  const run: GateContext = { ...inHome, cwd: R, tmpDir: `${R}/.tmp` };
  const check = (command: string) => decide('Bash', { command }, run);
  const UNREAD = 'a shell variable the workspace cannot read';

  it.each([
    `P=${R}; cd $P/shop-shared && git status -sb`, // Agent 2's form
    `cd .tmp/harness; SM=../../shop-shared; ls $SM`, // relative, from where the shell is when it is used
    'D=shop-api && git -C "$D" log --oneline -3',
    `P=${R}; cat "\${P}/case.md" > $P/out.txt`,
    `P=${R}; bash -c "ls $P/shop-api"`, // double quotes: this shell expands it before bash runs
  ])('reads a plain literal as the shell would: %s', (command) => {
    expect(check(command)).toEqual({ behavior: 'allow' });
  });

  it('still notes a plain value that points outside the run folder, and says where it resolves', () => {
    expect(check(`P=${R}; git -C $P/../SHOP-9999-x status`)).toMatchObject({ behavior: 'allow', note: `Touches ${R}/../SHOP-9999-x, in alex's home outside the run folder.` });
  });

  // Each of these would pass the gate if it took $P for the run folder: every one must still ask.
  it.each([
    ['a loop over a list it cannot read', 'for r in $LIST; do git -C $r status; done'],
    ['a value with ~', 'P=~/; git -C $P status'],
    ['an exported variable', `export P=${R}; git -C $P status`],
    ['a second assignment', `P=${R}; P=../../..; git -C $P status`],
    ['an assignment after &&', `false && P=${R}; git -C $P status`],
    ['an assignment after ||', `true || P=${R}; git -C $P status`],
    ['an assignment in a subshell', `(P=${R}); git -C $P status`],
    ['an assignment in a pipeline', `P=${R} | true; git -C $P status`],
    ['an assignment in the background', `P=${R} & git -C $P status`],
    ['an assignment inside if', `if true; then P=${R}; fi; git -C $P status`],
    ['an assignment inside a loop', `while true; do P=${R}; break; done; git -C $P status`],
    ['an assignment inside a brace group', `{ P=${R}; }; git -C $P status`],
    ['a function that reassigns it', `f() { P=../../..; }; P=${R}; f; git -C $P status`],
    ['read', `P=${R}; read P < input.txt; git -C $P status`],
    ['mapfile', `P=${R}; mapfile P < input.txt; git -C $P status`],
    ['declare -n', `P=${R}; declare -n Q=P; Q=../../..; git -C $P status`],
    ['printf -v', `P=${R}; printf -v P '%s' ../../..; git -C $P status`],
    ['source', `P=${R}; source ./env.sh; git -C $P status`],
    ['a DEBUG trap', `trap 'P=../../..' DEBUG; P=${R}; git -C $P status`],
    ['arithmetic', `P=${R}; (( P = 1 )); git -C $P status`],
    ['an append', `P=${R}; P+=/../../..; git -C $P status`],
    ['an array element', `P=${R}; P[0]=../../..; git -C $P status`],
    ['a default expansion', `P=${R}; git -C \${P:-../../..} status`],
    ['an assigning expansion', `: \${P:=../../..}; P=${R}; git -C $P status`],
    ['indirection', `Q=P; P=${R}; git -C \${!Q} status`],
    ['a prefix assignment, which the shell does not expand in its own command', `P=${R} git -C $P status`],
    ['a use before the assignment', `git -C $P status; P=${R}`],
    ['a single-quoted $, which the shell leaves alone', `P=${R}; cd '$P'`],
    ['an escaped $', `P=${R}; cd \\$P`],
    ['a value with a glob', 'P=/home/al*; git -C $P status'],
    ['a value with a space', `P="${R} /home/alex"; git -C $P status`],
    ['a value built from another variable', `B=${R}; P=$B/../../..; git -C $P status`],
    ['IFS changed on the line', `IFS=/; P=${R}; git -C $P status`],
    ['a shell started by the line, which gets none of its variables', `P=${R}; bash -c 'git -C $P status'`],
    ['an empty value', 'P=; cd $P'],
  ])('still notes %s', (_what, command) => {
    expect(check(command)).toMatchObject({ behavior: 'allow', note: expect.any(String) });
  });

  it('says why: a variable it cannot read', () => {
    expect(check('for r in $LIST; do git -C $r status; done')).toMatchObject({ note: `Touches $r, ${UNREAD}, so it may be outside the run folder.` });
    expect(check('cat notes/$X.md')).toMatchObject({ note: `Touches notes/$X.md, a path with ${UNREAD}, so it may be outside the run folder.` });
  });

  it('refuses a value made by command substitution, as before', () => {
    expect(check('P=$(pwd)/../..; cat $P/notes.txt')).toMatchObject({ behavior: 'deny' });
  });

  it.each([
    ['$TMPDIR after read TMPDIR', 'read TMPDIR < input.txt; cat $TMPDIR/notes.txt'],
    ['$TMPDIR after export TMPDIR', 'export TMPDIR; cat $TMPDIR/notes.txt'],
    ['$TMPDIR in a shell started after TMPDIR was set', 'TMPDIR=x bash -c "cat \\$TMPDIR/notes.txt"'],
    ['cd with CDPATH set on the line', 'read CDPATH < input.txt; cd notes'],
    ['$HOME after the line changed HOME', `HOME=${R}; cat $HOME/../../notes.txt`],
  ])('no longer trusts %s', (_what, command) => {
    expect(check(command)).toMatchObject({ behavior: 'allow', note: expect.any(String) });
  });

  // His second answer: a loop over plain words, and a value built only from literals and variables already read.
  it.each([
    [
      'the loop P1 and P3 asked for',
      `cd ${R}; ls -R .elfoqsy/team-dev | head -50; for r in shop-worker shop-shared shop-protocol; do echo "== $r"; git -C $r status -sb | head -5; git -C $r log --oneline -3; done`,
    ],
    ['the harness Agent 2 asked for', `P=${R}; H=$P/.tmp/harness; cd $P/shop-shared && tar cf - . | tar xf - -C $H/shared; ls -a $H/shared; cd $H/shared && git status`],
    ['a value built from two read variables', `P=${R}; S=shop-api; D=\${P}/$S/src; git -C $D status`],
    ['a loop over words built from a read variable', `P=${R}; for d in $P/shop-api $P/shop-worker; do git -C $d status; done`],
    ['a cd in each pass that comes back', 'for d in shop-api shop-worker; do cd $d && git status && cd ..; done'],
    ['a relative glob in the run folder', 'for f in *.ts; do wc -l $f; done'],
    ['relative globs in sub-folders', 'for f in src/*.ts test/*.spec.ts; do wc -l "$f"; done'],
    ['a cd into each match, in a subshell', 'for d in */; do (cd $d && pnpm test); done'],
    ['pushd and popd', 'pushd shop-api && git status && popd && git status'],
  ])('reads %s', (_what, command) => {
    expect(check(command)).toEqual({ behavior: 'allow' });
  });

  it.each([
    ['a loop over an absolute glob', 'for f in /home/alex/*; do cat $f; done'],
    ['a loop over a glob with ..', 'for f in ../*; do cat $f; done'],
    ['a loop over a glob that could match . or ..', 'for f in .*; do git -C $f status; done'],
    ['a loop over a glob with ~', 'for f in ~/*; do cat $f; done'],
    ['a loop over a brace expansion', 'for f in {a,../../..}; do git -C $f status; done'],
    ['a loop over a list with a variable it cannot read', 'for f in a $LIST; do git -C $f status; done'],
    ['a loop over a relative glob run outside the run folder', 'cd /var/tmp && for f in *; do cat $f; done'],
    ['the loop variable after the loop', 'for r in a b; do :; done; git -C $r status'],
    ['the loop variable set again in the body', 'for r in a b; do r=../../..; git -C $r status; done'],
    ['the loop variable read in the body', 'for r in a; do read r < input.txt; git -C $r status; done'],
    ['the same name in two loops', 'for r in a; do :; done; for r in ../../..; do :; done; git -C $r status'],
    ['plain words that climb a folder in each pass', 'cd shop-api/src; for d in .. .. ..; do cd $d; done; cat notes.txt; ls ../x'],
    ['cd .. in a loop over a glob, once per match', 'cd shop-api/src/a; for f in *.ts; do cd ..; done; cat notes.txt'],
    ['cd .. in a while loop', 'cd shop-api/src && while [ ! -d .ssh ]; do cd ..; done'],
    ['a value built from a variable it cannot read', 'H=$P/x; git -C $H status'],
    ['a value built from a variable assigned after it', `H=$P/x; P=${R}; git -C $H status`],
    ['a value built from a variable assigned after &&', `false && P=${R}; H=$P/x; git -C $H status`],
    ['a value built with a glob', `P=${R}; H=$P/*; git -C $H status`],
    ['a value built from $HOME', 'H=$HOME/x; git -C $H status'],
    ['a value built from a positional parameter', 'H=$1/x; git -C $H status'],
    ['a value built with a default expansion', `P=${R}; H=\${P:-/home/alex}/x; git -C $H status`],
  ])('still notes %s', (_what, command) => {
    expect(check(command)).toMatchObject({ behavior: 'allow', note: expect.any(String) });
  });

  // His second answer: a variable it cannot read, used as an ordinary argument, is noted.
  it.each([
    ['read from a file', 'read X < input.txt; cat $X/notes.txt'],
    ['never set', 'cat "$UNSET"'],
    ['a copy target', 'cp a.txt $DEST'],
    ['a redirect target', 'echo x > $OUT'],
    ['in the middle of a path', 'cat notes/$X.md'],
    ['a search folder', 'grep -r foo $DIR'],
    ['a flag value', 'tar --directory=$X -xf a.tar'],
    ['typed both quoted and not', "cat '$X' $X"],
    ['a cd target in the middle of a path', 'cd shop-api/$X'],
    ['a git -C folder in the middle of a path', 'git -C shop-api/$X status'],
  ])('notes an unread variable used as an argument: %s', (_what, command) => {
    expect(check(command)).toMatchObject({ behavior: 'allow', note: expect.any(String) });
  });

  it.each([
    ['text', 'echo "$X" && printf "%s" $Y'],
    ['a message', 'git commit -m "$MSG"'],
    ['a test', '[ -n "$X" ] && echo yes'],
    ['a single-quoted $, which the shell leaves alone', "cat '$X.md'"],
    ['a pattern', 'grep -rn "$PATTERN" src'],
  ])('leaves alone a variable that is not a path: %s', (_what, command) => {
    expect(check(command)).toEqual({ behavior: 'allow' });
  });

  it('refuses a command named by a variable it cannot read, and judges one it reads as itself', () => {
    expect(check('$C pr merge 9')).toMatchObject({ behavior: 'deny', reason: '$C is a shell variable the workspace cannot read, which hides what would run. Name the command itself.' });
    expect(check('C=gh; $C pr merge 9')).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('Agents never use gh') });
    expect(check(`$TMPDIR/harness/bin/protoc --version`)).toEqual({ behavior: 'allow' });
  });

  // Found while building these: a cd that does not outlive its subshell, pipeline or background job, and popd.
  it.each([
    ['a cd in a subshell', '(cd shop-api); cat ../notes.txt'],
    ['a cd in a pipeline', 'cd shop-api | true; cat ../notes.txt'],
    ['a cd in the background', 'cd shop-api & cat ../notes.txt'],
    ['popd back to where pushd started', 'pushd shop-api; popd; cat ../notes.txt'],
    ['popd with no pushd on the line', 'popd; cat notes.txt'],
  ])('knows where the shell is after %s', (_what, command) => {
    expect(check(command)).toMatchObject({ behavior: 'allow', note: expect.any(String) });
  });

  it('still reads $TMPDIR as the run temp folder when the line leaves it alone', () => {
    expect(check('mkdir -p $TMPDIR/x && cat $TMPDIR/x/y')).toEqual({ behavior: 'allow' });
  });
});

describe('run context', () => {
  const run: GateContext = {
    ...ctx,
    worktree: '/data/worktrees/SHOP-3546-r1',
    cwd: '/data/worktrees/SHOP-3546-r1/shop-api',
    protectedPaths: ['/code', '/foqs/elfoqsy/.env', '/home/alex/.claude'],
  };
  const runBash = (command: string, extra: Partial<GateContext> = {}) => decide('Bash', { command }, { ...run, ...extra });

  it('resolves relative paths from the session’s current directory', () => {
    expect(runBash('cat ../shop-worker/package.json')).toEqual({ behavior: 'allow' });
    expect(runBash('cat ../../other-run/x')).toEqual({ behavior: 'allow' }); // outside his home
    expect(behavior(runBash('cat ../../other-run/x', { worktree: '/home/alex/runs/SHOP-3546-r1', cwd: '/home/alex/runs/SHOP-3546-r1/shop-api' }))).toBe('allow:noted');
  });

  it.each([
    'cat /code/shop-api/package.json',
    'git -C /code/shop-worker log',
    'cp src/x.ts /code/shop-api/src/',
    'cat /foqs/elfoqsy/.env',
    'cat ~/.claude/.credentials.json',
    'cat /home/alex/.claude/.credentials.json',
    'cat ~/.claude.json',
  ])('denies protected paths outright: %s', (command) => {
    expect(behavior(runBash(command))).toBe('deny');
  });

  it('denies protected paths through the file tools too', () => {
    expect(behavior(decide('Read', { file_path: '/code/shop-api/src/index.ts' }, run))).toBe('deny');
    expect(behavior(decide('Edit', { file_path: '/home/alex/.claude/settings.json', old_string: 'a', new_string: 'b' }, run))).toBe('deny');
  });

  it('runs a command policy on every simple command, with its assignments and directory', () => {
    const seen: Array<[string[], string]> = [];
    const commandPolicy = (words: string[], cwd: string) => {
      seen.push([words, cwd]);
      return words.includes('test:soak') ? { behavior: 'ask' as const, kind: 'command' as const, reason: 'heavier' } : null;
    };
    expect(runBash('JEST_TIERS=unit npx jest src/a.spec.ts', { commandPolicy })).toEqual({ behavior: 'allow' });
    expect(behavior(runBash('cd .. && cd shop-api && npm run test:soak', { commandPolicy }))).toBe('ask:command');
    expect(seen[0]).toEqual([['JEST_TIERS=unit', 'npx', 'jest', 'src/a.spec.ts'], '/data/worktrees/SHOP-3546-r1/shop-api']);
    expect(seen.at(-1)).toEqual([['npm', 'run', 'test:soak'], '/data/worktrees/SHOP-3546-r1/shop-api']);
  });
});

// The file tools run in the agent's own process, outside the sandbox, so they are judged on where a path really leads: the shell
// may make a link in the run folder (it is inside the sandbox, which lets it), and a link must not turn the run folder into his home.
describe('the file tools follow links to where they really lead', () => {
  let base: string;
  let ctxReal: GateContext;
  const at = (...parts: string[]) => join(base, ...parts);

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'elfoqsy-links-')));
    const home = at('home');
    const worktree = at('home', 'runs', 'r1');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    mkdirSync(join(home, '.gnupg'), { recursive: true });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, 'Documents'), { recursive: true });
    mkdirSync(at('cache'), { recursive: true });
    writeFileSync(join(home, '.gnupg', 'pubring.kbx'), 'x');
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'x');
    writeFileSync(join(home, 'Documents', 'notes.txt'), 'x');
    writeFileSync(join(worktree, 'src', 'a.ts'), 'x');
    symlinkSync(home, join(worktree, 'to-home')); // what `ln -s ~ to-home` makes
    symlinkSync(join(home, '.gnupg'), join(worktree, 'to-gnupg'));
    symlinkSync(join(worktree, 'to-home'), join(worktree, 'chain')); // a link to a link
    symlinkSync(join(home, 'new-file'), join(worktree, 'dangling')); // the target is not there yet: writing creates it
    symlinkSync(join(worktree, 'src'), join(worktree, 'inside')); // a link that stays inside
    ctxReal = { worktree, branch: 'feature/SHOP-1', hosts: { jira: [], github: [], registry: [] }, home, cwd: worktree, protectedPaths: [] };
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const verdict = (tool: string, input: Record<string, unknown>) => behavior(decide(tool, input, ctxReal));

  it('asks about a read through a link into his home, as it asked about the link itself', () => {
    expect(verdict('Read', { file_path: join(ctxReal.worktree, 'to-home', '.gnupg', 'pubring.kbx') })).toBe('ask:outside_worktree');
    expect(verdict('Read', { file_path: join(ctxReal.worktree, 'to-gnupg', 'pubring.kbx') })).toBe('ask:outside_worktree');
    expect(verdict('Read', { file_path: join(ctxReal.worktree, 'chain', 'Documents', 'notes.txt') })).toBe('ask:outside_worktree');
    expect(verdict('Grep', { pattern: 'x', path: join(ctxReal.worktree, 'to-home') })).toBe('ask:outside_worktree');
    expect(verdict('Glob', { pattern: `${join(ctxReal.worktree, 'to-home')}/**/*.txt` })).toBe('ask:outside_worktree');
  });

  it('refuses a credential reached through a link, naming both paths', () => {
    const d = decide('Read', { file_path: join(ctxReal.worktree, 'to-home', '.ssh', 'id_ed25519') }, ctxReal);
    expect(d).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('to-home/.ssh/id_ed25519') });
    expect(d).toMatchObject({ reason: expect.stringContaining("credentials live") });
  });

  it('asks about a write through a link, including a link whose target is not there yet', () => {
    expect(verdict('Write', { file_path: join(ctxReal.worktree, 'to-home', '.bashrc'), content: 'x' })).toBe('ask:outside_worktree');
    expect(verdict('Edit', { file_path: join(ctxReal.worktree, 'chain', '.bashrc'), old_string: 'a', new_string: 'b' })).toBe('ask:outside_worktree');
    expect(verdict('Write', { file_path: join(ctxReal.worktree, 'dangling'), content: 'x' })).toBe('ask:outside_worktree');
    expect(verdict('Write', { file_path: join(ctxReal.worktree, 'to-home', 'brand', 'new', 'file.txt'), content: 'x' })).toBe('ask:outside_worktree');
  });

  it('still allows what stays inside the run folder, links included', () => {
    expect(verdict('Read', { file_path: join(ctxReal.worktree, 'src', 'a.ts') })).toBe('allow');
    expect(verdict('Read', { file_path: join(ctxReal.worktree, 'inside', 'a.ts') })).toBe('allow');
    expect(verdict('Write', { file_path: join(ctxReal.worktree, 'inside', 'b.ts'), content: 'x' })).toBe('allow');
    expect(verdict('Write', { file_path: join(ctxReal.worktree, 'src', 'new', 'c.ts'), content: 'x' })).toBe('allow');
  });

  it('judges a search with no path on the directory it starts from', () => {
    const inHomeCwd: GateContext = { ...ctxReal, cwd: ctxReal.home! };
    expect(behavior(decide('Grep', { pattern: 'password' }, inHomeCwd))).toBe('ask:outside_worktree');
    expect(behavior(decide('Glob', { pattern: '*.pem' }, inHomeCwd))).toBe('ask:outside_worktree');
    expect(behavior(decide('Grep', { pattern: 'password' }, ctxReal))).toBe('allow');
  });

  it('does not let a shell command ask to leave the sandbox', () => {
    expect(decide('Bash', { command: 'ls', dangerouslyDisableSandbox: true }, ctxReal)).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('inside the sandbox') });
    expect(decide('Bash', { command: 'ls' }, ctxReal)).toEqual({ behavior: 'allow' });
  });

  // The workspace runs git in the clone outside the sandbox: a hook or a config key written by hand into .git would run with his access.
  it('refuses a file tool that writes inside a .git folder, by any path, and reads there are as free as the rest', () => {
    const w = ctxReal.worktree;
    for (const [tool, input] of [
      ['Write', { file_path: join(w, 'src', '.git', 'hooks', 'pre-push'), content: '#!/bin/sh' }],
      ['Write', { file_path: join(w, '.git', 'config'), content: '[core]' }],
      ['Edit', { file_path: '.git/hooks/post-checkout', old_string: 'a', new_string: 'b' }],
      ['Edit', { file_path: './src/../.git/info/attributes', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: join(w, '.git', 'hooks', 'reference-transaction'), edits: [] }],
    ] as const) {
      expect(decide(tool, input, ctxReal), `${tool} ${JSON.stringify(input)}`).toMatchObject({ behavior: 'deny', reason: expect.stringContaining(".git folder") });
    }
    // Through a link made in the run folder: it leads to a .git.
    symlinkSync(join(w, '.git-target'), join(w, 'g'));
    mkdirSync(join(w, '.git-target'), { recursive: true });
    mkdirSync(join(w, 'real', '.git', 'hooks'), { recursive: true });
    symlinkSync(join(w, 'real', '.git'), join(w, 'viagit'));
    expect(decide('Write', { file_path: join(w, 'viagit', 'hooks', 'pre-push'), content: 'x' }, ctxReal)).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('leads to') });
    // What is not a .git folder is not touched: .gitignore, .gitattributes, .github, .git-notes, a file named like it in a path.
    for (const path of ['.gitignore', '.gitattributes', '.github/workflows/ci.yml', 'docs/.git-notes/x.md', 'src/digit/a.ts', 'my.git/readme']) {
      expect(verdict('Write', { file_path: join(w, path), content: 'x' }), path).toBe('allow');
    }
    expect(verdict('Read', { file_path: join(w, 'real', '.git', 'hooks') })).toBe('allow');
  });

  it('treats his own ~/.npm and ~/.cache as his: agents have caches of their own', () => {
    for (const path of [join(ctxReal.home!, '.npm', '_cacache'), join(ctxReal.home!, '.cache', 'x')]) expect(verdict('Read', { file_path: path }), path).toBe('ask:outside_worktree');
    // The shared cache is in `shared`, so it is theirs for the file tools too.
    expect(behavior(decide('Write', { file_path: at('cache', 'npm', 'x'), content: 'x' }, { ...ctxReal, shared: [at('cache')] }))).toBe('allow');
  });
});
