import { promises as fs } from "node:fs"
import path from "node:path"

import type { ContextBudget, ContextFile } from "./types.js"
import { approxTokens, pathExists, readText, wordCount } from "./util.js"

// The always-loaded set: files an agent reads on (nearly) every session regardless of task.
// This is the footprint clothaid holds down — context is the dominant cost of the loop.
const ALWAYS_LOADED: { path: string; role: string }[] = [
  { path: "AGENTS.md", role: "operating contract" },
  { path: "CLAUDE.md", role: "Claude Code pointer" },
  { path: "GEMINI.md", role: "Gemini pointer" },
  { path: ".github/copilot-instructions.md", role: "Copilot instructions" },
  { path: ".cursorrules", role: "Cursor rules (legacy)" },
]

/** Above this word count a single always-loaded file is worth extracting into an on-demand skill. */
const EXTRACTION_THRESHOLD = 4000

/**
 * A Cursor rule only loads every session when it is genuinely always-applied. Scoped rules
 * (globs, or alwaysApply omitted/false in frontmatter) load on demand and must not inflate the
 * budget — the flagship metric has to be honest to be worth anything.
 */
export function isAlwaysAppliedCursorRule(text: string): boolean {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return true
  const frontmatter = fm[1] ?? ""
  return /^\s*alwaysApply\s*:\s*true\s*$/m.test(frontmatter)
}

export async function measureContext(root: string): Promise<ContextBudget> {
  const files: ContextFile[] = []

  for (const spec of ALWAYS_LOADED) {
    const abs = path.join(root, spec.path)
    const text = await readText(abs)
    if (text === null) continue
    const words = wordCount(text)
    files.push({ path: spec.path, role: spec.role, words, approxTokens: approxTokens(words) })
  }

  const rulesDir = path.join(root, ".cursor", "rules")
  if (await pathExists(rulesDir)) {
    try {
      for (const entry of await fs.readdir(rulesDir)) {
        if (!entry.endsWith(".mdc") && !entry.endsWith(".md")) continue
        const text = await readText(path.join(rulesDir, entry))
        if (text === null || !isAlwaysAppliedCursorRule(text)) continue
        const words = wordCount(text)
        files.push({
          path: `.cursor/rules/${entry}`,
          role: "Cursor rule (always applied)",
          words,
          approxTokens: approxTokens(words),
        })
      }
    } catch {
      /* ignore */
    }
  }

  const totalWords = files.reduce((s, f) => s + f.words, 0)
  return {
    files: files.sort((a, b) => b.words - a.words),
    totalWords,
    totalApproxTokens: approxTokens(totalWords),
    extractionCandidates: files.filter((f) => f.words >= EXTRACTION_THRESHOLD),
  }
}

export { EXTRACTION_THRESHOLD }
