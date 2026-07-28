import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_CONFIG, readConfig } from "../src/core/config.js"
import { measureContext } from "../src/core/context.js"
import { expandFileGlobs } from "../src/core/detect.js"
import { scanProject } from "../src/core/scan.js"
import { matchesGlob } from "../src/core/util.js"
import { contextEconomyLens } from "../src/lenses/context-economy.js"
import { instructionTruthLens } from "../src/lenses/instruction-truth/lens.js"
import type { LensContext } from "../src/engine/finding.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-config-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function ctx(): Promise<LensContext> {
  const facts = await scanProject(dir)
  return { root: dir, facts, profile: "solo", baseline: null, config: await readConfig(dir) }
}

describe("glob matching", () => {
  it("matches within and across segments", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true)
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false)
    expect(matchesGlob("src/deep/a.ts", "src/**/*.ts")).toBe(true)
    // `**` spans zero segments too, so a/**/b covers a/b.
    expect(matchesGlob("src/a.ts", "src/**/*.ts")).toBe(true)
    expect(matchesGlob("a/b/c.md", "**/*.md")).toBe(true)
    expect(matchesGlob("SKILL.md", "?KILL.md")).toBe(true)
  })

  it("treats a wildcard-free pattern as a path prefix", () => {
    expect(matchesGlob(".claude/skills/x/SKILL.md", ".claude/skills")).toBe(true)
    expect(matchesGlob(".claude/skills", ".claude/skills")).toBe(true)
    expect(matchesGlob(".claude/skillset/x.md", ".claude/skills")).toBe(false)
  })

  it("does not let a dot in the pattern match any character", () => {
    expect(matchesGlob("axclaude/x.md", ".claude/**")).toBe(false)
  })
})

describe("expandFileGlobs", () => {
  it("walks only the literal prefix and reaches explicitly named dot-dirs", async () => {
    await write("design/001.md", "x")
    await write("design/nested/002.md", "x")
    await write(".agent/rules.md", "x")
    await write("node_modules/pkg/README.md", "x")
    await write("other/003.md", "x")

    expect(await expandFileGlobs(dir, ["design/**/*.md", ".agent/*.md"])).toEqual([
      ".agent/rules.md",
      "design/001.md",
      "design/nested/002.md",
    ])
    // node_modules is never walked, even under a matching glob.
    expect(await expandFileGlobs(dir, ["**/README.md"])).toEqual([])
  })
})

describe("readConfig", () => {
  it("returns defaults, not present, when there is no config file", async () => {
    const loaded = await readConfig(dir)
    expect(loaded.present).toBe(false)
    expect(loaded.problems).toEqual([])
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
  })

  it("reads scope and budgets", async () => {
    await write(
      ".etymd/config.json",
      JSON.stringify({
        instructions: { include: ["design/**/*.md"], exclude: [".claude/skills/**"] },
        context: { perFileWords: 1200, totalWords: 3000 },
      }),
    )
    const { config, present, problems } = await readConfig(dir)
    expect(present).toBe(true)
    expect(problems).toEqual([])
    expect(config.instructions).toEqual({
      include: ["design/**/*.md"],
      exclude: [".claude/skills/**"],
    })
    expect(config.context).toEqual({ perFileWords: 1200, totalWords: 3000 })
  })

  it("reports malformed JSON instead of silently falling back", async () => {
    await write(".etymd/config.json", "{ not json")
    const { config, present, problems } = await readConfig(dir)
    expect(present).toBe(true)
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(problems.join(" ")).toContain("not valid JSON")
  })

  it("reports a bad key and keeps the good ones", async () => {
    await write(
      ".etymd/config.json",
      JSON.stringify({
        instructions: { exclude: "everything" },
        context: { perFileWords: 0, totalWords: 500 },
      }),
    )
    const { config, problems } = await readConfig(dir)
    expect(config.instructions.exclude).toEqual([])
    expect(config.context.perFileWords).toBe(DEFAULT_CONFIG.context.perFileWords)
    expect(config.context.totalWords).toBe(500)
    expect(problems.join(" ")).toContain("instructions.exclude")
    expect(problems.join(" ")).toContain("context.perFileWords")
  })
})

