import { promises as fs } from "node:fs"
import path from "node:path"

import type { GeneratedFile } from "./generate.js"

export interface ApplyResult {
  written: string[]
  skipped: string[]
}

/**
 * Write a planned file set. Idempotent by default: an existing file is skipped unless `overwrite`
 * names it — clothaid never clobbers hand-authored contracts without consent.
 */
export async function applyFiles(
  root: string,
  files: GeneratedFile[],
  overwrite: Set<string> = new Set(),
): Promise<ApplyResult> {
  const written: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (file.exists && !overwrite.has(file.path)) {
      skipped.push(file.path)
      continue
    }
    const abs = path.join(root, file.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, file.contents, "utf8")
    if (file.executable) await fs.chmod(abs, 0o755)
    written.push(file.path)
  }

  return { written, skipped }
}
