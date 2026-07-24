import path from "node:path"

import { PACK_VERSION } from "../pack/version.js"
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
  type PackageJson,
} from "./detect.js"
import type { ProjectFacts } from "./types.js"
import { git, readJson } from "./util.js"

/** Most-common ticket prefix (e.g. "NGRE2E") in recent commit subjects, if any dominates. */
function inferTicketKey(subjects: string): string | undefined {
  const counts = new Map<string, number>()
  for (const m of subjects.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) {
    const key = m[1] as string
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return bestCount >= 3 ? best : undefined
}

/**
 * The deterministic half of a reckoning: everything knowable without an LLM. Kept pure of any
 * terminal output so it can back both the CLI and programmatic use, and so it is trivially
 * testable against a fixture directory.
 */
export async function scanProject(root: string): Promise<ProjectFacts> {
  const abs = path.resolve(root)
  const rootPkg = await readJson<PackageJson>(path.join(abs, "package.json"))

  const [packageManager, workspace, ci, artifacts, tree, isRepo] = await Promise.all([
    detectPackageManager(abs, rootPkg),
    detectWorkspace(abs, rootPkg),
    detectCi(abs),
    detectArtifacts(abs),
    walkTree(abs),
    git(abs, ["rev-parse", "--is-inside-work-tree"]).then((r) => r === "true"),
  ])

  const [branch, head, hooksPathRaw, authorsRaw, subjectsRaw] = isRepo
    ? await Promise.all([
        git(abs, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(abs, ["rev-parse", "--short", "HEAD"]),
        git(abs, ["config", "--get", "core.hooksPath"]),
        git(abs, ["log", "-200", "--format=%ae"]),
        git(abs, ["log", "-50", "--format=%s"]),
      ])
    : [null, null, null, null, null]

  const hooksPath = hooksPathRaw ?? undefined
  const hooks = await detectHooks(abs, hooksPath, rootPkg)
  const packages = workspace.packageGlobs.length
    ? await listWorkspacePackages(abs, workspace.packageGlobs)
    : []
  const recentAuthors = authorsRaw
    ? new Set(authorsRaw.split("\n").filter(Boolean)).size
    : undefined

  return {
    etymdVersion: VERSION,
    packVersion: PACK_VERSION,
    generatedAt: new Date().toISOString(),
    root: abs,
    name: rootPkg?.name ?? path.basename(abs),
    git: {
      isRepo,
      branch: branch ?? undefined,
      head: head ?? undefined,
      hooksPath,
      husky: hooks.source === "husky" || hooks.source === "husky-legacy",
      recentAuthors,
      ticketKey: subjectsRaw ? inferTicketKey(subjectsRaw) : undefined,
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
