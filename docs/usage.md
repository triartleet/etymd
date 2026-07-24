# clothaid — usage guide

A deeper walkthrough than the README. Every command is read-only unless it says it writes. The
writes are: the `.clothaid` cache/baseline/ledger, the workflow files you approve in
`init`/`gates`, and the briefing `brief` emits.

## Global options

- `--cwd <dir>` — operate on another project directory (default: current directory).
- `-v, --version`, `-h, --help`.

## The `.clothaid` directory — two lifecycles

| Path                      | Lifecycle                            | Role                                             |
| ------------------------- | ------------------------------------ | ------------------------------------------------ |
| `.clothaid/cache/`        | **gitignored** (init adds the entry) | transient scan cache, re-derivable               |
| `.clothaid/baseline.json` | **committed**                        | the approved reckoning drift is measured against |
| `.clothaid/ledger.json`   | **committed**                        | the findings memory: statuses, diffs, dismissals |

## Setup

### `clothaid scan`

Deterministically reckons the project: package manager, workspace topology (pnpm/yarn/npm/nx/
turbo/lerna), scripts classified into a **Done =** set (specific beats meta — `test:unit:local`
wins over a chaining `test`; a `--write`/`--fix` command is never classified as a check),
frameworks, CI system, git hooks (tracked `.githooks`, husky modern AND v3-legacy, custom
`core.hooksPath`, lint-staged), existing agent artifacts, solo/team signals, and a layout index
including meaningful dot-dirs. Flags: `--json`, `--no-save`.

### `clothaid score`

Grades the project against the pack rubric and suggests a setup mode (fresh / migration /
optimisation). **Profile-aware**: a team repo is not graded on solo rituals (state doc, session
archive, failure register). `--json` for the raw scorecard.

### `clothaid init`

The interactive orchestrator: reckon → confirm the **profile** (solo/team, detected from recent
commit authors) → scorecard → choose **mode** → adapters → gates + state doc → the **leash**
capture → plan preview → apply → **baseline approval**.

Mode is the reconcile posture:

- **Fresh** — full install; asks once before overwriting differing files.
- **Migration** — per-file reconcile for every existing file that differs: keep yours / take pack.
- **Optimisation** — shows what's missing; you pick which artifacts to add. Nothing else is touched.

`-y/--yes` accepts suggested defaults and **never overwrites**. A hand-edited hook is never
silently replaced. Finishes by writing `.clothaid/baseline.json` (commit it) and gitignoring the
cache.

### `clothaid gates`

Just the free local git-hook gates: process gate at `pre-commit`, correctness gate at `pre-push`
built from your detected check commands (writers can't enter it), via tracked `.githooks/` +
`core.hooksPath`. Warns before taking over from an existing husky/custom hook setup; asks per file
before replacing hand-edited hooks. `--ci` notes the CI review gate ships later.

### `clothaid brief`

Writes `.clothaid/brief.md` — a grounded briefing handing the deterministic facts to the agent
already in your repo, asking it to complete the semantic layer (what-this-is, composition points,
reuse inventory, ownership boundaries, conventions, gotchas) for your approval. `--human` writes
`.clothaid/onboarding.md` for people instead.

## Keeping it honest

### `clothaid audit`

Runs every **lens** and reports through one finding schema — claim · evidence · why · action ·
effort (S/M/L) · confidence — ranked **risk → gap → polish**, cheapest first. The report opens
with **lens coverage**: what ran, what found nothing, what could not run and why, plus honesty
disclosures (CI jobs inherited from unseen org templates; `allow_failure` jobs counted as
advisory, never as gates; script-less jobs inferred from name/variables only).

Findings reconcile against the **committed ledger**: the diff shows new / still-open / resolved /
**regressed**, and a finding dismissed with a reason never resurfaces. A partial run (`--lens`,
`--truth`) never marks unexamined findings resolved.

Flags: `--lens <id>` (e.g. `gate-integrity`) · `--truth` (doctor subset) · `--json`
(machine-stable) · `--no-ledger` (read-only).

Lenses:

- **contract-drift** (truth) — documented commands/artifacts/layout vs the baseline; dangling
  references; pack-version drift.
- **gate-integrity** — the CI ↔ local gate inventory and its three gap classes: **CI-only**
  (shift-left: a check whose failure you meet one slow pipeline after push — `clothaid gates` is
  the paired fix), **local-only** (bypass: hooks are `--no-verify`-skippable and CI never
  re-checks — suppressed when unreadable inherited templates might be running it), **latent**
  (coverage collected but nothing local gates on a number — where a Sonar server gate exists the
  finding says exactly that its threshold is not visible in the repo; commitlint installed but no
  commit-msg hook).
- **maturity** — rubric gaps as findings.

### `clothaid doctor`

Alias for `audit --truth`: "is the recorded reckoning still true?"

### `clothaid context`

Measures the **always-loaded footprint** — the files an agent reads every session (AGENTS.md,
pointers, and only the Cursor rules that are genuinely `alwaysApply`) — in words and approximate
tokens, flagging any single file heavy enough (≥ ~4000 words) to extract into an on-demand skill.
Context is the dominant cost of the loop; this is the lever that keeps it lean.

## Roadmap (designed, unscheduled)

Loop metrics · knowledge harvest from source projects · a keyless dashboard · session runner ·
org profiles · the bring-your-own-key AI-review CI job. See
[`docs/design/002-foundation-relock.md`](design/002-foundation-relock.md) for the current locked
design.
