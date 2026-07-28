# etymd

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

## Commands

| Command         | What it does                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `etymd audit`   | Verify every claim; ranked findings (risk → gap → polish) + ledger diff. `--lens`, `--truth`, `--json`, `--no-ledger`, `--fail-on <tier>`. |
| `etymd init`    | Onboard: approve the committed baseline; scaffold a minimal AGENTS.md **only if missing**. Never overwrites.                               |
| `etymd doctor`  | Alias for `audit --truth`.                                                                                                                 |
| `etymd context` | The economy view: per-file always-loaded footprint + extraction candidates.                                                                |
| `etymd gates`   | Install local git-hook gates (pre-commit / pre-push) built from your own check scripts.                                                    |
| `etymd scan`    | The deterministic reckoning behind everything. `--json`.                                                                                   |
| `etymd brief`   | A grounded briefing your in-repo agent completes to author the semantic layer.                                                             |

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
pivot** (the current identity; includes the state-of-the-field investigation it rests on).
[`ROADMAP.md`](ROADMAP.md) — what's now / next / later, the pre-publish checklist, and the
accepted heuristic trade-offs.

## License

MIT
