import path from "node:path"

import {
  ETYMD_DIR,
  deriveProfile,
  readBaseline,
  writeCachedFacts,
  type Baseline,
} from "../core/facts.js"
import { readConfig, type LoadedConfig, type StateBudgets } from "../core/config.js"
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
  /**
   * Fleet: the audited root is READ-ONLY — write nothing into it, not even the scan cache
   * where `.etymd` already exists there. A corp worktree is never written, regardless of flags.
   */
  readOnlyRoot?: boolean
  /**
   * Fleet: read/write the ledger at this root instead of the audited one. Corp findings persist
   * under the manifest's `corp/<name>/`, never inside the corp worktree.
   */
  ledgerRoot?: string
  /** Fleet: per-entry state-budget overlay (registry `staleAfterDays` / `stateBudget`). */
  stateBudgets?: Partial<StateBudgets>
  /** Fleet: judge repo freshness on fork-authored commits only (see `ScanOptions`). */
  upstreamRemote?: string
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
  const facts = await scanProject(root, { upstreamRemote: opts.upstreamRemote })
  const ledgerRoot = opts.ledgerRoot ?? root
  // A read-only audit of a repo that never opted in must leave zero trace — only cache where
  // .etymd/ already exists or this run is allowed to persist anyway. A read-only root (a corp
  // worktree) is never cached into, even where a stray .etymd exists there.
  if (
    !opts.readOnlyRoot &&
    ((opts.persistLedger ?? true) || (await pathExists(path.join(root, ETYMD_DIR))))
  ) {
    await writeCachedFacts(root, facts)
  }
  const baseline = await readBaseline(root)
  let config = await readConfig(root)
  if (opts.stateBudgets) {
    // The fleet manifest's per-entry thresholds overlay the repo's own config for this run.
    config = {
      ...config,
      config: { ...config.config, state: { ...config.config.state, ...opts.stateBudgets } },
    }
  }
  const profile = baseline?.profile ?? deriveProfile(facts)

  // Select lenses by --lensIds only. Kind filtering moved to the FINDING level: a lens can emit
  // both truth and improvement findings (gate-integrity is improvement, but "hooks-not-wired" is
  // an objective truth a `doctor` run must see). Filtering at the lens level silently skipped
  // findings that did not share the lens's label — which is how `doctor` missed a security risk.
  const selected = LENSES.filter((lens) => !opts.lensIds || opts.lensIds.includes(lens.id))

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

  // Stamp each finding with its kind: the finding's own if set, else the lens's. Then filter by
  // --kind at the finding level so a truth-only `doctor` sees truth findings from every lens.
  const all = reports.flatMap((r) => r.findings.map((f) => ({ ...f, kind: f.kind ?? r.kind })))
  const visible = opts.kind ? all.filter((f) => f.kind === opts.kind) : all
  const previous = await readLedger(ledgerRoot)
  // Files no lens looked at this run must not have their tracked findings closed as fixed.
  const outOfScope = reports.flatMap((r) => r.outOfScope ?? [])
  const { ledger, diff } = reconcileLedger(previous, all, undefined, outOfScope)
  // A partial run (kind or lens filter) must not mark unexamined findings resolved — only persist
  // the reconciliation when every lens ran AND no kind filter excluded any findings.
  const fullRun = !opts.kind && !opts.lensIds
  // A read-only root only ever takes ledger writes when they are redirected elsewhere.
  const ledgerWritable = !opts.readOnlyRoot || ledgerRoot !== root
  if ((opts.persistLedger ?? true) && fullRun && ledgerWritable) {
    await writeLedger(ledgerRoot, ledger)
  }

  return {
    facts,
    profile,
    baseline,
    config,
    reports,
    findings: rankFindings(visibleFindings(visible, previous)),
    ledger,
    diff,
  }
}
