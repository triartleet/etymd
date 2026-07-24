import type { Finding, Lens, LensReport } from "../../engine/finding.js"
import { buildGateInventory, type GateInventory, type GateTool } from "./inventory.js"

const LENS_ID = "gate-integrity"

// Correctness tools whose CI-vs-local placement the lens reasons about. format-write is
// deliberately absent: a writing command is never a gate.
const CORRECTNESS_TOOLS: GateTool[] = ["typecheck", "lint", "format-check", "test"]

const TOOL_LABEL: Record<GateTool, string> = {
  typecheck: "type checking",
  lint: "linting",
  "format-check": "format checking",
  "format-write": "format writing",
  test: "unit tests",
  coverage: "coverage",
  e2e: "e2e tests",
  sonar: "SonarQube analysis",
  codecov: "Codecov upload",
  commitlint: "commit-message linting",
  size: "bundle-size check",
  chromatic: "visual review",
}

function finding(partial: Omit<Finding, "lens">): Finding {
  return { lens: LENS_ID, ...partial }
}

export function deriveGateFindings(inv: GateInventory): Finding[] {
  const findings: Finding[] = []
  const localTools = new Set<GateTool>([
    ...inv.local.preCommit,
    ...inv.local.prePush,
    ...inv.local.commitMsg,
  ])
  const enforcedCiJobs = inv.ci.jobs.filter((j) => !j.advisory)
  const enforcedCiTools = new Set<GateTool>(enforcedCiJobs.flatMap((j) => j.tools))
  const anyCiTools = new Set<GateTool>(inv.ci.jobs.flatMap((j) => j.tools))

  // Hooks that exist but never run are the most silent failure a gate can have.
  if (inv.local.source === "githooks" && !inv.local.wired) {
    findings.push(
      finding({
        id: `${LENS_ID}/hooks-not-wired`,
        tier: "risk",
        claim: "Tracked .githooks/ exist but git core.hooksPath is unset — the hooks never run",
        evidence: [".githooks/"],
        why: "Every check in those hooks is silently skipped on this clone.",
        action: "Run `git config core.hooksPath .githooks` (etymd gates does this).",
        effort: "S",
        confidence: "high",
      }),
    )
  }

  // Shift-left gaps: CI enforces a correctness tool no local hook runs — failures surface only
  // after push, one slow pipeline later.
  for (const tool of CORRECTNESS_TOOLS) {
    if (!enforcedCiTools.has(tool) || localTools.has(tool)) continue
    const jobs = enforcedCiJobs.filter((j) => j.tools.includes(tool))
    const branchNote = jobs.every((j) => j.branchScoped)
      ? " (rule-scoped — blocking-ness may vary per branch)"
      : ""
    findings.push(
      finding({
        id: `${LENS_ID}/ci-only-${tool}`,
        tier: "gap",
        claim: `${TOOL_LABEL[tool]} is enforced only in CI — no local hook runs it`,
        evidence: jobs.map((j) => `${j.file} job \`${j.job}\`${branchNote}`),
        why: "A failure is invisible until the pipeline runs — the slowest possible feedback loop.",
        action: "Wire it into a pre-push hook — `etymd gates` generates one from your own scripts.",
        effort: "S",
        confidence: "high",
      }),
    )
  }

  // Bypass gaps: a local hook enforces something CI never re-checks — one --no-verify away
  // from landing unchecked.
  if (inv.ci.system !== "none" && inv.ci.jobs.length) {
    for (const tool of CORRECTNESS_TOOLS) {
      if (!localTools.has(tool) || anyCiTools.has(tool)) continue
      // Unreadable inherited templates may well run it — only claim what we can see.
      if (inv.ci.inheritedIncludes.length) continue
      findings.push(
        finding({
          id: `${LENS_ID}/local-only-${tool}`,
          tier: "gap",
          claim: `${TOOL_LABEL[tool]} runs only in local hooks — CI never re-checks it`,
          evidence: [`local hooks (${inv.local.source})`],
          why: "Hooks are skippable (`--no-verify`, fresh clones without hook setup) — CI is the backstop.",
          action: "Add the same check to the CI pipeline.",
          effort: "M",
          confidence: "medium",
        }),
      )
    }
  }

  // Latent: coverage is collected/analysed but nothing local gates on a number. Server-side
  // thresholds (Sonar quality gates) are real but invisible from the repo — say exactly that.
  if (inv.thresholds.coverageCollected && !inv.thresholds.coverageThresholdLocal) {
    const sonarJobs = inv.ci.jobs.filter((j) => j.tools.includes("sonar"))
    const advisoryNote =
      sonarJobs.length && sonarJobs.every((j) => j.advisory)
        ? " (the job is allow_failure — advisory on this pipeline)"
        : ""
    findings.push(
      finding({
        id: `${LENS_ID}/coverage-no-local-threshold`,
        tier: inv.thresholds.sonarConfigured ? "gap" : "polish",
        claim: inv.thresholds.sonarConfigured
          ? `A coverage gate exists only server-side (SonarQube)${advisoryNote} — its threshold is not visible in this repo and nothing local mirrors it`
          : "Coverage is collected but no threshold gates it anywhere",
        evidence: [
          ...sonarJobs.map((j) => `${j.file} job \`${j.job}\``),
          "no coverageThreshold in jest/vitest config",
        ],
        why: "A coverage regression is invisible until the server-side gate fails the pipeline — after push, sometimes after review.",
        action:
          "Add a local coverageThreshold mirroring the server gate (or document the server value beside the config) so a regression warns before push.",
        effort: "M",
        confidence: inv.thresholds.sonarConfigured ? "high" : "medium",
      }),
    )
  }

  // Latent: commitlint installed but no commit-msg hook wires it.
  if (
    inv.commitlintDep &&
    !inv.local.commitMsg.includes("commitlint") &&
    !localToolInHook(inv, "commitlint")
  ) {
    findings.push(
      finding({
        id: `${LENS_ID}/commitlint-unwired`,
        tier: "polish",
        claim: "commitlint is a dependency but no commit-msg hook runs it",
        evidence: ["package.json (@commitlint/cli)", "no commit-msg hook"],
        why: "The commit convention the tooling promises is not actually enforced.",
        action: "Wire commitlint into a commit-msg hook, or remove the dependency.",
        effort: "S",
        confidence: "high",
      }),
    )
  }

  return findings
}

