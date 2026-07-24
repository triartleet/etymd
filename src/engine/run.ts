import path from "node:path"

import {
  CLOTHAID_DIR,
  deriveProfile,
  readBaseline,
  writeCachedFacts,
  type Baseline,
} from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { pathExists } from "../core/util.js"
import type { ProjectFacts } from "../core/types.js"
import { contractDriftLens } from "../lenses/contract-drift.js"
import { gateIntegrityLens } from "../lenses/gate-integrity/lens.js"
import { maturityLens } from "../lenses/maturity.js"
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
export const LENSES: Lens[] = [contractDriftLens, gateIntegrityLens, maturityLens]

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
  reports: LensReport[]
  /** Ranked, dismissed-filtered — what the report shows. */
  findings: Finding[]
  ledger: Ledger
  diff: LedgerDiff
}

export async function runAudit(root: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const facts = await scanProject(root)
  // A read-only audit of a repo that never opted in must leave zero trace — only cache where
  // .clothaid/ already exists or this run is allowed to persist anyway.
  if ((opts.persistLedger ?? true) || (await pathExists(path.join(root, CLOTHAID_DIR)))) {
    await writeCachedFacts(root, facts)
  }
  const baseline = await readBaseline(root)
  const profile = baseline?.profile ?? deriveProfile(facts)

  const selected = LENSES.filter(
    (lens) =>
      (!opts.kind || lens.kind === opts.kind) && (!opts.lensIds || opts.lensIds.includes(lens.id)),
  )

  const reports: LensReport[] = []
  for (const lens of selected) {
    try {
      reports.push(await lens.run({ root, facts, profile, baseline }))
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
  const { ledger, diff } = reconcileLedger(previous, all)
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
    reports,
    findings: rankFindings(visibleFindings(all, previous)),
    ledger,
    diff,
  }
}
