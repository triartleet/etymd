import { promises as fs } from "node:fs"
import path from "node:path"

import { cancel, confirm, isCancel, multiselect, select } from "@clack/prompts"

import { applyFiles } from "../core/apply.js"
import { CONFIG_FILE, configPath, readConfig, type GateConfig } from "../core/config.js"
import { derivedCommands, planWorkflow } from "../core/generate.js"
import { ensurePackageScript } from "../core/merge-json.js"
import { scanProject } from "../core/scan.js"
import type { ProjectFacts } from "../core/types.js"
import { git, readText } from "../core/util.js"
import { isSafeGateCommand, runPrefix } from "../pack/templates.js"
import { print, renderPlan, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

/**
 * The publish door: the script etymd owns, and the manifest key that fires it.
 *
 * The key depends on the publish route. npm runs `prepublishOnly`; `vsce` ignores that key
 * completely and runs `vscode:prepublish`, so wiring the npm key into an extension installs a
 * gate that never fires — the worst kind, because the repo looks guarded.
 */
const PUBLISH_GATE_SCRIPT = "scripts/artifact-check.sh"
const PUBLISH_GATE_VALUE = `./${PUBLISH_GATE_SCRIPT}`

function publishGateKey(route: ProjectFacts["publishRoute"]): string {
  return route === "vscode" ? "vscode:prepublish" : "prepublishOnly"
}

export interface GatesOptions {
  cwd: string
  ci?: boolean
  yes?: boolean
}

/** Show the derivations in one place, so "accept" is an informed keystroke rather than a guess. */
function printGateSummary(
  gates: GateConfig,
  facts: ProjectFacts,
  source: { recorded: boolean; willRecord: boolean },
): void {
  const run = runPrefix(facts.packageManager)
  // The shell surface is a real step in the hook, so it belongs in the summary too — reporting
  // "none detected" beside a gate that is about to check twelve scripts is the tool lying about
  // its own output, and this summary is what "accept" is agreeing to.
  const shellStep = facts.shell?.scripts
    ? `shellcheck (${facts.shell.scripts} script${facts.shell.scripts === 1 ? "" : "s"})`
    : ""
  const listed = [...gates.commands.map((c) => `${run} ${c}`), ...(shellStep ? [shellStep] : [])]
  const cmds = listed.length ? listed.join(", ") : "none detected"
  print(`  ${glyph.bullet} ${theme.dim("pre-push runs")} ${theme.info(cmds)}`)
  print(`  ${glyph.bullet} ${theme.dim("audit fails on")} ${theme.info(gates.failOn)}`)
  print(
    `  ${glyph.bullet} ${theme.dim("publish screen")} ${theme.info(gates.publishGate ? "yes" : "no")}${
      gates.publishGate && !facts.publishable ? theme.dim(" (overridden)") : ""
    }`,
  )
  // Point at the file only when one exists or is about to. A non-interactive run records
  // nothing — these values are the scan's guess, not a decision, and re-deriving next run is
  // what keeps a repo's gates current as its scripts change.
  if (source.recorded || source.willRecord) {
    print(`  ${theme.dim(`change any of these later in ${CONFIG_FILE}`)}`)
  } else {
    print(
      `  ${theme.dim(`derived from this repo — write ${CONFIG_FILE} (or run without --yes) to pin them`)}`,
    )
  }
}

/** The escape hatch behind "customize" — the same choices, for the person who wants them. */
async function customize(
  current: GateConfig,
  facts: ProjectFacts,
): Promise<GateConfig | undefined> {
  const c = facts.commands
  const available = [c.formatCheck, c.typecheck, c.lint, c.test].filter((k): k is string =>
    Boolean(k),
  )
  const picked = available.length
    ? await multiselect({
        message: "Which commands should the pre-push gate run?",
        required: false,
        initialValues: current.commands,
        options: available.map((k) => ({
          value: k,
          label: `${runPrefix(facts.packageManager)} ${k}`,
          hint: isSafeGateCommand(c.raw[k]) ? undefined : "writes — allowed only if you pick it",
        })),
      })
    : []
  if (isCancel(picked)) return undefined

  const tier = await select({
    message: "Fail the push on which finding tier?",
    initialValue: current.failOn,
    options: [
      { value: "risk", label: "risk — only what makes an agent do the wrong thing" },
      { value: "gap", label: "gap — also dead references and missing safeguards" },
      { value: "polish", label: "polish — everything" },
    ],
  })
  if (isCancel(tier)) return undefined

  const publish = await confirm({
    message: "Screen the published artifact? (the only check that sees what actually ships)",
    initialValue: current.publishGate ?? facts.publishable,
  })
  if (isCancel(publish)) return undefined

  const commands = picked as string[]
  return {
    commands,
    failOn: tier as string,
    publishGate: publish,
    // Picking a writing command IS the override — recorded so the generator honors it.
    allowWriting: commands.filter((k) => !isSafeGateCommand(c.raw[k])),
  }
}

/**
 * Merge recorded gate choices into the user's existing `gates` section.
 *
 * Two properties, both about a file etymd does not own outright:
 *
 * Keys etymd does not define survive — notably `_why`, where the reason for a non-default value
 * lives beside the value it explains. The reference is structural rather than a naming
 * convention: `gates._why.failOn` mirrors `gates.failOn`, so it says what it refers to without
 * anyone having to infer it from a prefix, and it extends to any field without inventing a name.
 *
 * But an explanation of a value that just CHANGED is not an explanation any more. A stale note in
 * structured form is worse than the shell comment this replaces, because structure reads as
 * trustworthy — so an entry whose field this run changed is dropped rather than left to mislead.
 */
export function mergeGateSection(
  previous: Record<string, unknown>,
  gates: GateConfig,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous, ...gates }
  const why = previous._why as Record<string, unknown> | undefined
  if (!why) return merged

  const next = gates as unknown as Record<string, unknown>
  const kept = Object.fromEntries(
    Object.entries(why).filter(
      ([field]) => JSON.stringify(previous[field]) === JSON.stringify(next[field]),
    ),
  )
  if (Object.keys(kept).length) merged._why = kept
  else delete merged._why
  return merged
}

