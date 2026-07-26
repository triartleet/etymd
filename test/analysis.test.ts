import { describe, expect, it } from "vitest"

import { planWorkflow } from "../src/core/generate.js"
import { isDriftEmpty, summarizeBaselineDrift } from "../src/core/facts.js"
import type { ProjectFacts } from "../src/core/types.js"
import { generateAgentsMd, generatePrePushHook, isSafeGateCommand } from "../src/pack/templates.js"

export function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    etymdVersion: "0.0.0",
    packVersion: "1",
    generatedAt: new Date().toISOString(),
    root: "/tmp/demo",
    name: "demo",
    git: { isRepo: true, husky: false },
    packageManager: "pnpm",
    workspace: { kind: "none", packageGlobs: [] },
    packages: [],
    frameworks: ["React"],
    commands: {
      raw: { test: "vitest", lint: "eslint", typecheck: "tsc --noEmit" },
      test: "test",
      lint: "lint",
      typecheck: "typecheck",
    },
    ci: { system: "none", files: [] },
    hooks: {
      source: "none",
      preCommit: false,
      prePush: false,
      commitMsg: false,
      lintStaged: false,
    },
    artifacts: [
      { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: false },
      { id: "claude", label: "CLAUDE.md", path: "CLAUDE.md", kind: "adapter", exists: false },
    ],
    tree: { dirs: [{ name: "src", files: 10 }], truncated: false },
    ...overrides,
  }
}

describe("generateAgentsMd (minimal scaffold)", () => {
  it("embeds only truthful facts: Done=, map re-verify, pack version", () => {
    const md = generateAgentsMd(facts())
    expect(md).toContain("# AGENTS.md")
    expect(md).toContain("pnpm typecheck")
    expect(md).toContain("pnpm test")
    expect(md).toContain("Done =")
    expect(md).toContain("Advisory, not authoritative")
    expect(md).toContain("etymd pack v")
    // The scaffold must not claim what the scan cannot know.
    expect(md).not.toContain("PROJECT_CONTEXT.md")
  })

  it("never points at package.json in a docs-only repo that has none", () => {
    // The wonderbee class: no manifest, no scripts, no frameworks — the scaffold must not
    // reference a file the scan never saw.
    const md = generateAgentsMd(
      facts({
        packageManager: "unknown",
        frameworks: [],
        commands: { raw: {} },
        tree: { dirs: [], truncated: false },
      }),
    )
    expect(md).not.toContain("package.json")
    expect(md).toContain("none detected")
  })
})

describe("generatePrePushHook", () => {
  it("never wires a writing command into the correctness gate", () => {
    const f = facts({
      commands: {
        raw: {
          format: "nx format:write && eslint --fix .",
          "generate:types": "graphql-codegen",
          lint: "eslint .",
        },
        format: "format",
        lint: "lint",
      },
    })
    const hook = generatePrePushHook(f)
    expect(hook).not.toContain("format:write")
    expect(hook).not.toContain("generate:types")
    expect(hook).toContain("lint")
  })

  it("isSafeGateCommand rejects writers and accepts checks", () => {
    expect(isSafeGateCommand("prettier --check .")).toBe(true)
    expect(isSafeGateCommand("tsc --noEmit")).toBe(true)
    expect(isSafeGateCommand("prettier --write .")).toBe(false)
    expect(isSafeGateCommand("eslint --fix .")).toBe(false)
    expect(isSafeGateCommand(undefined)).toBe(false)
  })
})

describe("planWorkflow", () => {
  it("plans only what onboarding scaffolds: contract + gates", async () => {
    const plan = await planWorkflow("/nonexistent-root", facts(), { agents: true, gates: true })
    const paths = plan.map((p) => p.path)
    expect(paths).toEqual(["AGENTS.md", ".githooks/pre-commit", ".githooks/pre-push"])
    expect(plan.every((p) => p.exists === false)).toBe(true)
  })

  it("plans nothing when both toggles are off", async () => {
    const plan = await planWorkflow("/nonexistent-root", facts(), { agents: false, gates: false })
    expect(plan).toEqual([])
  })
})

describe("summarizeBaselineDrift", () => {
  it("is empty when nothing on the measured axes changed", () => {
    expect(isDriftEmpty(summarizeBaselineDrift(facts(), facts()))).toBe(true)
  })

  it("captures command, artifact, and layout changes with direction", () => {
    const old = facts()
    const fresh = facts({
      commands: { raw: { test: "vitest", build: "tsup" }, test: "test", build: "build" },
      artifacts: [
        { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: true },
      ],
      tree: {
        dirs: [
          { name: "src", files: 10 },
          { name: "docs", files: 3 },
        ],
        truncated: false,
      },
    })
    const drift = summarizeBaselineDrift(old, fresh)
    const byRole = Object.fromEntries(drift.commands.map((c) => [c.role, c]))
    // lint/typecheck were present in old, gone in fresh; build newly appears.
    expect(byRole.lint).toEqual({ role: "lint", from: "lint", to: undefined })
    expect(byRole.build).toEqual({ role: "build", from: undefined, to: "build" })
    expect(drift.artifactsAdded).toContain("AGENTS.md")
    expect(drift.dirsAdded).toEqual(["docs"])
    expect(drift.dirsRemoved).toEqual([])
    expect(isDriftEmpty(drift)).toBe(false)
  })
})
