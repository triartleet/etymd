# Design: clothaid — an agent-agnostic agentic-workflow CLI

> Founding design document (v0.0.1). Distilled from a frontrunner project workflow plus lessons
> from three private team repos — an Nx monorepo, a SPA + BFF app, and a legacy CRA app. Tool name
> **`clothaid`** (npm-available).
> "Reckon" is kept only as the name of the _scan step / knowledge-index artifact_; the binary is
> `clothaid`. This captures the design; the build follows in a later session.

## Context — why we're building this

workspace-fullstack (the frontrunner project) has, over 122 sessions, converged a **locked agentic
workflow**: an operating contract (`AGENTS.md`), ground-truth state (`PROJECT_CONTEXT.md`), a
navigation map (now a `repo-map` skill), composition-point seams, a session-archive protocol
(R5), structure/navigation rules (R1–R9), a three-tier gate model (process→pre-commit ·
correctness→pre-push/CI · AI-judgment→advisory), a `failure-modes` register, a canvas format,
and comment discipline — all agent-agnostic (read by Claude Code via a `CLAUDE.md` pointer and by
Cursor natively). The same skeleton was hand-ported into two team repos — an **Nx monorepo** and a
**SPA + BFF** app (`AGENTS.md` plus a `.github/copilot-instructions.md` pointer, reuse-first with an
inventory doc, an org-tooling leash, "Done =" gates) — and partially into a **legacy CRA** app.
There is concrete demand for exactly this as a **portable kit — a setup CLI** — with **measured**
delivery gains against a deadline, which is what makes it worth building rather than re-porting.

Today that port is manual: the owner links documents into a session and asks an agent to copy the
setup. The need: **a CLI that reckons any project and installs/optimises this workflow for it,
agent-agnostic, and keeps adding value + growing its own knowledge from the source projects.**

**North-star framing (leverage lens).** The single biggest N× lever this tool can pull is
**context economy on a measured loop**: workspace-fullstack proved context is ~85% of loop spend and that
extracting the map into a skill cut always-loaded context −52% _forever_. A generic scaffolder
installs files; clothaid installs a **measured, self-auditing, context-lean discipline** and
proves the gain in numbers. That is the differentiator to protect through every decision.

## 1. What it is (one paragraph)

A Node/TypeScript CLI, distributed as the npm package **`clothaid`**, run inside a target project.
It **reckons** the project (deterministic scan + an agent-orchestrated semantic pass), lets the
user pick a **setup mode** (Fresh / Migration / Optimisation), captures a **leash profile**
(operational constraints), then **plans and applies** an agent-agnostic workflow: one
source-of-truth contract + state + map/skills + gates, plus thin **per-agent adapter files**.
After setup it keeps earning its place — doctor/freshness, loop metrics, a keyless dashboard,
knowledge harvest, and gates.

## 2. Repo & corpus (decided)

