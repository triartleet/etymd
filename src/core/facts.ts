import { promises as fs } from "node:fs"
import path from "node:path"

import type { WorkflowProfile } from "../engine/finding.js"
import type { ProjectFacts } from "./types.js"
import { readJson } from "./util.js"

// Two stores with opposite lifecycles:
// - cache/facts.json — transient, re-derivable, GITIGNORED: the last scan, a convenience.
// - baseline.json    — COMMITTED: the approved reckoning drift is measured against. Written at
//   init (approval time), pack-versioned. Doctor/audit truth-lenses compare tree vs baseline,
//   never vs the last peek — otherwise looking at the project resets what "drift" means.
export const ETYMD_DIR = ".etymd"
export const CACHE_DIR = path.join(ETYMD_DIR, "cache")
export const CACHE_FACTS_FILE = path.join(CACHE_DIR, "facts.json")
export const BASELINE_FILE = path.join(ETYMD_DIR, "baseline.json")

export interface Baseline {
  packVersion: string
  etymdVersion: string
  approvedAt: string
  profile: WorkflowProfile
  facts: ProjectFacts
}

export function cacheFactsPath(root: string): string {
  return path.join(root, CACHE_FACTS_FILE)
}

export function baselinePath(root: string): string {
  return path.join(root, BASELINE_FILE)
}

async function writeJsonFile(target: string, data: unknown): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(data, null, 2) + "\n", "utf8")
  return target
}

export async function writeCachedFacts(root: string, facts: ProjectFacts): Promise<string> {
  return writeJsonFile(cacheFactsPath(root), facts)
}

export async function readCachedFacts(root: string): Promise<ProjectFacts | null> {
  return readJson<ProjectFacts>(cacheFactsPath(root))
}

export async function writeBaseline(root: string, baseline: Baseline): Promise<string> {
  return writeJsonFile(baselinePath(root), baseline)
}

export async function readBaseline(root: string): Promise<Baseline | null> {
  return readJson<Baseline>(baselinePath(root))
}

/** Solo vs team, from recent-author cardinality; init lets the human confirm/override. */
export function deriveProfile(facts: ProjectFacts): WorkflowProfile {
  return (facts.git.recentAuthors ?? 1) > 2 ? "team" : "solo"
}