describe("instruction scoping (the fork case)", () => {
  async function writeForkFixture() {
    await write("package.json", JSON.stringify({ name: "fork", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    // The fork's own layer: honest.
    await write("CLAUDE.md", "# CLAUDE.md\n\nOwn layer. Code in `src/mine.ts`.\n")
    await write("src/mine.ts", "export {}\n")
    // Inherited upstream skills the fork will never fix: full of stale paths.
    await write(".claude/skills/up-a/SKILL.md", "See `upstream/gone-a.ts`.\n")
    await write(".claude/skills/up-b/SKILL.md", "See `upstream/gone-b.ts`.\n")
  }

  it("audits everything when unscoped", async () => {
    await writeForkFixture()
    const report = await instructionTruthLens.run(await ctx())
    expect(report.findings.map((f) => f.id).sort()).toEqual([
      "instruction-truth/stale-path:.claude/skills/up-a/SKILL.md:upstream/gone-a.ts",
      "instruction-truth/stale-path:.claude/skills/up-b/SKILL.md:upstream/gone-b.ts",
    ])
  })

  it("excludes by glob and discloses exactly what it stopped looking at", async () => {
    await writeForkFixture()
    await write(
      ".etymd/config.json",
      JSON.stringify({ instructions: { exclude: [".claude/skills/**"] } }),
    )
    const report = await instructionTruthLens.run(await ctx())
    expect(report.findings).toEqual([])
    // Scoping may never buy a clean report silently — the excluded files are named.
    const disclosure = report.disclosures.find((d) => d.includes("excluded by"))
    expect(disclosure).toBeDefined()
    expect(disclosure).toContain("2 instruction file(s)")
    expect(disclosure).toContain(".claude/skills/up-a/SKILL.md")
  })

  it("includes extra files detection would miss, and discloses them", async () => {
    await writeForkFixture()
    await write("design/002-plan.md", "The planner lives in `src/planner.ts`.\n")
    await write(
      ".etymd/config.json",
      JSON.stringify({
        instructions: { include: ["design/**/*.md"], exclude: [".claude/skills/**"] },
      }),
    )
    const report = await instructionTruthLens.run(await ctx())
    expect(report.findings.map((f) => f.id)).toEqual([
      "instruction-truth/stale-path:design/002-plan.md:src/planner.ts",
    ])
    expect(report.disclosures.some((d) => d.includes("design/002-plan.md"))).toBe(true)
  })

  it("surfaces a malformed config as a lens disclosure", async () => {
    await writeForkFixture()
    await write(".etymd/config.json", "{ nope")
    const report = await instructionTruthLens.run(await ctx())
    expect(report.disclosures.some((d) => d.includes("not valid JSON"))).toBe(true)
    // Broken config must not silently narrow the audit — everything is still checked.
    expect(report.findings).toHaveLength(2)
  })
})

describe("configurable context budgets", () => {
  it("applies per-file and total overrides", async () => {
    await write("package.json", JSON.stringify({ name: "budgeted" }))
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ")
    await write("AGENTS.md", `# AGENTS.md\n\n${words}\n`)
    await write(
      ".etymd/config.json",
      JSON.stringify({ context: { perFileWords: 100, totalWords: 200 } }),
    )

    const report = await contextEconomyLens.run(await ctx())
    const ids = report.findings.map((f) => f.id)
    // Both thresholds are far below the default 4000/8000 — the file is only over BECAUSE of config.
    expect(ids).toContain("context-economy/heavy-file:AGENTS.md")
    expect(ids).toContain("context-economy/total-over-budget")
    expect(report.disclosures.some((d) => d.includes("100 words/file, 200 words total"))).toBe(true)
    expect(report.disclosures.some((d) => d.includes("set in"))).toBe(true)

    const budget = await measureContext(dir, 100)
    expect(budget.perFileWords).toBe(100)
  })

  it("stays on defaults and says so when unconfigured", async () => {
    await write("package.json", JSON.stringify({ name: "plain" }))
    await write("AGENTS.md", "# AGENTS.md\n\nShort.\n")
    const report = await contextEconomyLens.run(await ctx())
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => d.includes("defaults — override"))).toBe(true)
  })
})
