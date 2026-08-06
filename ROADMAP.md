# etymd — roadmap

One objective governs everything here: **keep your agent instructions true**. An item that does
not serve it does not ship. Decision record: [`docs/decisions/003-truth-guard-pivot.md`](docs/decisions/003-truth-guard-pivot.md).

## Now (prove it in daily use)

- **Daily-driver validation on the corpus.** Run `etymd audit` routinely on the sibling repos
  (the workspace-fullstack corpus as the clean control; cra-legacy/spa-bff as the findings-rich cases); fix every false positive at
  the heuristic level. Model passes so far: workspace-fullstack 24→0 (command-position matching,
  extensionless-token=prose, workspace-relative resolution); the `yarn nx` class (nx-monorepo 1→0) —
  a command that resolves to an installed `node_modules/.bin` binary is true, not a stale script,
  and is unverifiable (skipped + disclosed) when `node_modules` is absent; and the workspace-fullstack-main
  pass (4→2, 2026-07-25): dotted prose like Better-Auth's `create/update.after` needs a
  _recognized_ extension to be a file claim, and a missing-but-gitignored claim (`apps/api/.env`)
  is machine-local — unverifiable, skipped + disclosed. Current corpus baseline: workspace-fullstack 2
  (context-economy, real), cra-legacy 4, spa-bff 5 (3 real stale-path), nx-monorepo 0. **First external gate is
  live:** the workspace-fullstack corpus repo’s pre-push hook runs `etymd audit --fail-on risk` via the sibling checkout
  (an external MR) — the CI half follows once etymd has a remote.

### Shipped since 003

- **Fleet mode, slices 1–2** (2026-07-30/31, decision record
  [`docs/decisions/004-fleet-truth-guard.md`](docs/decisions/004-fleet-truth-guard.md)): the
  `state-freshness` truth lens (git-committer-date staleness, relative — a dormant repo's old
  state is current; decisions format checks; `Revisit:` debt), then the `fleet` command family —
  manifest loader for both shapes, `fleet` sweep with per-project delta rendering,
  `fleet check` manifest validation, `fleet dismiss`/`accept` with corp persistence beside the
  manifest, and the fleet-scope wall findings. Registry + fleet `--json` schemas are
  experimental through 0.2.x.

- **Scoped audits + two new skip classes** (2026-07-28), both harvested from the oss-fork first
  audit and both proven on it:

  - **`.etymd/config.json`** (committed, every key optional) — `instructions.include` /
    `instructions.exclude` globs and `context.perFileWords` / `context.totalWords` budgets, which
    were code constants until now. A file rather than a package.json key, because the corpus holds
    a repo with no manifest and a fork that must not touch upstream's. The honesty rule is
    structural: excluded files are counted and **named** in the disclosures, and malformed config
    is disclosed rather than silently defaulted — scoping must never buy a quietly clean report.
  - **Create-this and stand-in path claims** — a path the surrounding prose instructs _creating_
    (migration quarantine dirs, generated output) is forward-looking, not stale; a naming
    stand-in (`my-custom-skill`, `your-*`) was never a claim. One plain reference anywhere in the
    file still makes a path a live claim, so a stale path cannot hide behind a single mention.
  - **oss-fork result** — 56 → 51 findings from the skip classes alone, then 51 → 3 once the
    upstream skills directory is excluded: instruction-truth drops to **zero**, the fork's own
    layer (CLAUDE.md, plus its design docs pulled in by an include glob) is clean, and the 3 that
    remain are the deliberate CI-only gate gaps. The rest of the corpus is unmoved (workspace-fullstack 2,
    nx-monorepo 0, spa-bff 5, cra-legacy 4, vscode-extension 0, docs-only 0), so no real finding was skipped away.

- **Corpus grown to 7** (2026-07-26): vscode-extension (first etymd-scaffolded contract in daily
  use), docs-only (docs-only, no manifest), oss-fork (large fork, 29KB CLAUDE.md, symlinked
  AGENTS.md — onboarding pending). First `init` dogfood immediately caught two classes, both
  fixed at the source: the scaffold's frameworks fallback claimed `see package.json` in repos
  that have none (pack v2), and husky v9's `.husky/_` hooksPath misread as a custom hook setup.

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

