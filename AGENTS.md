# AGENTS.md

Operating contract for any AI agent working in **clothaid** (Claude Code, Cursor, Copilot, and
others). This is the single source of truth; per-agent files point here. clothaid dogfoods its own
standard — this file follows the same shape the tool generates, completed by hand.

## What this project is

An **agent-agnostic agentic-workflow CLI**, distributed as the npm package `clothaid`. Run inside a
target project it _reckons_ it (deterministic scan + an agent-orchestrated semantic pass), installs
or reconciles a disciplined workflow (one source-of-truth AGENTS.md + thin per-agent adapters +
gates), and keeps it honest afterwards (audit lenses, ledger, context budget). Distilled from the
pepshop frontrunner workflow and validated against a sibling-repo corpus (`sources.json`). Solo
developer; publish to npm is deliberately HELD until the foundation earns it.

## Stack

- **Shape:** single package, npm (not pnpm — pnpm 11's build-approval gate fights a publishable
  CLI), Node ≥ 18.17, TypeScript strict, ESM-only.
- **Build:** tsup — two builds: `src/cli.ts` (binary, shebang, per-command code-splitting) and
  `src/index.ts` (programmatic surface, dts). Runtime deps external + exact-pinned.
- **Tests:** vitest (`test/`), including read-only smoke tests over the sibling corpus repos.
- **CI:** GitHub Actions workflow file ready in `.github/workflows/ci.yml` (activates on a remote).

## Working rules (the leash)

- **Reuse-first.** Before writing any new helper: check `src/core/util.ts`, the pack, the engine,
  and the ui layer — a "new" util usually exists.
- **Never commit or push unasked.** The developer drives version control.
- **Minimal diffs.** Never touch files outside the task's scope.
- **Commits stay unattributed.** No `Co-authored-by:` trailers, no "Generated with …" credits.
- **Pin every dependency to an exact version** (`.npmrc` has `save-exact=true`) — no `^`/`~`.
- **Honesty is load-bearing.** Findings/claims the tool emits must cite evidence and disclose what
  they could not see (inherited CI templates, server-side thresholds). Never dress a heuristic as
  a fact — this is the product's core value and the repo's own rule.

## Navigate narrow

Read this contract → the map below → open only the files the task needs. Prefer targeted reads
over repo-wide scans.

## Repo map

> Advisory, not authoritative — re-verify with `git ls-files src` before structure-sensitive
> changes, and update this section in the same change that moves files.

- `src/cli.ts` — commander wiring; per-command dynamic imports (keep startup thin)
- `src/commands/` — thin command adapters (scan · score · audit · doctor · context · brief ·
  gates · init); no business logic here
- `src/core/` — the deterministic engine: `scan.ts` (orchestrator) · `detect.ts` (detectors +
  classifier ladders) · `facts.ts` (cache vs committed baseline) · `score.ts` · `context.ts` ·
  `leash.ts` · `generate.ts` (planner) · `apply.ts` (idempotent writes) · `types.ts` · `util.ts`
- `src/engine/` — the findings engine: `finding.ts` (Finding/Lens/ranking) · `ledger.ts`
  (committed improvement memory) · `run.ts` (lens registry + audit composition)
- `src/lenses/` — analysis lenses: `contract-drift.ts` (truth) · `maturity.ts` ·
  `gate-integrity/` (inventory + lens)
- `src/pack/` — the VERSIONED knowledge pack: `templates.ts` · `rubric.ts` · `version.ts`
- `src/ui/` — render + theme (all terminal output goes through here)
- `test/` — vitest suites incl. `corpus.test.ts` (read-only sibling-repo smokes)
- `docs/design/` — the design record (001 founding · 002 foundation re-lock)

## Composition points

- `src/engine/run.ts` `LENSES` — the lens registry; adding a lens = registering it here +
  its own module under `src/lenses/`. Invariant: a partial run (filtered lenses) must never
  persist ledger resolutions for lenses that did not run.
- `src/engine/finding.ts` `Finding` — the ONE finding schema. score/doctor/audit all speak it;
  never introduce a parallel finding shape.
- `src/pack/` — every template/rubric change is a pack change: bump `PACK_VERSION` when meaning
  changes; nothing outside `pack/` may hardcode template content.
- `src/core/facts.ts` — cache (`.clothaid/cache/`, gitignored) vs baseline
  (`.clothaid/baseline.json`, committed). Drift is measured against the baseline, never the cache.
- `src/core/detect.ts` `ROLE_LADDERS` — command classification. Invariant: specific beats meta
  (`test:unit` over a chaining `test`), and a writing command (`--write`/`--fix`/codegen) must
  never be classified where a check belongs (`isSafeGateCommand` guards the hook generator too).
- `src/lenses/gate-integrity/inventory.ts` — the gate inventory. Honesty rules are structural:
  `allow_failure` ⇒ advisory (not a gate), inherited includes ⇒ disclosed as unseen, script-less
  jobs ⇒ name/variable inference marked `scriptVisible: false`.

## Conventions

- Prettier (no semicolons, double quotes, trailing commas, width 100); `npm run format` before
  finishing.
- kebab-case filenames; commands mirror their CLI name; comment the why, not the what.
- Every user-visible output path goes through `src/ui/render.ts` — no ad-hoc `console.log`.
- `--json` outputs are machine-stable schemas; changing them is a breaking change.

## Done =

A change is done when these are green:

- `npm run format:check`
- `npm run typecheck`
- `npm test`

## Commands

```bash
npm run build        # tsup (cli + index)
npm test             # vitest run (incl. corpus smokes; they skip if siblings absent)
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write
node dist/cli.js …   # run the built CLI
```

## Session protocol

1. Read `docs/design/002-foundation-relock.md` for the current locked design before non-trivial
   changes; `docs/design/v0.0.1-design.md` is the founding record.
2. Work in small vertical slices; keep this map and the design record current in the same change.
3. At session end, summarise what changed and what's next for the owner.
