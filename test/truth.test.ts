import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import { extractCommandClaims, extractPathClaims } from "../src/lenses/instruction-truth/claims.js"
import { instructionTruthLens } from "../src/lenses/instruction-truth/lens.js"
import { contextEconomyLens, TOTAL_BUDGET_WORDS } from "../src/lenses/context-economy.js"
import type { LensContext } from "../src/engine/finding.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-truth-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function runTruth(): Promise<ReturnType<typeof instructionTruthLens.run>> {
  const facts = await scanProject(dir)
  const ctx: LensContext = { root: dir, facts, profile: "solo", baseline: null }
  return instructionTruthLens.run(ctx)
}

describe("claim extraction", () => {
  it("extracts script claims from pm invocations, skipping builtins and flagged calls", () => {
    const { scripts, filteredSkipped } = extractCommandClaims(
      [
        "Run `pnpm dev` then `pnpm install` and `npm run build`.",
        "```bash",
        "yarn test:unit",
        "pnpm --filter @x/api test",
        "```",
      ].join("\n"),
    )
    expect([...scripts.keys()].sort()).toEqual(["build", "dev", "test:unit"])
    expect(filteredSkipped).toBe(1)
  })

  it("treats `npm test` as a script claim but bare `npm foo` as nothing", () => {
    const { scripts } = extractCommandClaims("`npm test` and `npm foo`")
    expect([...scripts.keys()]).toEqual(["test"])
  })

  it("ignores pm names mentioned mid-phrase (prose, not instructions)", () => {
    const { scripts } = extractCommandClaims(
      "```sh\nfor t in pnpm node psql curl; do echo $t; done\n```",
    )
    expect([...scripts.keys()]).toEqual([])
  })

  it("extracts conservative path claims only", () => {
    const paths = extractPathClaims(
      [
        "See `src/core/detect.ts` and `docs/design/` for details.",
        "Routes live at `/admin/batches` and `~/home` and `@scope/pkg`.",
        "Globs like `src/**/*.ts` and urls `https://x.dev/a/b` and `$VAR/x` are skipped.",
        "Route params `p/$slug` are skipped.",
      ].join("\n"),
    )
    expect(paths.sort()).toEqual(["docs/design", "src/core/detect.ts"])
  })
})

describe("instruction-truth lens (the lying-AGENTS.md fixture)", () => {
  async function writeLyingFixture() {
    await write(
      "package.json",
      JSON.stringify({
        name: "liar",
        scripts: { "dev:web": "vite", test: "vitest run" },
      }),
    )
    await write("pnpm-lock.yaml", "")
    await write("src/real.ts", "export {}\n")
    await write(
      "AGENTS.md",
      [
        "# AGENTS.md",
        "Run `pnpm dev` to start.", // stale command (renamed dev:web)
        "The engine lives in `src/legacy/engine.ts`.", // stale path
        "Also see `src/real.ts`.", // true path
        "Use `yarn build:all` and `yarn deploy:prod` here.", // pm conflict (repo is pnpm)
        "State is tracked in PROJECT_CONTEXT.md.", // dangling doc ref
      ].join("\n\n"),
    )
  }

  it("reports each lie class with evidence, and nothing for true claims", async () => {
    await writeLyingFixture()
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)

    expect(ids).toContain("instruction-truth/stale-command:AGENTS.md:dev")
    expect(ids).toContain("instruction-truth/stale-path:AGENTS.md:src/legacy/engine.ts")
    expect(ids).toContain("instruction-truth/pm-conflict:AGENTS.md")
    expect(ids).toContain("instruction-truth/dangling-ref:AGENTS.md:PROJECT_CONTEXT.md")

    // True claims must not be flagged.
    expect(ids.filter((i) => i.includes("src/real.ts"))).toEqual([])
    // A stale command is the top severity: an agent will RUN it.
    const cmd = report.findings.find((f) => f.id.includes("stale-command"))
    expect(cmd?.tier).toBe("risk")
    // No baseline → disclosed, not silently skipped.
    expect(report.disclosures.some((d) => d.includes("baseline"))).toBe(true)
  })

  it("a truthful file produces no findings", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "honest", scripts: { dev: "vite", test: "vitest run" } }),
    )
    await write("pnpm-lock.yaml", "")
    await write("src/index.ts", "export {}\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nRun `pnpm dev`. Tests: `pnpm test`. Code in `src/index.ts`.\n",
    )
    const report = await runTruth()
    expect(report.findings).toEqual([])
  })

  it("reports a missing contract when no instruction files exist", async () => {
    await write("package.json", JSON.stringify({ name: "bare" }))
    const report = await runTruth()
    expect(report.findings.map((f) => f.id)).toContain("instruction-truth/no-contract")
  })

  it("resolves workspace scripts and package-relative paths in a monorepo (no false lies)", async () => {
    await write("package.json", JSON.stringify({ name: "mono", private: true }))
    await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n")
    await write("pnpm-lock.yaml", "")
    await write(
      "apps/api/package.json",
      JSON.stringify({ name: "@mono/api", scripts: { "db:generate": "drizzle-kit" } }),
    )
    await write("apps/api/src/db/schema.ts", "export {}\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nAfter editing the schema run `pnpm db:generate`. The schema lives in `db/schema.ts`.\n",
    )
    const report = await runTruth()
    // Both claims resolve in the workspace — flagging them would be the false-positive class
    // the pepshop live run exposed.
    expect(report.findings).toEqual([])
  })

  it("covers cursor rules and skills files too", async () => {
    await write("package.json", JSON.stringify({ name: "multi", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write(".cursor/rules/build.mdc", "Run `pnpm compile` before review.\n")
    await write(".claude/skills/deploy/SKILL.md", "See `scripts/deploy.sh` for the steps.\n")
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("instruction-truth/stale-command:.cursor/rules/build.mdc:compile")
    expect(ids).toContain(
      "instruction-truth/stale-path:.claude/skills/deploy/SKILL.md:scripts/deploy.sh",
    )
  })
})

describe("context-economy lens", () => {
  it("flags a heavy always-loaded file and the total budget", async () => {
    await write("package.json", JSON.stringify({ name: "heavy" }))
    const words = Array.from({ length: TOTAL_BUDGET_WORDS + 500 }, (_, i) => `word${i}`).join(" ")
    await write("AGENTS.md", `# AGENTS.md\n\n${words}\n`)
    const facts = await scanProject(dir)
    const report = await contextEconomyLens.run({
      root: dir,
      facts,
      profile: "solo",
      baseline: null,
    })
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("context-economy/heavy-file:AGENTS.md")
    expect(ids).toContain("context-economy/total-over-budget")
  })

  it("stays quiet on a lean footprint", async () => {
    await write("package.json", JSON.stringify({ name: "lean" }))
    await write("AGENTS.md", "# AGENTS.md\n\nShort and lean.\n")
    const facts = await scanProject(dir)
    const report = await contextEconomyLens.run({
      root: dir,
      facts,
      profile: "solo",
      baseline: null,
    })
    expect(report.findings).toEqual([])
  })
})
