import { EXTRACTION_THRESHOLD, measureContext } from "../core/context.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"

const LENS_ID = "context-economy"

/** Total always-loaded words past which the footprint itself becomes a finding. */
export const TOTAL_BUDGET_WORDS = 8000

/**
 * Economy lens: the always-loaded instruction footprint, as findings. Context is the dominant
 * cost of the agent loop, and attention dilutes long before windows fill — a lean contract is
 * a correctness feature, not a style preference.
 */
export const contextEconomyLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Context economy",
  kind: "improvement",
  async run(ctx): Promise<LensReport> {
    const budget = await measureContext(ctx.root)
    const findings: Finding[] = []

    for (const f of budget.extractionCandidates) {
      findings.push({
        id: `${LENS_ID}/heavy-file:${f.path}`,
        lens: LENS_ID,
        tier: "gap",
        claim: `${f.path} loads ${f.words} words (~${f.approxTokens} tokens) into every session`,
        evidence: [`${f.path}: ${f.words} words`],
        why: "Reference material that loads every session taxes attention and cost on tasks that never need it.",
        action: "Extract the reference bulk into an on-demand skill/doc and keep a pointer.",
        effort: "M",
        confidence: "high",
      })
    }

    if (budget.totalWords >= TOTAL_BUDGET_WORDS) {
      findings.push({
        id: `${LENS_ID}/total-over-budget`,
        lens: LENS_ID,
        tier: "gap",
        claim: `The always-loaded footprint is ${budget.totalWords} words (~${budget.totalApproxTokens} tokens) — over the ${TOTAL_BUDGET_WORDS}-word budget`,
        evidence: budget.files.slice(0, 5).map((f) => `${f.path}: ${f.words}w`),
        why: "Every session pays this before the task begins; instruction-following degrades as the resident context grows.",
        action: "Run `etymd context` for the per-file breakdown and extract the heaviest block.",
        effort: "M",
        confidence: "high",
      })
    }

    return {
      lens: LENS_ID,
      version: "1",
      title: "Context economy",
      kind: "improvement",
      status: "ran",
      disclosures: [
        `Budgets: ${EXTRACTION_THRESHOLD} words/file, ${TOTAL_BUDGET_WORDS} words total (defaults; configuration is a later release). Scoped Cursor rules excluded.`,
      ],
      findings,
    }
  },
}
