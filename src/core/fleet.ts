import os from "node:os"
import path from "node:path"

import { readText } from "./util.js"

// The fleet manifest loader — promoted from the corpus test harness's sources.json pattern.
// It parses BOTH manifest shapes through one resolved model:
//
//   (a) the fleet registry:  registry.json  (tracked)  + registry.local.json (gitignored)
//   (b) the legacy corpus:   sources.json   (tracked)  + sources.local.json  (gitignored)
//
// The tracked file carries CLAIMS (names, kinds, profiles, contract overrides); the gitignored
// sibling carries this MACHINE's facts (real directories, labels, corp host patterns). Private
// entries are opaque names in the tracked file — their directories exist only in the local file,
// so the tracked manifest is publishable by construction. Resolution failures are recorded on
// the entry (`unresolved`) or in `problems`, NEVER silently skipped: a fleet manifest is itself
// an agent-context file, and a mapping that quietly resolves to nothing is exactly the lie the
// tool exists to catch.

export type FleetProfile = "personal" | "corp"

export interface FleetContract {
  state?: string
  decisions?: string
  goals?: string
  /** `"none"` = the contract file is legitimately absent (a declared state, not a gap). */
  placement?: string
}

export interface FleetEntry {
  name: string
  kind?: string
  profile: FleetProfile
  private: boolean
  /** Root-relative path as DECLARED in the tracked manifest (personal entries only). */
  path?: string
  /** Remote name of the upstream this repo forks — freshness measures fork-authored commits. */
  upstream?: string
  /** `"public-repo"` marks an outside-contribution surface (hygiene needles apply). */
  trust?: string
  staleAfterDays?: number
  /** Per-entry state char-budget override (ships unset — the schema slot exists). */
  stateBudget?: number
  contract: FleetContract
  links: Record<string, string>
  /** Absolute directory on THIS machine, when the manifest pair resolves one. */
  resolvedRoot?: string
  /** Why `resolvedRoot` is absent — always disclosed, never a silent skip. */
  unresolved?: string
}

export interface ManifestProblem {
  kind: "parse-error" | "bad-shape" | "local-missing"
  /** The file the problem lives in (manifest-relative basename). */
  file: string
  detail: string
}

export interface FleetManifest {
  shape: "registry" | "corpus"
  /** Absolute path of the tracked manifest file. */
  manifestPath: string
  /** Its directory — corp persistence roots and the sweep delta file live beside it. */
  dir: string
  /** Resolved absolute fleet root (registry shape), when declared. */
  root?: string
  machineProfile?: FleetProfile
  corpHosts: string[]
  labels: Record<string, string>
  localDirs: Record<string, string>
  /** Absolute path where the gitignored local sibling is expected. */
  localPath: string
  localPresent: boolean
  entries: FleetEntry[]
  /** Structural problems — disclosed by every consumer, never defaulted away. */
  problems: ManifestProblem[]
}

/** `~`-expansion is the CONSUMER's job — the tracked manifest never records a machine home. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

const REBUILD_RECIPE =
  'rebuild it beside the manifest: {"machineProfile":"corp","dirs":{"<name>":"~/path/to/worktree"}}'

/**
 * A name must be ONE path-safe segment: names build finding ids (`fleet-manifest/<class>:<name>`)
 * and filesystem paths (`corp/<name>/.etymd/`, corpus sibling resolution). A `../` name would
 * steer a ledger write outside the corp zone — the manifest can lie, and a lie must never steer
 * a write. No separators, no leading dot, no whitespace, no `:` (the id delimiter).
 */
const SAFE_NAME = /^[^\s/\\:.][^\s/\\:]*$/

function rejectUnsafeName(
  name: string,
  where: string,
  manifest: FleetManifest,
  manifestFile: string,
): boolean {
  if (SAFE_NAME.test(name)) return false
  manifest.problems.push({
    kind: "bad-shape",
    file: manifestFile,
    detail: `${where} name ${JSON.stringify(name)} is not a single path-safe segment — entry skipped (names build finding ids and corp/<name>/ persistence paths)`,
  })
  return true
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asStringMap(value: unknown): Record<string, string> {
  const rec = asRecord(value)
  if (!rec) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) if (typeof v === "string") out[k] = v
  return out
}

