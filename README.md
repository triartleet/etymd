# clothaid

**Agent-agnostic agentic-workflow CLI.** Run it inside a project to _reckon_ it and install,
migrate, or optimise a disciplined AI-agent workflow — one source-of-truth operating contract with
thin per-agent adapters (Claude Code, Cursor, Copilot) — then keep it honest with freshness audits,
context-budget accounting, and (coming) loop metrics and knowledge that grows from the projects it
learns from.

Distilled from a production workflow refined over 120+ agent sessions, plus lessons across several
team frontends.

> **Why "agent-agnostic"?** clothaid writes **one** contract (`AGENTS.md`) and generates thin
> pointer files for each agent. Every assistant reads the same rules; you never maintain three
> divergent instruction sets.

## Install

```bash
# one-off
npx clothaid init

# or add to a project
npm i -D clothaid
pnpm add -D clothaid
```

Requires Node ≥ 18.17.

## Quick start

```bash
cd your-project
npx clothaid init      # interactive: reckon → score → mode → leash → plan → apply
```

`init` scans the project, shows a maturity scorecard, lets you pick a setup mode and the leash
(the operational constraints), previews every file as a diff, and only writes on your confirmation.
Nothing you already hand-authored is overwritten without asking.

## Commands

| Command            | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `clothaid init`    | Reckon + install/migrate/optimise the workflow (interactive). `-y` for defaults. |
| `clothaid scan`    | Deterministic reckoning → `.clothaid/facts.json`. `--json` to print it.          |
| `clothaid score`   | Maturity scorecard + suggested setup mode.                                       |
| `clothaid context` | Always-loaded context footprint + extraction candidates.                         |
| `clothaid doctor`  | "Is this still true?" — drift/freshness audit against the tree.                  |
| `clothaid brief`   | Grounded briefing your in-repo agent completes. `--human` for onboarding.        |
| `clothaid gates`   | Install the free local git-hook gates (pre-commit / pre-push).                   |
| _planned_          | `metrics` · `harvest` · `dashboard` · `session` · `profile`                      |

Run against another directory with `--cwd <dir>`. See [`docs/usage.md`](docs/usage.md) for the full
guide and [`docs/design/v0.0.1-design.md`](docs/design/v0.0.1-design.md) for the design.

## What it installs

- **`AGENTS.md`** — the single source of truth: stack, the leash (working rules), a repo-map
  skeleton, the definition of done (from your real scripts), and a session protocol.
- **Per-agent adapters** — `CLAUDE.md`, `.cursor/rules/agents.mdc`, `.github/copilot-instructions.md`,
  each a thin pointer to `AGENTS.md`.
- **`PROJECT_CONTEXT.md`** _(optional)_ — a read-first ground-truth state doc.
- **Local gates** _(optional)_ — tracked `.githooks/` + `core.hooksPath`: a process gate at
  pre-commit and a correctness gate (format/typecheck/lint) at pre-push.

## The reckoning is agent-orchestrated

The deterministic scan gathers facts; the _semantic_ layer (composition points, reuse inventory,
"what this project is") is completed by the agent already in your repo. `clothaid brief` writes the
grounded briefing; you point your agent at it; you approve the result before it becomes the
contract. No API keys, and it dogfoods the very workflow it installs.

## Programmatic use

```ts
import { scanProject, scoreProject, measureContext } from "clothaid"

const facts = await scanProject(process.cwd())
const card = scoreProject(facts)
console.log(card.score, card.suggestedMode)
```

## License

MIT
