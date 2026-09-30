# Etymd

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/etymd/main/media/etymd-logo.png" width="520" alt="Etymd — a papyrus of written instructions, each line checked against the repository it describes">
  <p>
    <a href="https://www.npmjs.com/package/etymd"><img src="https://img.shields.io/npm/v/etymd.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/fleetorders/etymd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fleetorders/etymd/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/fleetorders/etymd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

**Keep your agent instructions true.**

You wrote rules for your AI months ago. Since then a script got renamed, a folder moved, a habit
changed — and the AI still trusts every word. The file never complains when it goes stale; it just
keeps instructing, confidently, and you live with the results.

Etymd reads those instruction files — and, when you ask, the task you are about to hand an agent —
and checks every claim against your actual project.

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
- **"The shellcheck step announced that it skipped."** That is the intended behaviour, not a
  misconfiguration: where the binary is absent the hook says so and names the install command,
  because a check that goes quiet when its tool is missing looks installed everywhere and is
  installed nowhere.

---

## Quick start

```bash
cd your-project
npx etymd audit         # verify every instruction claim against the repo
npx etymd init          # opt in to drift: approve the baseline (+ scaffold AGENTS.md only if you have none)
npx etymd audit --fail-on risk   # the CI gate
npx etymd premise "fix the flaky test in src/legacy/foo.test.ts"   # is this the right task?
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

**`premise`** (via `etymd premise`) — the task itself is an instruction. Before an agent acts on
it, every path, script, well-known doc and decision id the task names is checked with the same
rules instruction files get. A path the task is _about_ and that does not exist ranks as **risk**:
the task would solve the wrong problem precisely. What cannot be read from files — that the named
things are the ones meant, that the mechanism the task assumes actually runs, that the state it
assumes holds — is handed to the agent in a brief, never guessed at. Nothing is remembered between
runs.

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
`<!-- decisions-format: 1 -->` anywhere in the file; forward-only, never retroactive. A file can
require field names of its own by appending them to the marker —
`<!-- decisions-format: 1 fields=Owner,Rollback -->` — and each is then checked on every entry.
Etymd ships no field vocabulary and reads no meaning into the names; it verifies only that what
the file declared is present, and discloses any name it could not use. Duplicate
or out-of-order `D-NNN` ids are flagged with a rename action even without the marker — an
append race is a defect in the file's own convention, not a format opinion.

**`fleet-manifest`** (via `etymd fleet`) — one truth guard across every repo you registered:
per-repo audits plus checks on the fleet manifest itself and on the placement wall between
personal and guarded repos. See [the fleet manifest](#the-fleet-manifest-experimental) below.

## Commands

| Command                          | What it does                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etymd audit`                    | Verify every claim; ranked findings (risk → gap → polish) + ledger diff. `--lens`, `--truth`, `--json`, `--no-ledger`, `--fail-on <tier>`.                                                                                                                          |
| `etymd init`                     | Onboard: approve the committed baseline; scaffold a minimal AGENTS.md **only if missing**, with its `CLAUDE.md` pointer. Never overwrites.                                                                                                                          |
| `etymd doctor`                   | Alias for `audit --truth`.                                                                                                                                                                                                                                          |
| `etymd context`                  | The economy view: per-file always-loaded footprint + extraction candidates.                                                                                                                                                                                         |
| `etymd gates`                    | Install local git-hook gates (pre-commit / commit-msg / pre-push, plus a publish screen where something ships) built from your own check scripts — and from the repo's shell surface, where it has one.                                                             |
| `etymd screen`                   | Content screen: find text that must never be published. Four scopes — `--staged`, `--message`, `--tree`, `--dir`. Bring your own patterns; etymd ships none.                                                                                                        |
| `etymd scan`                     | The deterministic reckoning behind everything. `--json`.                                                                                                                                                                                                            |
| `etymd brief`                    | A grounded briefing your in-repo agent completes to author the semantic layer.                                                                                                                                                                                      |
| `etymd premise`                  | `premise "<task>"` — is this the right task? What it names, verified against the repo; a brief for what only the agent can verify. `--file` (`-` = stdin), `--json`, `--no-brief`, `--fail-on <tier>`. No ledger.                                                   |
| `etymd approve`                  | Refresh the committed baseline non-interactively after intentional structural changes.                                                                                                                                                                              |
| `etymd ledger`                   | The findings memory: every tracked finding with status and history.                                                                                                                                                                                                 |
| `etymd dismiss`                  | `dismiss <id> --reason <text>` — a dismissed finding never resurfaces without regressing.                                                                                                                                                                           |
| `etymd accept`                   | `accept <id>` — record a finding as accepted reality; visible in the ledger, out of the report.                                                                                                                                                                     |
| `etymd fleet`                    | Sweep every project in a fleet manifest: read-only per-repo audits + manifest/wall checks. `--manifest`, `--only`, `--profile`, `--truth`, `--persist-ledgers`, `--json`, `--fail-on`.                                                                              |
| `etymd fleet check`              | Validate the manifest pair alone (no lenses): dangling mappings, duplicate names, privacy leaks, undeclared trust, machine paths. Non-zero exit on any finding.                                                                                                     |
| `etymd fleet add`                | `add <dir>` — register a project: scans it, asks for what no scan can derive, and refuses to write an entry missing a mandatory field, or a repo whose `AGENTS.md` Claude Code cannot see. `--name`, `--kind`, `--profile`, `--trust`, `-y`.                        |
| `etymd fleet board`              | Render the fleet board: every project's `MILESTONES.md` (contract key `milestones`, shape-checked by the sweep) plus a ranked initiatives table on one page. `--initiatives <file>`, `--out <file>`, `--json`.                                                      |
| `etymd propose`                  | Score the sweep's improvement findings + recurring classes against a fleet-authored rubric — stable `proposal/1` records, read-only, deterministic, guarded entries excluded. `--rubric <file>` (required), `--manifest <file>` or `--from <fleet.json>`, `--json`. |
| `etymd fleet dismiss` / `accept` | `<name> <id>` — resolve a project's finding from any cwd; guarded findings persist beside the manifest, never in the guarded worktree.                                                                                                                              |

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
    "commitFormat": true, // check the commit subject — Conventional Commits, off unless set
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
`etymd gates` installs the local pre-commit / pre-push mirror built from your own check scripts —
and from the repo's shell scripts, which usually have no check of their own — while the
`gate-integrity` lens flags whatever still runs in CI alone.

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

