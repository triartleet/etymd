import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "clothaid-scan-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

describe("scanProject", () => {
  it("detects package manager, commands, frameworks and artifacts", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          "format:check": "prettier --check .",
          build: "tsup",
          dev: "vite",
        },
        dependencies: { react: "18.0.0", express: "4.0.0" },
      }),
    )
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("src/index.ts", "export const x = 1\n")

    const facts = await scanProject(dir)

    expect(facts.name).toBe("demo")
    expect(facts.packageManager).toBe("pnpm")
    expect(facts.commands.test).toBe("test")
    expect(facts.commands.typecheck).toBe("typecheck")
    expect(facts.commands.formatCheck).toBe("format:check")
    expect(facts.frameworks).toContain("React")
    expect(facts.frameworks).toContain("Express")
    expect(facts.artifacts.find((a) => a.id === "agents")?.exists).toBe(true)
    expect(facts.artifacts.find((a) => a.id === "claude")?.exists).toBe(false)
    expect(facts.tree.dirs.some((d) => d.name === "src")).toBe(true)
  })

  it("handles a bare directory without a package.json", async () => {
    const facts = await scanProject(dir)
    expect(facts.packageManager).toBe("unknown")
    expect(facts.workspace.kind).toBe("none")
    expect(facts.commands.raw).toEqual({})
  })

  it("detects pnpm workspace packages", async () => {
    await write("package.json", JSON.stringify({ name: "root", private: true }))
    await write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
    await write("packages/a/package.json", JSON.stringify({ name: "@demo/a", version: "1.0.0" }))
    await write("packages/b/package.json", JSON.stringify({ name: "@demo/b" }))

    const facts = await scanProject(dir)
    expect(facts.workspace.kind).toBe("pnpm")
    expect(facts.packages.map((p) => p.name).sort()).toEqual(["@demo/a", "@demo/b"])
  })
})
