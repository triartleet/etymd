# 003 — The truth-guard pivot (and the rename to etymd)

_Supersedes the product identity of 001/002 (which remain the historical record under the old
name, **clothaid**). Where they disagree with this document, this one wins._

## Why

Before investing further, the project ran a state-of-the-field investigation (July 2026) to find
a genuine, enduring, under-served gap — with a hard constraint from the owner: one clear main
objective, small scope, and only an adjustment of the existing core (a ground-up redesign would
have ended the initiative).

### What the investigation established

- **AGENTS.md won.** Stewarded by the Linux Foundation's Agentic AI Foundation, adopted by 60k+
  repositories, read natively by 20+ tools (Claude Code, Codex, Cursor, Copilot, Gemini CLI,
  Windsurf, Zed, …). The _setup/adapter_ half of the old product is commoditized — vendor
  convergence plus 5+ rules-sync tools closed it.
- **Verification cost is the field's #1 named pain.** Developers now spend more time reviewing
  agent output than writing (11.4 h vs 9.8 h weekly; PRs +98%, median review time +441%); trust
  fell (40% → 29%) while adoption rose to 80%. "Context engineering" replaced prompt design;
  **context rot** is a named production concept (degradation past ~30k tokens / 70–80% fill).
- **The instruction-file-quality niche is young and contested but half-empty.** ~6 entrants born
  within months: agnix (363★, Rust, LSP, 437 rules — **static-only**: no codebase cross-check, no
  drift, no baselines, no persistent state), agents-lint (11★ — cross-checks paths/scripts but
  **point-in-time**: no baseline, no ledger, no budget, no trends), ctxlint/cclint/two web tools
  (small). **Nobody has the continuous half**: truth verified against the actual repo _over time_
  — committed baseline, drift, regression ledger, token-budget economy. That half is precisely the
  engine 002 built.

### The three filters, applied

1. **Endures:** documentation rot is a decades-old problem that agents made load-bearing — the
   instruction file is now the primary human→agent interface. Standardization _strengthens_ the
   case (a standard format begets standard tooling — the markdownlint/eslint/hadolint pattern).
   Leanness endures regardless of window growth (attention dilution + cost).
2. **Under-served:** verified above — the continuous seat is empty; the mature competitor (agnix)
   occupies a different lane (editor-time syntax/best-practice linting). Complementary, not me-too.
3. **Small:** the objective is one sentence, and the engine already exists. Adjust, not redesign.

## The one objective (locked)

> **Keep your agent instructions true.** etymd continuously verifies the agent context layer
> (AGENTS.md, CLAUDE.md, rules, skills) against the actual repo, on a token budget, with drift
> caught against a committed baseline and a ledger so fixed things stay fixed — honest about what
> it cannot see.

Everything ships under this objective or not at all. Gate-integrity folds under it naturally: a
CI config is a claim the workflow makes; the lens verifies it.

## The rename

**clothaid → etymd.** From Greek _étymon_ (ἔτυμον) — "the TRUE sense of a word" (the root of
_etymology_, the study of true meaning) — clipped with the dictionary abbreviation **etym.** plus
**md**, the file family it guards (AGENTS.md, CLAUDE.md, SKILL.md). Chosen for the written medium
an OSS tool lives in; npm-available; verified free of PATH/binary conflicts.

## What changed in this pivot

- **New headline lens — `instruction-truth`** (absorbs 002's contract-drift): verifies, against
  the real repo, every claim the instruction files make — script/command claims exist in
  package.json; path claims exist on disk; files agree with the repo's package manager;
  cross-references to known docs resolve — plus the baseline drift checks (commands/artifacts/
  layout vs `.etymd/baseline.json`). Precision over recall: workspace-filtered commands,
  absolute/globbed/placeholder tokens are skipped and _disclosed_, never guessed.
- **New lens — `context-economy`**: the always-loaded footprint as findings (heavy single files ≥
  4000 words; total ≥ 8000 words), Cursor-scoped-rule aware. `etymd context` remains the focused
  view.
- **`audit --fail-on <tier>`** — the CI gate (exit non-zero at/above the tier).
- **Setup demoted to onboarding**: slim `init` = approve the committed baseline + gitignore the
  cache + scaffold a minimal AGENTS.md _only where none exists_ + offer gates _only where none
  exist_. Never overwrites.
- **Cut** (off-objective, commoditized, or noise): the maturity rubric + `score` command, the
  Fresh/Migration/Optimisation mode machinery, the leash capture + rendering, per-agent adapter
  generation (CLAUDE.md/Cursor/Copilot pointers), the PROJECT_CONTEXT template. The pack shrinks
  to: the minimal AGENTS.md scaffold + the two hook templates + `PACK_VERSION`.
- **Kept intact**: the deterministic scan, the findings engine (one `Finding` schema, `Lens`
  interface, committed ledger with regression semantics, baseline/cache split), gate-integrity
  with its honesty rules, `brief`, `gates`, the corpus test harness, zero-trace on foreign repos.

## Deliberately NOT in v1 (competitors' lanes or later)

Framework-staleness patterns (agents-lint's lane), LSP/editor integration + autofix (agnix's
lane), configurable budgets/rules files, loop metrics, harvest, dashboard. Publish to npm remains
**held** by the owner until the tool has proven itself in daily use on the corpus.

## Sources (investigation)

Anthropic 2026 agentic-coding trends (via tessl.io) · AGENTS.md field guides (iuriio.com,
buildbetter.ai, morphllm.com) · digitalapplied.com 2026 developer survey (review-burden reversal)
· codex.danielvaughan.com human-review-bottleneck · controltheory.com trust guide ·
salesforce.com/usewire.io context-rot & budgets · github.com/agent-sh/agnix ·
github.com/giacomo/agents-lint · github.com/YawLabs/ctxlint · github.com/felixgeelhaar/cclint ·
github.com/lbb00/ai-rules-sync (+ syncai, agent_sync) · axify.io / swarmia.com measurement
landscape.
