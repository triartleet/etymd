import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import { DEFAULT_CONFIG, type StateBudgets } from "../core/config.js"
import { ETYMD_DIR } from "../core/facts.js"
import type { FleetEntry, FleetManifest } from "../core/fleet.js"
import { git, isDirectory, pathExists, readText } from "../core/util.js"
import type { Finding, FindingTier, LensKind } from "./finding.js"
import { readLedger } from "./ledger.js"
import { runAudit } from "./run.js"

const pExecFile = promisify(execFile)

// Fleet-scope findings — manifest truth, wall placement, coverage — have no single repo root,
// so they are constructed directly as Findings under one lens id. Deliberately NOT a Lens
// implementation: no second finding family has earned a FleetLens abstraction yet.
export const FLEET_LENS = "fleet-manifest"

/** The fleet `--json` schema marker — EXPERIMENTAL through 0.2.x, declared in the output. */
export const FLEET_JSON_SCHEMA = "fleet-experimental-0.2"

/** The wall artifacts a corp WORKTREE must not carry at its root (they live beside the manifest). */
const CORP_WALL_ARTIFACTS = ["PROJECT_CONTEXT.md", "DECISIONS.md"]

export interface FleetSweepOptions {
  /** Restrict to these registered names (unknown names throw — a typo must not skip silently). */
  only?: string[]
  profile?: "personal" | "corp"
  /** Truth lenses only per repo (the doctor subset). */
  kind?: LensKind
  /**
   * Persist per-repo ledgers — ONLY for personal-profile entries that already carry `.etymd`.
   * The sweep never creates `.etymd` anywhere, and corp worktrees are never written at all.
   */
  persistLedgers?: boolean
}

export interface FleetProjectSweep {
  name: string
  profile: "personal" | "corp"
  kind?: string
  resolvedRoot?: string
  /** Why this entry could not be audited — mirrored into `outOfScope`. */
  unresolved?: string
  staleAfterDays: number
  /** Days the newest state artifact trails the repo clock; null = nothing datable. */
  stateAgeDays: number | null
  counts: Record<FindingTier, number>
  /** Ranked, ledger-quieted findings from this repo's audit. */
  findings: Finding[]
  disclosures: string[]
}

export interface FleetSweepResult {
  schema: typeof FLEET_JSON_SCHEMA
  manifest: string
  sweptAt: string
  projects: FleetProjectSweep[]
  /** Fleet-scope wall findings (`fleet-manifest`) — not ledger-quietable in 0.2. */
  wall: Finding[]
  wallDisclosures: string[]
  /** Entry names that could not be audited — named here, never silently dropped. */
  outOfScope: string[]
  /** Manifest problems, verbatim — disclosed by every renderer, never defaulted away. */
  problems: string[]
}

function finding(
  id: string,
  tier: FindingTier,
  claim: string,
  evidence: string[],
  why: string,
  action?: string,
): Finding {
  return {
    id,
    lens: FLEET_LENS,
    tier,
    claim,
    evidence,
    why,
    ...(action ? { action } : {}),
    effort: "S",
    confidence: "high",
  }
}

/**
 * Where a corp entry's audit state persists: beside the manifest, never in the worktree.
 * Belt-and-braces to the loader's safe-name rule: a name that resolves anywhere but directly
 * under `<dir>/corp/` is refused — the manifest can lie, and a lie must never steer a write.
 */
export function corpPersistenceRoot(manifest: FleetManifest, name: string): string {
  const corpDir = path.join(manifest.dir, "corp")
  const root = path.resolve(corpDir, name)
  if (path.dirname(root) !== corpDir || root === corpDir) {
    throw new Error(
      `entry name ${JSON.stringify(name)} escapes the corp persistence zone — refusing to resolve a ledger root for it`,
    )
  }
  return root
}

export function stateBudgetsFor(entry: FleetEntry): Partial<StateBudgets> | undefined {
  const overlay: Partial<StateBudgets> = {}
  if (entry.staleAfterDays !== undefined) overlay.staleAfterDays = entry.staleAfterDays
  if (entry.stateBudget !== undefined) overlay.maxChars = entry.stateBudget
  return Object.keys(overlay).length ? overlay : undefined
}

