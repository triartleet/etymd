import path from "node:path"

import {
  ETYMD_DIR,
  deriveProfile,
  readBaseline,
  writeCachedFacts,
  type Baseline,
} from "../core/facts.js"
import { readConfig, type LoadedConfig } from "../core/config.js"
import { scanProject } from "../core/scan.js"
import { pathExists } from "../core/util.js"
import type { ProjectFacts } from "../core/types.js"
import { contextEconomyLens } from "../lenses/context-economy.js"
import { gateIntegrityLens } from "../lenses/gate-integrity/lens.js"
import { instructionTruthLens } from "../lenses/instruction-truth/lens.js"
import { stateFreshnessLens } from "../lenses/state-freshness.js"
import {
  rankFindings,
  type Finding,
  type Lens,
  type LensKind,
  type LensReport,
  type WorkflowProfile,
} from "./finding.js"
import {
  readLedger,
  reconcileLedger,
  visibleFindings,
  writeLedger,
  type Ledger,
  type LedgerDiff,
} from "./ledger.js"

/** The lens registry — adding a lens means registering it here. */
export const LENSES: Lens[] = [
  instructionTruthLens,
  stateFreshnessLens,
  gateIntegrityLens,
  contextEconomyLens,
]

export interface AuditOptions {
  /** Restrict to one kind (doctor = truth). */
  kind?: LensKind
  /** Restrict to specific lens ids. */
  lensIds?: string[]
  /** Persist the reconciled ledger (the default; false = read-only report). */
  persistLedger?: boolean
}

export interface AuditResult {
  facts: ProjectFacts
  profile: WorkflowProfile
  baseline: Baseline | null
  config: LoadedConfig
  reports: LensReport[]
  /** Ranked, dismissed-filtered — what the report shows. */
  findings: Finding[]
  ledger: Ledger
  diff: LedgerDiff
}

export async function runAudit(root: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const facts = await scanProject(root)
  // A read-only audit of a repo that never opted in must leave zero trace — only cache where
  // .etymd/ already exists or this run is allowed to persist anyway.
  if ((opts.persistLedger ?? true) || (await pathExists(path.join(root, ETYMD_DIR)))) {
    await writeCachedFacts(root, facts)
  }
  const baseline = await readBaseline(root)
  const config = await readConfig(root)
  const profile = baseline?.profile ?? deriveProfile(facts)

  const selected = LENSES.filter(
    (lens) =>
      (!opts.kind || lens.kind === opts.kind) && (!opts.lensIds || opts.lensIds.includes(lens.id)),
  )

  const reports: LensReport[] = []
  for (const lens of selected) {
    try {
      reports.push(await lens.run({ root, facts, profile, baseline, config }))
    } catch (err) {
      reports.push({
        lens: lens.id,
        version: lens.version,
        title: lens.title,
        kind: lens.kind,
        status: "skipped",
        reason: err instanceof Error ? err.message : String(err),
        disclosures: [],
        findings: [],
      })
    }
  }

  const all = reports.flatMap((r) => r.findings)
  const previous = await readLedger(root)
  // Files no lens looked at this run must not have their tracked findings closed as fixed.
  const outOfScope = reports.flatMap((r) => r.outOfScope ?? [])
  const { ledger, diff } = reconcileLedger(previous, all, undefined, outOfScope)
  // A partial run (kind/lens filter) must not mark unexamined findings resolved — only persist
  // the reconciliation when every lens ran.
  const fullRun = selected.length === LENSES.length
  if ((opts.persistLedger ?? true) && fullRun) {
    await writeLedger(root, ledger)
  }

  return {
    facts,
    profile,
    baseline,
    config,
    reports,
    findings: rankFindings(visibleFindings(all, previous)),
    ledger,
    diff,
  }
}
