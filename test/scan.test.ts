import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { classifyCommands, detectHooks } from "../src/core/detect.js"
import { scanProject } from "../src/core/scan.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-scan-"))
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
    expect(facts.packVersion).toBeTruthy()
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

  it("includes meaningful dot-dirs in the tree", async () => {
    await write("package.json", JSON.stringify({ name: "dots" }))
    await write(".github/workflows/ci.yml", "jobs: {}\n")
    await write(".claude/skills/repo-map/SKILL.md", "# map\n")
    await write("src/a.ts", "export {}\n")

    const facts = await scanProject(dir)
    const names = facts.tree.dirs.map((d) => d.name)
    expect(names).toContain(".github")
    expect(names).toContain(".claude")
    expect(names).toContain("src")
  })
})

describe("classifyCommands — corpus-shaped script sets", () => {
  it("nx-monorepo shape: bare meta `test` must not shadow test:unit:local; test:format is the check", () => {
    const cmds = classifyCommands({
      test: "npm-run-all test:lint:local test:types:local test:unit:local",
      "test:lint:local": "nx affected --target=lint",
      "test:types:local": "nx run-many --target=typecheck",
      "test:unit:local": "nx affected --target=test --runInBand",
      "test:format": "nx format:check",
      format: "nx affected --target=lint --fix && nx format:write",
    })
    expect(cmds.test).toBe("test:unit:local")
    expect(cmds.lint).toBe("test:lint:local")
    expect(cmds.typecheck).toBe("test:types:local")
    expect(cmds.formatCheck).toBe("test:format")
    // The writing formatter must never be picked as the check.
    expect(cmds.formatCheck).not.toBe("format")
  })

  it("spa-bff shape: test:unit wins over the && meta test; test:no-jest stays visible in raw", () => {
    const cmds = classifyCommands({
      test: "yarn test:unit && yarn test:no-jest",
      "test:unit": "jest",
      "test:no-jest": "yarn test:format && yarn test:types && yarn test:lint",
      "test:types": "tsc --noEmit -p tsconfig.json",
      "test:lint": "eslint src server",
      "test:format": "prettier -l 'src/**/*'",
    })
    expect(cmds.test).toBe("test:unit")
    expect(cmds.typecheck).toBe("test:types")
    expect(cmds.lint).toBe("test:lint")
    expect(cmds.formatCheck).toBe("test:format")
    expect(cmds.raw["test:no-jest"]).toBeDefined()
  })

  it("cra-legacy shape: prettier -l value classifies as formatCheck; format:eslint (--fix) is not lint", () => {
    const cmds = classifyCommands({
      test: "yarn test:lint && yarn test:format && yarn test:types && yarn test:unit",
      "test:lint": "eslint . --ext .ts,.tsx",
      "test:format": "prettier -l '**/*.{ts,tsx}'",
      "test:types": "tsc --noEmit",
      "test:unit": "jest --silent --detectOpenHandles --forceExit",
      "format:eslint": "eslint . --fix --ext .ts,.tsx",
      "format:prettier": "prettier --write '**/*'",
    })
    expect(cmds.test).toBe("test:unit")
    expect(cmds.lint).toBe("test:lint")
    expect(cmds.formatCheck).toBe("test:format")
    expect(cmds.format).toBe("format:prettier")
  })

  it("never lets a codegen script pass as typecheck", () => {
    const cmds = classifyCommands({
      "generate:types": "graphql-codegen",
      "build:types": "tsc --emitDeclarationOnly",
    })
    expect(cmds.typecheck).toBeUndefined()
  })
})

describe("detectHooks", () => {
  it("detects husky v3 config in package.json (no .husky dir)", async () => {
    const pkg = {
      name: "legacy",
      husky: { hooks: { "pre-commit": "lint-staged" } },
      "lint-staged": { "*.ts": ["prettier --write", "git add"] },
    }
    await write("package.json", JSON.stringify(pkg))
    const hooks = await detectHooks(dir, undefined, pkg as never)
    expect(hooks.source).toBe("husky-legacy")
    expect(hooks.preCommit).toBe(true)
    expect(hooks.prePush).toBe(false)
    expect(hooks.lintStaged).toBe(true)
  })

  it("records a custom core.hooksPath as the live hook source", async () => {
    await write("hooks/pre-push", "#!/bin/sh\nexit 0\n")
    const hooks = await detectHooks(dir, "hooks", null)
    expect(hooks.source).toBe("custom")
    expect(hooks.dir).toBe("hooks")
    expect(hooks.prePush).toBe(true)
  })

  it("reports tracked .githooks even when core.hooksPath is unset", async () => {
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")
    const hooks = await detectHooks(dir, undefined, null)
    expect(hooks.source).toBe("githooks")
    expect(hooks.preCommit).toBe(true)
  })
})
