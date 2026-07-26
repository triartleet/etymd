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

export interface PackageJson {
  name?: string
  version?: string
  private?: boolean
  packageManager?: string
  engines?: { node?: string }
  workspaces?: string[] | { packages?: string[] }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  husky?: { hooks?: Record<string, string> }
  "lint-staged"?: unknown
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

// Dot-dirs that carry workflow meaning belong in the map an agent navigates by.
const MEANINGFUL_DOT_DIRS = new Set([
  ".github",
  ".gitlab",
  ".claude",
  ".cursor",
  ".githooks",
  ".husky",
  ".changeset",
  ".vscode",
  ".storybook",
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

type Pattern = (key: string, value: string) => boolean

/** A meta-runner chains other scripts; prefer the narrow command it delegates to. */
const isMeta = (value: string) => /npm-run-all|run-s\b|run-p\b|concurrently|&&/.test(value)

// Per-role priority ladders, most specific first. Checked against ALL scripts per rung, so a
// bare meta `test` declared first can no longer shadow the real `test:unit(:local)` — the
// corpus failure that motivated this shape.
const ROLE_LADDERS: { role: CommandRole; exclude?: RegExp; ladder: Pattern[] }[] = [
  {
    role: "formatCheck",
    ladder: [
      (k) => /^format:check$/.test(k),
      (k) => /^test:format(:local)?$/.test(k),
      (k) => /^(prettier:check|check:format|format:ci)$/.test(k),
      (_k, v) => /prettier(\s|.*\s)(-l\b|--check)/.test(v),
    ],
  },
  {
    role: "typecheck",
    exclude: /generate|codegen|build|emit|watch/,
    ladder: [
      (k) => /^(typecheck|type-check)$/.test(k),
      (k) => /^test:types(:local)?$/.test(k),
      (k) => /^(types|check:types|types:check)$/.test(k),
      (_k, v) => /tsc\b.*--noemit/i.test(v),
    ],
  },
  {
    role: "test",
    exclude: /watch|coverage|snapshot|e2e|integration|debug|notsilent|mdx/,
    ladder: [
      (k) => /^test:unit(:local|:ci)?$/.test(k),
      (k) => /^test:jest$/.test(k),
      (k, v) => /^test$/.test(k) && !isMeta(v),
      (k) => /^test$/.test(k),
    ],
  },
  {
    role: "lint",
    exclude: /fix|format|staged|watch|style/,
    ladder: [
      (k) => /^lint$/.test(k),
      (k) => /^test:lint(:local)?$/.test(k),
      (k) => /^lint:/.test(k),
      (_k, v) => /eslint\b/.test(v) && !/--fix/.test(v),
    ],
  },
  {
    role: "format",
    exclude: /check|:ci$/,
    ladder: [
      (k) => /^format$/.test(k),
      (k) => /^(format:write|format:prettier|format:fix|prettier)$/.test(k),
      (_k, v) => /prettier\b.*--write/.test(v),
    ],
  },
  {
    role: "build",
    exclude: /watch|storybook/,
    ladder: [(k) => /^build$/.test(k), (k) => /^build:/.test(k)],
  },
  {
    role: "dev",
    ladder: [(k) => /^dev$/.test(k), (k) => /^start$/.test(k), (k) => /^dev:/.test(k)],
  },
]

export function classifyCommands(scripts: Record<string, string> = {}): DiscoveredCommands {
  const out: DiscoveredCommands = { raw: scripts }
  const entries = Object.entries(scripts)
  for (const { role, exclude, ladder } of ROLE_LADDERS) {
    for (const pattern of ladder) {
      const hit = entries.find(([k, v]) => !exclude?.test(k) && pattern(k, v))
      if (hit) {
        out[role] = hit[0]
        break
      }
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

async function hasLintStagedConfig(root: string, pkg: PackageJson | null): Promise<boolean> {
  if (pkg && pkg["lint-staged"]) return true
  for (const f of [
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.js",
    "lint-staged.config.js",
  ]) {
    if (await pathExists(path.join(root, f))) return true
  }
  return false
}

export async function detectHooks(
  root: string,
  hooksPath: string | undefined,
  pkg: PackageJson | null,
): Promise<HookFacts> {
  const lintStaged = await hasLintStagedConfig(root, pkg)

  // A custom core.hooksPath wins: git actually runs those hooks, wherever they live.
  if (hooksPath) {
    // husky v9's `prepare` wires core.hooksPath to `.husky/_` (its shim dir); the user's real
    // hooks live one level up in `.husky/` — that is husky, not a custom hook setup.
    if (hooksPath.replace(/\/+$/, "") === ".husky/_") {
      const base = path.join(root, ".husky")
      return {
        source: "husky",
        dir: ".husky",
        preCommit: await pathExists(path.join(base, "pre-commit")),
        prePush: await pathExists(path.join(base, "pre-push")),
        commitMsg: await pathExists(path.join(base, "commit-msg")),
        lintStaged,
      }
    }
    const base = path.join(root, hooksPath)
    return {
      source: hooksPath === ".githooks" ? "githooks" : "custom",
      dir: hooksPath,
      preCommit: await pathExists(path.join(base, "pre-commit")),
      prePush: await pathExists(path.join(base, "pre-push")),
      commitMsg: await pathExists(path.join(base, "commit-msg")),
      lintStaged,
    }
  }

  if (await isDirectory(path.join(root, ".githooks"))) {
    // Tracked hooks exist but core.hooksPath is unset — recorded so doctor can flag "not wired".
    const base = path.join(root, ".githooks")
    return {
      source: "githooks",
      dir: ".githooks",
      preCommit: await pathExists(path.join(base, "pre-commit")),
      prePush: await pathExists(path.join(base, "pre-push")),
      commitMsg: await pathExists(path.join(base, "commit-msg")),
      lintStaged,
    }
  }

  if (await isDirectory(path.join(root, ".husky"))) {
    const base = path.join(root, ".husky")
    return {
      source: "husky",
      dir: ".husky",
      preCommit: await pathExists(path.join(base, "pre-commit")),
      prePush: await pathExists(path.join(base, "pre-push")),
      commitMsg: await pathExists(path.join(base, "commit-msg")),
      lintStaged,
    }
  }

  // husky v3/v4: config-defined hooks, no .husky/ dir (package.json `husky` key or husky.config.js).
  const legacyHooks = pkg?.husky?.hooks
  const configText = legacyHooks ? null : await readText(path.join(root, "husky.config.js"))
  if (legacyHooks || configText) {
    const hookNamed = (name: string) =>
      legacyHooks ? Boolean(legacyHooks[name]) : Boolean(configText && configText.includes(name))
    return {
      source: "husky-legacy",
      preCommit: hookNamed("pre-commit"),
      prePush: hookNamed("pre-push"),
      commitMsg: hookNamed("commit-msg"),
      lintStaged,
    }
  }

  return { source: "none", preCommit: false, prePush: false, commitMsg: false, lintStaged }
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
    id: "failure-modes-skill",
    label: "Failure-modes register (skill)",
    path: ".claude/skills/failure-modes",
    kind: "skill",
  },
  {
    id: "failure-modes-doc",
    label: "Failure-modes register (doc)",
    path: "docs/failure-modes.md",
    kind: "other",
  },
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
    if (IGNORED_DIRS.has(entry.name)) continue
    // Workflow-bearing dot-dirs enter the map; other dot-dirs stay hidden.
    if (entry.name.startsWith(".") && !MEANINGFUL_DOT_DIRS.has(entry.name)) continue
    dirs.push({ name: entry.name, files: await countFiles(path.join(root, entry.name)) })
  }
  dirs.sort((a, b) => b.files - a.files)
  return { dirs, truncated: state.truncated }
}
