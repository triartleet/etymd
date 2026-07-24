# clothaid — usage guide

A deeper walkthrough than the README. Every command is read-only unless it says it writes, and the
only writes are: `.clothaid/` cache files, the workflow files you approve in `init`/`gates`, and the
briefing `brief` emits.

## Global options

- `--cwd <dir>` — operate on another project directory (default: current directory).
- `-v, --version`, `-h, --help`.

## The pipeline

`init` runs the whole thing interactively; each stage is also a standalone command.

```
scan ──▶ score ──▶ (mode) ──▶ (leash) ──▶ plan ──▶ apply
 │         │                                          │
 └ facts.json                                         └ AGENTS.md + adapters + gates
```

### `clothaid scan`

Deterministically reckons the project and caches `.clothaid/facts.json`:

- package manager (from lockfile / `packageManager`), workspace topology (pnpm/yarn/npm/nx/turbo/lerna),
- the `scripts` classified into a **Done =** set (test / lint / typecheck / format / build / dev),
- frameworks (from dependencies), CI system, git-hook state,
- existing agent artifacts (AGENTS.md, CLAUDE.md, Cursor, Copilot, Cline, Windsurf, Gemini, skills…),
- a top-level layout index with bounded file counts.

Flags: `--json` (print, don't render), `--no-save` (don't cache).

### `clothaid score`

Grades the project against the standard (operating contract, per-agent adapters, navigation map,
state doc, session protocol, gate tiers, failure register) and suggests a setup mode:

- **fresh** — no workflow yet,
- **migration** — a workflow exists but is below the bar,
- **optimisation** — a mature workflow to refine.

Uses the cached reckoning if present, else scans. `--json` for the raw scorecard.

### `clothaid init`

The interactive orchestrator. Steps: reckon → scorecard → choose mode → choose per-agent adapters →
choose gates + state doc → a short **leash** capture (may the agent commit unasked? is `gh`
available? are changes ticket-linked?) → **plan** (a create/exists diff of every file) → confirm →
**apply**. Existing hand-authored files are skipped unless you opt to overwrite. `-y/--yes` accepts
all suggested defaults non-interactively.

### `clothaid gates`

Installs just the free local git-hook gates: a process gate at `pre-commit` and a correctness gate
at `pre-push` (runs your detected format-check / typecheck / lint, cheapest first), via tracked
`.githooks/` + `git config core.hooksPath .githooks`. `--ci` acknowledges the advisory AI-review CI
job (planned). `-y` skips the prompt.

### `clothaid brief`

Writes `.clothaid/brief.md` — a grounded briefing that hands the deterministic facts to the agent
already in your repo and asks it to complete the **semantic** layer (composition points, reuse
inventory, ownership boundaries, gotchas), grounded in real files, for your approval. `--human`
writes `.clothaid/onboarding.md` for people instead.

## Keeping it honest (post-setup)

### `clothaid context`

Measures the **always-loaded footprint** — the files an agent reads every session (AGENTS.md, the
pointers, Cursor rules) — in words and approximate tokens, and flags any single file heavy enough
(≥ ~4000 words) to extract into an on-demand skill. Context is the dominant cost of the loop; this
is the lever that keeps it lean.

### `clothaid doctor`

Asks "is this still true?" — compares the cached reckoning and the contract's claims to today's
tree: documented commands that no longer exist, artifacts that vanished, top-level dirs the repo map
still lists, hooks installed but `core.hooksPath` unset. `--json` for CI.

## Planned commands

`metrics` (loop measurement vs a baseline) · `harvest` (grow the knowledge pack from source
projects) · `dashboard` (a keyless local metrics/status surface) · `session` (session runner) ·
`profile` (shareable org presets). Designed; reserved for coming releases.

## Files clothaid manages

| Path                                                                       | Role                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `.clothaid/facts.json`                                                     | cached reckoning (gitignore it)                 |
| `.clothaid/brief.md`                                                       | agent briefing (transient)                      |
| `AGENTS.md`                                                                | operating contract — the single source of truth |
| `CLAUDE.md`, `.cursor/rules/agents.mdc`, `.github/copilot-instructions.md` | per-agent pointers                              |
| `PROJECT_CONTEXT.md`                                                       | ground-truth state (optional)                   |
| `.githooks/pre-commit`, `.githooks/pre-push`                               | local gate tier (optional)                      |
