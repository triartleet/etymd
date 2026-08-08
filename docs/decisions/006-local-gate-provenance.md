# 006 — Local gate provenance: what the tool may read, and what it may rewrite

Scope: etymd — the local-gate machinery (`gate-integrity` lens, hook generation, `etymd gates`).

_Status: implemented. Two defects found in field use, both in the machinery that decides what a
repo's local gates are and whether etymd may replace them. They are recorded together because
they are the same mistake pointed in opposite directions: in one the tool refused to read
something it had itself written, in the other it refused to write something it had itself
written._

## The shared root

Etymd generates a hook, then later has to answer two questions about it: **what does it enforce?**
and **is it still mine to replace?** Both answers were being derived from a partial view of a file
the tool authored — and in both cases the tool had, on disk, everything it needed to answer
exactly, and guessed instead.

A guess in this position does not degrade gracefully. A gate is a thing that either runs or does
not, and a tool whose whole claim is "your instructions are true" cannot hedge about it.

## Decision 1 — the lens follows the `<hook>.local` include

**What was wrong.** Every generated hook opens by sourcing a sibling companion:

```sh
LOCAL="$(dirname "$0")/pre-push.local"
if [ -x "$LOCAL" ]; then
  "$LOCAL" "$@" || exit 1
fi
```

That companion is the sanctioned extension point — the seam that lets a repo keep its own guards
without hand-maintaining a generated file (the reasoning is in `pack/templates.ts`). The
`gate-integrity` lens stopped at the hook file. A check placed in the companion ran on every push
and blocked it, and the lens reported it as enforced **only in CI**, telling the user to wire in a
gate they had already wired.

**Why that is worse than an ordinary false positive.** The only way to silence it was
`etymd ledger dismiss`, which exists for a false positive or an accepted trade-off. Neither
applied: the check was real, the enforcement was real, and the tool simply could not see it.
Recording a blind spot as a judgement corrupts the ledger — the one place the tool keeps its
memory of what has already been reasoned about.

**The decision.** When the lens collects what a hook enforces, it resolves the companion and
collects from it too. This is not inference about arbitrary shell files: etymd emits the include,
knows the exact path, and is reading its own output. Applied uniformly to `pre-commit.local`,
`pre-push.local` and `commit-msg.local`.

Two conditions keep it precise, both mirroring what the shell does rather than what we hope:

1. **The hook must genuinely reference the companion.** A hand-written hook that does not call it
   gets nothing attributed to it.
2. **The companion must pass the same `[ -x ]` test the hook applies.** A present-but-not-
   executable companion is skipped by the hook on every push, so its checks are not counted. It
   is reported as inert instead, with the `chmod +x` that would make it run — a silent gate named
   rather than quietly credited.

Where the execute bit is not a meaningful question (Windows has no POSIX mode bits), the detector
declines to answer and the checks are counted. Precision runs in the direction that matters: a
false "you have no local gate" costs more than a missed one, because the user's response to it is
to wire a gate they already have, or to dismiss a finding that was true.

**Disclosed, per the honesty rule.** Both outcomes appear in the lens report: which companions
were counted, and which exist but cannot run.

## Decision 2 — a generation stamp splits stale from hand-edited

**What was wrong.** `etymd gates` refused to overwrite any hook whose content differed from what
it would generate, reporting `kept (hand-edited)`. `differs` was one bucket holding two states
with opposite correct answers:

- **hand-edited** — someone customised it; overwriting destroys their work. Refuse.
- **stale** — etymd generated it, nobody touched it, and the repo's own inputs moved underneath:
  a renamed script, a changed package manager, an older pack. The file is now a gate that no
  longer matches the repo. Regenerate.

Conflating them meant the protection actively **preserved a broken gate**. A repo that changed
package manager kept a hook running the old one; `etymd gates -y` printed the correct new plan
and then declined to write it, while `etymd audit` went on reporting the very gaps that rewrite
would have closed. The tool was reporting a real gap it was itself refusing to close, and the
only escape — delete the file and re-run — is not something a user has any reason to guess.

**The decision.** Generated shell files carry a stamp as their last line:

```
# etymd:generated pack-v6 <16 hex chars>
```

The digest covers the file **minus that line**. A file that still hashes to its own stamp is
byte-for-byte what etymd wrote and therefore cannot contain anyone's work — safe to regenerate.
Any edit breaks the match, including an edit to the stamp itself or a line appended below it, and
the file is hand-authored again. Three states replace the boolean:

| state       | meaning                               | `gates` does |
| ----------- | ------------------------------------- | ------------ |
| `stale`     | provably our own output, inputs moved | regenerates  |
| `edited`    | stamped, bytes have since changed     | keeps        |
| `unstamped` | no stamp — unknowable                 | keeps        |

`[differs]` stops being one bucket in the plan output too: a stale file is tagged `[stale]` and
says it is being regenerated; the other two say why they are being kept.

**Why a marker in the file rather than a hash in `.etymd/`.** A side record has to survive clone,
branch switch and history rewrite to stay true, and a clone that lacks it would read every
untouched hook as hand-edited. The stamp travels with the bytes it describes, needs no state
directory, and is verifiable by anyone with the file.

