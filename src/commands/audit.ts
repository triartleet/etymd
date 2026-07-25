import { runAudit } from "../engine/run.js"
import {
  print,
  renderFindings,
  renderLedgerDiff,
  renderLensCoverage,
  section,
} from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface AuditOptions {
  cwd: string
  json?: boolean
  /** Truth lenses only — the doctor subset ("is this still true?"). */
  truth?: boolean
  /** Restrict to one lens id. */
  lens?: string
  /** Do not persist the reconciled ledger (read-only report). */
  noLedger?: boolean
  /** Exit non-zero when a finding at (or above) this tier exists — the CI gate. */
  failOn?: "risk" | "gap" | "polish"
}

const TIER_RANK = { risk: 0, gap: 1, polish: 2 } as const

export async function run(opts: AuditOptions): Promise<void> {
  const result = await runAudit(opts.cwd, {
    kind: opts.truth ? "truth" : undefined,
    lensIds: opts.lens ? [opts.lens] : undefined,
    persistLedger: !opts.noLedger,
  })

  if (opts.failOn) {
    const threshold = TIER_RANK[opts.failOn]
    if (result.findings.some((f) => TIER_RANK[f.tier] <= threshold)) {
      process.exitCode = 1
    }
  }

  if (opts.json) {
    print(
      JSON.stringify(
        {
          profile: result.profile,
          baseline: result.baseline
            ? { packVersion: result.baseline.packVersion, approvedAt: result.baseline.approvedAt }
            : null,
          reports: result.reports.map(({ findings: _findings, ...r }) => r),
          findings: result.findings,
          diff: {
            new: result.diff.new.map((f) => f.id),
            stillOpen: result.diff.stillOpen.map((f) => f.id),
            regressed: result.diff.regressed.map((f) => f.id),
            resolved: result.diff.resolved.map((e) => e.id),
            dismissed: result.diff.dismissed.map((f) => f.id),
            accepted: result.diff.accepted.map((f) => f.id),
          },
        },
        null,
        2,
      ),
    )
    return
  }

  section(
    `${opts.truth ? "Doctor — is this still true?" : "Audit"} ${theme.dim(`· ${result.facts.name} · ${result.profile} profile`)}`,
  )
  if (!result.baseline && !opts.truth) {
    print(
      `  ${theme.dim("no committed baseline — run `etymd init` to approve one; drift checks are limited")}`,
    )
  }

  renderLensCoverage(result.reports)

  section(`Findings ${theme.dim("(ranked: risk → gap → polish, cheapest first)")}`)
  renderFindings(result.findings)
  renderLedgerDiff(result.diff)

  const top = result.findings[0]
  if (top) {
    print()
    print(
      `  ${theme.dim("next:")} ${theme.heading(top.claim)}${top.action ? theme.dim(` — ${top.action}`) : ""}`,
    )
  }
}
