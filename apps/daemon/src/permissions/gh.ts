// The gh proxy: an agent's gh call, run by the orchestrator with alex's gh login. Reads are free. Opening the run's
// own PR as a draft and re-running the failed jobs of its own branch's CI are done at once and reported. Marking a PR
// ready, commenting, editing, closing, running a workflow and deleting CI caches are asked. Merging, approving a review,
// rewriting or renaming refs, releases, secrets and gh's own login are never done. Writes go only to GITHUB_REPOS.
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import { redact } from '../redact';
import { invalid, shortOutput, type Classified, type ExecResult, type Outcome, type ProxyHandler, type Recorded, type RunRef } from './types';

export interface GhRequest {
  /** gh's arguments, without "gh". Name the repository with --repo. */
  args: string[];
}

export type GhCli = (args: string[]) => Promise<ExecResult>;

const schema = z.object({ args: z.array(z.string().max(20_000)).min(1).max(60) });

const VALUE_FLAGS = new Set([
  '-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-r', '--reviewer', '-a', '--assignee',
  '-l', '--label', '-m', '--milestone', '-p', '--project', '-q', '--jq', '--json', '-L', '--limit', '-s', '--state', '-X', '--method',
  '-f', '--field', '--raw-field', '--input', '--hostname', '--ref', '-j', '--job', '-w', '--workflow', '-u', '--user', '-c', '--commit',
  '-e', '--event', '--template', '--add-reviewer', '--remove-reviewer', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee',
  '--search', '-S', '--cache', '--preview', '--header', '--key', '--sort', '--order', '--author', '--branch', '--created', '--status',
]);
const PR_READS = new Set(['view', 'list', 'diff', 'checks', 'status']);
const RUN_READS = new Set(['view', 'list', 'watch']);
const REVIEWER_FLAGS = new Set(['-r', '--reviewer', '--add-reviewer']);
const PROD_WORKFLOW = /deploy|release|publish|prod/i;

export interface ParsedGh {
  group: string;
  verb: string;
  operands: string[];
  flags: Map<string, string[]>;
  repo?: string;
}

export function parseGh(args: string[]): ParsedGh {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const value = eq > 0 ? a.slice(eq + 1) : VALUE_FLAGS.has(a) ? (args[++i] ?? '') : '';
      flags.set(name, [...(flags.get(name) ?? []), value]);
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      // Short flags as gh reads them: -XPUT and -X=PUT are -X with a value, -fbody=hi is -f with "body=hi", -ab is -a
      // and -b. A flag that takes a value takes the rest of the word, or else the next word.
      for (let j = 1; j < a.length; j++) {
        const flag = `-${a[j]}`;
        if (VALUE_FLAGS.has(flag)) {
          let value = a.slice(j + 1);
          if (value.startsWith('=')) value = value.slice(1);
          else if (!value) value = args[++i] ?? '';
          flags.set(flag, [...(flags.get(flag) ?? []), value]);
          break;
        }
        flags.set(flag, [...(flags.get(flag) ?? []), '']);
      }
      continue;
    }
    positional.push(a);
  }
  const [group = '', verb = '', ...operands] = positional;
  const repo = flags.get('--repo')?.[0] ?? flags.get('-R')?.[0];
  return { group, verb, operands, flags, ...(repo ? { repo } : {}) };
}

/**
 * The local files a call makes gh read: a body file, an --input file, a field written key=@file. gh runs in the
 * orchestrator, outside the sandbox, with his access, so what it reads can be a file the sandbox hides from the agent.
 */
export function localFiles(p: ParsedGh): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    if (v && v !== '-') out.push(v);
  };
  for (const v of p.flags.get('--input') ?? []) add(v);
  for (const f of ['--body-file', '--notes-file']) for (const v of p.flags.get(f) ?? []) add(v);
  for (const f of ['-F', '--field']) {
    for (const v of p.flags.get(f) ?? []) {
      const field = /^[^=]+=@(.+)$/.exec(v);
      // A -F with no key is a body file (gh pr create -F file); with one, a field, which reads a file only as key=@file.
      if (field) add(field[1]);
      else if (!v.includes('=') && p.group !== 'api') add(v);
    }
  }
  return out;
}

