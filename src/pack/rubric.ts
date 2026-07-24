import type { ProjectFacts, ScoreLevel } from "../core/types.js"

// The maturity rubric as pack DATA (not code buried in score.ts) so it is versioned with the
// pack and diffable by harvest. Dimensions marked `solo` encode a single-dev ritual (state doc,
// session archive, failure register) — a team repo keeps that state in its tracker/MRs, so those
// dimensions are excluded under the team profile rather than counted against it.

export interface RubricResult {
  level: ScoreLevel
  detail: string
}

export interface RubricDimension {
  id: string
  label: string
  appliesTo: "all" | "solo"
  recommendation: string
  evaluate(facts: ProjectFacts): RubricResult
}

function has(facts: ProjectFacts, id: string): boolean {
  return facts.artifacts.find((a) => a.id === id)?.exists ?? false
}

export const RUBRIC: RubricDimension[] = [
  {
    id: "operating-contract",
    label: "Operating contract",
    appliesTo: "all",
    recommendation: "Generate an AGENTS.md single source of truth",
    evaluate: (facts) => ({
      level: has(facts, "agents") ? "present" : "absent",
      detail: has(facts, "agents") ? "AGENTS.md found" : "no AGENTS.md",
    }),
  },
  {
    id: "agent-adapters",
    label: "Per-agent adapters",
    appliesTo: "all",
    recommendation:
      "Add a thin per-agent pointer file (Claude/Cursor/Copilot) referencing AGENTS.md",
    evaluate: (facts) => {
      // One pointer + a contract is complete: Cursor consumes AGENTS.md natively, so demanding
      // N adapters would punish deliberate minimalism.
      const adapters = [
        "claude",
        "copilot",
        "cursorrules",
        "cursor-rules",
        "gemini",
        "cline",
        "windsurf",
      ].filter((id) => has(facts, id))
      const contract = has(facts, "agents")
      const level: ScoreLevel = adapters.length >= 1 ? "present" : contract ? "partial" : "absent"
      return {
        level,
        detail: adapters.length
          ? `${adapters.length} adapter file(s)`
          : contract
            ? "contract exists, no pointers"
            : "none",
      }
    },
  },
  {
    id: "navigation-map",
    label: "Navigation map",
    appliesTo: "all",
    recommendation: "Add a repo map (skill or INVENTORY doc) so agents navigate narrow",
    evaluate: (facts) => {
      const map = has(facts, "skills") || has(facts, "inventory")
      return {
        level: map ? "present" : "absent",
        detail: map ? "repo-map skill / INVENTORY.md" : "no navigation index",
      }
    },
  },
  {
    id: "state-doc",
    label: "Ground-truth state",
    appliesTo: "solo",
    recommendation: "Add a read-first PROJECT_CONTEXT.md",
    evaluate: (facts) => ({
      level: has(facts, "project-context") ? "present" : "absent",
      detail: has(facts, "project-context") ? "PROJECT_CONTEXT.md found" : "no state doc",
    }),
  },
  {
    id: "session-protocol",
    label: "Session protocol",
    appliesTo: "solo",
    recommendation: "Adopt the archive-every-session protocol",
    evaluate: (facts) => ({
      level: has(facts, "sessions") ? "present" : "absent",
      detail: has(facts, "sessions") ? "docs/sessions archive found" : "no session archive",
    }),
  },
  {
    id: "gate-tiers",
    label: "Gate tiers",
    appliesTo: "all",
    recommendation: "Install tracked hooks (process→pre-commit, correctness→pre-push)",
    evaluate: (facts) => {
      const h = facts.hooks
      const level: ScoreLevel =
        h.source === "githooks" ? "present" : h.source === "none" ? "absent" : "partial"
      const wired = [
        h.preCommit && "pre-commit",
        h.prePush && "pre-push",
        h.commitMsg && "commit-msg",
      ]
        .filter(Boolean)
        .join(" + ")
      return {
        level,
        detail: h.source === "none" ? "no git hooks" : `${h.source}: ${wired || "configured"}`,
      }
    },
  },
  {
    id: "failure-register",
    label: "Failure-modes register",
    appliesTo: "solo",
    recommendation: "Keep a failure-modes register of environment traps",
    evaluate: (facts) => {
      if (has(facts, "failure-modes-skill") || has(facts, "failure-modes-doc")) {
        return { level: "present", detail: "failure-modes register found" }
      }
      if (has(facts, "skills")) {
        return { level: "partial", detail: "skills dir present, no failure-modes register" }
      }
      return { level: "absent", detail: "no failure register" }
    },
  },
]
