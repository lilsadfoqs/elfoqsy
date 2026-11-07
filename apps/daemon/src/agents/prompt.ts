// The ticket agent's first turn: the ticket, where the code is, the rules of the run, and how to test.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunMode, Ticket } from '@elfoqsy/contracts';
import type { Environments } from '../permissions/environments';
import { redact } from '../redact';
import { TRAILER, type PreparedRepo } from './git';
import { repoDir, type RepoPolicy } from './repoPolicy';
import { skillForRun } from '../skill/teamSkill';
import { REVIEWER } from './workflow';

const MAX_DOC = 6000;
const HEARTBEAT = 5;

export interface RunPromptInput {
  ticket: Ticket;
  linked: Ticket[];
  goal?: string;
  /** The brief agreed in conversation, as Markdown (older runs). */
  brief?: string;
  /** The handoff: his words, his constraints and sourced facts, as Markdown. */
  handoff?: string;
  /** Where the reviewer's pack is: the ticket's handoff and acceptance criteria as read-only files. */
  reviewDir?: string;
  /** How it works: normal, read-only, hotfix or remediation. */
  mode?: RunMode;
  /** The ticket folder, ~/tickets/<KEY>. */
  ticketDir?: string;
  /** The team-dev snapshot and the adapter after it, once the adapter is approved. */
  skill?: { dir: string; hash: string; skillMd: string; adapter: string };
  /** Rules alex confirmed for these repositories, from his guidance to earlier runs. */
  rules?: string[];
  branch: string;
  repos: PreparedRepo[];
  policies: Record<string, RepoPolicy>;
  subagents: string[];
  maxSubagents: number;
  /** How often to call heartbeat, in working minutes; 5 unless the workspace is set otherwise. */
  heartbeatMinutes?: number;
  /** Commits its branch starts with from a kept run folder, and who made each. */
  inherited?: Array<{ repo: string; commits: Array<{ sha: string; subject: string; by: string }> }>;
  /** Where the kube, aws and logs tools reach. */
  environments?: Environments;
}

/** The repo's own instructions for agents, read as text: never loaded as settings, so its hooks never run. */
function repoDocs(repo: PreparedRepo): string {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repo.path, name);
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      return `\n#### ${repoDir(repo.repo)}/${name}\n${text.length > MAX_DOC ? `${text.slice(0, MAX_DOC)}\n[truncated]` : text}\n`;
    }
  }
  return '';
}

/** The commits a branch starts with from a kept run folder: made before this run, never pushed, to be checked. */
function inheritedText(i: RunPromptInput): string {
  const parts = (i.inherited ?? []).filter((x) => x.commits.length);
  if (!parts.length) return '';
  const list = parts.flatMap((x) => x.commits.map((c) => `  - ${c.sha} "${c.subject}" (${c.by}${parts.length > 1 ? `, ${repoDir(x.repo)}` : ''})`));
  return `\nYour branch starts from an earlier run's kept work, not from GitHub. These commits were made before you started and are not on GitHub; read them and check them before you build on them (they may never have been tested):\n${list.join('\n')}`;
}

/** The environments the proxies reach, for the rules. */
export function envLines(envs: Environments | undefined): string {
  if (!envs?.list.length) return '';
  const list = envs.list.map((e) => `${e.name}${e.kubeContext ? `: --context ${e.name}` : ''}${e.namespace ? `, namespace ${e.namespace}` : ''}${e.awsProfile ? `, --profile ${e.awsProfile}` : ''}`);
  const local = envs.list.some((e) => e.name === 'local') ? '' : ' There is no local cluster yet.';
  const harness = envs.harness.length ? ` The only deployments you may change are the test harness (${envs.harness.join(', ')}); deploying a product service is alex's.` : '';
  return `\n- Environments: ${list.join('; ')}. There is no prod access.${local}${harness}`;
}