/** A file inside the run's own folder, as a real path (a link in it that points out is not inside); absolute paths only. */
export function insideRun(path: string, root: string | undefined): boolean {
  if (!root || !isAbsolute(path)) return false;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const base = real(root);
  const full = real(path);
  return full === base || full.startsWith(`${base}${sep}`);
}

const has = (p: ParsedGh, ...names: string[]) => names.some((n) => p.flags.has(n));
const value = (p: ParsedGh, ...names: string[]) => names.map((n) => p.flags.get(n)?.[0]).find((v) => v !== undefined);

/** The HTTP method of a gh api call: explicit, or POST when it carries fields or input. */
function apiMethod(p: ParsedGh): string {
  const m = value(p, '-X', '--method');
  if (m) return m.toUpperCase();
  return has(p, '-f', '-F', '--field', '--raw-field', '--input') ? 'POST' : 'GET';
}

/** A gh api write that is never done: merges, refs, renames, protection, secrets, access, releases, deployments. */
const NEVER_API: Array<[RegExp, string]> = [
  [/\/pulls\/\d+\/merge$|\/merges$/, 'Merging is alex\'s to do.'],
  [/\/git\/refs(\/|$)/, 'Creating, moving or deleting refs through the API would push without the push rules.'],
  [/\/branches\/.+\/rename$/, 'Renaming a branch is never done: a rename once closed a PR for good.'],
  [/\/branches\/.+\/protection/, 'Branch protection is alex\'s.'],
  [/\/(actions|dependabot|codespaces)\/secrets|\/environments\/[^/]+\/secrets/, 'Secrets are alex\'s.'],
  [/\/(collaborators|keys|hooks|invitations)(\/|$)/, 'Access to a repository is alex\'s.'],
  [/\/(releases|deployments)(\/|$)/, 'Releases and deployments are writes towards prod.'],
  [/^\/?repos\/[^/]+\/[^/]+\/?$/, 'Changing or deleting a repository is alex\'s.'],
];
const NEVER_MUTATION = /\b(mergePullRequest|enablePullRequestAutoMerge|updateRef|updateRefs|deleteRef|createRef|(create|update|delete)BranchProtectionRule|deleteRepository|updateRepository|addPullRequestReview\b[^]*APPROVE|approve)/i;

