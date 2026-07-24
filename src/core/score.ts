import { RUBRIC } from "../pack/rubric.js"
import type { WorkflowProfile } from "../engine/finding.js"
import type { ProjectFacts, Scorecard, ScoreDimension, ScoreLevel, SetupMode } from "./types.js"

const WEIGHTS: Record<ScoreLevel, number> = { present: 1, partial: 0.5, absent: 0 }

/**
 * Grade a project against the pack rubric. Deterministic and side-effect-free — the same inputs
 * that back the scorecard also decide the suggested setup mode. The profile matters: team repos
 * are not graded on the solo-ritual dimensions (state doc, session archive, failure register).
 */
export function scoreProject(facts: ProjectFacts, profile: WorkflowProfile = "solo"): Scorecard {
  const applicable = RUBRIC.filter((d) => d.appliesTo === "all" || profile === "solo")
  const dimensions: ScoreDimension[] = applicable.map((d) => {
    const { level, detail } = d.evaluate(facts)
    return {
      id: d.id,
      label: d.label,
      level,
      detail,
      recommendation: level === "present" ? undefined : d.recommendation,
    }
  })

  const raw = dimensions.reduce((sum, d) => sum + WEIGHTS[d.level], 0)
  const score = Math.round((raw / dimensions.length) * 100)

  return { profile, dimensions, score, suggestedMode: suggestMode(facts, score) }
}

function suggestMode(facts: ProjectFacts, score: number): SetupMode {
  const hasOwn =
    (facts.artifacts.find((a) => a.id === "agents")?.exists ?? false) ||
    facts.artifacts.some((a) => a.kind === "adapter" && a.exists)
  if (!hasOwn) return "fresh"
  return score >= 60 ? "optimisation" : "migration"
}
