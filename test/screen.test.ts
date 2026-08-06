import { describe, expect, it } from "vitest"

import { isSelfName, screenText } from "../src/commands/screen.js"

const patterns = [/AcmeCorp/i, /internal\.example\.com/i]

describe("content screen", () => {
  it("flags a pattern hit and an absolute home path, with the line number", () => {
    const home = `/${"Users"}/someone/projects/x` // a fixture, assembled so it is not a literal
    const text = ["clean line", "mentions AcmeCorp here", home].join("\n")
    const hits = screenText(text, "doc.md", patterns)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: "doc.md", line: 2 })
    expect(hits[1]).toMatchObject({ line: 3, reason: "absolute home path" })
  })

  it("is case-insensitive — a leak does not stop being one in lower case", () => {
    expect(screenText("acmecorp", "f", patterns)).toHaveLength(1)
  })

  it("PINNED: a line marked `allow-published-string` is exempt", () => {
    // The escape hatch has to be visible IN the diff — a reviewer sees the exemption being
    // granted rather than discovering a silent allowlist elsewhere.
    const hits = screenText("AcmeCorp on purpose allow-published-string", "f", patterns)
    expect(hits).toEqual([])
  })

  it("reports one hit per line, not one per matching pattern", () => {
    // Otherwise a line matching three patterns triples the noise for a single fix.
    const hits = screenText("AcmeCorp and internal.example.com together", "f", patterns)
    expect(hits).toHaveLength(1)
  })

  it("matches a home path under either /Users or /home", () => {
    // Assembled from parts so this suite does not trip the very screen it tests (and so a
    // repo-wide grep for machine paths does not flag its own fixtures).
    const under = (root: string) => `/${root}/someone/x`
    expect(screenText(under("home"), "f", [])).toHaveLength(1)
    expect(screenText(under("Users"), "f", [])).toHaveLength(1)
    // Not every path is a machine path — /usr/local and repo-relative paths must stay silent.
    expect(screenText("/usr/local/bin/tool", "f", [])).toEqual([])
    expect(screenText("src/core/util.ts", "f", [])).toEqual([])
  })

  it("finds nothing when there is nothing — no patterns means no findings", () => {
    expect(screenText("AcmeCorp everywhere", "f", [])).toEqual([])
  })

  it("honours repo-level allow patterns for lines that cannot carry an inline marker", () => {
    // A scanner's own source contains the strings it screens for, and a bundler strips
    // comments — so some exemptions cannot live on the line itself.
    const allow = [/describing its own check/i]
    expect(screenText("AcmeCorp, describing its own check", "f", patterns, allow)).toEqual([])
    // The exemption is narrow: an ordinary hit beside it still reports.
    expect(screenText("AcmeCorp in plain prose", "f", patterns, allow)).toHaveLength(1)
  })

  it("an allow pattern suppresses a machine path too, not just a listed pattern", () => {
    const home = `/${"Users"}/someone/x`
    expect(screenText(home, "f", [], [/someone/])).toEqual([])
  })
})

describe("self-name exemption", () => {
  it("drops a pattern that IS the repo's own name, keeps one that merely contains it", () => {
    // A repo has to call itself something in its own README and package name; the
    // cross-project rule is about disclosing OTHER projects.
    expect(isSelfName(/widget/i, "widget")).toBe(true)
    expect(isSelfName(/WIDGET/i, "widget")).toBe(true)
    // Narrower than the name, or broader than it, both stay active.
    expect(isSelfName(/widget-internal/i, "widget")).toBe(false)
    expect(isSelfName(/wid/i, "widget")).toBe(false)
  })
})