export interface GhContext {
  /** Repositories gh may write to (GITHUB_REPOS). */
  repos: string[];
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function classifyGh(args: string[], run: RunRef, ctx: GhContext): Classified {
  const p = parseGh(args);
  const summary = `gh ${args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')}`.slice(0, 300);
  const kind = `gh.${p.group}${p.verb ? `.${p.verb}` : ''}`;
  const never = (reason: string, k = kind): Classified => ({ tier: 3, kind: k, summary, reason });
  const ask = (k: string, reason: string): Classified => ({ tier: 2, kind: k, summary, reason });
  const read: Classified = { tier: 0, kind, summary, reason: 'A read.' };
  if (has(p, '--admin', '--auto')) return never('--admin and --auto bypass review or merge later; never done.');
  if (has(p, '--web', '-w') && p.group !== 'run' && p.group !== 'workflow') return invalid(kind, summary, 'There is no browser here; read with view instead.');
  if (has(p, '--hostname') && value(p, '--hostname') !== 'github.com') return invalid(kind, summary, 'Only github.com.');

  // A file gh would read, outside the run's folder: never, whatever the call (a body file once could publish any file of his).
  const outside = localFiles(p).filter((f) => !insideRun(f, run.root));
  if (outside.length) {
    return never(`gh would read ${outside[0]!.slice(0, 120)} with alex's access, outside the sandbox. Only a file inside your run folder, by its absolute path, can be a body or an input.`, 'gh.local_file');
  }

  // Reads first: any repository may be read.
  if (p.group === 'api') {
    const method = apiMethod(p);
    const endpoint = p.verb;
    if (!endpoint) return invalid(kind, summary, 'Name the endpoint, for example gh api repos/OWNER/NAME/pulls/12.');
    if (endpoint === 'graphql') {
      const fields = ['-f', '-F', '--field', '--raw-field'].flatMap((f) => p.flags.get(f) ?? []);
      // A query read from a file or stdin cannot be checked here: it may be a mutation.
      if (has(p, '--input') || fields.some((f) => /=@/.test(f))) return ask('gh.api.write', 'A GraphQL query read from a file cannot be checked here, and may be a mutation: asked first.');
      const query = fields.join(' ');
      if (!/\bmutation\b/i.test(query)) return { ...read, kind: 'gh.api.read' };
      if (NEVER_MUTATION.test(query)) return never('That GraphQL mutation merges, approves, or changes refs, protection or the repository.', 'gh.api.never');
      return ask('gh.api.write', 'A GraphQL mutation writes to GitHub: asked first.');
    }
    if (method === 'GET' || method === 'HEAD') return { ...read, kind: 'gh.api.read' };
    const path = endpoint.replace(/^https:\/\/api\.github\.com/, '').replace(/^\/?/, '/');
    for (const [re, why] of NEVER_API) if (re.test(path)) return never(why, 'gh.api.never');
    if (/\/pulls\/\d+\/reviews/.test(path) && args.some((a) => /event=APPROVE/i.test(a))) return never('An approving review is alex\'s to give.', 'gh.pr.approve');
    const repo = /^\/repos\/([^/]+\/[^/]+)\//.exec(path)?.[1];
    if (!repo || !ctx.repos.some((r) => sameRepo(r, repo))) return invalid('gh.api.write', summary, `Writes go only to the configured repositories: ${ctx.repos.join(', ')}.`);
    return ask('gh.api.write', `gh api ${method} writes to GitHub: asked first.`);
  }
  switch (p.group) {
    case 'auth':
      return never('gh auth is alex\'s login; agents never hold credentials.', 'gh.auth');
    case 'secret':
      return p.verb === 'list' ? read : never('Secrets are alex\'s.', 'gh.secret');
    case 'search':
    case 'status':
      return read;
    case 'pr':
      if (PR_READS.has(p.verb)) return read;
      // Never, however it is named: before the repository is even looked at.
      if (p.verb === 'merge') return never('Merging is alex\'s to do.', 'gh.pr.merge');
      if (p.verb === 'review' && (has(p, '--approve') || args.includes('-a'))) return never('An approving review is alex\'s to give.', 'gh.pr.approve');
      break;
    case 'run':
      if (RUN_READS.has(p.verb)) return read;
      if (p.verb === 'download') return invalid(kind, summary, 'Downloads are not available through the proxy; read the log with gh run view --log-failed.');
      break;
    case 'workflow':
      if (p.verb === 'list' || p.verb === 'view') return read;
      break;
    case 'cache':
      if (p.verb === 'list') return read;
      break;
    case 'issue':
    case 'label':
    case 'release':
    case 'repo':
    case 'variable':
      if (['view', 'list', 'status', 'get'].includes(p.verb)) return read;
      break;
    default:
      return invalid(kind, summary, `gh ${p.group} is not available through the proxy.`);
  }

  // Writes: only to the configured repositories, named with --repo.
  if (p.group === 'release') return never('Releases are writes towards prod; alex\'s to do.');
  if (p.group === 'repo') {
    if (['delete', 'rename', 'archive', 'edit', 'sync', 'transfer'].includes(p.verb)) return never(`gh repo ${p.verb} is alex's to do.`);
    if (p.verb === 'clone' || p.verb === 'fork') return invalid(kind, summary, 'Your run folder already has its clones.');
  }
  if (!p.repo) return invalid(kind, summary, 'Name the repository with --repo OWNER/NAME.');
  if (!ctx.repos.some((r) => sameRepo(r, p.repo!))) return invalid(kind, summary, `Writes go only to the configured repositories: ${ctx.repos.join(', ')}.`);
  const target = run.targets.find((t) => sameRepo(t.repo, p.repo!));

  if (p.group === 'pr') {
    switch (p.verb) {
      case 'merge':
        return never('Merging is alex\'s to do.', 'gh.pr.merge');
      case 'create': {
        if (!target) return invalid('gh.pr.create', summary, `A PR comes only from this run's repositories: ${run.targets.map((t) => t.repo).join(', ')}.`);
        const head = value(p, '-H', '--head');
        if (head && head !== run.branch) return invalid('gh.pr.create', summary, `A PR comes only from the run branch, ${run.branch}.`);
        if (has(p, ...REVIEWER_FLAGS)) return invalid('gh.pr.create', summary, 'Open it as a draft without reviewers; reviewers come when it is marked ready, which is asked.');
        // His team's form (team-dev writing.md, his call of 11 October): "<branch>: <behaviour after the fix>".
        const title = value(p, '-t', '--title') ?? '';
        if (!title.startsWith(`${run.branch}: `) || title.length <= run.branch.length + 2) {
          return invalid('gh.pr.create', summary, `The PR title is "${run.branch}: <the behaviour after the fix>", with --title.`);
        }
        const base = value(p, '-B', '--base') ?? target.base;
        if (base !== target.base) return ask('gh.pr.create_other_base', `A PR into ${base} rather than ${target.base} is asked first.`);
        return { tier: 1, kind: 'gh.pr.create', summary, reason: 'Opening the run\'s own PR as a draft is done at once; no reviewer is notified.' };
      }
      case 'ready':
        return has(p, '--undo') ? ask('gh.pr.draft', 'Turning a PR back into a draft is asked first.') : ask('gh.pr.ready', 'Marking a PR ready for review notifies its reviewers: asked first.');
      case 'review':
        if (has(p, '-a', '--approve')) return never('An approving review is alex\'s to give.', 'gh.pr.approve');
        return ask('gh.pr.review', 'A review comment on a PR is asked first.');
      case 'comment':
        return ask('gh.pr.comment', 'Commenting on a PR is asked first.');
      case 'edit':
        return ask('gh.pr.edit', 'Editing a PR is asked first.');
      case 'close':
      case 'reopen':
      case 'lock':
      case 'unlock':
        return ask(`gh.pr.${p.verb}`, `gh pr ${p.verb} is asked first.`);
      case 'checkout':
        return invalid(kind, summary, 'Your run folder already has the branch checked out.');
      default:
        return ask(kind, `gh pr ${p.verb} is not a known command: asked first.`);
    }
  }
  if (p.group === 'run') {
    if (p.verb === 'rerun') {
      const scoped = has(p, '--failed', '-j', '--job');
      return target && scoped
        ? { tier: 1, kind: 'gh.run.rerun', summary, reason: 'Re-running the failed jobs of the run branch\'s own CI is done at once.' }
        : ask('gh.run.rerun_other', target ? 'Re-running every job, not only the failed ones, is asked first.' : 'Re-running CI outside this run\'s repositories is asked first.');
    }
    return ask(kind, `gh run ${p.verb} is asked first.`);
  }
  if (p.group === 'workflow') {
    if (p.verb !== 'run') return ask(kind, `gh workflow ${p.verb} is asked first.`);
    const name = p.operands[0] ?? value(p, '-w', '--workflow') ?? '';
    const ref = value(p, '--ref');
    if (PROD_WORKFLOW.test(name)) return never(`${name || 'That workflow'} deploys, releases or publishes: alex's to run.`, 'gh.workflow.prod');
    if (ref !== run.branch) return never(`A workflow runs only on the run branch, ${run.branch}; on ${ref ?? 'the default branch'} it could deploy.`, 'gh.workflow.other_ref');
    return ask('gh.workflow.run', 'Running a workflow is asked first.');
  }
  if (p.group === 'cache') return ask(p.verb === 'delete' ? 'gh.cache.delete' : kind, 'Deleting CI caches is asked first.');
  return ask(kind, `gh ${p.group} ${p.verb} writes to GitHub: asked first.`);
}

export class GhProxy implements ProxyHandler<GhRequest> {
  readonly name = 'gh' as const;
  readonly schema = schema;

