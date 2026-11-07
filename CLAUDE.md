# Notes for coding agents

Elfoqsy is a local-first orchestrator that runs one coding agent per ticket, with an approval gate and full replay. Read `docs/architecture.md` before changing the daemon, and `docs/ui-spec.md` before changing the screens.

## Ground rules

- TypeScript strict, pnpm workspaces. Shared types come from `contracts/events.ts` through `packages/contracts`; never redefine an event or payload type elsewhere. A new event goes into the contract first, with its zod schema.
- Both screens are folds over the event stream (`packages/state`). Never fetch data directly from a UI component; if the screen needs something, it becomes an event.
- The event log is append-only. Never edit or delete events; a correction is a new event. Every payload is redacted before it is written.
- The orchestrator never calls a model. Permission decisions stay in readable code (the gate and the capability proxies), never in a prompt.
- Do not weaken a tier, a gate rule or a redaction to make a test pass. If a safety test fails, fix the code or ask.
- Colours, type and spacing come only from `design/tokens.css`.
- Check Claude Agent SDK signatures against the official TypeScript reference before using them.
- Never commit secrets, and never put a real token, hostname, name or ticket in a fixture or test. Use the Acme Shop fakes (projects SHOP, CORE, OPS; repos `acme/shop-api`, `acme/shop-worker`, `acme/shop-shared`; the user "Alex").
- Lines Elfoqsy says without a model turn are written in both languages, `tr(en, vi)`; work text (code, commits, PRs, tickets) stays English.

## Working in the repo

- `pnpm install`, then `pnpm dev:sim` runs everything on scripted data with no accounts and no tokens.
- Run `tsc` per package and read its exit code; the recursive root typecheck can hide a failing package.
- Tests: `pnpm test`, or `npx vitest run <file>` inside a package. Tests never reach Jira, GitHub or a model; use the fakes in `apps/daemon/test/helpers`.
- When the docs and the code disagree, stop and ask in your summary rather than guess which one is right.
