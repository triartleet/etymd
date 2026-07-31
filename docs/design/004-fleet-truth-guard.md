# 004 — Fleet mode: the truth guard across your repositories

_Extends 003 (the truth-guard identity). The objective does not change — **keep your agent
instructions true** — this document applies it to the surfaces a single-repo audit structurally
cannot see. The fleet `--json` schema and the registry schema are **EXPERIMENTAL through 0.2.x**._

## What "fleet" means here

Your fleet of **repositories** — not a fleet of agents. One developer's work is spread across
personal projects, tools, forks of active upstreams, and employer checkouts that must never mix
with any of them. Each repo can keep its own instructions true with `etymd audit`; nothing keeps
true the layer ABOVE them:

- the **fleet manifest** — `registry.json` is itself an agent-context file: claims about your
  fleet (what exists, where, under which profile, with which contract files). It rots exactly
  like an AGENTS.md does — a renamed directory leaves a ghost entry that looks covered and is
  swept by nothing. **`etymd fleet` keeps the manifest true** the same way `etymd audit` keeps a
  contract true.
- **state docs' implicit claim** — "this describes now" is only checkable against each repo's
  own clock, entry by entry, with per-entry thresholds (a fork is judged on fork-authored
  commits; a slow-moving repo gets a longer window).
- the **wall** — when part of the fleet belongs to an employer, placement itself is a truth
  claim: corp contract files live outside corp worktrees, corp directories stay out of tracked
  files, public repos carry no private vocabulary. A wall nobody verifies is a wall that erodes.

One positioning line: **files, not databases** — everything here is git-versioned, human-auditable
markdown and JSON, _verified_ rather than stored; sync tools distribute content and memory layers
store it, but nobody else verifies truth over time across repos.

## Non-goals (deliberate, standing)

- **No dashboard.** A standing refusal: the sweep renders one line per project and detail only
  for what needs eyes. Aggregated output is never rendered or described as a dashboard.
- **No aggregation product.** The fleet result is a local report, not a hosted anything.
- **No content sync.** etymd never copies contract content between repos; it verifies claims.
- **No MCP yet.** An access layer (`fleet serve`) is a named v2 candidate, gated on evidence.
- **No transcript reading.** Session logs are out of scope, permanently by default.

## The manifest pair

Two files beside each other; the split IS the security model:

- `registry.json` (tracked, publishable by construction): names, kinds, profiles
  (`personal | corp`), root-relative paths for personal entries, per-entry `staleAfterDays` /
  `stateBudget`, contract-file overrides, upward links, `trust: "public-repo"` markers. Corp
  entries are **opaque aliases with no path**.
- `registry.local.json` (gitignored, machine-local): `machineProfile`, the real `dirs` behind
  corp aliases, human-readable `labels`, and `corpHosts` — each of which is itself an employer
  identifier and therefore never tracked.

`~` expansion is consumer-side; the tracked file never records a machine home. A corp entry with
the local file absent is an explicit problem carrying a one-line rebuild recipe — never a silent
skip. `machineProfile: "personal"` resolves corp entries disclosed-absent. The legacy corpus
shape (`sources.json` + `sources.local.json`) loads through the same resolver.

One line on the obvious analogy: this rhymes with Backstage's catalog-info, and diverges on
purpose — a single file, agent-consumed, no portal; a catalog importer is out of scope.

## Command surface (0.2.0)

- `etymd fleet` — the sweep: one read-only audit per resolved entry; `--manifest` required
  unless the cwd holds `registry.json` (**no env var, no global pointer** — a global pointer is
  an enumeration primitive from any cwd). Rendering: `name · state-age/staleAfterDays · open
counts by tier · Δ vs last sweep`, detail blocks only for new or risk findings; the delta
  baseline lives in `last.fleet.json` beside the manifest (gitignore it), and a filtered sweep
  never moves it.
- `etymd fleet check` — manifest validation only, zero lenses: parse errors, dangling path/dir
  mappings, duplicate names, a private entry leaking a `path`, dead link targets, absolute
  `/Users/` paths in the tracked file. Non-zero exit on any finding.
- `etymd fleet dismiss <name> <id> --reason` / `fleet accept <name> <id>` — one command from any
  cwd; reuses the single-repo ledger logic against the entry's persistence root.

