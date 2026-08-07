# etymd

## 0.3.0

### Minor Changes

- Content screening, a registration gate, and gates that can be regenerated without loss.

  **`etymd screen` — a content screen with no opinions of its own.** Four scopes for the four ways
  content leaves a repository: `--staged` (a commit), `--message` (the message, which the staged
  scan cannot see), `--tree` (everything tracked), and `--dir` (an unpacked build artifact). The
  last exists because the others share a blind spot — they answer "what is in the repository?",
  while `npm` and `vsce` ignore `.gitignore`, so a local file can ship to users while every
  git-scoped check passes forever.

  It ships **no patterns and never will**: the strings worth screening for are themselves the
  sensitive material. You supply a pattern file; without one the command is inert and says so,
  rather than reporting clean for a check it did not run. A repository naming itself is exempt, and
  a repo-level allow file covers lines that cannot carry an inline marker — a scanner's own source
  necessarily contains the patterns it screens for.

  **`etymd gates` generates all four doors**, including a `commit-msg` hook and a publish-time
  screen wired to the key the project's publish route actually runs (`vsce` ignores
  `prepublishOnly`). Generated hooks resolve the screener at run time and no-op when it is absent,
  so the same file is safe to commit to a public repository.

  **Your own checks live beside the generated ones.** Each hook calls `.githooks/<hook>.local` if it
  exists — a file etymd never reads, writes, or regenerates. Regeneration no longer forces a choice
  between accepting the pack and keeping your own guards, and it will not drop a test step an
  existing hook already ran.

  **Setup is one keystroke.** `gates` shows a plan with every derivation stated and asks once;
  `customize` reaches each choice. Answers record to `.etymd/config.json`, where
  `gates._why.<field>` can carry the reason a value is what it is — dropped automatically when the
  value it explains changes, because a stale reason misleads exactly where it meant to inform.

  **`etymd fleet add`** registers a project, prompting for what no scan can derive and refusing to
  write an incomplete entry. Fleet manifests gain a mandatory `trust` level on non-corp entries —
  absence is a finding, never a silent default — a manifest-level `orientation.root` replacing
  per-entry links, and a gate-drift check that reports a repository missing a gate its siblings
  install.

## 0.2.2

### Patch Changes

- 80db483: Gate integrity: detect scripts regardless of how the package manager is invoked.

  Script expansion guessed the script name positionally — the token straight after the
  manager. That only holds for `npm run x`, `yarn x` and `pnpm x`. Every other live shape
  expanded to nothing, so the tool was never detected and the gate read as absent:

  | invocation                           | captured as the script name |
  | ------------------------------------ | --------------------------- |
  | `pnpm run typecheck`                 | `run`                       |
  | `pnpm -s typecheck`                  | `-s`                        |
  | `pnpm -r --if-present run typecheck` | `-r`                        |
  | `pnpm --filter @scope/pkg test`      | `--filter`                  |

  A pre-push hook running `pnpm run typecheck` therefore reported as having no typecheck at
  all, and `audit` said "type checking is enforced only in CI — no local hook runs it" while
  the hook ran it on every push.

  Expansion no longer guesses position — it cannot, since the position depends on each
  manager's own flag grammar. It scans the invocation's tokens for a name that is a known
  script, which needs no grammar at all. Package-manager built-ins are excluded so `npm ci`
  is never read as "runs the `ci` script"; that direction matters, because expanding it would
  claim a gate is covered by a line that only installs dependencies. `test` and `start` stay
  recognised — those genuinely are script shortcuts. `exec`/`dlx` end the scan, since what
  follows is a binary, and `npx` is only scanned for `run-s`/`run-p`/`npm-run-all`.

## 0.2.1

### Patch Changes

- fdf6b6e: Fleet sweep: recurring classes + `placement: "none"` honored.

  - **Recurring classes** — the sweep report groups open findings by their engine-minted
    class prefix and lists every class present in ≥2 projects (worst tier first). A class
    open in one repo is that repo's problem; the same class in four is a fleet lesson —
    the report now asks "repo bug or fleet bug?" structurally, instead of relying on a
    human to ask it at triage time. `--json` gains a `recurringClasses` array
    (schema still EXPERIMENTAL through 0.2.x).
  - **`placement: "none"` suppresses `no-contract`** — a registry entry declaring its
    contract files legitimately absent no longer gets the absence re-reported every sweep.
    The repo-local lens can't see the registry's declaration, so the fleet view honors it
    (a standalone `etymd audit` in such a repo still reports it — correctly, since no
    declaration is in scope there). Tier counts summarize the filtered list.

## 0.2.0

### Minor Changes

