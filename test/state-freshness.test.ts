import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readConfig } from "../src/core/config.js"
import { scanProject } from "../src/core/scan.js"
import type { LensContext } from "../src/engine/finding.js"
import { stateFreshnessLens } from "../src/lenses/state-freshness.js"

const pExecFile = promisify(execFile)

// Synthetic fixtures only — invented file contents, no real project vocabulary.
const MARKER = "<!-- decisions-format: 1 -->"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-freshness-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

/** git with a pinned identity + committer date — freshness facts are committer-date facts. */
async function gitAt(date: string | null, args: string[]) {
  await pExecFile("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  })
}

async function commitAll(message: string, date: string) {
  await gitAt(null, ["add", "-A"])
  await gitAt(date, ["commit", "-q", "--no-verify", "-m", message])
}

async function ctx(): Promise<LensContext> {
  const facts = await scanProject(dir)
  return { root: dir, facts, profile: "solo", baseline: null, config: await readConfig(dir) }
}

describe("state-freshness — relative staleness", () => {
  it("PINNED: a dormant repo produces zero findings — old state is current state", async () => {
    await gitAt(null, ["init", "-q"])
    await write("src/a.ts", "export {}\n")
    await commitAll("code", "2025-11-01T10:00:00Z")
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: none\n")
    await commitAll("state", "2026-01-01T10:00:00Z")

    const report = await stateFreshnessLens.run(await ctx())
    // The state file is months old, but nothing moved past it — staleness is relative.
    expect(report.findings).toEqual([])
    expect(report.status).toBe("ran")
  })

  it("PINNED: state fresher than the threshold, then a year of dormancy — still zero findings", async () => {
    // The strongest dormant case: the state trails the last code commit by LESS than the
    // threshold, and the repo then sleeps for over a year. A wall-clock lens would flag this
    // (the doc is ~13 months old); the relative clock must not.
    await gitAt(null, ["init", "-q"])
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: alpha\n")
    await commitAll("state", "2025-07-01T10:00:00Z")
    await write("src/a.ts", "export {}\n")
    await commitAll("code", "2025-07-15T10:00:00Z") // 14 days later — under the 30-day window

    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings).toEqual([])
  })

  it("treats a tracked state file with uncommitted edits as fresh-now, disclosed", async () => {
    // The refresh is on disk, not yet committed (e.g. an audit inside a pre-commit gate) —
    // dating it by its last commit would flag the exact moment it was brought current.
    await gitAt(null, ["init", "-q"])
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: alpha\n")
    await commitAll("state", "2026-01-01T10:00:00Z")
    await write("src/a.ts", "export {}\n")
    await commitAll("code much later", "2026-07-01T10:00:00Z") // would be stale-risk
    await write("PROJECT_CONTEXT.md", "# state\n\njust refreshed, not yet committed\n")

    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings).toEqual([])
    expect(
      report.disclosures.some((d) => d.includes("PROJECT_CONTEXT.md") && d.includes("uncommitted")),
    ).toBe(true)
  })

  it("flags state the repo moved past (gap), with committer dates as evidence", async () => {
    await gitAt(null, ["init", "-q"])
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: alpha\n")
    await commitAll("state", "2026-01-01T10:00:00Z")
    await write("src/a.ts", "export {}\n")
    await commitAll("code moved on", "2026-03-01T10:00:00Z")

    const report = await stateFreshnessLens.run(await ctx())
    const stale = report.findings.find(
      (f) => f.id === "state-freshness/stale-state:PROJECT_CONTEXT.md",
    )
    expect(stale).toBeDefined()
    expect(stale?.tier).toBe("gap")
    expect(stale?.evidence.join(" ")).toContain("repo last commit")
  })

  it("escalates to risk past 3x the threshold with continued traffic", async () => {
    await gitAt(null, ["init", "-q"])
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: alpha\n")
    await commitAll("state", "2026-01-01T10:00:00Z")
    await write("src/a.ts", "export {}\n")
    await commitAll("code much later", "2026-07-01T10:00:00Z")

    const report = await stateFreshnessLens.run(await ctx())
    const stale = report.findings.find(
      (f) => f.id === "state-freshness/stale-state:PROJECT_CONTEXT.md",
    )
    expect(stale?.tier).toBe("risk")
  })

  it("honors a staleAfterDays override from .etymd/config.json", async () => {
    await gitAt(null, ["init", "-q"])
    await write("PROJECT_CONTEXT.md", "# state\n\ncurrent work: alpha\n")
    await commitAll("state", "2026-01-01T10:00:00Z")
    await write("src/a.ts", "export {}\n")
    await commitAll("code moved on", "2026-03-01T10:00:00Z")
    await write(".etymd/config.json", JSON.stringify({ state: { staleAfterDays: 365 } }))

    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => d.includes("staleAfterDays 365"))).toBe(true)
    expect(report.disclosures.some((d) => d.includes("set in"))).toBe(true)
  })

  it("discloses an untracked state file instead of flagging it", async () => {
    await gitAt(null, ["init", "-q"])
    await write("src/a.ts", "export {}\n")
    await commitAll("code", "2026-03-01T10:00:00Z")
    // Present on disk, never committed — git cannot vouch for any date.
    await write("PROJECT_CONTEXT.md", "# state\n\nnever committed\n")

    const facts = await scanProject(dir)
    expect(facts.freshness?.unverifiable).toEqual([
      { path: "PROJECT_CONTEXT.md", reason: "untracked — never committed" },
    ])

    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings).toEqual([])
    expect(
      report.disclosures.some((d) => d.includes("PROJECT_CONTEXT.md") && d.includes("untracked")),
    ).toBe(true)
  })
})

