# 005 — Declared rules: what a user asserts, and why

_Status: design. The model below is not yet implemented as described — `kind` has moved to the
finding (step 1, done), and `gates._why` is shipped and in use, but declared rules, the predicate
vocabulary, and the `profile` → properties migration are design only. The `.etymd/config.json`
schema is EXPERIMENTAL through 0.2.x; every field below lands inside that window or not at all._

## The problem this closes

Etymd computes claims about a repository and reports where they are false. That works while every
claim is one the tool can derive on its own. It breaks the moment a user needs a check the tool
does not know how to make — and it breaks in a specific way: the need gets served by adding the
check _into the tool_, shaped by whoever asked first.

That happened. A week of features — a `trust` vocabulary, publish-route detection, a fleet
gate-drift pass — were each added because one fleet had a gap, and each shipped as though it were
a general truth. The tool grew an opinion per need, and the opinions were not the users' to hold.

The fix is not more features. It is a way for a user to state their own checks, with their own
reasons — so the shipped surface can stop growing and start shrinking.

## Correcting the record this design started from

Two corrections, both found by stress-testing an earlier draft. They are kept here because each
one deleted a large piece of the design, and the reasoning matters more than the outcome.

**1. `LensKind` does not already make the cut this record needs.** The earlier draft claimed
`truth | improvement` (`src/engine/finding.ts`) was the seam, needing only a user-facing name.
On disk, `kind` sits on the **lens** while `tier` sits on the **finding**, and they disagree:
`gate-integrity` is `kind: "improvement"` yet emits `hooks-not-wired` at `tier: "risk"` —
_"tracked hooks exist but never run"_ is as objective as anything the truth lens reports. The live
consequence: `etymd doctor` filters to truth lenses and **silently skips that risk finding**.

So `kind` belongs on the finding, not the lens, and that fix comes **before** any of this is named
for users — otherwise the vocabulary inherits the inconsistency.

**2. Executing user commands was a solution in search of a need.** The earlier draft's centrepiece
was a `run` field: a user names a shell command, non-zero exit is a finding. It arrived by
reflex — user-defined verification → the exit-code contract is the standard answer — and every
example was invented _after_ the mechanism, not before.