- a58d3bd: Fleet mode — the truth guard across your repositories (design record `docs/decisions/004-fleet-truth-guard.md`; registry + fleet `--json` schemas EXPERIMENTAL through 0.2.x).

  - New `state-freshness` truth lens: state/decisions artifacts dated by git committer dates only (never mtime); staleness is relative, so a dormant repo's old state is current; state char budget against the ~10k session-hook truncation; marker-gated decisions format checks (`Scope:`, duplicate/out-of-order `D-NNN` ids, past `Revisit:` dates as due review debt); ADR conventions (`docs/adr/`, `docs/decisions/`, `NNNN-*.md`) recognized natively.
  - New `etymd fleet` command family. The sweep runs a read-only audit per registered repo (`--manifest` required unless the cwd holds `registry.json` — no env var, no global pointer) and renders one line per project with a delta against `last.fleet.json`; detail only for new or risk findings. `fleet check` validates the manifest pair alone (dangling mappings, duplicate names, privacy leaks, machine paths). `fleet dismiss`/`fleet accept` resolve a project's finding from any cwd.
  - The manifest loader (`src/core/fleet.ts`) resolves both the fleet registry pair (`registry.json` + gitignored `registry.local.json`) and the legacy corpus pair (`sources.json` + `sources.local.json`); corp entries are opaque aliases resolved only through the local file, and every resolution failure is disclosed, never silently skipped.
  - Persistence invariants, pinned by tests: the sweep never creates `.etymd` anywhere; `--persist-ledgers` only persists into personal repos that already opted in; corp worktrees take zero writes under every flag combination — corp findings persist (and stay dismissible) at `<manifestDir>/corp/<name>/.etymd/`; zero corp-resolved content under the manifest repo's tracked paths.
  - Fleet-scope wall findings (lens id `fleet-manifest`): corp contract files inside a corp worktree, unregistered corp-remote checkouts under the fleet root, tracked `/Users/` paths in the manifest's own repo, private needles inside `trust: "public-repo"` entries, corp-host commit emails on personal entries.
  - Fork-aware freshness: entries with `upstream` are dated on fork-authored commits only (`HEAD --not --remotes=<upstream>`), with a disclosed fallback when the remote is absent.

## 0.1.0 — 2026-07-31

First public release.

The truth guard for agent instruction files — **keep your agent instructions true**. (Formerly
prototyped as "clothaid", a broader workflow installer; the pivot and its state-of-the-field
rationale are recorded in `docs/decisions/003-truth-guard-pivot.md`.)

- `etymd audit` — verify every instruction claim against the actual repo, through three lenses:
  - **instruction-truth**: command claims vs `package.json` scripts, path claims vs the tree,
    package-manager consistency, cross-reference integrity, and drift vs the committed baseline —
    over AGENTS.md, CLAUDE.md, GEMINI.md, Copilot instructions, Cursor rules, and skills.
  - **gate-integrity**: the CI ↔ local gate inventory (GitLab incl. `!reference`/includes/
    script-less jobs, GitHub, husky modern + v3, lint-staged) with honesty rules — advisory jobs
    are never gates, unseen templates are disclosed, server-side thresholds named as such.
  - **context-economy**: the always-loaded footprint in words/tokens; extraction candidates.
  - Ranked findings (risk → gap → polish) with evidence · a **committed ledger** (resolved /
    regressed / dismissed-never-resurfaces) · lens-coverage reporting · `--fail-on <tier>` for CI.
- **Excluding a file never resolves its tracked findings.** A finding missing from a scoped run is
  absent because nobody looked, not because it was fixed. The ledger holds those entries open
  (`lastSeen` untouched) and the diff reports them as held rather than folding them into
  "N resolved".
- **`init` baselines the repo it leaves behind.** It used to approve the scan taken _before_ its
  own scaffold, so the first baseline recorded AGENTS.md and the hooks as absent — and deleting
  them later never registered as drift, which is the baseline's whole job. It now re-scans after
  writing.
- **The committed baseline carries no machine path.** `baseline.json` used to record the scan's
  absolute root — the approver's username and directory layout — in the one file etymd tells people
  to commit and therefore publish. The root is now elided on write (`"."`; it is redundant inside
  the repo it describes). A baseline written by an older etymd is detected and disclosed with the
  fix: `etymd approve`.
- **`.etymd/config.json`** (optional, committed) — `instructions.include` / `instructions.exclude`
  globs scope which instruction files are audited (a fork keeps its own layer honest without
  auditing inherited upstream skills), and `context.perFileWords` / `context.totalWords` make the
  economy budgets per-repo. Excluded files are counted and named in the disclosures, and malformed
  config is disclosed — narrowing an audit can never quietly buy a clean report.
- `etymd init` — onboarding: approve the committed baseline, gitignore the cache, scaffold a
  minimal AGENTS.md only where none exists. Never overwrites.
- `etymd doctor` — alias for `audit --truth`.
- `etymd context` — the per-file always-loaded footprint view.
- `etymd gates` — local git-hook gates built from the repo's own check commands (writers can
  never enter the gate); pairs with the gate-integrity findings.
- `etymd scan` — the deterministic reckoning (corpus-validated detectors incl. husky v3 and
  meta-script-proof command classification). `etymd brief` — the agent briefing for the
  semantic layer.
- Zero-trace guarantee: read-only probes of foreign repos write nothing.