async function readLocal(
  localPath: string,
  problems: ManifestProblem[],
): Promise<{ present: boolean; data: Record<string, unknown> }> {
  const raw = await readText(localPath)
  if (raw === null) return { present: false, data: {} }
  try {
    const parsed = asRecord(JSON.parse(raw))
    if (!parsed) {
      problems.push({
        kind: "parse-error",
        file: path.basename(localPath),
        detail: "must contain a JSON object — local mappings unusable",
      })
      return { present: true, data: {} }
    }
    return { present: true, data: parsed }
  } catch (err) {
    problems.push({
      kind: "parse-error",
      file: path.basename(localPath),
      detail: `not valid JSON (${err instanceof Error ? err.message : String(err)}) — local mappings unusable`,
    })
    return { present: true, data: {} }
  }
}

function loadRegistryEntries(
  projects: unknown[],
  manifest: FleetManifest,
  manifestFile: string,
): void {
  const corpNames: string[] = []
  for (const [i, rawEntry] of projects.entries()) {
    const rec = asRecord(rawEntry)
    const name = rec ? asString(rec.name) : undefined
    if (!rec || !name) {
      manifest.problems.push({
        kind: "bad-shape",
        file: manifestFile,
        detail: `projects[${i}] has no usable name — the entry cannot be resolved or audited`,
      })
      continue
    }
    if (rejectUnsafeName(name, `projects[${i}]`, manifest, manifestFile)) continue
    const profile: FleetProfile = rec.profile === "corp" ? "corp" : "personal"
    if (rec.profile !== undefined && rec.profile !== "corp" && rec.profile !== "personal") {
      manifest.problems.push({
        kind: "bad-shape",
        file: manifestFile,
        detail: `\`${name}\` declares unknown profile \`${String(rec.profile)}\` — read as personal`,
      })
    }
    // Contract values are used as relative paths by consumers — a non-string value must be
    // dropped AS A PROBLEM, never carried as a live grenade for the sweep to step on.
    const contract: FleetContract = {}
    const contractRec = asRecord(rec.contract)
    if (contractRec) {
      for (const [k, v] of Object.entries(contractRec)) {
        if (typeof v === "string") (contract as Record<string, string>)[k] = v
        else {
          manifest.problems.push({
            kind: "bad-shape",
            file: manifestFile,
            detail: `\`${name}\`.contract.${k} is not a string — ignored`,
          })
        }
      }
    }
    const entry: FleetEntry = {
      name,
      kind: asString(rec.kind),
      profile,
      private: rec.private === true,
      path: asString(rec.path),
      upstream: asString(rec.upstream),
      trust: asString(rec.trust),
      staleAfterDays: typeof rec.staleAfterDays === "number" ? rec.staleAfterDays : undefined,
      stateBudget: typeof rec.stateBudget === "number" ? rec.stateBudget : undefined,
      contract,
      links: asStringMap(rec.links),
    }

    if (entry.profile === "corp" || entry.private) {
      // Real corp directories live ONLY in the gitignored local file — a tracked path on a
      // private entry is a leak (`fleet check` flags it) and is never trusted for resolution.
      corpNames.push(name)
      if (!manifest.localPresent) {
        entry.unresolved = `registry.local.json is absent — ${REBUILD_RECIPE}`
      } else if (manifest.machineProfile === "personal") {
        entry.unresolved =
          'corp entries do not resolve under machineProfile "personal" — absent on this machine by design'
      } else {
        const dir = manifest.localDirs[name]
        if (!dir) {
          entry.unresolved = `no \`dirs\` mapping for \`${name}\` in ${path.basename(manifest.localPath)}`
        } else {
          entry.resolvedRoot = path.resolve(manifest.dir, expandTilde(dir))
        }
      }
    } else if (entry.path) {
      entry.resolvedRoot = path.resolve(manifest.root ?? manifest.dir, expandTilde(entry.path))
    } else {
      entry.unresolved = "personal entry declares no `path` — nothing to resolve"
    }
    manifest.entries.push(entry)
  }

  if (corpNames.length && !manifest.localPresent) {
    manifest.problems.push({
      kind: "local-missing",
      file: path.basename(manifest.localPath),
      detail: `${corpNames.length} corp/private entr${corpNames.length === 1 ? "y" : "ies"} (${corpNames.join(", ")}) cannot resolve without it — ${REBUILD_RECIPE}`,
    })
  }
}

