# clothaid

**Agent-agnostic agentic-workflow CLI.** Run it inside a project to _reckon_ it and install,
migrate, or optimise a disciplined AI-agent workflow — one source-of-truth operating contract with
thin per-agent adapters (Claude Code, Cursor, Copilot) — then keep it honest: ranked,
evidence-cited audit findings with a persistent ledger, drift measured against a committed
baseline, and context-budget accounting.

Distilled from a production workflow refined over 120+ agent sessions and validated against a
corpus of real repositories (its detectors are corpus-tested).

> **Why "agent-agnostic"?** clothaid writes **one** contract (`AGENTS.md`) and generates thin
> pointer files for each agent. Every assistant reads the same rules; you never maintain three
> divergent instruction sets.

**Status:** pre-publish. The npm release is deliberately held until the foundation has proven
itself in daily use; the versioning/publish infra is ready.

## Install (once published)

```bash
npx clothaid init
# or
npm i -D clothaid
```

Requires Node ≥ 18.17. Until then: `npm run build && node dist/cli.js …` from a checkout.

## Quick start

```bash
cd your-project
clothaid init      # interactive: reckon → score → mode → leash → plan → apply → baseline
clothaid audit     # ranked, evidence-cited findings across every lens + the ledger diff
```

`init` scans the project, shows a maturity scorecard, confirms your workflow profile (solo/team),
lets you pick a setup mode and the leash (operational constraints), previews every file, and only
writes on your confirmation — a hand-edited file is never silently overwritten. It finishes by
writing the **committed baseline** (`.clothaid/baseline.json`) that drift is measured against.

## Commands

| Command            | What it does                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `clothaid init`    | Reckon + install/migrate/optimise the workflow (interactive). `-y` = defaults, never overwrites.                                              |
| `clothaid scan`    | Deterministic reckoning → the `.clothaid` cache. `--json` to print it.                                                                        |
| `clothaid score`   | Maturity scorecard (profile-aware) + suggested setup mode.                                                                                    |
| `clothaid audit`   | All lenses: ranked findings (risk → gap → polish) + lens coverage + ledger diff. `--lens gate-integrity`, `--truth`, `--json`, `--no-ledger`. |
| `clothaid doctor`  | Alias for `audit --truth` — "is the recorded reckoning still true?"                                                                           |
| `clothaid context` | Always-loaded context footprint (Cursor-scoped-rule aware) + extraction candidates.                                                           |
| `clothaid brief`   | Grounded briefing your in-repo agent completes. `--human` for onboarding.                                                                     |
| `clothaid gates`   | Install the free local git-hook gates (process → pre-commit, correctness → pre-push).                                                         |

Run against another directory with `--cwd <dir>`. Full guide: [`docs/usage.md`](docs/usage.md).
Design record: [`docs/design/`](docs/design/) (001 founding · 002 foundation re-lock).

## The audit engine

`clothaid audit` runs **lenses** over the reckoning and reports through one finding schema —
claim · evidence (file/job) · why it matters · action · effort · confidence — ranked risk → gap →
polish, cheapest first. Every report declares its own coverage: which lenses ran, what they could
NOT see (inherited CI templates, server-side thresholds), and why. Findings persist in a
**committed ledger**: re-runs show new / resolved / regressed, and a finding you dismissed with a
reason never resurfaces.

Shipping lenses:

- **contract-drift** (truth) — commands, artifacts, and layout vs the committed baseline.
- **gate-integrity** — the CI ↔ local gate inventory: checks enforced only in CI (failures surface
  one slow pipeline after push — `clothaid gates` is the paired fix), checks only in skippable
  local hooks, and latent gaps (coverage collected but nothing local gates on it; commitlint
  installed but unwired). `allow_failure` jobs count as advisory, never as gates.
- **maturity** — the rubric's gaps as actionable findings.

## What `init` installs

- **`AGENTS.md`** — the single source of truth: stack, the leash (working rules incl. hard org
  policy vs soft preference), an advisory repo map with its re-verify command, composition-point
  and conventions scaffolds, the definition of done (from your real scripts), a session protocol.
- **Per-agent adapters** — `CLAUDE.md`, `.cursor/rules/agents.mdc`, `.github/copilot-instructions.md`.
- **`PROJECT_CONTEXT.md`** _(optional)_ — a read-first ground-truth state doc.
- **Local gates** _(optional)_ — tracked `.githooks/` + `core.hooksPath`: a process gate at
  pre-commit and a correctness gate at pre-push built from your own check commands (a writing
  command can never enter the gate).
- **`.clothaid/baseline.json`** — the approved reckoning (commit it); the scan cache stays
  gitignored.

## The reckoning is agent-orchestrated

The deterministic scan gathers facts; the _semantic_ layer (composition points, reuse inventory,
conventions, "what this project is") is completed by the agent already in your repo. `clothaid
brief` writes the grounded briefing; you point your agent at it; you approve the result before it
becomes the contract. No API keys, and it dogfoods the very workflow it installs — as does this
repo itself (see its `AGENTS.md`).

## Programmatic use

```ts
import { scanProject, scoreProject, runAudit } from "clothaid"

const facts = await scanProject(process.cwd())
const audit = await runAudit(process.cwd(), { persistLedger: false })
console.log(audit.findings[0])
```

## License

MIT
