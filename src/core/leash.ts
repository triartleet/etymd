import type { LeashProfile, ProjectFacts } from "./types.js"

/**
 * Seed a leash from what the scan already implies, so the interactive capture starts from an
 * informed default rather than a blank form. Team/CI signals bias toward a tighter leash; a
 * solo repo with no CI toward a looser one. Hardness (org policy vs preference) defaults soft —
 * only a human can assert "forbidden by policy".
 */
export function defaultLeash(facts: ProjectFacts): LeashProfile {
  const team = (facts.git.recentAuthors ?? 1) > 2
  const gitlab = facts.ci.system === "gitlab"
  const commitConvention = facts.git.ticketKey
    ? `type: ${facts.git.ticketKey}-<ticket> description`
    : facts.hooks.commitMsg || facts.hooks.source !== "none"
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
      // Corporate/GitLab setups commonly disallow the GitHub CLI; default off for those.
      ghCli: { enabled: !team && !gitlab, hard: false },
      mcpServers: { enabled: false, hard: false },
      ticketApiBlocked: team && Boolean(facts.git.ticketKey),
    },
    vcs: {
      commitConvention,
      ticketKey: facts.git.ticketKey,
      ticketLinked: team || Boolean(facts.git.ticketKey),
      attribution: "none",
    },
    deps: {
      exactPinning: false,
    },
    scope: {
      minimalDiffs: true,
      stayInScope: true,
    },
    disabledIntegrations: [],
    notes: [],
  }
}
