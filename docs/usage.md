# etymd — usage guide

A deeper walkthrough than the README. Every command is read-only unless it says it writes. The
writes are: the `.etymd` cache/baseline/ledger, the files you approve in `init`/`gates`, and the
briefing `brief` emits. Probing a repo that never opted in (`audit --no-ledger`) leaves zero trace.

## Global options

- `--cwd <dir>` — operate on another project directory (default: current directory).
- `-v, --version`, `-h, --help`.

## The `.etymd` directory — two lifecycles

| Path                   | Lifecycle                            | Role                                             |
| ---------------------- | ------------------------------------ | ------------------------------------------------ |
| `.etymd/cache/`        | **gitignored** (init adds the entry) | transient scan cache, re-derivable               |
| `.etymd/baseline.json` | **committed**                        | the approved reckoning drift is measured against |
| `.etymd/ledger.json`   | **committed**                        | the findings memory: statuses, diffs, dismissals |

## `etymd audit` — the command

Verifies every instruction claim against the repo and reports through one finding schema — claim ·
evidence (file/job) · why it matters · action · effort (S/M/L) · confidence — ranked **risk → gap
→ polish**, cheapest first. The report opens with **lens coverage**: what ran, what found nothing,
what could not run and why, plus honesty disclosures (unreadable org-template CI includes;
`allow_failure` jobs counted as advisory; skipped heuristics).

Findings reconcile against the **committed ledger**: the diff shows new / still-open / resolved /
**regressed**, and a finding dismissed with a reason never resurfaces. A partial run (`--lens`,
`--truth`) never marks unexamined findings resolved.

Flags: `--lens <id>` · `--truth` (doctor subset) · `--json` (machine-stable) · `--no-ledger`
(read-only) · `--fail-on <risk|gap|polish>` (exit non-zero at/above the tier — the CI gate).

### The lenses

**`instruction-truth`** (truth) — over AGENTS.md, CLAUDE.md, GEMINI.md, Copilot instructions,
`.cursorrules`, `.cursor/rules/*`, `.clinerules`, `.claude/skills/*/SKILL.md`:

- **Command claims**: `pnpm X` / `yarn X` / `npm run X` / `npm test` references must name a real
  script. Package-manager built-ins are ignored; workspace-filtered invocations
  (`pnpm --filter …`) are skipped and counted in the disclosure.
- **Path claims**: single-token repo-relative references must exist. Conservative by design —
  absolute paths, globs, URLs, `@scope/pkg` specs, `$param` route segments are skipped; capped
  per file; every skip class disclosed.
- **Package-manager consistency**: a file repeatedly commanding a different PM than the lockfile's
  is flagged.
- **Cross-references**: mentions of AGENTS.md / CLAUDE.md / PROJECT_CONTEXT.md / GEMINI.md must
  resolve to real files.
- **Baseline drift**: role commands (test/lint/typecheck/format/build), artifacts, and top-level
  dirs that existed at the approved baseline and are now gone.

**`gate-integrity`** — the CI ↔ local gate inventory (GitLab incl. `extends`/`!reference`/local
includes/script-less jobs, GitHub workflows, husky modern + v3-legacy, lint-staged, `.githooks`),
three gap classes: **CI-only** (shift-left — `etymd gates` is the paired fix), **local-only**
(bypass — suppressed when unreadable inherited templates might run the check), **latent**
(coverage collected but no local threshold — server-side Sonar gates are named as living on the
server; commitlint installed but unwired).

**`context-economy`** — the always-loaded footprint as findings: any single file ≥ 4000 words,
total ≥ 8000 words (defaults; configuration is a later release). Only genuinely `alwaysApply`
Cursor rules count.

## `etymd init` — onboarding

Reckon → confirm the workflow profile (solo/team, detected from recent commit authors) → scaffold
a minimal AGENTS.md **only if none exists** → offer local gates **only if no hook system exists**
→ write the **committed baseline** + gitignore the cache. Never overwrites anything. `-y` accepts
defaults.

The scaffold contains only what the scan can assert truthfully (stack, Done=, commands, an
advisory map with its re-verify command) plus clearly marked slots — `etymd brief` hands your
in-repo agent a grounded briefing to complete the semantic layer, and `etymd audit` then holds
the result to account.

## The rest

- **`etymd doctor`** — alias for `audit --truth`.
- **`etymd context`** — the per-file economy view of the same data the lens uses.
- **`etymd gates`** — tracked `.githooks/` + `core.hooksPath`; the pre-push gate is built from
  your own detected check commands, and a writing command (`--write`/`--fix`/codegen) can never
  enter it. Warns before taking over from husky/custom hooks; never silently replaces a
  hand-edited hook.
- **`etymd scan`** — the deterministic reckoning (package manager, workspace, script
  classification, hooks incl. husky v3, CI, instruction artifacts, layout). `--json`.
- **`etymd brief`** — writes `.etymd/brief.md` (or `--human` for onboarding people).

## CI recipe

```yaml
- run: npx etymd audit --json --fail-on risk
```

Commit `.etymd/baseline.json` + `.etymd/ledger.json`; keep `.etymd/cache/` ignored. Refresh the
baseline by re-running `etymd init` after intentional structural changes.