- **New repo**: `~/projects/clothaid` (own release cadence; must not couple an agent-agnostic
  product to workspace-fullstack's history).
- **Sibling-path corpus**: a `sources.json` manifest pointing at local siblings — the workspace-fullstack
  frontrunner plus the three private team repos. No vendoring/submodules; works today because all
  repos are siblings.
- **Dogfooding validation loop** (core to development): regenerate workspace-fullstack's real artifacts from
  clothaid and **diff against the hand-built originals** — the tool is "correct" when it can
  reproduce the frontrunner's locked setup. Each corpus repo also validates a _different shape_:
  pnpm-workspace TanStack (workspace-fullstack), Nx monorepo Next.js, single-repo SPA + Express BFF, and
  CRA + Apollo + husky/lint-staged.

## 3. Core architecture — four building blocks

### 3a. The Knowledge Pack (versioned standard)

The distilled, **versioned** encoding of the workspace-fullstack-derived standard: contract templates, the
R-rules, the gate-tier model, skill templates (repo-map, failure-modes, freshness-audit, session
protocol), the canvas format, comment discipline, and the maturity rubric. **This is the tool's
brain**, and the thing `harvest` (§6c) grows. Versioned so a project records _which_ pack version
it was set up against (drift is then computable). Ships a default "workspace-fullstack-standard" pack;
`org profiles` (§6h) layer on top.

### 3b. The Reckoning (per-project knowledge index)

The inspectable output of the Reckon step: `facts.json` (deterministic) + `reckoning.md`
(human-readable, approved). Everything downstream consumes it. Re-runnable → drift-detectable
(doctor/§6a). Contents: stack, package manager, monorepo topology, discovered **commands**
(test/lint/typecheck/format/build — the real "Done =" set), CI system, git-hook state, existing
agent artifacts, directory index, and the **semantic layer** (composition points/seams, reuse
inventory, ownership boundaries, "what this project is").

### 3c. Agent-agnostic adapter layer (the mechanism that makes it "agnostic")

**One source of truth** (`AGENTS.md` + `PROJECT_CONTEXT.md` + `docs/` + skills) and **thin,
generated pointer/adapter files per agent target** — exactly workspace-fullstack's `CLAUDE.md → @AGENTS.md`
and the team repos' `.github/copilot-instructions.md` pattern, generalized:

- **Claude Code**: `CLAUDE.md` pointer, `.claude/skills/*`, `.claude/settings.json` (hooks).
- **Cursor**: native `AGENTS.md` + `.cursor/rules/*`.
- **GitHub Copilot**: `.github/copilot-instructions.md` pointer.
- **Others (later, pluggable)**: Cline, Windsurf, Aider, Gemini CLI, Codex.

Adapters are a **plugin set**; adding an agent target never touches the source of truth.

### 3d. The Leash Profile (structured policy object)

A machine-usable + prose-rendered policy with three input sources (§5c): **autonomy** (may run
tests? arbitrary bash? network? push/commit/open-PRs?), **tooling** (gh allowed? MCP allowed? API
tokens?), **VCS discipline** (branch/commit format, ticket-linked changes), **scope** (minimal
diffs, out-of-scope-file ban), **secrets/security**, **review/human-in-loop gates**. Rendered into
the contract's "Working rules"/"leash" section; the team repos' org-tooling block is the proof this
generalizes.

## 4. The pipeline (top-level flow)

`clothaid init` orchestrates: **Reckon → Mode → Leash → Plan → Apply**. Each stage is also a
standalone command so power users can run piecemeal and re-run idempotently.

## 5. Stage design

### 5a. Reckon (agent-orchestrated — decided)

Two layers so it "excels anywhere":

1. **Deterministic scan** (`clothaid scan`, no LLM): package.json(s) + lockfile → package manager;
   `workspaces`/`nx.json`/`turbo.json`/`lerna.json` → monorepo topology; `scripts` → command set;
   tsconfig; `.gitlab-ci.yml`/`.github/workflows` → CI; husky/lint-staged/`core.hooksPath` →
   hook state; existing agent files (`AGENTS.md`, `CLAUDE.md`, `.cursor/`, copilot-instructions,
   `.clinerules`, `.windsurfrules`, `.aider*`); `docs/` layout; framework detection via deps;
   directory tree with sizes/file-counts. → `facts.json`.
2. **Agent-orchestrated semantic pass**: `clothaid brief` emits a **grounded briefing**
   (`.clothaid/brief.md`) that the agent _already in the repo_ executes to infer seams/composition
   points/reuse inventory/"what this is"; `clothaid ingest` folds the agent's answer back into
   `reckoning.md` for **human approval**. No API keys; maximally agnostic; **dogfoods the very
   workflow it installs**. (Optional bundled-LLM fallback deferred, not v0.0.1.)

_Principle (from the "automate content fetching" method):_ pipeline fetches + ranks, human
approves — the semantic layer is never silently authored.

### 5b. Modes (all three write in v0.0.1 — decided; iterate)

One shared engine; mode is the **starting-maturity lens**, not a hard branch. All three produce a
**maturity scorecard** (graded against the §3a rubric: contract? nav map? state doc? session
protocol? gate tiers? failure register? comment discipline? leash?).

- **Fresh** — no agentic workflow → install from scratch (owner already validated this path
  manually). Easiest; the scorecard starts near-empty.
- **Migration** — existing _other_ workflow → **diff against our standard**, communicate the
  deltas, let the user **pick/reconcile** feature-by-feature, then apply (merge-not-clobber).
- **Optimisation** — existing workflow, ours reviews it → scorecard + **prioritized, pick-list
  recommendations**; **may add the missing artifacts the user selects** (so Optimisation is
  "Migration, incremental + user-curated"). Yes, it can create extra artifacts — but only the
  scorecard-gap ones the user picks.

### 5c. Leash (three sources; user-specific always asked — decided)

- **Detected** (auto): infer likely constraints from the scan (GitLab + no `gh` → org VCS; husky
  commitlint → enforced commit format; no MCP config → assume none) — the team-repo leash is exactly
  this shape.
- **Our suggestions** (gap-driven): where the standard has a knob the project hasn't answered, ask.
- **User-specific** (always): an open capture of the user's own constraints, folded into the rules.

Runs **after mode is chosen, before Apply**.

### 5d. Plan → Apply (diff-first, idempotent, merge-not-clobber)

- `clothaid plan` renders the full change set as **previewable diffs** (ask permission before
  implementing).
- `clothaid apply` writes on approval; **re-running is safe** (reconcile, never clobber) —
  essential for Migration/Optimisation and for post-setup re-runs.

## 6. Post-setup value suite (the "keeps adding value" layer)

Each is a standalone command; the **dashboard** is their shared keyless front-end.

### 6a. Doctor / freshness (`clothaid doctor`)

Re-runnable audit generalizing workspace-fullstack's `freshness-audit` skill + R1 map-staleness (the recurring
team-repo pain): map lists files that no longer exist? documented commands still resolve? leash
claims ("gh not allowed") still true? "blocked-on" claims still true? canvas/status vs the actual
tree? **CI-installable** to fail on drift. Feeds the dashboard.

