import { promises as fs } from "node:fs"
import path from "node:path"

import { cancel, confirm, isCancel, select, text } from "@clack/prompts"

import {
  FLEET_TRUST_VALUES,
  isFleetTrust,
  loadFleetManifest,
  type FleetManifest,
} from "../core/fleet.js"
import { scanProject } from "../core/scan.js"
import { git, pathExists, readText } from "../core/util.js"
import { meetsFailOn, parseFailOnTier, type Finding, type FindingTier } from "../engine/finding.js"
import {
  checkManifest,
  ensureFindingRecorded,
  fleetLedgerTarget,
  sweepFleet,
  FLEET_JSON_SCHEMA,
  type FleetSweepResult,
} from "../engine/fleet.js"
import {
  print,
  renderFindings,
  renderFleetNotes,
  renderFleetRows,
  section,
  TIER_BADGE,
  type FleetRowView,
} from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"
import { accept as ledgerAccept, dismiss as ledgerDismiss } from "./ledger.js"

/** The previous sweep, stored beside the manifest for deltas. Local-only — gitignore it. */
const LAST_SWEEP_FILE = "last.fleet.json"

interface LastSweepRecord {
  schema: string
  sweptAt: string
  /** Per project: the visible finding ids of the last sweep — ids and tiers only, no content. */
  projects: Record<string, { id: string; tier: FindingTier }[]>
  wall: { id: string; tier: FindingTier }[]
}

interface LoadedManifest {
  manifest: FleetManifest
  /** Set when the manifest was picked up from the cwd — a targeting fact worth disclosing. */
  autoNote?: string
}

async function loadManifest(cwd: string, manifestOpt?: string): Promise<LoadedManifest> {
  if (manifestOpt) {
    return { manifest: await loadFleetManifest(path.resolve(cwd, manifestOpt)) }
  }
  const candidate = path.join(cwd, "registry.json")
  if (await pathExists(candidate)) {
    // The cwd fallback is a documented convenience, but WHICH manifest got picked is a
    // targeting fact — disclosed, so a stray registry.json can never be aimed at silently.
    return {
      manifest: await loadFleetManifest(candidate),
      autoNote: `manifest auto-selected from the cwd: ${candidate} (no --manifest given)`,
    }
  }
  throw new Error(
    "no --manifest given and no registry.json in the current directory — pass --manifest <file> (there is deliberately no env var and no global pointer)",
  )
}

/**
 * Read the delta baseline. Absent is a legitimate first sweep; PRESENT but unreadable or
 * foreign-schema is disclosed and reset — never a silent crash, never a silent "first sweep".
 */
async function readLastSweep(
  lastPath: string,
): Promise<{ record: LastSweepRecord | null; note?: string }> {
  const raw = await readText(lastPath)
  if (raw === null) return { record: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      record: null,
      note: `${LAST_SWEEP_FILE} exists but is not valid JSON — delta baseline reset (every finding reads as new this sweep).`,
    }
  }
  const rec = parsed as Partial<LastSweepRecord> | null
  if (
    typeof rec !== "object" ||
    rec === null ||
    rec.schema !== FLEET_JSON_SCHEMA ||
    typeof rec.projects !== "object" ||
    rec.projects === null ||
    Array.isArray(rec.projects) ||
    !Array.isArray(rec.wall)
  ) {
    return {
      record: null,
      note: `${LAST_SWEEP_FILE} carries a foreign schema — delta baseline reset (every finding reads as new this sweep).`,
    }
  }
  return { record: rec as LastSweepRecord }
}

