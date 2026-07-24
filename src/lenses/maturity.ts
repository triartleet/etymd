import { scoreProject } from "../core/score.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"

const LENS_ID = "maturity"

/**
 * Improvement lens: the pack rubric's gaps, expressed as findings so they enter the same
 * ranked report and ledger as every other lens. The scorecard itself remains the `score`
 * command's display; this is the same data speaking the Finding schema.
 */
export const maturityLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Workflow maturity",
  kind: "improvement",
  async run(ctx): Promise<LensReport> {
    const card = scoreProject(ctx.facts, ctx.profile)
    const findings: Finding[] = card.dimensions
      .filter((d) => d.level !== "present")
      .map((d) => ({
        id: `${LENS_ID}/${d.id}`,
        lens: LENS_ID,
        tier: d.level === "absent" ? "gap" : "polish",
        claim: `${d.label}: ${d.detail}`,
        evidence: [d.detail],
        why: "A missing workflow layer means agents re-derive or silently skip what the standard makes explicit.",
        action: d.recommendation,
        effort: d.level === "absent" ? "M" : "S",
        confidence: "high",
      }))

    return {
      lens: LENS_ID,
      version: "1",
      title: "Workflow maturity",
      kind: "improvement",
      status: "ran",
      disclosures:
        ctx.profile === "team"
          ? [
              "Solo-ritual dimensions (state doc, sessions, failure register) excluded under the team profile.",
            ]
          : [],
      findings,
    }
  },
}
