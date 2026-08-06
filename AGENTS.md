# AGENTS.md

Operating contract for any AI agent working in **etymd** (Claude Code, Cursor, Copilot, and
others). This is the single source of truth; per-agent files point here. etymd dogfoods its own
standard — this file is audited by the tool itself, so every claim below must stay true.

## What this project is

**The truth guard for agent instruction files**, distributed as the npm package `etymd` (from
Greek _étymon_, a word's true sense, + the `.md` family it guards). One objective: **keep your
agent instructions true**. It verifies the agent context layer (AGENTS.md, CLAUDE.md, rules,
skills) against the actual repo — command claims, path claims, consistency, CI↔local gate parity,
context economy — with drift measured against a committed baseline and a regression ledger.
Distilled from a frontrunner project workflow, validated against a sibling-repo corpus
(`sources.json`). Solo developer; publish to npm is deliberately HELD until it earns it.

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
- **One objective.** Every addition serves "keep your agent instructions true" or it does not
  ship — features off that axis were deliberately cut in 003; do not reintroduce them casually.
- **Honesty is load-bearing.** Findings/claims the tool emits must cite evidence and disclose what
  they could not see (inherited CI templates, server-side thresholds, skipped heuristics). Never
  dress a heuristic as a fact — this is the product's core value and the repo's own rule.
- **Precision over recall.** A false "your file is lying" costs more trust than a missed lie —
  claim-extraction heuristics filter aggressively and disclose what they skip.
- **Public repo.** Publishing exposes ALL history, not just the current tree, so no tracked
  file or commit message may carry: absolute paths, hostnames or other machine and
  environment detail; employer, client or internal project names and ticket identifiers;
  identity or credential configuration written into prose (author metadata belongs in
  `LICENSE` and `package.json`); the names of the developer's other projects; or internal
  deliberation and provenance. Documentation examples must not name a real private project
  or a convention the tool does not itself recognize. The test: _would this line make sense,
  and be safe, read by a stranger who knows nothing about the developer or their other
  work?_ A pre-commit content gate enforces this where installed (`.githooks/pre-commit`) —
  a backstop, not a substitute for the rule.

## Navigate narrow

Read this contract → the map below → open only the files the task needs. Prefer targeted reads
over repo-wide scans.

## Repo map

> Advisory, not authoritative — re-verify with `git ls-files src` before structure-sensitive
> changes, and update this section in the same change that moves files.

- `src/cli.ts` — commander wiring; per-command dynamic imports (keep startup thin)
- `src/commands/` — thin command adapters (audit · init · approve · scan · doctor · context ·
  brief · gates · ledger[dismiss/accept] · fleet[sweep/check/dismiss/accept]); no business
  logic here
- `src/core/` — the deterministic engine: `scan.ts` (orchestrator) · `detect.ts` (detectors +
  classifier ladders + glob expansion) · `facts.ts` (cache vs committed baseline, profile,
  baseline-drift summary for `approve`) · `config.ts` (the optional committed config file under
  `.etymd/`: instruction scope + context budgets) · `fleet.ts` (the fleet manifest loader —
  registry + legacy corpus shapes, one resolved model) · `context.ts` · `generate.ts`
  (onboarding planner) · `apply.ts` (idempotent writes) · `types.ts` · `util.ts`
- `src/engine/` — the findings engine: `finding.ts` (Finding/Lens/ranking) · `ledger.ts`
  (committed improvement memory + `resolveEntry` for dismiss/accept) · `run.ts` (lens registry +
  audit composition) · `fleet.ts` (sweep + manifest check + fleet-scope wall findings)
- `src/lenses/` — the lenses: `instruction-truth/` (claims extraction + the headline truth lens) ·
  `state-freshness.ts` (state/decisions freshness — git committer dates, never mtime) ·
  `gate-integrity/` (inventory + lens) · `context-economy.ts`
- `src/pack/` — the versioned pack: `templates.ts` (minimal scaffold + hooks) · `version.ts`
- `src/ui/` — render + theme (all terminal output goes through here)
- `test/` — vitest suites incl. `truth.test.ts` (the lying-fixture) and `corpus.test.ts`
  (read-only sibling-repo smokes)
- `docs/decisions/` — the decision record (001 founding · 002 foundation re-lock · 003 truth-guard
  pivot — the current identity · 004 fleet mode)
- `ROADMAP.md` — now/next/later, the pre-publish checklist, accepted heuristic trade-offs

## Composition points

- `src/engine/run.ts` `LENSES` — the lens registry; adding a lens = registering it here +
  its own module under `src/lenses/`. Invariant: a partial run (filtered lenses) must never
  persist ledger resolutions for lenses that did not run.
- `src/engine/finding.ts` `Finding` — the ONE finding schema every lens speaks;
  never introduce a parallel finding shape.
- `src/lenses/instruction-truth/claims.ts` — claim extraction. Invariant: precision over recall;
  every skip class (builtins, flagged invocations, globs/URLs/placeholders, unrecognized
  extensions, gitignored claims, installed-binary commands, uninstalled node_modules,
  create-this prose, naming stand-ins) is counted and disclosed by the lens, never silently
  dropped.
- `src/core/facts.ts` — cache (`.etymd/cache/`, gitignored) vs baseline
  (`.etymd/baseline.json`, committed). Drift is measured against the baseline, never the cache.
- `src/core/config.ts` — the optional committed config file under `.etymd/` (audit scope +
  context budgets; etymd itself needs neither, so the file is absent here). Invariant: scoping
  must never buy silence — that holds in the LEDGER too. A tracked finding whose file the run
  excluded is absent because nobody looked, not because it was fixed: `reconcileLedger` holds it
  open (`outOfScope`), never `done`. Silently resolving it would let scoping rewrite unfixed
  problems as successes. Every file dropped by
  `instructions.exclude` is counted and NAMED in the lens disclosures, and malformed config is
  disclosed instead of silently falling back — a narrowed audit that looked clean would be the
  exact dishonesty this tool exists to catch. Reading config is the engine's job (`run.ts` loads
  it into `LensContext`); a lens never reads the file itself.
