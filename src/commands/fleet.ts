import { promises as fs } from "node:fs"
import os from "node:os"
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
/**
 * Record a corp entry's alias → directory mapping in the gitignored local manifest.
 *
 * A corp entry in the tracked manifest is deliberately alias-only: no path, no remote. That is
 * what keeps employer names out of a file that gets pushed — and it also means the entry cannot
 * resolve to anything on its own. Writing the tracked half alone leaves a registration that
 * `fleet check` immediately reports as dangling, so the command that claims to register a
 * project finishes the job it starts.
 *
 * The path is written `~`-relative: the tracked manifest never records a machine home, and the
 * local one should not either — it is copied between machines by hand.
 *
 * The gitignore check is not defensive padding. This file is the one place real employer
 * directory names are written down, so creating it somewhere git would track it would produce
 * exactly the disclosure the alias convention exists to prevent. Refusing is the only safe
 * answer: a leak that the tool creates is worse than a registration it declines to finish.
 */
async function recordCorpMapping(
  manifest: { localPath: string; dir: string },
  name: string,
  absTarget: string,
): Promise<string> {
  const home = os.homedir()
  const value =
    absTarget === home || absTarget.startsWith(home + path.sep)
      ? `~${absTarget.slice(home.length)}`
      : absTarget

  const insideRepo = (await git(manifest.dir, ["rev-parse", "--is-inside-work-tree"])) === "true"
  if (insideRepo) {
    const ignored = (await git(manifest.dir, ["check-ignore", "-q", manifest.localPath])) !== null
    if (!ignored) {
      throw new Error(
        `${path.basename(manifest.localPath)} is not gitignored — refusing to write employer ` +
          `directory names into a file git would track. Add it to .gitignore, then re-run.`,
      )
    }
  }

  const existing = await readText(manifest.localPath)
  let doc: Record<string, unknown> = {}
  if (existing) {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>
    } catch {
      // Hand-maintained and machine-local: rewriting over a syntax error would destroy the
      // only copy of every other mapping on this machine.
      throw new Error(
        `${path.basename(manifest.localPath)} is not valid JSON — fix it before registering, ` +
          `so the mapping is not written over hand-maintained entries that cannot be re-derived.`,
      )
    }
  }
  const dirs = (doc.dirs as Record<string, unknown> | undefined) ?? {}
  dirs[name] = value
  doc.dirs = dirs
  await fs.writeFile(manifest.localPath, JSON.stringify(doc, null, 2) + "\n", "utf8")
  return value
}

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

  // The manifest already declares which hosts are the employer's, and the remote was just read
  // — so a corp repo landing as a personal entry is a failure the tool has every fact needed to
  // prevent. It matters because the two branches differ exactly where it is dangerous: the
  // personal one records `path` and the RAW `remote`, so a mis-profiled corp repo writes the
  // employer host and its internal group structure into a manifest that is tracked and pushed.
  // That is the leak the alias convention exists to prevent, and it sat one forgotten flag away.
  // Refuse rather than auto-correct: placement is the user's call, but it may not be made by
  // omission.
  const corpHost = remote ? manifest.corpHosts.find((h) => remote.includes(h)) : undefined
  if (corpHost && profile !== "corp") {
    throw new Error(
      `\`${name}\` has a remote on the corp host \`${corpHost}\`, but --profile is \`${profile}\`. ` +
        `A personal entry records its path and raw remote in the TRACKED manifest — register it ` +
        `with \`--profile corp\` (alias-only, machine-pinned), or move it out of the fleet root.`,
    )
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
          // The remote is deliberately NOT recorded. Nothing reads it — it was persisted only
          // because it happened to be derivable — and it is the field that turns a mis-profiled
          // entry into a disclosure: a raw URL carries the host AND the internal group path,
          // while `path` carries a bare directory name. Removing a field no consumer reads
          // retires that whole class without any host-matching guess, and keeps working on a
          // machine that has no local manifest for the corp-host guard above to read.
          // It stays derivable at any time from the checkout itself, which is where it came from.
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

  // The local mapping goes FIRST for a corp entry, because the two failure modes are not
  // symmetric. A mapping written without its entry is inert — a `dirs` key nothing reads. An
  // entry written without its mapping is a registration that resolves to nothing, in the file
  // that gets committed and pushed. Write the recoverable half first.
  let mappedTo: string | undefined
  if (profile === "corp") {
    mappedTo = await recordCorpMapping(manifest, name, absTarget)
  }

  // Append into the existing `projects` array by re-serializing the parsed document: the
  // manifest is hand-maintained and carries `_readme`/`_note` prose that a naive rewrite would
  // drop, so key order is preserved by mutating the parsed object rather than rebuilding it.
  const doc = JSON.parse(raw) as Record<string, unknown>
  if (!Array.isArray(doc.projects)) throw new Error("manifest has no `projects` array to append to")
  doc.projects.push(entry)
  await fs.writeFile(manifest.manifestPath, JSON.stringify(doc, null, 2) + "\n", "utf8")

  print(`  ${glyph.ok} ${theme.dim("registered")} ${theme.info(name)}`)
  if (mappedTo) {
    print(
      `  ${glyph.ok} ${theme.dim("mapped")} ${theme.info(`${name} → ${mappedTo}`)} ${theme.dim(`in ${path.basename(manifest.localPath)} (gitignored)`)}`,
    )
  }
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
