import path from "node:path"

import {
  generateAgentsMd,
  generateArtifactCheckScript,
  generateCommitMsgHook,
  generatePreCommitHook,
  generatePrePushHook,
} from "../pack/templates.js"
import type { GateConfig } from "./config.js"
import type { ProjectFacts } from "./types.js"
import { pathExists, readText } from "./util.js"

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
    await add(".githooks/pre-commit", generatePreCommitHook(), "Process gate (pre-commit)", true)
    await add(
      ".githooks/commit-msg",
      generateCommitMsgHook(),
      "Content screen (commit message)",
      true,
    )
    await add(
      ".githooks/pre-push",
      generatePrePushHook(facts, opts.gateConfig),
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
