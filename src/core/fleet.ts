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

/**
 * How exposed an entry's history is, or could plausibly become. A SAFETY PREDICATE, not a label:
 * it decides whether content screening applies, so absence must never read as the permissive
 * answer. `checkManifest` treats an undeclared non-corp entry as a finding — a repo published
 * without ever answering the question is exactly the case a default would hide.
 *
 *   `public-repo`   already public — outside-contribution surface.
 *   `public-bound`  private today, plausibly public later. Screened as hard as public, because
 *                   publishing exposes ALL history: the scrub must precede the first commit,
 *                   not the visibility flip.
 *   `private`       not destined to be published. An ANSWER, not the absence of one.
 *
 * Corp entries do not carry it — `profile: "corp"` implies the answer (machine-pinned, never
 * publishable), so requiring it there would be ceremony.
 */
export type FleetTrust = "public-repo" | "public-bound" | "private"

export const FLEET_TRUST_VALUES: readonly FleetTrust[] = ["public-repo", "public-bound", "private"]

export function isFleetTrust(value: unknown): value is FleetTrust {
  return typeof value === "string" && (FLEET_TRUST_VALUES as readonly string[]).includes(value)
}

/**
 * Fleet-wide orientation: the one entry every other entry is guided by.
 *
 * Declared ONCE at the manifest level rather than as a per-entry link, because the relationship
 * is constant — a per-entry field carries no information and can be forgotten, which is exactly
 * how three entries came to be silently unlinked. Hoisting it makes the orphan state
 * unrepresentable instead of merely detectable. A fleet with no orientation root simply omits
 * the block; etymd never assumes one exists.
 */
export interface FleetOrientation {
  /** Registered name of the orientation root. Only the root itself is exempt from being guided. */
  root: string
}

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
  /**
   * How exposed this entry is — see {@link FleetTrust}. `"public-repo"` marks an
   * outside-contribution surface (hygiene needles apply). Undeclared on a non-corp entry is a
   * `fleet check` finding, never a silent "private".
   */
  trust?: FleetTrust
  /** A declared `trust` value outside the vocabulary — preserved verbatim so the check can name it. */
  trustRaw?: string
  staleAfterDays?: number
  /**
   * How this entry's git hooks are governed. `"none"` declares that generated gates are
   * deliberately absent — a prose repo with nothing mechanically checkable, or one whose gate is
   * hand-written on purpose. Wall findings cannot be quieted through the ledger (004: their only
   * honest resolution is fixing them), which is right for leak and partition conditions but
   * wrong for a state a fleet legitimately chooses; without this, a settled decision is
   * re-reported on every sweep until the report is ignored.
   */
  gates?: string
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
  /** Fleet-wide orientation root, when the manifest declares one. Absent = this fleet has none. */
  orientation?: FleetOrientation
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
      // An unknown value is NOT coerced to a default: trust gates content screening, so a typo
      // must surface as "undeclared" (a finding) rather than quietly picking an answer.
      trust: isFleetTrust(rec.trust) ? rec.trust : undefined,
      gates: asString(rec.gates),
      trustRaw: asString(rec.trust),
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
    const orientationRec = asRecord(parsed.orientation)
    if (orientationRec) {
      const orientationRoot = asString(orientationRec.root)
      if (orientationRoot) manifest.orientation = { root: orientationRoot }
      else {
        manifest.problems.push({
          kind: "bad-shape",
          file: manifestFile,
          detail:
            "`orientation` declares no `root` name — the fleet's orientation cannot be resolved",
        })
      }
    } else if (parsed.orientation !== undefined) {
      manifest.problems.push({
        kind: "bad-shape",
        file: manifestFile,
        detail: '`orientation` must be an object (`{ "root": "<name>" }`) — ignored',
      })
    }
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
