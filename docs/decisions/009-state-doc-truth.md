# 009 — State documents are checked for truth, not only for age

Scope: etymd — the instruction-truth lens, state documents, and decision references.

_Status: implemented._

## The unaudited surface

The lens set split the document layer in two: instruction files went to instruction-truth
(commands, paths, cross-references verified against the repo), state documents went to
state-freshness (age against commit traffic, character budget). Nothing checked what a state
document actually SAYS. A state doc could assert a command that does not exist, a path that was
deleted, or a decision id that was never written, and every audit stayed green.

That gap sat on the worst possible surface. A state document is the first thing read on returning
to a project — it is the file that answers "where was this left" — so it is the highest-leverage
place in a repo for a false claim to sit. And state documents drift fastest, because they describe
what is changing. The observed shape: a state doc claimed a push gate ran a lint script, in a repo
with no package manifest at all; the claim survived every audit and misled the sessions that read
it. The tool's own thesis, pointed back at the one layer it skipped.

## State docs get the same truth checks, plus one of their own

Instruction-truth now audits every detected state document with the same command-claim and
path-claim machinery instruction files get — same skip classes, same disclosures, same finding
ids. A file already pulled in via `instructions.include` is never audited twice.

One check is new, because it only makes sense for state docs: **decision references**. Where the
repo has a decisions file with `## D-NNN` entries, a `D-NNN` citation in a state doc must resolve
to an entry that exists. A state doc citing an id the record never wrote is stale in a way age
cannot reveal — the file may have been edited yesterday and still cite nothing.

Tiers follow the existing definitions rather than the incident's severity: a dead command is
`risk` (an agent will run it), a dead path or dead decision reference is `gap` — a dead reference
is a gap by the tool's own definition, and consistency matters more than emphasis.

## Precision holds at two new edges

**Foreign records.** Prose legitimately cites OTHER ledgers ("peer D-050", "upstream D-014").
A reference immediately preceded by a word that is not connective prose or a citation verb is
treated as naming another record — skipped and disclosed, never accused. The skip errs safe: an
unlisted verb costs a check, never a false "your file is lying".

**Unverifiable records.** A directory decisions convention carries no parseable `D-NNN` ids, so
citations against it are disclosed as unresolvable, not flagged. Same for a repo with no decisions
artifact at all.

## A manifest-less repo can verify script claims

The "node_modules not installed → script claims unverifiable" guard existed because an unknown
command might be an uninstalled binary. In a repo with NO package manifest anywhere, nothing could
ever satisfy a script claim — no install will ever exist — so those claims are now checkable, and
false. Without this, the exact observed defect (`npm run lint` claimed in a manifest-less repo)
stays green forever, which is why the guard is narrowed rather than kept whole.
