// The sub-agents a ticket agent can use: one per allowed model and effort pair, named so it picks by
// name (e.g. sonnet-5.5-high). The SDK's per-call override only takes model aliases (not pinned ids)
// and its own guidance discourages choosing effort; named definitions pin both.
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Effort } from '../config';

/** claude-sonnet-5-5 -> { family: 'sonnet', version: '5.5', label: 'Sonnet 5.5' } */
export function describeModel(id: string): { family: string; version: string; label: string } {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (!m) return { family: id, version: '', label: id };
  const family = m[1]!;
  return { family, version: `${m[2]}.${m[3]}`, label: `${family[0]!.toUpperCase()}${family.slice(1)} ${m[2]}.${m[3]}` };
}

export const subagentName = (model: string, effort: string): string => {
  const d = describeModel(model);
  return `${d.family}-${d.version}-${effort}`;
};

/**
 * What each role may use (alex, v1.3; the reviewer's shell taken away ), enforced twice: here, so the tools
 * are not even offered, and by the run's gate, which checks the calling agent on every call. Workers read, edit and run
 * commands. The reviewer reads and nothing else, by configuration: it has no shell and no tool that writes, so there is no
 * command to hold to reads, and nothing it is told can change that. Neither has the run's tools or proxies (gh included), the
 * web, or sub-agents of its own.
 */
export const WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'TodoWrite'];
export const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
/** Everything a reviewer is refused by name as well as not offered: a shell and every writer. */
export const REVIEWER_NEVER = ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite'];
const NEVER = ['mcp__run', 'Agent', 'Task', 'WebFetch', 'WebSearch'];

const WORKER_PROMPT = `You are a sub-agent working for a ticket agent inside its run folder. Do only the task you were given.
- Work inside the run folder with your read, edit and shell tools. You have no proxy tools, no run tools and no web; pushes, PRs, questions for alex and anything remote are the ticket agent's.
- Run only the unit-test commands the ticket agent gave you; anything heavier needs alex's approval through the ticket agent.
- Be concise. Report what you did and what you found, with file paths.
- End your final message with one line: RESULT: success, or RESULT: failure, followed by a few words why.`;

const STRENGTH: Record<string, string> = {
  haiku: 'fast and cheap: searching, reading, summarising, small mechanical edits',
  sonnet: 'balanced: most coding, test fixing and reviews',
  opus: 'strongest: hard debugging, design decisions and tricky changes',
};

/** The review before the first push (team-dev): fresh context, read-only, Sonnet 5.5 at high. */
export const REVIEWER_MODEL = 'claude-sonnet-5-5';
const REVIEWER_PROMPT = `You are a fresh-context code reviewer for a ticket agent, before its first push. You know only what the task gives you.
- The task names a diff file in the run folder and the clone it applies to, and the folder with the ticket's handoff and acceptance criteria (handoff.md and acceptance-criteria.md, written by Elfoqsy, not by the ticket agent). Read those two first, then the diff with Read, and the files it touches in the clone with Read, Grep and Glob.
- Hold the diff to what was asked. For each acceptance criterion say MET, NOT MET, or CANNOT TELL from the diff and the files, and what would settle it. A criterion the diff does not meet, or a constraint of alex's in the handoff that it breaks, is a finding (Major, or Blocker when the ticket cannot be called done without it); a change the criteria and the handoff do not ask for is a finding too, Minor unless it is risky. The handoff's facts are leads, not conclusions: do not require a cause it does not state. If the folder is missing or says there is no handoff, say so and review against the ticket's own text in acceptance-criteria.md.
- Review it against the repository's CI review ruleset (.agents/skills/pr-review/RULESET.md) and its rules (.claude/rules/), and the input classes the agent declared.
- Check two things explicitly, in every case: whether the diff changes a visible contract (HTTP or error codes, result fields, key formats, message shapes, configuration names or anything a client or another service reads), and whether it bypasses a cache or an optimization (reads around a cache, skips a cache write, disables a short-cut).
- You have no shell and no tool that writes: you cannot run or change anything. If something only a command shows would settle a point (a git log, a test run), say so in your result; running it is the ticket agent's.
- Report each finding as Blocker, Major or Minor, with file:line and the rule or input class it breaks. Say what you checked and found fine in one line.
- End your final message with these lines, in this order:
  CONTRACT: none, or what changes and where (file:line)
  CACHE_BYPASS: none, or what is bypassed and where (file:line)
  one line for each acceptance criterion, numbered from 1 in the order of acceptance-criteria.md (the field first, then what the description states), in the ticket's own words and one criterion to a line:
  CRITERION <n>: MET | the criterion in a few words | what shows it (file:line)
  CRITERION <n>: NOT MET | the criterion in a few words | what is missing or wrong (file:line)
  CRITERION <n>: CANNOT TELL | the criterion in a few words | what would settle it
  or, when the ticket states none, the one line CRITERIA: none stated
  RESULT: success, or RESULT: failure, followed by a few words why.
  Every criterion you call NOT MET is shown to alex and holds the ticket agent's report that the run succeeded: call one NOT MET only when the diff and the files show it, and say so as CANNOT TELL when only a run of the code would.`;

export function subagentDefinitions(models: string[], efforts: Effort[]): Record<string, AgentDefinition> {
  const defs: Record<string, AgentDefinition> = {
    reviewer: {
      description: 'The one fresh-context review before your first push (Claude Sonnet 5.5 at high): write the diff to a file in the run folder and give it that path, the repo, your declared input classes and the folder with the ticket\'s handoff and acceptance criteria (the prompt of your run names it). It reads files only: no shell, nothing that writes.',
      prompt: REVIEWER_PROMPT,
      model: REVIEWER_MODEL,
      effort: 'high',
      tools: REVIEWER_TOOLS,
      disallowedTools: [...NEVER, ...REVIEWER_NEVER],
    },
  };
  for (const model of models) {
    const d = describeModel(model);
    for (const effort of efforts) {
      defs[subagentName(model, effort)] = {
        description: `Worker on Claude ${d.label} at ${effort} effort. ${STRENGTH[d.family] ?? ''}`.trim(),
        prompt: WORKER_PROMPT,
        model,
        effort,
        // No nesting, no web, no run tools or proxies: sub-agents count against the run's cap and live in its sandbox.
        tools: WORKER_TOOLS,
        disallowedTools: NEVER,
      };
    }
  }
  return defs;
}
