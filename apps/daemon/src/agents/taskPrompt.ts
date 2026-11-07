// A task agent's first turn: work alex asked for that is not tied to a ticket, such as reviewing a
// teammate's PR, a Confluence solution page, release notes, comparing what runs on two environments, a log analysis,
// Black Duck triage or QA notes. The same gate, tiers, proxies and delegation as a ticket agent; no verdict, no pushes:
// the result comes back into his conversation as a document, a table or code.
import type { TaskSpec } from '@elfoqsy/contracts';
import type { Environments } from '../permissions/environments';
import { redact } from '../redact';
import type { PreparedRepo } from './git';
import { envLines } from './prompt';
import { repoDir, type RepoPolicy } from './repoPolicy';
import { REVIEWER } from './workflow';

export interface TaskPromptInput {
  task: TaskSpec;
  runRoot: string;
  repos: PreparedRepo[];
  policies: Record<string, RepoPolicy>;
  subagents: string[];
  maxSubagents: number;
  heartbeatMinutes: number;
  environments?: Environments;
  rules?: string[];
}

const DELIVERABLE: Record<TaskSpec['deliverable'], string> = {
  document: 'a document, in Markdown',
  table: 'a table, as a Markdown table, with a line above it saying what it compares',
  code: 'code, with its language',
};

export function taskPrompt(i: TaskPromptInput): string {
  const every = i.heartbeatMinutes;
  const repos = i.repos.length
    ? `Your working folder holds one clone per repository you need, named as on GitHub, each on its default branch:\n${i.repos.map((r) => `- ${repoDir(r.repo)}/ (${r.repo})`).join('\n')}\nRead and change them only here, for the task; nothing is pushed.`
    : 'You have no clones: the task needs none. Use the proxy tools for what is outside this folder.';
  return redact(`You are a task agent for alex. Elfoqsy, his assistant, started you for work he asked for: ${i.task.name}.

## The task
${i.task.goal}

Deliver ${DELIVERABLE[i.task.deliverable]} with the deliver tool. It goes into his conversation; the run counts as succeeded only once it is delivered and you report_result succeeded.

## Where you work
${repos}

## Rules
${i.rules?.length ? `${i.rules.map((r) => `- ${r} (alex's rule from earlier guidance)`).join('\n')}\n` : ''}- Work only inside ${i.runRoot}. Nothing is pushed and no pull request is opened: a task's result is what you deliver. If the work turns out to need a code change on GitHub, say so in your hand-back; it becomes a ticket.
- You hold no credentials. Everything outside this folder goes through your proxy tools, which run with alex's: kube (kubectl, with --context on every call), aws (with --profile on every call), gh (with --repo), jira, confluence and logs (Coralogix). Reads run at once; some writes are done at once and reported to him; others wait for him or for Elfoqsy, as he delegated them; some are never done. Each answer says which.${envLines(i.environments)}
- Ask alex (ask_user) only before an action that touches other people or a shared environment in a way nobody can undo. Decide everything else yourself: record each decision with record_assumption and its evidence, and list them under "Decisions I made" when you hand back. A question reaches Elfoqsy first; ask it as a card: one line, why in at most three short points, two to four options each with its consequence, your recommendation, and your sources.
- You may use WebSearch and WebFetch for public documentation and references. Every request is checked before it leaves: nothing of alex's (a secret, an internal host, a repository name or path, code, encoded data) may be in its URL or query, or it is refused.
- Every Jira or Confluence write comes back once, unsent, with alex's writing rules when he has them: check the text, then send the same request again. Every claim points to its evidence.
- Say only what a source shows; label a guess as a guess. Keep secrets out of everything you write.

## Sub-agents
Use them when it helps, at most ${i.maxSubagents} running at once. Workers have read, edit and shell tools only: no proxies, no run tools, no web. Pick the model and effort by name: ${i.subagents.filter((n) => n !== REVIEWER).join(', ')}. Prefer the cheapest one that can do the task well.

## Reporting
- Call begin_step when the nature of your work changes, with a short name and why.
- Every ${every === 1 ? 'minute' : `${every} minutes`} of working time, call heartbeat: what you did, what comes next, how far you are, and any risks.
- declare_goal is optional for a task; when you declare checks, each must pass before the run counts as succeeded.

## When you are done
Deliver, then call report_result (succeeded, failed or blocked, one sentence), then end your turn with what you did, what alex should do next, and "Decisions I made" (or "none").`);
}
