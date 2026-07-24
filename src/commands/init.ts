import { promises as fs } from "node:fs"
import path from "node:path"

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
import { CACHE_DIR, deriveProfile, writeBaseline, writeCachedFacts } from "../core/facts.js"
import { planWorkflow, type GeneratedFile } from "../core/generate.js"
import { defaultLeash } from "../core/leash.js"
import { scanProject } from "../core/scan.js"
import { scoreProject } from "../core/score.js"
import type { LeashProfile, SetupMode } from "../core/types.js"
import type { WorkflowProfile } from "../engine/finding.js"
import { PACK_VERSION } from "../pack/version.js"
import { git, readText } from "../core/util.js"
import { VERSION } from "../version.js"
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

/** The committed cache dir must never be committed; the baseline and ledger must be. */
async function ensureCacheIgnored(root: string): Promise<boolean> {
  const target = path.join(root, ".gitignore")
  const line = `${CACHE_DIR}/`
  const existing = await readText(target)
  if (existing?.split("\n").some((l) => l.trim() === line || l.trim() === CACHE_DIR)) return false
  const next = existing ? `${existing.replace(/\n?$/, "\n")}${line}\n` : `${line}\n`
  await fs.writeFile(target, next, "utf8")
  return true
}

export async function run(opts: InitOptions): Promise<void> {
  intro(`${theme.brand("clothaid")} ${theme.dim("· agent-agnostic workflow setup")}`)

  const s = spinner()
  s.start("Reckoning the project")
  const facts = await scanProject(opts.cwd)
  await writeCachedFacts(opts.cwd, facts)
  s.stop(`Reckoned ${theme.brand(facts.name)}`)

  renderFacts(facts)
  const detectedProfile = deriveProfile(facts)
  let profile: WorkflowProfile = detectedProfile
  if (!opts.yes) {
    profile = guard(
      await select({
        message: `Workflow profile ${theme.dim(`(detected: ${detectedProfile}, from recent commit authors)`)}`,
        initialValue: detectedProfile,
        options: [
          {
            value: "solo",
            label: "Solo",
            hint: "one developer — state doc + session ritual apply",
          },
          {
            value: "team",
            label: "Team",
            hint: "state lives in the tracker/MRs — solo rituals not graded",
          },
        ],
      }),
    ) as WorkflowProfile
  }

  const card = scoreProject(facts, profile)
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
    state = !hasState && profile === "solo"
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
            hint: "reconcile your existing files against the pack, one by one",
          },
          {
            value: "optimisation",
            label: "Optimisation",
            hint: "add only the missing pieces you pick",
          },
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
          await confirm({
            message: "Add a PROJECT_CONTEXT.md state doc?",
            initialValue: profile === "solo",
          }),
        ) as boolean)

    gates = facts.git.isRepo
      ? (guard(
          await confirm({
            message: "Install local git-hook gates (pre-commit + pre-push)?",
            initialValue: true,
          }),
        ) as boolean)
      : false

    if (gates && (facts.hooks.source === "husky" || facts.hooks.source === "husky-legacy")) {
      print(
        `  ${glyph.partial} ${theme.warn(`${facts.hooks.source} already manages hooks here.`)} ${theme.dim("Installing .githooks + core.hooksPath would take over — git runs ONE hook path. Reconcile deliberately.")}`,
      )
      gates = guard(
        await confirm({ message: "Proceed with .githooks anyway?", initialValue: false }),
      ) as boolean
    }

    // Leash — a short capture seeded from what the scan implies; hard/soft matters in the wording.
    const commitUnasked = guard(
      await confirm({
        message: "May the agent commit without being asked?",
        initialValue: seed.autonomy.commitUnasked,
      }),
    ) as boolean
    const ghAvailable = guard(
      await confirm({
        message: "Is the GitHub `gh` CLI available here?",
        initialValue: seed.tooling.ghCli.enabled,
      }),
    ) as boolean
    const ghHard = ghAvailable
      ? false
      : (guard(
          await confirm({
            message: "Is `gh` blocked by org policy (vs just not set up)?",
            initialValue: seed.vcs.ticketLinked,
          }),
        ) as boolean)
    const ticketLinked = guard(
      await confirm({
        message: "Are changes tied to tickets (Jira / issue)?",
        initialValue: seed.vcs.ticketLinked,
      }),
    ) as boolean

    leash = {
      ...seed,
      autonomy: { ...seed.autonomy, commitUnasked },
      tooling: { ...seed.tooling, ghCli: { enabled: ghAvailable, hard: ghHard } },
      vcs: { ...seed.vcs, ticketLinked },
    }
  }

  const files = await planWorkflow(opts.cwd, facts, leash, { adapters, gates, state, profile })

  // Mode is the reconcile posture, not a label: fresh may overwrite, migration reconciles each
  // differing file, optimisation only adds what is missing and picked.
  let chosen: GeneratedFile[] = files
  const overwrite = new Set<string>()

  if (mode === "optimisation") {
    const missing = files.filter((f) => !f.exists)
    if (!missing.length) {
      renderPlan(files)
      outro(
        `${theme.ok("Nothing missing.")} Every planned artifact already exists — see \`clothaid audit\` for gaps.`,
      )
      return
    }
    if (opts.yes) {
      chosen = missing
    } else {
      renderPlan(files)
      const picked = guard(
        await multiselect({
          message: "Missing artifacts — pick what to add",
          required: false,
          initialValues: missing.map((f) => f.path),
          options: missing.map((f) => ({ value: f.path, label: f.path, hint: f.label })),
        }),
      ) as string[]
      chosen = missing.filter((f) => picked.includes(f.path))
    }
  } else if (mode === "migration") {
    renderPlan(files)
    const differing = files.filter((f) => f.exists && f.differs)
    if (!opts.yes) {
      for (const f of differing) {
        const choice = guard(
          await select({
            message: `${f.path} differs from the pack version`,
            initialValue: "keep",
            options: [
              { value: "keep", label: "Keep yours", hint: "leave the existing file untouched" },
              {
                value: "take",
                label: "Take pack version",
                hint: "replace with the generated file",
              },
            ],
          }),
        ) as string
        if (choice === "take") overwrite.add(f.path)
      }
    }
  } else {
    renderPlan(files)
    const existing = files.filter((f) => f.exists && f.differs)
    if (existing.length && !opts.yes) {
      const ow = guard(
        await confirm({
          message: `${existing.length} existing file(s) differ from the pack. Overwrite them? (No keeps yours.)`,
          initialValue: true,
        }),
      ) as boolean
      if (ow) for (const f of existing) overwrite.add(f.path)
    }
  }

  const willWrite = chosen.filter((f) => !f.exists || overwrite.has(f.path)).length
  if (!opts.yes) {
    const go = guard(
      await confirm({ message: `Write ${willWrite} file(s) now?`, initialValue: true }),
    ) as boolean
    if (!go) bail()
  }

  const result = await applyFiles(opts.cwd, chosen, overwrite)
  if (gates && facts.git.isRepo) await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  // The approved reckoning becomes the committed drift baseline; the cache stays out of git.
  await writeBaseline(opts.cwd, {
    packVersion: PACK_VERSION,
    clothaidVersion: VERSION,
    approvedAt: new Date().toISOString(),
    profile,
    facts,
  })
  const ignored = facts.git.isRepo ? await ensureCacheIgnored(opts.cwd) : false

  section("Applied")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  for (const sk of result.skipped) print(`  ${glyph.bullet} ${theme.dim("kept")} ${theme.dim(sk)}`)
  print(
    `  ${glyph.ok} ${theme.dim("baseline approved →")} ${theme.info(".clothaid/baseline.json")} ${theme.dim("(commit it)")}`,
  )
  if (ignored)
    print(
      `  ${glyph.ok} ${theme.dim("gitignored the transient cache")} ${theme.info(CACHE_DIR + "/")}`,
    )

  outro(
    [
      `${theme.ok("Workflow installed.")} Next:`,
      `  1. Fill in ${theme.code("AGENTS.md")} → "What this project is" (or run ${theme.code("clothaid brief")}).`,
      `  2. Commit ${theme.code(".clothaid/baseline.json")} — it is what drift is measured against.`,
      `  3. Check the always-loaded weight: ${theme.code("clothaid context")}.`,
      `  4. Keep it honest over time: ${theme.code("clothaid audit")}.`,
    ].join("\n"),
  )
}