  constructor(
    private readonly ctx: GhContext,
    private readonly gh: GhCli,
  ) {}

  async classify(request: GhRequest, run: RunRef): Promise<Classified> {
    const c = classifyGh(request.args, run, this.ctx);
    if (c.kind !== 'gh.run.rerun' || c.tier !== 1) return c;
    // Done at once only for a failed CI run of the run's own branch, read first.
    const p = parseGh(request.args);
    const id = p.operands[0] ?? '';
    const view = await this.gh(['run', 'view', id, '--repo', p.repo!, '--json', 'headBranch,conclusion,status']);
    let info: { headBranch?: string; conclusion?: string } = {};
    try {
      info = view.ok ? (JSON.parse(view.stdout) as typeof info) : {};
    } catch {
      /* unreadable: asked below */
    }
    if (info.headBranch === run.branch && info.conclusion === 'failure') return c;
    return { ...c, tier: 2, kind: 'gh.run.rerun_other', reason: info.headBranch ? `CI run ${id} is on ${info.headBranch}${info.conclusion ? ` and ${info.conclusion}` : ''}, not a failed run of ${run.branch}: asked first.` : `CI run ${id} could not be read: asked first.` };
  }

  async record(request: GhRequest, c: Classified, run: RunRef): Promise<Recorded | null> {
    if (c.tier === 0) return null;
    const p = parseGh(request.args);
    const repo = p.repo ?? '';
    switch (c.kind) {
      case 'gh.pr.create':
      case 'gh.pr.create_other_base':
        return {
          target: `${repo}, a PR from ${run.branch}`,
          before: `No PR from ${run.branch}.`,
          undo: { proxy: 'gh', summary: `Close the PR from ${run.branch} on ${repo}`, request: { args: ['pr', 'close', run.branch, '--repo', repo] } },
        };
      case 'gh.pr.ready': {
        const pr = p.operands[0] ?? run.branch;
        return { target: `${repo} PR ${pr}`, before: 'A draft.', undo: { proxy: 'gh', summary: `Turn ${repo} PR ${pr} back into a draft`, request: { args: ['pr', 'ready', pr, '--undo', '--repo', repo] } } };
      }
      case 'gh.run.rerun':
      case 'gh.run.rerun_other':
        return { target: `${repo} CI run ${p.operands[0] ?? ''}`.trim(), before: 'Its last result.', noUndo: 'A re-run cannot be taken back; it only runs CI again.' };
      default:
        return { target: `${repo}: gh ${p.group} ${p.verb}`, before: 'As it was on GitHub before the call.', noUndo: 'The orchestrator does not undo this on GitHub; ask alex if it has to be put back.' };
    }
  }

