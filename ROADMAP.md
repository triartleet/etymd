# etymd — roadmap

One objective governs everything here: **keep your agent instructions true** — an instruction
being anything told to an agent, in a file or in the prompt
([010](docs/decisions/010-premise-the-task-is-an-instruction.md)). An item that does not serve it
does not ship. Decision record: [`docs/decisions/003-truth-guard-pivot.md`](docs/decisions/003-truth-guard-pivot.md).

## Now (prove it in daily use)

- **Daily-driver validation.** Run `etymd audit` routinely on real repositories of different
  shapes and fix every false positive at the heuristic level, never by suppressing a finding.
  Classes fixed this way so far: command-position matching, extensionless tokens read as prose,
  workspace-relative resolution, commands that resolve to an installed `node_modules/.bin`
  binary (unverifiable, skipped and disclosed when `node_modules` is absent), dotted
  hook-notation prose like `create/update.after` (a file claim needs a _recognized_ extension),
  and missing-but-gitignored claims (machine-local: unverifiable, skipped and disclosed). A
  pre-push hook running `etymd audit --fail-on risk` is the first external gate in daily use.

### Shipped since 003

- **`etymd propose`** (decision record
  [`docs/decisions/012-propose-rubric-scored-proposals.md`](docs/decisions/012-propose-rubric-scored-proposals.md)):
  the scoring step between the sweep and a filed proposal — improvement findings and recurring
  classes scored against a fleet-authored rubric file (`criterion: <weight>` labeled lines;
  four computable criteria, unknown names refused quoting the line), emitted as deterministic
  `proposal/1` records with an evidence-derived implications block. Read-only; guarded entries
  excluded from the output entire.
- **`etymd premise`** (decision record
  [`docs/decisions/010-premise-the-task-is-an-instruction.md`](docs/decisions/010-premise-the-task-is-an-instruction.md)):
  the task an agent is handed is an instruction too — what it names is verified against the repo
  with the shared truth checks, and a brief hands the agent the premises only it can verify.
  Deterministic by construction (005); no ledger; zero trace without `.etymd/`.
- **Fleet mode, slices 1–2** (2026-07-30/31, decision record
  [`docs/decisions/004-fleet-truth-guard.md`](docs/decisions/004-fleet-truth-guard.md)): the
  `state-freshness` truth lens (git-committer-date staleness, relative — a dormant repo's old
  state is current; decisions format checks; `Revisit:` debt), then the `fleet` command family —
  manifest loader for both shapes, `fleet` sweep with per-project delta rendering,
  `fleet check` manifest validation, `fleet dismiss`/`accept` with guarded persistence beside the
  manifest, and the fleet-scope wall findings. Registry + fleet `--json` schemas are
  experimental through 0.2.x.

- **Scoped audits + two new skip classes** (2026-07-28):

  - **`.etymd/config.json`** (committed, every key optional) — `instructions.include` /
    `instructions.exclude` globs and `context.perFileWords` / `context.totalWords` budgets, which
    were code constants until now. A file rather than a package.json key, because a repo may have
    no manifest, and a fork must not touch upstream's files. The honesty rule is
    structural: excluded files are counted and **named** in the disclosures, and malformed config
    is disclosed rather than silently defaulted — scoping must never buy a quietly clean report.
  - **Create-this and stand-in path claims** — a path the surrounding prose instructs _creating_
    (migration quarantine dirs, generated output) is forward-looking, not stale; a naming
    stand-in (`my-custom-skill`, `your-*`) was never a claim. One plain reference anywhere in the
    file still makes a path a live claim, so a stale path cannot hide behind a single mention.

- **First `init` dogfood** (2026-07-26) immediately caught two classes, both fixed at the source:
  the scaffold's frameworks fallback claimed `see package.json` in repos that have none (pack
  v2), and husky v9's `.husky/_` hooksPath misread as a custom hook setup.

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
- **Baseline-aware CI recipe hardening**: document the two-job pattern (audit `--fail-on risk` on
  MRs; scheduled full audit that comments the ledger diff).
