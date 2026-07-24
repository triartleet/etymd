import type { ProjectFacts, Scorecard, ScoreDimension, ScoreLevel, SetupMode } from "./types.js"

const WEIGHTS: Record<ScoreLevel, number> = { present: 1, partial: 0.5, absent: 0 }

function has(facts: ProjectFacts, id: string): boolean {
  return facts.artifacts.find((a) => a.id === id)?.exists ?? false
}

/**
 * Grade a project against the pepshop-derived rubric. Deterministic and side-effect-free — the
 * same inputs that back the scorecard also decide the suggested setup mode.
 */
export function scoreProject(facts: ProjectFacts): Scorecard {
  const dims: ScoreDimension[] = []

  const contract = has(facts, "agents")
  dims.push({
    id: "operating-contract",
    label: "Operating contract",
    level: contract ? "present" : "absent",
    detail: contract ? "AGENTS.md found" : "no AGENTS.md",
    recommendation: contract ? undefined : "Generate an AGENTS.md single source of truth",
  })

  const adapters = [
    "claude",
    "copilot",
    "cursorrules",
    "cursor-rules",
    "gemini",
    "cline",
    "windsurf",
  ].filter((id) => has(facts, id))
  dims.push({
    id: "agent-adapters",
    label: "Per-agent adapters",
    level: adapters.length >= 2 ? "present" : adapters.length === 1 ? "partial" : "absent",
    detail: adapters.length ? `${adapters.length} adapter file(s)` : "none",
    recommendation:
      adapters.length >= 2 ? undefined : "Add thin per-agent pointer files (Claude/Cursor/Copilot)",
  })

  const map = has(facts, "skills") || has(facts, "inventory")
  dims.push({
    id: "navigation-map",
    label: "Navigation map",
    level: map ? "present" : "absent",
    detail: map ? "repo-map skill / INVENTORY.md" : "no navigation index",
    recommendation: map
      ? undefined
      : "Add a repo map (skill or INVENTORY) so agents navigate narrow",
  })

  const state = has(facts, "project-context")
  dims.push({
    id: "state-doc",
    label: "Ground-truth state",
    level: state ? "present" : "absent",
    detail: state ? "PROJECT_CONTEXT.md found" : "no state doc",
    recommendation: state ? undefined : "Add a read-first PROJECT_CONTEXT.md",
  })

  const sessions = has(facts, "sessions")
  dims.push({
    id: "session-protocol",
    label: "Session protocol",
    level: sessions ? "present" : "absent",
    detail: sessions ? "docs/sessions archive found" : "no session archive",
    recommendation: sessions ? undefined : "Adopt the archive-every-session protocol",
  })

  const gate: ScoreLevel =
    facts.hooks.source === "githooks"
      ? "present"
      : facts.hooks.source === "husky"
        ? "partial"
        : "absent"
  dims.push({
    id: "gate-tiers",
    label: "Gate tiers",
    level: gate,
    detail:
      facts.hooks.source === "none"
        ? "no git hooks"
        : `${facts.hooks.source}: ${
            [facts.hooks.preCommit && "pre-commit", facts.hooks.prePush && "pre-push"]
              .filter(Boolean)
              .join(" + ") || "configured"
          }`,
    recommendation:
      gate === "present"
        ? undefined
        : "Install tracked hooks (process→pre-commit, correctness→pre-push)",
  })

  const failure = facts.artifacts.some((a) => a.id === "skills" && a.exists)
  dims.push({
    id: "failure-register",
    label: "Failure-modes register",
    level: failure ? "partial" : "absent",
    detail: failure ? "skills dir present (verify a failure-modes skill)" : "no failure register",
    recommendation: "Keep a failure-modes register of environment traps",
  })

  const raw = dims.reduce((sum, d) => sum + WEIGHTS[d.level], 0)
  const score = Math.round((raw / dims.length) * 100)

  return { dimensions: dims, score, suggestedMode: suggestMode(facts, score) }
}

function suggestMode(facts: ProjectFacts, score: number): SetupMode {
  const hasOwn =
    has(facts, "agents") || facts.artifacts.some((a) => a.kind === "adapter" && a.exists)
  if (!hasOwn) return "fresh"
  return score >= 60 ? "optimisation" : "migration"
}
