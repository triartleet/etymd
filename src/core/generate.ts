import path from "node:path"

import { generateAgentsMd, generatePreCommitHook, generatePrePushHook } from "../pack/templates.js"
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
    await add(".githooks/pre-push", generatePrePushHook(facts), "Correctness gate (pre-push)", true)
  }

  return out
}
