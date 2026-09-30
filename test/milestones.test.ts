import { describe, expect, it } from "vitest"

import {
  INITIATIVE_COLUMNS,
  MILESTONE_COLUMNS,
  parseInitiatives,
  parseMilestones,
  renderBoard,
} from "../src/engine/milestones.js"

const HEADER = `| ${MILESTONE_COLUMNS.join(" | ")} |\n|${MILESTONE_COLUMNS.map(() => "---").join("|")}|\n`

const GOOD = `# Milestones

One line about the project.

${HEADER}| M1 | Board renders nightly | 2 | active | seed the file fleet-wide | M | — |
| M2 | Rank drives the drain | 2 | planned | read the rank in the drain | L | M1 |

## Notes

Prose after the table is never parsed: | not | a | row |
`

describe("parseMilestones — the standard shape", () => {
  it("parses a well-formed file into rows and no problems", () => {
    const doc = parseMilestones(GOOD)
    expect(doc.problems).toEqual([])
    expect(doc.rows.map((r) => r.id)).toEqual(["M1", "M2"])
    expect(doc.rows[1]?.dependsOn).toEqual(["M1"])
    expect(doc.rows[0]?.dependsOn).toEqual([])
    expect(doc.rows[0]?.status).toBe("active")
  })

  it("a header-only table is declared-empty: zero rows, zero problems", () => {
    const doc = parseMilestones(`# Milestones\n\n${HEADER}`)
    expect(doc.rows).toEqual([])
    expect(doc.problems).toEqual([])
  })

  it("names the heading defect and still looks for the table", () => {
    const doc = parseMilestones(`# Roadmap\n\n${HEADER}| M1 | x | 1 | done | y | S | — |\n`)
    expect(doc.problems).toEqual([
      "line 1: first heading is `# Roadmap`; it must be `# Milestones`",
    ])
    expect(doc.rows).toHaveLength(1)
  })

  it("a missing table and a wrong column list are each one problem", () => {
    expect(parseMilestones("# Milestones\n\nno table here\n").problems[0]).toMatch(
      /no milestones table/,
    )
    const wrong = parseMilestones("# Milestones\n\n| id | title |\n|---|---|\n| M1 | x |\n")
    expect(wrong.problems).toHaveLength(1)
    expect(wrong.problems[0]).toMatch(/table columns are `id \| title`; the standard is/)
    expect(wrong.rows).toEqual([])
  })

  it("holds every row to the vocabulary and keeps the rows that pass", () => {
    const doc = parseMilestones(
      `# Milestones\n\n${HEADER}` +
        "| M1 | ok | 2 | active | step | S | — |\n" +
        "| M1 | dup id | 2 | active | step | S | — |\n" +
        "| M3 | bad goal | 9 | active | step | S | — |\n" +
        "| M4 | bad status | 1 | soon | step | S | — |\n" +
        "| M5 | bad effort | 1 | planned | step | XL | — |\n" +
        "| M6 |  | 1 | planned | step | S | — |\n" +
        "| M7 | no next | 1 | planned |  | S | — |\n" +
        "| M8 | dangling | 1 | planned | step | S | M99 |\n" +
        "| X9 | bad id | 1 | planned | step | S | — |\n" +
        "| M10 | short row | 1 |\n",
    )
    expect(doc.rows.map((r) => r.id)).toEqual(["M1", "M8"])
    expect(doc.problems).toEqual([
      "line 6: id `M1` is used twice",
      "line 7: goal is `9`; allowed: `1`, `2`, `3`",
      "line 8: status is `soon`; allowed: `planned`, `active`, `blocked`, `done`",
      "line 9: effort is `XL`; allowed: `S`, `M`, `L`",
      "line 10: milestone title is empty",
      "line 11: next step is empty — a milestone without a next step is a wish",
      "line 13: id `X9` is not `M<number>`",
      "line 14: 3 cells, expected 7",
      "M8 depends on `M99`, which is not in the table",
    ])
  })
})