### The shell surface

Package scripts are not the only executable surface a repo has, and in some repos they are not
the main one — a tools or infra repo can be entirely `bootstrap/*.sh` plus `.githooks/*` with no
`package.json` at all. Those repos were told "no correctness commands detected", which reads as
"nothing to check" when it means "nothing was looked at". Where a repo has tracked shell scripts,
the generated pre-push now carries a `shellcheck` step. Three properties are deliberate:

- **Scripts are re-discovered by shebang at push time**, never baked into the hook as a list. A
  generated list is correct the day it is written and silently wrong the first time someone adds
  a script.
- **A missing `shellcheck` binary is a loud skip that names the install command**, never a quiet
  pass. A check that goes silent when its tool is absent looks installed on every machine and is
  installed on one.
- **Only `warning` severity and above blocks**; style and info print as advice afterwards. A gate
  with a high false-positive rate does not make a repo careful — it teaches everyone the bypass
  flag, and that flag is shared with the checks that must never be bypassed.

### The content screen (`etymd screen`)

A separate question from "are the instructions true?": **does this repo carry text that must
never be published?** Absolute home paths, an organisation's name, an internal hostname, an account
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
on anyone who clones it. A deliberate exception on a line you can edit is marked inline with
`allow-published-string`, visible in the diff.

