# Architecture

Elfoqsy is a local-first orchestrator that runs one coding agent per ticket, with an approval gate and full replay. One process (the daemon) owns an append-only event log; two browser screens rebuild everything they show by folding that log. An AI persona, Elfoqsy, talks with the user and asks the orchestrator to start and steer agents; the orchestrator is plain TypeScript and owns every permission decision.

This document is for contributors. How to run and use the workspace is in `USING.md`; the visual contract of the screens is in `ui-spec.md`.

## Layers

```
┌──────────────────────────── Workspace (browser, two windows) ────────────────────────────┐
│  /left  sprint orbit map + chat with Elfoqsy      /right  live map of agents             │
│  both are folds over the same event stream (packages/state)                               │
└───────────────────────────────▲──────────────────────────────────────────────────────────┘
                                │ WebSocket: events down; messages, answers and edits up
┌───────────────────────────────┴──────────────────────── Daemon (apps/daemon) ────────────┐
│  Elfoqsy's session ──tools──▶ Orchestrator (plain TS, never calls a model)               │
│        ▲                         │   approval gate · capability proxies · budgets        │
│        └──── reads ──── Event log (SQLite, append-only, redacted) ◀── writes ───┘        │
│  Sync adapters: tracker (Jira) · code host (GitHub)        Simulator (simulate mode)      │
└───────────────────────────────┬──────────────────────────────────────────────────────────┘
                                │ one Claude Agent SDK query() per ticket
┌───────────────────────────────▼──────────────────────────────── Agent runtime ───────────┐
│  Ticket agent: own run folder and clones, SDK sandbox, no credentials                    │
│     named sub-agents (one per allowed model × effort, plus a read-only reviewer)         │
│  Task agents (work not tied to a ticket) · Investigators (read-only questions)           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Package | What it holds |
| --- | --- |
| `contracts/events.ts` | The event contract: every event type and its payload. The single source of truth for types. |
| `contracts/tools.md` | The orchestrator tools Elfoqsy's session can call, with inputs and outputs. |
| `packages/contracts` | Zod schemas generated from the contract, the WebSocket protocol, and payload validation. |
| `packages/state` | The fold: `fold(state, event)` and `foldAll(events)`, plus derived views (narrative, analytics, layout). Shared by the daemon and the web app. |
| `apps/daemon` | Event log, server, Elfoqsy's sessions, orchestrator, gate, proxies, sync adapters, simulator. |
| `apps/web` | The two screens (React). They render state; they never fetch data themselves. |
| `prompts/` | Elfoqsy's identity, her system prompt, her first-responder prompt, and the team-skill adapter. |
| `design/tokens.css` | Every colour, size, spacing and font the screens use. |
| `mock/` | Scripted sprint and agent data for simulate mode. |

## The event contract

Every state change is an event. An event is an envelope:

```ts
interface EventEnvelope<T> {
  seq: number;     // assigned by the log, strictly increasing
  id: string;      // ULID
  ts: string;      // ISO 8601, UTC
  source: 'orchestrator' | 'jira' | 'github' | 'agent' | 'elfoqsy' | 'simulator';
  type: T;         // for example 'run.created', 'tool.called', 'approval.requested'
  payload: ...;    // typed per event in contracts/events.ts
}
```

Event types are grouped by prefix: `ticket.*` and `pr.*`/`ci.*` (what the adapters synced), `run.*` (an agent's lifecycle, goal, steps, verdict, result), `tool.*` and `subagent.*` (what hooks saw), `action.*`, `approval.*`, `grant.*` and `change.*` (the gate and the proxies), `elfoqsy.*` (her messages and activity), `decision.*` (what she decided for the user), `handoff.*`, `ability.*`, `layout.changed` and a few more.

Rules for the contract:

- Types are defined once, in `contracts/events.ts`. Everything else imports them from `@elfoqsy/contracts`.
- Payloads are validated against their zod schema when they are appended. An event that does not parse is not written.
- Events are never edited or deleted. A correction is a new event.
- Every string in a payload passes through the redactor (`apps/daemon/src/redact.ts`) before it is written, so tokens and keys never reach the log, the screens or a model that reads the log.

## The event log and the fold

The log is one SQLite table: `seq INTEGER PRIMARY KEY, id, ts, type, source, payload JSON` (`apps/daemon/src/eventLog.ts`). Nothing else is persisted as state.

The screens connect over WebSocket and send `hello { fromSeq }`. The server replays every event after `fromSeq`, sends `live`, and then streams new events as they are appended. A reconnect is a replay from the last `seq` the screen saw.

Both screens build their state with the same pure function, `fold(state, event)` in `packages/state`. The daemon uses the same fold for its own view of the world (what Elfoqsy is told at the start of a turn, what the orchestrator checks before a start). Because the fold is pure and the log is complete:

- the same log always gives the same screens, on any machine;
- simulate mode is only a different event source;
- a bug report can carry the log, and replaying it reproduces what the user saw;
- derived text such as a ticket's narrative ("What we know") is folded from the agent's reports, so no model writes it and it cannot drift from the evidence.

## Where the Claude Agent SDK runs

The SDK runs in four kinds of session, with very different powers.

**Elfoqsy's conversation session.** Long-lived, fed through streaming input. It has no file or shell tools. Its tools are the orchestrator functions in `contracts/tools.md`, exposed through an in-process SDK MCP server and allowed under `permissionMode: 'dontAsk'`, plus `WebSearch` and `WebFetch`. It loads none of the user's Claude Code setup: `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`, an empty working folder and an allowlisted environment. She can plan, explain and ask, and she can change the world only by asking the orchestrator to start, steer or stop a run. She cannot answer an approval.

Before her reply is posted, the orchestrator checks it against what her tools returned in that turn (`elfoqsy/fidelity.ts`): a sentence that gives a cause for something a tool dropped or refused, when no tool gave that cause, sends the reply back to her once with what the tools did return.

Her prompt is `prompts/identity.md` (who she is: a fox-themed teammate with a bilingual English and Vietnamese voice) followed by `prompts/elfoqsy-system-prompt.md` (how she works). `readHerPrompt` in `elfoqsy/prompts.ts` builds it; the identity comes first and loosens none of the rules. Work sessions (agents, investigators) never get the identity. Lines the workspace posts in her voice without a model turn are written in both languages in code and picked by the language of the user's latest message (`tr(en, vi)` in `elfoqsy/voice.ts`). Everything that is work (code, commits, PRs, tickets, reports) stays English.

**Her first responder.** One short session per agent question or escalation (`decisions/responder.ts`, prompt `prompts/elfoqsy-responder.md`): her model at medium effort, read-only lookups, her memory, and two ways to finish, `answer` or `escalate`. Every source she cites must be something a lookup returned in that session, a memory fact, or an earlier decision of the user; anything else is refused in code. After five minutes the question goes to the user with no suggestion.

**Investigators.** Read-only sessions Elfoqsy starts to answer a question that needs real reading across the code. They return findings with sources into her conversation.

**Agent runs.** One `query()` per ticket, started by the orchestrator when Elfoqsy calls `spawn_agent`, and task agents for work not tied to a ticket (`start_task`). Details below.

**Authentication.** Every session runs on the user's Claude Code login. The daemon refuses to start when an API key or a third-party provider switch is set, and strips those variables from every session. When Claude refuses work for a usage limit, new work pauses, Elfoqsy says so once, and a working run is paused (not failed) and resumes after the reset.

## The orchestrator

`apps/daemon/src/agents/orchestrator.ts` is plain TypeScript. It never calls a model. It:

- prepares run folders and enforces one run per ticket and the agents-at-once cap (`MAX_PARALLEL_AGENTS`, or the user's setting);
- enforces budgets: `AGENT_MAX_MINUTES` of working time (not time waiting for the user) and `AGENT_MAX_TOKENS`, checked every 15 seconds;
- wires hooks to the event log;
- owns every permission decision, through the gate and the capability proxies;
- holds the run to the ticket workflow;
- ends runs and cleans up their folders.

Keeping power in readable code and judgement in the model sessions is the main safety property of the design.

### An agent run

- **Its own clones.** A run folder under `WORKTREES_ROOT` holds one clone per repository the ticket touches, on `feature/<TICKET-KEY>`. Clones are made from a bare mirror the workspace keeps per repository (`agents/mirrors.ts`), never from the user's own clones, and given the code host as their only remote. After each run the mirror is checked with `git fsck` and rebuilt if anything is wrong.
- **No credentials.** No GitHub token, SSH agent, cloud or Anthropic variables; git's global config and credential helpers are emptied; kube and AWS config files point into a private folder the run cannot read. When the agent runs `git push`, the orchestrator pushes the run branch itself.
- **The SDK sandbox.** Shell commands run in the SDK sandbox (`sandbox.enabled`, `failIfUnavailable: true`): writes only to the run folder, its ticket folder and a shared package cache; reads in the home only what the run needs (`denyRead` on the home with an `allowRead` list); network only to package registries and the code host's download hosts. A run refuses to start without the sandbox. `apps/daemon/test/sandbox-proof.test.ts` proves the boundary against the real binary with no model call.
- **Sub-agents.** The `agents` option defines one named sub-agent per allowed model and effort (for example `sonnet-5.5-high`) and a `reviewer` that is offered file reads only. The gate refuses other names, per-call model overrides and more than `MAX_PARALLEL_SUBAGENTS` at once.
- **Hooks.** Every tool call and every sub-agent start and stop becomes an event (`tool.called`, `tool.finished`, `subagent.*`). This is what moves the dots on the right screen.
- **`canUseTool`.** The shell gate (`gate/policy.ts`, `gate/shell.ts`) parses each command. Edits, tests and commits inside the run folder are free. Remote tools typed in the shell (kubectl, aws, gh, docker, Jira CLIs) are refused with the proxy to use instead. Force-push, deleting a remote branch, and pushing main or any branch but the run's are refused however they are written. The file tools (Read, Write, Edit) run outside the sandbox, so the gate decides them on the real path, links resolved.
- **The run's tools.** An MCP server with the run's own tools: `declare_goal`, `begin_step`, `heartbeat`, `report_verdict`, `report_result`, `ask_user`, `record_assumption`, `request_check_approval`, and the capability proxies `kube`, `aws`, `gh`, `jira`, `confluence`, `logs`, `docker` and `shop`.
- **Done means evidence.** The agent declares the checks that prove its ticket done. A run counts as succeeded only when every check has passing evidence: a command that passed, CI on the pushed branch head, or the user's approval. Evidence is tied to a fingerprint of the code and goes stale when the code changes.
- **Isolation.** Auto-memory is off; the repositories' `CLAUDE.md`/`AGENTS.md` go into the first turn as text.

A run ends when its turn finishes with no open PR, or when its PR is merged or closed. Its folder is removed once the run is closed and nothing in it is uncommitted or missing from the code host; otherwise it is kept and offered as the starting point of the next run on that ticket.

### The ticket workflow

Elfoqsy does not decide how a ticket is fixed. When the user agrees to work on a ticket, she writes a **handoff** (`write_handoff`): the user's own messages copied word for word by the workspace, their constraints quoted from those messages, and facts that each carry a source the agent can check. The orchestrator drops any fact without a source or that reads as a cause or a fix. Her own theories never reach the agent.

The orchestrator then holds the run to a workflow (`agents/workflow.ts`), chosen by the ticket type and a mode (normal, read-only, hotfix on a release branch, remediation):

- **Verdict before code.** No edit or commit in the repositories before `report_verdict`. A bug needs the reported symptom reproduced; a story gives an input → output example. Verdicts that stop the run (already fixed, expected behaviour, not reproduced) come with a proposed ticket comment the user approves or not.
- **Decisions are recorded, not asked.** Agents ask only before an action that touches other people or a shared environment in a way their PR cannot undo. Everything else they decide and record (`record_assumption`); risky kinds (a visible contract change, a cache bypass) are flagged for the user to decide at review.
- **Review before push.** One fresh-context `reviewer` sub-agent reads the diff, the handoff and the acceptance criteria (written into the run folder by the orchestrator, read-only), and reports each criterion as MET, NOT MET or CANNOT TELL. An unexplained NOT MET holds the hand-back.
- **The narrative.** Seven sections ("What we know": understanding, verdict, reproduction, root cause, fix, verification, hand-back) are folded from the agent's reports. The PR description is written from the same reports.

## The approval gate

Agents hold no credentials. Every remote action, read or write, goes through a capability proxy (`apps/daemon/src/permissions/`) that classifies it into a tier, an action kind and an environment, and runs it with the user's credentials only if the tier allows. Every proxied action is logged (`action.classified`, `action.finished`), since the remote systems cannot tell an agent's action from the user's.

| Tier | What happens | Examples |
| --- | --- | --- |
| 0 | Runs at once, logged | Reading tickets, docs, PRs and CI; non-prod logs; `kubectl get/describe/logs`; `aws describe/list/get` |
| 1 | Recorded, runs at once, Elfoqsy says it in one line, undoable | Pushing the run branch, opening its PR as a draft, linking it in the ticket, filling empty fields of the user's own ticket, re-running its failed CI, changing the test harness on dev |
| 2 | Asked first (batched), or covered by a live grant; recorded, then run | Marking a PR ready, comments, transitions, writes on staging or integration, reading a secret, pushing an image |
| 3 | Refused; Elfoqsy tells the user it is theirs | Merging, anything on prod, force-push, main or master, renaming a branch, deploying a product service, `kubectl apply`, deleting pods, configmaps and secrets |

- **Environments** come from `config/environments.yaml`: kube contexts, AWS profiles, namespaces, log applications, and the test-harness deployments agents may change. Anything resolving to prod is tier 3; an environment marked as not the team's is tier 2 for every call; any other name is refused. Each run gets its own kubeconfig with only the configured non-prod contexts.
- **Record before change.** A tier-1 or tier-2 write records its target and earlier state first (`change.recorded`). Undo replays the recorded inverse through the same proxy and tier rules.
- **Grants.** "Allow for this ticket" on a tier-2 approval creates a grant for the same kind, ticket and environment, for 8 hours or until the run ends.
- **Batching.** Tier-2 requests within 3 seconds share one card.
- **Output is redacted** at the one exit of `Proxies.perform`. Environment variable values and credential fields are hidden in free reads (`permissions/hide.ts`); reads that mint credentials are never done; arguments that make a proxy read a local file are refused.
- **The aws CLI accepts any unique prefix of an option**, so guarded options are matched by prefix, and a shortened form of a guarded option is refused.

### Elfoqsy decides first

Every agent question and every tier-2 request reaches Elfoqsy before the user (`decisions/firstResponder.ts`). The orchestrator works out a category from how the proxy classified the request (never a model): `run_folder`, `sourced_answer`, `ci_rerun`, `harness_kube`, `notify_people`, `staging_write`, `read_secret`, `prod_logs`, `irreversible`, and others. The user sets each category to *decide*, *decide and tell me*, or *ask me*. A delegated request is decided at once in her name with no model call; a question goes to her responder, which answers from cited sources or escalates. Everything escalated reaches the user as a card with her recommendation. When the user comes back after time away, a digest lists what she decided meanwhile, each with Undo or Change.

### Elfoqsy's own reads and web

Her session has the tier-0 operations of four proxies as tools of her own (`kube`, `aws`, `gh`, `logs`), through the same handlers as an agent's, so what she reads is tiered, redacted and logged. Anything that would be asked or refused for an agent is refused to her: her session never asks and never changes anything.

`WebSearch` and `WebFetch` run in her own Claude Code process, so a `PreToolUse` hook (`elfoqsy/web.ts`) checks every outgoing request (`checkOutbound` in `redact.ts`): no secret, internal host, repository, local path, code or encoded data. A fetch's host is resolved first, so a public name for a private address is refused. These checks are heuristics.

## Adapters: where integrations plug in

The daemon talks to the outside world through two kinds of adapter, and both write only events.

**Sync adapters** (`apps/daemon/src/adapters`) are the extension point for new trackers and code hosts. Each is one small class behind an interface in `adapters/types.ts`:

```ts
interface TrackerAdapter {
  readonly id: string;                    // "jira"
  readonly projects: readonly string[];   // ticket key prefixes it owns: SHOP in SHOP-123
  currentTickets(): Promise<Ticket[]>;    // the current sprint or cycle, all or nothing
}

