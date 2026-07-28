import { promises as fs } from "node:fs"
import path from "node:path"

import { cancel, confirm, intro, isCancel, outro, select, spinner } from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { CACHE_DIR, deriveProfile, writeBaseline, writeCachedFacts } from "../core/facts.js"
import { planWorkflow } from "../core/generate.js"
import { scanProject } from "../core/scan.js"
import type { WorkflowProfile } from "../engine/finding.js"
import { PACK_VERSION } from "../pack/version.js"
import { git, readText } from "../core/util.js"
import { VERSION } from "../version.js"
import { print, renderFacts, renderPlan, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

export interface InitOptions {
  cwd: string
  yes?: boolean
}

function bail(): never {
  cancel("Onboarding cancelled — no changes made.")
  process.exit(0)
}

function guard<T>(value: T | symbol): T {
  if (isCancel(value)) bail()
  return value as T
}

/** The transient cache must never be committed; the baseline and ledger must be. */
async function ensureCacheIgnored(root: string): Promise<boolean> {
  const target = path.join(root, ".gitignore")
  const line = `${CACHE_DIR}/`
  const existing = await readText(target)
  if (existing?.split("\n").some((l) => l.trim() === line || l.trim() === CACHE_DIR)) return false
  const next = existing ? `${existing.replace(/\n?$/, "\n")}${line}\n` : `${line}\n`
  await fs.writeFile(target, next, "utf8")
  return true
}

/**
 * Onboarding, not installation: approve the baseline the truth guard measures against,
 * gitignore the cache, and scaffold a minimal AGENTS.md only where none exists.
 */
export async function run(opts: InitOptions): Promise<void> {
  intro(`${theme.brand("etymd")} ${theme.dim("· keep your agent instructions true")}`)

  const s = spinner()
  s.start("Reckoning the project")
  const facts = await scanProject(opts.cwd)
  await writeCachedFacts(opts.cwd, facts)
  s.stop(`Reckoned ${theme.brand(facts.name)}`)

  renderFacts(facts)
  print()

  const detectedProfile = deriveProfile(facts)
  let profile: WorkflowProfile = detectedProfile
  if (!opts.yes) {
    profile = guard(
      await select({
        message: `Workflow profile ${theme.dim(`(detected: ${detectedProfile}, from recent commit authors)`)}`,
        initialValue: detectedProfile,
        options: [
          { value: "solo", label: "Solo", hint: "one developer" },
          { value: "team", label: "Team", hint: "several committers" },
        ],
      }),
    ) as WorkflowProfile
  }

  const hasContract = facts.artifacts.some((a) => a.id === "agents" && a.exists)
  let scaffoldAgents = false
  if (!hasContract) {
    scaffoldAgents = opts.yes
      ? true
      : (guard(
          await confirm({
            message: "No AGENTS.md found — scaffold a minimal one from the reckoning?",
            initialValue: true,
          }),
        ) as boolean)
  }

  let gates = false
  if (facts.git.isRepo && facts.hooks.source === "none") {
    gates = opts.yes
      ? true
      : (guard(
          await confirm({
            message: "No git hooks found — install the local gates (pre-commit + pre-push)?",
            initialValue: true,
          }),
        ) as boolean)
  }

  const files = await planWorkflow(opts.cwd, facts, { agents: scaffoldAgents, gates })
  if (files.length) {
    renderPlan(files)
    if (!opts.yes) {
      const go = guard(
        await confirm({
          message: `Write ${files.filter((f) => !f.exists).length} file(s) now?`,
          initialValue: true,
        }),
      ) as boolean
      if (!go) bail()
    }
  }

  // Never overwrites: onboarding scaffolds only what is absent.
  const result = await applyFiles(opts.cwd, files)
  if (gates && facts.git.isRepo) await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  // The approved reckoning becomes the committed drift baseline; the cache stays out of git.
  // Re-scan first: `facts` predates the scaffold, so baselining it would approve a repo that no
  // longer exists — the contract and hooks init just wrote would be absent from the baseline, and
  // deleting them later would never register as drift. (Caught by the first live `approve` pass,
  // which reported them as additions in every scaffolded repo.)
  const approved = result.written.length ? await scanProject(opts.cwd) : facts
  await writeBaseline(opts.cwd, {
    packVersion: PACK_VERSION,
    etymdVersion: VERSION,
    approvedAt: new Date().toISOString(),
    profile,
    facts: approved,
  })
  const ignored = facts.git.isRepo ? await ensureCacheIgnored(opts.cwd) : false

  section("Onboarded")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  for (const sk of result.skipped) print(`  ${glyph.bullet} ${theme.dim("kept")} ${theme.dim(sk)}`)
  print(
    `  ${glyph.ok} ${theme.dim("baseline approved →")} ${theme.info(".etymd/baseline.json")} ${theme.dim("(commit it — drift is measured against it)")}`,
  )
  if (ignored)
    print(
      `  ${glyph.ok} ${theme.dim("gitignored the transient cache")} ${theme.info(CACHE_DIR + "/")}`,
    )

  outro(
    [
      `${theme.ok("Truth guard armed.")} Next:`,
      `  1. Commit ${theme.code(".etymd/baseline.json")}${scaffoldAgents ? ` and complete ${theme.code("AGENTS.md")} (or run ${theme.code("etymd brief")})` : ""}.`,
      `  2. Run ${theme.code("etymd audit")} — it verifies every instruction claim against the repo.`,
      `  3. Gate CI on it: ${theme.code("etymd audit --fail-on risk")}.`,
    ].join("\n"),
  )
}
