import path from "node:path"

import {
  generateAgentsMd,
  generateClaudePointer,
  generateCopilotInstructions,
  generateCursorRule,
  generatePreCommitHook,
  generatePrePushHook,
  generateProjectContext,
} from "../pack/templates.js"
import type { WorkflowProfile } from "../engine/finding.js"
import type { LeashProfile, ProjectFacts } from "./types.js"
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
  adapters: string[]
  gates: boolean
  state: boolean
  profile?: WorkflowProfile
}

/** Build the full set of files a setup would write, flagging which exist and which differ. */
export async function planWorkflow(
  root: string,
  facts: ProjectFacts,
  leash: LeashProfile,
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

  const profile = opts.profile ?? "solo"
  await add(
    "AGENTS.md",
    generateAgentsMd(facts, leash, { state: opts.state, profile }),
    "Operating contract (source of truth)",
  )
  if (opts.state)
    await add("PROJECT_CONTEXT.md", generateProjectContext(facts), "Ground-truth state")

  if (opts.adapters.includes("claude"))
    await add("CLAUDE.md", generateClaudePointer(), "Claude Code pointer")
  if (opts.adapters.includes("copilot"))
    await add(
      ".github/copilot-instructions.md",
      generateCopilotInstructions(),
      "Copilot instructions",
    )
  if (opts.adapters.includes("cursor"))
    await add(".cursor/rules/agents.mdc", generateCursorRule(), "Cursor rule")

  if (opts.gates) {
    await add(".githooks/pre-commit", generatePreCommitHook(), "Process gate (pre-commit)", true)
    await add(".githooks/pre-push", generatePrePushHook(facts), "Correctness gate (pre-push)", true)
  }

  return out
}