interface CodeHostAdapter {
  readonly id: string;                    // "github"
  openPullRequests(repo: string, projects: readonly string[]): Promise<HostPullRequest[]>;
  pullRequest(repo: string, number: number, projects: readonly string[], fallbackTicket: string): Promise<HostPullRequest>;
}
```

- `JiraTracker` (`adapters/jira.ts`) reads the open sprints through Jira Cloud REST v3. `GitHubHost` (`adapters/github.ts`) reads PRs and their checks through the `gh` CLI, and links each PR to a ticket by the key in its branch or title.
- `sync/sources.ts` holds the sync logic, written only against the interfaces: `syncTracker` and `syncCodeHost`. It also looks up a PR that left the open list once, to learn whether it was merged or closed.
- `sync/tracker.ts` remembers what the log last said and emits only changes (`ticket.synced`, `ticket.removed`, `pr.synced`, `ci.status`). `sync/poller.ts` polls every 60 seconds with backoff. A sync that fails part-way emits nothing.

To support another tracker (Linear, GitHub Issues) or code host (GitLab), implement one interface, map its data onto the contract's `Ticket` or `PullRequest`, and pass it to the poller in `main.ts`. The screens and the fold need no change. `apps/daemon/test/sync.test.ts` has a ten-line in-memory tracker as an example.

The adapters cover the sprint and its pull requests. The full ticket view, ticket edits and ticket drafts are still Jira-specific (`jira/tickets.ts`, `jira/writer.ts`); moving them behind the tracker interface is the next step.

**Capability proxies** (`apps/daemon/src/permissions`) are the extension point for what agents may do remotely. A new proxy classifies each request into a tier, an action kind and an environment, records before it changes, and returns redacted output. Log reads through Coralogix (`logs`) are an optional integration: without `CORALOGIX_API_KEY` the tool says log reads are not available.

**The team skill.** A team can bring its own Claude Code skill for working a ticket. Each run takes a read-only copy (`skill/teamSkill.ts`, its hash in `run.skill_snapshot`), and an adapter prompt (`prompts/skill-adapter.md`) settles where the skill and the workspace's rules disagree. See `skill-adapter.md`.

## Abilities

Abilities are short procedures Elfoqsy and her agents learn from real work, stored as Claude Code skills in `data/skills` (its own git repository; `abilities/`). Each session gets a read-only copy as a local plugin and loads a skill's content only when it calls `Skill`. A skill grants nothing: the copy keeps only descriptive frontmatter, shell expansion in skills is disabled, and the gate still decides every tool a skill names. Each read step is verified as a tier-0 read when the ability is written; each use is measured against a baseline, so the screens can show steps saved.

## Simulate mode

`pnpm dev:sim` starts the daemon with `--simulate`. `apps/daemon/src/sim` writes a scripted sprint and scripted agents (from `mock/`) into a separate log, at the times they happened, then keeps them moving: sub-agents come and go, heartbeats arrive, answers and messages get a reaction. The real tier policy runs over simulated backends, so grants, batching, Undo and Elfoqsy's lines behave as they do live. It never touches Jira, GitHub or a model, and costs no tokens.

Because the screens are folds, they cannot tell simulate mode from live mode.

## Telemetry

Every session the daemon starts exports Claude Code's own OpenTelemetry to a receiver in the daemon on 127.0.0.1 (`telemetry/`). Each session is tagged with its kind, run, ticket and conversation. Nothing leaves the machine.

## Flows

### Starting an agent

1. The user types "start an agent on SHOP-3546" → `elfoqsy.message`.
2. Elfoqsy writes the handoff (`handoff.created`) and calls `spawn_agent({ ticketKey, handoffId })`.
3. The orchestrator checks the ticket, the cap, the repositories and the user's usage, prepares the run folder, emits `run.created`, and starts `query()` with the handoff as the first instruction.
4. Hooks emit `tool.*` and `subagent.*`; the agent's tools emit `run.goal_declared`, `run.step_begun`, `run.heartbeat`.
5. The right screen draws the agent on its thread from Elfoqsy, its step ring, and its sub-agents.

### An approval round trip (tier 2)

1. The agent marks its PR ready through the `gh` proxy. The proxy classifies it as tier 2, finds no grant, and the category is *ask me*, so Elfoqsy's responder looks into it. The proxy emits `action.classified` and `approval.requested` (the exact command, redacted, with her suggestion) and waits.
2. The card appears in the conversation; the agent shows as waiting on the right screen.
3. The user answers → `approval.resolved`: Approve once, Allow for this ticket, or Deny. On approve, the proxy records the change, runs it and tells the agent.

### CI fails on an agent's PR

1. The code-host adapter sees a failed check on a PR linked to a run → `ci.status`.
2. The orchestrator reads the failed job's log (a read), redacts it, keeps the tail, and sends it to the run as a new turn.
3. The agent fixes it and pushes again (tier 1).

## Trade-offs

- **SQLite, one process, one machine.** Cheap, private and simple. A hosted version would swap the event store and the run launcher, not the screens or the contract.
- **Polling instead of webhooks.** A local daemon cannot receive webhooks without a tunnel; polling is fine for one user.
- **Per-run clones and the SDK sandbox instead of containers.** Fast, and enough for one trusted user.

## Known limits

- **WebFetch and DNS rebinding.** WebFetch runs in the session's own process, outside the sandbox. The hook resolves the host before the call, but the fetch resolves it again, so a host whose address changes between the two could reach a private address.
- **Outbound checks are heuristics.** They catch the shapes in the tests, not every way of hiding data in a query.
- **The file tools are outside the sandbox.** The gate decides them; the sandbox bounds shell commands only.
