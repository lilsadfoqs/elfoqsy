# Using Elfoqsy

Day-to-day use of the workspace. How it is built is in `architecture.md`; the screens' visual rules are in `ui-spec.md`.

To look around without any accounts or tokens, skip to `pnpm dev:sim` under "Other ways to run it".

## Before the first start

- Node 20.19 or later (22.5 or later for the backup command below) and pnpm. Run `pnpm install` once at the repository root.
- A `.env` at the repository root (gitignored); real environment variables win over it. Live mode needs `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECTS`, `GITHUB_REPOS` (for example `acme/shop-api,acme/shop-worker`) and `REPOS_ROOT` (the folder holding your own clones). Everything else has a default or is optional:

| Setting | Default | What it does |
| --- | --- | --- |
| `DAEMON_PORT` | 4317 | The daemon's port; the screens reach it through Vite. |
| `DATA_DIR` | `data/` in this repository | The event log, attachments, Elfoqsy's and the investigators' folders. |
| `WORKTREES_ROOT` | `~/.local/share/elfoqsy/runs` | Run folders. At most 50 characters, outside this repository and outside `REPOS_ROOT`. |
| `MAX_PARALLEL_AGENTS` | 3 | Ticket agents at work at once. |
| `AGENT_MAX_MINUTES`, `AGENT_MAX_TOKENS` | 45, 3,000,000 | A run's budget; past it, the run is stopped. |
| `AGENT_HEARTBEAT_MINUTES` | 5 | Working minutes between heartbeats; a reminder after one interval, a flag after two. |
| `USAGE_WARN_FIVE_HOUR`, `USAGE_WARN_SEVEN_DAY` | 60, 80 | Above these percentages of your plan, Elfoqsy says so in one sentence when an agent starts. It never asks, and never waits. |
| `ELFOQSY_WORKSPACE_UPDATES` | on | Elfoqsy hears about runs, flags and approvals as they happen. |
| `ELFOQSY_WEEKLY_REVIEW` | on | The weekly review, at the first start on or after Monday 09:00. |
| `JIRA_STORY_POINTS_FIELD`, `JIRA_SPRINT_FIELD` | a `customfield_…` id | The custom field ids of Story points and Sprint on your Jira site. Set them; the defaults are only examples. |
| `JIRA_ROOT_CAUSE_FIELD`, `JIRA_SOLUTION_FIELD`, `JIRA_AC_FIELD` | a `customfield_…` id | The custom field ids of Root cause, Solution and Acceptance criteria on your Jira site, if you use those fields. |
| `CORALOGIX_API_KEY` | none | Optional. A read-only Coralogix key (the DataQuerying preset) for the `logs` tool. Without it, log reads say they are not available. |
| `CORALOGIX_DOMAIN` | `us1.coralogix.com` | Your account's domain as Coralogix's domain selector names it; queries go to `https://api.<domain>/api/v1/dataprime/query`. |

  `TICKET_AGENT_MODEL` and `TICKET_AGENT_EFFORT` exist for probes only; leave them unset so ticket agents run Opus 5.5 at xhigh.
- `gh` logged in as you. The daemon reads PRs and CI with it, and does the GitHub work agents ask for under the tiers below.
- Optionally, `kubectl` and `aws` with your contexts and profiles, for agents' kube and aws calls. Which ones agents may use is `config/environments.yaml`: for Acme Shop, dev, staging and integration, by context name or cluster ARN, with their AWS profiles and namespaces. An environment you list as not your team's is asked for every call, reads included. There is no prod access. Each run gets its own kubeconfig with only those contexts, so nothing an agent does changes your current context or profile. Agents may change only the test-harness deployments you list (`shop-integration-test` in the example); product services are yours to deploy.
- Optionally, `docker`, for agents' docker calls, and your team's build script checkout under `REPOS_ROOT`, for the `shop` tool's `build-integration-test`.
- Optionally, your team's own skill for working a ticket under `~/.claude/skills/`, and your ticket folders at `~/tickets`: runs follow a copy of the skill (once its adapter is approved, see `skill-adapter.md`) and keep `case.md` and evidence in `~/tickets/<KEY>/`.
- Claude Code logged in. Elfoqsy, her investigators and the agents use your plan.