- `src/core/detect.ts` `ROLE_LADDERS` — command classification. Invariant: specific beats meta
  (`test:unit` over a chaining `test`), and a writing command (`--write`/`--fix`/codegen) must
  never be classified where a check belongs (`isSafeGateCommand` guards the hook generator too).
- `src/lenses/gate-integrity/inventory.ts` — the gate inventory. Honesty rules are structural:
  `allow_failure` ⇒ advisory (not a gate), inherited includes ⇒ disclosed as unseen, script-less
  jobs ⇒ name/variable inference marked `scriptVisible: false`.
- `src/pack/` — every template change is a pack change: bump `PACK_VERSION` when meaning changes;
  nothing outside `pack/` may hardcode template content. The scaffold must never claim what the
  scan cannot know.
- `src/core/fleet.ts` + `src/engine/fleet.ts` — the fleet seam. The loader resolves BOTH manifest
  shapes (registry pair, legacy corpus pair) into one model; fleet-scope findings are constructed
  directly as `Finding`s under lens id `fleet-manifest` — no new Lens abstraction until a second
  finding family earns it. Invariants, each pinned by test: the sweep never creates `.etymd`
  anywhere; a corp worktree takes zero writes regardless of flags or a stray `.etymd` inside it
  (corp persistence root = `<manifestDir>/corp/<name>/.etymd/`); zero corp-resolved content ever
  lands under the manifest repo's tracked paths; unresolvable entries and skipped checks are
  disclosed (`outOfScope` / problems), never silently dropped; a filtered sweep never moves the
  `last.fleet.json` delta baseline (the ledger's partial-run rule, applied to deltas).

## Conventions

- Prettier (no semicolons, double quotes, trailing commas, width 100); `npm run format` before
  finishing. A code span ending in a double-star (a `**` glob) must never sit inside bold —
  Prettier 3.4 mis-pairs the delimiters and silently rewrites the sentence, and `--check` still
  passes. `guard:md` fails both format scripts when that damage signature (an escaped star-pair)
  reaches a markdown file.
- kebab-case filenames; commands mirror their CLI name; comment the why, not the what.
- Every user-visible output path goes through `src/ui/render.ts` — no ad-hoc `console.log`.
- `--json` outputs are machine-stable schemas; changing them is a breaking change. One declared
  escape hatch: the fleet `--json` schema and the `registry.json` schema are EXPERIMENTAL through
  0.2.x — both say so in their own output/docs.

## Done =

A change is done when these are green:

- `npm run format:check`
- `npm run typecheck`
- `npm test`
- the self-audit — the built CLI run against this repo with `audit --fail-on risk`, which the
  pre-push hook and CI both enforce. etymd guards its own instructions with etymd.

## Commands

```bash
npm run build        # tsup (cli + index)
npm test             # vitest run (incl. corpus smokes; they skip if siblings absent)
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write
node dist/cli.js …   # run the built CLI
```

## Session protocol

1. Read `docs/decisions/003-truth-guard-pivot.md` for the current locked identity before non-trivial
   changes; 001/002 are the historical record (under the former name, clothaid).
2. Work in small vertical slices; keep this map and the decision record current in the same change —
   `etymd audit` on this repo will flag what you forget.
3. At session end, summarise what changed and what's next for the owner.
