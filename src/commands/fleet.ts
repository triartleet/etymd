import { promises as fs } from "node:fs"
import path from "node:path"

import { loadFleetManifest, type FleetManifest } from "../core/fleet.js"
import { pathExists, readJson } from "../core/util.js"
import type { Finding, FindingTier } from "../engine/finding.js"
import {
  checkManifest,
  ensureFindingRecorded,
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
  type FleetRowView,
} from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"
import { accept as ledgerAccept, dismiss as ledgerDismiss } from "./ledger.js"

const TIER_RANK: Record<FindingTier, number> = { risk: 0, gap: 1, polish: 2 }

/** The previous sweep, stored beside the manifest for deltas. Local-only — gitignore it. */
const LAST_SWEEP_FILE = "last.fleet.json"

interface LastSweepRecord {
  schema: string
  sweptAt: string
  /** Per project: the visible finding ids of the last sweep — ids and tiers only, no content. */
  projects: Record<string, { id: string; tier: FindingTier }[]>
  wall: { id: string; tier: FindingTier }[]
}

async function resolveManifestPath(cwd: string, manifest?: string): Promise<string> {
  if (manifest) return path.resolve(cwd, manifest)
  const candidate = path.join(cwd, "registry.json")
  if (await pathExists(candidate)) return candidate
  throw new Error(
    "no --manifest given and no registry.json in the current directory — pass --manifest <file> (there is deliberately no env var and no global pointer)",
  )
}

async function loadManifest(cwd: string, manifestOpt?: string): Promise<FleetManifest> {
  return loadFleetManifest(await resolveManifestPath(cwd, manifestOpt))
}

function failOnExit(failOn: FindingTier | undefined, findings: Finding[]): void {
  if (!failOn) return
  const threshold = TIER_RANK[failOn]
  if (findings.some((f) => TIER_RANK[f.tier] <= threshold)) process.exitCode = 1
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
  failOn?: FindingTier
}

export async function sweep(opts: FleetSweepCmdOptions): Promise<void> {
  if (opts.profile && opts.profile !== "personal" && opts.profile !== "corp") {
    throw new Error(`--profile must be personal or corp, got \`${opts.profile}\``)
  }
  const manifest = await loadManifest(opts.cwd, opts.manifest)
  const result = await sweepFleet(manifest, {
    only: opts.only,
    profile: opts.profile as "personal" | "corp" | undefined,
    kind: opts.truth ? "truth" : undefined,
    persistLedgers: opts.persistLedgers,
  })

  const lastPath = path.join(manifest.dir, LAST_SWEEP_FILE)
  const previous = await readJson<LastSweepRecord>(lastPath)
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
    print(JSON.stringify({ ...result, delta: previous ? delta : null }, null, 2))
  } else {
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
    await fs.writeFile(lastPath, JSON.stringify(record, null, 2) + "\n", "utf8")
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
  const manifest = await loadManifest(opts.cwd, opts.manifest)
  const { findings, disclosures } = await checkManifest(manifest)
  if (findings.length) process.exitCode = 1

  if (opts.json) {
    print(JSON.stringify({ schema: FLEET_JSON_SCHEMA, findings, disclosures }, null, 2))
    return
  }
  section(
    `Fleet check ${theme.dim(`· ${path.basename(manifest.manifestPath)} · ${manifest.entries.length} entr${manifest.entries.length === 1 ? "y" : "ies"} · manifest truth only, no lenses`)}`,
  )
  renderFindings(findings)
  renderFleetNotes([], disclosures)
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
  const manifest = await loadManifest(opts.cwd, opts.manifest)
  const { ledgerRoot, recorded } = await ensureFindingRecorded(manifest, opts.name, opts.id)
  if (!recorded) {
    throw new Error(
      `no finding \`${opts.id}\` recorded for \`${opts.name}\` even after a fresh audit — check the id against \`etymd fleet\` output (fleet-manifest wall findings are not ledger-quietable)`,
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