async function writeGateConfig(root: string, gates: GateConfig): Promise<void> {
  const target = configPath(root)
  const existing = await readText(target)
  let doc: Record<string, unknown> = {}
  if (existing) {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>
    } catch {
      // A hand-broken config is the user's to fix; recording over it would destroy their edits.
      return
    }
  }
  doc.gates = mergeGateSection((doc.gates as Record<string, unknown>) ?? {}, gates)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n", "utf8")
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

  // Everything below is DERIVED and shown, not asked. Getting a derivation wrong costs a
  // slightly slow hook or a slightly strict audit — both one edit away — so the default path is
  // a single keystroke, and `customize` exists for the person who wants the choices.
  // Read the hook being replaced BEFORE planning: regeneration must never silently drop a
  // check the repo already runs.
  const existingPrePush = await readText(path.join(opts.cwd, ".githooks", "pre-push"))
  const { config, present: hasConfig } = await readConfig(opts.cwd)
  // `--yes` records nothing: with no one to decide, the values are the scan's guess, and
  // freezing a guess as a decision would silently stop the gate tracking the repo's scripts.
  const configSource = { recorded: hasConfig, willRecord: !opts.yes }
  let gateConfig: GateConfig = {
    ...config.gates,
    commands: config.gates.commands.length
      ? config.gates.commands
      : derivedCommands(facts, existingPrePush ?? undefined),
    publishGate: config.gates.publishGate ?? facts.publishable,
  }

  const plan = async () => {
    const files = await planWorkflow(opts.cwd, facts, {
      agents: false,
      gates: true,
      gateConfig,
    })
    return files.filter((f) => f.executable)
  }
  let gateFiles = await plan()
  renderPlan(gateFiles, { regeneratesStale: true })
  printGateSummary(gateConfig, facts, configSource)

  if (!opts.yes) {
    const choice = await select({
      message: "Install these gates?",
      initialValue: "yes",
      options: [
        { value: "yes", label: "yes — install as shown" },
        { value: "customize", label: "customize — change what the gates run" },
        { value: "no", label: "cancel" },
      ],
    })
    if (isCancel(choice) || choice === "no") {
      cancel("No changes made.")
      return
    }
    if (choice === "customize") {
      const customized = await customize(gateConfig, facts)
      if (!customized) {
        cancel("No changes made.")
        return
      }
      gateConfig = customized
      gateFiles = await plan()
      renderPlan(gateFiles)
      printGateSummary(gateConfig, facts, configSource)
    }
    // Choices are recorded so a re-run never re-asks and a drift check has something to
    // compare against.
    await writeGateConfig(opts.cwd, gateConfig)
  }

  // A hand-edited hook is never silently clobbered — per-file consent when contents differ.
  //
  // But "differs" alone was doing two jobs. A hook etymd generated and nobody touched since
  // differs the moment the repo's own inputs move — a renamed script, a changed package manager,
  // a newer pack — and refusing THAT is not protection: it pins a gate that has stopped matching
  // the repo, while `etymd audit` goes on reporting the gaps the refused rewrite would close.
  // The stamp separates the cases, so consent is asked only where something could be lost.
  const overwrite = new Set<string>()
  for (const f of gateFiles) {
    if (!f.exists) continue
    if (!f.differs || f.drift === "stale") {
      overwrite.add(f.path)
      continue
    }
    if (opts.yes) continue
    const ow = await confirm({
      message:
        f.drift === "edited"
          ? `${f.path} has been edited since etymd generated it. Overwrite with the pack version?`
          : `${f.path} carries no etymd generation stamp, so it may be hand-written. Overwrite with the pack version?`,
      initialValue: false,
    })
    if (isCancel(ow)) {
      cancel("No changes made.")
      return
    }
    if (ow) overwrite.add(f.path)
  }

  const result = await applyFiles(opts.cwd, gateFiles, overwrite)
  await git(opts.cwd, ["config", "core.hooksPath", ".githooks"])

  section("Done")
  for (const w of result.written) print(`  ${glyph.ok} ${theme.dim("wrote")} ${theme.info(w)}`)
  // Say which of the two reasons applied, and name the way out. The refusal used to be a dead
  // end: one message for every case, and nothing pointing at the next move.
  for (const sk of result.skipped) {
    const drift = gateFiles.find((f) => f.path === sk)?.drift
    const reason = drift === "edited" ? "kept (edited since generated)" : "kept (no etymd stamp)"
    print(`  ${glyph.bullet} ${theme.dim(reason)} ${theme.dim(sk)}`)
    if (opts.yes) {
      print(
        `    ${theme.dim("its content differs from what this repo now generates — re-run without --yes to review and overwrite")}`,
      )
    }
  }
  print(`  ${glyph.ok} ${theme.dim("set")} ${theme.code("core.hooksPath = .githooks")}`)

  // The publish door needs one line in package.json to fire. The plan already showed it and the
  // install was consented to, so this does not ask again — but the merge itself stays
  // conservative: it refuses to overwrite a publish hook someone else wrote.
  const wrotePublishGate = result.written.includes(PUBLISH_GATE_SCRIPT)
  if (wrotePublishGate) {
    const pkgPath = path.join(opts.cwd, "package.json")
    const PUBLISH_GATE_KEY = publishGateKey(facts.publishRoute)
    {
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
    }
  }
}