- **Config file, remaining surface**: path-heuristic ignore rules and per-finding suppressions as
  an alternative to ledger dismissal. Scope globs and context budgets shipped 2026-07-28; these
  two were the parts of the original idea nothing has yet demanded.
- **Corpus follow-ups, next sessions:**
  - **oss-fork** — the fix is proven but NOT yet committed to the fork: writing
    `.etymd/config.json` with `exclude: [".claude/skills/**"]` (+ `include: ["design/**/*.md"]`)
    is the owner's call, as is whether any skill under `.claude/skills/` is fork-owned and should
    stay in scope. The remaining 3 CI-only-gate gaps are deliberate hooks divergence from
    upstream.
  - **docs-only** — the contract deliberately says "do not start building"; as design sessions
    produce the decision record and the stack lands, the AGENTS.md fills in and `etymd audit`
    tracks each claim as it becomes checkable. First re-approve will restamp pack v1 → v2.
  - **vscode-extension** — first push exercises the new pre-push gate live; when the repo gets CI,
    gate it on `etymd audit --fail-on risk` (the second external gate after the workspace-fullstack corpus). Also
    restamps to pack v2 on next approve.
- **Baseline-aware CI recipe hardening**: document the two-job pattern (audit `--fail-on risk` on
  MRs; scheduled full audit that comments the ledger diff).
- **Context-economy deepening**: measure the delta an extraction actually buys (before/after
  words/tokens per session), so the lens's advice carries a number. Budgets are now per-repo
  configurable, so the next question is what a _right_ budget is, not where it lives.
- **AI-review gate harvest**: distill the two real advisory AI-review CI jobs living in the corpus
  (one corpus repo’s AI-review job, and the Nx monorepo's advisory `ai review`) into a `gates --ci` generator.

## Later (only if the objective still leads)

- **Fleet follow-ups, evidence-gated** (decision record + gates in
  [`docs/decisions/004-fleet-truth-guard.md`](docs/decisions/004-fleet-truth-guard.md)): sidecar
  `contractDir` audits (slice 3 — a manifest-side contract's claims verified against the corp repo
  root it describes); `fleet serve` as the read-only MCP access layer inside this package;
  `fleet init` scaffolding — not before three measured hand-scaffold events (pack v3 rides that
  slice); the standalone convention spec, held behind the dated extraction review. None of these
  is date-gated; each waits for its evidence.
- **Fleet slice-2 deliberate drops** (recorded, not silent): a `--usage` sweep-telemetry flag was
  planned and not built — it ships only if a sweep habit shows what is worth counting; the
  always-loaded context measurement names `PROJECT_CONTEXT.md` literally, so a registry
  `contract.state` override (e.g. `STATUS.md`) is freshness-checked but does not yet join
  `measureContext` — join it by artifact kind in slice 3.
- Loop metrics ingest (workspace-fullstack's `scripts/loop-metrics.mjs` output) — measurement of the loop the
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
- **Create-this path claims are never accused.** When every mention of a path sits in prose that
  instructs creating/generating/writing it, the repo is right to lack it. The cost: a genuinely
  stale path mentioned _only_ inside creation prose goes unchecked. One plain reference anywhere
  in the file restores the check.
- **Naming stand-ins are not claims.** A segment prefixed `my-`/`your-`, or named `placeholder`/
  `foo`/`bar`/`baz`/`qux`, is a shape description. A real directory actually called `my-thing`
  therefore goes unchecked.
- **Developer-machine facts are not judged from CI.** Git hook wiring (`core.hooksPath`) is absent
  from an ephemeral CI checkout by design, so in CI it is skipped and disclosed rather than flagged.
  Without this, the `audit --fail-on risk` gate this tool recommends would fail forever in every
  repo with tracked hooks — caught by etymd's own first CI run. The cost: a genuinely unwired hook
  set is only reported locally.
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
