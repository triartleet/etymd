import type { LeashProfile, ProjectFacts } from "./types.js"

/**
 * Seed a leash from what the scan already implies, so the interactive capture starts from an
 * informed default rather than a blank form. Team/CI signals bias toward a tighter leash; a
 * solo repo with no CI toward a looser one.
 */
export function defaultLeash(facts: ProjectFacts): LeashProfile {
  const team = facts.ci.system !== "none"
  const commitConvention =
    facts.hooks.source !== "none" || facts.artifacts.some((a) => a.id === "githooks" && a.exists)
      ? "type: scope description"
      : undefined

  return {
    autonomy: {
      runCommands: true,
      commitUnasked: false,
      pushUnasked: false,
      openPrs: !team,
      network: false,
    },
    tooling: {
      // Corporate/GitLab setups commonly disallow the GitHub CLI; default off for team repos.
      ghCli: !team && facts.ci.system !== "gitlab",
      mcpServers: false,
    },
    vcs: {
      commitConvention,
      ticketLinked: team,
    },
    scope: {
      minimalDiffs: true,
      stayInScope: true,
    },
    notes: [],
  }
}
