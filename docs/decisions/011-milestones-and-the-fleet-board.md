# 011 — Milestones are a contract file; the fleet board is their rollup

Scope: etymd — the fleet manifest contract, the sweep's shape check, and `fleet board`.

_Status: implemented._

## Why

A fleet manifest (004) says what exists and where. It says nothing about where each project is
going. Every hosted agent product that offers a "plan" surface keeps it in its own database;
none reads a plan a repository already carries. A fleet's owner then holds the plan in their
head, opens whichever project they fancy, and no scheduler or automated runner can rank work
because nothing machine-readable says what matters.

The fix is not a planning product. It is one more contract file with a fixed shape, and one
rollup that reads them all.

## Decision

1. A project may declare `contract.milestones` in the manifest (by convention `MILESTONES.md`;
   `"none"` declares a deliberate absence). `fleet add` registers the file when it is present at
   registration; it never defaults to `"none"`, which is a decision, not a scan result.
2. The file's shape is law: a `# Milestones` heading, then a table with exactly the columns
   `id | milestone | goal | status | next | effort | depends-on`. `id` is `M<n>` and unique;
   `goal` is `1`, `2` or `3` — a fleet's own ordered goals, declared outside this tool; `status` is
   `planned | active | blocked | done`; `next` is the one concrete next step and may not be
   empty; `effort` is `S | M | L` remaining; `depends-on` is `—` or ids from the same table.
   Prose after the table is never parsed. A header-only table is a legitimate state: declared,
   empty.
3. The sweep checks the shape, not only existence: a declared file that is absent is a gap
   (`fleet-manifest/milestones-missing:<name>`), each shape defect is a gap
   (`fleet-manifest/milestones-shape:<name>:<n>`). Undeclared and `"none"` are silent.
4. `etymd fleet board` renders one page: an optional ranked initiatives table (`rank | id |
initiative | goal | status | next | effort | projects | depends-on`, the hand-edited
   fleet-level half, where `rank` is an order and duplicates are refused), then every personal
   project's rows grouped by project with its state named (ok, declared-empty, not-declared,
   none, missing, invalid, unresolved), then totals. Guarded entries never appear: the board is a
   publishable artifact of the personal side. The stamp is day-precision and the output is
   deterministic, so a committed board does not churn. Exit code 1 when any project is missing
   or invalid; the board still renders — the holes are the information.

## Rejected

- Frontmatter or YAML for the plan: the file is written by hand at the end of a session and
  read back in a terminal; a table reads in both places, and a fixed column list is the
  smallest grammar a validator can hold a writer to (a fleet standard: label fields, do not
  guard).
- Existence-check only, like the other contract overrides: the board consumes the file
  verbatim, so an off-shape file is a plan the fleet cannot see, which is exactly a gap.
- A `goal` vocabulary owned by etymd: a fleet's goals are its own; the tool holds the writer to
  "one of three ordered goals" and nothing more.
- Reading roadmap prose: roadmap files come in as many shapes as authors; a rollup needs one
  shape.

## Verify

`etymd fleet board --manifest <registry.json> --initiatives <initiatives.md> --out <board.md>`
writes the page and reports each hole; `etymd fleet` on a project with an
off-shape file shows `milestones-shape` gaps naming the line.
