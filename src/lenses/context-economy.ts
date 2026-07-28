import { CONFIG_FILE, DEFAULT_CONFIG } from "../core/config.js"
import { measureContext } from "../core/context.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"

const LENS_ID = "context-economy"

/** Default total always-loaded words past which the footprint itself becomes a finding. */
export const TOTAL_BUDGET_WORDS = DEFAULT_CONFIG.context.totalWords

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
    const budgets = ctx.config?.config.context ?? DEFAULT_CONFIG.context
    const budget = await measureContext(ctx.root, budgets.perFileWords)
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

    if (budget.totalWords >= budgets.totalWords) {
      findings.push({
        id: `${LENS_ID}/total-over-budget`,
        lens: LENS_ID,
        tier: "gap",
        claim: `The always-loaded footprint is ${budget.totalWords} words (~${budget.totalApproxTokens} tokens) — over the ${budgets.totalWords}-word budget`,
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
        ...(ctx.config?.problems ?? []),
        `Budgets: ${budgets.perFileWords} words/file, ${budgets.totalWords} words total (${
          budgets.perFileWords === DEFAULT_CONFIG.context.perFileWords &&
          budgets.totalWords === DEFAULT_CONFIG.context.totalWords
            ? `defaults — override under \`context\` in ${CONFIG_FILE}`
            : `set in ${CONFIG_FILE}`
        }). Scoped Cursor rules excluded.`,
      ],
      findings,
    }
  },
}
