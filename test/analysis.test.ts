import { describe, expect, it } from "vitest"

import { planWorkflow } from "../src/core/generate.js"
import { defaultLeash } from "../src/core/leash.js"
import { scoreProject } from "../src/core/score.js"
import type { ProjectFacts } from "../src/core/types.js"
import { generateAgentsMd, generatePrePushHook, isSafeGateCommand } from "../src/pack/templates.js"

export function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    clothaidVersion: "0.0.0",
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
      {
        id: "project-context",
        label: "state",
        path: "PROJECT_CONTEXT.md",
        kind: "state",
        exists: false,
      },
      { id: "skills", label: "skills", path: ".claude/skills", kind: "skill", exists: false },
      {
        id: "failure-modes-skill",
        label: "failure register",
        path: ".claude/skills/failure-modes",
        kind: "skill",
        exists: false,
      },
      { id: "sessions", label: "sessions", path: "docs/sessions", kind: "sessions", exists: false },
    ],
    tree: { dirs: [{ name: "src", files: 10 }], truncated: false },
    ...overrides,
  }
}

describe("scoreProject", () => {
  it("suggests fresh when no contract or adapters exist", () => {
    const card = scoreProject(facts())
    expect(card.suggestedMode).toBe("fresh")
    expect(card.score).toBeLessThan(30)
  })

  it("a fully equipped solo project can reach 100 (failure register included)", () => {
    const mature = facts({
      hooks: {
        source: "githooks",
        preCommit: true,
        prePush: true,
        commitMsg: false,
        lintStaged: false,
      },
      artifacts: [
        { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: true },
        { id: "claude", label: "CLAUDE.md", path: "CLAUDE.md", kind: "adapter", exists: true },
        {
          id: "project-context",
          label: "state",
          path: "PROJECT_CONTEXT.md",
          kind: "state",
          exists: true,
        },
        { id: "skills", label: "skills", path: ".claude/skills", kind: "skill", exists: true },
        {
          id: "failure-modes-skill",
          label: "failure register",
          path: ".claude/skills/failure-modes",
          kind: "skill",
          exists: true,
        },
        {
          id: "sessions",
          label: "sessions",
          path: "docs/sessions",
          kind: "sessions",
          exists: true,
        },
      ],
    })
    const card = scoreProject(mature, "solo")
    expect(card.score).toBe(100)
    expect(card.suggestedMode).toBe("optimisation")
  })

  it("team profile does not grade solo-ritual dimensions", () => {
    const teamRepo = facts({
      hooks: {
        source: "husky",
        preCommit: true,
        prePush: false,
        commitMsg: true,
        lintStaged: true,
      },
      artifacts: [
        { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: true },
        {
          id: "copilot",
          label: "copilot",
          path: ".github/copilot-instructions.md",
          kind: "adapter",
          exists: true,
        },
        {
          id: "inventory",
          label: "inventory",
          path: "docs/INVENTORY.md",
          kind: "map",
          exists: true,
        },
        {
          id: "project-context",
          label: "state",
          path: "PROJECT_CONTEXT.md",
          kind: "state",
          exists: false,
        },
        {
          id: "sessions",
          label: "sessions",
          path: "docs/sessions",
          kind: "sessions",
          exists: false,
        },
        { id: "skills", label: "skills", path: ".claude/skills", kind: "skill", exists: false },
      ],
    })
    const solo = scoreProject(teamRepo, "solo")
    const team = scoreProject(teamRepo, "team")
    expect(team.dimensions.map((d) => d.id)).not.toContain("state-doc")
    expect(team.dimensions.map((d) => d.id)).not.toContain("session-protocol")
    // A mature team contract must not read as a low-maturity migration target.
    expect(team.score).toBeGreaterThan(solo.score)
    expect(team.score).toBeGreaterThanOrEqual(60)
  })
})

describe("generateAgentsMd", () => {
  it("embeds the discovered Done= commands, map re-verify, and pack version", () => {
    const md = generateAgentsMd(facts(), defaultLeash(facts()), { state: true, profile: "solo" })
    expect(md).toContain("# AGENTS.md")
    expect(md).toContain("pnpm typecheck")
    expect(md).toContain("pnpm test")
    expect(md).toContain("Done =")
    expect(md).toContain("Advisory, not authoritative")
    expect(md).toContain("Composition points")
    expect(md).toContain("clothaid pack v")
  })

  it("omits the PROJECT_CONTEXT.md session protocol when no state doc is chosen", () => {
    const md = generateAgentsMd(facts(), defaultLeash(facts()), { state: false, profile: "team" })
    expect(md).not.toContain("PROJECT_CONTEXT.md")
  })

  it("renders hard org policy differently from soft preference", () => {
    const leash = defaultLeash(facts())
    leash.tooling.mcpServers = { enabled: false, hard: true }
    const md = generateAgentsMd(facts(), leash, { state: true, profile: "solo" })
    expect(md).toContain("disabled by org policy")
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
  it("plans the contract, chosen adapters and gates", async () => {
    const plan = await planWorkflow("/nonexistent-root", facts(), defaultLeash(facts()), {
      adapters: ["claude", "copilot"],
      gates: true,
      state: true,
    })
    const paths = plan.map((p) => p.path)
    expect(paths).toContain("AGENTS.md")
    expect(paths).toContain("PROJECT_CONTEXT.md")
    expect(paths).toContain("CLAUDE.md")
    expect(paths).toContain(".github/copilot-instructions.md")
    expect(paths).toContain(".githooks/pre-push")
    expect(plan.every((p) => p.exists === false)).toBe(true)
  })
})
