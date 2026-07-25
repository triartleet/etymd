# etymd — roadmap

One objective governs everything here: **keep your agent instructions true**. An item that does
not serve it does not ship. Design record: [`docs/design/003-truth-guard-pivot.md`](docs/design/003-truth-guard-pivot.md).

## Now (prove it in daily use)

- **Daily-driver validation on the corpus.** Run `etymd audit` routinely on the sibling repos
  (pepshop as the clean control; cra-legacy/spa-bff as the findings-rich cases); fix every false positive at
  the heuristic level. Model passes so far: pepshop 24→0 (command-position matching,
  extensionless-token=prose, workspace-relative resolution); the `yarn nx` class (nx-monorepo 1→0) —
  a command that resolves to an installed `node_modules/.bin` binary is true, not a stale script,
  and is unverifiable (skipped + disclosed) when `node_modules` is absent; and the pepshop-main
  pass (4→2, 2026-07-25): dotted prose like Better-Auth's `create/update.after` needs a
  _recognized_ extension to be a file claim, and a missing-but-gitignored claim (`apps/api/.env`)
  is machine-local — unverifiable, skipped + disclosed. Current corpus baseline: pepshop 2
  (context-economy, real), cra-legacy 4, spa-bff 5 (3 real stale-path), nx-monorepo 0. **First external gate is
  live:** pepshop's pre-push hook runs `etymd audit --fail-on risk` via the sibling checkout
  (pepshop MR 161) — the CI half follows once etymd has a remote.

### Shipped since 003

- **Ledger management commands** — `etymd dismiss <id> --reason "…"` (false positive, reason
  required), `etymd accept <id>` (known trade-off), `etymd ledger` (list by status). Both dismiss
  and accept quiet the finding from future audits while keeping it tracked; a later fix still counts
  as resolved. Engine: `resolveEntry` in `src/engine/ledger.ts`.
- **`etymd approve`** — non-interactive baseline refresh: shows the structural drift vs the old
  baseline (commands/artifacts/layout), preserves the approved profile, rewrites `baseline.json`.
  Requires an existing baseline (points to `init` otherwise). Chose the dedicated verb over an
  `audit --update-baseline` flag so approval stays an explicit act, not an audit side-effect.
- **`prepare` script** (`"prepare": "npm run build"`) — git-URL installs and fresh checkouts now
  self-build while npm publish stays held.

## Next

- **Config file** (`.etymd/config.json` or package.json key): context budgets, extra instruction
  globs, path-heuristic ignore rules, per-finding suppressions as an alternative to ledger
  dismissal. Today's budgets (4000 w/file, 8000 w total) are code constants, disclosed in output.
- **Baseline-aware CI recipe hardening**: document the two-job pattern (audit `--fail-on risk` on
  MRs; scheduled full audit that comments the ledger diff).
- **Context-economy deepening**: measure the delta an extraction actually buys (before/after
  words/tokens per session), so the lens's advice carries a number.
- **AI-review gate harvest**: distill the two real advisory AI-review CI jobs living in the corpus
  (pepshop's claude-review, nx-monorepo's `ai review`) into a `gates --ci` generator.

## Later (only if the objective still leads)

- Loop metrics ingest (pepshop's `scripts/loop-metrics.mjs` output) — measurement of the loop the
  instructions serve.
- Watch-mode / git-hook integration (`etymd audit --truth` as a pre-push step in guarded repos).
- More instruction dialects as they standardize (new agent config locations).
- Editor surfacing (problems-panel via `--json`) — but LSP/autofix stay agnix's lane; re-evaluate
  before ever entering it.

## Pre-publish checklist (publish is HELD by the owner)

1. **Claim the npm name** — `etymd` verified available 2026-07-24; the hold is squat exposure.
   First publish claims it (no placeholder-squatting; publish the real 0.0.1).
2. `package.json`: add `repository` / `homepage` / `bugs` once a remote exists; review the
   `author` field for the public identity the owner wants.
3. Activate CI (`.github/workflows/ci.yml` is ready; needs the GitHub remote).
4. Competitive re-check: has agnix / agents-lint added baselines, ledgers, or budgets since
   July 2026? Positioning in 003 assumes they have not.
5. Changeset + `npm run release` (changesets config is in place).

## Known limitations (accepted trade-offs, not bugs)

- **Extensionless file references go unchecked.** `lib/barcode-scan` (no extension, no trailing
  slash) is treated as prose — the rule that killed the `research/trust` / `milestone/mNN`
  false-positive class. A dir claim needs a trailing `/`; a file claim needs a _recognized_
  extension (`KNOWN_EXTENSIONS` in claims.ts — an unknown suffix like `.after` is prose, the
  rule that killed the Better-Auth hook-notation class). A real file with an exotic extension
  goes unchecked as the accepted cost.
- **Gitignored path claims are never accused.** A claimed path that is missing but matched by
  `.gitignore` (`.env` files, local caches) is machine-local by design — skipped and disclosed,
  since its absence in one checkout does not make the instruction false anywhere else.
- **Package-relative paths** resolve only against workspace roots plus their `src/` and
  `scripts/` sub-roots. Deeper prose-relative prefixes (e.g. relative to `apps/x/src/lib/`) are
  not chased.
- **Workspace-filtered commands** (`pnpm --filter x test`) are skipped, counted, and disclosed —
  not resolved into the target package.
- **Sonar/server-side thresholds** cannot be read from the repo; findings say exactly that.
- Precision over recall throughout: a false "your file is lying" costs more trust than a missed
  lie. Every skip class is disclosed in the lens report.