function localToolInHook(inv: GateInventory, tool: GateTool): boolean {
  return (
    inv.local.preCommit.includes(tool) ||
    inv.local.prePush.includes(tool) ||
    inv.local.commitMsg.includes(tool)
  )
}

export const gateIntegrityLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Gate integrity (CI ↔ local)",
  kind: "improvement",
  async run(ctx): Promise<LensReport> {
    const inv = await buildGateInventory(ctx.root, ctx.facts)
    const disclosures: string[] = []

    if (inv.ci.inheritedIncludes.length) {
      disclosures.push(
        `${inv.ci.inheritedIncludes.length} CI include(s) reference pipeline definitions outside this repo — the CI inventory is incomplete: ${inv.ci.inheritedIncludes.slice(0, 3).join("; ")}${inv.ci.inheritedIncludes.length > 3 ? " …" : ""}`,
      )
    }
    const advisory = inv.ci.jobs.filter((j) => j.advisory)
    if (advisory.length) {
      disclosures.push(
        `${advisory.length} CI job(s) are allow_failure/continue-on-error — advisory, not counted as enforced gates: ${advisory.map((j) => j.job).join(", ")}`,
      )
    }
    const inheritedScripts = inv.ci.jobs.filter((j) => !j.scriptVisible)
    if (inheritedScripts.length) {
      disclosures.push(
        `${inheritedScripts.length} CI job(s) define their script in an inherited template — tools inferred from name/variables only: ${inheritedScripts.map((j) => j.job).join(", ")}`,
      )
    }
    if (inv.ci.parseErrors.length)
      disclosures.push(...inv.ci.parseErrors.map((e) => `CI parse: ${e}`))
    if (inv.ci.system === "none")
      disclosures.push("No CI configuration found — CI↔local comparisons skipped.")

    return {
      lens: LENS_ID,
      version: "1",
      title: "Gate integrity (CI ↔ local)",
      kind: "improvement",
      status: "ran",
      disclosures,
      findings: deriveGateFindings(inv),
    }
  },
}
