import path from "node:path"

import { PACK_VERSION } from "../pack/version.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"
import type { ProjectFacts } from "../core/types.js"
import { readText } from "../core/util.js"

const LENS_ID = "contract-drift"

function finding(partial: Omit<Finding, "lens">): Finding {
  return { lens: LENS_ID, ...partial }
}

function compareCommands(baseline: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const out: Finding[] = []
  for (const role of ["test", "lint", "typecheck", "format", "formatCheck", "build"] as const) {
    const before = baseline.commands[role]
    if (before && !(before in fresh.commands.raw)) {
      out.push(
        finding({
          id: `${LENS_ID}/command-gone-${role}`,
          tier: "risk",
          claim: `Documented ${role} command \`${before}\` no longer exists in package.json`,
          evidence: ["package.json"],
          why: "Every doc, hook, and agent instruction naming it now fails or silently skips a check.",
          action: "Re-point the contract/hooks at the renamed script, then refresh the baseline.",
          effort: "S",
          confidence: "high",
        }),
      )
    }
  }
  return out
}

function compareArtifacts(baseline: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const out: Finding[] = []
  const freshById = new Map(fresh.artifacts.map((a) => [a.id, a]))
  for (const a of baseline.artifacts) {
    const now = freshById.get(a.id)
    if (a.exists && now && !now.exists) {
      out.push(
        finding({
          id: `${LENS_ID}/artifact-gone-${a.id}`,
          tier: "gap",
          claim: `${a.label} was present at baseline but is now missing`,
          evidence: [a.path],
          why: "Agents and docs still assume it exists; instructions referring to it now mislead.",
          action: "Restore it or update the contract and refresh the baseline.",
          effort: "S",
          confidence: "high",
        }),
      )
    }
  }
  return out
}

function compareLayout(baseline: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const now = new Set(fresh.tree.dirs.map((d) => d.name))
  return baseline.tree.dirs
    .filter((d) => !now.has(d.name))
    .map((d) =>
      finding({
        id: `${LENS_ID}/dir-gone-${d.name}`,
        tier: "gap",
        claim: `Top-level \`${d.name}/\` from the baseline no longer exists — the repo map may be stale`,
        evidence: [`${d.name}/`],
        why: "A stale map sends agents (and people) to paths that are gone.",
        action: "Update the AGENTS.md repo map and refresh the baseline.",
        effort: "S",
        confidence: "medium",
      }),
    )
}

/** Truth lens: is the recorded reckoning still true against today's tree? */
export const contractDriftLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Contract drift",
  kind: "truth",
  async run(ctx): Promise<LensReport> {
    const findings: Finding[] = []
    const disclosures: string[] = []
    const { facts } = ctx

    if (ctx.baseline) {
      findings.push(
        ...compareCommands(ctx.baseline.facts, facts),
        ...compareArtifacts(ctx.baseline.facts, facts),
        ...compareLayout(ctx.baseline.facts, facts),
      )
      if (ctx.baseline.packVersion !== PACK_VERSION) {
        disclosures.push(
          `Baseline was approved under pack v${ctx.baseline.packVersion}; current pack is v${PACK_VERSION} — templates/rubric have evolved since setup.`,
        )
      }
    } else {
      disclosures.push(
        "No committed baseline (.clothaid/baseline.json) — drift is measured against nothing; run `clothaid init` (or re-approve) to record one.",
      )
    }

    // Contract-consistency checks against the live tree (baseline-independent).
    const agentsText = await readText(path.join(ctx.root, "AGENTS.md"))
    if (agentsText) {
      const stateReferenced = agentsText.includes("PROJECT_CONTEXT.md")
      const stateExists = facts.artifacts.find((a) => a.id === "project-context")?.exists ?? false
      if (stateReferenced && !stateExists) {
        findings.push(
          finding({
            id: `${LENS_ID}/dangling-state-doc`,
            tier: "gap",
            claim: "AGENTS.md references PROJECT_CONTEXT.md but no such file exists",
            evidence: ["AGENTS.md"],
            why: "The contract's session protocol points agents at a file they can never read.",
            action: "Create the state doc or remove the reference.",
            effort: "S",
            confidence: "high",
          }),
        )
      }
    } else {
      findings.push(
        finding({
          id: `${LENS_ID}/no-contract`,
          tier: "gap",
          claim: "No AGENTS.md operating contract exists",
          evidence: ["AGENTS.md (missing)"],
          why: "Every agent in this repo works from generic priors instead of the project's rules.",
          action: "Run `clothaid init`.",
          effort: "M",
          confidence: "high",
        }),
      )
    }

    return {
      lens: LENS_ID,
      version: "1",
      title: "Contract drift",
      kind: "truth",
      status: "ran",
      disclosures,
      findings,
    }
  },
}
