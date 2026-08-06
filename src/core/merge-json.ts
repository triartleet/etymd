import { promises as fs } from "node:fs"

import { readText } from "./util.js"

/**
 * Set one key inside a JSON file the USER owns, leaving everything else untouched.
 *
 * `package.json` is the most central file in most repos and almost all of it is hand-authored,
 * so a generator cannot rewrite it wholesale the way it rewrites a hook. This sets exactly the
 * keys it is given and preserves the rest — including key order, which is meaningful to humans
 * reading a diff even though it is meaningless to JSON.
 *
 * Deliberately conservative:
 *   - refuses to overwrite a DIFFERENT existing value (that is the user's script, not ours)
 *   - preserves the file's existing indentation and trailing newline
 *   - never reorders, never reformats untouched keys
 *   - reports exactly what it did, so a caller can render it before consenting
 */

export type MergeOutcome = "added" | "unchanged" | "conflict" | "absent" | "unparsable"

export interface MergeResult {
  outcome: MergeOutcome
  /** The value already present when the outcome is `conflict`. */
  existing?: string
  detail?: string
}

/** Match the file's own indentation rather than imposing one — this is the user's file. */
function detectIndent(raw: string): string | number {
  const m = raw.match(/\n(\s+)"/)
  if (!m) return 2
  const ws = m[1] as string
  return ws.includes("\t") ? "\t" : ws.length
}

export function mergeScriptInto(
  raw: string,
  key: string,
  value: string,
): { text?: string; result: MergeResult } {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    return {
      result: {
        outcome: "unparsable",
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }

  const scripts = (doc.scripts ?? {}) as Record<string, unknown>
  const current = scripts[key]
  if (typeof current === "string") {
    if (current === value) return { result: { outcome: "unchanged" } }
    // A different command is a deliberate choice by whoever wrote it. Etymd reports and stops:
    // silently replacing a publish hook could disable a check the user relies on.
    return { result: { outcome: "conflict", existing: current } }
  }

  const indent = detectIndent(raw)
  const next = { ...doc, scripts: { ...scripts, [key]: value } }
  const trailing = raw.endsWith("\n") ? "\n" : ""
  return { text: JSON.stringify(next, null, indent) + trailing, result: { outcome: "added" } }
}

/** Apply {@link mergeScriptInto} to a file on disk. Writes only on `added`. */
export async function ensurePackageScript(
  pkgPath: string,
  key: string,
  value: string,
): Promise<MergeResult> {
  const raw = await readText(pkgPath)
  if (raw === null) return { outcome: "absent" }
  const { text, result } = mergeScriptInto(raw, key, value)
  if (text) await fs.writeFile(pkgPath, text, "utf8")
  return result
}
