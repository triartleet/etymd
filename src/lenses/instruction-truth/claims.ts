import { promises as fs } from "node:fs"
import path from "node:path"

import type { InstructionScope } from "../../core/config.js"
import { expandFileGlobs } from "../../core/detect.js"
import type { ProjectFacts } from "../../core/types.js"
import { isDirectory, matchesAnyGlob, normalizeRelPath, readText } from "../../core/util.js"

// Claim extraction: what an instruction file ASSERTS about the repo. Precision beats recall
// here — a false "your file is lying" costs more trust than a missed lie, so every heuristic
// filters aggressively and the lens discloses what it skipped.

export interface InstructionFile {
  /** Repo-relative path. */
  path: string
  text: string
}

export interface InstructionFileSet {
  /** The files the lens will actually audit. */
  files: InstructionFile[]
  /** Auto-detected files dropped by `instructions.exclude` — counted so scoping stays visible. */
  excluded: string[]
  /** Files pulled in by `instructions.include` that detection would have missed. */
  included: string[]
}

/**
 * Every agent-facing instruction file the scan knows how to find, then narrowed by the repo's
 * optional scope: auto-detected ∪ `include`, minus `exclude`. The excluded set is returned rather
 * than discarded — a scoped audit that quietly looked clean would be the exact dishonesty this
 * tool exists to catch.
 */
export async function listInstructionFiles(
  root: string,
  facts: ProjectFacts,
  scope?: InstructionScope,
): Promise<InstructionFileSet> {
  const files: InstructionFile[] = []
  const add = async (rel: string) => {
    const text = await readText(path.join(root, rel))
    if (text !== null) files.push({ path: normalizeRelPath(rel), text })
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

  const detected = new Set(files.map((f) => f.path))
  const included: string[] = []
  for (const rel of await expandFileGlobs(root, scope?.include ?? [])) {
    if (detected.has(rel)) continue
    const before = files.length
    await add(rel)
    if (files.length > before) included.push(rel)
  }

  const exclude = scope?.exclude ?? []
  if (!exclude.length) return { files, excluded: [], included }

  const kept: InstructionFile[] = []
  const excluded: string[] = []
  for (const file of files) {
    if (matchesAnyGlob(file.path, exclude)) excluded.push(file.path)
    else kept.push(file)
  }
  return { files: kept, excluded, included }
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

// A path the surrounding prose tells the agent to CREATE is not a stale reference — it is a
// forward-looking instruction, and the repo is right to lack it. Harvested from the oss-fork
// first audit (migration quarantine dirs, generated outputs), the second new skip class after
// Better-Auth dotted notation.
const CREATION_CONTEXT_RE =
  /\b(?:creat(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|scaffold(?:s|ed|ing)?|quarantin(?:e|es|ed|ing)|(?:writ(?:e|es|ten|ing)|output(?:s|ted)?|emit(?:s|ted|ting)?|sav(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|copy|copi(?:es|ed))\s+(?:it\s+|them\s+)?(?:to|into)|new\s+(?:file|directory|folder)|will\s+(?:be\s+)?(?:created|generated|written)|add(?:s|ed|ing)?\s+(?:a|the)\s+new)\b/i

// Naming stand-ins an instruction file uses to describe a shape, not to point at a real path.
const PLACEHOLDER_SEGMENTS = new Set(["placeholder", "foo", "bar", "baz", "qux"])
const PLACEHOLDER_PREFIX_RE = /^(?:my|your)-/i

function isPlaceholderClaim(token: string): boolean {
  return token
    .split("/")
    .some((seg) => PLACEHOLDER_PREFIX_RE.test(seg) || PLACEHOLDER_SEGMENTS.has(seg.toLowerCase()))
}

/**
 * The prose around one occurrence: its own line, plus the lead-in line when the claim sits in a
 * list item or table row ("Files this creates:" followed by bulleted paths is the common shape).
 */
function claimContext(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1
  const endRaw = text.indexOf("\n", index)
  const end = endRaw === -1 ? text.length : endRaw
  const line = text.slice(start, end)
  if (!/^\s*(?:[-*+]|\d+[.)]|\|)/.test(line)) return line

  // Walk back to the nearest non-empty, non-list line — the sentence the list hangs off.
  let cursor = start
  while (cursor > 0) {
    const prevEnd = cursor - 1
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1
    const prev = text.slice(prevStart, prevEnd)
    cursor = prevStart
    if (!prev.trim()) continue
    if (/^\s*(?:[-*+]|\d+[.)]|\|)/.test(prev)) continue
    return `${prev}\n${line}`
  }
  return line
}

export interface PathClaims {
  /** Claims to verify against the repo. */
  paths: string[]
  /** Claims whose every mention sits in create-this prose — skipped, counted, disclosed. */
  prospective: string[]
  /** Naming stand-ins (`my-custom-skill`) — never real claims. */
  placeholder: string[]
}

/**
 * Repo-relative path claims from single-token inline spans, conservatively filtered. The
 * load-bearing precision rule (learned from real corpus prose): an extensionless bare token
 * (`research/trust`, `milestone/mNN`) is prose — a dir claim must end with `/`, a file claim
 * must carry an extension.
 */
export function extractPathClaims(text: string): PathClaims {
  // Per claim: does EVERY mention sit in create-this prose? One plain reference makes it a claim.
  const prospectiveOnly = new Map<string, boolean>()
  const placeholder = new Set<string>()

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

    const claim = token.replace(/\/$/, "")
    if (isPlaceholderClaim(claim)) {
      placeholder.add(claim)
      continue
    }
    const prospective = CREATION_CONTEXT_RE.test(claimContext(text, m.index ?? 0))
    prospectiveOnly.set(claim, (prospectiveOnly.get(claim) ?? true) && prospective)
  }

  const paths: string[] = []
  const prospective: string[] = []
  for (const [claim, only] of prospectiveOnly) {
    if (only) prospective.push(claim)
    else paths.push(claim)
  }
  return { paths, prospective, placeholder: [...placeholder] }
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
export const KNOWN_DOC_REFS = [
  "AGENTS.md",
  "CLAUDE.md",
  "PROJECT_CONTEXT.md",
  "DECISIONS.md",
  "GEMINI.md",
]

export function extractDocRefs(text: string): string[] {
  return KNOWN_DOC_REFS.filter((name) => text.includes(name))
}