describe("state-freshness — char budget", () => {
  it("flags a state file over the default 9500-char budget", async () => {
    await write("PROJECT_CONTEXT.md", `# state\n\n${"x".repeat(9600)}\n`)

    const report = await stateFreshnessLens.run(await ctx())
    const over = report.findings.find(
      (f) => f.id === "state-freshness/state-over-budget:PROJECT_CONTEXT.md",
    )
    expect(over).toBeDefined()
    expect(over?.tier).toBe("gap")
    expect(over?.why).toContain("10,000")
  })
})

describe("state-freshness — decisions format (marker-gated, forward-only)", () => {
  it("flags a missing Scope: field only when the file carries the format marker", async () => {
    const entry = "## D-001 — 2026-01-05 — pick one queue library\n\nDecision: keep the first.\n"
    await write("DECISIONS.md", `# Decisions\n${MARKER}\n\n${entry}`)
    const flagged = await stateFreshnessLens.run(await ctx())
    expect(flagged.findings.map((f) => f.id)).toEqual([
      "state-freshness/scope-missing:DECISIONS.md:D-001",
    ])

    await write("DECISIONS.md", `# Decisions\n\n${entry}`)
    const skipped = await stateFreshnessLens.run(await ctx())
    expect(skipped.findings).toEqual([])
    expect(skipped.disclosures.some((d) => d.includes("format checks skipped"))).toBe(true)
    // Skipped is unexamined, not clean — the ledger must hold its findings open.
    expect(skipped.outOfScope).toContain("DECISIONS.md")
  })

  it("flags a duplicate D-NNN id with a rename action", async () => {
    await write(
      "DECISIONS.md",
      [
        "# Decisions",
        MARKER,
        "",
        "## D-001 — 2026-01-05 — first\n\nScope: repo.",
        "## D-002 — 2026-01-06 — second\n\nScope: repo.",
        "## D-002 — 2026-01-07 — collided append\n\nScope: repo.",
        "",
      ].join("\n"),
    )
    const report = await stateFreshnessLens.run(await ctx())
    const dupe = report.findings.find(
      (f) => f.id === "state-freshness/duplicate-id:DECISIONS.md:D-002",
    )
    expect(dupe).toBeDefined()
    expect(dupe?.tier).toBe("gap")
    expect(dupe?.action).toContain("Rename")
    expect(dupe?.action).toContain("D-003")
  })

  it("flags duplicate ids even WITHOUT the marker — an append race is not a format opinion", async () => {
    // Id-sequence checks are deliberately not marker-gated: a duplicated D-NNN in a legacy
    // file breaks the file's own convention, and self-healing must reach it.
    await write(
      "DECISIONS.md",
      [
        "# Decisions",
        "",
        "## D-001 — 2026-01-05 — first\n\nDecision: keep.",
        "## D-001 — 2026-01-06 — collided append\n\nDecision: keep.",
        "",
      ].join("\n"),
    )
    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings.map((f) => f.id)).toEqual([
      "state-freshness/duplicate-id:DECISIONS.md:D-001",
    ])
    // Scope-missing did NOT fire (format checks stay marker-gated), and the skip is disclosed.
    expect(report.disclosures.some((d) => d.includes("id-sequence checks still ran"))).toBe(true)
    expect(report.outOfScope).toContain("DECISIONS.md")
  })

  it("flags a past Revisit date as due review debt; future dates stay quiet", async () => {
    await write(
      "DECISIONS.md",
      [
        "# Decisions",
        MARKER,
        "",
        "## D-001 — 2026-01-05 — retry budget\n\nScope: repo. Revisit: 2025-02-01",
        "## D-002 — 2026-01-06 — cache policy\n\nScope: repo. Revisit: 2999-01-01",
        "",
      ].join("\n"),
    )
    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings.map((f) => f.id)).toEqual([
      "state-freshness/revisit-due:DECISIONS.md:D-001",
    ])
    expect(report.findings[0]?.why).toContain("Review debt is due")
  })
})

describe("state-freshness — ADR conventions are recognized as decisions artifacts", () => {
  it("recognizes a docs/adr directory and dates it as a decisions artifact", async () => {
    await gitAt(null, ["init", "-q"])
    await write("docs/adr/0001-use-one-database.md", "# 1. Use one database\n\nAccepted.\n")
    await commitAll("adr", "2026-01-01T10:00:00Z")

    const facts = await scanProject(dir)
    const adr = facts.artifacts.find((a) => a.id === "adr-dir")
    expect(adr?.exists).toBe(true)
    expect(adr?.kind).toBe("decisions")
    expect(facts.freshness?.artifacts.some((f) => f.path === "docs/adr")).toBe(true)

    // Decisions are exempt from age: an old ADR dir in a moving repo is history, not a defect.
    await write("src/a.ts", "export {}\n")
    await commitAll("code much later", "2027-01-01T10:00:00Z")
    const report = await stateFreshnessLens.run(await ctx())
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => d.includes("docs/adr"))).toBe(true)
  })

  it("recognizes NNNN-*.md files directly under docs/", async () => {
    await write("docs/0007-switch-to-queues.md", "# 7. Switch to queues\n\nAccepted.\n")
    const facts = await scanProject(dir)
    const adr = facts.artifacts.find((a) => a.id === "adr-files")
    expect(adr?.exists).toBe(true)
    expect(adr?.kind).toBe("decisions")
  })
})
