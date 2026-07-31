# etymd

[![npm version](https://img.shields.io/npm/v/etymd.svg)](https://www.npmjs.com/package/etymd)
[![CI](https://img.shields.io/github/actions/workflow/status/triartleet/etymd/ci.yml?branch=main&label=CI)](https://github.com/triartleet/etymd/actions/workflows/ci.yml)

**Keep your agent instructions true.**

Your `AGENTS.md` is the interface between your team and every coding agent — and it rots silently.
Scripts get renamed, directories move, rules go stale, and the file keeps instructing agents with
confidence. etymd continuously **verifies the agent context layer against the actual repo**:

```
$ etymd audit

  RISK   AGENTS.md tells agents to run `pnpm dev` — no such script exists
         evidence  AGENTS.md: `pnpm dev` · package.json scripts
         action    Update the instruction to the current script name.

  GAP    AGENTS.md references `src/legacy/` — it does not exist in the repo
  GAP    Type checking is enforced only in CI — no local hook runs it
  GAP    AGENTS.md loads 13,809 words (~18k tokens) into every session

  since last audit: 1 new · 3 still open · 1 resolved · 1 REGRESSED
```

_From Greek **étymon** — a word's true, original sense (→ etymology) — clipped to **etym.** + the
**.md** family it guards._

## Why this exists

- Instruction files are now load-bearing: 20+ agents (Claude Code, Codex, Cursor, Copilot,
  Gemini, …) read `AGENTS.md` natively. A stale claim doesn't error — it silently misleads every
  session.
- Linters exist for these files, but they check **a point in time**. Truth is a property **over
  time**: etymd measures drift against a **committed baseline**, remembers findings in a
  **ledger** (fixed things stay fixed; a returning problem is named a _regression_, and a finding
  you dismissed with a reason never resurfaces), and gates CI on it.
- **Honesty is structural.** Every report declares what it could NOT see — CI jobs inherited from
  unreadable org templates, server-side quality-gate thresholds, skipped heuristics. No guess is
  ever dressed as a fact.

## Quick start

```bash
cd your-project
npx etymd init          # approve the baseline (+ scaffold AGENTS.md only if you have none)
npx etymd audit         # verify every instruction claim against the repo
npx etymd audit --fail-on risk   # the CI gate
```

Requires Node ≥ 18.17. **Status: pre-publish** — run from a checkout (`npm run build &&
node dist/cli.js …`) until the first npm release.

## What it checks

**`instruction-truth`** — over `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions,
`.cursor/rules/*`, `.clinerules`, `.claude/skills/*/SKILL.md`:

- **Command claims** — every `pnpm X` / `npm run X` the files tell agents to run must exist in
  `package.json` scripts.
- **Path claims** — every repo path the files point at must exist (conservative heuristics; what's
  skipped is disclosed). A path the surrounding prose tells the agent to _create_, and an obvious
  naming stand-in like `my-custom-skill`, are forward-looking instructions, not stale references.
- **Package-manager consistency** — instructions must not command `yarn` in a `pnpm` repo.
- **Cross-references** — pointer chains (`CLAUDE.md` → `AGENTS.md` → state docs) must resolve.
- **Drift vs baseline** — documented commands/artifacts/layout that existed at approval and are
  now gone.

**`gate-integrity`** — a CI config is a claim too: checks enforced only in CI (failures surface a
slow pipeline after the agent finished — `etymd gates` generates the local mirror), checks only in
skippable local hooks, latent gaps (coverage collected but nothing gates on it; commitlint
installed but unwired). `allow_failure` jobs count as advisory, never as gates.

**`context-economy`** — the always-loaded footprint in words/tokens (only genuinely
`alwaysApply` Cursor rules count), flagging files worth extracting into on-demand skills. Context
is the dominant cost of the loop; a lean contract is a correctness feature.

**`state-freshness`** — the layer that claims "this describes now" (`PROJECT_CONTEXT.md`,
`DECISIONS.md`, ADR dirs), judged by git committer dates only, never mtime. Staleness is
_relative_ — a state doc is stale only when the repo moved past it, so a dormant repo's old
state is current. Decisions records get format checks (marker-gated) and a `Revisit:` date that,
once past, becomes a finding.

**`fleet-manifest`** (via `etymd fleet`) — one truth guard across every repo you registered:
per-repo audits plus checks on the fleet manifest itself and on the placement wall between
personal and employer repos. See [the fleet manifest](#the-fleet-manifest-experimental) below.

## Commands

| Command                          | What it does                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etymd audit`                    | Verify every claim; ranked findings (risk → gap → polish) + ledger diff. `--lens`, `--truth`, `--json`, `--no-ledger`, `--fail-on <tier>`.                                             |
| `etymd init`                     | Onboard: approve the committed baseline; scaffold a minimal AGENTS.md **only if missing**. Never overwrites.                                                                           |
| `etymd doctor`                   | Alias for `audit --truth`.                                                                                                                                                             |
| `etymd context`                  | The economy view: per-file always-loaded footprint + extraction candidates.                                                                                                            |
| `etymd gates`                    | Install local git-hook gates (pre-commit / pre-push) built from your own check scripts.                                                                                                |
| `etymd scan`                     | The deterministic reckoning behind everything. `--json`.                                                                                                                               |
| `etymd brief`                    | A grounded briefing your in-repo agent completes to author the semantic layer.                                                                                                         |
| `etymd approve`                  | Refresh the committed baseline non-interactively after intentional structural changes.                                                                                                 |
| `etymd ledger`                   | The findings memory: every tracked finding with status and history.                                                                                                                    |
| `etymd dismiss`                  | `dismiss <id> --reason <text>` — a dismissed finding never resurfaces without regressing.                                                                                              |
| `etymd accept`                   | `accept <id>` — record a finding as accepted reality; visible in the ledger, out of the report.                                                                                        |
| `etymd fleet`                    | Sweep every project in a fleet manifest: read-only per-repo audits + manifest/wall checks. `--manifest`, `--only`, `--profile`, `--truth`, `--persist-ledgers`, `--json`, `--fail-on`. |
| `etymd fleet check`              | Validate the manifest pair alone (no lenses): dangling mappings, duplicate names, privacy leaks, machine paths. Non-zero exit on any finding.                                          |
| `etymd fleet dismiss` / `accept` | `<name> <id>` — resolve a project's finding from any cwd; corp findings persist beside the manifest, never in the corp worktree.                                                       |

`--cwd <dir>` targets another directory. Read-only probing of any repo leaves **zero trace**
(`audit --no-ledger` writes nothing).

## The files etymd keeps

| Path                   | Lifecycle     | Role                                             |
| ---------------------- | ------------- | ------------------------------------------------ |
| `.etymd/baseline.json` | **committed** | the approved reckoning drift is measured against |
| `.etymd/ledger.json`   | **committed** | the findings memory: statuses, diffs, dismissals |
| `.etymd/config.json`   | **committed** | optional: audit scope + context budgets          |
| `.etymd/cache/`        | gitignored    | transient scan cache                             |

The committed files are written to be publishable: the baseline records `"."` as its scan root, never
your absolute machine path. Only the gitignored cache keeps the real one.

### `.etymd/config.json` (optional)

Every key is optional; omit the file entirely and the defaults below apply.

```jsonc
{
  "instructions": {
    // Audit these too — files detection would not find on its own.
    "include": ["design/**/*.md"],
    // Leave these out. The classic case: a fork that inherits upstream's skills
    // and will never fix them, but must keep its OWN instruction layer honest.
    "exclude": [".claude/skills/**"],
  },
  "context": {
    "perFileWords": 4000, // extraction candidate above this
    "totalWords": 8000, // always-loaded footprint budget
  },
}
```

Globs are repo-relative: `*` within a path segment, `**` across segments, `?` one character. A
pattern with no wildcard is a **path prefix**, so `.claude/skills` covers everything beneath it.

Narrowing an audit can hide findings, so etymd never lets it happen quietly: **every excluded file
is counted and named in the lens disclosures**, and a config that fails to parse is reported as a
disclosure rather than silently falling back to defaults.

## The fleet manifest (EXPERIMENTAL)

`etymd fleet` extends the one objective across every repository you work in — your fleet of
**repositories**, not a fleet of agents. The manifest, `registry.json`, is itself an
agent-context file: claims about your fleet (what exists, where, under which profile). It rots
like any AGENTS.md does, and `etymd fleet` keeps it true. Design record:
[`docs/design/004-fleet-truth-guard.md`](docs/design/004-fleet-truth-guard.md). Both the
registry schema and the fleet `--json` schema are **experimental through 0.2.x**.

Two files beside each other — the split is the privacy model:

`registry.json` (tracked; safe to publish by construction):

```jsonc
{
  "registryVersion": 1,
  "root": "~/projects", // ~ expands on the consumer side — never a machine home
  "projects": [
    { "name": "web-app", "kind": "repo", "profile": "personal", "path": "web-app" },
    {
      "name": "notes",
      "kind": "docs",
      "profile": "personal",
      "path": "notes",
      "staleAfterDays": 45, // per-entry freshness window
      "contract": { "state": "STATUS.md" }, // native conventions register, never migrate
    },
    {
      "name": "my-fork",
      "kind": "tool",
      "profile": "personal",
      "path": "my-fork",
      "upstream": "origin", // freshness measured on fork-authored commits only
      "trust": "public-repo", // hygiene needles apply (see below)
    },
    // Corp entries: opaque alias, private, NO path — real dirs live only in the local file.
    { "name": "c-one", "kind": "repo", "profile": "corp", "private": true, "staleAfterDays": 45 },
  ],
}
```

`registry.local.json` (gitignored; this machine's facts — each one an identifier you don't ship):

```jsonc
{
  "machineProfile": "corp", // "personal" resolves corp entries disclosed-absent
  "root": "~/projects", // optional per-machine root override
  "dirs": { "c-one": "~/projects/real-corp-dir" },
  "labels": { "c-one": "real-corp-dir" },
  "corpHosts": ["git.example-corp.com"],
}
```

How the sweep behaves:

- **Read-only by default, everywhere.** The sweep never creates `.etymd` anywhere.
  `--persist-ledgers` persists only into personal repos that already opted in, and a **corp
  worktree is never written** — regardless of flags, even if a stray `.etymd` exists inside it
  (pinned by test). Corp findings stay dismissible: their ledger lives at
  `<manifest-dir>/corp/<name>/.etymd/`, beside the manifest.
- **Deltas.** Each sweep compares against `last.fleet.json` stored beside the manifest and
  renders `Δ +new −resolved` per project. Add `*.fleet.json` to the manifest repo's
  `.gitignore` — sweep output is local-only and never tracked.
- **Wall checks.** Corp contract files found inside a corp worktree, unregistered checkouts
  under the fleet root whose remotes match `corpHosts`, tracked `/Users/` paths in the manifest
  repo, private needles (labels, dir names, hosts) inside `trust: "public-repo"` entries, and
  corp-host commit emails on personal entries — each a risk finding; each check that cannot run
  is disclosed.
- **No global pointer.** `--manifest` is required unless the cwd holds `registry.json` — there
  is deliberately no env var and no home-directory pointer.

Interop note: if a repo's Prettier (or similar formatter) checks JSON, add `.etymd` to its
`.prettierignore` — etymd writes its own JSON style, and a format gate fighting the ledger is
noise (this repo does exactly that).

## Programmatic use

```ts
import { runAudit } from "etymd"

const audit = await runAudit(process.cwd(), { persistLedger: false })
console.log(audit.findings) // one schema: claim · evidence · why · action · effort · confidence
```

## The corpus (how this is validated)

etymd is developed against a corpus of real sibling repos rather than fixtures alone —
[`sources.json`](sources.json) lists them by shape. Every heuristic here exists because a real
repo proved the previous one wrong, and each skip class in the truth lens is a false positive that
a corpus run caught.

Some corpus entries are private and are named by shape (`nx-monorepo`, `spa-bff`, `cra-legacy`)
rather than by directory. To run those smokes locally, add an untracked `sources.local.json`
mapping each name to its sibling directory:

```json
{ "dirs": { "nx-monorepo": "my-monorepo-checkout" } }
```

Each value is resolved as a sibling of the etymd checkout.

Without it — on a fresh clone or in CI — those suites skip cleanly and the rest still run.

## Design record & roadmap

[`docs/design/`](docs/design/) — 001 founding · 002 foundation re-lock · **003 the truth-guard
pivot** (the current identity; includes the state-of-the-field investigation it rests on) ·
**004 fleet mode** (the truth guard across your repositories).
[`ROADMAP.md`](ROADMAP.md) — what's now / next / later, the pre-publish checklist, and the
accepted heuristic trade-offs.

## License

MIT