**This does not reopen the marked-region question.** Generation deliberately keeps hand-written
text out of the compared file so drift stays byte-exact (see `pack/templates.ts`). The stamp is
pack-owned output, regenerated with the file and never a place to write anything; the repo's own
text still lives in the companion, which etymd does not read or write. The `.local` seam is what
makes refusing-to-overwrite affordable in the first place — there is a place to put your work
that is never a candidate for regeneration.

**Accepted limitation.** A hook generated before stamping existed carries no stamp, and no
evidence can prove it untouched. It lands in `unstamped` and is kept — with the reason stated and
the way out named, instead of the old dead end. It becomes provable the first time it is
regenerated. The asymmetry is deliberate: a stamp can prove a file is safe to replace, never that
it is unsafe.

## Decision 3 — provenance is a property of everything the pack generates

The two defects above were both the tool guessing about a file it had authored. Fixing them only
where they hurt would leave the same guess in place everywhere else, waiting. So the stamp is not
a hook feature:

**Every generated artifact carries it, in that file's own comment syntax.** Shell scripts take
`#`, the `AGENTS.md` scaffold takes an HTML comment — a stamp that renders as visible text in the
document it describes is a defect in the document. The scaffold's stamp replaces the bare
`<!-- etymd pack vN -->` comment, carrying the same version plus the provenance, so the file gains
information without gaining a line. It also answers a question that comment could not: whether
anyone has filled the contract in yet, or it is still untouched boilerplate.

`.etymd/config.json` is deliberately excluded. It is not generated — it is merged into, holds the
user's recorded decisions, and JSON has no comment syntax to hide a stamp in.

**The fleet sweep stops giving advice that will be refused.** `checkGateDrift` reported every
differing gate under one finding whose action was "re-run `etymd gates`". For a hand-edited hook
that command declines — so the sweep was telling an owner to run something that would not work,
which is the same dishonesty as decision 2 one level up. A provably-edited gate is now disclosed
as a customisation rather than reported as drift; `stale` and `unstamped` stay in the finding,
because "cannot prove it was touched" is not evidence that it was.

Note the direction: this **removes** reports rather than adding them. Splitting a bucket usually
grows the surface — here the honest half of it was never drift to begin with.

## Decision 4 — an unrunnable companion is a finding, at `gap`

Decision 1 left the inert case as a disclosure, which was the conservative move and the wrong one.
A disclosure does not rank, does not gate, does not reach the ledger, and gets skimmed. Meanwhile
the condition is precisely the silent failure this tool exists for: a check the repo believes it
runs, that the `[ -x ]` guard skips every time, on a file etymd's own instructions told the user
to create. It is also likely rather than theoretical — someone writing that file by hand will
forget `chmod +x`, and git tracks exactly one permission bit, so the dead gate then propagates to
every clone.

**Tier: `gap`, not `risk`.** The obvious move was matching `hooks-not-wired`, which is risk — but
that finding earns it because EVERY gate is dead there, which is what "makes an agent do the wrong
thing" means. One companion not running is a missing safeguard, which is what `gap` means. The
practical consequence points the same way: `--fail-on risk` fails only on risk findings, so
shipping this at risk would break the push gate etymd itself recommends, on upgrade, in repos
whose code never changed. Both readings agree, so the vocabulary decides it rather than caution.

**Kind: `truth`.** The file is called, it is present, and the mode bit says it will be skipped —
computed, not opined. So `doctor` must not skip it.

**The guard that keeps it honest.** "Not executable" is only trusted where the execute bit is
demonstrably meaningful, and the HOOK's own bit is what establishes that. A filesystem carrying no
bits reports everything as non-executable, so an unguarded check would tell every such checkout
that its working gate is dead. The claim therefore requires an asymmetry — the hook has the bit,
the companion beside it does not. Where that cannot be established the checks are counted and the
uncertainty is disclosed, never converted into an accusation. Three companion states result:
counted, counted-but-unverified, and provably inert.

**The action names both halves of the fix.** `chmod +x` alone does not survive a fresh clone;
`git update-index --chmod=+x` is what makes the mode stick for everyone else. An action that fixes
the reporter's machine and leaves the fleet broken is not a fix.

**Known false positive, accepted:** someone may clear the execute bit deliberately, as a way to
park a guard. The template documents deleting the companion as the way to stop it running, so this
is not the sanctioned path — but people will do it, and for them this is a genuine trade-off to
dismiss. That is what a ledger dismissal is for, and unlike the blind spot in decision 1, the
dismissal would be honest.

## What this cost the design

Nothing on the objective axis. No predicate was added, no lens, no configuration field. Decision 1
removes a false finding, decision 2 a false refusal, decision 3 a false instruction; decision 4
adds the one finding id in the set, for a condition the tool could already see and was merely
declining to rank. All four are the tool learning to read what it already wrote.

`PACK_VERSION` moves to 6: the generated files change meaning.
