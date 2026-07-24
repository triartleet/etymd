import { describe, expect, it } from "vitest"

import { generateAgentsMd, planWorkflow } from "../src/core/generate.js"
import { defaultLeash } from "../src/core/leash.js"
import { scoreProject } from "../src/core/score.js"
import type { ProjectFacts } from "../src/core/types.js"

function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    clothaidVersion: "0.0.0",
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
    hooks: { source: "none", preCommit: false, prePush: false },
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

  it("suggests optimisation for a mature project", () => {
    const mature = facts({
      hooks: { source: "githooks", preCommit: true, prePush: true },
      artifacts: [
        { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: true },
        { id: "claude", label: "CLAUDE.md", path: "CLAUDE.md", kind: "adapter", exists: true },
        {
          id: "copilot",
          label: "copilot",
          path: ".github/copilot-instructions.md",
          kind: "adapter",
          exists: true,
        },
        {
          id: "project-context",
          label: "state",
          path: "PROJECT_CONTEXT.md",
          kind: "state",
          exists: true,
        },
        { id: "skills", label: "skills", path: ".claude/skills", kind: "skill", exists: true },
        {
          id: "sessions",
          label: "sessions",
          path: "docs/sessions",
          kind: "sessions",
          exists: true,
        },
      ],
    })
    const card = scoreProject(mature)
    expect(card.suggestedMode).toBe("optimisation")
    expect(card.score).toBeGreaterThanOrEqual(60)
  })
})

describe("generateAgentsMd", () => {
  it("embeds the discovered Done= commands and package manager", () => {
    const md = generateAgentsMd(facts(), defaultLeash(facts()))
    expect(md).toContain("# AGENTS.md")
    expect(md).toContain("pnpm typecheck")
    expect(md).toContain("pnpm test")
    expect(md).toContain("Done =")
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