## Persistence: the wall is structural

- The sweep **never creates `.etymd` anywhere**; `--persist-ledgers` persists only into
  personal-profile repos that already opted in.
- A **corp worktree takes zero writes, ever** — regardless of flags, and even when a stray
  `.etymd` already exists inside it. Pinned by test.
- Corp findings are still ledger-dismissible (flag fatigue is what kills reports): their
  persistence root is `<manifestDir>/corp/<name>/.etymd/`, beside the manifest, inside the zone
  that never pushes.
- Partition invariant, pinned by test: after a sweep over corp entries, zero corp-resolved
  content exists under the manifest repo's tracked paths.
- Fleet-scope **wall findings are not ledger-quietable in 0.2** — they name leak and partition
  conditions whose only honest resolution is fixing them.

## Freshness across the fleet

Every date is a git committer date (`git log -1 --format=%cI`), never mtime. Staleness stays
RELATIVE (the dormant-repo rule from the state-freshness lens holds fleet-wide). Entries with an
`upstream` remote are measured on **fork-authored commits only**
(`HEAD --not --remotes=<upstream>`): upstream traffic merged into a fork must not make the
fork's state look stale, and a pure mirror — zero fork-authored commits — reads as dormant. When
the named remote is absent, the sweep falls back to the full clock and says so.

## Relationship to ADR

`DECISIONS.md` entries are deliberately close to MADR so nothing needs translating:

| MADR field                 | D-entry equivalent                                              |
| -------------------------- | --------------------------------------------------------------- |
| Title                      | heading title (`## D-NNN — YYYY-MM-DD — title`)                 |
| Date                       | ISO date in the heading (adopted from ADR practice)             |
| Status: accepted           | implicit — an appended entry is accepted                        |
| Status: superseded         | a later entry's `Supersedes:` — bidirectional links adopted     |
| Decision Outcome           | `Decision:`                                                     |
| Context / Decision Drivers | `Why:`                                                          |
| Consequences               | folded into `Why:`; future debt carried by `Revisit:`           |
| Deciders                   | omitted — solo default; absence is legal                        |
| Considered Options         | omitted — this is an append-only record, not a deliberation doc |
| (no equivalent)            | `Scope:` — what the decision binds (mandatory field)            |
| (no equivalent)            | `Revisit: YYYY-MM-DD`                                           |

The differentiator is the last row: **a past `Revisit:` date becomes a finding** — review debt
surfaces in the sweep instead of silently hardening into policy. This is verification,
deliberately not enforcement: etymd tells you the date passed; what happens next is yours.

Existing ADR conventions (`docs/adr/`, `docs/decisions/`, `NNNN-*.md` under `docs/`) are
recognized as native decisions artifacts — registered, never migrated.

## The five-clause anti-self-opinionation test

Every shipped fleet default, field, finding, and doc must pass all five (review-time checklist):

1. **One-line exit** — any convention can be abandoned with a one-line change (delete a marker,
   remove an entry); no tooling ceremony holds you in.
2. **Absence is legal** — a missing artifact is disclosed, never manufactured;
   `placement: "none"` is a legitimate declared state, not a gap.
3. **Tool-death survival** — every artifact (manifest, state docs, decisions files) stays fully
   useful with etymd uninstalled.
4. **Name-blind** — zero owner vocabulary on any shipped surface (docs, fixtures, pack); the
   public-hygiene needle check polices the product with the product.
5. **Opinionated about honesty, never taxonomy** — findings enforce disclosure and truth
   (skipped checks say so, absent facts are named), never a required folder layout, vocabulary,
   or workflow.

## Sliced delivery

1. Freshness facts + the `state-freshness` lens (shipped ahead of this doc — value on existing
   per-repo gates, zero new ritual).
2. Manifest loader + `fleet` / `fleet check` / `fleet dismiss|accept` + wall findings — 0.2.0,
   this document.
3. Sidecar `contractDir` audits: a hive-side contract's claims verified against the corp repo
   root it describes.
4. Deferred, evidence-gated (see ROADMAP): `fleet serve` (MCP access layer), `fleet init`
   scaffolding (not before three measured hand-scaffold events), the standalone convention spec.
