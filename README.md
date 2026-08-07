# Etymd

<div align="center">
  <img src="https://raw.githubusercontent.com/triartleet/etymd/main/media/etymd-logo.png" width="520" alt="Etymd — a papyrus of written instructions, each line checked against the repository it describes">
  <p>
    <a href="https://www.npmjs.com/package/etymd"><img src="https://img.shields.io/npm/v/etymd.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/triartleet/etymd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/triartleet/etymd/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/triartleet/etymd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

**Keep your agent instructions true.**

You wrote rules for your AI months ago. Since then a script got renamed, a folder moved, a habit
changed — and the AI still trusts every word. The file never complains when it goes stale; it just
keeps instructing, confidently, and you live with the results.

Etymd reads those instruction files and checks every claim in them against your actual project.

One command, run in your project's folder (needs Node ≥ 18.17, nothing else): `npx etymd audit`.
Here it is on a small demo project whose AGENTS.md still tells the AI to run `npm run start` and
`npm run lint` and points at a `src/legacy/` folder — none of which exist any more:

```
$ npx etymd audit

  RISK   AGENTS.md tells agents to run `start` — no such script exists
         evidence  AGENTS.md: `npm run start` · package.json scripts (root + workspaces)
         why       An agent following this instruction runs a command that fails — or silently skips the check it was meant to run.
         action    Update the instruction to the current script name (or restore the script).
         effort S · confidence high · instruction-truth · instruction-truth/stale-command:AGENTS.md:start

  ...

  GAP    AGENTS.md references `src/legacy` — it does not exist in the repo
         evidence  AGENTS.md · missing: src/legacy
         why       Agents navigate by these references; a dead path wastes a lookup and erodes trust in the rest of the file.
         action    Fix or remove the reference.
         effort S · confidence medium · instruction-truth · instruction-truth/stale-path:AGENTS.md:src/legacy

  since last audit: 3 still open
```

Each entry names something that is no longer true, shows the evidence it found, and suggests the
smallest fix. And it remembers between runs: a problem you fixed — or looked at and deliberately
waved off — never nags you twice.

That's the whole deal. It works with zero configuration and never rewrites your files — the
memory it keeps between runs lives in one small folder of its own (`.etymd/`). Everything below
the line is reference — read it when you need it.

_From Greek **étymon** — a word's true, original sense (→ etymology) — clipped to **etym.** + the
**.md** family it guards._

---

## Why this exists

- **Truth is a property over time, not a point in time.** Instruction files are load-bearing now —
  coding agents (Claude Code, Codex, Cursor, Copilot, Gemini, …) read `AGENTS.md` natively, and a
  stale claim doesn't error, it silently misleads every session. Linters for these files check a
  moment; Etymd measures _drift_ against a committed _baseline_ and remembers findings in a
  _ledger_, so fixed things stay fixed and a returning problem is named a _regression_ (all four
  words defined just below). It runs when you invoke it — or when a hook or CI job you wire up
  does.
- **Honesty is structural.** Every report declares what it could NOT see — CI jobs inherited from
  unreadable org templates, server-side quality-gate thresholds, heuristics it skipped. No guess
  is ever dressed as a fact.
- **Precision over recall.** A false "your file is lying" costs more trust than a missed lie, so
  the checks filter aggressively — and every class of claim they skip is counted and disclosed,
  never silently dropped.

## The words Etymd uses

| The docs say          | It means                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **finding**           | One verified problem, ranked **RISK** (an agent acting on this does the wrong thing) → **GAP** (a dead reference or missing safeguard) → **POLISH** (worth tidying). Within a tier, cheapest fix first.              |
| **claim**             | Anything an instruction file asserts about the project that can be checked: a command it tells agents to run, a path it points at, a rule about tooling.                                                             |
| **lens**              | One self-contained checker for one kind of truth (are the commands real? is the state doc current?). An audit is all lenses run together.                                                                            |
| **baseline**          | A snapshot of the repo's checkable facts that you approved and committed. Drift is measured against this — not against whatever yesterday's cache happened to hold.                                                  |
| **drift**             | The distance between the baseline and the repo today: what existed at approval and is now gone, renamed, or moved.                                                                                                   |
| **ledger**            | The committed memory of findings — each one's status and history. A finding that was fixed and comes back is a **regression**, and the report names it as one rather than re-introducing it as new.                  |
| **dismiss vs accept** | Two deliberate ways to close a finding. _Dismiss_ = "not a real problem, here's why" — it never resurfaces unless it regresses. _Accept_ = "true, and we're living with it" — kept in the ledger, out of the report. |
| **gate**              | A check that can actually fail a change: a git hook, a CI job. A job marked `allow_failure` is advisory, not a gate — a check that cannot fail anything is an opinion.                                               |
| **disclosure**        | The report's account of what it could not see or refused to guess about. Every report carries one; a clean result with no disclosures would be the exact dishonesty this tool exists to catch.                       |
| **fleet**             | Your fleet of **repositories** — every repo you registered in one manifest, swept by one command. Not a fleet of AI agents.                                                                                          |
| **context economy**   | The words your instruction files load into every single session, measured against a budget. Context is a cost you pay per conversation; leaner files are cheaper and better obeyed.                                  |

