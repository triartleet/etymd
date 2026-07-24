import path from "node:path"

import { PACK_VERSION } from "../../pack/version.js"
import type { Finding, Lens, LensContext, LensReport } from "../../engine/finding.js"
import type { ProjectFacts } from "../../core/types.js"
import { pathExists, readJson } from "../../core/util.js"
import {
  extractCommandClaims,
  extractDocRefs,
  extractPathClaims,
  listInstructionFiles,
  packageManagerUsage,
} from "./claims.js"

const LENS_ID = "instruction-truth"
const MAX_PATH_FINDINGS_PER_FILE = 15

function finding(partial: Omit<Finding, "lens">): Finding {
  return { lens: LENS_ID, ...partial }
}

// ---- baseline drift (carried over from the former contract-drift lens) ----

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
        action: "Update the repo map and refresh the baseline.",
        effort: "S",
        confidence: "medium",
      }),
    )
}

// ---- content-vs-repo verification (the main event) ----

/**
 * The truth lens: does what the instruction files CLAIM still hold against the actual repo?
 * Commands must exist as scripts, paths must exist on disk, files must agree on the package
 * manager, cross-references must resolve — plus drift against the committed baseline.
 */
export const instructionTruthLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Instruction truth",
  kind: "truth",
  async run(ctx: LensContext): Promise<LensReport> {
    const findings: Finding[] = []
    const disclosures: string[] = []
    const { facts, root } = ctx

    const files = await listInstructionFiles(root, facts)

    if (!files.length) {
      findings.push(
        finding({
          id: `${LENS_ID}/no-contract`,
          tier: "gap",
          claim: "No agent instruction files exist (AGENTS.md or equivalents)",
          evidence: ["AGENTS.md (missing)"],
          why: "Every agent in this repo works from generic priors instead of the project's rules.",
          action: "Run `etymd init` to scaffold one.",
          effort: "M",
          confidence: "high",
        }),
      )
    }

    // Monorepo truth: a script/path claim holds if it resolves in the ROOT or in ANY workspace
    // package — instruction files legitimately name workspace scripts bare and paths relative
    // to the package they discuss.
    const knownScripts = new Set(Object.keys(facts.commands.raw))
    for (const pkg of facts.packages) {
      const pkgJson = await readJson<{ scripts?: Record<string, string> }>(
        path.join(root, pkg.dir, "package.json"),
      )
      for (const key of Object.keys(pkgJson?.scripts ?? {})) knownScripts.add(key)
    }
    const pathResolves = async (claim: string): Promise<boolean> => {
      const bases = [root, ...facts.packages.map((p) => path.join(root, p.dir))]
      for (const base of bases) {
        if (await pathExists(path.join(base, claim))) return true
        // Conventional sub-roots instruction prose is written relative to.
        if (await pathExists(path.join(base, "src", claim))) return true
        if (await pathExists(path.join(base, "scripts", claim))) return true
      }
      return false
    }

    let totalFilteredSkipped = 0

    for (const file of files) {
      // Command claims: a script the file tells agents to run must exist somewhere real.
      const { scripts: claimed, filteredSkipped } = extractCommandClaims(file.text)
      totalFilteredSkipped += filteredSkipped
      for (const [script, raw] of claimed) {
        if (knownScripts.has(script)) continue
        findings.push(
          finding({
            id: `${LENS_ID}/stale-command:${file.path}:${script}`,
            tier: "risk",
            claim: `${file.path} tells agents to run \`${script}\` — no such script exists`,
            evidence: [`${file.path}: \`${raw}\``, "package.json scripts (root + workspaces)"],
            why: "An agent following this instruction runs a command that fails — or silently skips the check it was meant to run.",
            action: "Update the instruction to the current script name (or restore the script).",
            effort: "S",
            confidence: "high",
          }),
        )
      }

      // Path claims: a path the file points agents at must exist.
      const paths = extractPathClaims(file.text)
      let pathFindings = 0
      for (const claim of paths) {
        if (await pathResolves(claim)) continue
        if (pathFindings >= MAX_PATH_FINDINGS_PER_FILE) {
          disclosures.push(
            `${file.path}: more than ${MAX_PATH_FINDINGS_PER_FILE} missing-path claims — truncated.`,
          )
          break
        }
        pathFindings += 1
        findings.push(
          finding({
            id: `${LENS_ID}/stale-path:${file.path}:${claim}`,
            tier: "gap",
            claim: `${file.path} references \`${claim}\` — it does not exist in the repo`,
            evidence: [file.path, `missing: ${claim}`],
            why: "Agents navigate by these references; a dead path wastes a lookup and erodes trust in the rest of the file.",
            action: "Fix or remove the reference.",
            effort: "S",
            confidence: "medium",
          }),
        )
      }

      // Package-manager consistency: instructions must not command a different PM than the repo uses.
      if (facts.packageManager !== "unknown") {
        const usage = packageManagerUsage(file.text)
        const own = usage.get(facts.packageManager) ?? 0
        for (const [pm, count] of usage) {
          if (pm === facts.packageManager || count < 2 || count <= own) continue
          findings.push(
            finding({
              id: `${LENS_ID}/pm-conflict:${file.path}`,
              tier: "gap",
              claim: `${file.path} instructs \`${pm}\` (${count}×) but the repo uses ${facts.packageManager}`,
              evidence: [file.path, `lockfile → ${facts.packageManager}`],
              why: "Mixed package-manager instructions produce divergent lockfiles and broken installs.",
              action: `Rewrite the commands for ${facts.packageManager}.`,
              effort: "S",
              confidence: "medium",
            }),
          )
          break
        }
      }

      // Cross-references to well-known docs must resolve.
      for (const ref of extractDocRefs(file.text)) {
        if (await pathExists(path.join(root, ref))) continue
        findings.push(
          finding({
            id: `${LENS_ID}/dangling-ref:${file.path}:${ref}`,
            tier: "gap",
            claim: `${file.path} references ${ref} — no such file exists`,
            evidence: [file.path, `missing: ${ref}`],
            why: "The pointer chain agents follow breaks at a file they can never read.",
            action: `Create ${ref} or remove the reference.`,
            effort: "S",
            confidence: "high",
          }),
        )
      }
    }

    // Drift vs the committed baseline.
    if (ctx.baseline) {
      findings.push(
        ...compareCommands(ctx.baseline.facts, facts),
        ...compareArtifacts(ctx.baseline.facts, facts),
        ...compareLayout(ctx.baseline.facts, facts),
      )
      if (ctx.baseline.packVersion !== PACK_VERSION) {
        disclosures.push(
          `Baseline was approved under pack v${ctx.baseline.packVersion}; current pack is v${PACK_VERSION}.`,
        )
      }
    } else {
      disclosures.push(
        "No committed baseline (.etymd/baseline.json) — drift over time is not measurable; run `etymd init` to approve one.",
      )
    }

    disclosures.push(
      `Checked ${files.length} instruction file(s); scripts resolved against root + ${facts.packages.length} workspace manifest(s); paths matched against root and package roots. Heuristics: workspace-filtered commands skipped (${totalFilteredSkipped}); extensionless bare tokens treated as prose (a dir claim needs a trailing slash); absolute/globbed/placeholder tokens skipped; framework-pattern staleness not checked.`,
    )

    return {
      lens: LENS_ID,
      version: "1",
      title: "Instruction truth",
      kind: "truth",
      status: "ran",
      disclosures,
      findings,
    }
  },
}