  async execute(request: GhRequest, c: Classified, run: RunRef): Promise<Outcome> {
    let args = request.args;
    const p = parseGh(args);
    if (c.kind === 'gh.pr.create' || c.kind === 'gh.pr.create_other_base') {
      // Always a draft, always from the run branch, into the repository's default branch unless asked otherwise.
      const target = run.targets.find((t) => sameRepo(t.repo, p.repo!))!;
      args = [...args.filter((a) => a !== '--draft' && a !== '-d'), '--draft'];
      if (!has(p, '-H', '--head')) args.push('--head', run.branch);
      if (!has(p, '-B', '--base')) args.push('--base', target.base);
    }
    const r = await this.gh(args);
    const output = shortOutput(redact(r.ok ? r.stdout : r.stderr || r.stdout));
    if (!r.ok) return { ok: false, output: output || 'gh failed.' };
    const repoName = (p.repo ?? '').split('/')[1] ?? p.repo;
    let done: { en: string; vi: string };
    if (c.kind.startsWith('gh.pr.create')) {
      const number = /\/pull\/(\d+)/.exec(r.stdout)?.[1];
      done = { en: `opened ${repoName} ${number ? `#${number}` : 'a PR'} as a draft`, vi: `đã mở ${repoName} ${number ? `#${number}` : 'một PR'} dưới dạng draft` };
    } else if (c.kind.startsWith('gh.run.rerun')) done = { en: `re-ran the failed jobs of CI run ${p.operands[0] ?? ''} on ${repoName}`, vi: `đã chạy lại các job lỗi của CI run ${p.operands[0] ?? ''} trên ${repoName}` };
    else if (c.kind === 'gh.pr.ready') done = { en: `marked ${repoName} #${p.operands[0] ?? ''} ready for review`, vi: `đã chuyển ${repoName} #${p.operands[0] ?? ''} sang sẵn sàng để review` };
    else done = { en: `ran gh ${p.group} ${p.verb} on ${repoName}`, vi: `đã chạy gh ${p.group} ${p.verb} trên ${repoName}` };
    return { ok: true, output: output || 'Done.', done: done.en, doneVi: done.vi };
  }
}