Some exemptions cannot live on the line itself: a scanner's own source contains the strings it
screens for, its tests contain fixtures that must match, and a bundler strips comments so an
inline marker would not survive into the artifact. Those live in `.etymd-screen-allow` at the
repo root — one labeled line per field, so the pattern is never delimited:

```
pattern ^AcmeInc|BetaInc$
reason fixture proving the detector fires on either name
date 2026-08-15
author someone
```

A pattern may contain any character, including the `|` shown above, without escaping: a
free-form field delimited in-band is an ambiguity in the format itself, and no amount of
parser-side guarding fixes that class — labels move the boundary to the line break, which the
field cannot contain. An entry naming the repo itself needs no provenance — a bare `^widget$`
line is a complete record, the exemption being exactly as wide as the name. Anything else
missing a field is reported and does not apply: an exemption is a hole in the gate, and a hole
nobody signed cannot be audited later. The file is read from the repo being screened, never a
shared location, and it screens itself out (it necessarily contains every string it exempts).

The file carries a second record kind, for paths rather than lines:

```
generated ^src/data/corpus\.json$
reason public-domain corpus, regenerated by scripts/corpus each January
date 2026-09-04
author someone
```

A `generated` path is data a pipeline rebuilds — a public-domain corpus, generated fixtures —
and period English trips credential vocabulary (`passkey`, `secret`) on a schedule, training
exactly the `--no-verify` habit the screen exists to prevent. The file is still read and still
screened: only vocabulary-class patterns drop for it, while secret-class patterns and the
machine-path check stay — a generated file is precisely where a real credential would be least
visible. Provenance is unconditional (a path is never the repo naming itself), and the paths
that took the exemption are named in the output, so a clean run never reads as fully screened
where it was screened narrower.

### The commit subject, if you ask for it

Off unless you turn it on:

```json
{ "gates": { "commitFormat": true } }
```