Tested against real cases, it collapsed. The one genuine motivating need (_"I gate at `gap`
because no stricter rule can fire here"_) is etymd evaluating its own lenses — a function call.
Two other candidates were repo-state questions in disguise. Nothing that survived needed a
subprocess.

And execution was expensive: consent keyed on a command hash **silently transfers** when the
script behind `npm run x` changes; timeouts, cwd in monorepos, shell portability and Windows all
become permanent surface; and `etymd audit` stops being unconditionally safe to point at a
stranger's repository — a change to the tool's character larger than any schema cost.

**Cut.** What remains is declarative, and the entire consent apparatus disappears with it: there
is nothing to consent to.

## The model

### Derived and declared

- **Derived** — etymd computed it. No author. The founding promise: _"AGENTS.md says run
  `npm run start`; no such script exists."_
- **Declared** — someone asserted it, and it carries a **warrant**: their reason. Covers an
  opinion held from the start as readily as one adopted later; the record does not care whether a
  value changed, only that a person chose it and can be asked why.

### The discipline

> **Etymd ships an opinion only if it can mechanize the check.**

Necessary, and **not sufficient**: `trust` is fully mechanized and still parochial. So a second
test applies to every shipped surface — the question the week of features never asked:

> **Would a user who is not us ever set this?**

Both, plus the five-clause anti-self-opinionation test in
[004](004-fleet-truth-guard.md#the-five-clause-anti-self-opinionation-test), gate everything the
package ships.

### Checkability is a property, not a category

- **verifiable** → etymd evaluates it and emits findings that name the declaration behind them.
- **not verifiable** → recorded with its warrant, surfaced beside what it governs, **never a
  finding**.

The second half is load-bearing. Flagging an unverifiable reason as a defect punishes documenting
and teaches people to delete their warrants. Absence of proof is a **disclosure**; only proof of
absence is a finding — 004's honesty rule applied to policy.

## Declared rules

A rule is a **predicate over repository state**, evaluated by etymd, with a reason attached.

```jsonc
{
  "rules": [
    {
      "id": "agents-lean",
      "check": { "file": "AGENTS.md", "underWords": 4000 },
      "why": "read every session; past this it stops being obeyed",
      "tier": "gap",
    },
    {
      "id": "adr-series",
      "check": { "series": "docs/decisions/*.md", "gapless": true },
      "why": "a missing number means a decision was made and never written down",
    },
  ],
}
```

| field   | meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `id`    | stable finding id — the ledger keys on it, so dismissals survive     |
| `check` | a predicate over repo state (vocabulary below)                       |
| `why`   | the warrant, printed verbatim beside every finding the rule produces |
| `tier`  | `risk` \| `gap` \| `polish` — default `gap`                          |

**Etymd runs nothing.** Every predicate reads files, lists directories, or consults etymd's own
findings. No subprocess, no shell, no consent model, no timeouts — and `etymd audit` stays safe to
point at any repository, which is a property worth more than the flexibility given up.

### The predicate vocabulary

Deliberately small. Each entry is a shipped opinion about what is worth checking and must pass
both tests above.

| predicate                          | reads              | reuses                              |
| ---------------------------------- | ------------------ | ----------------------------------- |
| `{ file, exists }`                 | the filesystem     | the `stale-path` machinery          |
| `{ file, underWords }`             | file contents      | `wordCount` (`src/core/util.ts:53`) |
| `{ series, gapless }`              | a directory glob   | —                                   |
| `{ auditAt: "risk", empty: true }` | etymd's own lenses | the engine, in-process              |

`auditAt` is the one that earns its place: it turns _"I gate at `gap` because no stricter tier can
fire here"_ into a check that fails by itself the day the repository changes — the exact case that
motivated this record, mechanized without a subprocess.

**The vocabulary is where scope creep will re-enter.** A predicate set is a small DSL, and 004's
non-goals reject policy languages. The defence is that four typed JSON predicates are not a
language — but a defence that lives only in prose is the same defence that failed for a week.

### The fitness test for a new predicate

A prose warning does not survive contact with a real need at 5pm. Every candidate answers all
five, in writing, in the pull request that adds it. A "no" is a rejection, not a discussion.

1. **Would a user who is not us ever ask for it?** Name a plausible user and their situation
   without using this fleet's vocabulary. If the only example is ours, it belongs in a rule we
   declare, not a predicate we ship.
2. **Is it a question about repository state?** Not about the world, a network, a clock, or
   another program's behaviour. If evaluating it needs anything but reading files, it is out of
   scope by construction — that is what deleted `run`.
3. **Does it compose, or does it special-case?** A predicate is a general shape parameterized by
   the user. `{ file, underWords }` is a shape; `{ agentsFileUnder4000 }` is our policy wearing a
   predicate's clothes.
4. **Is it already expressible?** With the existing four plus a parameter, or by a native lens. A
   second way to say the same thing costs a permanent branch in the config schema and buys a
   synonym.
5. **What does its absence actually cost?** Name the check that becomes impossible — not
   inconvenient. If the honest answer is "a user writes two rules instead of one", that is the
   correct outcome, not a gap.

**The count is the alarm.** Four predicates is the design; six is a signal to re-read this
section; anything approaching ten means the set has become a language and 004's non-goal has been
breached in fact whatever the prose says. The number is not a limit to be argued down — it is the
tripwire that says the discipline stopped working.

**Deletion is a first-class move.** A predicate that no rule in the wild uses is not neutral
weight: it is schema surface, a doc entry, and a thing every future contributor must reason
around. Removing an unused one is a change worth making on its own.

### Declared rules are `improvement`, never `truth`

Truth is etymd's promise about what it computed. A user's predicate is a defensible position,
which is what `improvement` means. Preserving that line keeps the split meaningful.

**Known consequence, accepted:** a declared rule cannot be part of the truth-only `doctor` subset.
Users will want their most important rule to gate CI; `--fail-on` operates on tier, and a declared
rule can be `tier: "risk"`, so it can gate — it simply cannot claim to be etymd's own truth.

### What etymd checks, reports, and refuses

- **Checks:** the declaration parses; the predicate is known; its parameters are sane; the paths
  it names exist. A rule pointing at a missing file is the `stale-path` class.
- **Reports:** which rule produced a finding, and its warrant verbatim.
- **Refuses:** whether the rule was a good idea.

A predicate that cannot be evaluated is a **disclosure**, never a pass.

## Warrants

Free prose in `why`, printed with every finding its rule produces, never interpreted.

**No author field yet.** Attribution without identity resolves to `git config user.email` or a
self-declared marker: forgeable, and nothing would consume it. The real risk is an unattributed
agent-written warrant reading as the maintainer's — one enum value (`human | agent | unknown`)
added when something reads it, not before.

**Warrants elsewhere.** `gates._why.<field>` (built) is the same primitive for config values,
including the property that an entry is **dropped when the value it explains changes** — a reason
attached to a value it no longer explains misleads exactly where it meant to inform. The
`.githooks/*.local` companion's warrant is a comment in the file, which is sufficient.

## Presets

A preset is not a separate system: it is a rule with the predicate pre-filled, shipped
**disabled** and with an **empty warrant**, so enabling one is always an act with an author.
Etymd never says "you should do this" — it says "here is a shape people commonly want; enable it
if you agree, and write your own reason."

**Only a rule etymd can implement and test ships as a preset.** A preset is code in the package:
it moves with the tool, is typechecked, appears in the suite. A documented snippet is what rots,
because nothing executes it — this is the answer to the curation worry.

Candidates map one-to-one onto the predicate vocabulary, chosen so each teaches a **different kind
of thing a rule can examine** rather than building a checklist: a measurable property
(`underWords`), a structural invariant over a set (`gapless`), and the tool's own output
(`auditAt`).

Anything already native — `stale-path`, `screen`, `hooks-not-wired` — is excluded: a preset must
not re-teach what the tool already asserts.

## What execution would have been for, and why it is not here

The residue that genuinely needs a program is thin and already served twice:

- **"do the tests pass", "is typecheck clean"** — gates and CI. `gate-integrity` already reasons
  about these without running them; an audit tool asserting them would duplicate the gate it tells
  you to install.
- **bespoke org policy** (the 168-line archive-guard class) — `.githooks/*.local`, which runs at
  commit time with no consent model because the user invoked git.

If someone shows a check that is not a predicate, not a gate, and not a hook, that is the evidence
to reopen this. Shipping an execution engine on speculation is the pattern this record exists to
end.

## Properties, not zones

`FleetProfile = "personal" | "corp"` encodes one fleet's employer separation as the fleet model's
architecture: **63 `corp` references in the fleet engine, 30 in the loader, 10 in commands**. A
stranger with a fleet has no employer wall; they have repositories with different exposure.

The obvious fix — rename `corp` to `restricted`, or add a richer zone vocabulary — is the wrong
shape. A zone is a **taxonomy**, and a taxonomy forces a judgment at registration time
(_"is this project restricted?"_ — restricted from what?) while making every new zone appear to
need a position on every behaviour. That is the "judgmental complexity" this record is trying not
to ship.

**The word was doing two independent jobs, and the code already separates them.** `private` is
already its own boolean (`src/core/fleet.ts:71`), and the branches divide cleanly: four sites test
`corp || private`, three test `corp` alone. Two latent properties, named:

| property    | means                                                   | drives                                                              |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `aliasOnly` | this repo's real path must not appear in a tracked file | opaque alias; the path resolves only from the gitignored local file |
| `localOnly` | nothing etymd writes may land inside this repo          | ledger redirected beside the manifest, never written in-repo        |

All four combinations are meaningful, so no cell requires a judgment call:

|                    | `localOnly: false`                                | `localOnly: true`                          |
| ------------------ | ------------------------------------------------- | ------------------------------------------ |
| `aliasOnly: false` | an ordinary repository                            | scratch work that never leaves the machine |
| `aliasOnly: true`  | client work, synced but unnamed in a tracked file | what `corp` means today                    |

A user who needs neither writes nothing. Nobody picks a category; they state two facts.

**`profile` leaves the entry schema entirely** — no `personal`, no `corp`, no replacement word.
`machineProfile` stays, because it describes the _machine_, not a repository.

**Explicitly parked: the relational checks.** The corp-email check (`src/engine/fleet.ts:597`) runs
on _personal_ entries and flags employer-domain authors; the hygiene-needle check is the same
shape. Neither is a property of a repository — both assert _"identifiers associated with A must
not appear in B"_, which is a relationship. Forcing them into properties would reintroduce exactly
the complexity this section removes. They stay as they are until a second user gives evidence for
a relationship concept.

**Cost:** a schema change with migration implications, and the only breaking item in this record.
The experimental window is the cheap moment; after 1.0 it is permanent.

## What this deletes

Against _"would a user who is not us ever set this?"_ — verdicts are the INTENDED end state;
items marked **demote** or **delete** are not yet applied and remain live until the properties
migration (sequencing step 6) runs.

| feature          | verdict                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `screen`         | **keep** — mechanism ships, policy is the user's, zero bundled patterns                                  |
| `publishRoute`   | **keep** — npm vs vsce is a fact about the world                                                         |
| fleet gate-drift | **keep** — "do my repos have the hooks I think they do" is general                                       |
| `publishable`    | **keep, rename** — it measures "npm would publish this", not a judgment                                  |
| `trust`          | **demote** — the needle check is general; the three-level vocabulary is ours                             |
| `profile`        | **delete (pending)** — to be replaced by `aliasOnly` / `localOnly`; the type is still live in the source |

## Non-goals (deliberate, standing)

- **No execution of user commands.** Cut with reasons above; reopen only on evidence.
- **No DSL or policy language.** The predicate vocabulary stays small and argued.
- **No plugin API, no user code in-process.**
- **No verifying warrants.** Etymd verifies the deviation still exists and shows its reason;
  whether the reason was good is the reader's judgment.
- **No preset carrying our vocabulary.** Shapes generalize; framings do not.

## Sequencing

1. **Move `kind` from lens to finding** and fix the `doctor` skip. Prerequisite for everything
   else; independently valuable.
2. **Glossary entry** for derived/declared — the user-facing distinction, no new machinery.
3. **Per-rule severity with a reason** — lets a user turn off any shipped opinion, delivering
   "opinionate it yourself" before declared rules exist at all.
4. **Declared rules** with the four predicates.
5. **The deletion table**, which is where the tool actually shrinks.
6. **`profile` → properties**, last, with a migration plan — the only breaking change.

Steps 1–3 deliver most of the value with no new concepts. If 4 never happens, 1–3 still stand on
their own.

## Open questions

1. **Where a preset's parameter validation lives** — a missing or absurd `underWords` should be a
   config problem, not a rule failure.
2. **Whether `rules` belongs in `.etymd/config.json` or its own file** once the array grows —
   etymd's own context-economy lens flags heavy files, and config already carries four sections.
3. **Property migration** — `profile` is written in existing manifests, so removing it needs a
   read-both-write-new period or a one-shot rewrite. Deciding which is the last open item.