- **Context-economy deepening**: measure the delta an extraction actually buys (before/after
  words/tokens per session), so the lens's advice carries a number. Budgets are now per-repo
  configurable, so the next question is what a _right_ budget is, not where it lives.

## Later (only if the objective still leads)

- **Fleet follow-ups, evidence-gated** (decision record + gates in
  [`docs/decisions/004-fleet-truth-guard.md`](docs/decisions/004-fleet-truth-guard.md)): sidecar
  `contractDir` audits (slice 3 — a manifest-side contract's claims verified against the guarded repo
  root it describes); `fleet serve` as the read-only MCP access layer inside this package;
  `fleet init` scaffolding — not before three measured hand-scaffold events (pack v3 rides that
  slice); the standalone convention spec, held behind the dated extraction review. None of these
  is date-gated; each waits for its evidence.
- **Fleet slice-2 deliberate drops** (recorded, not silent): a `--usage` sweep-telemetry flag was
  planned and not built — it ships only if a sweep habit shows what is worth counting; the
  always-loaded context measurement names `PROJECT_CONTEXT.md` literally, so a registry
  `contract.state` override (e.g. `STATUS.md`) is freshness-checked but does not yet join
  `measureContext` — join it by artifact kind in slice 3.
- Watch-mode / git-hook integration (`etymd audit --truth` as a pre-push step).
- More instruction dialects as they standardize (new agent config locations).
- Editor surfacing (problems-panel via `--json`) — but LSP/autofix stay agnix's lane; re-evaluate
  before ever entering it.

## Known limitations (accepted trade-offs, not bugs)

- **The pre-push hook stages only `.shellcheckrc`, and reads only an unquoted
  `external-sources=true`.** shellcheck also reads a config named `shellcheckrc` (no dot), and
  accepts quoted values such as `external-sources="true"` (its man page, RC FILES). A repo using
  either form gets the checker's default settings in the hook, or unfollowed helpers, where a
  checkout would have applied them. Recorded rather than fixed until a user needs it; both are
  pinned as known gaps in the checkout-parity table in `test/gates.test.ts`, which turns red
  the day they are fixed.
- **Extensionless file references go unchecked.** `lib/barcode-scan` (no extension, no trailing
  slash) is treated as prose — the rule that killed the extensionless-prose-path
  false-positive class. A dir claim needs a trailing `/`; a file claim needs a _recognized_
  extension (`KNOWN_EXTENSIONS` in claims.ts — an unknown suffix like `.after` is prose, the
  rule that killed the dotted hook-notation class). A real file with an exotic extension
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
- **A script a pushed commit did not touch is not re-checked.** The pre-push shellcheck step reads
  only what each commit changes; an untouched script carries bytes a previous push already
  checked. The commit that installs or changes the gate, its classifier, or a `.shellcheckrc` is
  checked whole, so a repo's existing scripts are read once at adoption. The cost: a commit
  pushed with `--no-verify` is never re-read by a later push; a periodic whole-tree
  `shellcheck` run closes that gap.
- **A hook generated before the generation stamp existed cannot be proven untouched.** It has no
  stamp, so `etymd gates` keeps it rather than regenerating — stating the reason and the way out
  instead of the old silent `kept (hand-edited)`. One regeneration makes it provable from then on.
  The asymmetry is deliberate (decision
  [006](docs/decisions/006-local-gate-provenance.md)): a stamp can prove a file is safe to
  replace, never that it is unsafe.
- **A companion (`<hook>.local`) without the execute bit is not counted as enforcement.** The
  generated hook guards the call with `[ -x ]`, so such a file never runs; the lens mirrors that
  and reports it as inert rather than crediting checks that do not fire. Where the execute bit is
  not a meaningful question (no POSIX mode bits), the checks are counted rather than a dead gate
  invented.
- Precision over recall throughout: a false "your file is lying" costs more trust than a missed
  lie. Every skip class is disclosed in the lens report.
