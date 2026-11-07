# Bringing your team's skill into runs: the adapter

Many teams already have a Claude Code skill that says how they work a ticket: how to reproduce a bug, which labels a verdict uses, how commits and PR titles are written, what goes into the PR description. Elfoqsy can run that skill inside every ticket agent, so agents work the way the team already does. This file explains how, and how to write the adapter that makes the skill and the workspace's rules agree.

The skill is optional. Without it, ticket agents follow the workspace's own workflow (`architecture.md`, "The ticket workflow").

## How a run uses the skill

- **Where it is read from.** The daemon looks for the skill at `~/.claude/skills/team-dev` (the folder name `skill/teamSkill.ts` expects today). Without a `SKILL.md` there, runs have no team skill.
- **A read-only copy per run.** When a run starts it copies the skill into its run folder, read-only, and logs its version as `run.skill_snapshot`. The version is a SHA-256 over each file's path and contents, in path order (12 hex characters). A run follows its copy to the end, even if the skill changes meanwhile.
- **Only with an adapter.** The copy's `SKILL.md` goes into the agent's first instruction only when `prompts/skill-adapter.md` exists. Writing the adapter is how you approve the skill for runs.
- **The first instruction.** The skill's `SKILL.md` goes in verbatim, with `$ARGUMENTS` replaced by `<KEY> <mode>` from the handoff, and the adapter comes right after it. The skill's references are read from the copy, never from `~/.claude`.
- **Its environment.** The run's environment sets `ELFOQSY_RUN_ID` (so the skill can tell it runs inside Elfoqsy and yield to it) and `COAUTHOR_TRAILER` (the one co-author line every agent commit carries).

## When the skill changes

The adapter is written against one version of the skill. `config/skill-adapter.json` records that version:

```json
{
  "skill": "team-dev",
  "hash": "<12 hex characters>",
  "sections": { "Setup": "<hash>", "Verdicts": "<hash>" }
}
```

`sections` holds a hash per `##` section of `SKILL.md`. At start, and before each run, the daemon compares the skill on disk with the manifest. When they differ, Elfoqsy says once, in the Today conversation, which sections changed and that the adapter needs a review; runs follow the new version meanwhile. Update the adapter, then the manifest.

## Writing the adapter

The adapter is a list of instructions for the agent, one for each place where the skill and the workspace's rules disagree. The workspace's rules win where safety is concerned: the four tiers, credentials, which branches may be pushed, and what counts as evidence. The orchestrator enforces those whatever the prompt says; the adapter only keeps the agent from trying what will be refused, and settles the rest (language, file locations, commit and PR format).

A good way to write one is to go through the skill line by line and make a table first:

| # | Area | The skill says | The workspace's rule | Resolution inside Elfoqsy |
| --- | --- | --- | --- | --- |
| 1 | Asking the user | "Confirm with the user before …" | Agents ask only before an action that touches other people or a shared environment in a way their PR cannot undo; everything else is recorded with `record_assumption`. | Every "ask the user" goes through `ask_user` (which reaches Elfoqsy first), and only in the cases the workspace asks. |
| 2 | Branch | "Create a ticket branch per repo convention." | The orchestrator creates `feature/<KEY>` in every repository before the run starts; it is never renamed. | The agent never creates, switches or renames a branch. |
| 3 | Workspace | "Work in the shared checkout." | Each run has its own clones in its run folder; the user's clones are out of reach. | The run folder is the workspace. |
| 4 | Remote actions | "Run kubectl, aws or gh as needed." | Remote actions go through the capability proxies under the four tiers. | Use the `kube`, `aws`, `gh`, `jira`, `confluence`, `logs`, `docker` and `shop` tools, never the CLIs in the shell. |
| 5 | Review | "Run a fresh-context review before pushing." | Only named sub-agents may run; the `reviewer` is read-only. | Use the `reviewer` sub-agent with the diff, the ruleset and the input classes. |
| 6 | Commit trailer | "Add our co-author line." | Exactly one trailer, kept by the workspace's commit hook. | Add `$COAUTHOR_TRAILER` or nothing. |
| 7 | Verdict labels | The skill's own labels (for example VALID, ALREADY_FIXED, NOT_REPRODUCED). | `report_verdict` before any code change. | Report the verdict with `report_verdict`, in the skill's labels. |

Then write the Resolution column as instructions in `prompts/skill-adapter.md`, grouped by area. The shipped `prompts/skill-adapter.md` is an example written for a skill like the one above, for the Acme Shop team; adapt it to yours, or delete it to run without a team skill.

Rules the skill states but cannot enforce are worth listing too, because the workspace turns them into gates: a reproduced symptom before a fix (the verdict gate), a review before the first push (the push waits for it), a different defect getting its own ticket (`report_finding` drafts one; it is never fixed in the same run).