## Start and stop

From the repository root:

```sh
pnpm dev
```

This starts the daemon and the screens. Open <http://127.0.0.1:5173/left> and <http://127.0.0.1:5173/right>, one per monitor, full screen. Each screen is a fixed 1920 by 1080 stage scaled to fit.

`pnpm dev` restarts the daemon whenever its code changes, and a restart ends any agent at work. For a day of real work, run the two halves without the watcher, each in its own terminal:

```sh
pnpm --filter @elfoqsy/daemon start
pnpm --filter @elfoqsy/web dev
```

At start, the daemon prints:
- its mode, socket and log file;
- the clones it found under `REPOS_ROOT`;
- any run folders it removed or kept for closed runs.

**To stop it,** press Ctrl-C in its terminal. Any agent still working is cancelled ("The daemon stopped."), and the log is closed cleanly. If the daemon is killed instead, the next start marks the runs it finds active as failed ("The daemon restarted…") and closes their open questions; dismiss them when you have looked.

**Other ways to run it:**
- `pnpm dev:sim`: a simulated sprint with simulated agents, in `data/sim.sqlite`, started fresh each time. Nothing outside is reached. In a conversation, `do SHOP-3049` starts a simulated agent from a handoff (a bug goes Understand, Locate, Verdict, Reproduce, Fix, Prove and Hand back); `check CORE-18891` starts a read-only one, which stops at its verdict, EXPECTED_BEHAVIOR/INVALID, with Elfoqsy's proposed comment.
- `pnpm --filter @elfoqsy/daemon tail [--from <seq>]`: prints the live event stream in a terminal.

## What each screen shows

Both screens are folds over the same event log. Nothing on them is fetched any other way.

**The top line of both screens** shows what needs you, as icon and count, with the sentence on hover:
- **broken:** failed runs and failing CI on open PRs, until you dismiss them;
- **waiting:** agents waiting for your answer;
- **blocked:** tickets blocked in Jira.

Then the date and time, and a quiet line when something is off (offline, Jira or GitHub unreachable, Claude paused for a usage limit).

### Left screen: talk to Elfoqsy (`/left`)

