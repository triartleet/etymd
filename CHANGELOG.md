# clothaid

## 0.0.1

Initial release.

- `clothaid init` — reckon a project and install/migrate/optimise an agent-agnostic workflow
  (interactive): one source-of-truth `AGENTS.md`, per-agent adapters (Claude Code / Cursor /
  Copilot), an optional `PROJECT_CONTEXT.md` state doc, and local git-hook gates.
- `clothaid scan` — deterministic project reckoning (package manager, workspace topology,
  Done= commands, frameworks, CI, hooks, existing agent artifacts, layout) → `.clothaid/facts.json`.
- `clothaid score` — maturity scorecard against the standard, with a suggested setup mode.
- `clothaid context` — always-loaded context-budget accounting + skill-extraction candidates.
- `clothaid doctor` — freshness/drift audit ("is this still true?") against the tree.
- `clothaid brief` — grounded briefing for the in-repo agent to complete the semantic layer
  (`--human` writes an onboarding brief instead).
- `clothaid gates` — install the free local correctness/process git-hook gates.
- Reserved (designed, planned): `metrics`, `harvest`, `dashboard`, `session`, `profile`.
