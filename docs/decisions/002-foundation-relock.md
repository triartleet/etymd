# 002 — Foundation re-lock (post multi-agent E2E review)

_Supersedes parts of [001-founding.md](001-founding.md). 001 remains the founding record;
where they disagree, this document wins._

## Why

Before building further on v0.0.1, the whole utility went through a three-agent adversarial E2E
review — product/strategy, architecture/code, and corpus-reality (validated file-by-file against
the corpus repos). The reviews converged on four foundation gaps,
a verified defect cluster, and one strategic correction. The owner locked three decisions and this
rework implemented them. Cost accepted deliberately: better to re-lock early than to discover the
gap under a mature implementation.

## The strategic correction

The moat is **not** the scaffolding (a good agent reproduces most of a template skeleton) and not
context-counting per se. It is the **measured, re-runnable, reconciling, drift-guarded discipline
proven on real repos**: idempotent merge-not-clobber setup, a committed baseline that drift is
measured against, ranked evidence-cited findings with a persistent memory, and corpus-validated
detectors. Everything in this re-lock serves that.

## Owner decisions (locked)

1. **Advisor = one engine, one command.** A shared findings engine (one `Finding` schema, a `Lens`
   interface, a committed ledger); `clothaid audit` runs all lenses; `doctor` is the alias for the
   truth-lens subset. `score`/`context` migrate onto lenses over time.
2. **Gate-integrity lens first** after the foundation rework; metrics next.
3. **Publish = HOLD.** Infra stays ready (changesets, exact pins, build); npm waits until the
   foundation earns it. The 5 "planned" stub commands were removed from the CLI surface; a
   ROADMAP.md records undelivered plans at some later point.

## What the rework changed

### The versioned knowledge pack (`src/pack/`)

Templates and the maturity rubric moved out of code into the pack — versioned (`PACK_VERSION`),
diffable (the future `harvest` target), stamped into facts, baselines, and generated AGENTS.md.
Nothing outside `pack/` may hardcode template content.

### The findings engine (`src/engine/`)

One `Finding` schema (id · lens · tier risk/gap/polish · claim · evidence · why · action · effort ·
confidence) and a `Lens` interface with honest coverage reporting (`ran`/`skipped` + disclosures).
A **committed ledger** (`.clothaid/ledger.json`): open/accepted/done/dismissed(reason)/regressed;
re-runs are diffs; dismissed never resurfaces; a resolved finding that reappears is named a
regression. Partial runs never persist resolutions for lenses that did not run.

### Baseline vs cache (`src/core/facts.ts`)

The transient scan cache (`.clothaid/cache/`, gitignored — init appends it to the target's
.gitignore) is now distinct from the **committed baseline** (`.clothaid/baseline.json`, written at
init approval, pack-versioned, carrying the confirmed solo/team profile). Drift is measured
against the baseline — previously every look at the project reset what "drift" meant.

### Lenses (`src/lenses/`)

- **contract-drift** (truth): commands/artifacts/layout vs baseline; dangling state-doc reference
  (now read from the actual AGENTS.md text); pack-version drift disclosure.
- **maturity** (improvement): the rubric's gaps as findings.
- **gate-integrity** (improvement) — the first flagship lens: a deterministic **gate inventory**
  (local hooks incl. husky v3 + lint-staged; GitLab CI incl. `extends`, `!reference`, local
  includes, script-less jobs; GitHub workflows; tool registry; thresholds), then gap findings in
  three classes: **CI-only** (shift-left — the lead finding; `clothaid gates` is the paired fix),
  **local-only** (bypass — suppressed when unreadable inherited templates might run the check),
  **latent** (coverage collected but no local threshold — the script-less-coverage case; commitlint unwired).
  **Honesty rules are structural:** `allow_failure`/`continue-on-error` ⇒ advisory, never an
  enforced gate; org-template `include:`s ⇒ disclosed as unseen inventory; server-side Sonar
  thresholds ⇒ phrased as living on the server with no local mirror; script-less jobs ⇒
  name/variable inference marked `scriptVisible: false` and disclosed.

### Modes made real (`init`)

Mode is now the reconcile posture, not a label: **Fresh** may overwrite (asked once) · **Migration**
reconciles each differing file (keep yours / take pack) · **Optimisation** adds only the missing
artifacts the user picks. `-y` never overwrites. Solo/team **profile** is detected from recent
commit-author cardinality, confirmable at init, recorded in the baseline; the rubric does not grade
team repos on solo rituals (state doc, session archive, failure register).

### Defect cluster fixed (corpus-verified)

- Classifier ladders: specific beats meta (`test:unit(:local)` over a chaining `test`);
  `test:format`/`prettier -l` recognised as the format **check**; typecheck can no longer match
  codegen (`generate:types`); a **writing command can never enter a correctness gate**
  (`isSafeGateCommand` guards the pre-push generator).
- husky v3 (`husky.config.js` / package.json `husky` key) and custom `core.hooksPath` detected;
  `gates`/`init` warn before installing a second hook system; hand-edited hooks are never silently
  overwritten (content-diff + per-file consent).
- Rubric: failure-register can reach "present" (failure-modes skill/doc artifacts); one adapter +
  contract = complete (Cursor reads AGENTS.md natively); team profile bias removed.
- `context` reads Cursor `.mdc` frontmatter — only `alwaysApply: true` (or frontmatter-less) rules
  count as always-loaded.
- Meaningful dot-dirs (`.github`, `.claude`, `.githooks`, …) enter the tree/map.
- ANSI width regex fixed (ESC char); empty-array `Math.max` guards; shebang on the cli build only.

### Self-dogfood

clothaid now carries its own `AGENTS.md` (this standard, hand-completed), `CLAUDE.md` pointer,
wired `.githooks` (format:check + typecheck + test on pre-push), and a CI workflow ready for a
remote. The corpus smoke tests in `test/corpus.test.ts` are the regenerate-and-verify harness's
first embodiment — they already caught one real miss (a script-less coverage job in a corpus repo) during this
rework.

## Deferred (recorded, not lost)

- `metrics` (ingest workspace-fullstack's `loop-metrics.mjs` output) — next after the gate lens beds in.
- Harvesting the two real AI-review CI jobs (two corpus repos' advisory AI-review jobs) into pack
  templates for `gates --ci`.
- `context` as a measured lever (perform/track extraction, before/after deltas), `harvest`,
  `dashboard`, `session`, `profile`, extra adapters — designed in 001 §6, unscheduled.
- `repository`/`homepage`/`bugs` in package.json + activating CI — when a remote exists
  (pre-publish checklist).
- ROADMAP.md — owner-timed.
