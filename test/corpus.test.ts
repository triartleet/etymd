import { existsSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import { buildGateInventory } from "../src/lenses/gate-integrity/inventory.js"
import { instructionTruthLens } from "../src/lenses/instruction-truth/lens.js"

// Read-only smoke tests over the sibling corpus repos — the dogfood harness. Each asserts only
// durable, hand-verified facts; skipped cleanly on machines without the corpus.
const CORPUS_ROOT = path.resolve(import.meta.dirname, "..", "..")
const repo = (name: string) => path.join(CORPUS_ROOT, name)
const hasRepo = (name: string) => existsSync(repo(name))

describe.skipIf(!hasRepo("pepshop"))("corpus: pepshop (control — the gold standard)", () => {
  it("scans as a pnpm workspace with wired tracked githooks", async () => {
    const facts = await scanProject(repo("pepshop"))
    expect(facts.packageManager).toBe("pnpm")
    expect(facts.workspace.kind).toBe("pnpm")
    expect(facts.hooks.source).toBe("githooks")
    expect(facts.hooks.preCommit).toBe(true)
    expect(facts.hooks.prePush).toBe(true)
    expect(facts.commands.formatCheck).toBe("format:check")
    expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
    expect(facts.artifacts.find((a) => a.id === "failure-modes-skill")?.exists).toBe(true)
  })

  it("runs the truth lens read-only over the real contract + skills without throwing", async () => {
    const root = repo("pepshop")
    const facts = await scanProject(root)
    const report = await instructionTruthLens.run({ root, facts, profile: "solo", baseline: null })
    expect(report.status).toBe("ran")
    // The instruction set includes AGENTS.md + CLAUDE.md + skills — several files, all checked.
    expect(report.disclosures.some((d) => /Checked \d+ instruction file/.test(d))).toBe(true)
    // Findings may legitimately exist (repos evolve); every one must carry evidence.
    for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!hasRepo("nx-monorepo"))("corpus: nx-monorepo (Nx team repo)", () => {
  it("classifies the narrow unit command, never the meta runner or a writer", async () => {
    const facts = await scanProject(repo("nx-monorepo"))
    expect(facts.workspace.kind).toBe("nx")
    expect(facts.commands.test).toBe("test:unit:local")
    // The corpus defect that motivated the classifier rework: a format WRITER must never be
    // selected where a check belongs.
    if (facts.commands.formatCheck) {
      const value = facts.commands.raw[facts.commands.formatCheck] ?? ""
      expect(value).not.toContain("--write")
      expect(value).not.toContain("format:write")
    }
  })
})

describe.skipIf(!hasRepo("spa-bff"))("corpus: spa-bff (SPA + BFF team repo)", () => {
  it("sees the narrow test command and the pre-assembled no-jest trio", async () => {
    const facts = await scanProject(repo("spa-bff"))
    expect(facts.commands.test).toBe("test:unit")
    expect(facts.commands.typecheck).toBe("test:types")
    expect(facts.commands.raw["test:no-jest"]).toBeDefined()
    expect(facts.artifacts.find((a) => a.id === "copilot")?.exists).toBe(true)
  })
})

describe.skipIf(!hasRepo("cra-legacy"))("corpus: cra-legacy (the un-converted repo)", () => {
  it("detects husky v3 hooks that were previously invisible", async () => {
    const facts = await scanProject(repo("cra-legacy"))
    expect(facts.hooks.source).toBe("husky-legacy")
    expect(facts.hooks.lintStaged).toBe(true)
  })

  it("gate inventory finds sonar without a local coverage threshold (the motivating case)", async () => {
    const facts = await scanProject(repo("cra-legacy"))
    const inv = await buildGateInventory(repo("cra-legacy"), facts)
    expect(inv.thresholds.sonarConfigured).toBe(true)
    expect(inv.thresholds.coverageThresholdLocal).toBe(false)
  })
})

describe.skipIf(!hasRepo("cc-gg-bridgy"))(
  "corpus: cc-gg-bridgy (etymd-scaffolded extension)",
  () => {
    it("scans the onboarded state: pnpm, tracked githooks, contract present", async () => {
      const facts = await scanProject(repo("cc-gg-bridgy"))
      expect(facts.packageManager).toBe("pnpm")
      expect(facts.hooks.source).toBe("githooks")
      expect(facts.commands.typecheck).toBe("typecheck")
      expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
    })

    it("truth lens holds on the contract etymd itself scaffolded", async () => {
      const root = repo("cc-gg-bridgy")
      const facts = await scanProject(root)
      const report = await instructionTruthLens.run({
        root,
        facts,
        profile: "solo",
        baseline: null,
      })
      expect(report.status).toBe("ran")
      for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
    })
  },
)

describe.skipIf(!hasRepo("wonderbee"))("corpus: wonderbee (docs-only, no manifest)", () => {
  it("scans a repo with no package.json without inventing facts", async () => {
    const facts = await scanProject(repo("wonderbee"))
    expect(facts.packageManager).toBe("unknown")
    expect(facts.workspace.kind).toBe("none")
    expect(facts.commands.test).toBeUndefined()
    expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
  })

  it("truth lens runs over a code-free contract", async () => {
    const root = repo("wonderbee")
    const facts = await scanProject(root)
    const report = await instructionTruthLens.run({ root, facts, profile: "solo", baseline: null })
    expect(report.status).toBe("ran")
    for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!hasRepo("nanoclaw-v2"))(
  "corpus: nanoclaw-v2 (large fork, symlinked contract)",
  () => {
    it("scans the fork: pnpm, husky hooks, AGENTS.md symlink counts as a contract", async () => {
      const facts = await scanProject(repo("nanoclaw-v2"))
      expect(facts.packageManager).toBe("pnpm")
      expect(facts.hooks.source).toBe("husky")
      expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
    })

    it("truth lens survives the 29KB claim-rich CLAUDE.md read-only", async () => {
      const root = repo("nanoclaw-v2")
      const facts = await scanProject(root)
      const report = await instructionTruthLens.run({
        root,
        facts,
        profile: "solo",
        baseline: null,
      })
      expect(report.status).toBe("ran")
      for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
    })
  },
)
