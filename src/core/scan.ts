import path from "node:path"

import { VERSION } from "../version.js"
import {
  classifyCommands,
  detectArtifacts,
  detectCi,
  detectFrameworks,
  detectHooks,
  detectPackageManager,
  detectWorkspace,
  listWorkspacePackages,
  walkTree,
} from "./detect.js"
import type { ProjectFacts } from "./types.js"
import { git, readJson } from "./util.js"

interface RootPkg {
  name?: string
  version?: string
  private?: boolean
  packageManager?: string
  engines?: { node?: string }
  workspaces?: string[] | { packages?: string[] }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * The deterministic half of a reckoning: everything knowable without an LLM. Kept pure of any
 * terminal output so it can back both the CLI and programmatic use, and so it is trivially
 * testable against a fixture directory.
 */
export async function scanProject(root: string): Promise<ProjectFacts> {
  const abs = path.resolve(root)
  const rootPkg = await readJson<RootPkg>(path.join(abs, "package.json"))

  const [packageManager, workspace, ci, artifacts, tree, isRepo] = await Promise.all([
    detectPackageManager(abs, rootPkg),
    detectWorkspace(abs, rootPkg),
    detectCi(abs),
    detectArtifacts(abs),
    walkTree(abs),
    git(abs, ["rev-parse", "--is-inside-work-tree"]).then((r) => r === "true"),
  ])

  const [branch, head, hooksPathRaw] = isRepo
    ? await Promise.all([
        git(abs, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(abs, ["rev-parse", "--short", "HEAD"]),
        git(abs, ["config", "--get", "core.hooksPath"]),
      ])
    : [null, null, null]

  const hooksPath = hooksPathRaw ?? undefined
  const hooks = await detectHooks(abs, hooksPath)
  const packages = workspace.packageGlobs.length
    ? await listWorkspacePackages(abs, workspace.packageGlobs)
    : []

  return {
    clothaidVersion: VERSION,
    generatedAt: new Date().toISOString(),
    root: abs,
    name: rootPkg?.name ?? path.basename(abs),
    git: {
      isRepo,
      branch: branch ?? undefined,
      head: head ?? undefined,
      hooksPath,
      husky: hooks.source === "husky",
    },
    packageManager,
    node: rootPkg?.engines?.node,
    workspace: { kind: workspace.kind, packageGlobs: workspace.packageGlobs },
    packages,
    frameworks: detectFrameworks(rootPkg),
    commands: classifyCommands(rootPkg?.scripts),
    ci,
    hooks,
    artifacts,
    tree,
  }
}