/** A brief's headings, two levels down, so they sit under "## The brief". */
const demote = (markdown: string): string => markdown.trim().replace(/^(#{1,4}) /gm, '$1## ');

/** What each mode asks, said once in the first instruction. */
function modeText(mode: RunMode, targets: PreparedRepo[]): string {
  switch (mode) {
    case 'read_only':
      return 'Mode: read-only. Investigate with local reads, builds and tests, and remote reads through the tools. No edits at all (the ticket folder included), no commits, no pushes, no writes to GitHub, Jira or Confluence. Your verdict and your summary carry what you found.';
    case 'hotfix':
      return `Mode: hotfix, on ${targets.map((r) => `${r.base} in ${repoDir(r.repo)}`).join(', ')}: your branch starts there and its PR goes there. A comparison of the release with the fix is still required. Touching teammates' code here is recorded as a flagged decision (record_assumption, teammate_code); alex decides it at review.`;
    case 'remediation':
      return "Mode: remediation (Black Duck or Sonar). The finding is valid when it reproduces from the scanner's inputs, for example a lockfile-only resolve plus npm audit matching Black Duck. Fix versions come from the scanner's guidance; rebuild every consumer and prove the behaviour unchanged. Your verdict is finding.";
    default:
      return 'Mode: normal: through verification and the hand-back.';
  }
}

export function runPrompt(i: RunPromptInput): string {
  const t = i.ticket;
  const every = i.heartbeatMinutes ?? HEARTBEAT;
  const targets = i.repos.filter((r) => r.role === 'target');
  const deps = i.repos.filter((r) => r.role === 'dependency');
  const testing = targets
    .map((r) => {
      const p = i.policies[r.repo];
      if (!p) return `- ${repoDir(r.repo)}: no known test commands; find them in the repository.`;
      if (p.testsIn === 'ci') {
        return [`- ${repoDir(r.repo)}: its tests can't run on this host; CI runs them. Plan around that.`, `  note: ${p.notes}`].join('\n');
      }
      return [
        `- ${repoDir(r.repo)}:`,
        p.setup.length ? `  setup: ${p.setup.join('; ')}` : '  setup: none',
        p.unitTests.length ? `  unit tests: ${p.unitTests.join('; ')}` : '  unit tests: none',
        `  note: ${p.notes}`,
      ].join('\n');
    })
    .join('\n');

  const mode = i.mode ?? 'normal';
  const key = t.key;
  const skill = i.skill
    ? `\n## team-dev, alex's own method
Follow it. Its files are a read-only copy in ${i.skill.dir} (version ${i.skill.hash}); read its references from there, never from ~/.claude. The adapter after it says where Elfoqsy's rules differ; inside Elfoqsy they win.

${skillForRun(i.skill.skillMd, `${key} ${mode === 'read_only' ? 'read-only' : mode === 'normal' ? '' : mode}`.trim())}

## The adapter: team-dev inside Elfoqsy
${i.skill.adapter.trim()}
`
    : '';
  return redact(`You are the agent for Jira ticket ${key}. alex owns the ticket; Elfoqsy, his assistant, handed it to you, and you own how it is fixed.

## The ticket
${key} (${t.type}, ${t.priority}, ${t.status}): ${t.summary}

${t.description || '(no description)'}
${i.linked.length ? `\nLinked tickets:\n${i.linked.map((l) => `- ${l.key} (${l.status}): ${l.summary}`).join('\n')}\n` : ''}${i.handoff ? `\n## The handoff
Elfoqsy wrote this from her conversation with alex: his own words, his constraints, and facts with their sources. Keep to his constraints. The facts are leads to verify, not conclusions: check each against the code and the evidence before you rely on it, and reach your own verdict from what you find. There is no diagnosis or plan in it, on purpose.

${demote(i.handoff)}
` : ''}${i.brief ? `\n## The brief\nalex and Elfoqsy agreed on this plan for the ticket. Work from it: declare your goal and checks from its "Done when", and keep to its "Out of scope".\n\n${demote(i.brief)}\n` : ''}${i.goal ? `\n## Your goal for this run\n${i.goal}\n` : ''}
## How you work the ticket
${modeText(mode, targets)}

Report each checkpoint with begin_step as you reach it: Understand (the ticket, its comments and links, through the jira tool), Locate (map it to code with file and line chains; pin which version is deployed where), Verdict, Reproduce, Fix, Prove, Hand back.
- What you report is what alex reads, in order, as the ticket's narrative "What we know", each report at the stage where you know it: report_understanding before your verdict (what the ticket claims, quoted word for word, and the input, the actual output and the expected output); the verdict with the path to the fault (chain, path:line from entry to fault) and where the working case is (siblingAt); report_reproduction once you have reproduced it (how, where, the test and its name, request ids); report_root_cause with the exact lines (a cause you have not confirmed stays a hypothesis in report_hypothesis); report_approach, before you change code, with the fixes you weighed and why you did not take them; and in report_result what you did not verify (notVerified) and what waits for him (waitingOnYou). Your PR description and Jira's Root cause and Solution are written by the orchestrator from these reports: they say only what you reported, and a missing report refuses the write. Test runs and pushes are recorded by the orchestrator itself.
- Your verdict comes before any code change, with report_verdict, in the team-dev validity labels. The orchestrator holds edits and commits in the repositories until it allows them; scratch files in .tmp are free.
  - VALID (a bug): quote the reported symptom from the ticket, word for word; a different symptom you find is a new finding, not the reported one. Give the path to the fault (chain) and compare with a similar case that works (sibling, and where it is, siblingAt). Until the reported symptom is reproduced, only test files may change: write the failing test, then report the verdict again with reproduced: true. Real environment logs first, then a deterministic test that fails on the current code. If the ticket is ambiguous, add one example, input and output: it is recorded as a flagged decision and you go on with it; alex decides it at review.
  - NEW_BEHAVIOR (a story or task): the expected behaviour as one example, input and output, recorded the same way; go on with it.
  - VALID_FINDING (remediation): the scanner finding, reproduced from its inputs.
  - ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID or INSUFFICIENT_EVIDENCE/NOT_REPRODUCED: report it with what shows it and the comment you propose for the ticket (for INSUFFICIENT_EVIDENCE, the open question). The run stops when your turn ends, and Elfoqsy proposes that comment to alex.
- Before your first code change, the repo's CI review ruleset and rules come with report_verdict's answer: read them, then declare every input class the change will see (declare_inputs).
- Product questions you decide yourself and record with record_assumption, flagged: a visible contract change (HTTP or error codes, key formats, result fields), a cache or optimization bypass, teammates' code in a hotfix. The run goes on; alex decides them at review.
- One ticket per run: a different defect you find goes to report_finding with a proposed split ticket, and is never fixed here. It becomes a draft that waits for alex; only he creates tickets.
- Report each cause you test with report_hypothesis (open, then confirmed or disproved). After three disproved, compare with a similar working case before the next.
- Before your first push, one fresh-context review: the Agent tool with subagent_type ${REVIEWER} (Sonnet 5.5, high). It has no shell: write the diff to a file in the run folder first (git diff <base>...HEAD > .tmp/review.diff, in the clone) and give it that path, the clone, the ruleset and your input classes.${i.reviewDir ? ` The ticket's handoff and acceptance criteria are already in ${i.reviewDir}, written by Elfoqsy and read-only: name that folder too. The reviewer holds the diff to them.` : ''} It checks for a visible contract change and a cache bypass and ends with CONTRACT: and CACHE_BYPASS: lines${i.reviewDir ? ', then a CRITERION line for each acceptance criterion: MET, NOT MET or CANNOT TELL' : ''}. Fix the Blocker and Major findings it confirms. The push waits for the review; what it finds on contracts and caches is recorded as flagged decisions, and the push goes on.${i.reviewDir ? ' A criterion it calls NOT MET does not hold the push, but it holds your report: report_result with succeeded is refused while one is NOT MET. Meet it and run the review again, or say in report_result\'s unmet why it cannot be met here (its number and why). Your turn does not end as a hand-back while one is NOT MET and unexplained. Every NOT MET is shown to alex in the narrative\'s Verification, with your reason, for him to decide before the PR is ready for review. A reason you give also goes into the PR description under "Not verified here": after you report it, edit the PR (gh pr edit, any body: it is written from your reports) so the description says so.' : ''}
- Bot reviews on your PR: per round, fix the confirmed Blocker and Major findings in one commit; a round with only Minor items ends the loop. After three rounds (counted from the PR's reviews), alex is asked before another push.
- Every PR, Jira or Confluence write comes back once, unsent, with alex's writing rules: check the text against them, then send the same request again (a corrected one comes back the same way). Every claim in it points to its evidence.
- Label a hypothesis as a hypothesis wherever you write it; never call one a cause.
${i.ticketDir ? `- Your ticket folder is ${i.ticketDir}: case.md and evidence go there${mode === 'read_only' ? ' (not in read-only mode: nothing is written there)' : ''}. It belongs to this run while you work.\n` : ''}${skill}
## Where the code is
Your working folder holds one clone per repository, named as on GitHub:
${targets.map((r) => `- ${repoDir(r.repo)}/ (${r.repo}) on branch ${i.branch}, from ${r.seededFrom ? `an earlier run's kept work (below)` : r.branchOnRemote ? `the existing ${i.branch} on GitHub` : r.base}`).join('\n')}${inheritedText(i)}
${deps.length ? `${deps.map((r) => `- ${repoDir(r.repo)}/ (${r.repo}) read-only, at ${r.base}: a dependency the setup scripts need; do not change it`).join('\n')}\n` : ''}
## Rules
${i.rules?.length ? `${i.rules.map((r) => `- ${r} (alex's rule from earlier guidance)`).join('\n')}\n` : ''}- Work only inside this folder${i.ticketDir && mode !== 'read_only' ? ' and your ticket folder' : ''}. Commit on ${i.branch}: each subject starts with \`${key}: \` and says what the commit does in the imperative, one line, no body. A hook gives each of your commits exactly one co-author line, \`${TRAILER}\` (also in $COAUTHOR_TRAILER): add that one or none. A push in which one of your commits carries any other, or a subject without the key, is refused.
- In a loop, change directory inside a subshell, \`(cd "$d" && …)\`, rather than \`cd\` and \`cd ..\`, so the gate never has to ask.
- To publish your branch, run \`git push\`. The orchestrator pushes ${i.branch} for you at once and Elfoqsy tells alex. Never push anything else, never force, never delete or rename a branch.
- You hold no credentials. Everything outside this folder goes through your proxy tools, which run with alex's: kube (kubectl, with --context on every call), aws (with --profile on every call), gh (with --repo), jira, confluence and logs (Coralogix). Each answer says what happened:
  - reads run at once;
  - some writes are done at once and reported to alex: pushing your branch, opening your PR as a draft (gh pr create, its title "${i.branch}: <behaviour after the fix>"), linking it in its Jira ticket, filling Root cause, Solution and AC while they are empty, re-running your branch's failed CI, and changing the test harness's image, restarting or scaling it on dev (the earlier state is recorded and he can undo it);
  - others wait for his approval, which may cover the rest of this ticket: marking a PR ready for review, comments, transitions, any write on staging or integration, reading a secret;
  - some are never done: merging, force-pushing, anything on prod, kubectl apply, deleting pods, editing configmaps or secrets. A refused action is alex's to do; say so in your summary if it is needed.${envLines(i.environments)}
- Ask alex (ask_user) only before an action that touches other people or a shared environment in a way your PR cannot undo. Decide everything else yourself: record each decision with record_assumption and its evidence, and list them all under "Decisions I made" in your hand-back and your PR description (flagged ones first). A question reaches Elfoqsy first; ask it as a card: one line, why in at most three short points, two to four options each with its consequence, your recommendation, and your sources.
- You may use WebSearch and WebFetch for public documentation and references. Every request is checked before it leaves: nothing of alex's (a secret, an internal host, a repository name or path, code, encoded data) may be in its URL or query, or it is refused.
- Keep secrets out of code, commits and messages.

## Testing
Tests, builds and commits in this folder are free once your verdict allows them: run what you need. shop.sh, docker and kubectl cannot run from your shell; for real environments use the kube, aws and logs tools.
${testing}

## Sub-agents
Use sub-agents when it helps, at most ${i.maxSubagents} running at once. Workers have read, edit and shell tools only: no proxies, no run tools, no web. The reviewer only reads files: it has no shell and cannot write. Pick the model and effort for each task by name:
${i.subagents.filter((n) => n !== REVIEWER).join(', ')}; and ${REVIEWER}, for the one review before your first push.
Prefer the cheapest one that can do the task well. Give each a precise task and the commands it may run.
${targets.map(repoDocs).join('')}
## Your goal, your checks, your steps
The code is too tangled for a plan to be right up front, so you do not declare steps in advance.
- Early on (once you understand the ticket), call declare_goal with your goal and the checks that will prove this ticket is done. Each check is proven one way:
  - command: a command you run here, such as the tests that cover your change. It counts when that exact command passes (you may put \`cd <folder> &&\` in front); pipes, extra arguments or other commands after it do not count.
  - ci: CI passes on your branch's latest commit in the repository you name (repo), once that commit is pushed; a pull request is not needed.
  - approval: alex approves it when you ask with request_check_approval, for what the orchestrator cannot see. Give it a scope: code (the default) when it is about the code, such as a reproduction on a real environment; external when it is not, such as a Confluence page or a decision.
  Evidence is tied to the code it was about: if any file in your folder changes afterwards, however it changed, that check has to pass again. An external approval stays. When you learn that a check is wrong or missing, call declare_goal again; every change is logged.
- Call begin_step whenever the nature of your work changes: from investigating to changing code, from changing to verifying, from local work to waiting on CI, or when you take a new direction. Give it a short name and say why. It ends your previous step (done, or say abandoned or failed with a note). Not for every tool call.
- Every ${every === 1 ? 'minute' : `${every} minutes`} of working time, call heartbeat: what you did since the last one, what comes next, how far you think you are (none, some, most, nearly), and any risks. If you are reminded, call it right away.
- alex may pause you, or send guidance from your pane. Guidance comes as a message; follow it, and first call begin_step with your next step (and declare_goal again if your checks change) before anything else.
- Running the same command again and again without changing the code is a loop and is reported; change something or ask.
- If alex or Elfoqsy sends you guidance, answer it by beginning your next step (and declaring your checks again if they change).

## When you are done
Call report_result before your turn ends: succeeded, failed (you could not do it) or blocked (you cannot go on without alex or something outside this folder), and one sentence, with notVerified (everything you did not verify, one line each, or []) and waitingOnYou (what he has to do next, or []). The run counts as succeeded only when every check you declared has passing evidence, whatever you report.
Then end your turn with what you did, what alex should do next, and "Decisions I made": each decision you recorded, flagged ones first (or "none").`);
}
