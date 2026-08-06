import path from "node:path"

import { cancel, confirm, isCancel } from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { planWorkflow } from "../core/generate.js"
import { ensurePackageScript } from "../core/merge-json.js"
import { scanProject } from "../core/scan.js"
import { git } from "../core/util.js"

/** The publish door: the script etymd owns, and the one package.json key that fires it. */
const PUBLISH_GATE_SCRIPT = "scripts/artifact-check.sh"
const PUBLISH_GATE_KEY = "prepublishOnly"
const PUBLISH_GATE_VALUE = `./${PUBLISH_GATE_SCRIPT}`
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

  // The publish door needs one line in package.json to fire. Etymd writes it only on an
  // explicit yes: package.json is the user's file, and every other gate here is a file etymd
  // owns outright. Declining leaves a working script they can wire by hand.
  const wrotePublishGate = result.written.includes(PUBLISH_GATE_SCRIPT)
  if (wrotePublishGate) {
    const pkgPath = path.join(opts.cwd, "package.json")
    const wire =
      opts.yes ||
      (await confirm({
        message: `Add "${PUBLISH_GATE_KEY}": "${PUBLISH_GATE_VALUE}" to package.json? (screens what actually ships)`,
        initialValue: true,
      }).then((v) => (isCancel(v) ? false : v)))
    if (wire) {
      const merged = await ensurePackageScript(pkgPath, PUBLISH_GATE_KEY, PUBLISH_GATE_VALUE)
      if (merged.outcome === "added")
        print(`  ${glyph.ok} ${theme.dim("wired")} ${theme.code(PUBLISH_GATE_KEY)}`)
      else if (merged.outcome === "conflict")
        print(
          `  ${glyph.partial} ${theme.warn(`${PUBLISH_GATE_KEY} already runs \`${merged.existing}\``)} ${theme.dim("— left as is; chain the screen into it by hand if you want both.")}`,
        )
      else if (merged.outcome === "unchanged")
        print(`  ${glyph.bullet} ${theme.dim(`${PUBLISH_GATE_KEY} already wired`)}`)
      else
        print(
          `  ${glyph.partial} ${theme.dim(`package.json ${merged.outcome}${merged.detail ? `: ${merged.detail}` : ""} — wire ${PUBLISH_GATE_KEY} by hand`)}`,
        )
    } else {
      print(
        `  ${glyph.bullet} ${theme.dim(`not wired — add "${PUBLISH_GATE_KEY}": "${PUBLISH_GATE_VALUE}" when you want the publish door active`)}`,
      )
    }
  }
}
