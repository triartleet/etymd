import { promises as fs } from "node:fs"
import path from "node:path"

import type {
  CiSystem,
  DetectedArtifact,
  DiscoveredCommands,
  HookFacts,
  PackageInfo,
  PackageManager,
  WorkspaceKind,
} from "./types.js"
import { isDirectory, pathExists, readJson, readText } from "./util.js"

interface PackageJson {
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

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm",
  "out",
])

export async function detectPackageManager(
  root: string,
  pkg: PackageJson | null,
): Promise<PackageManager> {
  if (pkg?.packageManager) {
    const name = pkg.packageManager.split("@")[0]
    if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") return name
  }
  const lock: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
  ]
  for (const [file, pm] of lock) {
    if (await pathExists(path.join(root, file))) return pm
  }
  return "unknown"
}

export async function detectWorkspace(
  root: string,
  pkg: PackageJson | null,
): Promise<{ kind: WorkspaceKind; packageGlobs: string[] }> {
  if (await pathExists(path.join(root, "nx.json"))) return { kind: "nx", packageGlobs: [] }
  if (await pathExists(path.join(root, "turbo.json"))) return { kind: "turbo", packageGlobs: [] }
  if (await pathExists(path.join(root, "lerna.json"))) return { kind: "lerna", packageGlobs: [] }

  const pnpmWs = await readText(path.join(root, "pnpm-workspace.yaml"))
  if (pnpmWs) {
    const globs = pnpmWs
      .split("\n")
      .map((l) => l.match(/^\s*-\s*["']?([^"'#]+)["']?/)?.[1]?.trim())
      .filter((g): g is string => Boolean(g))
    return { kind: "pnpm", packageGlobs: globs }
  }

  if (pkg?.workspaces) {
    const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? [])
    return {
      kind: (pkg.packageManager?.startsWith("yarn") ? "yarn" : "npm") as WorkspaceKind,
      packageGlobs: globs,
    }
  }

  return { kind: "none", packageGlobs: [] }
}

/** Expand simple `dir/*` and `dir/**` globs into concrete package dirs (bounded, no glob lib). */
export async function listWorkspacePackages(root: string, globs: string[]): Promise<PackageInfo[]> {
  const found: PackageInfo[] = []
  const seen = new Set<string>()

  const addFromDir = async (dir: string) => {
    const pkgPath = path.join(dir, "package.json")
    if (seen.has(pkgPath)) return
    const pkg = await readJson<PackageJson>(pkgPath)
    if (!pkg?.name) return
    seen.add(pkgPath)
    found.push({
      name: pkg.name,
      dir: path.relative(root, dir) || ".",
      private: Boolean(pkg.private),
      version: pkg.version,
    })
  }

  for (const glob of globs) {
    const base = glob.replace(/\/\*\*?$/, "")
    const parent = path.join(root, base)
    if (!(await isDirectory(parent))) continue
    let entries: string[]
    try {
      entries = await fs.readdir(parent)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue
      const child = path.join(parent, entry)
      if (await isDirectory(child)) await addFromDir(child)
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir))
}

type CommandRole = Exclude<keyof DiscoveredCommands, "raw">

const CLASSIFIERS: { role: CommandRole; test: (k: string, v: string) => boolean }[] = [
  {
    role: "formatCheck",
    test: (k) => /format:check|format:ci|prettier:check|check:format/.test(k),
  },
  {
    role: "typecheck",
    test: (k, v) => /typecheck|type-check|types|tsc/.test(k) || /tsc\s+--noemit/i.test(v),
  },
  { role: "test", test: (k) => /^test(:unit|:ci|:local)?$/.test(k) },
  { role: "lint", test: (k) => /^lint$|lint:|test:lint|eslint/.test(k) },
  { role: "format", test: (k) => /^format$|format:write|prettier:write/.test(k) },
  { role: "build", test: (k) => /^build$|build:/.test(k) },
  { role: "dev", test: (k) => /^dev$|^start$|dev:/.test(k) },
]

export function classifyCommands(scripts: Record<string, string> = {}): DiscoveredCommands {
  const out: DiscoveredCommands = { raw: scripts }
  for (const [key, value] of Object.entries(scripts)) {
    if (/watch/.test(key)) continue
    for (const { role, test } of CLASSIFIERS) {
      if (out[role]) continue
      if (test(key, value)) out[role] = key
    }
  }
  return out
}

