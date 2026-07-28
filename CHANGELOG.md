# etymd

## 0.0.1 (unreleased)

The truth guard for agent instruction files — **keep your agent instructions true**. (Formerly
prototyped as "clothaid", a broader workflow installer; the pivot and its state-of-the-field
rationale are recorded in `docs/design/003-truth-guard-pivot.md`.)

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