### 6b. Metrics / measurement (`clothaid metrics`)

Instruments the loop — session weight, iteration count, reversals, rework %, revert %, lead
time/story vs a baseline — generalizing workspace-fullstack's A4 instrument (`scripts/loop-metrics.mjs` →
`agentic-metrics-baseline.md`). **Directly powers the manager-proposal December case study.**
Fed automatically by the **session runner** (§6f) so measurement is free, not a chore. Strict-by-
default methodology (matched comparisons, named limits) mirroring the proposal.

### 6c. Harvest / knowledge growth (`clothaid harvest`)

The **upstream feedback loop** — automate-expansion. Reads the _evolved_ contracts/skills/
failure-modes of the corpus repos, **diffs vs the current knowledge pack**, and **proposes
human-approved updates** to the pack (new rule, new failure mode, refined template) → a new pack
version. This is how the tool learns from workspace-fullstack and the team repos continuing to evolve.

### 6d. Gates (`clothaid gates`) — split by cost

- **Free tier, always project-agnostic**: install the tracked-hooks gate model — `process →
pre-commit`, `correctness → pre-push` (format/types/lint over the working tree) — via
  `.githooks/` + `core.hooksPath` (workspace-fullstack's multi-agent-safe, git-level pattern). **No keys.**
- **Opt-in AI-review CI job** (`--ci`): the `AI-judgment → advisory` MR/PR review that the team repos
  already run — **bring-your-own-key**, auto-detects an existing CI AI-review setup (free on the
  corpus projects), skipped cleanly where no key/CI exists. Never a hard requirement.

### 6e. Operational dashboard (`clothaid dashboard`)

A **zero-infra, keyless** self-contained HTML (served locally) or TUI rendering the whole picture:
metrics trends (weight/iterations/reversals/rework), doctor/freshness status, **context budget**
(§6g), leash profile, scorecard, pack version + drift. The natural home for everything measured,
needing no credentials.

### 6f. Session runner (`clothaid session start|end`)

Encodes workspace-fullstack's session protocol: `start` opens a session with the right context loaded (state →
map → task); `end` drafts the R5 archive + `PROJECT_CONTEXT.md` mirror and enforces gapless
Task↔Session numbering. The **operational heartbeat**, and it auto-emits the measured unit §6b
consumes — measurement becomes a side effect of working, not extra work.

### 6g. Context-budget accounting (`clothaid context`) — **flagship differentiator**

