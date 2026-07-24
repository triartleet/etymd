// The one Finding schema every analysis surface reports through. score/doctor/audit all speak
// this shape so the ledger, ranking, and JSON output stay machine-stable across lenses.

export type FindingTier = "risk" | "gap" | "polish"
export type Effort = "S" | "M" | "L"
export type Confidence = "high" | "medium" | "low"

export interface Finding {
  /** Stable across runs: `<lens>/<slug>` — the ledger keys on this. */
  id: string
  lens: string
  tier: FindingTier
  /** One sentence: what is wrong / missing. */
  claim: string
  /** File paths, job names, or metrics that ground the claim. Never empty. */
  evidence: string[]
  /** The concrete cost of NOT acting. */
  why: string
  /** What to do about it (may name a etymd command as the fix). */
  action?: string
  effort: Effort
  confidence: Confidence
}

export type LensKind = "truth" | "improvement"

export type LensStatus = "ran" | "skipped"

export interface LensReport {
  lens: string
  version: string
  title: string
  kind: LensKind
  status: LensStatus
  /** Honest coverage: why the lens could not run, or what it could not see. */
  reason?: string
  /** Partial-visibility disclosures (e.g. "3 CI jobs inherited from an unseen template"). */
  disclosures: string[]
  findings: Finding[]
}

export interface LensContext {
  root: string
  facts: import("../core/types.js").ProjectFacts
  profile: WorkflowProfile
  /** The committed, approved reckoning — what truth lenses measure drift against. */
  baseline: import("../core/facts.js").Baseline | null
}

/** Solo vs team changes what counts as a gap (state docs and session archives are solo ritual). */
export type WorkflowProfile = "solo" | "team"

export interface Lens {
  id: string
  version: string
  title: string
  kind: LensKind
  run(ctx: LensContext): Promise<LensReport>
}

const TIER_ORDER: Record<FindingTier, number> = { risk: 0, gap: 1, polish: 2 }
const EFFORT_ORDER: Record<Effort, number> = { S: 0, M: 1, L: 2 }

/** Canonical ranking: severity first, then cheapest wins inside a tier. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort],
  )
}
