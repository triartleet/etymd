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

/**
 * The scan's absolute root is a MACHINE path — it carries the author's username and directory
 * layout. It must never reach the baseline, because the baseline is the one file etymd tells
 * people to commit (and therefore to publish). It is redundant there anyway: the baseline lives
 * inside the repo it describes, and `facts.name` already identifies the project.
 *
 * True for the gitignored cache too, but that one stays absolute on purpose — it never leaves the
 * machine, and a wrong-checkout cache is easier to spot with the real path in it.
 */
export function withoutMachinePath(facts: ProjectFacts): ProjectFacts {
  return { ...facts, root: "." }
}

/** True for a baseline written before the root was elided — its holder should re-approve. */
export function baselineCarriesMachinePath(baseline: Baseline): boolean {
  const root = baseline.facts?.root
  return (
    typeof root === "string" &&
    root !== "." &&
    (root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root))
  )
}

export async function writeBaseline(root: string, baseline: Baseline): Promise<string> {
  return writeJsonFile(baselinePath(root), {
    ...baseline,
    facts: withoutMachinePath(baseline.facts),
  })
}

export async function readBaseline(root: string): Promise<Baseline | null> {
  return readJson<Baseline>(baselinePath(root))
}

/** Solo vs team, from recent-author cardinality; init lets the human confirm/override. */
export function deriveProfile(facts: ProjectFacts): WorkflowProfile {
  return (facts.git.recentAuthors ?? 1) > 2 ? "team" : "solo"
}

const DRIFT_ROLES = ["test", "lint", "typecheck", "format", "formatCheck", "build", "dev"] as const

export interface BaselineDrift {
  /** Per-role command changes on the "Done =" axis (renamed, added, or removed scripts). */
  commands: { role: string; from?: string; to?: string }[]
  artifactsAdded: string[]
  artifactsRemoved: string[]
  dirsAdded: string[]
  dirsRemoved: string[]
}

/**
 * The structural change between an approved baseline and a fresh reckoning, on exactly the axes
 * the baseline is measured on (commands, artifacts, top-level layout). What `etymd approve` shows
 * the human so they see what they are blessing. Pure.
 */
export function summarizeBaselineDrift(old: ProjectFacts, fresh: ProjectFacts): BaselineDrift {
  const commands: BaselineDrift["commands"] = []
  for (const role of DRIFT_ROLES) {
    const from = old.commands[role]
    const to = fresh.commands[role]
    if (from !== to) commands.push({ role, from, to })
  }

  const presentIds = (f: ProjectFacts) =>
    new Set(f.artifacts.filter((a) => a.exists).map((a) => a.id))
  const oldArtifacts = presentIds(old)
  const freshArtifacts = presentIds(fresh)
  const labelOf = (id: string) =>
    fresh.artifacts.find((a) => a.id === id)?.label ??
    old.artifacts.find((a) => a.id === id)?.label ??
    id
  const artifactsAdded = [...freshArtifacts].filter((id) => !oldArtifacts.has(id)).map(labelOf)
  const artifactsRemoved = [...oldArtifacts].filter((id) => !freshArtifacts.has(id)).map(labelOf)

  const oldDirs = new Set(old.tree.dirs.map((d) => d.name))
  const freshDirs = new Set(fresh.tree.dirs.map((d) => d.name))
  const dirsAdded = [...freshDirs].filter((d) => !oldDirs.has(d))
  const dirsRemoved = [...oldDirs].filter((d) => !freshDirs.has(d))

  return { commands, artifactsAdded, artifactsRemoved, dirsAdded, dirsRemoved }
}

/** True when nothing on the baseline's measured axes changed. */
export function isDriftEmpty(d: BaselineDrift): boolean {
  return (
    d.commands.length === 0 &&
    d.artifactsAdded.length === 0 &&
    d.artifactsRemoved.length === 0 &&
    d.dirsAdded.length === 0 &&
    d.dirsRemoved.length === 0
  )
}
