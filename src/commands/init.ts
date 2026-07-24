import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
} from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { writeFacts } from "../core/facts.js"
import { planWorkflow } from "../core/generate.js"
import { defaultLeash } from "../core/leash.js"
import { scanProject } from "../core/scan.js"
import { scoreProject } from "../core/score.js"
import type { LeashProfile, SetupMode } from "../core/types.js"
import { git } from "../core/util.js"
import { print, renderFacts, renderPlan, renderScorecard, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

export interface InitOptions {
  cwd: string
  yes?: boolean
}

function bail(): never {
  cancel("Setup cancelled — no changes made.")
  process.exit(0)
}

function guard<T>(value: T | symbol): T {
  if (isCancel(value)) bail()
  return value as T
}

export async function run(opts: InitOptions): Promise<void> {
  intro(`${theme.brand("clothaid")} ${theme.dim("· agent-agnostic workflow setup")}`)

  const s = spinner()
  s.start("Reckoning the project")
  const facts = await scanProject(opts.cwd)
  await writeFacts(opts.cwd, facts)
  s.stop(`Reckoned ${theme.brand(facts.name)}`)

  renderFacts(facts)
  const card = scoreProject(facts)
  renderScorecard(card)
  print()

  const hasState = facts.artifacts.some((a) => a.id === "project-context" && a.exists)
  const seed = defaultLeash(facts)

  let mode: SetupMode
  let adapters: string[]
  let gates: boolean
  let state: boolean
  let leash: LeashProfile

  if (opts.yes) {
    mode = card.suggestedMode
    adapters = ["claude", "cursor", "copilot"]
    gates = facts.git.isRepo
    state = !hasState
    leash = seed
  } else {
    mode = guard(
      await select({
        message: "Setup mode",
        initialValue: card.suggestedMode,
        options: [
          { value: "fresh", label: "Fresh", hint: "install the workflow from scratch" },
          {
            value: "migration",
            label: "Migration",
            hint: "reconcile an existing workflow to this standard",
          },
          { value: "optimisation", label: "Optimisation", hint: "review and fill the gaps" },
        ],
      }),
    ) as SetupMode

    adapters = guard(
      await multiselect({
        message: "Per-agent adapter files (thin pointers to AGENTS.md)",
        required: false,
        initialValues: ["claude", "cursor", "copilot"],
        options: [
          { value: "claude", label: "Claude Code", hint: "CLAUDE.md" },
          { value: "cursor", label: "Cursor", hint: ".cursor/rules/agents.mdc" },
          { value: "copilot", label: "GitHub Copilot", hint: ".github/copilot-instructions.md" },
        ],
      }),
    ) as string[]

    state = hasState
      ? false
      : (guard(
          await confirm({ message: "Add a PROJECT_CONTEXT.md state doc?", initialValue: true }),
        ) as boolean)

    gates = facts.git.isRepo
      ? (guard(
          await confirm({
            message: "Install local git-hook gates (pre-commit + pre-push)?",
            initialValue: true,
          }),
        ) as boolean)
      : false

    // Leash — a short capture seeded from what the scan implies.
    const commitUnasked = guard(
      await confirm({
        message: "May the agent commit without being asked?",
        initialValue: seed.autonomy.commitUnasked,
      }),
    ) as boolean
    const ghCli = guard(
      await confirm({
        message: "Is the GitHub `gh` CLI available here?",
        initialValue: seed.tooling.ghCli,
      }),
    ) as boolean
    const ticketLinked = guard(
      await confirm({
        message: "Are changes tied to tickets (Jira / issue)?",
        initialValue: seed.vcs.ticketLinked,
      }),
    ) as boolean

    leash = {
      ...seed,
      autonomy: { ...seed.autonomy, commitUnasked },
      tooling: { ...seed.tooling, ghCli },
      vcs: { ...seed.vcs, ticketLinked },
    }
  }

  const files = await planWorkflow(opts.cwd, facts, leash, { adapters, gates, state })
  renderPlan(files)
  print()

  // Existing non-hook files are skipped unless the user opts to overwrite; hooks are ours to own.
  const overwrite = new Set(files.filter((f) => f.executable).map((f) => f.path))
  const existing = files.filter((f) => f.exists && !f.executable)
  if (existing.length && !opts.yes) {
    const ow = guard(
      await confirm({
        message: `${existing.length} file(s) already exist. Overwrite them? (No keeps yours untouched.)`,
        initialValue: mode === "fresh",
      }),
    ) as boolean
    if (ow) for (const f of existing) overwrite.add(f.path)
  }

  const willWrite = files.filter((f) => !f.exists || overwrite.has(f.path)).length
  if (!opts.yes) {
    const go = guard(
      await confirm({ message: `Write ${willWrite} file(s) now?`, initialValue: true }),
    ) as boolean
    if (!go) bail()
  }

  const result = await applyFiles(opts.cwd, files, overwrite)
  if (gates && facts.git.isRepo) await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  section("Applied")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  for (const sk of result.skipped) print(`  ${glyph.bullet} ${theme.dim("kept")} ${theme.dim(sk)}`)

  outro(
    [
      `${theme.ok("Workflow installed.")} Next:`,
      `  1. Fill in ${theme.code("AGENTS.md")} → "What this project is" (or run ${theme.code("clothaid brief")}).`,
      `  2. Check the always-loaded weight: ${theme.code("clothaid context")}.`,
      `  3. Keep it honest over time: ${theme.code("clothaid doctor")}.`,
    ].join("\n"),
  )
}
