import { promises as fs } from "node:fs"
import path from "node:path"

import type { ProjectFacts } from "./types.js"
import { readJson } from "./util.js"

/** Where a project's reckoning is cached. Gitignored by convention (transient, re-derivable). */
export const CLOTHAID_DIR = ".clothaid"
export const FACTS_FILE = "facts.json"

export function factsPath(root: string): string {
  return path.join(root, CLOTHAID_DIR, FACTS_FILE)
}

export async function writeFacts(root: string, facts: ProjectFacts): Promise<string> {
  const dir = path.join(root, CLOTHAID_DIR)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, FACTS_FILE)
  await fs.writeFile(target, JSON.stringify(facts, null, 2) + "\n", "utf8")
  return target
}

export async function readFacts(root: string): Promise<ProjectFacts | null> {
  return readJson<ProjectFacts>(factsPath(root))
}