describe("parseInitiatives — the ranked table", () => {
  const IHEADER = `| ${INITIATIVE_COLUMNS.join(" | ")} |\n|${INITIATIVE_COLUMNS.map(() => "---").join("|")}|\n`

  it("sorts by rank and reads project lists", () => {
    const doc = parseInitiatives(
      `# Initiatives\n\n${IHEADER}` +
        "| 2 | I2 | second | 1 | planned | step | M | a, b | I1 |\n" +
        "| 1 | I1 | first | 2 | active | step | L | a | — |\n",
    )
    expect(doc.problems).toEqual([])
    expect(doc.rows.map((r) => r.id)).toEqual(["I1", "I2"])
    expect(doc.rows[1]?.projects).toEqual(["a", "b"])
  })

  it("a rank is an order: duplicates and non-integers are problems", () => {
    const doc = parseInitiatives(
      `${IHEADER}` +
        "| 1 | I1 | a | 2 | active | step | L | — | — |\n" +
        "| 1 | I2 | b | 2 | active | step | L | — | — |\n" +
        "| high | I3 | c | 2 | active | step | L | — | — |\n",
    )
    expect(doc.rows.map((r) => r.id)).toEqual(["I1"])
    expect(doc.problems).toEqual([
      "line 4: rank 1 is used twice — a rank is an order, not a score",
      "line 5: rank `high` is not a positive integer",
    ])
  })
})

describe("renderBoard — one page, every state named", () => {
  it("renders initiatives, per-project sections, and totals deterministically", () => {
    const good = parseMilestones(GOOD)
    const md = renderBoard({
      generatedOn: "2026-09-04",
      manifest: "registry.json",
      initiatives: parseInitiatives(
        `| ${INITIATIVE_COLUMNS.join(" | ")} |\n|${INITIATIVE_COLUMNS.map(() => "---").join("|")}|\n| 1 | I1 | The scheduler | 2 | active | board first | L | core | — |\n`,
      ).rows,
      initiativesProblems: [],
      projects: [
        {
          name: "core",
          kind: "tool",
          file: "MILESTONES.md",
          state: "ok",
          rows: good.rows,
          problems: [],
        },
        { name: "quiet", state: "not-declared", rows: [], problems: [] },
        { name: "mirror", file: "none", state: "none", rows: [], problems: [] },
        { name: "gone", file: "MILESTONES.md", state: "missing", rows: [], problems: [] },
        { name: "empty", file: "MILESTONES.md", state: "declared-empty", rows: [], problems: [] },
        {
          name: "broken",
          file: "MILESTONES.md",
          state: "invalid",
          rows: [],
          problems: ["line 1: first heading is `# Plan`; it must be `# Milestones`"],
        },
      ],
    })
    expect(md).toContain("# Fleet board")
    expect(md).toContain("| 1 | I1 | The scheduler | 2 | active | board first | L | core | — |")
    expect(md).toContain("### core (tool) — planned 1 · active 1 · blocked 0 · done 0")
    expect(md).toContain(
      "| M2 | Rank drives the drain | 2 | planned | read the rank in the drain | L | M1 |",
    )
    expect(md).toContain("### quiet — not declared (no `milestones` contract key)")
    expect(md).toContain("### mirror — none, by declaration")
    expect(md).toContain("### gone — MISSING: `MILESTONES.md` is declared and absent")
    expect(md).toContain("### empty — declared, empty")
    expect(md).toContain("### broken — INVALID — 1 problem")
    expect(md).toContain("| active | 1 |")
    expect(md).toContain("| 2 | 2 |") // two open milestones serve goal 2
    expect(md).toContain(
      "Projects: 6 — ok 1 · not-declared 1 · none 1 · missing 1 · declared-empty 1 · invalid 1",
    )
    // Same input, same output — a committed board must not churn between renders.
    expect(
      renderBoard({
        generatedOn: "2026-09-04",
        manifest: "registry.json",
        initiatives: [],
        initiativesProblems: [],
        projects: [],
      }),
    ).toBe(
      renderBoard({
        generatedOn: "2026-09-04",
        manifest: "registry.json",
        initiatives: [],
        initiativesProblems: [],
        projects: [],
      }),
    )
  })

  it("escapes pipes inside cells so a title cannot break the table", () => {
    const md = renderBoard({
      generatedOn: "2026-09-04",
      manifest: "registry.json",
      initiatives: null,
      initiativesProblems: [],
      projects: [
        {
          name: "p",
          file: "MILESTONES.md",
          state: "ok",
          rows: [
            {
              id: "M1",
              milestone: "a | b",
              goal: "1",
              status: "done",
              next: "c",
              effort: "S",
              dependsOn: [],
            },
          ],
          problems: [],
        },
      ],
    })
    expect(md).toContain("| M1 | a \\| b | 1 | done | c | S | — |")
    expect(md).toContain("No initiatives file given")
  })
})