**Sprint**
- **The orbit map:** rings are priority, size is story points, fill is Jira status, and the glyph is the type. A numbered badge marks a ticket with an agent, and open PRs orbit their ticket.
- **Ticket details:** click a ticket. The map shrinks to a dial; the arrow keys and the dial step through tickets, and the arrows name the ticket each goes to. Hover the dial and it grows over the header, naming every ticket; hover a dot for its title and workflow status. Under the dial is everything Jira shows for the ticket:
  - the parent, workflow status, priority, points and "Blocked by N", then the title with when it was created and updated;
  - its filled fields in two columns, with the empty ones folded into one line you can open;
  - Description, Solution, Impact, Acceptance criteria and Design, and for a bug Root cause;
  - any other field with a value, under its Jira name;
  - sub-tasks, linked work items grouped as Jira words them, the Confluence pages that mention it, Development (branches and PRs from GitHub, with Dismiss on a failing CI), attachments, comments and history (one line, "History · N changes", until you open it; Rank and automation are left out, and a long text's change has Show diff).

  Ticket keys anywhere in it open inside Elfoqsy, also tickets outside the sprint ("not in sprint" under the dial); Confluence links show the page's title, and other links open in a new tab. The open ticket is read from Jira again about every 10 seconds.
- **Menus, tooltips and the search** open one at a time: opening one closes the others, and a click outside or Escape closes it, putting the keyboard back where it was. Escape closes only that; it does not take you back to the map or cancel an edit.
- **Editing a ticket:** your edits go straight to Jira with your credentials.
  - Click any rich text (or "Add text") to edit it with a Jira-like toolbar; Save, or Ctrl Enter. Only a plain click edits: dragging, double and triple clicks select text so you can read and copy, and a link inside opens. A field holding something the editor cannot keep, or text the workspace masks, shows "Edit in Jira" instead.
  - Click a field's value to change it: people, selects, labels with suggestions, numbers, dates, the sprint. Click the title to change it.
  - Click the status chip for the transitions Jira offers from here; one with a screen asks for its required fields first.
  - Comments: add one (type @ to mention someone), and edit or delete your own. Linked work items: "+ Link" with a type and a ticket, × to remove one.
  - If someone changed the field while you were editing, nothing is saved: you see who, and "See theirs" shows their version. Save after that asks once, "Replace Quinn Bauer's version?": only Replace writes over theirs; Keep editing goes back.
  - A field someone else just changed is lit for a few seconds with who changed it; on the map and the dial too. A field Elfoqsy filled says "Elfoqsy, 10:20" with Undo.
- **Finding a ticket:** Ctrl K anywhere on this screen, or the magnifier under the dial's expand button. It opens in the middle of the screen over a dimmed backdrop. Type a key or words of its title; Jira is searched too, so tickets outside the sprint show with "not in sprint". Up and Down choose, Enter opens it here, Escape closes. "New ticket" at the bottom opens the create form.
- **Creating a ticket:** the form asks for the project, type, priority, summary, the Description (the same editor), sprint (the current one by default), story points, labels, links, assignee, and whatever else Jira requires for that type (a Story here needs its Acceptance criteria). Nothing reaches Jira until you press Create; the new ticket then opens, and says so if Jira did not keep its links, sprint or parent.
  - When Elfoqsy or an agent drafts one (an agent's second defect, say), a card waits for you in the conversation: Create in Jira as it is, Edit first in the form, or Discard. Only you create tickets; neither of them can, nor can the tester.
- **Handoffs:** a handoff opened from the conversation shows here: the ticket and the mode, your words as you wrote them, your constraints, the known facts with their sources, and what the workspace left out and why. Copy as Markdown gives what the agent read.
- **The story-point bar** is at the bottom left.

**Elfoqsy**
- Her portrait (broken, needs you, working, quiet) and her one line.
- The sliders button above her portrait opens what she decides for you: each kind of request set to Decide, Decide and tell me, or Ask me; your precedents, each with Remove; how many agents may work at once (6 to start with); and how many of her decisions you changed.
- Your conversations: New conversation, then Today, Yesterday and Earlier.
- Your Claude usage, for 5 hours and 7 days.

**Conversation**
- The thread with her. Anything richer than a sentence is a block: tickets, findings with sources, handoffs, an agent's verdict with its evidence, reviews, and approvals. Anything she says about a cause that no tool has confirmed is labelled a hypothesis. Her text is Markdown: code comes with its file, line numbers and the lines she means highlighted (Copy copies it), and tables can carry a coloured status dot.
- As soon as you send, she shows that she is working under her name: what she has done so far, each with a check and its tool's icon, and what she is doing now, with the seconds it has taken. It turns into her answer.
- What reaches you from an agent comes as a card: the question in one line, why in short points, the options as buttons with Elfoqsy's suggestion marked, the sources collapsed under "N sources", and "Let Elfoqsy decide this kind next time". A tier-2 action's card offers Approve, Allow for this ticket and Deny. Several asked within a few seconds come as one message, with Approve all once above them.
- When you come back after half an hour or more, she lists what she decided meanwhile ("I decided 4 things while you were away"), each with what it rests on and View, Undo or Change. To see it any time, press the checklist button at the top of her column, next to the settings: she lists what she decided since your last digest in the open conversation (or Today's), or says there is nothing new. A task agent's result comes back as a document, a table or code, with Copy.
- **Jira news:** when you come back after being away, she lists what happened in Jira meanwhile: mentions of you in comments anywhere, and others' changes, transitions and comments on tickets you are assigned to or reported, one row each with who, what, the ticket (it opens here) and the time. The checklist button shows it too, after the digest: what happened since your last digest or Jira news, or one line saying nothing did. Jira news goes back at most 72 hours, so a Monday digest still includes Friday.
- The composer takes text and attached files or screenshots.

### Right screen: watch the work (`/right`)

**Live map**
- Elfoqsy is at the centre, with one thread per agent and its ticket (or a task agent's name) at the end. Click an agent, or Tab to it and press Enter, to bring its terminal into focus; it opens if it has no pane.
- Each agent's ring grows one arc per step: green when done, blue for the current step, yellow while it waits for you, red on failure.
- Sub-agents appear beside their agent while they work.

**Terminals:** one pane per agent, tiled like Zellij. A new agent's pane opens by itself: beside the focused pane if there is room, otherwise in place of another pane, never the focused one: a finished agent's or an empty one first, one waiting for you last, and among those the one you focused least recently. Clicking an agent on the map focuses its pane, opening it (and the terminals, if hidden) when it has none.
- The header has the agent's number, its ticket (or task), model and effort, its steps as dots with the current step's name, and the sub-agent count. Split, the timeline, pause and close are in the ⋯ menu.
- Then the agent's own words, as text you can read, and each tool call as one light line: the tool's icon and name, the call, a check, a cross, a spinner or a yellow dot while it waits, how long it took, and one line of what came back. Three or more calls in a row that went well collapse into one chip ("6 reads and searches"); click it to see them. A failed call is never collapsed. A web read shows its domain. An edit shows its lines, numbered.
- The verdict is one line ("VALID reproduced") with its points under it. Where Elfoqsy answered the agent for you, a line says so and where the answer came from, with Change. A question for you shows at the end of the pane with its options.
- The log scrolls freely. It follows new work while you are at the bottom; scroll up to read, and Latest takes you back down.
- The footer is the message input, with the run's tokens against its budget; a line above it says when it is paused or flagged.
- A line whose change was recorded before it ran has an Undo button. Its tooltip says what Undo puts back.
- Keys: Alt n opens a pane, Alt and an arrow (or h j k l) moves focus, Alt + and Alt − resize.

## What agents may do, and when they ask

Agents ask far less than before: only before an action that touches other people or a shared environment in a way their PR cannot undo. Everything else they decide, record with its evidence, and list under "Decisions I made" in their hand-back and their PR description; a contract change, a cache bypass, teammates' code in a hotfix and an expected behaviour are flagged for you to decide at review.

Every question and every request below reaches Elfoqsy first. She decides what you delegated to her, answers a question only from a source she can cite (the ticket and its AC, docs, code an investigator read, logs, her memory, an earlier decision of yours), and otherwise brings it to you as a card with her suggestion. Her defaults: she decides path asks inside the run folder, questions answerable from sources and CI reruns; she decides and tells you about the test harness on dev and integration and its ECR image; she asks you about anything with no source, anything that notifies people, staging writes, secrets, prod logs and anything irreversible. A question nobody answers in 72 hours is withdrawn and its run paused; Resume it when you are back.

Agents hold no credentials. Everything they do outside their run folder goes through the orchestrator's proxies (kube, aws, gh, jira, confluence, logs, docker, shop), in four tiers:

| Tier | What happens | For example |
| --- | --- | --- |
| 0. Free | Done at once, logged | Reading Jira, Confluence, GitHub, non-prod logs, the clusters; tests, edits and commits in the run folder once its verdict allows them; docker builds and its own containers |
| 1. Do, then tell | Done at once; Elfoqsy tells you in one line; Undo where it can be put back | Pushing the run's branch; opening its PR as a draft; linking it in Jira; filling empty Root cause, Solution and AC on your ticket; re-running its failed CI; changing the test harness's image, restarting or scaling it on dev, or rebuilding it with the `shop` tool's `build-integration-test dev` |
| 2. Ask first | Approve once, Allow for this ticket, or Deny | Marking a PR ready for review; comments; transitions; any write on staging or integration; reading a secret; ECR push; workflows |
| 3. Never | Refused; Elfoqsy tells you it is yours to do | Merging; anything on prod; force-push; main or master; renaming a branch; deploying a product service; kubectl apply; deleting pods; configmaps and secrets; a container that reaches the host |

- **Allow for this ticket:** the same kind of action, on the same ticket and in the same environment, runs without asking for 8 hours or until the run ends. The approval says until when.
- **Undo:** puts a recorded change back through the same rules. Your own click is the approval a tier-2 Undo needs; a push cannot be undone (it would need a force-push).
- **Your AWS sessions:** the daemon checks each environment's profile once an hour, and any AWS call that says the session ran out marks it expired at once. The top line names the environments whose session has run out; agents that need one wait, shown paused, Elfoqsy asks you once to paste a fresh one into `~/.aws/credentials`, and they go on by themselves once it works.
- **A tester's run** (started from a test message) logs every write it would make, tier 1 or 2, and sends none.
- **The web:** agents, task agents and investigators may search and read the public web. A request is refused before it leaves if its address or query carries a secret, an internal host (an address written as the host counts, and so does a name that resolves to a private address), one of your repositories or a path in them, code, or what looks like encoded data. These are heuristics, not a guarantee.
- **Their commands** (curl, wget, `git clone`, `npm install`, a script) reach only the package registries and GitHub. Their sandbox refuses any other host when the connection is made, however the command builds the address.
- **Sub-agents** have read, edit and shell tools only; the reviewer only reads. Neither can reach the proxies, ask you anything or use the web.

### How an agent works a ticket

Elfoqsy hands it over with a handoff and starts it once you agree; you choose the mode in the conversation: normal, read-only (no edits at all), hotfix (on a release branch she asks you for when it is not clear) or remediation (Black Duck or Sonar). If you seem to be on the ticket yourself (a fresh `case.md`, or uncommitted work in your worktree), she asks first.

- **Its verdict comes before any code**, posted in the conversation, in your team skill's labels. VALID (a bug) needs the symptom from the ticket reproduced, and a similar working case compared; NEW_BEHAVIOR (a story), or an ambiguous VALID, gives one example of the expected behaviour, which goes on as a flagged decision for you to decide at review; VALID_FINDING is a remediation's. ALREADY_FIXED, EXPECTED_BEHAVIOR/INVALID or INSUFFICIENT_EVIDENCE/NOT_REPRODUCED stop the run, and Elfoqsy proposes its comment for the ticket, which you approve or not.
- **Before its first code change** it reads the repository's CI review ruleset and rules and says which input classes the change will see.
- **It decides** a visible contract change (HTTP or error codes, key formats), a cache bypass or teammates' code in a hotfix itself, flagged for your review, and goes on. A different defect it finds comes to you as a proposed ticket, never fixed in the same run.
- **Before its first push** one fresh review runs, which checks for contract changes and cache bypasses; what it finds is added to the flagged decisions, and the push goes on. Commits start with the ticket key; PR titles are `feature/SHOP-<n>: <behaviour>`; after three bot-review rounds on its PR (read from the PR's reviews) you are asked before another push. Every PR, Jira or Confluence write is checked against your writing rules first.
- **After merge and QA** (you say so, or Jira moves the ticket to Done), `case.md` is regenerated from the log and the QA notes and the solution page's draft land in `~/tickets/<KEY>/`; publishing the page is asked.

### Task agents

For work that is not tied to a ticket (reviewing a teammate's PR, a Confluence solution page, release notes, comparing what runs on integration and staging, a log analysis, Black Duck triage, QA notes), ask Elfoqsy. She starts a task agent with the model the work needs (Haiku for lookups, Sonnet for drafting, Opus for deep code work), tells you the goal and what it will deliver, and its result comes back into the conversation. It works in its own folder under the same rules as a ticket agent, never pushes, and shows on the map by its short name. She never starts work you did not ask for.

## Guiding, stopping or dismissing an agent

- **Guide it:** type in its pane and press Enter. That pauses it, gives it your message and resumes it, in one action; it then has to say its next step again.
- **Pause it to think:** Pause in its pane's ⋯ menu. The same item resumes it.
- **Stop it:** ask Elfoqsy ("stop Agent 3"). She cancels the run and tells you exactly what is left: whether the branch is on GitHub, unpushed commits, uncommitted changes, and where the folder is. Panes have no stop button.
- **Dismiss a failed run:** Dismiss on its pane's footer, or ask Elfoqsy. It stops counting as broken and leaves the map; it stays failed in history and analytics.
- **Dismiss a CI failure:** Dismiss on the PR in the ticket's details, or ask Elfoqsy. It stops counting as broken until the next CI result on that PR. The PR stays red, and nothing reaches GitHub.

A run also ends on its own: when its turn finishes with no open PR, or when its PR is merged or closed. It counts as succeeded only when every check of its plan has passing evidence.

## Where data and run folders live

| What | Where |
| --- | --- |
| The event log, the only record of everything | `data/elfoqsy.sqlite`, with `-wal` and `-shm` beside it. Never edit it. |
| Files and screenshots you attach | `data/attachments/` |
| Elfoqsy's working folder, empty on purpose | `data/elfoqsy/` |
| The investigators' working folder | `data/investigations/` |
| The simulator's log | `data/sim.sqlite` |
| Run folders | `~/.local/share/elfoqsy/runs/<TICKET>-<6 characters of the run id>/`: one clone per repository on `feature/<TICKET>`, and the run's `.tmp`. |
| Each running agent's kubeconfig | `data/runs/<runId>/`, removed when the run ends. Agents cannot read it. |

Your clones under `REPOS_ROOT` are only ever read.

**When a run's folder goes:**
- **A closed run with nothing to keep:** a run is closed once it is cancelled, its failure dismissed, or its ticket's PR merged or closed. If nothing in its folder is uncommitted (a stash counts) or missing from GitHub, the folder is removed and the log says why (`run.folder_removed`).
- **A closed run with work in it:** the folder is kept and noted once in the ticket's conversation. If it holds commits, Elfoqsy offers them as the starting point of the next run on that ticket; if you agree, that run's push lists every earlier commit and who made it.
- **A run that is not closed** keeps its folder.
- **A run started for the tester** keeps its folder only for commits GitHub lacks.

You can delete a kept folder yourself at any time; at the next start Elfoqsy forgets it.

## Backing up the event log

The log is SQLite in WAL mode, so copying `elfoqsy.sqlite` alone while the daemon runs can miss the latest events. Take a snapshot instead. It is safe while the daemon runs: it only reads the live file, and it refuses to overwrite an existing backup.

```sh
mkdir -p ~/backups/elfoqsy
node -e "new (require('node:sqlite').DatabaseSync)('data/elfoqsy.sqlite', { readOnly: true }).exec(\"VACUUM INTO '$HOME/backups/elfoqsy/elfoqsy-$(date +%F).sqlite'\")"
rsync -a data/attachments ~/backups/elfoqsy/
```

Run it from the repository root. Node may print an ExperimentalWarning for `node:sqlite`; that is fine. Attachments are kept apart from the log, which refers to them by id, so back them up too.

With the daemon stopped, copying the whole `data/` folder works as well.

**To restore:**
1. Stop the daemon.
2. Move `data/elfoqsy.sqlite` and its `-wal` and `-shm` files aside.
3. Copy the backup to `data/elfoqsy.sqlite`.
4. Start the daemon.

Keep backups outside this repository and outside the run folders. The redactor keeps tokens out of the log, but it holds ticket text and your conversations.