/**
 * `git grep` over TRACKED files. `null` = the check could not run (not a repo, git absent) and
 * must be disclosed; `[]` = ran clean. Exit code 1 (no matches) is success, not failure — the
 * distinction `util.git()` cannot make, which is why this helper exists.
 */
async function gitGrepFiles(
  root: string,
  needle: string,
  mode: "fixed" | "regex" = "fixed",
): Promise<string[] | null> {
  try {
    const matchFlag = mode === "regex" ? "-E" : "-F"
    const { stdout } = await pExecFile("git", ["grep", "-I", "-l", matchFlag, "-e", needle], {
      cwd: root,
      timeout: 8000,
    })
    return stdout.split("\n").filter(Boolean)
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return []
    return null
  }
}

/**
 * A REAL machine path, not prose about the ban. Requires an actual username segment after
 * /Users/ that keeps going (a path separator, a closing quote, or end of line) — so the
 * rule text "`/Users/…` paths are banned" and a bare "/Users/" never fire, while
 * /Users/<anyone>/projects/x and a JSON-quoted "/Users/<anyone>" do.
 */
const MACHINE_PATH_RE = /\/Users\/[A-Za-z0-9._@-]{2,}([/"']|$)/m
const MACHINE_PATH_GREP = String.raw`/Users/[A-Za-z0-9._@-]{2,}(/|"|'|$)`

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** True when an email's domain is (a registrable suffix of) one of the corp hosts. */
export function emailMatchesCorpHosts(email: string, hosts: string[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase()
  if (!domain) return false
  return hosts.some((h) => {
    const host = h.toLowerCase()
    if (domain === host) return true
    // The email's domain may sit ONE label above the host (git.corp.example → corp.example) or
    // anywhere below it. Climbing further would match generic/public suffixes — a host on
    // git.corp.example.com must never flag every @example.com commit as a corp identity.
    if (
      domain.includes(".") &&
      host.endsWith(`.${domain}`) &&
      domain.split(".").length >= host.split(".").length - 1
    ) {
      return true
    }
    return domain.endsWith(`.${host}`)
  })
}

// ---------------------------------------------------------------------------------------------
// fleet check — manifest validation only, no lenses
// ---------------------------------------------------------------------------------------------

const PROBLEM_TIER: Record<string, FindingTier> = {
  "parse-error": "risk",
  "bad-shape": "risk",
  "local-missing": "gap",
}

/**
 * Validate the manifest pair itself: parse problems, dangling mappings (the live ghost-entry
 * class), duplicate names, privacy leaks, dead links, machine paths. Pure manifest truth —
 * no lenses run, no repo is audited, nothing is written.
 */
export async function checkManifest(
  manifest: FleetManifest,
): Promise<{ findings: Finding[]; disclosures: string[] }> {
  const findings: Finding[] = []
  const disclosures: string[] = []
  const manifestFile = path.basename(manifest.manifestPath)
  const localFile = path.basename(manifest.localPath)

  for (const p of manifest.problems) {
    findings.push(
      finding(
        `${FLEET_LENS}/${p.kind}:${p.file}`,
        PROBLEM_TIER[p.kind] ?? "gap",
        `${p.file}: ${p.detail}`,
        [p.file],
        "A manifest that cannot be read is a fleet whose claims cannot be verified — every consumer is flying blind.",
        "Fix the file; the manifest pair is the fleet's single source of truth.",
      ),
    )
  }

  const seen = new Set<string>()
  const flaggedDup = new Set<string>()
  for (const entry of manifest.entries) {
    if (seen.has(entry.name) && !flaggedDup.has(entry.name)) {
      flaggedDup.add(entry.name)
      findings.push(
        finding(
          `${FLEET_LENS}/duplicate-name:${entry.name}`,
          "gap",
          `\`${entry.name}\` is registered more than once`,
          [`${manifestFile}: ${entry.name} appears twice`],
          "Resolution is keyed by name — a duplicate makes every lookup, dismiss, and delta ambiguous.",
          "Rename one of the entries.",
        ),
      )
    }
    seen.add(entry.name)

    if (entry.private && entry.path) {
      findings.push(
        finding(
          `${FLEET_LENS}/private-path-leak:${entry.name}`,
          "risk",
          `private entry \`${entry.name}\` carries a \`path\` in the tracked manifest`,
          [`${manifestFile}: ${entry.name}.path = ${entry.path}`],
          "A private entry is an opaque alias by design — a tracked path ties the alias to a real directory for anyone who can read the manifest.",
          `Delete the path; map the alias in the gitignored ${localFile} instead.`,
        ),
      )
    }

    // Dangling resolution: a mapping that points at nothing is the manifest lying about the
    // fleet — the exact class a stale personal path or a renamed worktree produces.
    if (entry.resolvedRoot && !(await isDirectory(entry.resolvedRoot))) {
      const viaLocal = manifest.localDirs[entry.name] !== undefined
      findings.push(
        finding(
          `${FLEET_LENS}/${viaLocal ? "dangling-dir" : "dangling-path"}:${entry.name}`,
          "gap",
          `\`${entry.name}\` resolves to a directory that does not exist`,
          [`${viaLocal ? localFile : manifestFile}: ${entry.name} → ${entry.resolvedRoot}`],
          "A dangling mapping silently drops the project from every sweep — absent coverage that looks registered.",
          "Fix the mapping or retire the entry.",
        ),
      )
    }
    if (
      entry.unresolved &&
      manifest.localPresent &&
      manifest.machineProfile !== "personal" &&
      (entry.profile === "corp" || entry.private)
    ) {
      findings.push(
        finding(
          `${FLEET_LENS}/dangling-dir:${entry.name}`,
          "gap",
          `\`${entry.name}\` has no usable directory mapping`,
          [`${localFile}: ${entry.unresolved}`],
          "An unmapped corp entry silently drops out of every sweep on the machine that most needs it.",
          `Add a \`dirs\` mapping for \`${entry.name}\` in ${localFile}.`,
        ),
      )
    }
  }

  for (const entry of manifest.entries) {
    for (const [rel, target] of Object.entries(entry.links)) {
      if (!seen.has(target)) {
        findings.push(
          finding(
            `${FLEET_LENS}/dangling-link:${entry.name}:${target}`,
            "gap",
            `\`${entry.name}\` links \`${rel}\` → \`${target}\`, which is not a registered name`,
            [`${manifestFile}: ${entry.name}.links.${rel} = ${target}`],
            "Links are the metadata that keeps moves lossless — a dead target is a relationship claim nothing can follow.",
            "Point the link at a registered name or delete it.",
          ),
        )
      }
    }
  }

  // Orphaned local mappings: a dirs key for a name the registry no longer carries.
  for (const name of Object.keys(manifest.localDirs)) {
    if (manifest.shape === "registry" && !seen.has(name)) {
      findings.push(
        finding(
          `${FLEET_LENS}/orphan-dir:${name}`,
          "gap",
          `${localFile} maps \`${name}\`, which is not a registered name`,
          [`${localFile}: dirs.${name}`],
          "An orphaned mapping is a ghost entry — it looks covered and is swept by nothing.",
          "Register the entry or delete the mapping.",
        ),
      )
    }
  }

  // Machine identity in the tracked manifest: an absolute /Users/ path names the machine (and
  // usually the human) in a file built to be publishable.
  const rawManifest = await readText(manifest.manifestPath)
  if (rawManifest === null) {
    disclosures.push(`${manifestFile} could not be re-read for the machine-path check — skipped.`)
  } else if (MACHINE_PATH_RE.test(rawManifest)) {
    findings.push(
      finding(
        `${FLEET_LENS}/registry-machine-path:${manifestFile}`,
        "risk",
        `${manifestFile} contains an absolute /Users/ path`,
        [manifestFile],
        "The tracked manifest is publishable by construction — a home-directory path ships the machine's identity with it.",
        `Use \`~\` (expanded consumer-side) or a root-relative path; machine paths belong in ${localFile}.`,
      ),
    )
  }

  if (manifest.machineProfile === "personal") {
    const corpCount = manifest.entries.filter((e) => e.profile === "corp" || e.private).length
    if (corpCount) {
      disclosures.push(
        `machineProfile "personal": ${corpCount} corp entr${corpCount === 1 ? "y" : "ies"} deliberately absent on this machine — disclosed, not dangling.`,
      )
    }
  }

  return { findings, disclosures }
}

// ---------------------------------------------------------------------------------------------
// wall findings — fleet-scope checks with no single repo root
// ---------------------------------------------------------------------------------------------

async function checkCorpWallArtifacts(entries: FleetEntry[], findings: Finding[]): Promise<void> {
  for (const entry of entries) {
    if (entry.profile !== "corp" || !entry.resolvedRoot) continue
    for (const artifact of CORP_WALL_ARTIFACTS) {
      if (await pathExists(path.join(entry.resolvedRoot, artifact))) {
        findings.push(
          finding(
            `${FLEET_LENS}/corp-artifact-in-repo:${entry.name}:${artifact}`,
            "risk",
            `corp entry \`${entry.name}\` carries ${artifact} inside its worktree`,
            [`${entry.resolvedRoot}/${artifact}`],
            "Agent artifacts for corp repos live outside the repo by policy — an in-repo copy is one push away from colleagues' eyes and will diverge from the manifest-side truth.",
            `Move it to the fleet's corp/${entry.name}/ zone and leave a pointer if the harness needs one.`,
          ),
        )
      }
    }
  }
}

async function checkCoverage(
  manifest: FleetManifest,
  findings: Finding[],
  disclosures: string[],
): Promise<void> {
  if (!manifest.corpHosts.length) {
    disclosures.push(
      "Coverage check skipped — no corpHosts in the local manifest, so a corp remote cannot be recognized.",
    )
    return
  }
  if (!manifest.root || !(await isDirectory(manifest.root))) {
    disclosures.push("Coverage check skipped — the fleet root is undeclared or missing.")
    return
  }
  const registered = new Set<string>()
  for (const entry of manifest.entries) {
    if (entry.resolvedRoot) registered.add(await realpathOr(entry.resolvedRoot))
  }
  registered.add(await realpathOr(manifest.dir))

  const dirents = await fs.readdir(manifest.root, { withFileTypes: true })
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue
    const dir = path.join(manifest.root, d.name)
    if (registered.has(await realpathOr(dir))) continue
    if (!(await pathExists(path.join(dir, ".git")))) continue
    const remotes = await git(dir, ["config", "--get-regexp", "^remote\\..*\\.url"])
    if (!remotes) continue
    const corpRemote = manifest.corpHosts.find((h) => remotes.includes(h))
    if (corpRemote) {
      findings.push(
        finding(
          `${FLEET_LENS}/unregistered-corp-remote:${d.name}`,
          "risk",
          `\`${d.name}\` under the fleet root has a corp remote but is not registered`,
          [`${dir}: remote matches ${corpRemote}`],
          "The wall is only as good as its census — an unregistered employer checkout is corp material no sweep, wall check, or transfer plan knows exists.",
          "Register it as a corp entry (opaque alias + local dirs mapping) or move it out of the fleet root.",
        ),
      )
    }
  }
}

async function checkManifestRepoMachinePaths(
  manifest: FleetManifest,
  findings: Finding[],
  disclosures: string[],
): Promise<void> {
  const isRepo = (await git(manifest.dir, ["rev-parse", "--is-inside-work-tree"])) === "true"
  if (!isRepo) {
    disclosures.push(
      "Machine-path check skipped — the manifest directory is not inside a git repository.",
    )
    return
  }
  const files = await gitGrepFiles(manifest.dir, MACHINE_PATH_GREP, "regex")
  if (files === null) {
    disclosures.push(
      "Machine-path check could not run (`git grep` failed) — undetermined, not clean.",
    )
    return
  }
  for (const file of files) {
    findings.push(
      finding(
        `${FLEET_LENS}/machine-path:${file}`,
        "risk",
        `${file} (tracked in the manifest's repo) contains an absolute /Users/ path`,
        [file],
        "The manifest repo is the fleet's publishable surface — a tracked home-directory path ships the machine's identity in it.",
        "Replace with `~` or a relative path; machine paths belong only in gitignored local files.",
      ),
    )
  }
}

async function checkHygieneNeedles(
  manifest: FleetManifest,
  findings: Finding[],
  disclosures: string[],
): Promise<void> {
  const publicEntries = manifest.entries.filter((e) => e.trust === "public-repo" && e.resolvedRoot)
  if (!publicEntries.length) return
  if (!manifest.localPresent) {
    disclosures.push(
      "Hygiene-needle check skipped — the local manifest (needle source) is absent on this machine.",
    )
    return
  }
  const needles = [
    ...new Set(
      [
        ...Object.values(manifest.labels),
        ...Object.values(manifest.localDirs).map((d) => path.basename(expandNeedleDir(d))),
        ...manifest.corpHosts,
      ].filter((n) => n.length >= 3),
    ),
  ]
  if (!needles.length) {
    disclosures.push("Hygiene-needle check skipped — the local manifest carries no needles.")
    return
  }
  for (const entry of publicEntries) {
    const flagged = new Set<string>()
    for (const needle of needles) {
      const files = await gitGrepFiles(entry.resolvedRoot as string, needle)
      if (files === null) {
        disclosures.push(
          `Hygiene-needle check could not run in \`${entry.name}\` — undetermined, not clean.`,
        )
        break
      }
      for (const file of files) {
        if (flagged.has(file)) continue
        flagged.add(file)
        // The needle stays OUT of the id and claim — a dismissed finding's ledger entry lives
        // in the public repo, and must not itself become the leak. Evidence renders locally only.
        findings.push(
          finding(
            `${FLEET_LENS}/hygiene-needle:${entry.name}:${file}`,
            "risk",
            `${file} in public-repo \`${entry.name}\` carries a needle from the fleet's private local manifest`,
            [`${file}: contains "${needle}"`],
            "A public repo that names a private label, corp directory, or corp host joins the public and employer identities for anyone who greps.",
            "Scrub the needle from the tracked file (rewrite history if it already shipped).",
          ),
        )
      }
    }
  }
}

function expandNeedleDir(dir: string): string {
  // Basenames only — "~/projects/some-corp-dir" needles as "some-corp-dir".
  return dir.replace(/\/+$/, "")
}

async function checkCorpEmails(
  manifest: FleetManifest,
  findings: Finding[],
  disclosures: string[],
): Promise<void> {
  if (!manifest.corpHosts.length) {
    disclosures.push(
      "Corp-email check skipped — no corpHosts in the local manifest, so a corp domain cannot be recognized.",
    )
    return
  }
  for (const entry of manifest.entries) {
    if (entry.profile !== "personal" || !entry.resolvedRoot) continue
    const emails = await git(entry.resolvedRoot, ["log", "-30", "--format=%ae"])
    if (emails === null) {
      // Not a repo / no commits / git absent — this check did not run. The per-repo audit only
      // discloses git absence when dated artifacts exist, so the wall must say so itself.
      disclosures.push(
        `Corp-email check could not run in \`${entry.name}\` (no readable commit history) — undetermined, not clean.`,
      )
      continue
    }
    const lines = emails.split("\n").filter(Boolean)
    const matched = [...new Set(lines.filter((e) => emailMatchesCorpHosts(e, manifest.corpHosts)))]
    if (matched.length) {
      const count = lines.filter((e) => matched.includes(e)).length
      findings.push(
        finding(
          `${FLEET_LENS}/corp-email:${entry.name}`,
          "risk",
          `recent commits on personal entry \`${entry.name}\` are authored with a corp-host email`,
          [`${count} of the last ${lines.length} commits: ${matched.join(", ")}`],
          "A corp email in a personal repo's history ties the two identities together permanently — and silently, since the machine's global git identity is usually the corp one.",
          "Set the repo-local identity to the personal one and amend the unpushed commits.",
        ),
      )
    }
  }
}

/** All fleet-scope wall checks. Each check that cannot run says so — undetermined, not clean. */
export async function collectWallFindings(
  manifest: FleetManifest,
): Promise<{ findings: Finding[]; disclosures: string[] }> {
  const findings: Finding[] = []
  const disclosures: string[] = []
  await checkCorpWallArtifacts(manifest.entries, findings)
  await checkCoverage(manifest, findings, disclosures)
  await checkManifestRepoMachinePaths(manifest, findings, disclosures)
  await checkHygieneNeedles(manifest, findings, disclosures)
  await checkCorpEmails(manifest, findings, disclosures)
  return { findings, disclosures }
}

// ---------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------

function stateAgeDays(facts: import("../core/types.js").ProjectFacts): number | null {
  const freshness = facts.freshness
  if (!freshness?.repoLastCommit) return null
  const stateIds = new Set(
    facts.artifacts.filter((a) => a.kind === "state" && a.exists).map((a) => a.id),
  )
  const dated = freshness.artifacts.filter((f) => stateIds.has(f.artifactId))
  if (!dated.length) return null
  const repoAt = Date.parse(freshness.repoLastCommit)
  return Math.max(
    0,
    ...dated.map((f) =>
      // A dirty artifact is treated fresh-now (the refresh is on disk, uncommitted) — the row
      // must agree with the lens, which discloses instead of flagging it.
      f.commitsSince && !f.dirty ? Math.floor((repoAt - Date.parse(f.lastCommit)) / 86_400_000) : 0,
    ),
  )
}

async function sweepEntry(
  manifest: FleetManifest,
  entry: FleetEntry,
  opts: FleetSweepOptions,
): Promise<FleetProjectSweep> {
  const project: FleetProjectSweep = {
    name: entry.name,
    profile: entry.profile,
    kind: entry.kind,
    resolvedRoot: entry.resolvedRoot,
    unresolved: entry.unresolved,
    staleAfterDays: entry.staleAfterDays ?? DEFAULT_CONFIG.state.staleAfterDays,
    stateAgeDays: null,
    counts: { risk: 0, gap: 0, polish: 0 },
    findings: [],
    disclosures: [],
  }
  const root = entry.resolvedRoot
  if (!root) {
    project.disclosures.push(`not audited: ${entry.unresolved ?? "unresolved"}`)
    return project
  }
  if (!(await isDirectory(root))) {
    project.unresolved = `resolved directory does not exist: ${root}`
    project.disclosures.push(`not audited: ${project.unresolved} — \`etymd fleet check\` names it`)
    return project
  }

  let upstreamRemote: string | undefined
  if (entry.upstream) {
    const url = await git(root, ["remote", "get-url", entry.upstream])
    // A remote that is configured but never fetched has zero refs/remotes/<name>/* refs, so
    // `--not --remotes=<name>` excludes nothing — the full clock silently applies. Verify refs
    // exist, or the fork-clock disclosure would be a lie about the clock actually used.
    const refs =
      url !== null
        ? await git(root, ["for-each-ref", "--count=1", `refs/remotes/${entry.upstream}`])
        : null
    if (url !== null && refs) {
      upstreamRemote = entry.upstream
      project.disclosures.push(
        `freshness measured on fork-authored commits only (\`--not --remotes=${entry.upstream}\`)`,
      )
    } else if (url !== null) {
      project.disclosures.push(
        `upstream remote \`${entry.upstream}\` has no fetched refs — freshness measured on all commits`,
      )
    } else {
      project.disclosures.push(
        `upstream remote \`${entry.upstream}\` not found — freshness measured on all commits`,
      )
    }
  }

  const corp = entry.profile === "corp"
  // Persistence rules, pinned by test: a corp WORKTREE is never written under any flag — its
  // ledger lives at the manifest's corp/<name>/. A personal repo persists only when it already
  // opted in (.etymd exists) AND --persist-ledgers was passed; the sweep never creates .etymd.
  const optedIn = !corp && (await pathExists(path.join(root, ETYMD_DIR)))
  const result = await runAudit(root, {
    kind: opts.kind,
    persistLedger: !corp && opts.persistLedgers === true && optedIn,
    readOnlyRoot: corp,
    ledgerRoot: corp ? corpPersistenceRoot(manifest, entry.name) : undefined,
    stateBudgets: stateBudgetsFor(entry),
    upstreamRemote,
  })

  project.findings = result.findings
  for (const f of result.findings) project.counts[f.tier] += 1
  project.stateAgeDays = stateAgeDays(result.facts)
  // The row's denominator must be the threshold the audit ACTUALLY applied — repo config plus
  // the registry overlay — or the summary contradicts the findings it summarizes.
  project.staleAfterDays = result.config.config.state.staleAfterDays

  for (const [key, value] of Object.entries(entry.contract)) {
    if (key === "placement" || !value) continue
    const exists = await pathExists(path.join(root, value.replace(/#.*$/, "")))
    project.disclosures.push(
      `contract override \`${key}: ${value}\` — registered, existence-checked only (${exists ? "present" : "MISSING"})`,
    )
  }
  if (entry.contract.placement === "none") {
    project.disclosures.push("contract placement \`none\` — legitimately absent, by declaration")
  }
  return project
}

/**
 * The fleet sweep: one read-only audit per resolved entry + the fleet-scope wall checks.
 * Invariants (each pinned by test): never creates `.etymd` anywhere; never writes into a corp
 * worktree regardless of flags or a stray `.etymd` there; unresolvable entries land in
 * `outOfScope` with a disclosure, never a silent skip.
 */
export async function sweepFleet(
  manifest: FleetManifest,
  opts: FleetSweepOptions = {},
): Promise<FleetSweepResult> {
  let entries = manifest.entries
  if (opts.only?.length) {
    const known = new Set(entries.map((e) => e.name))
    const unknown = opts.only.filter((n) => !known.has(n))
    if (unknown.length) {
      throw new Error(
        `--only names not in the manifest: ${unknown.join(", ")} — run \`etymd fleet check\``,
      )
    }
    const wanted = new Set(opts.only)
    entries = entries.filter((e) => wanted.has(e.name))
  }
  if (opts.profile) entries = entries.filter((e) => e.profile === opts.profile)

  const projects: FleetProjectSweep[] = []
  for (const entry of entries) {
    projects.push(await sweepEntry(manifest, entry, opts))
  }

  const wall = await collectWallFindings(manifest)
  // Corp findings are ledger-dismissible at the corp persistence root; the sweep must honor
  // those resolutions even though it never persists (visibleFindings inside runAudit already
  // filtered per entry via ledgerRoot). Wall findings are deliberately not quietable in 0.2 —
  // they name leak/partition conditions whose only honest resolution is fixing them.

  return {
    schema: FLEET_JSON_SCHEMA,
    manifest: manifest.manifestPath,
    sweptAt: new Date().toISOString(),
    projects,
    wall: wall.findings,
    wallDisclosures: wall.disclosures,
    outOfScope: projects.filter((p) => !p.resolvedRoot || p.unresolved).map((p) => p.name),
    problems: manifest.problems.map((p) => `${p.file}: ${p.detail}`),
  }
}

// ---------------------------------------------------------------------------------------------
// fleet dismiss / accept
// ---------------------------------------------------------------------------------------------

/**
 * Resolve where a named entry's findings persist, honoring the wall: personal entries own
 * their repo's `.etymd`; corp entries persist beside the manifest under `corp/<name>/`,
 * and their worktree is never touched.
 */
export async function fleetLedgerTarget(
  manifest: FleetManifest,
  name: string,
): Promise<{ entry: FleetEntry; auditRoot: string; ledgerRoot: string; corp: boolean }> {
  const entry = manifest.entries.find((e) => e.name === name)
  if (!entry) {
    throw new Error(
      `no entry \`${name}\` in ${path.basename(manifest.manifestPath)} — registered names: ${manifest.entries
        .map((e) => e.name)
        .join(", ")}`,
    )
  }
  if (!entry.resolvedRoot) {
    throw new Error(`\`${name}\` does not resolve on this machine: ${entry.unresolved}`)
  }
  const corp = entry.profile === "corp"
  return {
    entry,
    auditRoot: entry.resolvedRoot,
    ledgerRoot: corp ? corpPersistenceRoot(manifest, name) : entry.resolvedRoot,
    corp,
  }
}

/**
 * Make sure `id` is recorded in the entry's ledger, running one persisting single-repo audit
 * when it is not (corp: audit read-only, ledger persisted beside the manifest). Returns false when the
 * id is still unknown after the audit.
 */
export async function ensureFindingRecorded(
  manifest: FleetManifest,
  name: string,
  id: string,
): Promise<{ ledgerRoot: string; recorded: boolean }> {
  const target = await fleetLedgerTarget(manifest, name)
  const has = async () => (await readLedger(target.ledgerRoot)).entries.some((e) => e.id === id)
  if (await has()) return { ledgerRoot: target.ledgerRoot, recorded: true }

  await runAudit(target.auditRoot, {
    persistLedger: true,
    readOnlyRoot: target.corp,
    ledgerRoot: target.corp ? target.ledgerRoot : undefined,
    stateBudgets: stateBudgetsFor(target.entry),
  })
  return { ledgerRoot: target.ledgerRoot, recorded: await has() }
}
