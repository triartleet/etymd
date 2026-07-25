import { promises as fs } from "node:fs"
import path from "node:path"

import type { ProjectFacts } from "../../core/types.js"
import { isDirectory, readText } from "../../core/util.js"

// Claim extraction: what an instruction file ASSERTS about the repo. Precision beats recall
// here — a false "your file is lying" costs more trust than a missed lie, so every heuristic
// filters aggressively and the lens discloses what it skipped.

export interface InstructionFile {
  /** Repo-relative path. */
  path: string
  text: string
}

/** Every agent-facing instruction file the scan knows how to find. */
export async function listInstructionFiles(
  root: string,
  facts: ProjectFacts,
): Promise<InstructionFile[]> {
  const files: InstructionFile[] = []
  const add = async (rel: string) => {
    const text = await readText(path.join(root, rel))
    if (text !== null) files.push({ path: rel, text })
  }

  const singleFileArtifacts = [
    "agents",
    "claude",
    "gemini",
    "copilot",
    "cursorrules",
    "cline",
    "windsurf",
  ]
  for (const id of singleFileArtifacts) {
    const artifact = facts.artifacts.find((a) => a.id === id)
    if (artifact?.exists) await add(artifact.path)
  }

  const rulesDir = path.join(root, ".cursor", "rules")
  if (await isDirectory(rulesDir)) {
    try {
      for (const entry of await fs.readdir(rulesDir)) {
        if (entry.endsWith(".md") || entry.endsWith(".mdc"))
          await add(path.join(".cursor/rules", entry))
      }
    } catch {
      /* ignore */
    }
  }

  const skillsDir = path.join(root, ".claude", "skills")
  if (await isDirectory(skillsDir)) {
    try {
      for (const entry of await fs.readdir(skillsDir)) {
        const skill = path.join(".claude/skills", entry, "SKILL.md")
        await add(skill)
      }
    } catch {
      /* ignore */
    }
  }

  return files
}

/** Inline code spans + fenced-code lines — where command and path claims live. */
export function extractCodeTokens(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(/`([^`\n]+)`/g)) tokens.push((m[1] as string).trim())
  for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of (block[1] as string).split("\n")) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) tokens.push(trimmed)
    }
  }
  return tokens
}

export interface CommandClaims {
  /** Script names the file claims exist (deduped). */
  scripts: Map<string, string>
  /** Workspace-filtered invocations we deliberately did not validate. */
  filteredSkipped: number
}

// Package-manager built-ins that are not project scripts.
const PM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "up",
  "update",
  "upgrade",
  "dlx",
  "exec",
  "create",
  "init",
  "link",
  "unlink",
  "publish",
  "pack",
  "audit",
  "outdated",
  "why",
  "list",
  "ls",
  "view",
  "info",
  "config",
  "store",
  "import",
  "rebuild",
  "prune",
  "setup",
  "env",
  "bin",
  "root",
  "licenses",
  "patch",
  "approve-builds",
  "workspaces",
  "workspace",
  "cache",
  "version",
  "help",
])

/** Script names referenced via `pnpm X` / `yarn X` / `npm run X` / `bun run X` / `npm test`. */
export function extractCommandClaims(text: string): CommandClaims {
  const scripts = new Map<string, string>()
  let filteredSkipped = 0
  for (const token of extractCodeTokens(text)) {
    // Only command-position invocations count: token start or after a shell chain. A pm name
    // mentioned mid-phrase (`for t in pnpm node psql`) is prose, not an instruction.
    for (const m of token.matchAll(
      /(?:^|&&\s*|\|\|\s*|;\s*|\|\s*|\$\s+|\(\s*)(pnpm|yarn|npm|bun)\s+(?:(run)\s+)?(-{0,2}[A-Za-z0-9:._@/[\]-]+)/g,
    )) {
      const pm = m[1] as string
      const ranExplicit = Boolean(m[2])
      const arg = m[3] as string
      if (arg.startsWith("-")) {
        // A flagged invocation (--filter, -r, -C …) may target a workspace script we cannot
        // resolve from the root manifest — skipped, counted, disclosed.
        filteredSkipped += 1
        continue
      }
      // `npm X` only refers to a script via `npm run X` or the test/start shorthands.
      if (pm === "npm" && !ranExplicit && arg !== "test" && arg !== "start") continue
      if ((pm === "bun" || pm === "yarn" || pm === "pnpm") && !ranExplicit && PM_BUILTINS.has(arg))
        continue
      if (ranExplicit && PM_BUILTINS.has(arg)) continue
      scripts.set(arg, token)
    }
  }
  return { scripts, filteredSkipped }
}

const PATH_TOKEN_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.$-]+)+\/?$/

// A file claim needs a RECOGNIZED extension, not just a dot suffix: Better-Auth hook notation
// (`create/update.after`) reads as slash-joined prose with a dotted stage, and any bare
// "ends in .xyz" rule accuses it. Unknown extensions fall back to prose — precision over recall.
const KNOWN_EXTENSIONS = new Set([
  ...(
    "ts tsx cts mts js jsx cjs mjs json jsonc json5 md mdx mdc yml yaml toml ini cfg conf " +
    "env sh bash zsh fish ps1 bat cmd css scss sass less html htm xml svg sql prisma graphql " +
    "gql proto py rb rs go java kt kts swift c h cc cpp hpp cs php vue svelte astro txt log " +
    "lock csv tsv png jpg jpeg gif webp ico avif woff woff2 ttf otf wasm map pem key crt tf " +
    "tfvars example sample local snap ejs hbs pug"
  ).split(" "),
])

/**
 * Repo-relative path claims from single-token inline spans, conservatively filtered. The
 * load-bearing precision rule (learned from real corpus prose): an extensionless bare token
 * (`research/trust`, `milestone/mNN`) is prose — a dir claim must end with `/`, a file claim
 * must carry an extension.
 */
export function extractPathClaims(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = (m[1] as string).trim()
    if (token.includes(" ") || token.length > 120) continue
    if (
      token.startsWith("/") ||
      token.startsWith("~") ||
      token.startsWith("@") ||
      token.startsWith("$")
    )
      continue
    if (token.includes("://") || token.startsWith("www.")) continue
    if (/[*?{}<>|]/.test(token)) continue
    if (token.includes("@")) continue
    if (!PATH_TOKEN_RE.test(token)) continue
    // A $-placeholder segment (TanStack-style `/p/$slug`) is a route pattern, not a file claim.
    if (token.split("/").some((seg) => seg.startsWith("$"))) continue
    const isDirClaim = token.endsWith("/")
    const ext = token.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1]
    if (!isDirClaim && !(ext && KNOWN_EXTENSIONS.has(ext))) continue
    out.add(token.replace(/\/$/, ""))
  }
  return [...out]
}

/** How often each package manager is used in command position — the consistency signal. */
export function packageManagerUsage(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of extractCodeTokens(text)) {
    for (const m of token.matchAll(/\b(pnpm|yarn|npm|bun)\s+(?:run\s+)?[A-Za-z-]/g)) {
      const pm = m[1] as string
      counts.set(pm, (counts.get(pm) ?? 0) + 1)
    }
  }
  return counts
}

/** Cross-references to other well-known instruction/state docs. */
export const KNOWN_DOC_REFS = ["AGENTS.md", "CLAUDE.md", "PROJECT_CONTEXT.md", "GEMINI.md"]

export function extractDocRefs(text: string): string[] {
  return KNOWN_DOC_REFS.filter((name) => text.includes(name))
}