function loadCorpusEntries(
  sources: unknown[],
  manifest: FleetManifest,
  manifestFile: string,
): void {
  for (const [i, rawEntry] of sources.entries()) {
    const rec = asRecord(rawEntry)
    const name = rec ? asString(rec.name) : undefined
    if (!rec || !name) {
      manifest.problems.push({
        kind: "bad-shape",
        file: manifestFile,
        detail: `sources[${i}] has no usable name — the entry cannot be resolved`,
      })
      continue
    }
    if (rejectUnsafeName(name, `sources[${i}]`, manifest, manifestFile)) continue
    const entry: FleetEntry = {
      name,
      kind: asString(rec.shape),
      profile: "personal",
      private: rec.private === true,
      path: asString(rec.path),
      contract: {},
      links: {},
    }
    // Exactly the historical corpus resolution: the local dir wins, then the declared path,
    // then a same-named sibling of the manifest's parent (whose absence simply skips a smoke).
    const localDir = manifest.localDirs[name]
    if (localDir) {
      entry.resolvedRoot = path.resolve(manifest.dir, "..", expandTilde(localDir))
    } else if (entry.path) {
      entry.resolvedRoot = path.resolve(manifest.dir, expandTilde(entry.path))
    } else {
      entry.resolvedRoot = path.resolve(manifest.dir, "..", name)
    }
    manifest.entries.push(entry)
  }
}

/**
 * Load and resolve a fleet manifest (either shape) against this machine. Never throws on
 * content problems — they land in `problems` / per-entry `unresolved` so every consumer can
 * disclose them. Throws only when the manifest file itself cannot be read at all.
 */
export async function loadFleetManifest(manifestPath: string): Promise<FleetManifest> {
  const abs = path.resolve(manifestPath)
  const dir = path.dirname(abs)
  const manifestFile = path.basename(abs)
  const raw = await readText(abs)
  if (raw === null) {
    throw new Error(`cannot read fleet manifest \`${abs}\``)
  }

  const manifest: FleetManifest = {
    shape: "registry",
    manifestPath: abs,
    dir,
    corpHosts: [],
    labels: {},
    localDirs: {},
    localPath: path.join(dir, "registry.local.json"),
    localPresent: false,
    entries: [],
    problems: [],
  }

  let parsed: Record<string, unknown> | null = null
  try {
    parsed = asRecord(JSON.parse(raw))
    if (!parsed) {
      manifest.problems.push({
        kind: "parse-error",
        file: manifestFile,
        detail: "must contain a JSON object — no entries loaded",
      })
      return manifest
    }
  } catch (err) {
    manifest.problems.push({
      kind: "parse-error",
      file: manifestFile,
      detail: `not valid JSON (${err instanceof Error ? err.message : String(err)}) — no entries loaded`,
    })
    return manifest
  }

  if (Array.isArray(parsed.projects)) {
    manifest.shape = "registry"
    const local = await readLocal(manifest.localPath, manifest.problems)
    manifest.localPresent = local.present
    manifest.localDirs = asStringMap(local.data.dirs)
    manifest.labels = asStringMap(local.data.labels)
    manifest.corpHosts = Array.isArray(local.data.corpHosts)
      ? local.data.corpHosts.filter((h): h is string => typeof h === "string")
      : []
    manifest.machineProfile =
      local.data.machineProfile === "corp" || local.data.machineProfile === "personal"
        ? local.data.machineProfile
        : undefined
    const rootRaw = asString(local.data.root) ?? asString(parsed.root)
    if (rootRaw) manifest.root = path.resolve(dir, expandTilde(rootRaw))
    loadRegistryEntries(parsed.projects, manifest, manifestFile)
  } else if (Array.isArray(parsed.sources)) {
    manifest.shape = "corpus"
    manifest.localPath = path.join(dir, "sources.local.json")
    const local = await readLocal(manifest.localPath, manifest.problems)
    manifest.localPresent = local.present
    manifest.localDirs = asStringMap(local.data.dirs)
    loadCorpusEntries(parsed.sources, manifest, manifestFile)
  } else {
    manifest.problems.push({
      kind: "bad-shape",
      file: manifestFile,
      detail: "neither a `projects` (registry) nor a `sources` (corpus) array — no entries loaded",
    })
  }

  return manifest
}