const FRAMEWORK_MARKERS: [string, string][] = [
  ["next", "Next.js"],
  ["@tanstack/react-start", "TanStack Start"],
  ["@tanstack/start", "TanStack Start"],
  ["@tanstack/react-router", "TanStack Router"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["@trpc/server", "tRPC"],
  ["vite", "Vite"],
  ["react-scripts", "CRA"],
  ["@apollo/client", "Apollo"],
  ["drizzle-orm", "Drizzle"],
  ["prisma", "Prisma"],
  ["@sanity/client", "Sanity"],
  ["nx", "Nx"],
]

export function detectFrameworks(pkg: PackageJson | null): string[] {
  if (!pkg) return []
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const out: string[] = []
  for (const [marker, label] of FRAMEWORK_MARKERS) {
    if (deps[marker] && !out.includes(label)) out.push(label)
  }
  return out
}

export async function detectCi(root: string): Promise<{ system: CiSystem; files: string[] }> {
  if (await pathExists(path.join(root, ".gitlab-ci.yml"))) {
    return { system: "gitlab", files: [".gitlab-ci.yml"] }
  }
  const workflows = path.join(root, ".github", "workflows")
  if (await isDirectory(workflows)) {
    try {
      const files = (await fs.readdir(workflows))
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map((f) => path.join(".github/workflows", f))
      if (files.length) return { system: "github", files }
    } catch {
      /* ignore */
    }
  }
  return { system: "none", files: [] }
}

export async function detectHooks(root: string, hooksPath: string | undefined): Promise<HookFacts> {
  const husky = await isDirectory(path.join(root, ".husky"))
  const dir =
    hooksPath ??
    ((await isDirectory(path.join(root, ".githooks"))) ? ".githooks" : husky ? ".husky" : "")
  const source: HookFacts["source"] = dir === ".githooks" ? "githooks" : husky ? "husky" : "none"
  const base = dir ? path.join(root, dir) : ""
  return {
    source,
    preCommit: base ? await pathExists(path.join(base, "pre-commit")) : false,
    prePush: base ? await pathExists(path.join(base, "pre-push")) : false,
  }
}

const ARTIFACT_SPECS: Omit<DetectedArtifact, "exists">[] = [
  { id: "agents", label: "AGENTS.md (operating contract)", path: "AGENTS.md", kind: "contract" },
  {
    id: "project-context",
    label: "PROJECT_CONTEXT.md (ground-truth state)",
    path: "PROJECT_CONTEXT.md",
    kind: "state",
  },
  { id: "claude", label: "CLAUDE.md (Claude Code pointer)", path: "CLAUDE.md", kind: "adapter" },
  {
    id: "copilot",
    label: "Copilot instructions",
    path: ".github/copilot-instructions.md",
    kind: "adapter",
  },
  {
    id: "cursorrules",
    label: ".cursorrules (legacy Cursor)",
    path: ".cursorrules",
    kind: "adapter",
  },
  { id: "cursor-rules", label: ".cursor/rules", path: ".cursor/rules", kind: "adapter" },
  { id: "gemini", label: "GEMINI.md", path: "GEMINI.md", kind: "adapter" },
  { id: "cline", label: ".clinerules", path: ".clinerules", kind: "adapter" },
  { id: "windsurf", label: ".windsurfrules", path: ".windsurfrules", kind: "adapter" },
  { id: "skills", label: "Agent skills (.claude/skills)", path: ".claude/skills", kind: "skill" },
  {
    id: "sessions",
    label: "Session archive (docs/sessions)",
    path: "docs/sessions",
    kind: "sessions",
  },
  { id: "githooks", label: "Tracked git hooks (.githooks)", path: ".githooks", kind: "gate" },
  {
    id: "inventory",
    label: "Reuse inventory (docs/INVENTORY.md)",
    path: "docs/INVENTORY.md",
    kind: "map",
  },
]

export async function detectArtifacts(root: string): Promise<DetectedArtifact[]> {
  return Promise.all(
    ARTIFACT_SPECS.map(async (spec) => ({
      ...spec,
      exists: await pathExists(path.join(root, spec.path)),
    })),
  )
}

/** Top-level directory index with bounded file counts (skips ignored/heavy dirs; caps work). */
export async function walkTree(
  root: string,
): Promise<{ dirs: { name: string; files: number }[]; truncated: boolean }> {
  const state = { budget: 20000, truncated: false }

  const countFiles = async (dir: string): Promise<number> => {
    if (state.budget <= 0) {
      state.truncated = true
      return 0
    }
    let total = 0
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue
      if (entry.isDirectory()) {
        total += await countFiles(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        total += 1
        state.budget -= 1
        if (state.budget <= 0) {
          state.truncated = true
          break
        }
      }
    }
    return total
  }

  let top: import("node:fs").Dirent[]
  try {
    top = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { dirs: [], truncated: false }
  }
  const dirs: { name: string; files: number }[] = []
  for (const entry of top) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue
    dirs.push({ name: entry.name, files: await countFiles(path.join(root, entry.name)) })
  }
  dirs.sort((a, b) => b.files - a.files)
  return { dirs, truncated: state.truncated }
}
