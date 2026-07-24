import { cancel, confirm, isCancel } from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { planWorkflow } from "../core/generate.js"
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
      `  ${glyph.partial} ${theme.dim("The advisory AI-review CI job (bring-your-own-key) ships in a later release — installing the free local gates below.")}`,
    )
  }

  if (!facts.git.isRepo) {
    print(
      `  ${glyph.bad} ${theme.dim("Not a git repository — local hooks need git. Run `git init` first.")}`,
    )
    return
  }
  if (
    facts.hooks.source === "husky" ||
    facts.hooks.source === "husky-legacy" ||
    facts.hooks.source === "custom"
  ) {
    print(
      `  ${glyph.partial} ${theme.warn(`${facts.hooks.source} already manages hooks here.`)} ${theme.dim("git runs ONE hook path — installing .githooks + core.hooksPath takes over. Fold the existing hook logic in first.")}`,
    )
    if (!opts.yes) {
      const go = await confirm({ message: "Proceed with .githooks anyway?", initialValue: false })
      if (isCancel(go) || !go) {
        cancel("No changes made.")
        return
      }
    }
  }

  const files = await planWorkflow(opts.cwd, facts, { agents: false, gates: true })
  const gateFiles = files.filter((f) => f.executable)
  renderPlan(gateFiles)

  // A hand-edited hook is never silently clobbered — per-file consent when contents differ.
  const overwrite = new Set<string>()
  for (const f of gateFiles) {
    if (!f.exists) continue
    if (!f.differs) {
      overwrite.add(f.path)
      continue
    }
    if (opts.yes) continue
    const ow = await confirm({
      message: `${f.path} exists with different content (hand-edited?). Overwrite with the pack version?`,
      initialValue: false,
    })
    if (isCancel(ow)) {
      cancel("No changes made.")
      return
    }
    if (ow) overwrite.add(f.path)
  }

  if (!opts.yes) {
    const ok = await confirm({ message: "Install these git hooks and point git at .githooks?" })
    if (isCancel(ok) || !ok) {
      cancel("No changes made.")
      return
    }
  }

  const result = await applyFiles(opts.cwd, gateFiles, overwrite)
  await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  section("Done")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  for (const sk of result.skipped)
    print(`  ${glyph.bullet} ${theme.dim("kept (hand-edited)")} ${theme.dim(sk)}`)
  print(`  ${glyph.ok} ${theme.dim("set")} ${theme.code("core.hooksPath = .githooks")}`)
}
