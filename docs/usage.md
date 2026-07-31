# etymd — usage guide

A deeper walkthrough than the README. Every command is read-only unless it says it writes. The
writes are: the `.etymd` cache/baseline/ledger, the files you approve in `init`/`gates`, and the
briefing `brief` emits. Probing a repo that never opted in (`audit --no-ledger`) leaves zero trace.

## Global options

- `--cwd <dir>` — operate on another project directory (default: current directory).
- `-v, --version`, `-h, --help`.

## The `.etymd` directory — two lifecycles

| Path                   | Lifecycle                            | Role                                                                              |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `.etymd/cache/`        | **gitignored** (init adds the entry) | transient scan cache, re-derivable                                                |
| `.etymd/baseline.json` | **committed**                        | the approved reckoning drift is measured against                                  |
| `.etymd/ledger.json`   | **committed**                        | the findings memory: statuses, diffs, dismissals                                  |
| `.etymd/config.json`   | **committed**, optional              | audit scope (include/exclude) + context budgets — see the README's config section |

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

**`state-freshness`** (truth) — the "this describes now" layer (`PROJECT_CONTEXT.md`,
`DECISIONS.md`, `docs/adr/`, `docs/decisions/`, `NNNN-*.md` under `docs/`), judged by git
committer dates only, never mtime:

- **Relative staleness**: a state doc is flagged only when the repo moved past it
  (`staleAfterDays`, default 30; 3x escalates to risk) — a dormant repo's old state is current,
  and a tracked file with uncommitted edits is treated fresh-now with a disclosure.
- **Char budget**: state docs over 9,500 chars (session-injection hooks truncate ~10,000).
  Override both under `state` in `.etymd/config.json`.
- **Decisions format checks** (`Scope:` presence, past `Revisit:` dates): opt in by adding the
  literal marker `<!-- decisions-format: 1 -->` anywhere in the decisions file — forward-only,
  never retroactive. Duplicate / out-of-order `D-NNN` ids are flagged with a rename action even
  without the marker. Decisions artifacts are exempt from age — old decisions are history.

**`context-economy`** — the always-loaded footprint as findings: any single file ≥ 4000 words,
total ≥ 8000 words (defaults; override under `context` in `.etymd/config.json`). Only genuinely
`alwaysApply` Cursor rules count.

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
- **`etymd approve`** — the non-interactive baseline refresh: re-reckon and restamp
  `.etymd/baseline.json` after intentional structural changes, without the `init` dialogue.
- **`etymd ledger`** — print the findings memory: every tracked finding with its status
  (open / accepted / done / dismissed / regressed) and first/last-seen history.
- **`etymd dismiss <id> --reason <text>`** — record that a finding is noise or a deliberate
  choice; it stays out of reports unless it regresses. The reason is kept in the ledger.
- **`etymd accept <id>`** — acknowledge a finding as accepted reality (e.g. a known trade-off);
  visible in the ledger, out of the report.

## `etymd fleet` — the truth guard across your repositories (EXPERIMENTAL through 0.2.x)

One manifest, `registry.json`, registers every repo you work in (format in the README's
"fleet manifest" section; design record in `docs/design/004-fleet-truth-guard.md`). The sweep
runs a read-only audit per resolved entry and checks the manifest itself plus the placement
wall between personal and corp entries.

```bash
cd ~/projects/my-fleet-hub            # the dir holding registry.json …
etymd fleet                            # … or: etymd fleet --manifest path/to/registry.json
```

The report is one line per project — `name · state-age/staleAfterDays · open counts by tier ·
Δ vs last sweep` — with detail blocks only for new or risk findings. The delta baseline lives in
`last.fleet.json` beside the manifest (local-only: gitignore `*.fleet.json`); a filtered sweep
(`--only`, `--profile`, `--truth`) reports but never moves the baseline.

Flags: `--only <names…>` · `--profile <personal|corp>` · `--truth` · `--persist-ledgers` ·
`--json` (schema `fleet-experimental-0.2`) · `--fail-on <tier>`. `--manifest` is required unless
the cwd holds `registry.json` — deliberately no env var and no global pointer.

Walkthrough of the pieces:

- **`etymd fleet check`** — validates the manifest pair only, no lenses, non-zero exit on any
  finding: parse errors, dangling path/dir mappings (a renamed worktree leaves a ghost entry
  that looks covered and is swept by nothing — this catches it), duplicate names, a private
  entry leaking a `path`, dead link targets, absolute `/Users/` paths in the tracked file.
- **`etymd fleet dismiss <name> <id> --reason "…"` / `etymd fleet accept <name> <id>`** — the
  one-command loop that keeps a fleet report green AND honest. Personal entries resolve into
  that repo's `.etymd`; corp entries into `<manifest-dir>/corp/<name>/.etymd/` (created there if
  missing — the corp worktree is never touched). If the id is not yet recorded, a persisting
  single-repo audit runs internally first.
- **Persistence rules** (each pinned by test): the sweep never creates `.etymd` anywhere;
  `--persist-ledgers` applies only to personal entries that already opted in; corp worktrees
  take zero writes under every flag combination; and after a sweep, zero corp-resolved content
  exists under the manifest repo's tracked paths.
- **Fork freshness**: an entry with `"upstream": "origin"` is dated on fork-authored commits
  only (`HEAD --not --remotes=origin`) — merged upstream traffic cannot make the fork's state
  look stale, and a pure mirror reads as dormant. A missing remote falls back to the full clock
  with a disclosure.
- **Wall findings** (lens id `fleet-manifest`, all risk-tier): corp contract files inside a corp
  worktree; unregistered corp-remote checkouts under the fleet root; tracked `/Users/` paths in
  the manifest's own repo; private needles in `trust: "public-repo"` entries; corp-host commit
  emails on personal entries. These are not ledger-quietable in 0.2 — the only honest resolution
  is fixing them. Every check that cannot run says so.

## CI recipe

```yaml
- run: npx etymd audit --json --fail-on risk
```

Commit `.etymd/baseline.json` + `.etymd/ledger.json`; keep `.etymd/cache/` ignored. Refresh the
baseline with `etymd approve` after intentional structural changes.