function failOnExit(failOn: string | undefined, findings: Finding[]): void {
  if (failOn === undefined) return
  if (meetsFailOn(findings, parseFailOnTier(failOn))) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------
// etymd fleet — the sweep
// ---------------------------------------------------------------------------------------------

export interface FleetSweepCmdOptions {
  cwd: string
  manifest?: string
  only?: string[]
  profile?: string
  truth?: boolean
  persistLedgers?: boolean
  json?: boolean
  failOn?: string
}

export async function sweep(opts: FleetSweepCmdOptions): Promise<void> {
  if (opts.profile && opts.profile !== "personal" && opts.profile !== "corp") {
    throw new Error(`--profile must be personal or corp, got \`${opts.profile}\``)
  }
  // Validate the gate tier BEFORE the sweep runs — a typo must never report success.
  if (opts.failOn !== undefined) parseFailOnTier(opts.failOn)
  const { manifest, autoNote } = await loadManifest(opts.cwd, opts.manifest)
  const result = await sweepFleet(manifest, {
    only: opts.only,
    profile: opts.profile as "personal" | "corp" | undefined,
    kind: opts.truth ? "truth" : undefined,
    persistLedgers: opts.persistLedgers,
  })

  const lastPath = path.join(manifest.dir, LAST_SWEEP_FILE)
  const { record: previous, note: baselineNote } = await readLastSweep(lastPath)
  const previousIds = (name: string) => new Set((previous?.projects[name] ?? []).map((e) => e.id))
  const previousWallIds = new Set((previous?.wall ?? []).map((e) => e.id))

  const allFindings = [...result.projects.flatMap((p) => p.findings), ...result.wall]
  failOnExit(opts.failOn, allFindings)

  // A filtered sweep must not move the delta baseline — the next full sweep would misreport
  // everything it skipped as new/resolved (the ledger's partial-run rule, applied to deltas).
  const fullSweep = !opts.only && !opts.profile && !opts.truth

  const delta: Record<string, { new: string[]; resolved: string[] }> = {}
  for (const p of result.projects) {
    const prev = previousIds(p.name)
    const current = new Set(p.findings.map((f) => f.id))
    delta[p.name] = {
      new: [...current].filter((id) => !prev.has(id)),
      resolved: [...prev].filter((id) => !current.has(id)),
    }
  }
  const wallNew = result.wall.filter((f) => !previousWallIds.has(f.id)).map((f) => f.id)

  if (opts.json) {
    print(
      JSON.stringify(
        {
          ...result,
          delta: previous ? delta : null,
          ...(baselineNote ? { deltaBaselineNote: baselineNote } : {}),
        },
        null,
        2,
      ),
    )
  } else {
    if (autoNote) print(`  ${theme.dim(`◦ ${autoNote}`)}`)
    if (baselineNote) print(`  ${theme.dim(`◦ ${baselineNote}`)}`)
    renderSweep(result, previous, delta, wallNew)
  }

  if (fullSweep) {
    const record: LastSweepRecord = {
      schema: FLEET_JSON_SCHEMA,
      sweptAt: result.sweptAt,
      projects: Object.fromEntries(
        result.projects.map((p) => [p.name, p.findings.map((f) => ({ id: f.id, tier: f.tier }))]),
      ),
      wall: result.wall.map((f) => ({ id: f.id, tier: f.tier })),
    }
    // Write-then-rename: a crash mid-write must leave the old baseline intact, never a
    // truncated file that silently reads as "first sweep" next time.
    const tmpPath = `${lastPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8")
    await fs.rename(tmpPath, lastPath)
  } else if (!opts.json) {
    print()
    print(`  ${theme.dim("partial sweep — the delta baseline was not updated")}`)
  }
}

function renderSweep(
  result: FleetSweepResult,
  previous: LastSweepRecord | null,
  delta: Record<string, { new: string[]; resolved: string[] }>,
  wallNew: string[],
): void {
  section(
    `Fleet sweep ${theme.dim(`· ${path.basename(result.manifest)} · ${result.projects.length} project(s) · schema ${result.schema}`)}`,
  )
  const rows: FleetRowView[] = result.projects.map((p) => {
    const d = delta[p.name] ?? { new: [], resolved: [] }
    const deltaStr = !previous
      ? "first sweep"
      : d.new.length || d.resolved.length
        ? `Δ ${[d.new.length ? `+${d.new.length}` : "", d.resolved.length ? `−${d.resolved.length}` : ""].filter(Boolean).join(" ")}`
        : "Δ ±0"
    return {
      name: p.name,
      age: p.stateAgeDays === null ? "—" : `${p.stateAgeDays}/${p.staleAfterDays}d`,
      counts: p.counts,
      delta: deltaStr,
      note: p.unresolved,
    }
  })
  renderFleetRows(rows)
  renderFleetNotes(
    result.problems,
    result.projects.flatMap((p) => p.disclosures.map((d) => `${p.name}: ${d}`)),
  )

  // Detail blocks only for what needs eyes: new findings and risk-tier ones.
  const detail = [
    ...result.projects.flatMap((p) =>
      p.findings.filter((f) => f.tier === "risk" || (delta[p.name]?.new ?? []).includes(f.id)),
    ),
    ...result.wall.filter((f) => f.tier === "risk" || wallNew.includes(f.id)),
  ]
  if (detail.length) {
    section(`New or risk findings ${theme.dim(`(${detail.length})`)}`)
    renderFindings(detail)
  }

  // The class-fix view: a class open in ≥2 repos is a fleet-level lesson no per-repo
  // session can see — this section is the machine asking "repo bug or fleet bug?" so
  // nobody has to remember to.
  if (result.recurringClasses.length) {
    section(`Recurring classes ${theme.dim("(open in ≥2 projects — class-fix candidates)")}`)
    for (const rc of result.recurringClasses) {
      print(
        `  ${TIER_BADGE[rc.tier]} ${rc.classId} ${theme.dim(`— ${rc.projects.length}×: ${rc.projects.join(", ")}`)}`,
      )
    }
  }

  section("Fleet wall")
  if (!result.wall.length) print(`  ${glyph.ok} ${theme.dim("clean")}`)
  else
    print(
      `  ${theme.warn(`${result.wall.length} finding(s)`)} ${theme.dim("(detailed above if new or risk)")}`,
    )
  renderFleetNotes([], result.wallDisclosures)
  if (result.outOfScope.length) {
    print(
      `  ${theme.dim(`out of scope (not audited, named above): ${result.outOfScope.join(", ")}`)}`,
    )
  }
}

// ---------------------------------------------------------------------------------------------
// etymd fleet check — manifest validation only
// ---------------------------------------------------------------------------------------------

export interface FleetCheckCmdOptions {
  cwd: string
  manifest?: string
  json?: boolean
}

export async function check(opts: FleetCheckCmdOptions): Promise<void> {
  const { manifest, autoNote } = await loadManifest(opts.cwd, opts.manifest)
  const { findings, disclosures } = await checkManifest(manifest)
  if (findings.length) process.exitCode = 1

  if (opts.json) {
    print(
      JSON.stringify(
        { schema: FLEET_JSON_SCHEMA, manifest: manifest.manifestPath, findings, disclosures },
        null,
        2,
      ),
    )
    return
  }
  if (autoNote) print(`  ${theme.dim(`◦ ${autoNote}`)}`)
  section(
    `Fleet check ${theme.dim(`· ${path.basename(manifest.manifestPath)} · ${manifest.entries.length} entr${manifest.entries.length === 1 ? "y" : "ies"} · manifest truth only, no lenses`)}`,
  )
  renderFindings(findings)
  renderFleetNotes([], disclosures)
}

// ---------------------------------------------------------------------------------------------
// etymd fleet add — the registration gate
// ---------------------------------------------------------------------------------------------

export interface FleetAddCmdOptions {
  cwd: string
  manifest?: string
  /** Directory of the project to register. */
  target: string
  name?: string
  kind?: string
  profile?: string
  trust?: string
  yes?: boolean
}

/**
 * Register a project, refusing to write an entry that is missing a mandatory field.
 *
 * The gate is the point: a manifest entry is the fleet's claim about a project, and the fields
 * a scanner CANNOT derive — `trust` above all — are exactly the ones that get forgotten when
 * registration is a hand-edit. Prompting at the moment of mutation is what makes the mandatory
 * set true by construction instead of true by remembering. Non-interactive runs (`--yes`, CI)
 * must pass every mandatory value as a flag; a missing one is an error, never a default.
 */
export async function add(opts: FleetAddCmdOptions): Promise<void> {
  const { manifest, autoNote } = await loadManifest(opts.cwd, opts.manifest)
  if (autoNote) print(`  ${theme.dim(`◦ ${autoNote}`)}`)
  if (manifest.shape !== "registry") {
    throw new Error("`fleet add` targets the registry shape — this manifest is a legacy corpus")
  }
  const raw = await readText(manifest.manifestPath)
  if (raw === null) throw new Error(`cannot read ${manifest.manifestPath}`)

  const absTarget = path.resolve(opts.cwd, opts.target)
  if (!(await pathExists(absTarget))) throw new Error(`no such directory: ${absTarget}`)
  const name = opts.name ?? path.basename(absTarget)
  if (manifest.entries.some((e) => e.name === name)) {
    throw new Error(`\`${name}\` is already registered — resolution is keyed by name`)
  }

  const facts = await scanProject(absTarget)
  // A remote IS derivable — read it, never ask. The fields below are not, so they are asked.
  const remote = facts.git.isRepo ? await git(absTarget, ["remote", "get-url", "origin"]) : null

  section(`Fleet add ${theme.dim(`· ${name} · ${absTarget}`)}`)

  // `profile` decides which side of the wall an entry lives on — a placement decision, not a
  // repo fact. Defaulting it silently would let a corp repo land as personal, so it is asked
  // (the flag answers it for non-interactive runs; personal stays the pre-selected default).
  let profile = opts.profile
  if (!profile && !opts.yes) {
    const picked = await select({
      message: "Which side of the wall does this belong to?",
      initialValue: "personal",
      options: [
        { value: "personal", label: "personal — your own work" },
        { value: "corp", label: "corp — employer work (alias-only, machine-pinned)" },
      ],
    })
    if (isCancel(picked)) {
      cancel("No entry written.")
      return
    }
    profile = picked as string
  }
  profile = profile ?? "personal"
  if (profile !== "personal" && profile !== "corp") {
    throw new Error(`--profile must be personal or corp, got \`${profile}\``)
  }

  // `kind` is deliberately a FREE string, not a vocabulary: a fleet's categories are its own,
  // and constraining them would make a general tool impose one owner's taxonomy. The scan can
  // only tell tool-shaped from repo-shaped, so that guess seeds the prompt and the kinds
  // already used in this manifest are offered beside it — the fleet's vocabulary reinforces
  // itself without ever being hardcoded.
  const derivedKind = facts.commands.build || facts.commands.test ? "tool" : "repo"
  let kind = opts.kind
  if (!kind && !opts.yes) {
    const known = [...new Set(manifest.entries.map((e) => e.kind).filter(Boolean))] as string[]
    const choices = [...new Set([derivedKind, ...known])]
    const picked = await select({
      message: "Kind?",
      initialValue: derivedKind,
      options: [
        ...choices.map((k) => ({
          value: k,
          label: k === derivedKind ? `${k} — matches this repo's shape` : k,
        })),
        { value: "", label: "something else…" },
      ],
    })
    if (isCancel(picked)) {
      cancel("No entry written.")
      return
    }
    kind = picked as string
    if (!kind) {
      const typed = await text({
        message: "Kind (free text):",
        validate: (v) => (v.trim() ? undefined : "a kind is required"),
      })
      if (isCancel(typed)) {
        cancel("No entry written.")
        return
      }
      kind = (typed as string).trim()
    }
  }
  kind = kind ?? derivedKind

  // Corp entries take their answer from the profile (machine-pinned, never publishable), so the
  // predicate is only asked of the entries it actually gates.
  let trust: string | undefined
  if (profile === "personal") {
    trust = opts.trust
    if (!trust && !opts.yes) {
      const picked = await select({
        message: "How exposed is this repo's history? (gates content screening)",
        options: [
          { value: "private", label: "private — not destined to be published" },
          { value: "public-bound", label: "public-bound — private now, plausibly public later" },
          { value: "public-repo", label: "public-repo — already public" },
        ],
      })
      if (isCancel(picked)) {
        cancel("No entry written.")
        return
      }
      trust = picked as string
    }
    if (!trust) {
      throw new Error(
        `\`${name}\` needs a trust level: pass --trust <${FLEET_TRUST_VALUES.join("|")}> (non-interactive runs cannot be prompted, and there is deliberately no default — trust gates content screening)`,
      )
    }
    if (!isFleetTrust(trust)) {
      throw new Error(`--trust must be one of ${FLEET_TRUST_VALUES.join(", ")}, got \`${trust}\``)
    }
  } else if (opts.trust) {
    throw new Error("corp entries take no `trust` — `profile: corp` already implies it")
  }

  const entry: Record<string, unknown> =
    profile === "corp"
      ? { name, kind, profile, private: true }
      : {
          name,
          kind,
          profile,
          path: path.relative(manifest.root ?? manifest.dir, absTarget),
          trust,
          contract: {},
          links: {},
          // The scan does not collect remotes (they are not a workflow fact), so read it here —
          // recorded when present, simply absent when the repo has no origin yet.
          ...(remote ? { remote } : {}),
        }

  print(`  ${glyph.bullet} ${theme.dim("entry")}`)
  print(
    JSON.stringify(entry, null, 2)
      .split("\n")
      .map((l) => `    ${theme.dim(l)}`)
      .join("\n"),
  )

  if (!opts.yes) {
    const ok = await confirm({
      message: `Write this entry to ${path.basename(manifest.manifestPath)}?`,
    })
    if (isCancel(ok) || !ok) {
      cancel("No entry written.")
      return
    }
  }

  // Append into the existing `projects` array by re-serializing the parsed document: the
  // manifest is hand-maintained and carries `_readme`/`_note` prose that a naive rewrite would
  // drop, so key order is preserved by mutating the parsed object rather than rebuilding it.
  const doc = JSON.parse(raw) as Record<string, unknown>
  if (!Array.isArray(doc.projects)) throw new Error("manifest has no `projects` array to append to")
  doc.projects.push(entry)
  await fs.writeFile(manifest.manifestPath, JSON.stringify(doc, null, 2) + "\n", "utf8")

  print(`  ${glyph.ok} ${theme.dim("registered")} ${theme.info(name)}`)
  print(`  ${theme.dim(`verify with \`etymd fleet check --manifest ${manifest.manifestPath}\``)}`)
}

// ---------------------------------------------------------------------------------------------
// etymd fleet dismiss / accept
// ---------------------------------------------------------------------------------------------

export interface FleetResolveCmdOptions {
  cwd: string
  manifest?: string
  name: string
  id: string
  reason?: string
}

async function resolveFleetFinding(
  opts: FleetResolveCmdOptions,
  status: "dismissed" | "accepted",
): Promise<void> {
  if (status === "dismissed" && !opts.reason?.trim()) {
    throw new Error('dismiss needs a reason: etymd fleet dismiss <name> <id> --reason "…"')
  }
  const { manifest, autoNote } = await loadManifest(opts.cwd, opts.manifest)
  if (autoNote) print(`  ${theme.dim(`◦ ${autoNote}`)}`)
  // The internal persisting audit may create the entry's FIRST ledger (`.etymd/`) — designed
  // one-command behavior, but a write into a repo that never opted in must be announced.
  const target = await fleetLedgerTarget(manifest, opts.name)
  const hadLedger = await pathExists(path.join(target.ledgerRoot, ".etymd"))
  const { ledgerRoot, recorded } = await ensureFindingRecorded(manifest, opts.name, opts.id)
  if (!recorded) {
    throw new Error(
      `no finding \`${opts.id}\` recorded for \`${opts.name}\` even after a fresh audit — check the id against \`etymd fleet\` output (fleet-manifest wall findings are not ledger-quietable)`,
    )
  }
  if (!hadLedger) {
    print(
      `  ${theme.dim(`first ledger for \`${opts.name}\`: created ${path.join(ledgerRoot, ".etymd")} (a persisting audit ran to record the finding)`)}`,
    )
  }
  // The single-repo ledger commands do the actual resolution — same logic, different root.
  const args = { cwd: ledgerRoot, id: opts.id, reason: opts.reason }
  await (status === "dismissed" ? ledgerDismiss(args) : ledgerAccept(args))
  print(`  ${theme.dim(`ledger: ${path.join(ledgerRoot, ".etymd", "ledger.json")}`)}`)
}

export async function dismiss(opts: FleetResolveCmdOptions): Promise<void> {
  await resolveFleetFinding(opts, "dismissed")
}

export async function accept(opts: FleetResolveCmdOptions): Promise<void> {
  await resolveFleetFinding(opts, "accepted")
}