Measures the **always-loaded footprint** (contract + pointers + auto-loaded skills, in words/
tokens), flags bloat, and proposes the **skill-extraction move** (map → skill) that cut workspace-fullstack's
context −52% forever. Context is ~85% of loop spend (workspace-fullstack's own finding) — this is the measured
N× lever no generic tool offers. Also guards regressions (a contract that re-bloats trips doctor).

### 6h. Org profiles (`clothaid profile`)

Leash profiles + knowledge-pack overlays are **shareable across repos**. Define an org leash once
(e.g. gh-disabled · MCP-disabled · ticket discipline · commitlint format · GitLab CI) and apply
across every repo — the **multi-repo scale story** the "broader AI-enablement" ambition needs.

### 6i. Onboarding brief (`clothaid brief --human`)

Render the reckoning as a **human** onboarding doc (not only agent-facing) — earns the tool its
keep for new teammates and widens the buyer to team leads.

### 6j. Networked failure-modes (`clothaid failure add`)

Append to the local `failure-modes` register when an agent hits an environment trap; `harvest`
promotes cross-project ones into the shared pack. workspace-fullstack's failure-modes skill, networked.

## 7. Command surface (sketch, not final)

```text
clothaid init            # orchestrates scan -> brief/ingest -> mode -> leash -> plan -> apply
clothaid scan            # deterministic facts.json
clothaid brief [ingest]  # agent-orchestrated semantic pass -> reckoning.md (approved)
clothaid plan / apply    # diff-preview -> write (idempotent, merge-not-clobber)
clothaid score           # maturity scorecard (any mode)
clothaid doctor          # freshness/drift audit  (CI-installable)
clothaid metrics         # loop measurement vs baseline
clothaid context         # always-loaded context budget + skill-extraction proposals
clothaid session start|end
clothaid gates [--ci]    # free local hooks; opt-in AI-review job
clothaid harvest         # pull corpus evolution -> propose knowledge-pack updates
clothaid profile         # org leash/pack presets
clothaid dashboard       # keyless local metrics/status surface
```

## 8. Tech & distribution

- Node/TypeScript CLI, npm package `clothaid` (matches every corpus project's ecosystem; audience
  is IT-professionals — sensible interactive defaults + power-user flags; **not overly complex**).
- Package-manager-agnostic execution (detects pnpm/yarn/npm from lockfile).
- Adapters + agents + knowledge packs are **plugin-shaped** so the tool grows without core churn.
- Pin deps exact (workspace-fullstack convention); the tool holds itself to the standard it installs
  (dogfood: `clothaid` sets up `clothaid`).

## 9. v0.0.1 scope & phasing

**In v0.0.1** (all modes write, per decision; iterate quality after):

- New repo + `sources.json` corpus + the dogfood diff harness (§2).
- Knowledge pack v1 (default workspace-fullstack-standard) + maturity rubric (§3a).
- Reckon: deterministic scan + agent-orchestrated brief/ingest (§5a).
- All three modes with scorecards, sharing one engine (§5b).
- Leash capture (detected + suggested + user-specific) (§5c).
- Plan/Apply diff-first + idempotent (§5d).
- Adapter layer for **Claude Code + Cursor + Copilot** (the owner's three environments) (§3c).
- Free gates tier (local hooks) (§6d).

**Fast-follow (v0.0.x, designed now, built next):** doctor, metrics + session runner, context
accounting, dashboard, harvest, org profiles, opt-in AI-review CI, onboarding brief, extra agent
adapters, networked failure-modes. (Ordering set when we move from design to build.)

## 10. Verification / dogfooding (how we know it works)

- **Corpus reproduction**: run against `../workspace-fullstack` and diff generated vs hand-built `AGENTS.md`/
  map-skill/gates — the frontrunner is the golden fixture.
- **Shape coverage**: run against the Nx monorepo, the SPA + BFF app, and the legacy CRA app —
  each exercises a different topology/command-set/hook-setup the scan must get right.
- **Self-setup**: `clothaid` installs its own workflow into its own repo (dogfood).
- **Mode coverage**: Fresh on a scratch repo; Migration/Optimisation on a corpus repo with its
  existing setup temporarily treated as "other".

## 11. Open decisions for the owner

1. ~~Name~~ — **decided: `clothaid`** (npm-available, owner-confirmed).
2. **Adapter target list for v0.0.1** — assumed Claude Code + Cursor + Copilot (the owner's three);
   confirm none others are needed on day one.
3. **Fast-follow ordering** — set when design → build (leaning: doctor + session-runner + metrics
   - context first, since they compound and feed the dashboard).
