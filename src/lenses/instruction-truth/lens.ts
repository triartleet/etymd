import { PACK_VERSION } from "../../pack/version.js"
import type { Finding, Lens, LensContext, LensReport } from "../../engine/finding.js"
import { CONFIG_FILE, DEFAULT_CONFIG } from "../../core/config.js"
import { BASELINE_FILE, baselineCarriesMachinePath } from "../../core/facts.js"
import type { ProjectFacts } from "../../core/types.js"
import {
  buildTruthEnv,
  checkDecisionRefs,
  checkDocRefs,
  checkTextClaims,
  emptyCounters,
  loadDecisionLedger,
} from "./checks.js"
import {
  listInstructionFiles,
  listStateDocuments,
  packageManagerUsage,
  type InstructionFile,
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

    const config = ctx.config?.config ?? DEFAULT_CONFIG
    disclosures.push(...(ctx.config?.problems ?? []))

    const {
      files,
      excluded,
      included: includedExtra,
    } = await listInstructionFiles(root, facts, config.instructions)

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

    const env = await buildTruthEnv(root, facts)
    const counters = emptyCounters()
    const claimOpts = {
      lensId: LENS_ID,
      missingPathTier: "gap" as const,
      maxPathFindings: MAX_PATH_FINDINGS_PER_FILE,
    }
    // The command/path truth checks — shared by instruction files, state documents, and
    // `etymd premise` (see checks.ts).
    const auditClaims = async (file: InstructionFile) => {
      const result = await checkTextClaims(env, file, claimOpts, counters)
      findings.push(...result.findings)
      disclosures.push(...result.disclosures)
    }

    for (const file of files) {
      await auditClaims(file)

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
      findings.push(...(await checkDocRefs(env, file, LENS_ID, counters)).findings)
    }

    // ---- state documents: the same truth checks, plus decision-reference resolution ----
    // A state doc is the first file read on returning to a project — the highest-leverage place
    // for a false claim to sit. Age and size live in state-freshness; TRUTH is checked here.
    const auditedPaths = new Set(files.map((f) => f.path))
    const stateDocs = await listStateDocuments(root, facts)
    const ledger = stateDocs.length
      ? await loadDecisionLedger(root, facts)
      : { ids: null, sources: [] }
    const ledgerSources = ledger.sources
    for (const doc of stateDocs) {
      // `instructions.include` may already have audited this file — never double-report.
      if (!auditedPaths.has(doc.path)) await auditClaims(doc)

      // Decision references: a state doc citing an id the record never wrote is stale in a way
      // age cannot reveal — the file may have been edited yesterday and still cite nothing.
      findings.push(...checkDecisionRefs(doc, ledger, { lensId: LENS_ID }, counters).findings)
    }

    // Drift vs the committed baseline.
    if (ctx.baseline) {
      findings.push(
        ...compareCommands(ctx.baseline.facts, facts),
        ...compareArtifacts(ctx.baseline.facts, facts),
        ...compareLayout(ctx.baseline.facts, facts),
      )
      // Baselines written before the root was elided carry the approver's machine path into a
      // committed — often published — file. Say so; `approve` clears it.
      if (baselineCarriesMachinePath(ctx.baseline)) {
        disclosures.push(
          `${BASELINE_FILE} records an absolute machine path as its scan root (written by an older etymd). It is committed, so that path is published with your repo — run \`etymd approve\` to rewrite it.`,
        )
      }
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

    if (counters.binaryResolved) {
      disclosures.push(
        `${counters.binaryResolved} command claim(s) are installed binaries (node_modules/.bin), not package scripts — treated as true.`,
      )
    }
    if (counters.unverifiableCommands) {
      disclosures.push(
        `node_modules is not installed — ${counters.unverifiableCommands} command claim(s) matching no package script could not be checked against installed binaries; skipped, not flagged.`,
      )
    }
    if (counters.gitignoredSkipped) {
      disclosures.push(
        `${counters.gitignoredSkipped} missing path claim(s) are gitignored (machine-local, e.g. .env) — existence is not verifiable from the repo; skipped, not flagged.`,
      )
    }
    if (counters.prospectiveSkipped) {
      disclosures.push(
        `${counters.prospectiveSkipped} path claim(s) sit in create-this prose (the file instructs generating them) — forward-looking, not stale; skipped, not flagged.`,
      )
    }
    if (counters.fetchedSkipped) {
      disclosures.push(
        `${counters.fetchedSkipped} path claim(s) sit beside the URL they are fetched from — another tree's files, unverifiable here; skipped, not flagged.`,
      )
    }
    if (counters.placeholderSkipped) {
      disclosures.push(
        `${counters.placeholderSkipped} path claim(s) are naming stand-ins (e.g. \`my-custom-skill\`) rather than real references; skipped, not flagged.`,
      )
    }
    if (counters.tildeSkipped) {
      disclosures.push(
        `${counters.tildeSkipped} well-known doc mention(s) sit inside \`~/\` home paths (e.g. \`~/.claude/CLAUDE.md\`) — machine-global files, not this repo's; skipped, not flagged.`,
      )
    }
    if (counters.absenceSkipped) {
      disclosures.push(
        `${counters.absenceSkipped} well-known doc mention(s) name the doc only to say it deliberately does not exist here (create-this or absence prose) — skipped, not flagged.`,
      )
    }
    if (stateDocs.length) {
      disclosures.push(
        `Checked ${stateDocs.length} state document(s) for command, path, and decision-reference claims (same skip classes as instruction files); decision ids resolved against ${
          ledgerSources.length
            ? ledgerSources.join(", ")
            : "nothing — no decisions file with D-NNN entries"
        }.`,
      )
    }
    if (counters.qualifiedRefsSkipped) {
      disclosures.push(
        `${counters.qualifiedRefsSkipped} decision reference(s) name another record (e.g. a fleet-level ledger) — not claims about this repo's decisions; skipped, not flagged.`,
      )
    }
    if (counters.unresolvableRefs) {
      disclosures.push(
        `${counters.unresolvableRefs} decision reference(s) could not be resolved — no decisions file with \`## D-NNN\` entries; skipped, not flagged.`,
      )
    }
    // Scoping narrows what this lens can see, so it is stated up front and by name — an audit
    // that looks clean because the lying files were excluded must say so itself.
    if (excluded.length) {
      const shown = excluded.slice(0, 5).join(", ")
      disclosures.push(
        `${excluded.length} instruction file(s) excluded by ${CONFIG_FILE} and NOT audited: ${shown}${excluded.length > 5 ? `, +${excluded.length - 5} more` : ""}.`,
      )
    }
    if (includedExtra.length) {
      disclosures.push(
        `${includedExtra.length} extra instruction file(s) audited via ${CONFIG_FILE} \`instructions.include\`: ${includedExtra.slice(0, 5).join(", ")}${includedExtra.length > 5 ? `, +${includedExtra.length - 5} more` : ""}.`,
      )
    }
    disclosures.push(
      `Checked ${files.length} instruction file(s); commands resolved against root + ${facts.packages.length} workspace manifest(s) plus installed binaries; paths matched against root, package roots, the claiming file's directory, and directories the same file names; existence judged on the working tree (gitignored-but-present is true, gitignored-and-absent unverifiable). Heuristics: workspace-filtered commands skipped (${counters.filteredSkipped}); tokens without a recognized extension treated as prose (a dir claim needs a trailing slash); schemeless hosts read as URLs; gitignored claims unverifiable; create-this, fetched-from-URL, and stand-in path claims skipped; absolute/globbed/placeholder tokens skipped; doc mentions inside \`~/\` home paths skipped; framework-pattern staleness not checked.`,
    )

    return {
      lens: LENS_ID,
      version: "1",
      title: "Instruction truth",
      kind: "truth",
      status: "ran",
      disclosures,
      findings,
      outOfScope: excluded,
    }
  },
}