in `.etymd/config.json`. Then the `commit-msg` hook also checks the subject against
[Conventional Commits](https://www.conventionalcommits.org) — `<type>[(scope)][!]: <summary>`,
with `feat fix docs style refactor perf test build ci chore revert` as the types. It is a format
check and not a taste check: it asks whether a machine can classify the line, and stops there.
An over-long subject is reported as advice and never blocks, and the subjects git writes for you
— merge, revert, fixup, squash, amend — are exempt, since gating those would ask you to rewrite
text you did not write.

It is the one generated check that needs nothing installed, and therefore the one that would run
for everyone who clones your repo. That is exactly why it is off by default. Every other check
the pack writes is either derived from what your repo already does or inert without a checker you
installed yourself; a commit convention is neither — it is an opinion, and this tool does not
hold opinions on your behalf.

Turn it on where the convention is already yours. A convention nobody gates does not get
abandoned in a decision you could point at: it erodes one hurried commit at a time, and by the
time the log reads as a mixture, every commit in it is already published.

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
side of the wall an entry belongs to, `personal` or `guarded`; the **wall** is the placement
boundary between personal and guarded content that the sweep polices). It rots like any
AGENTS.md does, and `etymd fleet` keeps it true. Decision record:
[`docs/decisions/004-fleet-truth-guard.md`](https://github.com/fleetorders/etymd/blob/main/docs/decisions/004-fleet-truth-guard.md). Both the
registry schema and the fleet `--json` schema are **experimental through 0.2.x**.

Two files beside each other — the split is the privacy model:

`registry.json` (tracked; safe to publish by construction):

```jsonc
{
  "registryVersion": 1,
  "root": "~/projects", // ~ expands on the consumer side — never a machine home
  "orientation": { "root": "notes" }, // optional: the entry every other entry is guided by
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
      "trust": "private", // mandatory on every non-guarded entry — see below
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
    // Guarded entries: opaque alias, private, NO path — real dirs live only in the local file.
    {
      "name": "c-one",
      "kind": "repo",
      "profile": "guarded",
      "private": true,
      "staleAfterDays": 45,
    },
  ],
}
```

`registry.local.json` (gitignored; this machine's facts — each one an identifier you don't ship):

```jsonc
{
  "machineProfile": "guarded", // which profile this machine resolves; "personal" resolves guarded entries disclosed-absent
  "root": "~/projects", // optional per-machine root override
  "dirs": { "c-one": "~/projects/real-guarded-dir" },
  "labels": { "c-one": "real-guarded-dir" },
  "guardedHosts": ["git.example-guarded.com"],
}
```

Two fields the scan can never derive, so the manifest must declare them:

- **`trust` — mandatory on every non-guarded entry** (`public-repo` | `public-bound` | `private`).
  It is a _safety predicate_, not a label: it decides whether content screening applies, so an
  absent value is reported (`fleet check` flags it), never read as a silent `private`.
  `public-bound` means private today, plausibly public later — screened exactly as hard as
  public, because publishing exposes _all_ history: the scrub has to precede the first commit,
  not the visibility flip. A value outside the vocabulary is flagged rather than coerced, so a
  typo can never quietly disable screening. Guarded entries omit it — `profile: "guarded"` already
  implies the answer.
- **`orientation.root` — optional, declared once.** Names the one entry every other entry is
  guided by. Declared at the manifest level rather than repeated per entry, because a per-entry
  link carries no information and can be forgotten: hoisting it makes an unoriented project
  unrepresentable instead of merely detectable. Fleets without an orientation root omit the
  block — etymd never assumes one.

`etymd fleet add <dir>` is the gate that keeps both true: it scans the project, prompts for what
no scan can derive, and **refuses to write an incomplete entry**. Non-interactive runs (`--yes`,
CI) must pass every mandatory value as a flag — there is deliberately no default. It also refuses
a repo whose `CLAUDE.md` hides its `AGENTS.md`: Claude Code reads `CLAUDE.md` when one exists and
falls back to `AGENTS.md` (from 2.1.277) only when none does, so a `CLAUDE.md` must import
`@AGENTS.md` or be a symlink to it — the refusal prints the fix. A repo with `AGENTS.md` alone
registers; on a Claude Code older than 2.1.277 it gets a note, since that version cannot see it.

How the sweep behaves:

- **Read-only by default, everywhere.** The sweep never creates `.etymd` anywhere.
  `--persist-ledgers` persists only into personal repos that already opted in, and a **guarded
  worktree is never written** — regardless of flags, even if a stray `.etymd` exists inside it
  (pinned by test). Guarded findings stay dismissible: their ledger lives at
  `<manifest-dir>/guarded/<name>/.etymd/`, beside the manifest.
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
- **Wall checks.** Guarded contract files found inside a guarded worktree, unregistered checkouts
  under the fleet root whose remotes match `guardedHosts`, tracked `/Users/` paths in the manifest
  repo, private **needles** — the identifiers the local file holds (labels, dir names, hosts) —
  inside `trust: "public-repo"` entries, guarded-host commit emails on personal entries, and
  repos whose `AGENTS.md` no `CLAUDE.md` pointer or symlink makes visible to Claude Code
  (`claude-pointer-missing`) — each a risk finding; each check that cannot run is disclosed.
- **No global pointer.** `--manifest` is required unless the cwd holds `registry.json` — there
  is deliberately no env var and no home-directory pointer.
- **Milestones and the fleet board.** A project declares its plan in one file — `MILESTONES.md`,
  registered as `"contract": { "milestones": "MILESTONES.md" }` (`fleet add` registers it when the
  file is present; `"none"` declares a project deliberately carries no plan). The file has a fixed
  shape so the fleet can read every plan without an agent: a `# Milestones` heading, then a table
  `| id | milestone | goal | status | next | effort | depends-on |` — `id` is `M<n>`, `goal` is 1, 2
  or 3 (your fleet's own ordered goals, declared outside this tool), `status` is planned | active |
  blocked | done, `next` is the one concrete next step, `effort` the S | M | L remaining,
  `depends-on` a list of ids or `—`. Prose after the table is free. The sweep files a gap when a
  declared file is absent or off-shape. `etymd fleet board --initiatives <file> --out <file>`
  renders every project's rows, a ranked initiatives table (`| rank | id | initiative | goal |
status | next | effort | projects | depends-on |`, the one hand-edited fleet-level surface), and
  totals; guarded entries never appear on it. Day-precision stamp, deterministic output, exit code 1
  when any project is missing or invalid — a board with holes still renders, and says so.

Formatter interop for the `.etymd` state the sweep resolves: same rule as everywhere — see
[the files Etymd keeps](#the-files-etymd-keeps).

### Rubric-scored proposals (`etymd propose`)

The sweep already gives every improvement finding an action, an effort and a confidence, and
names the classes open in two or more projects. `etymd propose` adds the scoring step — against
a rubric **your fleet authors**, because what is worth doing is your call, not the tool's:

```
severity: 2      # risk=3 · gap=2 · polish=1
economy: 3       # S=3 · M=2 · L=1
confidence: 1    # high=3 · medium=2 · low=1
breadth: 4       # projects carrying it, capped at 3
```

One criterion per line (`#` comments and blanks ignored). Those four criteria are the whole
vocabulary — each is computed from finding facts, so a score is arithmetic, not an opinion; a
line naming anything else is refused quoting the line. `score` is Σ weight × value; a line
**fires** (listed in `matched`) when the subject reads at/above the criterion's midpoint.

```bash
etymd propose --manifest registry.json --rubric opportunity.rubric --json
# or, without re-sweeping: --from <fleet.json> (a stored `etymd fleet --json` output)
```

Subjects are every `kind: improvement` finding from personal projects plus every recurring
class, recomputed over personal projects only — **guarded entries are excluded from the output
entire, by name**. A class is scored conservatively (worst tier, dearest effort, weakest
confidence). Each `proposal/1` record carries id, class, projects, action, effort, confidence,
score, the fired rubric lines, and an `implications` block (projects, files, gates,
reversibility) extracted from the findings' evidence — files are path-shaped evidence tokens,
and `undetermined` reversibility says so rather than guessing. Read-only and deterministic: no
timestamps, nothing written, identical input → identical bytes, so a filed proposal can be
re-derived and compared. Decision record:
[`docs/decisions/012-propose-rubric-scored-proposals.md`](https://github.com/fleetorders/etymd/blob/main/docs/decisions/012-propose-rubric-scored-proposals.md).

## Programmatic use

```ts
import { runAudit } from "etymd"

const audit = await runAudit(process.cwd(), { persistLedger: false })
console.log(audit.findings) // one schema: claim · evidence · why · action · effort · confidence
```

## How this is validated

Every heuristic here exists because a real repository proved the previous one wrong, and each skip
class in the truth lens is a false positive found that way. The fixtures in `test/` reproduce each
case, so the suite runs the same checks on a fresh clone.

## Decision record & roadmap

[`docs/decisions/`](https://github.com/fleetorders/etymd/tree/main/docs/decisions) — 001 founding · 002 foundation re-lock · **003 the truth-guard
pivot** (the current identity; includes the state-of-the-field investigation it rests on) ·
**004 fleet mode** (the truth guard across your repositories) · 005 declared rules (design only) ·
**006 local gate provenance** (what the tool may read, and what it may rewrite) · 011 milestones
& the fleet board · 012 `etymd propose` (rubric-scored proposals).
[`ROADMAP.md`](https://github.com/fleetorders/etymd/blob/main/ROADMAP.md) — what's now / next / later, and the accepted heuristic
trade-offs.

## License

MIT