### Things that surprise first-run users

- **"It missed an obvious stale command."** Without `node_modules` installed, command claims are
  skipped — and the skip is disclosed in the report. A command might resolve to an installed
  binary, and Etymd would rather say "couldn't check" than accuse an honest file. Install
  dependencies and run again.
- **`etymd audit` works without `etymd init`.** You only lose drift-over-time measurement — with
  no committed baseline, there is nothing to measure drift against. Everything else runs.
- **`etymd init` never overwrites an existing `AGENTS.md`.** It scaffolds a minimal one only if
  you have none. The feared overwrite path simply does not exist.

---

## Quick start

```bash
cd your-project
npx etymd audit         # verify every instruction claim against the repo
npx etymd init          # opt in to drift: approve the baseline (+ scaffold AGENTS.md only if you have none)
npx etymd audit --fail-on risk   # the CI gate
```

`audit` needs no setup — without `init` you get the full findings report and lose only drift
measured against a committed baseline. `init` is that opt-in, not a prerequisite, and it never
overwrites an existing `AGENTS.md`. On npm since v0.1.0 — `npx etymd` just works. To wire the
gate into a pipeline, see [In CI](#in-ci).

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
state is current; a tracked file with uncommitted edits is treated fresh-now (the refresh is
already on disk) and disclosed. Decisions records get format checks (`Scope:` presence, a
`Revisit:` date that, once past, becomes a finding) — opt in by adding the literal marker
`<!-- decisions-format: 1 -->` anywhere in the file; forward-only, never retroactive. Duplicate
or out-of-order `D-NNN` ids are flagged with a rename action even without the marker — an
append race is a defect in the file's own convention, not a format opinion.

**`fleet-manifest`** (via `etymd fleet`) — one truth guard across every repo you registered:
per-repo audits plus checks on the fleet manifest itself and on the placement wall between
personal and employer repos. See [the fleet manifest](#the-fleet-manifest-experimental) below.

## Commands

| Command                          | What it does                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etymd audit`                    | Verify every claim; ranked findings (risk → gap → polish) + ledger diff. `--lens`, `--truth`, `--json`, `--no-ledger`, `--fail-on <tier>`.                                               |
| `etymd init`                     | Onboard: approve the committed baseline; scaffold a minimal AGENTS.md **only if missing**. Never overwrites.                                                                             |
| `etymd doctor`                   | Alias for `audit --truth`.                                                                                                                                                               |
| `etymd context`                  | The economy view: per-file always-loaded footprint + extraction candidates.                                                                                                              |
| `etymd gates`                    | Install local git-hook gates (pre-commit / commit-msg / pre-push, plus a publish screen where something ships) built from your own check scripts.                                        |
| `etymd screen`                   | Content screen: find text that must never be published. Four scopes — `--staged`, `--message`, `--tree`, `--dir`. Bring your own patterns; etymd ships none.                             |
| `etymd scan`                     | The deterministic reckoning behind everything. `--json`.                                                                                                                                 |
| `etymd brief`                    | A grounded briefing your in-repo agent completes to author the semantic layer.                                                                                                           |
| `etymd approve`                  | Refresh the committed baseline non-interactively after intentional structural changes.                                                                                                   |
| `etymd ledger`                   | The findings memory: every tracked finding with status and history.                                                                                                                      |
| `etymd dismiss`                  | `dismiss <id> --reason <text>` — a dismissed finding never resurfaces without regressing.                                                                                                |
| `etymd accept`                   | `accept <id>` — record a finding as accepted reality; visible in the ledger, out of the report.                                                                                          |
| `etymd fleet`                    | Sweep every project in a fleet manifest: read-only per-repo audits + manifest/wall checks. `--manifest`, `--only`, `--profile`, `--truth`, `--persist-ledgers`, `--json`, `--fail-on`.   |
| `etymd fleet check`              | Validate the manifest pair alone (no lenses): dangling mappings, duplicate names, privacy leaks, undeclared trust, machine paths. Non-zero exit on any finding.                          |
| `etymd fleet add`                | `add <dir>` — register a project: scans it, asks for what no scan can derive, and refuses to write an entry missing a mandatory field. `--name`, `--kind`, `--profile`, `--trust`, `-y`. |
| `etymd fleet dismiss` / `accept` | `<name> <id>` — resolve a project's finding from any cwd; corp findings persist beside the manifest, never in the corp worktree.                                                         |

`--cwd <dir>` targets another directory. Read-only probing of any repo leaves **zero trace**
(`audit --no-ledger` writes nothing).

## The files Etymd keeps

| Path                   | Lifecycle     | Role                                             |
| ---------------------- | ------------- | ------------------------------------------------ |
| `.etymd/baseline.json` | **committed** | the approved reckoning drift is measured against |
| `.etymd/ledger.json`   | **committed** | the findings memory: statuses, diffs, dismissals |
| `.etymd/config.json`   | **committed** | optional: audit scope + context budgets          |
| `.etymd/cache/`        | gitignored    | transient scan cache                             |

The committed files are written to be publishable: the baseline records `"."` as its scan root, never
your absolute machine path. Only the gitignored cache keeps the real one.

Formatter interop: if your Prettier (or similar formatter) checks JSON, add `.etymd` to
`.prettierignore` — Etymd writes its own JSON style, and a format gate fighting the ledger is
noise (this repo does exactly that).

### `.etymd/config.json` (optional)

Every key is optional; omit the file entirely and the defaults below apply.

```jsonc
{
  "instructions": {
    // Audit these too — files detection would not find on its own.
    "include": ["docs/handbook/**/*.md"],
    // Leave these out. The classic case: a fork that inherits upstream's skills
    // and will never fix them, but must keep its OWN instruction layer honest.
    "exclude": [".claude/skills/**"],
  },
  "context": {
    "perFileWords": 4000, // extraction candidate above this
    "totalWords": 8000, // always-loaded footprint budget
  },
  "gates": {
    // What `etymd gates` generates. Written for you on first run from what the scan
    // finds — edit it here rather than editing the generated hook, so the next run
    // agrees with you instead of arguing.
    "commands": ["typecheck", "lint"], // pre-push steps, in order
    "failOn": "risk", // audit tier that fails the push: risk | gap | polish
    "publishGate": true, // screen the published artifact
    "allowWriting": [], // commands allowed into a gate despite writing
    // Why a value here is what it is. Each key mirrors the field it explains, so the
    // note says what it refers to instead of sitting near it and hoping. Etymd keeps
    // these, and DROPS one whose field it changes — a reason attached to a value it no
    // longer explains is worse than no reason at all.
    "_why": { "failOn": "no build and no tests here; only docs drift can fire" },
  },
}
```

Globs are repo-relative: `*` within a path segment, `**` across segments, `?` one character. A
pattern with no wildcard is a **path prefix**, so `.claude/skills` covers everything beneath it.

Narrowing an audit can hide findings, so Etymd never lets it happen quietly. Honesty is
structural: **every excluded file is counted and named in the lens disclosures**, and a config
that fails to parse is reported as a disclosure rather than silently falling back to defaults.

## In CI

The gate is one command:

```bash
npx etymd audit --no-ledger --fail-on risk
```

Exit-code contract: without `--fail-on`, `audit` reports and exits 0 no matter what it found.
With `--fail-on <tier>` (`risk` | `gap` | `polish`) it exits non-zero when any finding at or
above that tier exists — so `--fail-on risk` blocks on risks only, `--fail-on polish` blocks on
everything. `--no-ledger` keeps the CI run read-only: the throwaway checkout is never written.

The ledger and baseline are not CI by-products — they are **committed, reviewable state**,
updated locally and read in CI. A dismissal (with its reason), an accepted finding, a baseline
refresh after an intentional restructure: each lands in `.etymd/` and shows up in the pull
request diff like any other change. Keep `.etymd` out of your formatter's reach (see
[the files Etymd keeps](#the-files-etymd-keeps)).

A check that runs only in CI is itself a finding: the failure surfaces after the agent finished.
`etymd gates` installs the local pre-commit / pre-push mirror built from your own check scripts,
and the `gate-integrity` lens flags whatever still runs in CI alone.

### Your own checks, beside the generated ones

Generated hooks are overwritten on every `etymd gates` run, so nothing hand-written belongs in
them. Each one calls a companion instead — `.githooks/pre-commit.local`, `commit-msg.local`,
`pre-push.local` — that etymd **never reads, writes, or regenerates**. Make it executable and it
runs; a non-zero exit stops the commit or push exactly as the generated checks do.

> **Commit the companion, and check your `.gitignore` first.** A `*.local` rule — common for env
> files, and shipped by some framework templates — silently swallows these too. The guard then
> works on the machine that wrote it and is absent for everyone who clones, which looks identical
> to having no guard at all. Add `!.githooks/*.local` if that rule exists.

```sh
cat > .githooks/pre-commit.local <<'EOF'
#!/usr/bin/env sh
# Whatever this project needs — etymd will not touch this file.
./scripts/check-changelog.sh || exit 1
EOF
chmod +x .githooks/pre-commit.local
```

Two files, two owners. The generated half stays byte-identical to what the pack produces, which
is what lets drift detection say something precise: a difference there means the _managed_ part
was edited or went stale, never that you added a check of your own. Delete the companion and its
checks stop running — that is what deleting a file means, and etymd does not police a file it
does not own.

### The content screen (`etymd screen`)

A separate question from "are the instructions true?": **does this repo carry text that must
never be published?** Absolute home paths, an employer's name, an internal hostname, an account
identifier — permanent the moment they are committed, because publishing exposes all history,
not the current tree.

Etymd ships the mechanism and **no patterns, ever**. The strings worth screening for are
themselves the sensitive material, so a built-in list would be useless to everyone else and a
leak for whoever wrote it. You supply a pattern file (one regex or literal per line, `#` for
comments) at `~/.config/etymd/screen-patterns` or via `--patterns`. Without one the command is
inert and says so — it never reports "clean" for a check it did not run.

`etymd gates` wires it into four doors, because a leak walks through whichever is unguarded:

| door             | scope               | what only it can catch                                        |
| ---------------- | ------------------- | ------------------------------------------------------------- |
| `pre-commit`     | staged file bytes   | the ordinary case, at the cheapest moment to fix              |
| `commit-msg`     | the message itself  | the staged scan reads file bytes and never sees the message   |
| `pre-push`       | every tracked file  | anything committed with `--no-verify`, or merged in from else |
| `prepublishOnly` | the packed artifact | **a gitignored file that still ships** — see below            |

That last door exists because the first three share a blind spot: they all answer "what is in
the repository?". `npm` and `vsce` do not honour `.gitignore`, so a local cache file can be
packaged into a published release while every git-scoped check passes forever.

Every generated hook resolves the screener at run time and **no-ops when it is absent**, so the
same hook file is safe to commit to a public repo: it carries no patterns and imposes no policy
on anyone who clones it. A deliberate exception is marked inline with `allow-published-string`,
visible in the diff rather than hidden in an allowlist.

Modeled on this repo's own workflow (Etymd guards its own instructions with Etymd — its CI runs
the same gate against its own freshly built CLI):

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: npm
  - run: npm ci
  - run: npx etymd audit --no-ledger --fail-on risk
```

## The fleet manifest (EXPERIMENTAL)

`etymd fleet` extends the one objective across every repository you work in — your fleet of
**repositories**, not a fleet of agents. The manifest, `registry.json`, is itself an
agent-context file: claims about your fleet (what exists, where, under which **profile** — the
side of the wall an entry belongs to, `personal` or `corp`; the **wall** is the placement
boundary between personal and employer content that the sweep polices). It rots like any
AGENTS.md does, and `etymd fleet` keeps it true. Decision record:
[`docs/decisions/004-fleet-truth-guard.md`](https://github.com/triartleet/etymd/blob/main/docs/decisions/004-fleet-truth-guard.md). Both the
registry schema and the fleet `--json` schema are **experimental through 0.2.x**.

Two files beside each other — the split is the privacy model:

`registry.json` (tracked; safe to publish by construction):

```jsonc
{
  "registryVersion": 1,
  "root": "~/projects", // ~ expands on the consumer side — never a machine home
  "orientation": { "root": "north" }, // optional: the entry every other entry is guided by
  "projects": [
    {
      "name": "web-app",
      "kind": "repo",
      "profile": "personal",
      "path": "web-app",
      "trust": "private",
    },
    {
      "name": "notes",
      "kind": "docs",
      "profile": "personal",
      "path": "notes",
      "trust": "private", // mandatory on every non-corp entry — see below
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
  "machineProfile": "corp", // which profile this machine resolves; "personal" resolves corp entries disclosed-absent
  "root": "~/projects", // optional per-machine root override
  "dirs": { "c-one": "~/projects/real-corp-dir" },
  "labels": { "c-one": "real-corp-dir" },
  "corpHosts": ["git.example-corp.com"],
}
```

Two fields the scan can never derive, so the manifest must declare them:

- **`trust` — mandatory on every non-corp entry** (`public-repo` | `public-bound` | `private`).
  It is a _safety predicate_, not a label: it decides whether content screening applies, so an
  absent value is reported (`fleet check` flags it), never read as a silent `private`.
  `public-bound` means private today, plausibly public later — screened exactly as hard as
  public, because publishing exposes _all_ history: the scrub has to precede the first commit,
  not the visibility flip. A value outside the vocabulary is flagged rather than coerced, so a
  typo can never quietly disable screening. Corp entries omit it — `profile: "corp"` already
  implies the answer.
- **`orientation.root` — optional, declared once.** Names the one entry every other entry is
  guided by. Declared at the manifest level rather than repeated per entry, because a per-entry
  link carries no information and can be forgotten: hoisting it makes an unoriented project
  unrepresentable instead of merely detectable. Fleets without an orientation root omit the
  block — etymd never assumes one.

`etymd fleet add <dir>` is the gate that keeps both true: it scans the project, prompts for what
no scan can derive, and **refuses to write an incomplete entry**. Non-interactive runs (`--yes`,
CI) must pass every mandatory value as a flag — there is deliberately no default.

How the sweep behaves:

- **Read-only by default, everywhere.** The sweep never creates `.etymd` anywhere.
  `--persist-ledgers` persists only into personal repos that already opted in, and a **corp
  worktree is never written** — regardless of flags, even if a stray `.etymd` exists inside it
  (pinned by test). Corp findings stay dismissible: their ledger lives at
  `<manifest-dir>/corp/<name>/.etymd/`, beside the manifest.
- **Deltas.** Each sweep compares against `last.fleet.json` stored beside the manifest and
  renders `Δ +new −resolved` per project. Add `*.fleet.json` to the manifest repo's
  `.gitignore` — sweep output is local-only and never tracked.
- **Recurring classes.** A finding class open in two or more projects renders as its own section
  of class-fix candidates (worst tier first) — the sweep asking "repo bug or fleet bug?", a
  fleet-level lesson no per-repo audit can see. The sweep only groups; the class vocabulary is
  minted by the engine's lenses.
- **Declared absence is honored.** An entry whose contract declares `"placement": "none"` states
  that instruction files are legitimately absent in that project — the sweep drops its
  missing-contract finding instead of re-reporting a decision every run. Absence disclosed on
  purpose is a state, not a gap.
- **Wall checks.** Corp contract files found inside a corp worktree, unregistered checkouts
  under the fleet root whose remotes match `corpHosts`, tracked `/Users/` paths in the manifest
  repo, private **needles** — the identifiers the local file holds (labels, dir names, hosts) —
  inside `trust: "public-repo"` entries, and corp-host commit emails on personal entries — each
  a risk finding; each check that cannot run is disclosed.
- **No global pointer.** `--manifest` is required unless the cwd holds `registry.json` — there
  is deliberately no env var and no home-directory pointer.

Formatter interop for the `.etymd` state the sweep resolves: same rule as everywhere — see
[the files Etymd keeps](#the-files-etymd-keeps).

## Programmatic use

```ts
import { runAudit } from "etymd"

const audit = await runAudit(process.cwd(), { persistLedger: false })
console.log(audit.findings) // one schema: claim · evidence · why · action · effort · confidence
```

## The corpus (how this is validated)

Etymd is developed against a corpus of real sibling repos rather than fixtures alone —
[`sources.json`](https://github.com/triartleet/etymd/blob/main/sources.json) lists them by shape. Every heuristic here exists because a real
repo proved the previous one wrong, and each skip class in the truth lens is a false positive that
a corpus run caught.

Some corpus entries are private and are named by shape (`nx-monorepo`, `spa-bff`, `cra-legacy`)
rather than by directory. To run those smokes locally, add an untracked `sources.local.json`
mapping each name to its sibling directory:

```json
{ "dirs": { "nx-monorepo": "my-monorepo-checkout" } }
```

Each value is resolved as a sibling of the Etymd checkout.

Without it — on a fresh clone or in CI — those suites skip cleanly and the rest still run.

## Decision record & roadmap

[`docs/decisions/`](https://github.com/triartleet/etymd/tree/main/docs/decisions) — 001 founding · 002 foundation re-lock · **003 the truth-guard
pivot** (the current identity; includes the state-of-the-field investigation it rests on) ·
**004 fleet mode** (the truth guard across your repositories).
[`ROADMAP.md`](https://github.com/triartleet/etymd/blob/main/ROADMAP.md) — what's now / next / later, the pre-publish checklist, and the
accepted heuristic trade-offs.

## License

MIT
