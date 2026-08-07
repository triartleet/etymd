import path from "node:path"

import {
  generateAgentsMd,
  generateArtifactCheckScript,
  generateCommitMsgHook,
  generatePreCommitHook,
  generatePrePushHook,
  isSafeGateCommand,
} from "../pack/templates.js"
import { DEFAULT_CONFIG, type GateConfig } from "./config.js"
import type { ProjectFacts } from "./types.js"
import { pathExists, readText } from "./util.js"

/**
 * The scan's opening guess at what a pre-push gate should run.
 *
 * `test` is included only when the existing hook already ran it. It stays out of the default set
 * — a slow suite in a push gate is how people learn to reach for `--no-verify` — but REMOVING a
 * check a repo already had is a silent downgrade, and a generator that quietly drops working
 * checks cannot be trusted to regenerate anything.
 */
export function derivedCommands(facts: ProjectFacts, existingHook?: string): string[] {
  const c = facts.commands
  const base = [c.formatCheck, c.typecheck, c.lint].filter(
    (k): k is string => Boolean(k) && isSafeGateCommand(c.raw[k as string]),
  )
  if (c.test && existingHook && new RegExp(`\\b${c.test}\\b`).test(existingHook)) {
    base.push(c.test)
  }
  return base
}

export interface GeneratedFile {
  path: string
  contents: string
  /** Present on disk already — apply will skip or ask before overwriting. */
  exists: boolean
  /** The existing file's content differs from what the pack would generate (hand-edited or stale). */
  differs?: boolean
  /** Hooks need the executable bit. */
  executable?: boolean
  label: string
}

export interface PlanOptions {
  /** Scaffold a minimal AGENTS.md (init only offers this when none exists). */
  agents: boolean
  gates: boolean
  /**
   * Emit the publish-time screen. Defaults to `facts.publishable` — set it explicitly to
   * override the derivation (a repo that publishes by a route npm cannot see, or one that
   * declines the door).
   */
  publishGate?: boolean
  /** Recorded gate choices; absent means derive everything from the scan. */
  gateConfig?: GateConfig
}

/** Build the file set an onboarding would write, flagging which exist and which differ. */
export async function planWorkflow(
  root: string,
  facts: ProjectFacts,
  opts: PlanOptions,
): Promise<GeneratedFile[]> {
  const out: GeneratedFile[] = []
  const add = async (rel: string, contents: string, label: string, executable = false) => {
    const abs = path.join(root, rel)
    const exists = await pathExists(abs)
    const existing = exists ? await readText(abs) : null
    out.push({
      path: rel,
      contents,
      exists,
      differs: exists ? existing !== contents : undefined,
      executable,
      label,
    })
  }

  if (opts.agents) {
    await add("AGENTS.md", generateAgentsMd(facts), "Minimal operating contract (scaffold)")
  }
  if (opts.gates) {
    // Preservation belongs HERE, not in the command that calls this. `etymd gates` used to read
    // the existing hook itself, so every other caller — the fleet drift check above all —
    // regenerated without it and compared a repo against a hook missing checks the repo really
    // runs: permanent false drift, and a silent downgrade for anyone who applied it.
    const existingPrePush = await readText(path.join(root, ".githooks", "pre-push"))

    await add(".githooks/pre-commit", generatePreCommitHook(), "Process gate (pre-commit)", true)
    await add(
      ".githooks/commit-msg",
      generateCommitMsgHook(),
      "Content screen (commit message)",
      true,
    )
    // A recorded command set is the user's decision and wins outright; otherwise derive, keeping
    // whatever the existing hook already ran.
    const gateConfig: GateConfig | undefined = opts.gateConfig?.commands.length
      ? opts.gateConfig
      : {
          commands: derivedCommands(facts, existingPrePush ?? undefined),
          failOn: opts.gateConfig?.failOn ?? DEFAULT_CONFIG.gates.failOn,
          publishGate: opts.gateConfig?.publishGate,
          allowWriting: opts.gateConfig?.allowWriting ?? [],
        }

    await add(
      ".githooks/pre-push",
      generatePrePushHook(facts, gateConfig),
      "Correctness gate (pre-push)",
      true,
    )
    // The publish door is only meaningful where something actually ships. A recorded answer
    // wins; otherwise fall back to the derivation. Note the derivation is a GUESS: npm treats a
    // missing `private` as publishable, which is right about npm's semantics and wrong about a
    // local fork that will never be published — hence the recorded override.
    if (opts.gateConfig?.publishGate ?? opts.publishGate ?? facts.publishable) {
      await add(
        "scripts/artifact-check.sh",
        generateArtifactCheckScript(),
        "Content screen (published artifact)",
        true,
      )
    }
  }

  return out
}
