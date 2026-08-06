import { existsSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { loadFleetManifest } from "../src/core/fleet.js"
import { scanProject } from "../src/core/scan.js"
import { buildGateInventory } from "../src/lenses/gate-integrity/inventory.js"
import { instructionTruthLens } from "../src/lenses/instruction-truth/lens.js"

// Read-only smoke tests over the sibling corpus repos — the dogfood harness. Each asserts only
// durable, hand-verified facts; skipped cleanly on machines without the corpus.
//
// Private corpus entries are named here by shape (`nx-monorepo`, …), never by directory. The
// untracked sources.local.json supplies the real sibling directory on a machine that has them;
// everywhere else the lookup misses and the suite skips, which is the same path as "repo absent".
// Resolution goes through the promoted fleet loader (`src/core/fleet.ts`) — the same code path
// `etymd fleet` uses — asserting the promotion changed no corpus behavior.
const CORPUS_ROOT = path.resolve(import.meta.dirname, "..", "..")

const manifest = await loadFleetManifest(path.join(import.meta.dirname, "..", "sources.json"))

const repo = (name: string) =>
  manifest.entries.find((e) => e.name === name)?.resolvedRoot ?? path.join(CORPUS_ROOT, name)
const hasRepo = (name: string) => existsSync(repo(name))

describe("corpus manifest — the legacy shape loads through the fleet loader", () => {
  it("parses sources.json as the corpus shape with every entry resolved to a sibling", () => {
    expect(manifest.shape).toBe("corpus")
    expect(manifest.problems).toEqual([])
    expect(manifest.entries.length).toBeGreaterThanOrEqual(7)
    for (const entry of manifest.entries) {
      // Behavior unchanged: every corpus entry resolves under the checkout's parent, whether
      // via a declared path, a local dir mapping, or the same-named-sibling fallback.
      expect(entry.resolvedRoot).toBeDefined()
      expect(path.dirname(entry.resolvedRoot as string)).toBe(CORPUS_ROOT)
    }
  })
})

describe.skipIf(!hasRepo("workspace-fullstack"))(
  "corpus: workspace-fullstack (control — the gold standard)",
  () => {
    it("scans as a pnpm workspace with wired tracked githooks", async () => {
      const facts = await scanProject(repo("workspace-fullstack"))
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
      const root = repo("workspace-fullstack")
      const facts = await scanProject(root)
      const report = await instructionTruthLens.run({
        root,
        facts,
        profile: "solo",
        baseline: null,
      })
      expect(report.status).toBe("ran")
      // The instruction set includes AGENTS.md + CLAUDE.md + skills — several files, all checked.
      expect(report.disclosures.some((d) => /Checked \d+ instruction file/.test(d))).toBe(true)
      // Findings may legitimately exist (repos evolve); every one must carry evidence.
      for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
    })
  },
)

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

describe.skipIf(!hasRepo("vscode-extension"))(
  "corpus: vscode-extension (etymd-scaffolded extension)",
  () => {
    it("scans the onboarded state: pnpm, tracked githooks, contract present", async () => {
      const facts = await scanProject(repo("vscode-extension"))
      expect(facts.packageManager).toBe("pnpm")
      expect(facts.hooks.source).toBe("githooks")
      expect(facts.commands.typecheck).toBe("typecheck")
      expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
    })

    it("truth lens holds on the contract etymd itself scaffolded", async () => {
      const root = repo("vscode-extension")
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

describe.skipIf(!hasRepo("docs-only"))("corpus: docs-only (no manifest)", () => {
  it("scans a repo with no package.json without inventing facts", async () => {
    const facts = await scanProject(repo("docs-only"))
    expect(facts.packageManager).toBe("unknown")
    expect(facts.workspace.kind).toBe("none")
    expect(facts.commands.test).toBeUndefined()
    expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
  })

  it("truth lens runs over a code-free contract", async () => {
    const root = repo("docs-only")
    const facts = await scanProject(root)
    const report = await instructionTruthLens.run({ root, facts, profile: "solo", baseline: null })
    expect(report.status).toBe("ran")
    for (const f of report.findings) expect(f.evidence.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!hasRepo("oss-fork"))("corpus: oss-fork (large fork, symlinked contract)", () => {
  it("scans the fork: pnpm, husky hooks, AGENTS.md symlink counts as a contract", async () => {
    const facts = await scanProject(repo("oss-fork"))
    expect(facts.packageManager).toBe("pnpm")
    expect(facts.hooks.source).toBe("husky")
    expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
  })

  it("truth lens survives the 29KB claim-rich CLAUDE.md read-only", async () => {
    const root = repo("oss-fork")
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
})
