import { cancel, confirm, isCancel } from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { planWorkflow } from "../core/generate.js"
import { defaultLeash } from "../core/leash.js"
import { scanProject } from "../core/scan.js"
import { git } from "../core/util.js"
import { print, renderPlan, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

export interface GatesOptions {
  cwd: string
  ci?: boolean
  yes?: boolean
}

export async function run(opts: GatesOptions): Promise<void> {
  const facts = await scanProject(opts.cwd)

  if (opts.ci) {
    section("CI review gate")
    print(
      `  ${glyph.partial} ${theme.dim("The advisory AI-review CI job (bring-your-own-key) is planned for a later release.")}`,
    )
    print(`  ${theme.dim("Installing the free local correctness gate below instead.")}`)
  }

  if (!facts.git.isRepo) {
    print(
      `  ${glyph.bad} ${theme.dim("Not a git repository — local hooks need git. Run `git init` first.")}`,
    )
    return
  }
  if (facts.hooks.source === "husky") {
    print(
      `  ${glyph.partial} ${theme.warn("Husky is already managing hooks.")} ${theme.dim("clothaid installs tracked .githooks + core.hooksPath; reconcile by hand to avoid two hook systems.")}`,
    )
  }

  const files = await planWorkflow(opts.cwd, facts, defaultLeash(facts), {
    adapters: [],
    gates: true,
    state: false,
  })
  renderPlan(files)

  if (!opts.yes) {
    const ok = await confirm({ message: "Install these git hooks and point git at .githooks?" })
    if (isCancel(ok) || !ok) {
      cancel("No changes made.")
      return
    }
  }

  const result = await applyFiles(
    opts.cwd,
    files,
    new Set(files.filter((f) => f.executable).map((f) => f.path)),
  )
  await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  section("Done")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  print(`  ${glyph.ok} ${theme.dim("set")} ${theme.code("core.hooksPath = .githooks")}`)
}
